// agentry：中心应用（桌面 GUI + 中心 hub）。
//
// 定位：这是**中心**。它监听一个端口，等各台远端机器上的 agentry-proxy 主动接入；
// 接入后把「本机 + 所有远端」的会话 / 产物 / 任务合并成同一份视图给界面检索。
//
// 与远端的关系（两个独立应用）：
//   - 中心 agentry ：GUI + hub（本文件）；数据层在 agent-core。
//   - 远端 agentry-proxy   ：headless 常驻；数据层同样在 agent-core。
// 两者共用 agent-core → 收录口径、字段结构、清洗规则完全一致，
// 所以界面里看到的远端数据和本机数据是同一种东西。
//
// 注意：这里**没有** --proxy / --query / --hub 之类的模式开关 ——
// 「中心」和「远端代理」是两个各自独立的应用，不该靠参数区分同一个二进制。
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use agent_core::model::ConvList;
use agent_core::proto;
use agent_core::stats::{ArtifactStats, ConnStat, KindStat};
use agent_core::text::{artifact_content_hash, norm_name};
use agent_core::{
    default_node, list_artifacts_impl, list_conversations_impl, list_tasks_impl,
    load_connectors, load_store, read_artifact_impl, save_connectors, save_store,
    sync_all_core, sync_ingest_connector, Artifact, Connector, SyncReport, TaskRec,
};
use tauri::{Emitter, Manager};

// 中心 hub：接受远端代理 agent 的主动出站连接。
//
// 公开是为了让集成测试能直接起中心、拉合并数据 —— 不用真的开一个窗口。
pub mod hub;


struct AppState {
    // 同步锁：保证多次 sync 串行，避免并发读写 artifacts.json 造成重复/丢失。
    sync_lock: Mutex<()>,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            sync_lock: Mutex::new(()),
        }
    }
}

fn emit(app: &tauri::AppHandle, evt: &str, v: serde_json::Value) {
    let _ = app.emit(evt, v.to_string());
}

/// 把 agent-core 的同步进度回调适配成 tauri 事件。
///
/// core 不知道 tauri 的存在（远端代理没有界面），所以它只给一个
/// 「事件名 + 载荷」的闭包；中心这边负责把它转成前端能收的 tauri 事件。
fn progress_sink(app: &tauri::AppHandle) -> impl Fn(&str, serde_json::Value) {
    // 克隆一份 AppHandle，让闭包不借用外部的生命周期。
    let app = app.clone();
    move |evt: &str, v: serde_json::Value| {
        let _ = app.emit(evt, v.to_string());
    }
}




// ---------- 命令 ----------
#[tauri::command]
fn list_connectors() -> Vec<Connector> {
    load_connectors()
}


#[tauri::command]
fn remove_connector(id: String) -> Result<Vec<Connector>, String> {
    let mut items = load_connectors();
    let before = items.len();
    items.retain(|c| c.id != id);
    if items.len() == before {
        return Err(format!("未找到连接器: {id}"));
    }
    save_connectors(&items)?;
    Ok(items)
}


#[tauri::command]
fn list_artifacts(filter: Option<HashMap<String, String>>) -> Vec<Artifact> {
    list_artifacts_impl(filter)
}


// 统计支持按连接器收窄：右侧只显示「当前选中工具」时，数字也要跟着变。
#[tauri::command]
fn artifact_stats(connector: Option<String>) -> ArtifactStats {
    let mut items = load_store();
    if let Some(c) = connector.as_deref() {
        if !c.is_empty() {
            items.retain(|a| a.connector == c);
        }
    }
    let mut conn_map: HashMap<String, (usize, u64, usize, usize)> = HashMap::new();
    let mut kind_map: HashMap<String, usize> = HashMap::new();
    let mut total_size = 0u64;
    for a in &items {
        let e = conn_map.entry(a.connector.clone()).or_insert((0, 0, 0, 0));
        e.0 += 1;
        e.1 += a.size;
        match a.kind.as_str() {
            "conversation" => e.2 += 1,
            "file" => e.3 += 1,
            _ => {}
        }
        *kind_map.entry(a.kind.clone()).or_insert(0) += 1;
        total_size += a.size;
    }
    let mut connectors: Vec<ConnStat> = conn_map
        .into_iter()
        .map(|(connector, (count, size, conversations, files))| ConnStat {
            connector,
            count,
            size,
            conversations,
            files,
        })
        .collect();
    connectors.sort_by(|a, b| b.count.cmp(&a.count));
    let mut kinds: Vec<KindStat> = kind_map
        .into_iter()
        .map(|(kind, count)| KindStat { kind, count })
        .collect();
    kinds.sort_by(|a, b| b.count.cmp(&a.count));
    ArtifactStats {
        total: items.len(),
        total_size,
        connectors,
        kinds,
    }
}


