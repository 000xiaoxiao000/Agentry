use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// cwd → 项目名 的进程内缓存。
///
/// 为什么需要：`workspace_project_dir` 在 cwd 末段是时间戳时会 `read_dir` 遍历目录。
/// 会话列表有近 500 条，很多 cwd 都是时间戳目录 → 一次列表刷新几百次目录遍历
/// （实测 315ms，占首屏等待的大头）。而同一个 cwd 每次刷新都会问一遍同样的问题。
///
/// 用 TTL 而不是 mtime 失效：目录内容变了不急着更新项目名（几分钟后自然刷新），
/// 但要防止「项目刚建好时列表里看不到名字」—— 所以 TTL 取得很短（30 秒）。
static PROJECT_DIR_CACHE: OnceLock<Mutex<Option<(u64, HashMap<String, Option<String>>)>>> =
    OnceLock::new();

const PROJECT_DIR_TTL_MS: u64 = 30_000;

/// 工作区的用户自定义显示名表（~/.workbuddy/workspace-display-names.json）。
/// 例：/Users/xiaoxiao/WorkBuddy/automation-2026-08-13-22-27-30
///→ 「定时任务-每日 AI 新闻推送」。
/// 这是唯一能把「时间戳目录」还原成「项目真名」的地方，没有它左栏就只剩日期。
/// 整个表很小，一次性读入内存供批量查表（别每个会话都去读一次文件）。
pub fn workspace_display_names() -> HashMap<String, String> {
    let Some(home) = std::env::var("HOME").ok() else {
        return HashMap::new();
    };
    let path = Path::new(&home)
        .join(".workbuddy")
        .join("workspace-display-names.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return HashMap::new();
    };
    let Some(ws) = v.get("workspaces").and_then(|w| w.as_object()) else {
        return HashMap::new();
    };
    ws.iter()
        .filter_map(|(k, e)| {
            let n = e.get("displayName")?.as_str()?.trim();
            if n.is_empty() {
                None
            } else {
                Some((k.clone(), n.to_string()))
            }
        })
        .collect()
}


/// 去掉目录名末尾的时间戳：`automation-2026-08-13-22-27-30` → `automation`，
/// `2026-10-16-14-06-45` → ``（整段就是时间戳）。
/// 纯手写，不引 regex 依赖（str::replace 是字面替换，不是正则）。
pub fn strip_ts_suffix(name: &str) -> String {
    let b = name.as_bytes();
    // 从右往左找 '-YYYY-MM-DD'（可能再跟 -HH[-MM[-SS]]）
    for date_start in (0..b.len()).rev() {
        if b[date_start] != b'-' {
            continue;
        }
        let rest = &name[date_start + 1..];
        let parts: Vec<&str> = rest.split('-').collect();
        // YYYY-MM-DD 至少 3 段
        if parts.len() < 3 {
            continue;
        }
        let ok_date = parts[0].len() == 4
            && parts[0].chars().all(|c| c.is_ascii_digit())
            && parts[1].len() == 2
            && parts[1].chars().all(|c| c.is_ascii_digit())
            && parts[2].len() == 2
            && parts[2].chars().all(|c| c.is_ascii_digit());
        if !ok_date {
            continue;
        }
        // 可选的时分秒段，每段 2 位数字
        let mut valid = true;
        for p in &parts[3..] {
            if p.len() != 2 || !p.chars().all(|c| c.is_ascii_digit()) {
                valid = false;
                break;
            }
        }
        if !valid {
            continue;
        }
        // 往前再吃一个时间戳段（连续两个日期时只剥最后一个）
        return name[..date_start].trim().to_string();
    }
    name.trim().to_string()
}


/// 目录名整体是不是一个纯时间戳（`2026-10-16-14-06-45` / `2026-08-13`）。
pub fn is_pure_timestamp(name: &str) -> bool {
    let digits = name.chars().filter(|c| c.is_ascii_digit()).count();
    name.len() >= 8 && digits >= 8 && name.chars().all(|c| c.is_ascii_digit() || c == '-')
}


