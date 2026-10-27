// Token 用量统计：从会话文件（*.jsonl）里解析各 AI 工具的 token 消耗与缓存节省。
//
// ---------- 累加口径（实测得出，别想当然）----------
//
// 会话文件里的 `usage` 出现在两种记录上：
//   - `message` / assistant：usage 挂在 message.usage
//   - `function_call`：message 里只有 usage 一个字段
//
// **每条 usage 记录 = 一次 API 调用的用量**，所以所有字段都该**求和**。
// 这里曾踩过一个很深的坑：最初以为 input_tokens 是「至今累计」，于是取最大值 ——
// 结果把总量低估了 **34 倍**（3852 万 vs 正确值 13.25 亿）。三个决定性证据：
//
//   1. **全新会话的第一条 usage 就是 30241**（system prompt + 工具定义 + 首条消息）。
//      若它是「至今累计」，刚开张的会话应该接近 0。
//   2. **105 个会话的 input 序列会回退** —— 例：in 94046 → 33017。
//      那是 compaction（上下文压缩）后上下文变小；「至今累计」不可能变小。
//      77 个会话的 max > last，正好证明「取最大值 / 取最后一条」都不对。
//   3. **不存在重复记账**：相邻 usage 记录 input 完全相同的只有 2 对（0.02%），
//      message.id 相邻重复 0 次 —— 说明一次 API 调用没有被拆成两条各带 usage 的记录。
//
// 自洽性检查：求和后 `sum(cache_read) <= sum(input)` 在全部 432 个会话上都成立（0 例外）。
//
// 「节省」的口径：缓存命中的输入按约 1/10 计价（Claude Sonnet：缓存读 $0.30/MTok
// vs 普通输入 $3/MTok），所以 cache_read 那部分相当于省下 90% 的输入成本。
// 同时也给出原始的缓存命中 token 数与命中率 —— 两个口径都摆出来，让用户自己判断。
//
// 注意：并非所有工具都记录 usage（实测 Codex / Claude Code 的会话文件里没有），
// 没有就返回空 —— 不猜、不编。
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 单个会话（或单个工具）的 token 用量。
#[derive(Clone, Default, Serialize, Deserialize, Debug)]
pub struct TokenUsage {
    /// 输入 token（各次 API 调用求和）。
    #[serde(default)]
    pub input: u64,
    /// 输出 token（各次 API 调用求和）。
    #[serde(default)]
    pub output: u64,
    /// 命中缓存的输入 token（各次 API 调用求和）。
    #[serde(default)]
    pub cache_read: u64,
    /// 写入缓存的输入 token（各次 API 调用求和）。
    #[serde(default)]
    pub cache_creation: u64,
    /// 参与统计的会话数。
    #[serde(default)]
    pub sessions: u64,
}

impl TokenUsage {
    /// 缓存命中率（0..=1）。没有输入时返回 0。
    pub fn cache_hit_rate(&self) -> f64 {
        if self.input == 0 {
            return 0.0;
        }
        (self.cache_read as f64 / self.input as f64).min(1.0)
    }

    /// 未命中缓存、需要按原价计费的输入 token。
    pub fn uncached_input(&self) -> u64 {
        self.input.saturating_sub(self.cache_read)
    }

    /// 缓存命中省下的 token 等价量（按缓存读价 ≈ 输入价 1/10 折算）。
    ///
    /// 例：命中 10 万 → 相当于省下 9 万个 token 的输入成本。
    pub fn saved_equivalent(&self) -> u64 {
        // 缓存读取价约为普通输入价的 1/10 → 省下 90%
        (self.cache_read as f64 * 0.9).round() as u64
    }

    /// 总 token（输入 + 输出）。
    pub fn total(&self) -> u64 {
        self.input.saturating_add(self.output)
    }

    /// 合并另一个统计。
    pub fn merge(&mut self, o: &TokenUsage) {
        self.input = self.input.saturating_add(o.input);
        self.output = self.output.saturating_add(o.output);
        self.cache_read = self.cache_read.saturating_add(o.cache_read);
        self.cache_creation = self.cache_creation.saturating_add(o.cache_creation);
        self.sessions = self.sessions.saturating_add(o.sessions);
    }
}


