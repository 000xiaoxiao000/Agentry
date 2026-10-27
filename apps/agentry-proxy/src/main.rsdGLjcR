// agentry-proxy：远端代理应用（独立于中心 agentry 的第二个应用）。
//
// 定位：装在远端机器上，**只**做两件事：
//   1) 扫描本机各 AI 工具的会话目录，算出「哪些工具在跑、今天跑了多少」；
//   2) 主动出站连回中心 agentry，把状态推上去，并按中心的请求提供
//      本机的会话 / 产物 / 任务 / 文件内容。
//
// 关键设计：
//   - 远端零入站端口（只出不进）→ NAT / 防火墙友好，不需要在远端开任何端口。
//   - 自己的配置文件（~/.agentry-proxy/config.json）→ 装好就不用每次敲参数。
//   - 数据目录 ~/.agentry-proxy → 与中心完全隔离，两边互不覆盖。
//   - 与中心共用 agent-core → 收录口径、字段结构、清洗规则完全一致。
//
// 用法：
//   agentry-proxy                                   # 读配置文件常驻
//   agentry-proxy --hub 1.2.3.4:47800 --secret KEY  # 命令行覆盖
//   agentry-proxy --install-service                 # 注册为开机自启服务
//   agentry-proxy --uninstall-service
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_core::proto;

mod config;
mod service_install;

/// 代理的默认目录：~/.agentry-proxy
///
/// 配置（config.json）、产物索引（artifacts.json）、任务记录（tasks.json）、
/// 日志（logs/）全在这一处 —— 装完只需要记住一个路径。
fn default_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".agentry-proxy")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // ---- 服务安装 / 卸载（先处理，它们不需要连中心）----
    if args.iter().any(|a| a == "--install-service") {
        std::process::exit(service_install::install());
    }
    if args.iter().any(|a| a == "--uninstall-service") {
        std::process::exit(service_install::uninstall());
    }
    // --init：生成配置模板（填中心地址与密钥），之后直接跑 agentry-proxy 即可。
    if args.iter().any(|a| a == "--init") {
        let hub = cli_value(&args, "hub").unwrap_or_default();
        let secret = cli_value(&args, "secret").unwrap_or_default();
        let name = cli_value(&args, "name").unwrap_or_default();
        match config::write_template(&hub, &secret, &name) {
            Ok(()) => {
                eprintln!(
                    "[proxy] 配置已写入 {}",
                    config::config_path().display()
                );
                eprintln!("[proxy] 确认无误后直接运行 agentry-proxy 即可常驻。");
            }
            Err(e) => {
                eprintln!("[proxy] 写配置失败：{e}");
                std::process::exit(1);
            }
        }
        return;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("agentry-proxy {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    // ---- 配置：文件 + 命令行覆盖 ----
    let mut cfg = config::load(&args);

    // 数据目录：命令行 > 配置文件 > 默认
    if let Some(d) = cli_value(&args, "data-dir") {
        cfg.data_dir = d;
    }
    if cfg.data_dir.is_empty() {
        cfg.data_dir = default_dir().display().to_string();
    }
    if cfg.secret.trim().is_empty() {
        eprintln!(
            "[proxy] 缺少共享密钥：请在 ~/.agentry-proxy/config.json 里填 secret，或用 --secret 指定。"
        );
        std::process::exit(2);
    }
    if cfg.hub.trim().is_empty() {
        eprintln!("[proxy] 缺少中心地址：请在 ~/.agentry-proxy/config.json 里填 hub，或用 --hub 指定。");
        std::process::exit(2);
    }

    // 展开 ~ 并建目录
    let data_dir = expand_home(&cfg.data_dir);
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("[proxy] 数据目录创建失败 {}：{e}", data_dir.display());
        std::process::exit(2);
    }
    // 让 agent-core 的所有读写都落到这个目录
    agent_core::set_data_root(data_dir.clone());

    let machine = agent_core::default_node();
    if cfg.name.trim().is_empty() {
        cfg.name = machine.clone();
    }
    if cfg.id.trim().is_empty() {
        cfg.id = format!("proxy-{}", agent_core::short_id());
    }
    cfg.interval = cfg.interval.clamp(1, 3600);

    eprintln!(
        "[proxy] {} -> 中心 {}（每 {}s 上报一次，数据目录 {}）",
        cfg.name,
        cfg.hub,
        cfg.interval,
        data_dir.display()
    );

    // 首次全量同步放后台：首扫要几十秒，挡在连接前会让中心一直看不到这台机器。
    {
        let dd = data_dir.clone();
        std::thread::spawn(move || {
            eprintln!("[proxy] 后台首次同步（数据目录 {}）…", dd.display());
            agent_core::sync_all_core(None);
            eprintln!("[proxy] 首次同步完成");
        });
    }

    loop {
        match connect_and_run(&cfg) {
            Ok(()) => eprintln!("[proxy] 连接正常结束"),
            Err(e) => eprintln!("[proxy] 断开：{e}"),
        }
        std::thread::sleep(Duration::from_secs(cfg.interval.max(3)));
    }
}

