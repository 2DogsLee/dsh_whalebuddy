use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 诊断日志（best-effort）：优先 exe 旁 pet-discover.log（开发期最方便），
/// 失败再落 %LOCALAPPDATA%\dev.dsh.pet\discover.log。
/// 宠物 UI 没有控制台，这是唯一能从进程外看到发现层在干什么的通道。
fn log_discover(line: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{ts}] {line}\n");
    let mut written = false;
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = std::fs::create_dir_all(dir);
            written = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("pet-discover.log"))
                .and_then(|mut f| f.write_all(line.as_bytes()))
                .is_ok();
        }
    }
    if !written {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            let dir = std::path::Path::new(&base).join("dev.dsh.pet");
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("discover.log"))
                .and_then(|mut f| f.write_all(line.as_bytes()));
        }
    }
}

/// 探测单个端口是否是 dsh-pet 握手端点（HTTP GET /dsh-pet/handshake）。
/// 连接 300ms + 读写 600ms 上限：本机安全软件对 loopback 关闭端口会静默丢 SYN
/// （实测单端口要 ~2s 才失败），无上限的话全段扫描会被拖到不可用。
fn probe(port: u16) -> bool {
    let Some(addr) = ("127.0.0.1", port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut i| i.next())
    else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = b"GET /dsh-pet/handshake HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(req).is_err() {
        return false;
    }
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= 2048 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).contains("dsh-pet")
}

/// 枚举本机 TCP LISTENING 且落在临时端口段的端口（netstat 解析，零网络流量）。
/// 动机：过滤驱动让关闭端口连接要 ~2s，全段 1.6 万端口扫描最坏 ~10 分钟；
/// netstat 直接读内核 TCP 表，把候选缩到个位数，探测亚秒级完成。
fn listening_candidates() -> Vec<u16> {
    let Ok(out) = Command::new("netstat").args(["-ano", "-p", "tcp"]).output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut ports: Vec<u16> = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 || cols[3] != "LISTENING" {
            continue;
        }
        let Some((_, port_s)) = cols[1].rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port_s.parse::<u16>() else {
            continue;
        };
        if (49152..=65535).contains(&port) && !ports.contains(&port) {
            ports.push(port);
        }
    }
    ports
}

/// 并行探测候选端口序列，命中 dsh-pet 握手即返回。
fn scan_ports(ports: &[u16]) -> Option<u16> {
    if ports.is_empty() {
        return None;
    }
    let ports: Arc<Vec<u16>> = Arc::new(ports.to_vec());
    let idx = Arc::new(AtomicUsize::new(0));
    let found = Arc::new(AtomicU16::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let threads = 8.min(ports.len());

    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let ports = Arc::clone(&ports);
            let idx = Arc::clone(&idx);
            let found = Arc::clone(&found);
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || loop {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let i = idx.fetch_add(1, Ordering::Relaxed);
                if i >= ports.len() {
                    return;
                }
                if probe(ports[i]) {
                    found.store(ports[i], Ordering::SeqCst);
                    stop.store(true, Ordering::Release);
                    return;
                }
            })
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }
    let p = found.load(Ordering::SeqCst);
    if p != 0 { Some(p) } else { None }
}

/// 端口发现（命令与 CLI 共用）：
/// 1) 环境变量 DSH_WEB_URL（从带 DSH 环境的 shell 启动时直接命中）
/// 2) netstat LISTENING 候选（亚秒级，正常路径）
/// 3) 全段扫描兜底（netstat 不可用时；慢但完整）
fn discover_impl() -> Option<u16> {
    let t0 = Instant::now();
    if let Ok(url) = std::env::var("DSH_WEB_URL") {
        if let Some(port) = url.rsplit(':').next().and_then(|s| s.trim().parse::<u16>().ok()) {
            if probe(port) {
                log_discover(&format!("env hit port {port} ({}ms)", t0.elapsed().as_millis()));
                return Some(port);
            }
            log_discover(&format!(
                "env miss: DSH_WEB_URL={url} probe {port} failed ({}ms)",
                t0.elapsed().as_millis()
            ));
        }
    }
    let cands = listening_candidates();
    let shown: Vec<u16> = cands.iter().take(20).copied().collect();
    log_discover(&format!(
        "netstat candidates {} 个: {:?} ({}ms)",
        cands.len(),
        shown,
        t0.elapsed().as_millis()
    ));
    if let Some(p) = scan_ports(&cands) {
        log_discover(&format!("netstat path hit {p} ({}ms)", t0.elapsed().as_millis()));
        return Some(p);
    }
    log_discover(&format!(
        "netstat path miss, full scan 16384 ports begin ({}ms)",
        t0.elapsed().as_millis()
    ));
    let full: Vec<u16> = (49152..=65535).collect();
    let r = scan_ports(&full);
    log_discover(&format!(
        "full scan done -> {r:?} ({}ms)",
        t0.elapsed().as_millis()
    ));
    r
}

