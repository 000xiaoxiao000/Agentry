// Hub 侧：接受远端「代理 agent」的主动出站连接。
//
// 拓扑：中心 hub（本应用）监听，多台远端只跑轻量代理 agent，代理主动连过来。
// 远端零入站端口，天然穿 NAT / 防火墙 —— 这是相对旧 P2P「两端都要可达」的关键改进。
//
// 帧编解码与 HMAC 挑战应答来自 agent-core（中心与远端代理共用同一份实现）。
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

/// hook 里展示用的代理摘要（在线状态 + 最近一次上报的 activity 原样 JSON）。
#[derive(Clone, serde::Serialize)]
pub struct ProxyInfo {
    pub id: String,
    pub name: String,
    pub machine: String,
    pub online: bool,
    pub last_seen: i64,
    pub connectors: Vec<String>,
    pub activity: Option<serde_json::Value>,
}

/// 一条已建立的代理连接：写端 + 待应答表。
///
/// 中心 → 代理要能主动发请求（req），代理的 res 再按 rid 投回等待方。
/// 写端用 Mutex 包住：Tauri 命令线程与读线程可能同时要写同一 socket。
struct ProxyConn {
    writer: Mutex<TcpStream>,
    pending: agent_core::proto::Pending,
}

#[derive(Default)]
pub struct HubState {
    pub proxies: Mutex<HashMap<String, ProxyInfo>>,
    /// 代理连接（写端 + 待应答表）：中心向远端拉数据时用。
    conns: Mutex<HashMap<String, Arc<ProxyConn>>>,
    /// 置 true 让监听线程退出（停止中心）。
    shutdown: AtomicBool,
    /// 监听线程是否还在跑：start 后置 true，线程退出前置 false。
    running: AtomicBool,
}

static HUB: OnceLock<Arc<HubState>> = OnceLock::new();

/// 进程内唯一的 hub 状态；Tauri 命令与监听线程共用。
pub fn hub_state() -> Arc<HubState> {
    HUB.get_or_init(|| Arc::new(HubState::default())).clone()
}

