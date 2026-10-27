use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use crate::model::Artifact;
use crate::store::{load_store, save_store};
use crate::text::{ignored, tidy_text, truncate_utf8};
use crate::workspace::workspace_project_dir;

// 收集目录下所有 *.jsonl（深度受限，跳过噪声目录）。
pub fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 12 {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if ignored(&name) {
            continue;
        }
        if let Ok(md) = e.metadata() {
            if md.is_dir() {
                collect_jsonl(&p, out, depth + 1);
            } else if name.ends_with(".jsonl") {
                out.push(p);
            }
        }
    }
}


// 宽松解析各类工具的会话 jsonl（WorkBuddy / Codex / Claude 通用）。
// 兼容两种结构：顶层 {type:"message",role,content} 与
// {type:"response_item",payload:{type:"message",role,content}}（Codex）。
// 仅提取 user / assistant 的消息，拼接为 Markdown，避免吞入 developer/system 指令噪声。
pub fn parse_session_text(path: &Path) -> Option<String> {
    let s = std::fs::read_to_string(path).ok()?;
    let mut out = String::new();
    let mut total = 0usize;
    for line in s.lines() {
        if total > 200000 {
            break;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            // 候选对象：顶层本身，及其 payload 子对象（Codex 把消息包在 payload 里）
            let mut objs: Vec<&serde_json::Value> = Vec::new();
            objs.push(&v);
            if let Some(p) = v.get("payload") {
                objs.push(p);
            }
            for obj in objs {
                let role = obj.get("role").and_then(|r| r.as_str()).unwrap_or("");
                let ok_role = role == "user" || role == "assistant";
                let content = obj.get("content");
                if !(ok_role && content.is_some()) {
                    continue;
                }
                let text = match content {
                    Some(serde_json::Value::String(s)) => Some(s.clone()),
                    Some(serde_json::Value::Array(arr)) => {
                        let mut t = String::new();
                        for it in arr {
                            for key in ["text", "input_text", "output_text"] {
                                if let Some(tx) = it.get(key).and_then(|x| x.as_str()) {
                                    t.push_str(tx);
                                    t.push('\n');
                                    break;
                                }
                            }
                        }
                        if t.trim().is_empty() {
                            None
                        } else {
                            Some(t)
                        }
                    }
                    _ => None,
                };
                if let Some(raw_text) = text {
                    // 剥掉 <system-reminder> 之类的系统注入块，否则对话视图和标题全是机器噪声
                    let cleaned = tidy_text(&raw_text);
                    if !cleaned.trim().is_empty() {
                        let c = truncate_utf8(&cleaned, 20000);
                        out.push_str(&format!("### {}\n", role));
                        out.push_str(&c);
                        out.push_str("\n\n");
                        total += c.len();
                    }
                }
            }
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}


// 同步用：从会话内容里提取一个可读标题。
// 优先取第一条「有实质内容」的 user 文本（跳过 /命令、纯符号、系统块残留）；
// 找不到就退化为首条 assistant 文本，再不行才用「未命名会话」。
pub fn session_title(content: &str) -> String {
    fn pick(content: &str, want_role: &str) -> Option<String> {
        let mut in_role = false;
        let mut buf = String::new();
        for line in content.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("### ") {
                if in_role && !buf.trim().is_empty() {
                    break;
                }
                in_role = rest.trim() == want_role;
                buf.clear();
                continue;
            }
            if !in_role {
                continue;
            }
            if t.is_empty() {
                continue;
            }
            // 跳过斜杠命令、纯标点、残留标签行、机器生成的摘要行、过短片段
            let low = t.to_lowercase();
            if (t.starts_with('/') && t.len() < 24)
                || t.starts_with('<')
                || low.starts_with("summary of the conversation")
                || low.starts_with("here is a summary")
                || t.starts_with("以下是对话摘要")
                || t.starts_with("对话摘要")
                || t.chars().all(|c| "-=*_#>`~|".contains(c))
            {
                continue;
            }
            buf.push_str(t);
            buf.push(' ');
            if buf.chars().count() > 70 {
                break;
            }
        }
        let t = buf.trim().to_string();
        if t.chars().count() >= 2 {
            Some(t)
        } else {
            None
        }
    }

    let raw = pick(content, "user")
        .or_else(|| pick(content, "assistant"))
        .unwrap_or_else(|| "未命名会话".to_string());
    let short: String = raw.chars().take(44).collect();
    if raw.chars().count() > 44 {
        format!("{short}…")
    } else {
        short
    }
}


// 列表用预览：跳过角色标题行，压成一行，截断到 max 个字符。
pub fn conversation_preview(content: &str, max: usize) -> String {
    let mut out = String::new();
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("### ") {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
        if out.chars().count() >= max {
            break;
        }
    }
    let mut s: String = out.chars().take(max).collect();
    if out.chars().count() > max {
        s.push('…');
    }
    s
}


// 把一条已入库的对话产物重洗干净（名字 + 正文 + 大小）。
// 返回 true 表示确实改动了；内容为空（整条都是系统注入块）返回 false 由调用方删除。
pub fn clean_conversation_artifact(a: &mut Artifact) -> bool {
    if a.kind != "conversation" {
        return false;
    }
    let original = match a.content.clone() {
        Some(c) => c,
        None => return false,
    };
    let cleaned = tidy_text(&original);
    if cleaned.trim().is_empty() {
        return false;
    }
    let new_name = session_title(&cleaned);
    if cleaned == original && new_name == a.name {
        return false;
    }
    a.size = cleaned.len() as u64;
    a.content = Some(cleaned);
    a.name = new_name;
    true
}


// 启动时一次性洗库：早期版本入库的会话带上大量 <system-reminder>/<environment_context>，
// 而 sync 的 existing 去重会让它们永远不再重解析，所以必须在读取侧统一修一遍。
pub fn migrate_store() -> usize {
    let mut items = load_store();
    let before = items.len();
    let mut changed = 0usize;
    items.retain_mut(|a| {
        if a.kind != "conversation" {
            return true;
        }
        let had_content = a.content.as_ref().map(|c| !c.trim().is_empty()).unwrap_or(false);
        if !had_content {
            changed += 1;
            return false;
        }
        if clean_conversation_artifact(a) {
            changed += 1;
        }
        true
    });
    if changed > 0 {
        save_store(&items);
        eprintln!(
            "[ai-orchestrator] 已清洗历史产物：{} 项改动 / {} 条删除（{} → {}）",
            changed,
            before.saturating_sub(items.len()),
            before,
            items.len()
        );
    }
    changed
}


// 同步用：判断字符串是否像一个绝对文件路径（且非系统/依赖目录），用于从会话里抽取「产物」文件。
pub fn looks_like_path(s: &str) -> bool {
    let s = s.trim();
    if s.len() < 4 || s.len() > 400 || !s.starts_with('/') || !s.contains('/') {
        return false;
    }
    if s.starts_with("/System")
        || s.starts_with("/usr/")
        || s.starts_with("/Library/")
        || s.starts_with("/private/var")
        || s.starts_with("/proc")
        || s.starts_with("/dev")
        || s.starts_with("/Applications/")
        || s.contains("/node_modules/")
        || s.contains("/.git/")
    {
        return false;
    }
    let last = s.rsplit('/').next().unwrap_or("");
    !last.is_empty() && last.contains('.') && !last.ends_with('/')
}


// 同步用：递归遍历 JSON，收集所有像文件路径的字符串。
pub fn collect_paths_from_json(v: &serde_json::Value, out: &mut HashSet<String>) {
    match v {
        serde_json::Value::String(s) => {
            if looks_like_path(s) {
                out.insert(s.trim().to_string());
            }
        }
        serde_json::Value::Array(a) => {
            for it in a {
                collect_paths_from_json(it, out);
            }
        }
        serde_json::Value::Object(o) => {
            for (_, val) in o {
                collect_paths_from_json(val, out);
            }
        }
        _ => {}
    }
}

pub fn collect_paths_from_text(text: &str, out: &mut HashSet<String>) {
    for line in text.lines() {
        if out.len() > 6000 {
            return;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            collect_paths_from_json(&v, out);
        }
    }
}


/// 读文件尾部最多 max 字节（大文件也只读尾巴，避免把 36MB 的会话全读进来）
pub fn read_tail(path: &Path, max: usize) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len() as usize;
    let start = len.saturating_sub(max);
    f.seek(SeekFrom::Start(start as u64)).ok()?;
    let mut buf = Vec::with_capacity(len - start);
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}


