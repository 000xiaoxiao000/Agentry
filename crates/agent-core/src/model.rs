use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::tokens::TokenUsage;

// ---------- 连接器（描述「怎么调用一个外部 AI 工具」）----------
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub transport: String, // "cli" | "mcp" | "gui"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>, // 支持占位符 {task}
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_dirs: Option<Vec<String>>, // 相对 workdir，作为 harvest_roots 的回落
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harvest_roots: Option<Vec<String>>, // 真实产物根（递归 diff）。支持 ~ / {task_dir}。缺省回落 artifact_dirs，再回落 workdir
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_roots: Option<Vec<String>>, // 工具会话存档根（如 ~/.workbuddy/projects）。只收 mtime>任务开始 的子项：文件+*.jsonl 对话
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_mode: Option<String>, // "raw" | "claude-stream"
    #[serde(default)]
    pub capture_conversation: bool,
    #[serde(default)]
    pub capture_log: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_task_arg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>, // 备注（如「这是 B 机器的 agentry 节点」）
}


// ---------- 产物统一索引 ----------
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Artifact {
    pub id: String,
    pub connector: String,
    pub task_id: String,
    pub kind: String, // "file" | "conversation" | "log"
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub created_at: i64,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>, // 云端同步来的条目记来源机器 id；本机产生为 None
    /// 来源节点的显示名（远端才有）。origin 是路由用的 id，这个是给人看的名字。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_name: Option<String>,
}


// ---------- 任务记录持久化（左栏任务列表重启后仍在）----------
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TaskRec {
    pub id: String,
    pub connector: String,
    pub task: String,
    pub workdir: String,
    pub status: String, // "running" | "done" | "stopped" | "err"
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>, // 云端同步来的条目记来源机器 id；本机产生为 None
}


// ---------- 各工具执行情况（活体扫描）----------
// 状态分两层，避免「刚答完还显示运行中」：
//   1) 是否真的在提问/回答（busy）：读会话文件尾部判断这一轮有没有结束，
//      文件刚写但尾记录是「已完成」的不算忙 —— 只靠 mtime 会误报最多整个活跃窗口。
//   2) 工具是否开启（open）：GUI 应用用 lsappinfo 列出运行中的 App（无需权限、无弹窗）；
//      CLI 工具本身就是「跑一次存在一次」，开启态由 busy 体现，没有则为未开启。
// store 里的 created_at 是上次同步时的快照，会滞后；所以这里当场 stat 一遍文件，不读索引。
/// 单个会话的近期明细：像素办公室里每个「小人」对应一条。
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct LiveSession {
    pub id: String,        // 会话文件 stem（作为稳定 key）
    pub workspace: String, // 所属项目目录名 → 办公室里的「房间 / Areas」
    pub busy: bool,        // 是否正在提问/回答（尾判）
    pub act: String,       // 姿态：thinking / writing / tooling / idle
    pub last: i64,         // 最近写入时间（秒）
    #[serde(default)]
    pub title: String,     // 会话标题（各工具写入的 ai-title / session-meta），没有则为空
    #[serde(default)]
    pub cwd: String,       // 会话的真实工作目录（比目录名更准，房间名优先用它）
    #[serde(default)]
    pub project: String,   // 真实项目名（工作区下的项目目录 / 用户自定义显示名）→ 办公室的房间名
    /// 该会话的 token 用量（没有 usage 记录的工具为 None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
}


#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct LiveTool {
    pub connector: String,
    pub name: String,
    pub sessions: u32, // 会话文件总数（≈ 工具里跑过的对话次数）
    pub running: u32,  // 真正还在进行中的会话数（尾部看得到未结束的一轮）
    pub today: u32,    // 今天写入过的会话数
    pub last: i64,     // 最近一次写入时间
    pub open: Option<bool>, // 工具应用是否开着：true/false，无法判断时 null（如 MCP）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent: Vec<LiveSession>, // 近期 / 活跃会话明细（最多 40 条），像素办公室按这个渲染小人
}


// 同步报告（前端展示用）
#[derive(serde::Serialize)]
pub struct SyncReport {
    pub connector: String,
    pub conversations: u64,
    pub files: u64,
    pub errors: Vec<String>,
}

// ---------- 会话简表（中心与远端同一结构） ----------
//
// 需要 Serialize + Deserialize：代理把它序列化出去，中心再反序列化回来，
// 两边共用同一个类型 —— 结构才不会漂移。
#[derive(Clone, Serialize, Deserialize)]
pub struct ConvBrief {
    pub id: String,
    pub connector: String,
    pub name: String,
    pub created_at: i64,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// 来源节点名（远端会话才有；本机为 None）。界面用它标注「这条来自哪台机器」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// 该会话的 token 用量（没有 usage 记录的工具为 None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ConvList {
    pub total: usize,
    pub items: Vec<ConvBrief>,
}
