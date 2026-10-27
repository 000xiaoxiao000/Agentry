use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::default_node;
use crate::paths::data_root;
use crate::model::{Artifact, TaskRec};
// 再导出：调用方习惯写 service::ConvList（旧模块结构保持不变）
pub use crate::model::{ConvBrief, ConvList};
use crate::session::{session_head_meta_cached, HeadMeta};
use crate::workspace::{workspace_display_names, workspace_project_dir};
use crate::activity::tool_activity;
use crate::session::{clean_conversation_artifact, conversation_preview};
use crate::text::truncate_utf8;
use crate::store::{load_connectors, load_store, load_tasks};
use crate::tokens::{session_tokens_cached, session_tokens_cached_readonly, TokenStat, TokenUsage};

/// 产物列表的真正实现（service 层复用，让远端代理能返回同样结构的数据）。
pub fn list_artifacts_impl(filter: Option<HashMap<String, String>>) -> Vec<Artifact> {
    let mut items = load_store();
    if let Some(f) = filter {
        if let Some(c) = f.get("connector") {
            if !c.is_empty() {
                items.retain(|a| a.connector == *c);
            }
        }
        if let Some(k) = f.get("kind") {
            if !k.is_empty() {
                items.retain(|a| a.kind == *k);
            }
        }
        if let Some(q) = f.get("q") {
            if !q.is_empty() {
                let ql = q.to_lowercase();
                items.retain(|a| {
                    a.name.to_lowercase().contains(&ql)
                        || a
                            .path
                            .as_ref()
                            .map(|p| p.to_lowercase().contains(&ql))
                            .unwrap_or(false)
                        || a
                            .content
                            .as_ref()
                            .map(|p| p.to_lowercase().contains(&ql))
                            .unwrap_or(false)
                });
            }
        }
        // 时间快捷筛选：since/until 为 epoch 秒，区间 [since, until)
        if let Some(s) = f.get("since") {
            if let Ok(sv) = s.parse::<i64>() {
                if sv > 0 {
                    items.retain(|a| a.created_at >= sv);
                }
            }
        }
        if let Some(u) = f.get("until") {
            if let Ok(uv) = u.parse::<i64>() {
                if uv > 0 {
                    items.retain(|a| a.created_at < uv);
                }
            }
        }
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    // 列表只回传「预览片段」：上千条会话每条最多 100KB，全量回传会把 IPC 和渲染拖死。
    // 点开详情时前端再用 get_artifact 取完整内容。
    for a in items.iter_mut() {
        if a.kind == "conversation" || a.kind == "log" {
            // 兜底：迁移没跑到（例如进程刚起就读）时，按需就地清洗，保证标题与摘要可读
            let needs_clean = a.name.trim_start().starts_with('<')
                || a
                    .content
                    .as_ref()
                    .map(|c| c.contains("<system-reminder") || c.contains("<environment_context") || c.contains("<user_info"))
                    .unwrap_or(false);
            if needs_clean {
                let _ = clean_conversation_artifact(a);
            }
            if let Some(c) = &a.content {
                a.content = Some(conversation_preview(c, 200));
            }
        } else if let Some(c) = &a.content {
            a.content = Some(truncate_utf8(&c.replace('\n', " "), 160));
        }
    }
    items
}


/// 本机统计的真正实现（service 层复用）：会话 / 产物 / 任务计数 + 工具活跃情况。
pub fn stats_impl() -> serde_json::Value {
    let store = load_store();
    let mut convs = 0usize;
    let mut files = 0usize;
    let mut size = 0u64;
    for a in &store {
        match a.kind.as_str() {
            "conversation" => convs += 1,
            "file" => files += 1,
            _ => {}
        }
        size += a.size;
    }
    let tasks = load_tasks().len();
    let act = tool_activity(None, None);
    let mut running = 0u32;
    let mut tools = 0usize;
    for t in &act {
        tools += 1;
        running += t.running;
    }
    serde_json::json!({
        "conversations": convs,
        "files": files,
        "size": size,
        "tasks": tasks,
        "tools": tools,
        "running": running,
        "node": default_node(),
    })
}


/// 单个产物的真正实现（service 层复用）。
pub fn get_artifact_impl(id: String) -> Option<Artifact> {
    let mut a = load_store().into_iter().find(|a| a.id == id)?;
    // 迁移可能还没落盘；详情页直接读旧数据时修一遍，避免用户又看到系统块
    let _ = clean_conversation_artifact(&mut a);
    Some(a)
}


/// 任务列表的真正实现（service 层复用）。
pub fn list_tasks_impl() -> Vec<TaskRec> {
    let mut v = load_tasks();
    v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    v
}


/// 会话简表的真正实现（service 层复用，让远端代理返回同样结构）。
pub fn list_conversations_impl(connector: Option<String>, limit: Option<usize>) -> ConvList {
    let scope = connector.as_deref().filter(|c| !c.is_empty());
    let mut items: Vec<Artifact> = load_store()
        .into_iter()
        .filter(|a| a.kind == "conversation")
        .filter(|a| scope.map(|c| a.connector == c).unwrap_or(true))
        .collect();
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let total = items.len();
    // 工作区显示名表一次读入，供所有条目查表（避免逐条读文件）
    let ws_names = workspace_display_names();
    let items = items
        .into_iter()
        .take(limit.unwrap_or(40))
        .enumerate()
        .map(|(idx, a)| {
            // 只对「实际会返回的」条目读文件头（take 之后），避免为几千条历史做无用的文件读；
            // 再加一道上限：越靠后越老，左栏每组只渲染前 20 条，超过前 500 条的用默认标题即可。
            let meta = if idx < 500 {
                a.path
                    .as_deref()
                    .map(|p| session_head_meta_cached(Path::new(p)))
                    .unwrap_or_default()
            } else {
                HeadMeta::default()
            };
            // token 用量：**只从缓存读**，不触发重算。
            // 启动路径不能为了凑 token 去读 1GB 的会话文件（那要 2.4 秒，首屏会白屏）。
            // 重算交给后台的 token_stats 命令；算完写回缓存，下次就有值了。
            let tokens = if idx < 500 {
                a.path
                    .as_deref()
                    .and_then(|p| session_tokens_cached_readonly(Path::new(p)))
            } else {
                None
            };
            ConvBrief {
                id: a.id,
                connector: a.connector,
                name: if a.name.trim().is_empty() {
                    "未命名会话".to_string()
                } else {
                    a.name
                },
                created_at: a.created_at,
                size: a.size,
                path: a.path,
                workspace: meta.cwd.clone(),
                title: meta.title,
                workspace_name: meta
                    .cwd
                    .as_deref()
                    .and_then(|c| ws_names.get(c).cloned()),
                project: meta.cwd.as_deref().and_then(workspace_project_dir),
                origin: None, // 本机条目；远端由合并层填来源节点
                tokens,
            }
        })
        .collect();
    ConvList { total, items }
}


/// 读文件的真正实现（service 层复用，让远端代理也能按需回传文件内容）。
pub fn read_artifact_impl(path: String) -> Result<String, String> {
    let p = if Path::new(&path).is_absolute() {
        PathBuf::from(&path)
    } else {
        data_root().join(&path)
    };
    std::fs::read_to_string(&p).map_err(|e| format!("读取失败 {}: {e}", p.display()))
}


/// 按连接器聚合的 token 统计（service 层复用，中心与远端同一份实现）。
///
/// 走的是产物索引里的会话条目（已经有 path），不用再遍历目录。
/// 这是**后台任务**：会读全部会话文件（本机累计 1GB，首次约 2 秒），
/// 所以会话列表的启动路径只用缓存、不在这里等。
pub fn token_stats_impl() -> Vec<TokenStat> {
    let mut by_conn: HashMap<String, TokenStat> = HashMap::new();
    let connectors = load_connectors();

    for a in load_store() {
        if a.kind != "conversation" {
            continue;
        }
        let path = match a.path.as_deref() {
            Some(p) => p,
            None => continue,
        };
        let u = session_tokens_cached(Path::new(path));
        if u.sessions == 0 {
            continue; // 这个工具不记录 usage → 不计入（不显示 0，避免误导）
        }
        let entry = by_conn.entry(a.connector.clone()).or_insert_with(|| {
            let name = connectors
                .iter()
                .find(|c| c.id == a.connector)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| a.connector.clone());
            TokenStat {
                connector: a.connector.clone(),
                name,
                usage: TokenUsage::default(),
            }
        });
        entry.usage.merge(&u);
    }

    // 算完把新结果落盘（一次写文件，不是每个会话写一次）
    crate::tokens::flush_token_cache();

    let mut out: Vec<TokenStat> = by_conn.into_values().collect();
    out.sort_by(|a, b| b.usage.input.cmp(&a.usage.input));
    out
}