/// 从会话文件里解析 token 用量。
///
/// **流式逐行读**，不把整个文件读进内存：
/// 本机最大的会话文件有 103MB，全部会话累计 1GB —— `read_to_string` 会让
/// 单次内存峰值冲到 100MB+，大文件多了容易 OOM。BufReader 逐行读的峰值只有一行。
///
/// 解析时**只对含 "usage" 的行做 JSON 解析**，其余行直接跳过 ——
/// 避免为无关行付出解析代价（一个 100MB 的文件里大部分行不含 usage）。
pub fn session_tokens(path: &Path) -> TokenUsage {
    use std::io::{BufRead, BufReader};

    let mut out = TokenUsage::default();
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return out,
    };
    let mut found = false;
    // 每条 usage = 一次 API 调用的用量 → 全部字段累加。
    // （曾误以为 input 是「至今累计」而取最大值，低估 34 倍 —— 见文件头注释的三个证据。）
    let mut in_sum: u64 = 0;
    let mut out_sum: u64 = 0;
    let mut cache_sum: u64 = 0;
    let mut cc_sum: u64 = 0;

    let mut reader = BufReader::with_capacity(256 * 1024, file);
    // 复用同一个 buffer 逐行读：避免每行都分配一个 String
    // （1GB 的会话文件，逐行分配会拖慢 30% 左右）。
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf) {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        // 用 str::contains（走 SIMD 优化）而不是手写字节搜索 ——
        // 实测手写 windows().any() 慢一倍（6.2s vs 2.9s）。
        // from_utf8 失败就跳过这行（非法 UTF-8 不可能是有意义�� JSON 记录）。
        match std::str::from_utf8(&buf) {
            Ok(s) if s.contains("usage") => {}
            _ => continue,
        }
        let v: serde_json::Value = match serde_json::from_slice(&buf) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let u = match pick_usage(&v) {
            Some(u) => u,
            None => continue,
        };
        found = true;
        let input = num(&u, "input_tokens").or_else(|| num(&u, "inputTokens")).unwrap_or(0);
        let output = num(&u, "output_tokens").or_else(|| num(&u, "outputTokens")).unwrap_or(0);
        let cache_read = num(&u, "cache_read_input_tokens")
            .or_else(|| num(&u, "cacheReadInputTokens"))
            .unwrap_or(0);
        let cache_creation = num(&u, "cache_creation_input_tokens")
            .or_else(|| num(&u, "cacheCreationInputTokens"))
            .unwrap_or(0);
        in_sum = in_sum.saturating_add(input);
        out_sum = out_sum.saturating_add(output);
        cache_sum = cache_sum.saturating_add(cache_read);
        cc_sum = cc_sum.saturating_add(cache_creation);
    }

    if !found {
        return out;
    }
    out.input = in_sum;
    out.output = out_sum;
    out.cache_read = cache_sum;
    out.cache_creation = cc_sum;
    out.sessions = 1;
    out
}


/// usage 可能挂在顶层，也可能挂在 message 里。
fn pick_usage(v: &serde_json::Value) -> Option<&serde_json::Value> {    if let Some(u) = v.get("usage") {
        if u.is_object() {
            return Some(u);
        }
    }
    if let Some(m) = v.get("message") {
        if let Some(u) = m.get("usage") {
            if u.is_object() {
                return Some(u);
            }
        }
    }
    None
}


fn num(u: &serde_json::Value, key: &str) -> Option<u64> {
    u.get(key).and_then(|x| x.as_u64())
}


/// 按连接器聚合的 token 统计。
#[derive(Clone, Default, Serialize, Deserialize, Debug)]
pub struct TokenStat {
    pub connector: String,
    pub name: String,
    #[serde(flatten)]
    pub usage: TokenUsage,
}


/// 单个会话文件的 token 用量（按会话文件）。
///
/// 三级缓存：
///   1. 内存缓存（同一次进程内，文件没变直接复用）
///   2. **磁盘缓存**（`<data_root>/token-cache.json`，按 path + mtime 失效）
///   3. 重新扫描文件
///
/// 为什么要有磁盘缓存：本机全部会话累计 **1GB**，最大的单文件 103MB。
/// 每次进程启动都重扫一遍要 2.4 秒 —— 首屏会被卡住（界面全程空白）。
/// 磁盘缓存让**第二次启动几乎瞬时**，只有真正改过的会话才重算。
///
/// 注意落盘是**批量**的：重算 479 个会话不能写 479 次文件。
/// 调��方在批量统计结束后调 `flush_token_cache()` 统一落盘。
pub fn session_tokens_cached(path: &Path) -> TokenUsage {
    match session_tokens_cached_readonly(path) {
        Some(u) => u,
        None => {
            let u = session_tokens(path);
            if u.sessions > 0 {
                mem_cache_put(path, &u);
            }
            u
        }
    }
}