/// 从一条 JSON 记录里抽取用户可见文本（content 可能是字符串，或其分段数组 / 嵌套 message.content）。
pub fn extract_user_text(v: &serde_json::Value) -> Option<String> {
    let content = v
        .get("content")
        .or_else(|| v.get("message").and_then(|m| m.get("content")))?;
    if let Some(s) = content.as_str() {
        return Some(s.trim().to_string());
    }
    if let Some(arr) = content.as_array() {
        let mut out = String::new();
        for part in arr {
            let t = part
                .get("text")
                .and_then(|x| x.as_str())
                .or_else(|| part.get("content").and_then(|x| x.as_str()));
            if let Some(t) = t {
                let t = t.trim();
                if !t.is_empty() {
                    out.push_str(t);
                    out.push(' ');
                }
            }
        }
        let s = out.trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}


/// 会话文件的头部元信息：工作目录 + 工具自己生成的短标题。
#[derive(Clone, Default)]
pub struct HeadMeta {
    pub cwd: Option<String>,
    pub title: Option<String>,
}


/// 头部元信息缓存：key = 会话文件路径，value = (mtime, meta)。
/// 列表每次刷新都要给上千条会话取 cwd/短标题，若每次都读 8KB 文件头会很重；
/// 用 mtime 做失效判断，文件没变就直接复用。
pub static HEAD_META_CACHE: Mutex<Option<HashMap<String, (i64, HeadMeta)>>> = Mutex::new(None);


/// 头部元信息的**磁盘**缓存：`<data_root>/head-cache.json`。
///
/// 为什么要有：内存缓存只在进程内有效，每次启动都要重读 479 个会话文件的头部
/// （实测 632ms，直接算进首屏等待）。落盘后第二次启动几乎瞬时。
/// 结构：path → {mtime, cwd, title}
type HeadDiskCache = HashMap<String, HeadDiskEntry>;

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct HeadDiskEntry {
    mtime: i64,
    cwd: Option<String>,
    title: Option<String>,
}

static HEAD_DISK_CACHE: OnceLock<Mutex<Option<HeadDiskCache>>> = OnceLock::new();


fn head_cache_path() -> PathBuf {
    crate::paths::data_root().join("head-cache.json")
}

fn head_disk_load() -> HeadDiskCache {
    let p = head_cache_path();
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn head_disk_save(c: &HeadDiskCache) {
    let p = head_cache_path();
    if let Ok(s) = serde_json::to_string(c) {
        let _ = std::fs::write(p, s);
    }
}


/// 带缓存地取会话头部元信息。
pub fn session_head_meta_cached(path: &Path) -> HeadMeta {
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let key = path.to_string_lossy().to_string();

    // 1) 内存缓存
    if let Ok(mut guard) = HEAD_META_CACHE.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some((mt, meta)) = map.get(&key) {
            if *mt == mtime {
                return meta.clone();
            }
        }
    }

    // 2) 磁盘缓存（跨进程有效 —— 每次启动省下几百毫秒）
    if let Some(meta) = head_disk_get(&key, mtime) {
        if let Ok(mut guard) = HEAD_META_CACHE.lock() {
            let map = guard.get_or_insert_with(HashMap::new);
            map.insert(key.clone(), (mtime, meta.clone()));
        }
        return meta;
    }

    // 3) 重算
    let meta = session_head_meta(path);
    if let Ok(mut guard) = HEAD_META_CACHE.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(key.clone(), (mtime, meta.clone()));
    }
    head_disk_put(&key, mtime, &meta);
    meta
}


