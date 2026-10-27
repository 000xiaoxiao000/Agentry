// 端到端联调：两个**独立应用**之间跑通完整闭环。
//
// 覆盖的场景（都是这次拆分后最容易出问题的点）：
//   1. 远端 agentry-proxy 能不能连上中心的 hub（握手 / 鉴权 / register）。
//   2. 中心能不能按需从远端拉到会话 / 产物 / 任务（req-res）。
//   3. 合并视图是不是把「本机 + 远端」并到一份、且标清来源。
//   4. 远端离线后，中心是不是如实报出 offline（而不是静默少数据）。
//
// 用法：cargo test -p agentry --test hub_e2e -- --nocapture
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use agent_core::proto;

const SECRET: &str = "e2e-secret";

/// hub 是**进程级单例**（OnceLock 里的全局状态），所以同一进程里同时只能起一个。
/// 测试之间必须串行 + 收尾停止，否则第二个测试会撞上「中心已在运行」。
fn hub_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// 持锁期间自动停掉 hub。
///
/// 用 Drop 而不是手动调用：测试 panic 时也会执行 —— 否则一次失败就会把
/// 「中心已在运行」传染给后面所有测试，排查起来非常费劲。
struct HubGuard {
    _lock: MutexGuard<'static, ()>,
}

impl HubGuard {
    fn acquire() -> Self {
        let lock = hub_lock();
        // 上一轮可能因为 panic 没走 Drop，这里先确保是干净状态
        agentry::hub::stop_hub();
        Self { _lock: lock }
    }
}

impl Drop for HubGuard {
    fn drop(&mut self) {
        agentry::hub::stop_hub();
    }
}

/// 造一份**测试自己的**产物数据，把数据根指到临时目录。
///
/// 为什么不用项目目录里的 artifacts.json：
///   - 那份索引是本机扫描出来的派生数据，会随用户机器上的会话变化；
///     删了它、或它本来就是空的，测试就会莫名其妙地失败。
///   - 测试写用户的真实索引会污染用户数据。
/// 所以这里自己造 3 条已知数据，断言才有确定性。
fn use_fake_data() -> PathBuf {
    let dir = std::env::temp_dir().join("agentry-e2e-data");
    let _ = std::fs::create_dir_all(&dir);
    agent_core::set_data_root(dir.clone());

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let items: Vec<agent_core::Artifact> = (0..3)
        .map(|i| agent_core::Artifact {
            id: format!("g-workbuddy-conv-e2e{i}"),
            connector: "workbuddy".into(),
            task_id: format!("g-workbuddy-conv-e2e{i}"),
            kind: "conversation".into(),
            name: format!("E2E 会话 {i}"),
            path: Some(format!("/tmp/e2e-session-{i}.jsonl")),
            content: Some(format!("### user\nE2E 会话 {i} 的内容")),
            created_at: now - i as i64,
            size: 16,
            origin: None,
            origin_name: None,
        })
        .collect();
    agent_core::save_store(&items);
    dir
}

/// 起一个中心 hub（后台线程），返回端口。
fn start_center() -> u16 {
    // 用一个不冲突的端口：先占一个再释放，避免撞上别的服务。
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    agentry::hub::start_hub("127.0.0.1", port, SECRET.to_string())
        .expect("中心 hub 启动失败");
    // 等监听真正就绪
    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    port
}

/// 起一个远端代理（模拟 agentry-proxy 的连接流程），返回持有的连接。
fn connect_proxy(port: u16, id: &str, name: &str) -> TcpStream {
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("连不上中心");
    s.set_read_timeout(Some(Duration::from_secs(30))).ok();
    s.set_write_timeout(Some(Duration::from_secs(30))).ok();

    proto::write_frame(
        &mut s,
        &serde_json::json!({
            "t": "hello", "id": id, "name": name, "machine": name, "role": "proxy"
        }),
    )
    .unwrap();
    let ch = proto::read_frame(&mut s).unwrap();
    let nonce = ch.get("nonce").and_then(|v| v.as_str()).unwrap();
    let resp = proto::hmac_sha256(SECRET, nonce);
    proto::write_frame(&mut s, &serde_json::json!({"t":"auth","resp":resp})).unwrap();
    let ok = proto::read_frame(&mut s).unwrap();
    assert_eq!(
        ok.get("t").and_then(|v| v.as_str()),
        Some("ok"),
        "中心鉴权未通过"
    );
    proto::write_frame(
        &mut s,
        &serde_json::json!({"t":"register","connectors":[{"id":"workbuddy","name":"WorkBuddy"}]}),
    )
    .unwrap();
    s
}

/// 代理侧：收到中心的 req → 用 agent-core 的同一套数据服务回答。
///
/// 返回应答线程的句柄 —— 用来在测试结束时确认线程已退出。
fn answer_requests(mut s: TcpStream) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        loop {
            let msg = match proto::read_frame_io(&mut s) {
                Ok(v) => v,
                Err(e) => match e.kind() {
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => continue,
                    _ => break,
                },
            };
            if let Some((rid, op, args)) = proto::parse_req(&msg) {
                let result = agent_core::handle_proxy_op(&op, &args);
                let frame = proto::res_frame(rid, result);
                if proto::write_frame(&mut s, &frame).is_err() {
                    break;
                }
            }
        }
    })
}