/// 从工作区根目录推断「项目名」。
///
/// WorkBuddy 的会话 cwd 指向工作区根（如 /Users/xiaoxiao/WorkBuddy/2026-10-16-14-06-45），
/// 真正的项目往往是它下面的一个子目录（agentry / ai-native-sdlc-zsxq …）。
/// 规则：
///   - cwd 末段是真实名字（不是纯时间戳）→ 直接用它
///     （claude / cursor 的 cwd 就是项目目录；automation-xxx-时间戳 则剥掉时间戳）
///   - cwd 末段是纯时间戳 → 列出它的一级子目录，剔除通用名
///     （outputs/output/delivery/.workbuddy…）；剩一个就用它；多个则取最近修改过的那个
pub fn workspace_project_dir(cwd: &str) -> Option<String> {
    // 缓存命中就直接返回（TTL 内）
    if let Some(hit) = project_dir_cache_get(cwd) {
        return hit;
    }
    let v = workspace_project_dir_uncached(cwd);
    project_dir_cache_put(cwd, v.clone());
    v
}


fn project_dir_cache_get(cwd: &str) -> Option<Option<String>> {
    let cache = PROJECT_DIR_CACHE.get_or_init(|| Mutex::new(None));
    let guard = cache.lock().ok()?;
    let (saved_at, map) = guard.as_ref()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if now.saturating_sub(*saved_at) > PROJECT_DIR_TTL_MS {
        return None; // 过期了 → 重算
    }
    map.get(cwd).cloned()
}


fn project_dir_cache_put(cwd: &str, v: Option<String>) {
    let cache = PROJECT_DIR_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let map = guard.get_or_insert_with(|| (now, HashMap::new()));
    map.0 = now;
    map.1.insert(cwd.to_string(), v);
}


fn workspace_project_dir_uncached(cwd: &str) -> Option<String> {
    const GENERIC: &[&str] = &[
        "outputs", "output", "delivery", "deliverables", "artifacts", "dist", "build", "target",
        "node_modules", "tmp", "temp", "logs", "log", "cache", "docs", "doc", "assets", "public",
        "src", "lib", "bin", "test", "tests", "resources", "scripts", "tools", "config",
        "__pycache__", "boot-inf", "imgs", "images", "img", "media",
    ];
    let dir = Path::new(cwd);
    if !dir.is_dir() {
        return None;
    }
    // cwd 末段不是时间戳 → 它自己就是项目名
    let last = dir.file_name()?.to_str()?;
    if !is_pure_timestamp(last) {
        let stripped = strip_ts_suffix(last);
        if !stripped.is_empty() && !GENERIC.contains(&stripped.to_lowercase().as_str()) {
            return Some(stripped);
        }
        return None;
    }

    // 末段是纯时间戳 → 看它下面的一级子目录，真正的项目多半在里面
    let mut cands: Vec<(std::time::SystemTime, String)> = Vec::new();
    for e in std::fs::read_dir(dir).ok().into_iter().flatten() {
        let e = match e {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = match e.file_name().to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let low = name.to_lowercase();
        if GENERIC.contains(&low.as_str()) {
            continue;
        }
        // 图片/资源目录（fde_imgs、xxx-images、foo_imgs…）不是项目名
        if low.ends_with("_imgs")
            || low.ends_with("-imgs")
            || low.ends_with("_images")
            || low.ends_with("-images")
            || low.ends_with("_img")
        {
            continue;
        }
        // 名字里内嵌时间戳（workbuddy-launch-2026-08-01）也剥掉
        let clean = strip_ts_suffix(&name);
        if clean.is_empty() {
            continue;
        }
        let mt = e
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        cands.push((mt, clean));
    }
    cands.sort_by(|a, b| b.0.cmp(&a.0));
    cands.into_iter().next().map(|(_, n)| n)
}