#[tauri::command]
fn get_artifact(id: String) -> Option<Artifact> {
    agent_core::get_artifact_impl(id)
}


// ---------- 任务记录读写 ----------
#[tauri::command]
fn list_tasks() -> Vec<TaskRec> {
    list_tasks_impl()
}

// ---------- 各工具执行情况（活体扫描）----------
// 实现在 agent-core（远端代理用的是同一份），这里只做一层 tauri 命令包装。
#[tauri::command]
fn tool_activity(today_start: Option<i64>, active_window: Option<i64>) -> Vec<agent_core::LiveTool> {
    agent_core::tool_activity(today_start, active_window)
}


#[tauri::command]
fn list_conversations(connector: Option<String>, limit: Option<usize>) -> ConvList {
    list_conversations_impl(connector, limit)
}


// ---------- 产物删除 / 清空 ----------
#[tauri::command]
fn delete_artifact(id: String) -> Result<(), String> {
    // 远端产物（id 带「代理id:」前缀）不在本机索引里，删了也没有效果 ——
    // 明确报错比「静默成功」好，免得用户以为删掉了。
    if let Some((node, _)) = id.rsplit_once(':') {
        if !node.is_empty() && node != default_node() {
            return Err("这是远端机器上的产物，请到对应机器上删除".into());
        }
    }
    let mut items = load_store();
    items.retain(|a| a.id != id);
    save_store(&items);
    Ok(())
}

#[tauri::command]
fn clear_artifacts() -> Result<(), String> {
    save_store(&[]);
    Ok(())
}


// ---------- 同步：拉取各工具已有的全部任务 / 会话 / 产物 ----------
// 每个连接器配了 session_roots（如 ~/.workbuddy/projects、~/.codex/sessions、
// ~/.claude/projects）就把它下面的历史会话全量收口进统一索引，
// 并把会话里引用的文件、目录下现存的文件也收为产物，因此能拿到「所有」历史数据（只读，不派发任务）。
#[tauri::command]
fn sync_connector(
    app: tauri::AppHandle,
    connector_id: String,
) -> Result<SyncReport, String> {
    let app_state = app.state::<AppState>();
    let _g = app_state
        .sync_lock
        .lock()
        .map_err(|_| "sync 锁失败".to_string())?;
    let connectors = load_connectors();
    let c = connectors
        .iter()
        .find(|x| x.id == connector_id)
        .cloned()
        .ok_or_else(|| format!("未找到连接器: {connector_id}"))?;
    let mut store = load_store();
    let mut existing: HashSet<(String, String)> = store
        .iter()
        .filter_map(|a| a.path.clone().map(|p| (a.connector.clone(), p)))
        .collect();
    let mut report = SyncReport {
        connector: c.id.clone(),
        conversations: 0,
        files: 0,
        errors: Vec::new(),
    };
    let mut progress = 0u64;
    sync_ingest_connector(
        Some(&progress_sink(&app)),
        &c,
        &mut store,
        &mut existing,
        &mut report,
        &mut progress,
    );
    save_store(&store);
    emit(&app, "agent-event", serde_json::json!({"type":"sync-done"}));
    Ok(report)
}


