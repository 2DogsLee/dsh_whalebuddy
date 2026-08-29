fn main() {
    // 监听 frontendDist 目录内所有文件，任何前端改动都触发 build.rs 重跑并重新嵌入。
    // 用 rerun-if-changed 精确声明每个文件（tauri_build 默认不监听，否则增量编译
    // 一直用旧嵌入的 index.html）。
    let ui = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../ui"));
    if let Ok(rd) = std::fs::read_dir(ui) {
        for e in rd.flatten() {
            if let Some(name) = e.path().file_name().and_then(|n| n.to_str()) {
                println!("cargo:rerun-if-changed=../ui/{}", name);
            }
        }
    }
    tauri_build::build()
}
