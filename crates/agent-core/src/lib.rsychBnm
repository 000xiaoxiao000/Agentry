// agent-core：中心与远端代理**共用**的数据层。
//
// 为什么要有这个 crate：拆成两个独立应用后（中心 agentry / 远端 agentry-proxy），
// 两边都要读会话文件、算工具活跃度、维护产物索引、按同一套规则清洗文本。
// 这些逻辑必须只有一份实现 —— 否则「本机有、远端没有」或「字段结构不同」的问题会立刻出现。
//
// 本 crate 不依赖 Tauri，因此远端代理可以在没有 GUI 框架的机器上独立编译、独立安装。
pub mod activity;
pub mod model;
pub mod paths;
pub mod proto;
pub mod service;
pub mod session;
pub mod stats;
pub mod store;
pub mod sync;
pub mod text;
pub mod tokens;
pub mod workspace;

// ---------- 常用项的再导出：调用方写 agent_core::Artifact 比 agent_core::model::Artifact 顺手 ----------
pub use activity::{connector_app_name, mtime_secs, now, running_app_names, short_id, tool_activity};
pub use model::{Artifact, Connector, LiveSession, LiveTool, SyncReport, TaskRec};
pub use paths::{data_root, resolve_data_root, set_data_root, user_data_dir};
pub use service::{
    get_artifact_impl, handle_proxy_op, list_artifacts_impl, list_conversations_impl,
    list_tasks_impl, read_artifact_impl, stats_impl,
};
pub use session::migrate_store;
pub use stats::{ArtifactStats, ConnStat, KindStat};
pub use store::{load_connectors, load_store, load_tasks, save_connectors, save_store};
pub use sync::{sync_all_core, sync_ingest_connector};
pub use tokens::{session_tokens, session_tokens_cached, TokenStat, TokenUsage};
pub use workspace::{
    is_pure_timestamp, strip_ts_suffix, workspace_display_names, workspace_project_dir,
};

// ---------- 帧编解码与 HMAC 的薄转发（实现都在 proto.rs） ----------
use std::io::{Read, Write};

pub fn write_frame<W: Write>(w: &mut W, v: serde_json::Value) -> Result<(), String> {
    proto::write_frame(w, &v)
}

pub fn read_frame<R: Read>(r: &mut R) -> Result<serde_json::Value, String> {
    proto::read_frame(r)
}

pub fn hmac_sha256(key: &str, msg: &str) -> String {
    proto::hmac_sha256(key, msg)
}

pub fn nonce_hex() -> String {
    proto::nonce_hex()
}

/// 本机标识（主机名）。
pub fn default_node() -> String {
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.trim().is_empty() {
            return h.trim().to_string();
        }
    }
    if let Ok(out) = std::process::Command::new("hostname").output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    format!("node-{}", short_id())
}
