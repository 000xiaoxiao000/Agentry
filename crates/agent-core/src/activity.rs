use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::model::{Connector, LiveSession, LiveTool};
use crate::session::{collect_jsonl, first_user_message, scan_session, session_head_meta_cached, session_project_name, session_workspace};
use crate::tokens::session_tokens_cached_readonly;
use crate::paths::data_root;
use crate::store::load_connectors;
use crate::text::expand;
use crate::workspace::workspace_display_names;

// ---------- 工具函数 ----------
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 本地时区「今天零点」的 Unix 秒数。
///
/// 用途：调用方没给 today_start 时的兜底（见 tool_activity）。
///
/// 实现：问一次系统（`date +%s` 取当前时间，再用 `date` 的本地日期算零点）。
/// 不引入 chrono 之类的依赖 —— 整个 crate 只用 std，而 std 不暴露时区。
/// 一天只问一次（结果缓存在静态变量里），开销可忽略。
pub fn local_today_start() -> i64 {
    // 缓存「今天零点 + 当时是哪天」，跨过午夜时自动失效重算 ——
    // 代理可能连跑好几天，不能把零点永久冻住。
    static CACHE: OnceLock<Mutex<(String, i64)>> = OnceLock::new();
    let today = today_local_date();
    let cache = CACHE.get_or_init(|| Mutex::new((String::new(), 0)));
    if let Ok(mut guard) = cache.lock() {
        if guard.0 == today {
            return guard.1;
        }
        let start = compute_local_today_start(&today);
        *guard = (today, start);
        return start;
    }
    compute_local_today_start(&today)
}

/// 按本地日期算出当天零点的 Unix 秒数。
fn compute_local_today_start(today: &str) -> i64 {
    // macOS：`date -j -f "%Y-%m-%d" <今天> +%s`
    // Linux：`date -d "<今天> 00:00" +%s`
    let out = std::process::Command::new("date")
        .args(["-j", "-f", "%Y-%m-%d", today, "+%s"])
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            if let Ok(s) = String::from_utf8_lossy(&o.stdout).trim().parse::<i64>() {
                return s;
            }
        }
    }
    let out = std::process::Command::new("date")
        .args(["-d", &format!("{today} 00:00"), "+%s"])
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            if let Ok(s) = String::from_utf8_lossy(&o.stdout).trim().parse::<i64>() {
                return s;
            }
        }
    }
    // 兜底：UTC 零点（误差最多一个时区，对「今天写过」这个粗判定够用）
    now().div_euclid(86_400) * 86_400
}

/// 本地时区的今天日期（YYYY-MM-DD）。
fn today_local_date() -> String {
    std::process::Command::new("date")
        .arg("+%Y-%m-%d")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "1970-01-01".to_string())
}

// 文件真实修改时间（秒）。同步进来的历史产物应该按「它原本是什么时候的」排序，
// 而不是全部堆在「刚刚同步」这一刻。
pub fn mtime_secs(p: &Path) -> i64 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or_else(now)
}


pub fn short_id() -> String {
    crate::proto::short_id()
}


/// macOS 上正在运行的 GUI 应用名（lsappinfo 不需要辅助功能 / 自动化权限，也不会弹窗）
pub fn running_app_names() -> Option<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("lsappinfo")
            .arg("list")
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        let mut names = Vec::new();
        for line in s.lines() {
            // 形如：86) "WorkBuddy" ASN:0x0-0x53e53e:
            if !line.contains(" ASN:") {
                continue;
            }
            if let Some(a) = line.find('"') {
                if let Some(b) = line[a + 1..].find('"') {
                    names.push(line[a + 1..a + 1 + b].to_string());
                }
            }
        }
        Some(names)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}


/// 从连接器推断它对应的 App 名：优先取 .app 路径里的名字，否则按 id/name/command 关键词兜底。
pub fn connector_app_name(c: &Connector) -> Option<String> {
    if let Some(cmd) = &c.command {
        if let Some(idx) = cmd.find(".app/") {
            let prefix = &cmd[..idx];
            if let Some(slash) = prefix.rfind('/') {
                return Some(prefix[slash + 1..].to_string());
            }
        }
    }
    let hay = format!(
        "{} {} {}",
        c.id,
        c.name,
        c.command.clone().unwrap_or_default()
    )
    .to_lowercase();
    for (k, v) in [
        ("workbuddy", "WorkBuddy"),
        ("codebuddy", "WorkBuddy"),
        ("cursor", "Cursor"),
        ("claude", "Claude"),
        ("codex", "Codex"),
    ] {
        if hay.contains(k) {
            return Some(v.to_string());
        }
    }
    None
}


