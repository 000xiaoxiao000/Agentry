// 中心端的 headless 助手：只做「起中心 hub」一件事。
//
// 为什么需要它：agentry 是 GUI 应用，没法在脚本里驱动窗口；
// 但中心的能力（hub、合并门面）都在 agentry 这个 lib 里 ——
// 这个助手调的是**和 GUI 完全相同**的函数，所以联调测到的是真实行为。
//
// 它是 agentry 包里的第二个 bin（与 GUI 同包、同 lib）：
//   cargo run -p agentry --bin agentry-center-helper -- --port 47800 --secret <密钥>
// 仅供测试与「中心跑在无界面的服务器上」的场景使用；正常用桌面 GUI。
// 包内的 default-run = "agentry" 保证 `cargo run` 不会因两个 bin 而歧义。
use std::path::PathBuf;
use std::time::Duration;

use agentry::hub;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut port: u16 = 47800;
    let mut secret = String::new();
    let mut data_dir: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" if i + 1 < args.len() => {
                port = args[i + 1].parse().unwrap_or(port);
                i += 2;
            }
            "--secret" if i + 1 < args.len() => {
                secret = args[i + 1].clone();
                i += 2;
            }
            // 数据目录：联调时必须显式指定，否则会落到开发期回落路径（项目目录），
            // 把测试扫到的产物写进用户的真实数据目录。
            "--data-dir" if i + 1 < args.len() => {
                data_dir = Some(PathBuf::from(args[i + 1].clone()));
                i += 2;
            }
            _ => i += 1,
        }
    }
    if secret.trim().is_empty() {
        eprintln!("[center] 缺少 --secret");
        std::process::exit(2);
    }
    if let Some(d) = data_dir {
        let _ = std::fs::create_dir_all(&d);
        agent_core::set_data_root(d);
    }
    if let Err(e) = hub::start_hub("127.0.0.1", port, secret) {
        eprintln!("[center] 启动失败：{e}");
        std::process::exit(1);
    }
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}
