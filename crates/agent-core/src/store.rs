use std::path::PathBuf;

use crate::model::{Artifact, Connector, TaskRec};
use crate::paths::data_root;

pub fn store_path() -> PathBuf {
    data_root().join("artifacts.json")
}

pub fn load_store() -> Vec<Artifact> {
    let p = store_path();
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Vec<Artifact>>(&s) {
            return v;
        }
    }
    Vec::new()
}

pub fn save_store(items: &[Artifact]) {
    let p = store_path();
    if let Ok(s) = serde_json::to_string_pretty(items) {
        let _ = std::fs::write(&p, s);
    }
}

pub fn tasks_path() -> PathBuf {
    data_root().join("tasks.json")
}

pub fn load_tasks() -> Vec<TaskRec> {
    let p = tasks_path();
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Vec<TaskRec>>(&s) {
            return v;
        }
    }
    Vec::new()
}


pub fn load_connectors() -> Vec<Connector> {
    let p = data_root().join("connectors.json");
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Vec<Connector>>(&s) {
            return v;
        }
    }
    serde_json::from_str::<Vec<Connector>>(EMBEDDED_CONNECTORS).unwrap_or_default()
}


pub fn save_connectors(items: &[Connector]) -> Result<(), String> {
    let p = data_root().join("connectors.json");
    let s = serde_json::to_string_pretty(items).map_err(|e| format!("序列化连接器失败: {e}"))?;
    std::fs::write(&p, s).map_err(|e| format!("写入 {} 失败: {e}", p.display()))
}


// 扫描会话根：只收 mtime 晚于任务开始（start_ns）的子项，
// 其内文件作为 file 产物、其内 *.jsonl 作为 conversation 产物。

// 默认连接器（connectors.json 缺失时的兜底）。
pub const EMBEDDED_CONNECTORS: &str = r#"[
  {"id":"codex","name":"OpenAI Codex (CLI)","transport":"cli","command":"codex","args":["exec","--dangerously-bypass-approvals-and-sandbox","{task}"],"workdir":null,"env":{},"artifact_dirs":["."],"harvest_roots":["{task_dir}"],"session_roots":["~/.codex/sessions"],"output_mode":"raw","capture_conversation":true,"capture_log":true,"note":"需安装 codex CLI 并登录；--dangerously-bypass-approvals-and-sandbox 用于无头自动化。产物在 task_dir；会话在 ~/.codex/sessions。"},
  {"id":"claude-code","name":"Claude Code (CLI)","transport":"cli","command":"claude","args":["-p","{task}","--output-format","stream-json","--yes"],"workdir":null,"env":{},"artifact_dirs":["."],"harvest_roots":["{task_dir}"],"session_roots":["~/.claude/projects"],"output_mode":"claude-stream","capture_conversation":true,"capture_log":false,"note":"需安装 claude CLI 并登录；最终回答从 stream-json 的 result 提取。会话在 ~/.claude/projects。"},
  {"id":"workbuddy","name":"WorkBuddy (codebuddy CLI)","transport":"cli","command":"/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy","args":["-p","{task}","--output-format","stream-json","--permission-mode","bypassPermissions"],"workdir":null,"env":{},"artifact_dirs":["."],"harvest_roots":["{task_dir}"],"session_roots":["~/.workbuddy/projects"],"output_mode":"claude-stream","capture_conversation":true,"capture_log":false,"note":"经 WorkBuddy 自带 CLI codebuddy 无头调用；--permission-mode bypassPermissions 跳过权限确认。会话与产物在 ~/.workbuddy/projects。"},
  {"id":"cursor","name":"Cursor (GUI)","transport":"gui","command":"cursor","args":["{workdir}"],"workdir":null,"env":{},"artifact_dirs":null,"harvest_roots":["{task_dir}"],"session_roots":null,"output_mode":null,"capture_conversation":false,"capture_log":false,"note":"Phase 3（GUI 自动化）：用 cursor 打开工作目录并监听文件变化实时收口产物；停止时兜底收割。任务说明写入 PROMPT.md。"}
]"#;