pub fn tool_activity(today_start: Option<i64>, active_window: Option<i64>) -> Vec<LiveTool> {
    // 「今天」的起点。调用方没给（远端代理走的是 tool_activity(None, None)）时，
    // 用**本地今天零点**兜底 —— 绝不能留 0：留 0 会让「今天写过」的判定恒为真，
    // 于是每个历史会话都要做昂贵的尾部扫描（见下方 might_be_recent）。
    let today_start = match today_start {
        Some(t) if t > 0 => t,
        _ => local_today_start(),
    };
    // 活跃窗口只用来「限定候选文件」：真正是否在跑由尾部记录决定，所以窗口可以适当放宽，
    // 避免长工具调用（几分钟不写盘）期间状态闪回空闲。
    let win = active_window.unwrap_or(300).clamp(30, 3600);
    let cutoff = now() - win;
    // 「还在忙」的时效窗口：比 cutoff 宽松（cutoff 是 5 分钟级，太紧会让长工具调用闪回空闲），
    // 但必须有上限 —— 否则几十天前写完、结尾没写 status 的老会话会永远显示成「正在工作」。
    let busy_cut = now() - 1800;
    let home = std::env::var("HOME").unwrap_or_default();
    let running_apps = running_app_names();
    // 工作区显示名表一次读入，供所有会话查表（办公室的房间名用真实项目名）
    let ws_names = workspace_display_names();
    let mut out = Vec::new();
    for c in load_connectors() {
        let task_dir = data_root().join("tasks").join(&c.id);
        let mut files: Vec<PathBuf> = Vec::new();
        if let Some(roots) = &c.session_roots {
            for d in roots {
                collect_jsonl(&expand(d, &home, &task_dir), &mut files, 0);
            }
        }
        let (mut sessions, mut running, mut today, mut last) = (0u32, 0u32, 0u32, 0i64);
        let mut recent: Vec<LiveSession> = Vec::new();
        let recent_cut = now() - 24 * 3600; // 近 24h 内的会话也纳入办公室「近期」明细
        for f in &files {
            let m = mtime_secs(f);
            sessions += 1;
            if m > last {
                last = m;
            }
            if m >= today_start {
                today += 1;
            }

            // **只对「可能进近期明细」的会话做尾部扫描** —— 这是卡顿的主因。
            //
            // 尾部扫描要读 96KB 并逐行解析 JSON；本机近 500 个会话文件全扫一遍
            // 实测要 29 秒，而办公室每 5 秒调一次 → 请求堆积、界面卡死。
            //
            // 而 sessions / today / last 三个计数**只需 mtime**，不需要扫尾部。
            // running 计数也只关心「最近写过」的文件（m >= cutoff）。
            // 其余纯历史会话（几百个）完全不用碰文件内容。
            //
            // 判定条件与下面的 recent 纳入条件保持一致：正在跑 / 今天写过 / 近 24h 写过。
            let might_be_recent = m >= today_start || m >= recent_cut || m >= cutoff;
            if !might_be_recent {
                continue;
            }

            let scan = scan_session(f);
            let busy_opt = scan.busy;
            // 只有「最近写过」的会话才值得读尾部；且尾部明确未结束才算进行中
            if m >= cutoff && busy_opt == Some(true) {
                running += 1;
            }
            // 纳入「近期明细」：正在跑、或今天写过、或近 24h 写过 —— 办公室里每个小人对应一条。
            //
            // 关键：busy 必须同时满足「尾部说还没结束」**和**「最近确实动过」。
            // 只看尾部的话，一批早就写完但结尾没写 status 的老会话会永远被判成 busy，
            // 办公室里就塞满幽灵小人（实测 33 个「正在工作」里 28 个 30 天没动过），
            // 忙闲信号直接失去意义。
            // 窗口取 30 分钟：既能挡住陈年幽灵，又容得下一次几分钟不写盘的长工具调用。
            let busy = busy_opt == Some(true) && m >= busy_cut;
            if busy || m >= today_start || m >= recent_cut {
                // 尾部扫描未必拿到 ai-title（它常写在会话开头，正文长时 96KB 尾部够不着），
                // 这里补一次头部扫描；只对会进入办公室的近期会话做，且有 mtime 缓存兜底。
                let head = session_head_meta_cached(f);
                let cwd = if scan.cwd.is_empty() {
                    head.cwd.clone().unwrap_or_default()
                } else {
                    scan.cwd.clone()
                };
                let workspace = if cwd.is_empty() {
                    session_workspace(f)
                } else {
                    Path::new(&cwd)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string()
                };
                // 没有显式标题时，用首条真实用户消息兜底（剥掉系统噪声块）
                let title = if !scan.title.trim().is_empty() {
                    scan.title.clone()
                } else if let Some(t) = head.title {
                    t
                } else {
                    first_user_message(f)
                };
                // token 用量：**只从缓存读**。办公室要的是「已经算过的会话」的用量，
                // 不该为了显示一行数字去重读上百 MB 的会话文件（那会拖慢每次刷新）。
                // 后台 token_stats 会把结果算好写进缓存，这里只是顺带显示。
                let tokens = session_tokens_cached_readonly(f);
                recent.push(LiveSession {
                    id: f
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string(),
                    workspace,
                    busy,
                    act: if busy { scan.act } else { "idle".to_string() },
                    last: m,
                    title,
                    project: session_project_name(&cwd, &ws_names),
                    cwd,
                    tokens,
                });
            }
        }
        // 按最近活动排序，最多保留 40 条（办公室只展示活跃 / 近期的小人，避免几百条历史挤爆）
        recent.sort_by(|a, b| b.last.cmp(&a.last));
        recent.truncate(40);
        // 拿不到运行中 App 清单时保持 null（未知），别误报成「未开启」
        let open = match (connector_app_name(&c), &running_apps) {
            (Some(app), Some(list)) => {
                Some(list.iter().any(|n| n.eq_ignore_ascii_case(&app)))
            }
            _ => None,
        };
        out.push(LiveTool {
            connector: c.id,
            name: c.name,
            sessions,
            running,
            today,
            last,
            open,
            recent,
        });
    }
    out
}
