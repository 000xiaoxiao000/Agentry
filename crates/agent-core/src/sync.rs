use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::activity::mtime_secs;
use crate::model::{Artifact, Connector, SyncReport};
use crate::paths::data_root;
use crate::session::{collect_jsonl, collect_paths_from_text, parse_session_text, session_title};
use crate::store::{load_connectors, load_store, save_store};
use crate::text::{expand, hash_str, is_noise_file, snap_recursive_map, truncate_utf8};

// 同步单个连接器：把 session_roots 下的全部历史会话收为对话产物、抽取会话内引用的文件为文件产物，
// 并把 session_roots 目录里（非 jsonl）的现存文件也收为产物。按 (connector,path) 去重，结果追加进 store。
//
// on_progress 可选：桌面端用它把同步进度推给界面；远端代理没有界面，传 None。
// 但同步逻辑本身两边完全一致 —— 这样远端产物的收录口径与本机不会漂移。
pub fn sync_ingest_connector(
    on_progress: Option<&dyn Fn(&str, serde_json::Value)>,
    c: &Connector,
    store: &mut Vec<Artifact>,
    existing: &mut HashSet<(String, String)>,
    report: &mut SyncReport,
    progress: &mut u64,
) {
    let home = std::env::var("HOME").unwrap_or_default();
    let task_dir = data_root().join("tasks").join(&c.id);
    let configured = c.session_roots.clone().unwrap_or_default();
    if configured.is_empty() {
        report
            .errors
            .push(format!("连接器 {} 未配置 session_roots，跳过", c.id));
        return;
    }
    // 统一对端协议已取代 SSH 远程：会话目录一律按本地路径解析。
    let roots: Vec<PathBuf> = configured
        .iter()
        .map(|d| expand(d, &home, &task_dir))
        .collect();
    if roots.is_empty() {
        return;
    }
    let mut path_set: HashSet<String> = HashSet::new();
    // "connector|path" -> store 下标。已收录的条目也要刷新 mtime / 大小，
    // 否则「今天」「最近活动」永远停在第一次同步那一刻，和工具里实际在更新的会话对不上。
    let mut index: HashMap<String, usize> = HashMap::new();
    for (i, a) in store.iter().enumerate() {
        if let Some(p) = &a.path {
            index.insert(format!("{}|{}", a.connector, p), i);
        }
    }
    for root in &roots {
        // 1) 历史会话 jsonl → 对话产物（每个会话 = 一个历史任务）
        let mut js: Vec<PathBuf> = Vec::new();
        collect_jsonl(root, &mut js, 0);
        for j in js {
            if report.conversations >= 3000 {
                break;
            }
            let p_s = j.display().to_string();
            if existing.contains(&(c.id.clone(), p_s.clone())) {
                if let Some(a) = index.get(&format!("{}|{}", c.id, p_s)).and_then(|i| store.get_mut(*i)) {
                    a.created_at = mtime_secs(&j);
                }
                continue;
            }
            if let Some(text) = parse_session_text(&j) {
                let text = truncate_utf8(&text, 100_000);
                let title = session_title(&text);
                let size = text.len() as u64;
                let id = format!("g-{}-conv-{}", c.id, hash_str(&p_s));
                store.push(Artifact {
                    id: id.clone(),
                    connector: c.id.clone(),
                    task_id: id.clone(),
                    kind: "conversation".into(),
                    name: title,
                    path: Some(p_s.clone()),
                    content: Some(text),
                    created_at: mtime_secs(&j),
                    size,
                
                origin: None,
                origin_name: None,});
                existing.insert((c.id.clone(), p_s.clone()));
                index.insert(format!("{}|{}", c.id, p_s), store.len() - 1);
                report.conversations += 1;
                *progress += 1;
                if *progress % 250 == 0 {
                    if let Some(cb) = on_progress {
                        cb(
                            "agent-event",
                            serde_json::json!({"type":"sync-progress","connector":c.id,"count":*progress}),
                        );
                    }
                }
                if let Ok(raw) = std::fs::read_to_string(&j) {
                    collect_paths_from_text(&raw, &mut path_set);
                }
            }
        }
        // 2) session_roots 目录下（非 jsonl）的现存文件 → 文件产物
        let mut fm: HashMap<String, (PathBuf, u64)> = HashMap::new();
        snap_recursive_map(root, None, &mut fm);
        for (rel, (abs, _key)) in fm {
            if report.files >= 8000 {
                break;
            }
            let abs_s = abs.display().to_string();
            // 跳过工具内部临时文件（chatcmpl-*.txt / tool-results/ 等），它们对用户没有意义
            if is_noise_file(&rel, &abs_s) {
                continue;
            }
            if existing.contains(&(c.id.clone(), abs_s.clone())) {
                // 已知文件：刷新大小与时间（内容可能被工具追加写过）
                let size = abs.metadata().map(|m| m.len()).unwrap_or(0);
                if let Some(a) = index.get(&format!("{}|{}", c.id, abs_s)).and_then(|i| store.get_mut(*i)) {
                    a.created_at = mtime_secs(&abs);
                    if size > 0 {
                        a.size = size;
                    }
                }
                continue;
            }
            let size = abs.metadata().map(|m| m.len()).unwrap_or(0);
            let id = format!("g-{}-file-{}", c.id, hash_str(&abs_s));
            store.push(Artifact {
                id: id.clone(),
                connector: c.id.clone(),
                task_id: id.clone(),
                kind: "file".into(),
                name: rel,
                path: Some(abs_s.clone()),
                content: None,
                created_at: mtime_secs(&abs),
                size,
            
                origin: None,
                origin_name: None,});
            existing.insert((c.id.clone(), abs_s.clone()));
            index.insert(format!("{}|{}", c.id, abs_s), store.len() - 1);
            report.files += 1;
            *progress += 1;
            if *progress % 250 == 0 {
                if let Some(cb) = on_progress {
                    cb(
                        "agent-event",
                        serde_json::json!({"type":"sync-progress","connector":c.id,"count":*progress}),
                    );
                }
            }
        }
        if report.conversations >= 3000 || report.files >= 8000 {
            break;
        }
    }
    // 3) 会话里引用的、仍存在于磁盘的文件 → 文件产物（真实「产物」）
    let mut added = 0u64;
    for p in path_set {
        if added >= 8000 || report.files >= 8000 {
            break;
        }
        if existing.contains(&(c.id.clone(), p.clone())) {
            continue;
        }
        let pb = PathBuf::from(&p);
        let md = match std::fs::metadata(&pb) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !md.is_file() || md.len() > 5_000_000 {
            continue;
        }
        let size = md.len();
        let name = pb
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_else(|| p.clone());
        if is_noise_file(&name, &p) {
            continue;
        }
        let id = format!("g-{}-file-{}", c.id, hash_str(&p));
        store.push(Artifact {
            id: id.clone(),
            connector: c.id.clone(),
            task_id: id.clone(),
            kind: "file".into(),
            name,
            path: Some(p.clone()),
            content: None,
            created_at: mtime_secs(&pb),
            size,
            origin: None,
            origin_name: None,
        });
        existing.insert((c.id.clone(), p.clone()));
        report.files += 1;
        added += 1;
        *progress += 1;
        if *progress % 250 == 0 {
            if let Some(cb) = on_progress {
                cb(
                    "agent-event",
                    serde_json::json!({"type":"sync-progress","connector":c.id,"count":*progress}),
                );
            }
        }
    }
}


/// 全量同步的核心逻辑（on_progress 可选）。
///
/// 抽出来的原因：无界面代理要维护自己的产物索引，但没有界面可发进度。
/// 两边共用同一段代码 —— 远端收录产物的口径与本机完全一致，不会出现
/// 「本机有、远端没有」或字段结构不同的情况。
pub fn sync_all_core(on_progress: Option<&dyn Fn(&str, serde_json::Value)>) -> Vec<SyncReport> {
    let connectors = load_connectors();
    let mut store = load_store();
    let mut existing: HashSet<(String, String)> = store
        .iter()
        .filter_map(|a| a.path.clone().map(|p| (a.connector.clone(), p)))
        .collect();
    let mut reports: Vec<SyncReport> = Vec::new();
    for c in &connectors {
        // 只有配了 session_roots 的连接器才参与全量同步（cursor / mcp-demo 等跳过）
        if c.session_roots.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
            continue;
        }
        let mut report = SyncReport {
            connector: c.id.clone(),
            conversations: 0,
            files: 0,
            errors: Vec::new(),
        };
        let mut progress = 0u64;
        sync_ingest_connector(on_progress, c, &mut store, &mut existing, &mut report, &mut progress);
        reports.push(report);
    }
    save_store(&store);
    reports
}