/// 端口发现（前端 invoke 调用）。
/// 必须是 async command：同步命令在主线程执行，扫描会阻塞窗口消息泵
/// 触发 Windows Application Hang（1002），表现即"双击 exe 卡死"。
#[tauri::command]
async fn discover_port(port_hint: Option<u16>) -> Option<u16> {
    if let Some(port) = port_hint {
        if port != 0 && probe(port) {
            return Some(port);
        }
    }
    discover_impl()
}

/// 前端 JS 调试日志：写入 pet-discover.log，便于进程外诊断（GUI 无控制台）。
#[tauri::command]
fn debug_log(msg: String) {
    log_discover(&format!("[js] {msg}"));
}

/// 开机自启动开关（whalebuddy）：写/删 HKCU\...\Run\whalebuddy 注册表项。
/// 用 reg.exe 子进程（Windows 自带），避免为单一功能引入注册表 crate 依赖。
/// 自启动值是当前 exe 的完整路径（带引号）+ --autostart 标记。
/// 重复调用幂等：enabled=true 反复写同值无副作用；enabled=false 删不存在的键视为成功。
#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_str = exe.to_string_lossy().to_string();
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    if enabled {
        let value = format!("\"{exe_str}\" --autostart");
        let out = Command::new("reg")
            .args(["add", key, "/v", "whalebuddy", "/t", "REG_SZ", "/d", &value, "/f"])
            .output()
            .map_err(|e| format!("reg add 启动失败: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "reg add 非零退出 ({}): {}",
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        log_discover(&format!("autostart enabled -> {key}\\whalebuddy = {value}"));
    } else {
        let out = Command::new("reg")
            .args(["delete", key, "/v", "whalebuddy", "/f"])
            .output()
            .map_err(|e| format!("reg delete 启动失败: {e}"))?;
        // 键不存在时 reg delete 返回错误码 1 —— 目标态已达成，视为成功
        if !out.status.success() {
            let code = out.status.code().unwrap_or(-1);
            if code != 1 {
                return Err(format!(
                    "reg delete 非零退出 ({code}): {}",
                    String::from_utf8_lossy(&out.stderr)
                ));
            }
        }
        log_discover(&format!("autostart disabled (reg delete exit {})", out.status.code().unwrap_or(-1)));
    }
    Ok(())
}

/// 用默认浏览器打开 URL（whalebuddy 设置页入口）。
/// `cmd /c start "" <url>` 模式：空 title 参数防止 cmd 把 URL 当作标题；Windows 自带 start 关联默认浏览器。
/// 不引新依赖（避免 tauri-plugin-shell/opener），Rust 侧 spawn 不受 Tauri shell 权限约束。
/// 仅允许 http/https（防 file:// 等本地协议被滥用）。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("refused non-http(s) url: {url}"));
    }
    let out = Command::new("cmd")
        .args(["/c", "start", "", url])
        .output()
        .map_err(|e| format!("cmd start failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "cmd start non-zero ({}): {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    log_discover(&format!("open_url -> {url}"));
    Ok(())
}

pub fn run() {
    // CLI 诊断模式：dsh-pet.exe --discover —— 只跑发现逻辑并写日志，不起窗口。
    // 宠物 UI 无控制台，结果一律落 discover.log（GUI 子系统进程没有可用的 stdout）。
    if std::env::args().any(|a| a == "--discover") {
        log_discover("--discover start");
        let t0 = Instant::now();
        let r = discover_impl();
        log_discover(&format!(
            "--discover result: {r:?} total {}ms",
            t0.elapsed().as_millis()
        ));
        return;
    }
    // --autostart 标记（开机自启动带入）：与普通启动行为一致（宠物开机即出现），
    // 保留参数以便将来支持静默/最小化启动。其余参数忽略。
    if std::env::args().any(|a| a == "--autostart") {
        log_discover("launched via --autostart (system Run key)");
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![discover_port, debug_log, set_autostart, open_url])
        .run(tauri::generate_context!())
        .expect("dsh-pet 启动失败");
}