// ---------- 远端数据服务（代理端） ----------
//
// 中心发 req → 这里按 op 读代理本机的数据 → 回 res。
// 走的是与本机命令同一套 service 实现，所以远端拿到的结构 / 筛选语义 / 清洗规则
// 与本机完全一致 —— 这正是「本机与远程通用」的关键。
pub fn handle_proxy_op(op: &str, args: &serde_json::Value) -> Result<serde_json::Value, String> {
    use crate::proto::ops;
    match op {
        ops::LIST_CONVERSATIONS => {
            let connector = args
                .get("connector")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
            let list = list_conversations(connector, limit);
            serde_json::to_value(list).map_err(|e| format!("序列化失败: {e}"))
        }
        ops::LIST_ARTIFACTS => {
            let filter = args
                .get("filter")
                .and_then(|v| v.as_object())
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect::<HashMap<String, String>>()
                });
            let list = list_artifacts(filter);
            serde_json::to_value(list).map_err(|e| format!("序列化失败: {e}"))
        }
        ops::LIST_TASKS => {
            let list = list_tasks();
            serde_json::to_value(list).map_err(|e| format!("序列化失败: {e}"))
        }
        ops::TOKEN_STATS => {
            let list = token_stats();
            serde_json::to_value(list).map_err(|e| format!("序列化失败: {e}"))
        }
        ops::GET_ARTIFACT => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("缺少 id")?
                .to_string();
            match get_artifact(id) {
                Some(a) => serde_json::to_value(a).map_err(|e| format!("序列化失败: {e}")),
                None => Ok(serde_json::Value::Null),
            }
        }
        ops::READ_FILE => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("缺少 path")?
                .to_string();
            read_file(path).map(|s| serde_json::Value::String(s))
        }
        ops::STATS => Ok(stats()),
        other => Err(format!("不支持的 op: {other}")),
    }
}