#[tauri::command]
fn sync_all(app: tauri::AppHandle) -> Result<Vec<SyncReport>, String> {
    let app_state = app.state::<AppState>();
    let _g = app_state
        .sync_lock
        .lock()
        .map_err(|_| "sync 锁失败".to_string())?;
    let reports = sync_all_core(Some(&progress_sink(&app)));
    emit(&app, "agent-event", serde_json::json!({"type":"sync-done"}));
    Ok(reports)
}


// ---------- 结构化导出 ----------
#[tauri::command]
fn export_all(format: String) -> Result<String, String> {
    let items = load_store();
    match format.as_str() {
        "json" => serde_json::to_string_pretty(&items).map_err(|e| e.to_string()),
        "csv" => {
            let mut s = String::from("id,connector,task_id,kind,name,size,path\n");
            for a in &items {
                let path = a.path.clone().unwrap_or_default().replace(',', " ");
                s.push_str(&format!(
                    "{},{},{},{},{},{},{}\n",
                    a.id, a.connector, a.task_id, a.kind, a.name, a.size, path
                ));
            }
            Ok(s)
        }
        _ => {
            // markdown
            let mut md = "# AI 工具产物汇总\n\n".to_string();
            md.push_str(&format!("- 总产物数：{}\n", items.len()));
            let mut total_size: u64 = 0;
            let mut conn_map: HashMap<String, (usize, u64)> = HashMap::new();
            let mut kind_map: HashMap<String, usize> = HashMap::new();
            for a in &items {
                total_size += a.size;
                let e = conn_map.entry(a.connector.clone()).or_insert((0, 0));
                e.0 += 1;
                e.1 += a.size;
                *kind_map.entry(a.kind.clone()).or_insert(0) += 1;
            }
            md.push_str(&format!("- 总大小：{:.1} KB\n\n", total_size as f64 / 1024.0));
            md.push_str("## 按工具\n");
            let mut conns: Vec<_> = conn_map.into_iter().collect();
            conns.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
            for (c, (cnt, sz)) in conns {
                md.push_str(&format!("- **{}**：{} 项 / {:.1} KB\n", c, cnt, sz as f64 / 1024.0));
            }
            md.push_str("\n## 按类型\n");
            for (k, cnt) in kind_map {
                md.push_str(&format!("- {}：{} 项\n", k, cnt));
            }
            md.push_str("\n## 明细\n");
            for a in &items {
                md.push_str(&format!(
                    "- [{}] {}（{}）{}\n",
                    a.kind,
                    a.name,
                    a.connector,
                    a.path.as_ref().map(|p| format!(" — {p}")).unwrap_or_default()
                ));
            }
            Ok(md)
        }
    }
}


// ---------- 跨工具对比：按名称聚合（≥2 连接器）+ 按内容完全一致聚合（同名不同名但内容相同）----------
fn member_json(a: &Artifact, hash: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "id": a.id,
        "connector": a.connector,
        "kind": a.kind,
        "size": a.size,
        "name": a.name,
        "path": a.path,
        "created_at": a.created_at,
        "has_content": a.content.is_some(),
        "content_hash": hash,
    })
}