fn head_disk_get(key: &str, mtime: i64) -> Option<HeadMeta> {
    let cache = HEAD_DISK_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().ok()?;
    let map = guard.get_or_insert_with(head_disk_load);
    let e = map.get(key)?;
    if e.mtime != mtime {
        return None;
    }
    Some(HeadMeta {
        cwd: e.cwd.clone(),
        title: e.title.clone(),
    })
}

fn head_disk_put(key: &str, mtime: i64, meta: &HeadMeta) {
    let cache = HEAD_DISK_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let map = guard.get_or_insert_with(head_disk_load);
    map.insert(
        key.to_string(),
        HeadDiskEntry {
            mtime,
            cwd: meta.cwd.clone(),
            title: meta.title.clone(),
        },
    );
    // 落盘要**节流**：这个函数会被逐条调用（列表里上千条会话），
    // 每次都写一遍整个文件会把启动拖慢。距上次保存不足 500ms 就跳过 ——
    // 丢掉的最后几条下次启动重算即可，无碍。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    static LAST_SAVE: OnceLock<Mutex<u64>> = OnceLock::new();
    let last = LAST_SAVE.get_or_init(|| Mutex::new(0));
    {
        let mut l = match last.lock() {
            Ok(l) => l,
            Err(_) => return,
        };
        if now.saturating_sub(*l) < 500 {
            return;
        }
        *l = now;
    }
    let snapshot = map.clone();
    drop(guard);
    head_disk_save(&snapshot);
}


