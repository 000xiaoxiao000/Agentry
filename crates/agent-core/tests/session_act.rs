//! 「书写 / 阅读 / 调工具」三态的判定回归测试。
//!
//! 这三个姿态**不是 UI 编出来的拟人化标签**，而是由会话 JSONL 尾部的记录类型决定的。
//! 曾经踩过的坑：写判定为「assistant message 的 status ∈ in_progress/streaming」，
//! 但 WorkBuddy 是整段回答写完才落盘（实测 485 个会话文件里 in_progress/streaming 出现 0 次），
//! 导致「书写」在界面上永远是 0 —— 看起来就像假数据。
//!
//! 现在改按「最后一条记录的类型」判定：
//!   function_call         → tooling（工具已派出、结果未回）
//!   function_call_result  → writing（结果已回、正在产出回答）
//!   reasoning             → thinking（正在思考）
//! 本文件把这四条规则钉住，防止以后被改回去。

use std::io::Write;

use agent_core::session::scan_session_uncached;

fn write_session(name: &str, lines: &[&str]) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("agent-core-act-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    let p = dir.join("session.jsonl");
    let mut f = std::fs::File::create(&p).expect("create");
    for l in lines {
        writeln!(f, "{}", l).expect("write");
    }
    p
}

/// 会话里常见的元信息记录：每次动作后都会补写，不能参与定性。
const NOISE: &[&str] = &[
    r#"{"type":"session-meta","cwd":"/tmp/proj"}"#,
    r#"{"type":"file-history-snapshot","files":[]}"#,
];

fn with_tail(lines: &[&str], tail: &str) -> Vec<String> {
    let mut v: Vec<String> = NOISE.iter().map(|s| s.to_string()).collect();
    v.extend(lines.iter().map(|s| s.to_string()));
    v.push(tail.to_string());
    v
}

#[test]
fn last_function_call_is_tooling() {
    let p = write_session(
        "tooling",
        &[
            r#"{"type":"message","role":"user","content":"帮我看看这个项目"}"#,
            r#"{"type":"reasoning","content":"先扫一遍目录"}"#,
            r#"{"type":"function_call","function":{"name":"Bash","arguments":"ls"}}"#,
        ],
    );
    let s = scan_session_uncached(&p);
    assert_eq!(s.act, "tooling");
    assert_eq!(s.busy, Some(true));
}

#[test]
fn last_function_call_result_is_writing() {
    // 关键用例：工具结果回来了、后面还没写别的 —— 这一小段只可能在组织输出。
    let lines = with_tail(
        &[
            r#"{"type":"function_call","function":{"name":"Bash","arguments":"ls"}}"#,
        ],
        r#"{"type":"function_call_result","status":"completed","content":"main.rs"}"#,
    );
    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let p = write_session("writing", &refs);
    let s = scan_session_uncached(&p);
    assert_eq!(s.act, "writing", "工具已返回应判为书写（不是调工具、也不是闲）");
    assert_eq!(s.busy, Some(true));
}

#[test]
fn last_reasoning_is_thinking() {
    let lines = with_tail(
        &[r#"{"type":"function_call_result","status":"completed","content":"ok"}"#],
        r#"{"type":"reasoning","content":"接下来改哪一行"}"#,
    );
    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let p = write_session("thinking", &refs);
    let s = scan_session_uncached(&p);
    assert_eq!(s.act, "thinking");
    assert_eq!(s.busy, Some(true));
}

#[test]
fn finished_assistant_message_is_idle_even_when_incomplete() {
    // completed 与 incomplete 都算「这一轮已经结束」。
    // incomplete 是被切换/中断留下的截断 —— 判成忙会让几十天前的老会话变成幽灵小人。
    for status in ["completed", "incomplete"] {
        let tail = format!(
            r#"{{"type":"message","role":"assistant","status":"{}","content":[{{"type":"output_text","text":"好了"}}]}}"#,
            status
        );
        let lines = with_tail(&[], &tail);
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        let name = format!("idle-{}", status);
        let p = write_session(&name, &refs);
        let s = scan_session_uncached(&p);
        assert_eq!(s.act, "idle", "status={} 应为闲坐", status);
        assert_eq!(s.busy, Some(false), "status={} 不应算忙", status);
    }
}

#[test]
fn trailing_user_message_is_waiting() {
    let lines = with_tail(
        &[r#"{"type":"message","role":"assistant","status":"completed","content":"上一轮答完了"}"#],
        r#"{"type":"message","role":"user","content":"再问一个"}"#,
    );
    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let p = write_session("waiting", &refs);
    let s = scan_session_uncached(&p);
    assert_eq!(s.act, "waiting");
    assert_eq!(s.busy, Some(true));
}