#[tauri::command]
fn compare_groups(filter: Option<HashMap<String, String>>) -> Vec<serde_json::Value> {
    let mut items = load_store();
    // 时间快捷筛选：since/until 为 epoch 秒，区间 [since, until)，只比较窗口内的产物
    if let Some(f) = filter {
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
    // 为每件产物附加内容指纹
    let infos: Vec<(Artifact, Option<String>)> = items
        .into_iter()
        .map(|a| {
            let h = artifact_content_hash(&a);
            (a, h)
        })
        .collect();

    let mut groups: Vec<serde_json::Value> = Vec::new();

    // 1) 按归一化名称聚合（需出现于 ≥2 个连接器）
    let mut by_name: HashMap<String, Vec<(Artifact, Option<String>)>> = HashMap::new();
    for it in &infos {
        by_name.entry(norm_name(&it.0.name)).or_default().push(it.clone());
    }
    for (key, arts) in by_name {
        let conns: HashSet<String> = arts.iter().map(|x| x.0.connector.clone()).collect();
        if conns.len() < 2 {
            continue;
        }
        let mut members: Vec<serde_json::Value> = arts
            .iter()
            .map(|(a, h)| member_json(a, h.clone()))
            .collect();
        members.sort_by(|x, y| {
            x["connector"]
                .as_str()
                .cmp(&y["connector"].as_str())
        });
        let hashes: HashSet<Option<String>> = arts.iter().map(|x| x.1.clone()).collect();
        let identical = hashes.len() == 1
            && hashes.iter().next().map(|x| x.is_some()).unwrap_or(false);
        groups.push(serde_json::json!({
            "match": "name",
            "key": key,
            "name": arts[0].0.name,
            "count": arts.len(),
            "latest": arts.iter().map(|x| x.0.created_at).max().unwrap_or(0),
            "size_total": arts.iter().map(|x| x.0.size).sum::<u64>(),
            "connectors": members,
            "identical": identical
        }));
    }

    // 2) 按内容指纹聚合（相同内容、但文件名不同 → 至少 2 个不同归一化名）
    let mut by_hash: HashMap<String, Vec<(Artifact, Option<String>)>> = HashMap::new();
    for it in &infos {
        if let Some(h) = &it.1 {
            by_hash.entry(h.clone()).or_default().push(it.clone());
        }
    }
    for (h, arts) in by_hash {
        if arts.len() < 2 {
            continue;
        }
        let names: HashSet<String> = arts.iter().map(|x| norm_name(&x.0.name)).collect();
        if names.len() < 2 {
            continue; // 同名已在上一步处理
        }
        let mut members: Vec<serde_json::Value> = arts
            .iter()
            .map(|(a, _)| member_json(a, Some(h.clone())))
            .collect();
        members.sort_by(|x, y| x["connector"].as_str().cmp(&y["connector"].as_str()));
        groups.push(serde_json::json!({
            "match": "content",
            "key": h,
            "name": "内容完全一致（文件名不同）",
            "count": arts.len(),
            "latest": arts.iter().map(|x| x.0.created_at).max().unwrap_or(0),
            "size_total": arts.iter().map(|x| x.0.size).sum::<u64>(),
            "connectors": members,
            "identical": true
        }));
    }

    groups.sort_by(|a, b| {
        let ma = a["match"].as_str().unwrap_or("");
        let mb = b["match"].as_str().unwrap_or("");
        if ma != mb {
            return mb.cmp(ma); // 内容完全一致优先
        }
        b["count"].as_u64().cmp(&a["count"].as_u64())
    });
    groups
}


// ---------- 通用文件命令（文件树 / 预览 / 在访达显示 / 导出）----------
#[derive(serde::Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}


const FS_IGNORE: [&str; 8] = [
    ".DS_Store",
    ".kernel-events.log",
    "node_modules",
    ".git",
    "target",
    "dist",
    "gen",
    "node_modules",
];

#[tauri::command]
fn list_dir(path: Option<String>) -> Result<Vec<DirEntryInfo>, String> {
    let root = agent_core::data_root();
    let rel = path.unwrap_or_default();
    let base = if rel.trim().is_empty() {
        root.clone()
    } else if Path::new(&rel).is_absolute() {
        PathBuf::from(&rel)
    } else {
        root.join(&rel)
    };
    let rd = std::fs::read_dir(&base).map_err(|e| format!("读取目录失败 {}: {e}", base.display()))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if FS_IGNORE.contains(&name.as_str()) || name.starts_with(".kernel-events") {
            continue;
        }
        let p = entry.path();
        let md = entry.metadata().ok();
        let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
        let relpath = p
            .strip_prefix(&root)
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_else(|_| p.to_string_lossy().to_string());
        out.push(DirEntryInfo { name, path: relpath, is_dir, size });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}


#[tauri::command]
fn read_artifact(path: String) -> Result<String, String> {
    read_artifact_impl(path)
}


#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("当前仅支持 macOS 的「在访达中显示」".into());
    }
    let root = agent_core::data_root();
    let p = if Path::new(&path).is_absolute() {
        PathBuf::from(&path)
    } else {
        root.join(&path)
    };
    Command::new("open")
        .arg("-R")
        .arg(&p)
        .spawn()
        .map_err(|e| format!("打开访达失败: {e}"))?;
    Ok(())
}