/// 一次读会话文件的头部若干行，取两样东西：
///   - cwd：左栏「任务」维度当项目名用（会话文件所在的时间戳目录只是壳）
///   - ai-title：工具生成的短标题（如「将 codex harness 做成桌面版 AI 工具」），
///     比首条用户消息更适合当列表标题
///
/// 注意：不能「只读前 8KB」—— WorkBuddy 会话的第一条 user 记录就可能长达 1 万多字符
/// （system-reminder + user_query 都塞在一条里），ai-title 往往落在第 5 行，
/// 8KB 窗口根本够不着，实测覆盖率只有 12%。所以这里按行渐进扫描，够到就停。
/// 取不到就返回 None，前端会各自退回（cwd → 按工具归组；标题 → 首条用户消息）。
pub fn session_head_meta(path: &Path) -> HeadMeta {
    use std::io::{BufRead, BufReader};
    let mut out = HeadMeta::default();
    let Ok(f) = std::fs::File::open(path) else {
        return out;
    };
    let mut reader = BufReader::new(f);
    let mut line = String::new();
    let mut scanned = 0usize;
    let max_bytes = 512 * 1024; // 兜底上限，别把大文件全读进来
    let mut lines = 0usize;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => scanned += n,
        }
        lines += 1;
        if scanned > max_bytes || lines > 2000 {
            break;
        }
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(t) {
            Ok(v) => v,
            Err(_) => continue, // 头部最后一行可能被截断
        };
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        // 标题：取最早的一条 ai-title（它概括整段会话；后面会随对话推进越改越窄）
        if out.title.is_none() {
            let t = match ty {
                "ai-title" => v.get("aiTitle").and_then(|x| x.as_str()),
                "session-meta" => ["title", "aiTitle", "summary"]
                    .iter()
                    .find_map(|k| v.get(*k).and_then(|x| x.as_str())),
                _ => None,
            };
            if let Some(t) = t {
                let t = t.trim();
                if !t.is_empty() {
                    out.title = Some(t.chars().take(48).collect::<String>());
                }
            }
        }
        if out.cwd.is_none() {
            for k in ["cwd", "workingDirectory", "working_dir"] {
                if let Some(c) = v.get(k).and_then(|x| x.as_str()) {
                    let c = c.trim();
                    if !c.is_empty() {
                        out.cwd = Some(c.to_string());
                        break;
                    }
                }
            }
        }
        if out.cwd.is_some() && out.title.is_some() {
            break; // 两样都拿到了，头部的后续记录不用再看
        }
    }
    out
}