// ---------- 公开的数据服务 API ----------
//
// 中心与远端走同一套入口：桌面端命令调它们，代理收到 req 时也调它们。
// 结构与筛选语义因此完全一致 —— 「本机与远程通用」的落点。

/// 拉取会话简表。
pub fn list_conversations(connector: Option<String>, limit: Option<usize>) -> ConvList {
    list_conversations_impl(connector, limit)
}

/// 拉取产物列表（filter 语义与本机一致：connector / kind / q / since / until）。
pub fn list_artifacts(filter: Option<HashMap<String, String>>) -> Vec<Artifact> {
    list_artifacts_impl(filter)
}

/// 按 id 取单个产物（含完整内容）。
pub fn get_artifact(id: String) -> Option<Artifact> {
    get_artifact_impl(id)
}

/// 任务记录列表。
pub fn list_tasks() -> Vec<TaskRec> {
    list_tasks_impl()
}

/// 读一个文件的内容（产物详情里的文件预览）。
pub fn read_file(path: String) -> Result<String, String> {
    read_artifact_impl(path)
}

/// 按连接器聚合的 token 用量统计。
pub fn token_stats() -> Vec<TokenStat> {
    token_stats_impl()
}

/// 本机统计（会话数 / 今日 / 运行中）。
pub fn stats() -> serde_json::Value {
    stats_impl()
}