/// **只读缓存**版本：缓存命中才返回，未命中返回 None（**不重算**）。
///
/// 启动路径用这个：会话列表要立刻返回，不能为了凑 token 去读 1GB。
/// 重算交给后台的 `token_stats` 命令去做（不阻塞首屏）。
pub fn session_tokens_cached_readonly(path: &Path) -> Option<TokenUsage> {
    let mtime = mtime_secs_of(path);
    let key = path.to_string_lossy().to_string();

    // 1) 内存缓存
    if let Some(u) = mem_cache_get(&key, mtime) {
        return Some(u);
    }
    // 2) 磁盘缓存
    let u = disk_cache_get(&key, mtime)?;
    mem_cache_put_raw(&key, mtime, &u);
    Some(u)
}


/// 把内存里新增的 token 结果落盘（批量统计结束后调一次）。
pub fn flush_token_cache() {
    let snapshot: DiskCache = {
        let mut guard = match DISK_CACHE.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let map = guard.get_or_insert_with(disk_cache_load);
        map.clone()
    };
    disk_cache_save(&snapshot);
}


/// 文件的修改时间（秒）；取不到时返回 0。
fn mtime_secs_of(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}


/// 磁盘缓存条目：path → {mtime, 用量}
#[derive(Serialize, Deserialize, Default, Clone)]
struct DiskCacheEntry {
    mtime: i64,
    #[serde(flatten)]
    usage: TokenUsage,
}

type DiskCache = HashMap<String, DiskCacheEntry>;


/// 磁盘缓存的进程内副本（避免每次都读文件）。
static DISK_CACHE: Mutex<Option<DiskCache>> = Mutex::new(None);
/// 进程内内存缓存：path → (mtime, 用量)
static MEM_CACHE: Mutex<Option<HashMap<String, (i64, TokenUsage)>>> = Mutex::new(None);


fn mem_cache_get(key: &str, mtime: i64) -> Option<TokenUsage> {
    let guard = MEM_CACHE.lock().ok()?;
    let map = guard.as_ref()?;
    let (mt, u) = map.get(key)?;
    if *mt != mtime {
        return None;
    }
    Some(u.clone())
}

fn mem_cache_put_raw(key: &str, mtime: i64, u: &TokenUsage) {
    if let Ok(mut guard) = MEM_CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(key.to_string(), (mtime, u.clone()));
    }
}

fn mem_cache_put(path: &Path, u: &TokenUsage) {
    let mtime = mtime_secs_of(path);
    let key = path.to_string_lossy().to_string();
    mem_cache_put_raw(&key, mtime, u);
    // 同时挂进磁盘缓存的内存副本，等 flush 时一起落盘
    if let Ok(mut guard) = DISK_CACHE.lock() {
        let map = guard.get_or_insert_with(disk_cache_load);
        map.insert(key, DiskCacheEntry { mtime, usage: u.clone() });
    }
}


fn disk_cache_path() -> std::path::PathBuf {
    crate::paths::data_root().join("token-cache.json")
}


/// 读磁盘缓存（整个文件读进内存 —— 它很小，只有会话数 × 一条记录）。
fn disk_cache_load() -> DiskCache {
    let p = disk_cache_path();
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn disk_cache_save(c: &DiskCache) {
    let p = disk_cache_path();
    if let Ok(s) = serde_json::to_string(c) {
        let _ = std::fs::write(p, s);
    }
}

fn disk_cache_get(key: &str, mtime: i64) -> Option<TokenUsage> {
    let mut guard = DISK_CACHE.lock().ok()?;
    let map = guard.get_or_insert_with(disk_cache_load);
    let e = map.get(key)?;
    if e.mtime != mtime {
        return None;
    }
    Some(e.usage.clone())
}
