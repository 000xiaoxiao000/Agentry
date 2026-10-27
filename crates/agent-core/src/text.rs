use std::collections::HashMap;
use std::time::UNIX_EPOCH;

use crate::model::Artifact;
use std::path::{Path, PathBuf};

// FNV-1a 64 位哈希，用于把文件路径映射成稳定短 id。
pub fn hash_str(s: &str) -> String {
    let mut h: u64 = 1469598103934665603; // FNV-1a offset basis
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{:016x}", h)
}


// 按字节上限截断字符串，但保证落在字符边界（避免中文等多字节字符被切半导致 panic）。
pub fn truncate_utf8(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    // 找到不超过 max_bytes 的最近字符边界
    let mut boundary = max_bytes;
    while boundary > 0 && !s.is_char_boundary(boundary) {
        boundary -= 1;
    }
    s[..boundary].to_string()
}


// ---------- 可读性：剥掉工具注入的系统块 / 过滤内部临时文件 ----------
// 这些块（system-reminder / 项目上下文 / 记忆 / 连接器状态…）是给模型看的，
// 不该出现在对话视图里，更不该被当成会话标题。
pub const NOISE_BLOCK_TAGS: &[&str] = &[
    // Claude / Codex / WorkBuddy 常见的系统注入块
    "system-reminder",
    "system_reminder",
    "user-memory",
    "user_memory",
    "memory",
    "user_info",
    "user-context",
    "user_context",
    "identity_context",
    "product_identity",
    "project_context",
    "connector-status",
    "connector_status",
    "additional-data",
    "additional-data",
    "additional_metadata",
    "craft_mode",
    "wecom_wedrive_references",
    "mcp_server_list",
    "available_skills",
    "available_tools",
    "tool_list",
    "tool_result",
    "tool_results",
    "environment_context",
    "environment",
    "filesystem",
    "workspace",
    "workspace_roots",
    "system_context",
    "session_context",
    "hook_context",
    "project_instructions",
    "user_instructions",
    "developer",
];


pub fn strip_noise_blocks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let mut best: Option<(usize, &str)> = None;
        for tag in NOISE_BLOCK_TAGS {
            let open = format!("<{tag}");
            if let Some(i) = rest.find(&open) {
                if best.map(|(b, _)| i < b).unwrap_or(true) {
                    best = Some((i, tag));
                }
            }
        }
        match best {
            None => {
                out.push_str(rest);
                break;
            }
            Some((i, tag)) => {
                out.push_str(&rest[..i]);
                let after = &rest[i..];
                let close = format!("</{tag}>");
                if let Some(j) = after.find(&close) {
                    rest = &after[j + close.len()..];
                } else if let Some(gt) = after.find('>') {
                    rest = &after[gt + 1..];
                } else {
                    break;
                }
            }
        }
    }
    out
}


// 残留的孤立 XML 标签行（`<user_info>` / `</filesystem>`）与元数据行。
// 正常对话里不会出现，出现了就是系统注入块没被整块剥掉的残渣。
pub fn is_noise_line(l: &str) -> bool {
    let t = l.trim();
    if t.is_empty() {
        return true;
    }
    // 纯符号分隔线
    if t.chars().all(|c| "-=*_#>`~|".contains(c)) {
        return true;
    }
    // 单个 XML 标签（开/闭/自闭合）
    if t.starts_with('<') && t.ends_with('>') && !t.contains(" <") {
        let inner = &t[1..t.len() - 1];
        let name = inner.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/' || c == '>').next().unwrap_or("");
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
            return true;
        }
    }
    // 系统块里常见的「字段: 值」行
    let meta_prefixes = [
        "OS Version:", "OS:", "Shell:", "IDE Theme:", "Workspace Folder:", "Working Directory:",
        "Current Date:", "Timezone:", "Platform:", "CWD:", "User:", "Host:",
    ];
    if meta_prefixes.iter().any(|p| t.starts_with(p)) {
        return true;
    }
    // 上下文压缩时工具自动插入的摘要抬头（真正的用户请求在它后面，要保留）
    let low = t.to_lowercase();
    if low.starts_with("summary of the conversation so far")
        || low.starts_with("the conversation is between an ai agent")
        || low.starts_with("use this to get up to speed")
        || low.starts_with("some contents may be omitted")
        || low == "interrupted by user"
        || low == "<omitted />"
    {
        return true;
    }
    false
}


// 这些标签包的是「真实用户内容」（不是系统噪声）：去掉外壳、保留正文。
pub const UNWRAP_TAGS: &[&str] = &[
    "user_query",
    "user-query",
    "summary",
    "conversation_summary",
    "task",
    "prompt",
    "question",
];


// 删除 <tag ...> ... </tag> 的外壳但保留内部文本。
pub fn unwrap_tag(s: &str, tag: &str) -> String {
    let open_prefix = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let Some(i) = rest.find(&open_prefix) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..i]);
        let after = &rest[i..];
        let Some(gt) = after.find('>') else {
            break;
        };
        rest = &after[gt + 1..];
        if let Some(j) = rest.find(&close) {
            out.push_str(&rest[..j]);
            rest = &rest[j + close.len()..];
        }
    }
    out
}


pub fn unwrap_content_tags(s: &str) -> String {
    let mut out = s.to_string();
    for tag in UNWRAP_TAGS {
        if out.contains(&format!("<{tag}")) {
            out = unwrap_tag(&out, tag);
        }
    }
    out
}