/// 单个会话文件的扫描结果：这一轮是否还在进行、当前姿态、标题、工作目录。
#[derive(Clone, Default)]
pub struct SessionScan {
    pub busy: Option<bool>,
    pub act: String,
    pub title: String,
    pub cwd: String,
}


/// 会话尾部扫描的缓存：(mtime, 扫描结果)。
///
/// **为什么必须缓存**：scan_session 要读文件尾部 96KB 并逐行解析 JSON。
/// 本机有近 500 个会话文件（累计 1GB），全部扫一遍实测要 **29 秒**。
/// 而像素办公室每 5 秒就调一次 tool_activity —— 不缓存的话请求根本追不上，
/// 界面会卡死。
///
/// 缓存键用 mtime：文件没被写过 → 尾部内容没变 → 扫描结果必然相同。
/// 正在跑的会话 mtime 一直在变 → 每次都是新结果，不影响实时性。
pub static SCAN_CACHE: Mutex<Option<HashMap<String, (i64, SessionScan)>>> = Mutex::new(None);


/// 扫会话文件尾部（带 mtime 缓存）。
///
/// 公开入口都用这个；只有明确需要绕过缓存时才调 `scan_session_uncached`。
pub fn scan_session_cached(path: &Path) -> SessionScan {
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let key = path.to_string_lossy().to_string();

    if let Ok(mut guard) = SCAN_CACHE.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some((mt, scan)) = map.get(&key) {
            if *mt == mtime {
                return scan.clone();
            }
        }
        let scan = scan_session_uncached(path);
        map.insert(key, (mtime, scan.clone()));
        return scan;
    }
    scan_session_uncached(path)
}


/// 扫会话文件尾部，得到 (是否进行中, 当前姿态, 标题, 工作目录)。
/// 从尾部往前扫，第一条能定性的记录就返回 —— 比 mtime 窗口准得多：
/// 用户一拿到回答，最后一条通常是「已完成的 assistant 消息 / task_complete」，立刻落回空闲。
/// 姿态用于像素办公室给小人摆 pose：thinking（阅读）/ writing（书写）/ tooling（调工具）/ idle（闲坐）。
/// 三个忙碌姿态都是「会话尾部的即时状态」，能真实观测到 —— 详见下面 match 里的注释。
/// 标题与 cwd 各自工具的记录格式不同，能取到就用（`ai-title` / `session-meta`），取不到留空。
pub fn scan_session(path: &Path) -> SessionScan {
    scan_session_cached(path)
}