fn cli_value(args: &[String], key: &str) -> Option<String> {
    let k = format!("--{key}");
    for (i, a) in args.iter().enumerate() {
        if a == &k {
            return args.get(i + 1).cloned();
        }
        if let Some(rest) = a.strip_prefix(&format!("{k}=")) {
            return Some(rest.to_string());
        }
    }
    None
}

/// 展开路径里的 ~。
fn expand_home(p: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if p == "~" {
        return PathBuf::from(home);
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(p)
}

fn connect_and_run(cfg: &config::Config) -> Result<(), String> {
    let mut s = TcpStream::connect(cfg.hub.as_str())
        .map_err(|e| format!("连接 {} 失败：{e}", cfg.hub))?;
    s.set_read_timeout(Some(Duration::from_secs(90))).ok();
    s.set_write_timeout(Some(Duration::from_secs(30))).ok();

    // ---- 握手：hello -> challenge -> auth -> ok ----
    proto::write_frame(
        &mut s,
        &serde_json::json!({
            "t": "hello",
            "id": cfg.id,
            "name": cfg.name,
            "machine": agent_core::default_node(),
            "role": "proxy",
        }),
    )?;
    let ch = proto::read_frame(&mut s)?;
    let nonce = ch
        .get("nonce")
        .and_then(|v| v.as_str())
        .ok_or("中心未发 challenge nonce")?;
    let resp = proto::hmac_sha256(&cfg.secret, nonce);
    proto::write_frame(&mut s, &serde_json::json!({"t": "auth", "resp": resp}))?;
    let ok = proto::read_frame(&mut s)?;
    if ok.get("t").and_then(|v| v.as_str()) != Some("ok") {
        return Err("中心鉴权未通过（共享密钥不一致）".into());
    }
    eprintln!("[proxy] 已接入中心");

    // ---- register 一次：告知本机有哪些工具 ----
    let conns: Vec<serde_json::Value> = agent_core::load_connectors()
        .iter()
        .map(|c| serde_json::json!({"id": c.id, "name": c.name}))
        .collect();
    proto::write_frame(
        &mut s,
        &serde_json::json!({"t": "register", "connectors": conns}),
    )?;

    // 写端共享给「上报 activity 的线程」和「应答请求的读线程」——
    // 两个线程都会写同一个 socket，必须用 Mutex 串行化，否则帧会交错写坏。
    let writer = Arc::new(Mutex::new(
        s.try_clone().map_err(|e| format!("复制连接失败: {e}"))?,
    ));

    // ---- 读线程：处理中心发来的 req ----
    {
        let mut reader = s.try_clone().map_err(|e| format!("复制连接失败: {e}"))?;
        let w = writer.clone();
        std::thread::spawn(move || {
            loop {
                let msg = match proto::read_frame_io(&mut reader) {
                    Ok(v) => v,
                    Err(e) => match e.kind() {
                        // 读超时只是这段时间没收到请求，连接还在，继续等
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => continue,
                        _ => break, // 中心关闭 / 连接复位
                    },
                };
                if let Some((rid, op, args)) = proto::parse_req(&msg) {
                    // 走 agent-core 的同一套数据服务 → 与中心本机口径完全一致
                    let result = agent_core::handle_proxy_op(&op, &args);
                    let frame = proto::res_frame(rid, result);
                    let mut guard = w.lock().unwrap();
                    if proto::write_frame(&mut *guard, &frame).is_err() {
                        break;
                    }
                }
            }
        });
    }

    // ---- 周期上报 activity；写失败即断线，由外层重连 ----
    // 每 10 轮做一次增量同步：中心随时可能来拉会话/产物，索引不能是启动那一刻的快照。
    let mut tick: u64 = 0;
    loop {
        tick += 1;
        if tick % 10 == 0 {
            std::thread::spawn(|| {
                agent_core::sync_all_core(None);
            });
        }
        let tools = agent_core::tool_activity(None, None);
        let frame = serde_json::json!({"t": "activity", "ts": agent_core::now(), "tools": tools});
        {
            let mut guard = writer.lock().unwrap();
            if proto::write_frame(&mut *guard, &frame).is_err() {
                return Err("写 activity 失败（对端已断开）".into());
            }
        }
        std::thread::sleep(Duration::from_secs(cfg.interval));
    }
}

fn print_help() {
    println!(
        r#"agentry-proxy —— 远端代理 agent（独立应用）

用法：
  agentry-proxy [选项]

选项：
  --hub <host:port>      中心 agentry 的地址（覆盖配置文件）
  --secret <密钥>        与中心约定的共享密钥（覆盖配置文件）
  --name <机器名>        这台机器在中心界面里显示的名字
  --id <节点 id>         稳定的节点标识（默认自动生成）
  --interval <秒>        上报周期，默认 5
  --data-dir <目录>      数据目录，默认 ~/.agentry-proxy
  --init                 生成配置文件模板（--hub / --secret / --name 填入）
  --install-service      注册为开机自启服务（macOS launchd / Linux systemd）
  --uninstall-service    注销自启服务
  --version              显示版本
  -h, --help             显示本帮助

配置文件：~/.agentry-proxy/config.json
  {{
    "hub": "192.168.1.10:47800",
    "secret": "与中心一致的密钥",
    "name": "我的 Mac mini",
    "interval": 5,
    "data_dir": "~/.agentry-proxy"
  }}
"#
    );
}