#[tauri::command]
fn save_export(content: String, filename: String) -> Result<String, String> {
    let dir = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|h| h.join("Downloads"))
        .filter(|p| p.is_dir())
        .unwrap_or_else(agent_core::data_root);
    let path = dir.join(filename);
    std::fs::write(&path, content).map_err(|e| format!("写入失败 {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}


// ---------- 中心统一数据门面：本机 + 所有在线代理的合并视图 ----------
//
// 这是「本机与远程通用」的落点：前端只调这几个命令，
// 后端把本机数据与各在线代理的数据合并成同一份结构返回，
// 条目用 origin 标出它来自哪台机器（本机为 None）。
//
// 单台代理失败（离线/超时）不影响其它来源 —— 合并视图里跳过并记录到 errors。

/// 合并结果里附带的来源与错误信息。
///
/// 三个字段合起来回答一个问题：「我拿到的数据全吗？」
///   - sources：本次有数据贡献的节点
///   - offline：已登记但当前离线的节点（它们的���据这轮没拿到）
///   - errors：取数失败的节点与原因
#[derive(serde::Serialize)]
pub struct MergedMeta {
    /// 数据来源节点（本机名 + 各代理名）
    pub sources: Vec<String>,
    /// 已登记但当前离线的节点
    pub offline: Vec<String>,
    /// 各来源的失败原因（离线 / 超时 / 协议错误）
    pub errors: Vec<String>,
    /// 合并后的条目总数
    pub total: usize,
}


/// 合并视图的响应信封：{ list, meta }。
///
/// 为什么不用元组：元组序列化成 JSON 数组，前端拿不到具名字段
/// （res.list / res.meta 全是 undefined），界面会静默显示成空列表。
/// 具名结构两边都读得懂，也和协议层的 {list, meta} 保持一致。
#[derive(serde::Serialize)]
pub struct Merged<T> {
    pub list: T,
    pub meta: MergedMeta,
}

/// 给远端条目打上来源标记，并保证 id 全局唯一。
///
/// 产物 id 在单机内唯一（g-{connector}-{kind}-{path hash}），但两台机器可能有同名路径
/// （例如都在 /Users/xiaoxiao/... 下），合并后会撞 id。所以远端条目的 id 加节点前缀。
fn tag_remote_artifact(mut a: Artifact, node_id: &str, node_name: &str) -> Artifact {
    a.id = format!("{node_id}:{}", a.id);
    a.origin = Some(node_id.to_string()); // 路由用：转发给哪台节点
    a.origin_name = Some(node_name.to_string()); // 展示用：给人看的名字
    a
}

fn tag_remote_conv(mut c: agent_core::service::ConvBrief, node_id: &str, node_name: &str) -> agent_core::service::ConvBrief {
    c.id = format!("{node_id}:{}", c.id);
    c.origin = Some(node_name.to_string()); // 展示用
    c
}


/// 合并后的会话列表（本机 + 各在线代理）。
#[tauri::command]
fn list_all_conversations(
    connector: Option<String>,
    limit: Option<usize>,
) -> Merged<agent_core::service::ConvList> {
    merged_conversations(connector, limit)
}


/// 合并会话列表的实现（中心统一数据门面的核心）。
///
/// Tauri 命令与协议层的 op 分发共用同一份逻辑，
/// 保证「界面里看到的」与「脚本里拉到的」是同一套数据。
pub fn merged_conversations(
    connector: Option<String>,
    limit: Option<usize>,
) -> Merged<agent_core::service::ConvList> {
    let mut items: Vec<agent_core::service::ConvBrief> = agent_core::service::list_conversations(connector.clone(), limit).items;
    let mut sources = vec![default_node()];
    let mut errors: Vec<String> = Vec::new();

    // 各代理并发拉取（串行会按代理数线性放大等待时间）
    let results = hub::broadcast(
        agent_core::proto::ops::LIST_CONVERSATIONS,
        serde_json::json!({
            "connector": connector,
            "limit": limit,
        }),
        std::time::Duration::from_secs(20),
    );
    for (node_id, name, r) in results {
        match r {
            Ok(v) => {
                if let Ok(list) = serde_json::from_value::<agent_core::service::ConvList>(v) {
                    for c in list.items {
                        items.push(tag_remote_conv(c, &node_id, &name));
                    }
                }
                sources.push(name);
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let total = items.len();
    if let Some(l) = limit {
        if items.len() > l {
            items.truncate(l);
        }
    }
    let meta = MergedMeta {
        sources,
        offline: hub::offline_proxies(),
        errors,
        total,
    };
    Merged {
        list: agent_core::service::ConvList { total, items },
        meta,
    }
}


/// 合并后的产物列表（本机 + 各在线代理）。
#[tauri::command]
fn list_all_artifacts(filter: Option<HashMap<String, String>>) -> Merged<Vec<Artifact>> {
    merged_artifacts(filter)
}


/// 合并产物列表的实现。
pub fn merged_artifacts(filter: Option<HashMap<String, String>>) -> Merged<Vec<Artifact>> {
    let mut items = agent_core::service::list_artifacts(filter.clone());
    let mut sources = vec![default_node()];
    let mut errors: Vec<String> = Vec::new();

    let results = hub::broadcast(
        agent_core::proto::ops::LIST_ARTIFACTS,
        serde_json::json!({ "filter": filter }),
        std::time::Duration::from_secs(30),
    );
    for (node_id, name, r) in results {
        match r {
            Ok(v) => {
                if let Ok(list) = serde_json::from_value::<Vec<Artifact>>(v) {
                    for a in list {
                        items.push(tag_remote_artifact(a, &node_id, &name));
                    }
                }
                sources.push(name);
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let meta = MergedMeta {
        sources,
        offline: hub::offline_proxies(),
        errors,
        total: items.len(),
    };
    Merged { list: items, meta }
}


/// 合并后的任务列表（本机 + 各在线代理）。
#[tauri::command]
fn list_all_tasks() -> Merged<Vec<TaskRec>> {
    merged_tasks()
}


/// 合并任务列表的实现。
pub fn merged_tasks() -> Merged<Vec<TaskRec>> {
    let mut items = agent_core::service::list_tasks();
    let mut sources = vec![default_node()];
    let mut errors: Vec<String> = Vec::new();

    let results = hub::broadcast(
        agent_core::proto::ops::LIST_TASKS,
        serde_json::Value::Null,
        std::time::Duration::from_secs(15),
    );
    for (node_id, name, r) in results {
        match r {
            Ok(v) => {
                if let Ok(list) = serde_json::from_value::<Vec<TaskRec>>(v) {
                    for mut t in list {
                        // 远端任务 id 加节点前缀，避免与本机撞 id
                        t.id = format!("{node_id}:{}", t.id);
                        t.origin = Some(name.clone());
                        items.push(t);
                    }
                }
                sources.push(name);
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let meta = MergedMeta {
        sources,
        offline: hub::offline_proxies(),
        errors,
        total: items.len(),
    };
    Merged { list: items, meta }
}


/// 合并后的 token 统计（本机 + 各在线代理，按连接器聚合）。
///
/// 远端返回的是「按连接器聚合」的结果 —— 合并时同名连接器要**累加**，
/// 而不是并列成两行（两台机器都用 WorkBuddy 是常态）。
#[tauri::command]
fn list_all_token_stats() -> Merged<Vec<agent_core::TokenStat>> {
    merged_token_stats()
}


pub fn merged_token_stats() -> Merged<Vec<agent_core::TokenStat>> {
    let mut items = agent_core::service::token_stats();
    let mut sources = vec![default_node()];
    let mut errors: Vec<String> = Vec::new();

    let results = hub::broadcast(
        agent_core::proto::ops::TOKEN_STATS,
        serde_json::Value::Null,
        std::time::Duration::from_secs(30),
    );
    for (_node_id, name, r) in results {
        match r {
            Ok(v) => {
                if let Ok(list) = serde_json::from_value::<Vec<agent_core::TokenStat>>(v) {
                    for t in list {
                        // 同名连接器累加；不同节点各有同名工具时合成一行
                        if let Some(existing) = items.iter_mut().find(|x| x.connector == t.connector) {
                            existing.usage.merge(&t.usage);
                        } else {
                            items.push(t);
                        }
                    }
                }
                sources.push(name);
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }

    items.sort_by(|a, b| b.usage.input.cmp(&a.usage.input));
    let meta = MergedMeta {
        sources,
        offline: hub::offline_proxies(),
        errors,
        total: items.len(),
    };
    Merged { list: items, meta }
}


/// 统一的 op 分发：中心收到「取数据」的请求时，走本机 + 远端合并。
///
/// 协议层客户端与图形界面走同一个入口 —— 这是「本机与远程通用」
/// 在协议层的落点：调用方只管说 op，不用关心数据在哪个节点。
pub fn serve_query_op(op: &str, args: &serde_json::Value) -> Result<serde_json::Value, String> {
    use proto::ops;
    match op {
        ops::LIST_CONVERSATIONS => {
            let connector = args
                .get("connector")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
            let m = merged_conversations(connector, limit);
            // 会话的 list 是 {total, items}，这里统一摊平成数组 + meta.total，
            // 让三种 op 的响应结构一致（调用方不用各写一套解析）。
            Ok(serde_json::json!({
                "list": m.list.items,
                "meta": { "total": m.list.total, "sources": m.meta.sources, "offline": m.meta.offline, "errors": m.meta.errors }
            }))
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
            let m = merged_artifacts(filter);
            Ok(serde_json::json!({
                "list": m.list,
                "meta": { "total": m.meta.total, "sources": m.meta.sources, "offline": m.meta.offline, "errors": m.meta.errors }
            }))
        }
        ops::LIST_TASKS => {
            let m = merged_tasks();
            Ok(serde_json::json!({
                "list": m.list,
                "meta": { "total": m.meta.total, "sources": m.meta.sources, "offline": m.meta.offline, "errors": m.meta.errors }
            }))
        }
        ops::TOKEN_STATS => {
            let m = merged_token_stats();
            Ok(serde_json::json!({
                "list": m.list,
                "meta": { "total": m.meta.total, "sources": m.meta.sources, "offline": m.meta.offline, "errors": m.meta.errors }
            }))
        }
        ops::STATS => Ok(agent_core::service::stats()),
        // 读文件 / 取单个产物：要指明读哪台节点（args.node 是代理 id），
        // 不传就读本机 —— 与界面的 read_artifact_any / get_artifact_any 语义一致。
        ops::READ_FILE => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("缺少 path")?
                .to_string();
            let node = args.get("node").and_then(|v| v.as_str()).unwrap_or("");
            if node.is_empty() {
                Ok(serde_json::Value::String(agent_core::service::read_file(path)?))
            } else {
                hub::hub_state().request(
                    node,
                    ops::READ_FILE,
                    serde_json::json!({ "path": path }),
                    std::time::Duration::from_secs(30),
                )
            }
        }
        ops::GET_ARTIFACT => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("缺少 id")?
                .to_string();
            let node = args.get("node").and_then(|v| v.as_str()).unwrap_or("");
            if node.is_empty() {
                match agent_core::service::get_artifact(id) {
                    Some(a) => Ok(serde_json::to_value(a).map_err(|e| format!("序列化失败: {e}"))?),
                    None => Ok(serde_json::Value::Null),
                }
            } else {
                hub::hub_state().request(
                    node,
                    ops::GET_ARTIFACT,
                    serde_json::json!({ "id": id }),
                    std::time::Duration::from_secs(20),
                )
            }
        }
        other => Err(format!("不支持的 op: {other}")),
    }
}


/// 取单个产物（自动路由到来源节点）。
///
/// 远端条目的 id 形如 "代理id:g-workbuddy-conv-xxxx" —— 合并时加节点前缀是为了
/// 保证跨机器唯一（两台机器可能有同名路径）。这里按**最后一个冒号**切分，
/// 节点名本身含冒号也不会切错。
#[tauri::command]
fn get_artifact_any(id: String) -> Option<Artifact> {
    if let Some((node, real_id)) = id.rsplit_once(':') {
        if !real_id.is_empty() && !node.is_empty() {
            if let Ok(v) = hub::hub_state().request(
                node,
                agent_core::proto::ops::GET_ARTIFACT,
                serde_json::json!({ "id": real_id }),
                std::time::Duration::from_secs(20),
            ) {
                if let Ok(mut a) = serde_json::from_value::<Artifact>(v) {
                    a.origin = Some(node.to_string());
                    return Some(a);
                }
            }
            return None;
        }
    }
    agent_core::service::get_artifact(id)
}


/// 读文件内容（自动路由到来源节点）。
///
/// 远端产物的 path 是**那台机器上的**路径，本机读不到也不该读
/// （本机可能有同名路径，读出来是错的内容）。
/// 所以按 origin（来源节点 id）转发给来源节点，让它读自己本机的文件。
#[tauri::command]
fn read_artifact_any(path: String, origin: Option<String>) -> Result<String, String> {
    if let Some(node_id) = origin.as_deref().filter(|n| !n.is_empty()) {
        let v = hub::hub_state().request(
            node_id,
            agent_core::proto::ops::READ_FILE,
            serde_json::json!({ "path": path }),
            std::time::Duration::from_secs(30),
        )?;
        return v
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "远端返回的文件内容不是字符串".to_string());
    }
    agent_core::service::read_file(path)
}


/// 已接入的代理 agent 列表（在线状态 + 最近一次 activity 快照）。
/// 前端「已接入机器」面板与像素办公室都从这份数据取远端状态。
#[tauri::command]
fn list_proxies() -> Vec<hub::ProxyInfo> {
    hub::hub_state().snapshot()
}


/// 让桌面端担任中心 hub：起监听等待代理接入（默认仅本机，绑 0.0.0.0 时暴露到局域网）。
#[tauri::command]
fn hub_start(host: Option<String>, port: Option<u16>, secret: String) -> Result<(), String> {
    if secret.trim().is_empty() {
        return Err("共享密钥不能为空".into());
    }
    let h = host.unwrap_or_else(|| "127.0.0.1".to_string());
    let p = port.unwrap_or(47800);
    hub::start_hub(&h, p, secret)
}


/// 停止中心 hub：让监听线程退出并释放端口。
#[tauri::command]
fn hub_stop() -> bool {
    hub::stop_hub()
}


/// 中心 hub 是否正在运行。
#[tauri::command]
fn hub_running() -> bool {
    hub::hub_running()
}


/// 启动桌面应用（中心）。
///
/// 拆成 lib + bin 是 Tauri v2 的标准布局：业务逻辑放 lib（可被集成测试直接调用），
/// 二进制只做一件事 —— 把窗口跑起来。
pub fn run() {
    // 数据根目录：开发期沿用项目目录（artifacts.json / connectors.json 都在这），
    // 装到别的机器上则落到用户数据目录，并把开发期数据带过去（见 agent_core::paths）。
    let dev_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let root = agent_core::resolve_data_root(None, dev_root);
    agent_core::set_data_root(root.clone());
    eprintln!("[agentry] 数据目录 = {}", root.display());

    // 早期版本入库的会话里混着大量 <system-reminder>/<environment_context>，
    // 入库去重导致它们不会自动更新 —— 启动时洗一遍，之后幂等。
    agent_core::migrate_store();
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|_app| {
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connectors,
            remove_connector,
            list_tasks,
            list_conversations,
            tool_activity,
            list_artifacts,
            artifact_stats,
            get_artifact,
            compare_groups,
            delete_artifact,
            clear_artifacts,
            sync_connector,
            sync_all,
            export_all,
            list_dir,
            read_artifact,
            open_in_finder,
            save_export,
            list_proxies,
            hub_start,
            hub_stop,
            hub_running,
            list_all_conversations,
            list_all_artifacts,
            list_all_tasks,
            list_all_token_stats,
            get_artifact_any,
            read_artifact_any
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
