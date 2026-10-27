// 数据根目录：中心桌面端与远端代理各自有一份，互不干扰。
//
// 之前所有路径都挂在「编译期写死的项目根」上（CARGO_MANIFEST_DIR 的父目录），
// 那只对「跑在开发机上的同一个二进制」成立。拆成两个独立应用后必须改成运行时决定：
//   - 中心 agentry：项目目录（artifacts.json / connectors.json 都在这）
//   - 远端 agentry-proxy  ：~/.agentry-proxy（远端机器上自己的可写目录）
//
// 优先级：显式指定 > AGENT_DATA_DIR 环境变量 > 传入的开发期回落路径 > 用户数据目录。
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 设定数据根目录（进程内一次性生效）。
///
/// 显式设定优先于环境变量 —— 远端代理用它把数据落在自己机器的可写目录里。
pub fn set_data_root(p: PathBuf) -> bool {
    DATA_ROOT.set(p).is_ok()
}

/// 显式设定的数据根目录（若已设定）。
pub fn explicit_data_root() -> Option<PathBuf> {
    DATA_ROOT.get().cloned()
}

/// 当前数据根目录。
///
/// 顺序：显式设定 > AGENT_DATA_DIR > 编译期默认根。
pub fn data_root() -> PathBuf {
    if let Some(p) = DATA_ROOT.get() {
        return p.clone();
    }
    if let Ok(p) = std::env::var("AGENT_DATA_DIR") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    default_data_root()
}

/// 编译期默认根：core crate 所在目录的上一级（仅开发期有意义）。
fn default_data_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 用户级数据目录（跨平台的兜底）。
pub fn user_data_dir(app: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    if cfg!(target_os = "macos") {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(app)
    } else {
        PathBuf::from(home)
            .join(".local")
            .join("share")
            .join(app)
    }
}

/// 解析最终的数据根目录。
///
/// 优先级：显式指定 > AGENT_DATA_DIR > 传入的开发期回落路径 > 用户数据目录。
///
/// 刻意**不搬运产物索引**（artifacts.json / tasks.json）：
/// 产物索引是「扫描本机会话目录」得出的**派生数据**，每台机器各自扫描即可，
/// 把旧机器的索引搬过来只会带来一堆陈旧条目（旧路径、旧字段、内容早已过时）。
/// 只有连接器配置（connectors.json）属于**用户设置**，必须跟着人走 —— 否则换机器后
/// 连接器全空，用户得从零重配。
pub fn resolve_data_root(explicit: Option<PathBuf>, dev_fallback: PathBuf) -> PathBuf {
    if let Some(p) = explicit {
        let _ = std::fs::create_dir_all(&p);
        return p;
    }
    if let Ok(p) = std::env::var("AGENT_DATA_DIR") {
        if !p.trim().is_empty() {
            let p = PathBuf::from(p);
            let _ = std::fs::create_dir_all(&p);
            return p;
        }
    }
    if dev_fallback.is_dir() {
        return dev_fallback;
    }
    // 装在别的机器上：落到用户数据目录。只带**用户设置**过去，不带历史产物。
    let user = user_data_dir("agentry");
    let _ = std::fs::create_dir_all(&user);
    let from = dev_fallback.join("connectors.json");
    let to = user.join("connectors.json");
    if from.is_file() && !to.exists() {
        let _ = std::fs::copy(&from, &to);
    }
    user
}
