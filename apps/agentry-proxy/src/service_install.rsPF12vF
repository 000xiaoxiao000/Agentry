// 把代理注册成开机自启服务。
//
// 远端代理是「装上去就一直跑」的东西 —— 装完必须重启机器还能自动接回中心，
// 否则每次断电/注销后都得手动跑一次。所以提供 --install-service：
//   - macOS：写一份 launchd plist 到 ~/Library/LaunchAgents/，用 launchctl 加载
//   - Linux：写一份 systemd user unit 到 ~/.config/systemd/user/，用 systemctl --user 启用
//
// 只用「用户级」服务（不需要 root），免得装个工具还要提权。
use std::path::PathBuf;
use std::process::Command;

const LABEL: &str = "com.agentry.proxy";

/// 当前可执行文件的绝对路径（服务要靠它启动）。
fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("取当前程序路径失败: {e}"))
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()))
}

/// 安装服务。返回进程退出码。
pub fn install() -> i32 {
    let exe = match current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[proxy] 安装失败：{e}");
            return 1;
        }
    };
    let log_dir = home().join(".agentry-proxy").join("logs");
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!("[proxy] 安装失败：创建日志目录 {} 错误 {e}", log_dir.display());
        return 1;
    }
    let stdout = log_dir.join("proxy.out.log");
    let stderr = log_dir.join("proxy.err.log");

    if cfg!(target_os = "macos") {
        install_launchd(&exe, &stdout, &stderr)
    } else {
        install_systemd(&exe, &stdout, &stderr)
    }
}

/// 卸载服务。返回进程退出码。
pub fn uninstall() -> i32 {
    if cfg!(target_os = "macos") {
        let plist = home()
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{LABEL}.plist"));
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{}", uid()), &plist.display().to_string()])
            .output();
        let _ = Command::new("launchctl")
            .args(["unload", &plist.display().to_string()])
            .output();
        if plist.exists() {
            match std::fs::remove_file(&plist) {
                Ok(_) => eprintln!("[proxy] 已卸载服务（{}）", plist.display()),
                Err(e) => {
                    eprintln!("[proxy] 卸载失败：删除 {} 错误 {e}", plist.display());
                    return 1;
                }
            }
        } else {
            eprintln!("[proxy] 服务本来就没装");
        }
        0
    } else {
        let unit = home()
            .join(".config")
            .join("systemd")
            .join("user")
            .join("agentry-proxy.service");
        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", "agentry-proxy.service"])
            .output();
        if unit.exists() {
            match std::fs::remove_file(&unit) {
                Ok(_) => eprintln!("[proxy] 已卸载服务（{}）", unit.display()),
                Err(e) => {
                    eprintln!("[proxy] 卸载失败：删除 {} 错误 {e}", unit.display());
                    return 1;
                }
            }
        } else {
            eprintln!("[proxy] 服务本来就没装");
        }
        let _ = Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .output();
        0
    }
}

fn uid() -> u32 {
    // macOS launchctl 的 gui/<uid> 域
    unsafe { libc_getuid() }
}

#[cfg(target_os = "macos")]
unsafe fn libc_getuid() -> u32 {
    extern "C" {
        fn getuid() -> u32;
    }
    getuid()
}

#[cfg(not(target_os = "macos"))]
unsafe fn libc_getuid() -> u32 {
    0
}

fn install_launchd(exe: &PathBuf, stdout: &PathBuf, stderr: &PathBuf) -> i32 {
    let dir = home().join("Library").join("LaunchAgents");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[proxy] 安装失败：创建 {} 错误 {e}", dir.display());
        return 1;
    }
    let plist = dir.join(format!("{LABEL}.plist"));
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array><string>{exe}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{stdout}</string>
  <key>StandardErrorPath</key><string>{stderr}</string>
  <key>WorkingDirectory</key><string>{workdir}</string>
</dict>
</plist>
"#,
        label = LABEL,
        exe = exe.display(),
        stdout = stdout.display(),
        stderr = stderr.display(),
        workdir = home().display(),
    );
    if let Err(e) = std::fs::write(&plist, xml) {
        eprintln!("[proxy] 安装失败：写入 {} 错误 {e}", plist.display());
        return 1;
    }
    // 先卸载旧的再加载新的，避免重复注册
    let _ = Command::new("launchctl")
        .args(["bootout", &format!("gui/{}", uid())])
        .output();
    let out = Command::new("launchctl")
        .args([
            "bootstrap",
            &format!("gui/{}", uid()),
            &plist.display().to_string(),
        ])
        .output();
    let loaded = match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
    };
    if !loaded {
        // 老系统没有 bootstrap，退回 load
        let out2 = Command::new("launchctl")
            .args(["load", "-w", &plist.display().to_string()])
            .output();
        match out2 {
            Ok(o) => {
                if !o.status.success() {
                    eprintln!(
                        "[proxy] 安装失败：launchctl 加载失败：{}",
                        String::from_utf8_lossy(&o.stderr)
                    );
                    return 1;
                }
            }
            Err(e) => {
                eprintln!("[proxy] 安装失败：launchctl 调用失败：{e}");
                return 1;
            }
        }
    }
    eprintln!("[proxy] 已注册开机自启（{}）", plist.display());
    eprintln!("[proxy] 查看日志：{} / {}", stdout.display(), stderr.display());
    0
}

fn install_systemd(exe: &PathBuf, stdout: &PathBuf, stderr: &PathBuf) -> i32 {
    let dir = home().join(".config").join("systemd").join("user");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[proxy] 安装失败：创建 {} 错误 {e}", dir.display());
        return 1;
    }
    let unit = dir.join("agentry-proxy.service");
    let content = format!(
        r#"[Unit]
Description=Agentry 远端代理 agent
After=network.target

[Service]
Type=simple
ExecStart={exe}
Restart=always
RestartSec=5
StandardOutput=append:{stdout}
StandardError=append:{stderr}
WorkingDirectory={workdir}

[Install]
WantedBy=default.target
"#,
        exe = exe.display(),
        stdout = stdout.display(),
        stderr = stderr.display(),
        workdir = home().display(),
    );
    if let Err(e) = std::fs::write(&unit, content) {
        eprintln!("[proxy] 安装失败：写入 {} 错误 {e}", unit.display());
        return 1;
    }
    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();
    let out = Command::new("systemctl")
        .args(["--user", "enable", "--now", "agentry-proxy.service"])
        .output();
    match out {
        Ok(o) => {
            if !o.status.success() {
                eprintln!(
                    "[proxy] 安装完成但启动失败：{}",
                    String::from_utf8_lossy(&o.stderr)
                );
                eprintln!("[proxy] 可手动检查：systemctl --user status agentry-proxy");
                return 1;
            }
        }
        Err(e) => {
            eprintln!("[proxy] 安装完成但启动失败：systemctl 调用失败：{e}");
            eprintln!("[proxy] 可手动检查：systemctl --user status agentry-proxy");
            return 1;
        }
    }
    eprintln!("[proxy] 已注册开机自启（{}）", unit.display());
    eprintln!("[proxy] 查看日志：{} / {}", stdout.display(), stderr.display());
    0
}
