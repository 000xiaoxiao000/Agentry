// 统一对端线协议（中心 hub ↔ 轻量代理 agent 共用）。
//
// 帧格式：4 字节大端长度前缀 + JSON。握手 hello→challenge→auth→ok（HMAC-SHA256 双向认证）。
//
// 消息类型：
//   proxy → hub：hello / register / activity / heartbeat / bye
//   hub → proxy：req（请求拉取远端数据）→ proxy 回 res（同 rid 关联）
//
// 「req/res」是本模块的核心：早期协议是单向的（代理只上报 activity），
// 中心无法按需拉取远端的会话 / 产物 / 任务内容，只能看到「有多少个工具在跑」。
// 加了 req/res 后，本机与远端走同一套数据接口 —— 中心一条命令就能拿到
// 「本机 + 所有在线代理」的合并视图。
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// 写一帧 JSON（4 字节大端长度前缀 + 内容）。
pub fn write_frame<W: Write>(w: &mut W, v: &serde_json::Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(v).map_err(|e| format!("序列化失败: {e}"))?;
    let len = bytes.len() as u32;
    w.write_all(&len.to_be_bytes())
        .map_err(|e| format!("写入长度失败: {e}"))?;
    w.write_all(&bytes).map_err(|e| format!("写入数据失败: {e}"))?;
    w.flush().map_err(|e| format!("flush 失败: {e}"))?;
    Ok(())
}

/// 读一帧 JSON。
pub fn read_frame<R: Read>(r: &mut R) -> Result<serde_json::Value, String> {
    read_frame_io(r).map_err(|e| format!("读取失败: {e}"))
}

/// 读一帧 JSON，保留 io::Error 的类型。
///
/// 中心 hub 需要区分「读超时」与「对端关闭」：
/// 超时只说明这段时间没收到数据（代理可能只是上报间隔长），连接本身还是好的；
/// 只有真正的 EOF / 复位才算断开。把类型丢掉的话，代理会被误判成离线。
pub fn read_frame_io<R: Read>(r: &mut R) -> std::io::Result<serde_json::Value> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    // 防御：单个帧不允许超过 64MB（远端返回大产物列表时也不该更大）
    if len > 64 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("帧过大: {len} 字节"),
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    serde_json::from_slice(&buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// HMAC-SHA256（十六进制）。
pub fn hmac_sha256(key: &str, msg: &str) -> String {
    let key_bytes = key.as_bytes();
    let mut k = [0u8; 64];
    if key_bytes.len() > 64 {
        let h = Sha256::digest(key_bytes);
        k[..h.len()].copy_from_slice(&h);
    } else {
        k[..key_bytes.len()].copy_from_slice(key_bytes);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(msg.as_bytes());
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(&inner_hash);
    let outer_hash = outer.finalize();
    let mut s = String::with_capacity(64);
    for b in outer_hash {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 随机 nonce（十六进制）。
pub fn nonce_hex() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static C: std::sync::OnceLock<AtomicU64> = std::sync::OnceLock::new();
    let c = C.get_or_init(|| AtomicU64::new(0));
    let seq = c.fetch_add(1, Ordering::SeqCst);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:016x}{:08x}", nanos as u64, seq)
}

/// 中心 → 代理的请求 op。协议稳定后只增不改。
pub mod ops {
    /// 拉取会话简表（与本机 list_conversations 同结构）
    pub const LIST_CONVERSATIONS: &str = "list_conversations";
    /// 拉取产物列表（与本机 list_artifacts 同结构）
    pub const LIST_ARTIFACTS: &str = "list_artifacts";
    /// 拉取任务记录（与本机 list_tasks 同结构）
    pub const LIST_TASKS: &str = "list_tasks";
    /// 按 id 拉取单个产物完整内容
    pub const GET_ARTIFACT: &str = "get_artifact";
    /// 读一个文件的内容（产物详情里的文件预览）
    pub const READ_FILE: &str = "read_file";
    /// 代理本机统计（会话数 / 今日 / 运行中）
    pub const STATS: &str = "stats";
    /// 按连接器聚合的 token 用量统计
    pub const TOKEN_STATS: &str = "token_stats";
}

/// 中心的请求表：rid → 等待中的应答通道。
///
/// 中心是「一条连接一个读线程」的模型：读线程收到 res 后按 rid 找到等待方投递，
/// 于是 Tauri 命令线程可以阻塞等待某个具体请求的结果（带超时）。
pub type Pending = Arc<Mutex<HashMap<u64, Sender<Result<serde_json::Value, String>>>>>;

/// 注册一个待应答的请求，返回 rid。
pub fn register_pending(p: &Pending) -> (u64, Receiver<Result<serde_json::Value, String>>) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static C: AtomicU64 = AtomicU64::new(1);
    let rid = C.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    p.lock()
        .unwrap()
        .insert(rid, tx);
    (rid, rx)
}

/// 把代理回的 res 投递给等待方（rid 不存在说明已超时丢弃）。
pub fn deliver_pending(p: &Pending, rid: u64, v: Result<serde_json::Value, String>) {
    let tx = p.lock().unwrap().remove(&rid);
    if let Some(tx) = tx {
        let _ = tx.send(v);
    }
}

/// 构造一条 res 帧。
pub fn res_frame(rid: u64, v: Result<serde_json::Value, String>) -> serde_json::Value {
    match v {
        Ok(data) => serde_json::json!({"t":"res","rid":rid,"ok":true,"data":data}),
        Err(e) => serde_json::json!({"t":"res","rid":rid,"ok":false,"error":e}),
    }
}

/// 构造一条 req 帧。
pub fn req_frame(rid: u64, op: &str, args: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"t":"req","rid":rid,"op":op,"args":args})
}

/// 代理侧：解析一条 req 帧 → (rid, op, args)。
pub fn parse_req(msg: &serde_json::Value) -> Option<(u64, String, serde_json::Value)> {
    if msg.get("t").and_then(|v| v.as_str()) != Some("req") {
        return None;
    }
    let rid = msg.get("rid").and_then(|v| v.as_u64())?;
    let op = msg.get("op").and_then(|v| v.as_str())?.to_string();
    let args = msg.get("args").cloned().unwrap_or(serde_json::Value::Null);
    Some((rid, op, args))
}

/// 代理侧：解析一条 res 帧 → (rid, 结果)。
pub fn parse_res(msg: &serde_json::Value) -> Option<(u64, Result<serde_json::Value, String>)> {
    if msg.get("t").and_then(|v| v.as_str()) != Some("res") {
        return None;
    }
    let rid = msg.get("rid").and_then(|v| v.as_u64())?;
    let ok = msg.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        Some((rid, Ok(msg.get("data").cloned().unwrap_or(serde_json::Value::Null))))
    } else {
        let e = msg
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("远端处理失败")
            .to_string();
        Some((rid, Err(e)))
    }
}

/// 短 id。
pub fn short_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static C: AtomicU64 = AtomicU64::new(0);
    let n = C.fetch_add(1, Ordering::SeqCst);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", t as u64, n)
}

/// 等待应答（带超时）。超时返回 Err，调用方不应无限期阻塞。
pub fn await_res(
    rx: Receiver<Result<serde_json::Value, String>>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    match rx.recv_timeout(timeout) {
        Ok(v) => v,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("等待远端应答超时（{}s）", timeout.as_secs()))
        }
        Err(_) => Err("等待远端应答时通道断开".to_string()),
    }
}