/// 实际的扫描逻辑（无缓存）。
pub fn scan_session_uncached(path: &Path) -> SessionScan {
    let mut out = SessionScan {
        busy: None,
        act: "idle".into(),
        title: String::new(),
        cwd: String::new(),
    };
    let tail = match read_tail(path, 96 * 1024) {
        Some(t) => t,
        None => return out,
    };

    // 第一遍（正序）：捞元信息。标题记录通常在会话开头附近，cwd 也可能只在早期记录里。
    for line in tail.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
            "ai-title" => {
                if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    if !t.trim().is_empty() {
                        out.title = t.trim().to_string();
                    }
                }
            }
            "session-meta" => {
                for k in ["title", "name", "aiTitle", "summary"] {
                    if let Some(t) = v.get(k).and_then(|x| x.as_str()) {
                        if !t.trim().is_empty() {
                            out.title = t.trim().to_string();
                            break;
                        }
                    }
                }
            }
            _ => {}
        }
        for k in ["cwd", "workingDirectory", "working_dir"] {
            if let Some(c) = v.get(k).and_then(|x| x.as_str()) {
                if !c.trim().is_empty() {
                    out.cwd = c.trim().to_string();
                }
            }
        }
    }
    if out.title.chars().count() > 40 {
        out.title = out.title.chars().take(40).collect::<String>();
    }

    // 第二遍（倒序）：定性当前这一轮。
    for line in tail.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // 尾部第一行可能被截断，跳过即可
        };
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match ty {
            // WorkBuddy / CodeBuddy（Claude Code 派生）会话格式
            // 最后一条就是一次工具调用：已经派出去、结果还没落盘 —— 工具正在跑。
            "function_call" => return SessionScan { busy: Some(true), act: "tooling".into(), ..out },
            // 工具结果已经回来、但后面还没写别的记录：这一小段只可能在「组织下一步输出」，
            // 所以算书写 —— 这是三个姿态里唯一能量到的 writing 时机。
            //
            // 为什么不能靠 assistant message 的 status 判 writing：
            // WorkBuddy 是整段回答写完才落盘（status 只有 completed / incomplete，
            // 实测 485 个会话文件里 in_progress / streaming 出现 0 次），
            // 「正在打字」这个中间态在磁盘上根本不存在 —— 照 status 判，书写永远是 0。
            "function_call_result" => return SessionScan { busy: Some(true), act: "writing".into(), ..out },
            // 尾部是思考块：模型正在读上下文 / 盘算下一步。
            "reasoning" => return SessionScan { busy: Some(true), act: "thinking".into(), ..out },
            "message" => {
                let role = v.get("role").and_then(|x| x.as_str()).unwrap_or("");
                let status = v.get("status").and_then(|x| x.as_str()).unwrap_or("");
                if role == "assistant" {
                    // 只有「明确还在进行中」才算忙。
                    // status 缺失、或为 "incomplete"（会话被切换/中断导致的截断）都说明这一轮
                    // 早就结束了 —— 实测有 28 个几十天前的老会话因此被永久判成 busy，
                    // 办公室里塞满幽灵小人，忙闲信号完全失真。
                    let busy = matches!(status, "in_progress" | "streaming" | "pending" | "running");
                    return SessionScan {
                        busy: Some(busy),
                        act: if busy { "writing" } else { "idle" }.into(),
                        ..out
                    };
                }
                if role == "user" {
                    // 末尾是用户消息：助手还没回复，算「这一轮进行中」，但姿态是等待
                    return SessionScan { busy: Some(true), act: "waiting".into(), ..out };
                }
            }
            "result" => return SessionScan { busy: Some(false), act: "idle".into(), ..out },
            // Claude Code 原生格式：assistant 带了 stop_reason 才算这一轮结束
            "assistant" => {
                let done = v
                    .get("message")
                    .and_then(|m| m.get("stop_reason"))
                    .map(|s| !s.is_null())
                    .unwrap_or(false);
                return SessionScan {
                    busy: Some(!done),
                    act: if done { "idle" } else { "writing" }.into(),
                    ..out
                };
            }
            "user" => return SessionScan { busy: Some(true), act: "waiting".into(), ..out },
            "system" | "session-meta" | "turn_context" | "ai-title" | "file-history-snapshot" => {}
            // 等权限：不同工具的记录名不一样，这里统一认审批 / 权限请求
            "approval_request" | "exec_approval_request" | "permission_request"
            | "elicitation_request" | "tool_permission_request" => {
                return SessionScan { busy: Some(true), act: "waiting".into(), ..out }
            }
            // Codex rollout：事件流里以 task_started / task_complete 标记一轮
            "event_msg" => {
                let p = v.get("payload");
                let pt = p
                    .and_then(|p| p.get("type"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                match pt {
                    "task_complete" | "turn_aborted" => {
                        return SessionScan { busy: Some(false), act: "idle".into(), ..out }
                    }
                    "exec_approval_request" | "apply_patch_approval_request" => {
                        return SessionScan { busy: Some(true), act: "waiting".into(), ..out }
                    }
                    "task_started" | "user_message" | "agent_message" | "agent_reasoning" => {
                        return SessionScan { busy: Some(true), act: "thinking".into(), ..out }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}


/// 从会话文件路径推断「项目目录名」：跳过 sessions/session/chat 这类中间目录，取最近的真实项目名。
///
/// 注意 Codex 的会话目录是 `~/.codex/sessions/2026/10/18/rollout-xxx.jsonl` —— 逐级上跳会
/// 落到「18」这种纯日期段，当房间名毫无意义。所以这里要跳过纯数字 / 纯日期的目录名，
/// 一路往上找到第一个像项目名的目录。
pub fn session_workspace(f: &Path) -> String {
    let skip = ["sessions", "session", "chat", "jsonl", "logs", "log", "history"];
    let home = std::env::var("HOME").unwrap_or_default();
    let mut cur = f.parent();
    while let Some(d) = cur {
        let name = d.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let low = name.to_lowercase();
        // 纯数字或纯日期段（18 / 2026 / 10-18）不是项目名，继续往上
        let is_date_like = !name.is_empty()
            && name.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '_')
            && name.chars().any(|c| c.is_ascii_digit());
        // 隐藏目录（.codex / .claude / .workbuddy）和用户主目录也不是项目名
        let is_hidden = name.starts_with('.');
        let is_home = !home.is_empty() && d == Path::new(&home);
        if !name.is_empty()
            && !skip.contains(&low.as_str())
            && !is_date_like
            && !is_hidden
            && !is_home
        {
            return name.to_string();
        }
        cur = d.parent();
    }
    String::new()
}


/// 会话的真实项目名（办公室的房间名）：
///   1. 工作区的用户自定义显示名（如「定时任务-每日 AI 新闻推送」）
///   2. 工作区根下的项目目录名（如 agentry / ai-native-sdlc-zsxq）
///   3. 都没有 → 空字符串，前端回退到工作区目录名
pub fn session_project_name(cwd: &str, ws_names: &HashMap<String, String>) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    if let Some(n) = ws_names.get(cwd) {
        return n.clone();
    }
    workspace_project_dir(cwd).unwrap_or_default()
}


/// 没有 ai-title / session-meta 时，用首条用户消息作为会话标题兜底，
/// 这样办公室浮框始终能看到「在处理什么」，而不是一片「无标题会话」。
///
/// 注意必须先 tidy_text：WorkBuddy 会话的第一条 user 记录里塞满了
/// <system-reminder>（OS 版本、SOUL.md、连接器状态…）动辄上万字符，
/// 直接取会得到一堆机器噪声，用户根本看不出在处理什么。
/// tidy_text 会剥掉噪声块、并把 <user_query> 外壳解开，只留真实请求正文。
pub fn first_user_message(path: &Path) -> String {
    use std::io::{BufRead, BufReader};
    let Ok(f) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut reader = BufReader::new(f);
    let mut line = String::new();
    let mut scanned = 0usize;
    let max_bytes = 512 * 1024;
    let mut lines = 0usize;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => scanned += n,
        }
        lines += 1;
        if scanned > max_bytes || lines > 2000 {
            break;
        }
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(t) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let is_user = match ty {
            "message" => v.get("role").and_then(|x| x.as_str()) == Some("user"),
            "user" => true,
            _ => false,
        };
        if !is_user {
            continue;
        }
        if let Some(raw) = extract_user_text(&v) {
            let t = tidy_text(&raw);
            let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
            if t.chars().count() >= 2 {
                return t.chars().take(40).collect::<String>();
            }
        }
    }
    String::new()
}