// 对话正文清理：去系统块、去空行、去纯符号行 / 孤立标签行，保留正文。
pub fn tidy_text(s: &str) -> String {
    let cleaned = unwrap_content_tags(&strip_noise_blocks(s));
    let mut lines: Vec<String> = Vec::new();
    for raw in cleaned.lines() {
        let l = raw.trim();
        if is_noise_line(l) {
            continue;
        }
        lines.push(l.to_string());
    }
    lines.join("\n")
}


// 工具内部临时文件（如 chatcmpl-tool-xxx-render.txt、tool-results/）不是用户要的产物。
pub fn is_noise_file(rel: &str, abs: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    let path = abs.to_lowercase();
    name.starts_with("chatcmpl-")
        || name.starts_with("toolu_")
        || name.ends_with(".tmp")
        || name.ends_with(".lock")
        || name.ends_with("-render.txt")
        || name == ".ds_store"
        || name == "_run.jsonl"
        || path.contains("/tool-results/")
        || path.contains("/.cache/")
        || path.contains("/__pycache__/")
}


// 内容指纹（FNV-1a 64-bit，用于内容相同检测，无需引入外部哈希库）。
pub fn fnv1a_bytes(b: &[u8]) -> u64 {
    let mut h: u64 = 1469598103934665603;
    for &b in b {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h
}

pub fn content_fingerprint(text: &str) -> String {
    format!("{:016x}", fnv1a_bytes(text.trim().as_bytes()))
}


// 为一件产物计算内容指纹：对话/日志用内存内容；文件在 ≤200KB 且非二进制时读盘。
pub fn artifact_content_hash(a: &Artifact) -> Option<String> {
    if let Some(c) = &a.content {
        if !c.trim().is_empty() {
            return Some(content_fingerprint(c));
        }
    }
    if a.kind == "file" {
        if let Some(p) = &a.path {
            if let Ok(bytes) = std::fs::read(p) {
                if bytes.len() <= 200_000 && !bytes.contains(&0) {
                    return Some(content_fingerprint(&String::from_utf8_lossy(&bytes)));
                }
            }
        }
    }
    None
}


// 归一化产物名（取 basename、转小写、去掉前导的十六进制任务 id / 分隔符），用于按名聚合。
pub fn norm_name(name: &str) -> String {
    let n = Path::new(name)
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let n = n.to_lowercase();
    n.trim_start_matches(|c: char| c.is_ascii_hexdigit() || c == '-' || c == '_')
        .to_string()
}


// ---------- 产物收割（递归快照 + 会话解析）----------
pub fn ignored(name: &str) -> bool {
    matches!(
        name,
        // 构建产物与依赖
        ".DS_Store" | "node_modules" | ".git" | "target" | "dist" | "gen" | ".venv" | ".workbuddy" | ".tmp"
        // 本项目自身的运行时数据目录：远端代理的目录（~/.agentry-proxy）
        | ".agentry-proxy" | ".agentry"
        // 产物索引本身（它是派生数据，不该再被当成产物收录一遍）
        | "artifacts.json" | "tasks.json"
    )
        // 运行时日志（点开头的隐藏日志文件，不是用户的产物）
        || name.starts_with(".")
        || name.ends_with(".sqlite")
        || name.ends_with(".sqlite-shm")
        || name.ends_with(".sqlite-wal")
}


// 路径展开：{task_dir} / ~/ / ~ 的相对化。
pub fn expand(s: &str, home: &str, task_dir: &Path) -> PathBuf {
    let r = if s == "{task_dir}" {
        task_dir.to_path_buf()
    } else if let Some(rest) = s.strip_prefix("~/") {
        PathBuf::from(home).join(rest)
    } else if s == "~" {
        PathBuf::from(home)
    } else {
        PathBuf::from(s)
    };
    if r.is_absolute() {
        r
    } else {
        task_dir.join(r)
    }
}


// 递归快照：rel -> (绝对路径, size+mtime)。since=Some(ns) 时只收 mtime>=ns 的文件。
pub fn snap_recursive_map(root: &Path, since: Option<u64>, map: &mut HashMap<String, (PathBuf, u64)>) {
    fn walk(
        root: &Path,
        since: Option<u64>,
        map: &mut HashMap<String, (PathBuf, u64)>,
        seen: &mut usize,
        depth: usize,
    ) {
        if depth > 14 || *seen > 8000 {
            return;
        }
        let rd = match std::fs::read_dir(root) {
            Ok(r) => r,
            Err(_) => return,
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if ignored(&name) {
                continue;
            }
            let p = e.path();
            let md = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.is_dir() {
                walk(&p, since, map, seen, depth + 1);
            } else if md.is_file() {
                if name.ends_with(".jsonl") {
                    continue; // 会话单独处理
                }
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|x| x.as_nanos() as u64)
                    .unwrap_or(0);
                if let Some(s) = since {
                    if mtime < s {
                        continue;
                    }
                }
                let rel = p
                    .strip_prefix(root)
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_else(|_| p.to_string_lossy().to_string());
                let key = md.len() + mtime;
                map.insert(rel, (p.clone(), key));
                *seen += 1;
            }
        }
    }
    let mut seen = 0usize;
    walk(root, since, map, &mut seen, 0);
}