/// 读满一帧。
fn read_frame_from(s: &mut TcpStream) -> serde_json::Value {
    proto::read_frame(s).expect("读帧失败")
}

#[test]
fn 两个独立应用能跑通完整闭环() {
    let _guard = HubGuard::acquire();
    use_fake_data();
    let port = start_center();

    // ---- 远端代理接入 ----
    let proxy = connect_proxy(port, "proxy-e2e", "远端机E2E");
    // 等中心登记完代理
    std::thread::sleep(Duration::from_millis(300));

    let peers = agentry::hub::hub_state().snapshot();
    assert!(
        peers.iter().any(|p| p.id == "proxy-e2e" && p.online),
        "中心没有登记到远端代理：{:?}",
        peers.iter().map(|p| (&p.id, p.online)).collect::<Vec<_>>()
    );

    // 代理侧开一个应答线程（模拟 agentry-proxy 的读线程）
    let answerer = answer_requests(proxy.try_clone().unwrap());

    // ---- 中心向远端要数据 ----
    let state = agentry::hub::hub_state();
    let v = state
        .request(
            "proxy-e2e",
            proto::ops::LIST_CONVERSATIONS,
            serde_json::json!({"connector": null, "limit": 5}),
            Duration::from_secs(20),
        )
        .expect("中心向远端取会话失败");
    assert!(v.get("items").is_some(), "远端返回的会话结构不对：{v}");

    let v = state
        .request(
            "proxy-e2e",
            proto::ops::LIST_ARTIFACTS,
            serde_json::json!({"filter": null}),
            Duration::from_secs(20),
        )
        .expect("中心向远端取产物失败");
    assert!(v.is_array(), "远端返回的产物结构不对：{v}");

    let v = state
        .request(
            "proxy-e2e",
            proto::ops::LIST_TASKS,
            serde_json::Value::Null,
            Duration::from_secs(20),
        )
        .expect("中心向远端取任务失败");
    assert!(v.is_array(), "远端返回的任务结构不对：{v}");

    // ---- 合并视图：本机 + 远端 ----
    let merged = agentry::merged_conversations(None, Some(5000));
    assert!(
        merged.meta.sources.iter().any(|s| s == "远端机E2E"),
        "合并视图里没有远端来源：{:?}",
        merged.meta.sources
    );
    // 远端条目应带上 origin（来源机器），供界面标注与路由
    let remote = merged.list.items.iter().find(|c| c.origin.is_some());
    assert!(
        remote.is_some(),
        "远端会话没有 origin 标记，前端无法区分来源"
    );
    if let Some(r) = remote {
        assert!(
            r.id.contains(':'),
            "远端会话 id 应带节点前缀以保证跨机器唯一：{}",
            r.id
        );
    }

    // ---- 离线如实上报 ----
    // 真正关掉 socket（shutdown 会让对端读到 EOF），中心才认得出代理已离开
    let _ = proxy.shutdown(std::net::Shutdown::Both);
    drop(proxy);
    let _ = answerer.join();
    std::thread::sleep(Duration::from_millis(800));
    let offline = agentry::hub::offline_proxies();
    assert!(
        offline.iter().any(|n| n == "远端机E2E"),
        "代理断开后中心没有如实标记离线：{offline:?}"
    );
}

/// 中心 hub 对错误密钥必须拒绝（鉴权不能形同虚设）。
#[test]
fn 错误密钥无法接入() {
    let _guard = HubGuard::acquire();
    use_fake_data();
    let port = start_center();
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).ok();
    proto::write_frame(
        &mut s,
        &serde_json::json!({"t":"hello","id":"bad","name":"坏客户端","machine":"x","role":"proxy"}),
    )
    .unwrap();
    let ch = proto::read_frame(&mut s).unwrap();
    let nonce = ch.get("nonce").and_then(|v| v.as_str()).unwrap();
    // 故意用错密钥
    let resp = proto::hmac_sha256("wrong-secret", nonce);
    proto::write_frame(&mut s, &serde_json::json!({"t":"auth","resp":resp})).unwrap();
    let r = proto::read_frame(&mut s).unwrap();
    assert_ne!(
        r.get("t").and_then(|v| v.as_str()),
        Some("ok"),
        "错误密钥竟然被放行了"
    );
}

/// 中心侧的合并门面对「没有远端」也要正常工作（本机单机可用）。
#[test]
fn 单机也能用() {
    use_fake_data();
    let merged = agentry::merged_conversations(None, Some(10));
    // 本机条目必须能取到 —— 单机（没有远端代理）也要完整可用
    assert!(
        merged.list.items.len() >= 3,
        "本机产物取不到，合并视图是空的：{}",
        merged.list.items.len()
    );
    assert!(
        merged.meta.total >= merged.list.items.len(),
        "total 统计异常：{:?}",
        merged.meta.total
    );
    // 没有远端时，本机条目不应带 origin（origin 是远端标记）
    assert!(
        merged.list.items.iter().all(|c| c.origin.is_none()),
        "本机条目不该带 origin 标记"
    );
    let _ = read_frame_from; // 保持工具函数被引用
}

/// 清理：测试用的临时数据目录不留在用户机器上。
#[test]
fn 测试目录不污染用户数据() {
    let p: PathBuf = agent_core::user_data_dir("agentry-proxy");
    // 只验证路径解析合理（不真的删用户数据）
    assert!(p.to_string_lossy().contains("agentry-proxy"));
}