impl HubState {
    pub fn snapshot(&self) -> Vec<ProxyInfo> {
        let m = self.proxies.lock().unwrap();
        let mut v: Vec<ProxyInfo> = m.values().cloned().collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    /// 向某个在线代理发一个请求并等待应答（带超时）。
    ///
    /// 这是「本机与远程同构」的关键：中心与远端跑的是同一套 op（list_conversations /
    /// list_artifacts / get_artifact / read_file …），中心只管发 req、收 res，
    /// 不关心数据是从哪台机器来的。
    pub fn request(
        &self,
        proxy_id: &str,
        op: &str,
        args: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let conn = {
            let m = self.conns.lock().unwrap();
            m.get(proxy_id).cloned()
        };
        let conn = conn.ok_or_else(|| format!("代理 {proxy_id} 未连接"))?;
        let (rid, rx) = agent_core::proto::register_pending(&conn.pending);
        let frame = agent_core::proto::req_frame(rid, op, args);
        {
            let mut w = conn.writer.lock().unwrap();
            agent_core::proto::write_frame(&mut *w, &frame)?;
        }
        let r = agent_core::proto::await_res(rx, timeout);
        // 无论成功失败都要清掉这条待应答，避免表里堆积
        conn.pending.lock().unwrap().remove(&rid);
        r
    }
}

/// 已登记但当前离线的代理名。
///
/// 合并视图要能告诉用户「这轮少了哪些机器的数据」—— 离线节点被静默跳过的话，
/// 用户会以为那就是全部数据。
pub fn offline_proxies() -> Vec<String> {
    hub_state()
        .snapshot()
        .into_iter()
        .filter(|p| !p.online)
        .map(|p| p.name)
        .collect()
}

/// 向所有在线代理发同一个请求，返回 (代理 id, 代理名, 结果)。
///
/// 单个代理失败（离线 / 超时）不影响其它代理 —— 合并视图里跳过它即可。
/// 返回 id 与名两者：id 用于路由转发（唯一），名用于界面展示（可读）。
pub fn broadcast(
    op: &str,
    args: serde_json::Value,
    timeout: Duration,
) -> Vec<(String, String, Result<serde_json::Value, String>)> {
    let state = hub_state();
    let online: Vec<(String, String)> = state
        .snapshot()
        .into_iter()
        .filter(|p| p.online)
        .map(|p| (p.id.clone(), p.name.clone()))
        .collect();
    let mut out = Vec::new();
    for (id, name) in online {
        let r = state.request(&id, op, args.clone(), timeout);
        out.push((id, name, r));
    }
    out
}

/// 起监听：绑定成功即返回，accept 循环在后台线程跑（非阻塞轮询 shutdown，可被 stop_hub 干净退出）。
pub fn start_hub(host: &str, port: u16, secret: String) -> Result<(), String> {
    let state = hub_state();
    if state.running.load(Ordering::SeqCst) {
        return Err("中心已在运行（请先停止）".into());
    }
    let listener = TcpListener::bind((host, port))
        .map_err(|e| format!("hub 监听 {host}:{port} 失败：{e}"))?;
    listener.set_nonblocking(true).ok();
    state.shutdown.store(false, Ordering::SeqCst);
    state.running.store(true, Ordering::SeqCst);
    eprintln!("[hub] 监听 {host}:{port}，等待代理 agent 接入");
    thread::spawn(move || {
        loop {
            if state.shutdown.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((s, _)) => {
                    let st = state.clone();
                    let sec = secret.clone();
                    thread::spawn(move || {
                        if let Err(e) = handle_proxy_conn(s, &sec, st) {
                            eprintln!("[hub] 连接结束：{e}");
                        }
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
                Err(_) => {
                    if state.shutdown.load(Ordering::SeqCst) {
                        break;
                    }
                    continue;
                }
            }
        }
        state.running.store(false, Ordering::SeqCst);
        eprintln!("[hub] 已停止监听");
    });
    Ok(())
}

/// 停止中心：置 shutdown，等监听线程退出（最多 ~2s），把现存代理标记离线。
/// 返回 true 表示本次确实停掉了（之前在运行）；false 表示之前就没在跑。
pub fn stop_hub() -> bool {
    let state = hub_state();
    if !state.running.load(Ordering::SeqCst) {
        return false;
    }
    state.shutdown.store(true, Ordering::SeqCst);
    for _ in 0..20 {
        if !state.running.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    {
        let mut m = state.proxies.lock().unwrap();
        for p in m.values_mut() {
            p.online = false;
        }
    }
    true
}

/// 中心是否正在运行（前端用来切换「启动 / 停止」按钮态）。
pub fn hub_running() -> bool {
    hub_state().running.load(Ordering::SeqCst)
}

fn handle_proxy_conn(mut s: TcpStream, secret: &str, state: Arc<HubState>) -> Result<(), String> {
    // 监听是非阻塞的（为了能被 shutdown 干净退出），但 accept 出来的连接会继承非阻塞标志，
    // 这里必须改回阻塞，否则下面的握手 / 读帧会立刻返回 WouldBlock 而失败。
    s.set_nonblocking(false).ok();
    s.set_read_timeout(Some(Duration::from_secs(90))).ok();
    s.set_write_timeout(Some(Duration::from_secs(30))).ok();

    // ---- 握手：hello -> challenge -> auth -> ok ----
    let hello = agent_core::read_frame(&mut s)?;
    if hello.get("t").and_then(|v| v.as_str()) != Some("hello") {
        return Err("首帧不是 hello".into());
    }
    let id = hello
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return Err("hello 缺少 id".into());
    }
    let name = hello
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let machine = hello
        .get("machine")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 角色：proxy = 远端代理 agent（上报 activity，也响应中心的取数请求）；
    // client = 只读的查询客户端（如 --query），不登记为代理。
    let role = hello
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("proxy")
        .to_string();
    let is_client = role == "client";

    let snonce = agent_core::nonce_hex();
    agent_core::write_frame(&mut s, serde_json::json!({"t":"challenge","nonce":snonce}))?;
    let auth = agent_core::read_frame(&mut s)?;
    let resp = auth
        .get("resp")
        .and_then(|v| v.as_str())
        .ok_or("auth 缺少 resp")?;
    if resp != agent_core::hmac_sha256(secret, &snonce) {
        let _ = agent_core::write_frame(&mut s, serde_json::json!({"t":"error","msg":"auth failed"}));
        return Err(format!("代理 {id} 鉴权失败（共享密钥不一致）"));
    }
    agent_core::write_frame(&mut s, serde_json::json!({"t":"ok","node": agent_core::default_node()}))?;

    // 写端留一份给中心发请求用（读线程继续收帧）。
    // try_clone 出来的句柄共享同一个 socket，写操作要用 Mutex 串行化。
    let writer = s.try_clone().map_err(|e| format!("复制连接失败: {e}"))?;
    let conn = Arc::new(ProxyConn {
        writer: Mutex::new(writer),
        pending: Arc::new(Mutex::new(HashMap::new())),
    });
    // 查询客户端不占用代理槽位，也不接受中心的广播请求
    if !is_client {
        let mut m = state.conns.lock().unwrap();
        m.insert(id.clone(), conn.clone());
    }

    if !is_client {
        let mut m = state.proxies.lock().unwrap();
        let e = m.entry(id.clone()).or_insert_with(|| ProxyInfo {
            id: id.clone(),
            name: name.clone(),
            machine: machine.clone(),
            online: true,
            last_seen: agent_core::now(),
            connectors: Vec::new(),
            activity: None,
        });
        e.name = name.clone();
        e.machine = machine.clone();
        e.online = true;
        e.last_seen = agent_core::now();
    }
    eprintln!("[hub] 代理已连接：{name}（{id} / {machine}）");

    // ---- 持续接收上报 ----
    loop {
        // 区分「读超时」与「对端关闭」：
        //   - 超时：只是这段时间没收到数据（代理的上报间隔可能较长），连接还在，继续等；
        //   - EOF / 复位：代理真的走了，退出循环并标记离线。
        // 早前两者混为一谈，导致上报间隔一长就被误判成离线、界面里节点反复闪断。
        let msg = match agent_core::proto::read_frame_io(&mut s) {
            Ok(v) => v,
            Err(e) => match e.kind() {
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => continue,
                _ => break, // 对端关闭 / 连接复位
            },
        };
        let t = msg
            .get("t")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        match t.as_str() {
            "register" => {
                let conns: Vec<String> = msg
                    .get("connectors")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|c| {
                                c.get("name")
                                    .or_else(|| c.get("id"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let mut m = state.proxies.lock().unwrap();
                if let Some(p) = m.get_mut(&id) {
                    p.connectors = conns;
                    p.last_seen = agent_core::now();
                    p.online = true;
                }
            }
            "activity" => {
                let n = msg
                    .get("tools")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let mut m = state.proxies.lock().unwrap();
                if let Some(p) = m.get_mut(&id) {
                    p.activity = Some(msg);
                    p.last_seen = agent_core::now();
                    p.online = true;
                }
                eprintln!("[hub] 收到 {name} 的 activity（{n} 个工具）");
            }
            "heartbeat" => {
                let mut m = state.proxies.lock().unwrap();
                if let Some(p) = m.get_mut(&id) {
                    p.last_seen = agent_core::now();
                    p.online = true;
                }
            }
            // 代理回的应答：按 rid 投递给等待该请求的命令线程
            "res" => {
                if let Some((rid, v)) = agent_core::proto::parse_res(&msg) {
                    agent_core::proto::deliver_pending(&conn.pending, rid, v);
                }
            }
            // 客户端（--query 等无界面工具）发来的取数请求：
            // 由中心把它转成「本机 + 各在线代理」的合并视图再回。
            "req" => {
                if let Some((rid, op, args)) = agent_core::proto::parse_req(&msg) {
                    let result = crate::serve_query_op(&op, &args);
                    let frame = agent_core::proto::res_frame(rid, result);
                    let mut w = conn.writer.lock().unwrap();
                    let _ = agent_core::proto::write_frame(&mut *w, &frame);
                }
            }
            "bye" => break,
            _ => {}
        }
    }

    // 连接断开：清掉连接与待应答（等待方会收到「通道断开」而不是永久挂起）
    if !is_client {
        let mut m = state.conns.lock().unwrap();
        m.remove(&id);
    }
    if !is_client {
        let mut m = state.proxies.lock().unwrap();
        if let Some(p) = m.get_mut(&id) {
            p.online = false;
            p.last_seen = agent_core::now();
        }
    }
    if is_client {
        return Ok(());
    }
    eprintln!("[hub] 代理断开：{name}");
    Ok(())
}

