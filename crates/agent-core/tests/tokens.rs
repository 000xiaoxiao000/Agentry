// token 用量解析的单元测试。
//
// 重点验证「累计算法」—— 这是最容易出错的地方：
//   input_tokens 是累计快照（取最大/最后一条），output_tokens 是增量（求和）。
// 搞反了会算出差几个数量级的数字。
use std::fs;
use std::path::PathBuf;

use agent_core::tokens::{session_tokens, TokenUsage};

/// 每个测试用**独立子目录**。
///
/// 测试是并发跑的：共用一个目录时，某个测试清理目录会让另一个正在写文件的
/// 测试报 `Invalid argument`（macOS 上删掉已打开的文件就会这样）。
/// 独立子目录 = 互不干扰。
fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("agentry-token-test")
        .join(tag);
    let _ = fs::create_dir_all(&dir);
    dir
}

fn tmp_path(tag: &str, name: &str) -> PathBuf {
    tmp_dir(tag).join(name)
}
/// 写一个会话文件，内容由调用方给。
fn write_session(tag: &str, name: &str, lines: &[&str]) -> PathBuf {
    let p = tmp_path(tag, name);
    let body = lines.join("\n");
    fs::write(&p, body).unwrap();
    p
}

#[test]
fn 所有字段都是求和() {
    // 每条 usage = 一次 API 调用的用量 → 全部字段累加。
    // （曾误以为 input 是「至今累计」而取最大值，低估 34 倍。）
    let p = write_session(
        "acc",
        "acc.jsonl",
        &[
            r#"{"type":"function_call","message":{"usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":50}}}"#,
            r#"{"type":"function_call","message":{"usage":{"input_tokens":200,"output_tokens":20,"cache_read_input_tokens":150}}}"#,
            r#"{"type":"function_call","message":{"usage":{"input_tokens":300,"output_tokens":30,"cache_read_input_tokens":250}}}"#,
        ],
    );
    let u = session_tokens(&p);
    assert_eq!(u.input, 600, "input 是各次调用之和 = 100+200+300");
    assert_eq!(u.output, 60, "output 是各次调用之和 = 10+20+30");
    assert_eq!(u.cache_read, 450, "cache_read 是各次调用之和 = 50+150+250");
    assert_eq!(u.sessions, 1);
}

#[test]
fn 上下文压缩导致回退时仍要累加() {
    // compaction 后上下文变小：in 从 94046 掉到 33017。
    // 「至今累计」不可能变小 → 这类记录必须**求和**，不能取最大值。
    let p = write_session(
        "compact",
        "compact.jsonl",
        &[
            r#"{"type":"function_call","message":{"usage":{"input_tokens":90000,"output_tokens":100,"cache_read_input_tokens":89000}}}"#,
            r#"{"type":"function_call","message":{"usage":{"input_tokens":94046,"output_tokens":200,"cache_read_input_tokens":93824}}}"#,
            r#"{"type":"function_call","message":{"usage":{"input_tokens":33017,"output_tokens":300,"cache_read_input_tokens":15616}}}"#,
            r#"{"type":"function_call","message":{"usage":{"input_tokens":43013,"output_tokens":400,"cache_read_input_tokens":40448}}}"#,
        ],
    );
    let u = session_tokens(&p);
    // 正确 = 全部累加：90000+94046+33017+43013
    assert_eq!(u.input, 260076, "回退不能影响累加");
    // 取最大值会得到 94046（漏掉后半段）—— 那正是原来的错误实现
    assert_ne!(u.input, 94046);
    assert_eq!(u.cache_read, 238888, "cache_read 同样是各次之和");
    assert_eq!(u.output, 1000);
}

#[test]
fn usage_可挂在顶层或_message_里() {
    let p = write_session(
        "where",
        "where.jsonl",
        &[
            r#"{"type":"message","role":"assistant","usage":{"input_tokens":500,"output_tokens":50}}"#,
            r#"{"type":"function_call","message":{"usage":{"input_tokens":900,"output_tokens":25}}}"#,
        ],
    );
    let u = session_tokens(&p);
    // 两种挂载方式都要被认出来，且都参与累加：500 + 900 = 1400
    assert_eq!(u.input, 1400);
    assert_eq!(u.output, 75);
}

#[test]
fn 兼容驼峰字段名() {
    // 另一种工具的记录格式：camelCase
    let p = write_session(
        "camel",
        "camel.jsonl",
        &[
            r#"{"type":"message","message":{"usage":{"inputTokens":1234,"outputTokens":56}}}"#,
        ],
    );
    let u = session_tokens(&p);
    assert_eq!(u.input, 1234);
    assert_eq!(u.output, 56);
}

#[test]
fn 无_usage_的会话返回空() {
    let p = write_session(
        "none",
        "none.jsonl",
        &[
            r#"{"type":"message","role":"user","content":"hi"}"#,
            r#"{"type":"message","role":"assistant","content":"hello"}"#,
        ],
    );
    let u = session_tokens(&p);
    assert_eq!(u.input, 0);
    assert_eq!(u.output, 0);
    assert_eq!(u.sessions, 0, "没有 usage 的会话不该计入统计");
}

#[test]
fn 文件不存在不报错() {
    let u = session_tokens(&tmp_path("missing", "__不存在__.jsonl"));
    assert_eq!(u.input, 0);
    assert_eq!(u.sessions, 0);
}

#[test]
fn 节省量与命中率算得对() {
    let mut u = TokenUsage::default();
    u.input = 1_000_000;
    u.output = 50_000;
    u.cache_read = 900_000;
    u.sessions = 10;

    assert!((u.cache_hit_rate() - 0.9).abs() < 1e-9, "命中率应为 90%");
    assert_eq!(u.uncached_input(), 100_000, "未命中缓存的部分才是原价计费");
    // 缓存读价约为输入价 1/10 → 90 万命中相当于省下 81 万
    assert_eq!(u.saved_equivalent(), 810_000);
    assert_eq!(u.total(), 1_050_000);
}

#[test]
fn 合并统计() {
    let mut a = TokenUsage { input: 100, output: 10, cache_read: 50, cache_creation: 5, sessions: 1 };
    let b = TokenUsage { input: 200, output: 20, cache_read: 150, cache_creation: 0, sessions: 2 };
    a.merge(&b);
    assert_eq!(a.input, 300);
    assert_eq!(a.output, 30);
    assert_eq!(a.cache_read, 200);
    assert_eq!(a.sessions, 3);
}

#[test]
fn 清理临时目录() {
    // 只删**自己专属**的目录 —— 不能碰其它测试正在用的子目录。
    // （之前删整个根目录，偶发导致并发测试报 Invalid argument。）
    let _ = fs::remove_dir_all(tmp_dir("cleanup"));
}
