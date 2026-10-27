// 代理的配置文件：~/.agentry-proxy/config.json
//
// 为什么要有配置文件：远端代理是「装上去就一直跑」的服务，
// 让用户每次敲 --hub/--secret/--name 不现实。装的时候写一次配置，之后直接跑。
//
// 优先级：命令行 > 配置文件 > 内置默认。
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Config {
    /// 中心 agentry 的地址，host:port。
    #[serde(default)]
    pub hub: String,
    /// 与中心约定的共享密钥（HMAC 挑战应答用）。
    #[serde(default)]
    pub secret: String,
    /// 这台机器在中心界面里显示的名字。
    #[serde(default)]
    pub name: String,
    /// 稳定的节点 id：中心用它路由请求。留空则自动生成（重启会变）。
    #[serde(default)]
    pub id: String,
    /// 上报周期（秒）。
    #[serde(default)]
    pub interval: u64,
    /// 数据目录（产物索引 / 任务记录）。
    #[serde(default)]
    pub data_dir: String,
}

/// 代理的主目录：~/.agentry-proxy
pub fn base_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".agentry-proxy")
}

/// 配置文件路径：~/.agentry-proxy/config.json
pub fn config_path() -> PathBuf {
    base_dir().join("config.json")
}

/// 读取配置：先读文件，再用命令行参数覆盖。
pub fn load(args: &[String]) -> Config {
    let path = config_path();
    let mut cfg: Config = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("[proxy] 配置文件解析失败（{}）：{e}，改用命令行参数", path.display());
            Config::default()
        }),
        Err(_) => Config::default(),
    };

    if let Some(v) = cli_value(args, "hub") {
        cfg.hub = v;
    }
    if let Some(v) = cli_value(args, "secret") {
        cfg.secret = v;
    }
    if let Some(v) = cli_value(args, "name") {
        cfg.name = v;
    }
    if let Some(v) = cli_value(args, "id") {
        cfg.id = v;
    }
    if let Some(v) = cli_value(args, "interval").and_then(|v| v.parse().ok()) {
        cfg.interval = v;
    }
    // data_dir 也要从命令行覆盖（配置文件里读到的值在这里）。
    // 注意：命令行优先级最高，所以要先读配置、再让命令行覆盖。
    if let Some(v) = cli_value(args, "data-dir") {
        cfg.data_dir = v;
    }
    cfg
}

/// 写一份配置模板（首次安装时用）。
pub fn write_template(hub: &str, secret: &str, name: &str) -> Result<(), String> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
    }
    let cfg = Config {
        hub: hub.to_string(),
        secret: secret.to_string(),
        name: name.to_string(),
        id: String::new(),
        interval: 5,
        data_dir: "~/.agentry-proxy".to_string(),
    };
    let s = serde_json::to_string_pretty(&cfg).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, s).map_err(|e| format!("写入 {} 失败: {e}", path.display()))
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
