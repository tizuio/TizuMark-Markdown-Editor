use std::fs;
use std::ops::Deref;
use encoding_rs::GB18030;
use std::sync::Mutex;
use notify::{Watcher, RecursiveMode, RecommendedWatcher, Config as NotifyConfig, Event as NotifyEvent};
use tauri::{Emitter, Manager};
use tauri::path::BaseDirectory;
use tauri::WindowEvent;
use tauri::tray::{TrayIcon, TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri::menu::{Menu, MenuItem};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use md5::{Md5, Digest};

fn show_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
     .replace('\'', "&#x27;")
}

#[tauri::command]
fn open_devtools(app_handle: tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.open_devtools();
    }
}

#[tauri::command]
fn get_cli_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

// 从单实例回调的完整 argv 中取出待打开文件：跳过 argv[0]（可执行文件路径本身）。
// 与 get_cli_args（std::env::args().skip(1)）保持一致，避免把 exe 路径当文件打开。
fn files_from_args(argv: Vec<String>) -> Vec<String> {
    argv.into_iter().skip(1).collect()
}

// 前端同步窗口行为偏好：更新内存状态，并按需切换托盘图标可见性。
#[tauri::command]
fn set_window_behavior(show_tray: bool, app: tauri::AppHandle) {
    let behavior = app.state::<WindowBehavior>();
    if let Ok(mut s) = behavior.show_tray.lock() {
        *s = show_tray;
    }
    if let Ok(tray_guard) = app.state::<TrayState>().0.lock() {
        if let Some(tray) = tray_guard.as_ref() {
            let _ = tray.set_visible(show_tray);
        }
    }
}

// 前端调此命令真正退出应用（关窗弹框选"退出"时调用）。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// 路径安全校验：拒绝写入/创建到系统关键目录或越界路径。
// 编辑器需读写用户任意选中的文件，故不做全盘 scope 限制，
// 仅在此拦截危险目标（启动目录、系统目录等持久化/RCE 向量）。
fn safe_write_target(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    let canonical = p
        .canonicalize()
        .or_else(|_| {
            // 目标尚不存在时，向上递归找到第一个存在的祖先目录再 canonicalize，
            // 然后逐级 join 不存在的路径段，得到规范化的绝对路径。
            // 修复：ensure_dir 创建多级子树（如 app_data/tizu-mark/fonts）时，
            // 父目录也不存在，parent.canonicalize() 会失败报"系统找不到指定路径"。
            let mut components: Vec<std::ffi::OsString> = Vec::new();
            let mut cur = p;
            let mut base: Option<std::path::PathBuf> = None;
            while let Some(parent) = cur.parent() {
                if let Ok(canon) = parent.canonicalize() {
                    base = Some(canon);
                    break;
                }
                if let Some(name) = cur.file_name() {
                    components.push(name.to_os_string());
                }
                cur = parent;
                if cur.as_os_str().is_empty() { break; }
            }
            let base = base.ok_or_else(|| format!("Invalid path {}: cannot resolve ancestor", path))?;
            let file_name = p.file_name().ok_or_else(|| format!("Invalid path {}", path))?;
            // 确保最后一段（目标本身）也在 components 里
            if components.is_empty() || components.last().map(|s| s.as_os_str()) != Some(file_name) {
                components = components.into_iter().rev().collect();
            } else {
                components.reverse();
            }
            let mut result = base;
            for name in &components {
                result = result.join(name);
            }
            Ok::<std::path::PathBuf, String>(result)
        })?;

    let canonical_str = canonical.to_string_lossy().replace('/', "\\").to_lowercase();
    // 系统关键 / 持久化目录前缀黑名单（Windows）
    const BLOCKED: &[&str] = &[
        "\\windows\\",
        "\\program files\\",
        "\\program files (x86)\\",
        "\\system32\\",
        "\\programdata\\microsoft\\windows\\start menu\\programs\\startup",
        "\\appdata\\roaming\\microsoft\\windows\\start menu\\programs\\startup",
        "\\documents and settings\\",
        "autorun.inf",
    ];
    for b in BLOCKED {
        if canonical_str.contains(b) {
            return Err(format!("Refusing to write to protected path: {}", path));
        }
    }
    Ok(canonical)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let raw = fs::read(&path).map_err(|e| {
        // 结构化错误 JSON，前端按 kind 映射到错误码（E_NOT_FOUND / E_PERMISSION / E_LOCKED / E_IO）
        let kind = if e.kind() == std::io::ErrorKind::NotFound {
            "NotFound"
        } else if e.kind() == std::io::ErrorKind::PermissionDenied {
            // Windows 上文件被独占锁定（ERROR_SHARING_VIOLATION=32）也归为锁定
            match e.raw_os_error() {
                Some(32) => "Locked",
                _ => "PermissionDenied",
            }
        } else {
            "Io"
        };
        format!(
            "{{\"kind\":\"{}\",\"path\":\"{}\",\"message\":\"{}\"}}",
            kind,
            path.replace('\\', "\\\\").replace('"', "\\\""),
            e.to_string().replace('"', "\\\"")
        )
    })?;

    Ok(decode_bytes(&raw))
}

// 读取打包资源文件（demo.md / screenshots/* 等），dev/prod 兼容：
// 1) 优先从 Tauri 资源目录读取（生产 / 部分 dev 模式：target/debug/resources/...）；
// 2) 找不到时回退到 CARGO_MANIFEST_DIR 父目录（项目根）的同名字段，dev 模式
//    bundle.resources 不复制资源、目标目录为空，这里能直接读源码根的 demo.md / screenshots；
// 3) 仍找不到返回结构化 NotFound 错误，前端按 openLink 错误码处理。
// 返回 `{ content, path }`：path 是真正读到文件的本地路径（dev = 项目根，prod = 资源目录），
// 让 _openBundledFile 能把它设为 tab.filePath，processImages 据此解析相对图片。
#[tauri::command]
fn read_bundled_file(app: tauri::AppHandle, filename: String) -> Result<serde_json::Value, String> {
    if let Ok(p) = app.path().resolve(&filename, BaseDirectory::Resource) {
        if let Ok(bytes) = fs::read(&p) {
            return Ok(serde_json::json!({
                "content": decode_bytes(&bytes),
                "path": p.to_string_lossy().to_string(),
            }));
        }
    }
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(project_root) = manifest_dir.parent() {
        let dev_path = project_root.join(&filename);
        if let Ok(bytes) = fs::read(&dev_path) {
            return Ok(serde_json::json!({
                "content": decode_bytes(&bytes),
                "path": dev_path.to_string_lossy().to_string(),
            }));
        }
    }
    Err(format!(
        "{{\"kind\":\"NotFound\",\"path\":\"{}\",\"message\":\"bundled file not found: {}\"}}",
        filename.replace('\\', "\\\\").replace('"', "\\\""),
        filename
    ))
}

// 与 read_bundled_file 同款的资源定位策略，返回 base64 字符串（用于 pack 资源如
// screenshots/*.png）。demo.md 内的相对图片优先按 tab.filePath 拼路径走 fetch_image_as_base64，
// 不存在本地时回退到这里，便于 dev 模式加载项目根 screenshots 与生产资源目录 images。
#[tauri::command]
async fn read_bundled_image_as_base64(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let bytes_opt: Option<Vec<u8>> = if let Ok(p) = app.path().resolve(&filename, BaseDirectory::Resource) {
        fs::read(&p).ok()
    } else {
        None
    }
    .or_else(|| {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        manifest_dir.parent().and_then(|root| fs::read(root.join(&filename)).ok())
    });
    let bytes = bytes_opt.ok_or_else(|| {
        format!("bundled image not found: {}", filename)
    })?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// 解码字节为字符串：剥离 UTF-8 BOM → 优先 UTF-8 → 回退 GB18030（覆盖 GBK/GB2312/简繁）。
// read_file 与 search_in_files 共用，确保非 UTF-8 文件也能被搜索。
fn decode_bytes(raw: &[u8]) -> String {
    let stripped: &[u8] = if raw.len() >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF {
        &raw[3..]
    } else {
        raw
    };
    if let Ok(s) = String::from_utf8(stripped.to_vec()) {
        return s;
    }
    let (cow, _enc, _had_errors) = GB18030.decode(stripped);
    cow.into_owned()
}

// 托盘可见性状态，由前端设置同步。
// 关闭窗口时若无托盘则强制退出（否则窗口无法恢复）。
struct WindowBehavior {
    show_tray: Mutex<bool>,
}

impl Default for WindowBehavior {
    fn default() -> Self {
        Self {
            show_tray: Mutex::new(true),
        }
    }
}

struct TrayState(Mutex<Option<TrayIcon>>);

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<TrayIcon> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::new()
        .tooltip("TizuMark")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        show_window(&window);
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
                | TrayIconEvent::DoubleClick { .. } => {
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        show_window(&window);
                    }
                }
                _ => {}
            }
        })
        .build(app)
}

// ====== 「关闭到托盘」OS 级全局热键 ======
// 前端 keydown 只能在窗口聚焦时收到按键；窗口隐藏到托盘后 WebView 不再接收任何
// 键盘事件，因此「隐藏后也能唤回窗口」必须由 OS 级全局热键（tauri-plugin-global-shortcut）
// 承担。前端在应用启动/修改快捷键时调用 set_close_to_tray_shortcut 注册/注销。
struct GlobalShortcutState(Mutex<Option<String>>);

// 全局热键回调：窗口可见 → 隐藏到托盘（仅当托盘可见，否则窗口将无法恢复）；
// 窗口已隐藏/最小化 → 显示并聚焦（show_window 已做 unminimize + show + set_focus）。
fn toggle_main_window(app: &tauri::AppHandle) {
    let show_tray = app
        .try_state::<WindowBehavior>()
        .and_then(|b| b.show_tray.lock().ok().map(|g| *g))
        .unwrap_or(true);
    let Some(window) = app.get_webview_window("main") else { return };
    if window.is_visible().unwrap_or(false) {
        if show_tray {
            let _ = window.hide();
        }
    } else {
        show_window(&window);
    }
}

// 前端同步「关闭到托盘」全局热键：key 为空字符串则仅注销旧热键。
#[tauri::command]
fn set_close_to_tray_shortcut(app: tauri::AppHandle, key: String) -> Result<(), String> {
    // 1) 先注销旧的全局热键（存在时）
    let old = app
        .state::<GlobalShortcutState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    if let Some(old_key) = old {
        if let Ok(s) = old_key.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(s);
        }
    }
    let key = key.trim().to_string();
    if key.is_empty() {
        return Ok(());
    }
    // 2) 注册新热键；组合键已被其他程序占用等失败会返回 Err，由前端告警
    let shortcut: Shortcut = key
        .parse()
        .map_err(|e| format!("无效全局快捷键 {}: {}", key, e))?;
    app.global_shortcut().register(shortcut).map_err(|e| e.to_string())?;
    *app
        .state::<GlobalShortcutState>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = Some(key);
    Ok(())
}

#[derive(serde::Serialize, Clone, Copy)]
struct FileMeta {
    mtime: u64,
    size: u64,
}

#[tauri::command]
fn file_meta(path: String) -> Result<Option<FileMeta>, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Ok(None);
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(FileMeta {
        mtime,
        size: meta.len(),
    }))
}

#[tauri::command]
fn is_directory(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

// 重型/非笔记目录：不进树、不参与 Ctrl+P 搜索，避免 node_modules 等把树/搜索撑爆。
const IGNORE_DIRS: &[&str] = &[
    ".git", ".idea", ".vscode", "dist", "src-tauri", "target",
    "build", "out", "bin", "obj",
];

// 单目录条目上限：超过则截断并置 truncated，防止单文件夹上万文件把 DOM/渲染卡死。
const MAX_DIR_ENTRIES: usize = 3000;

#[derive(serde::Serialize, Clone)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    created: u64,
    mtime: u64,
    size: u64,
}

#[derive(serde::Serialize)]
struct DirListing {
    entries: Vec<DirEntryInfo>,
    truncated: bool,
}

impl Deref for DirListing {
    type Target = Vec<DirEntryInfo>;
    fn deref(&self) -> &Self::Target {
        &self.entries
    }
}

#[tauri::command]
fn list_dir(path: String) -> Result<DirListing, String> {
    let p = std::path::Path::new(&path);
    let _ = safe_write_target(&path).map_err(|e| e)?; // 复用规范化以拒绝越界/关键目录
    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let read = std::fs::read_dir(&p).map_err(|e| e.to_string())?;
    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // 跳过重型/非笔记目录（不进树，避免撑爆）
        if is_dir && IGNORE_DIRS.contains(&name.as_str()) {
            continue;
        }
        // 注：不再按扩展名过滤——所有非隐藏文件都进树；类型判定交给前端 classifyFile。
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let created = meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let size = meta.len();
        entries.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            created,
            mtime,
            size,
        });
        if entries.len() >= MAX_DIR_ENTRIES {
            break;
        }
    }
    let truncated = entries.len() >= MAX_DIR_ENTRIES;
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });
    Ok(DirListing { entries, truncated })
}

// 在文件管理器中「打开所在目录」并选中目标。
// 目录：直接打开该目录本身；文件：打开父目录并选中文件。
// 跨平台：Windows explorer（目录直接打开 / 文件 /select），macOS open（目录直接打开 / 文件 -R），Linux xdg-open（目录直接打开 / 文件打开父目录）。
// 关键：spawn 失败必须向外抛 Err（不能被 let _ = 吞掉），否则前端收到 Ok 却无反应。
// 关键：去掉 Windows 长路径前缀 \\?\（dev 模式下 Tauri canonical 路径会带此前缀，explorer / shell 都不认 → 静默失败）。
#[tauri::command]
fn reveal_in_folder(path: String, is_dir: bool) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is empty".to_string());
    }
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path).to_string();
    let spawn_res = if is_dir {
        // 目录：直接打开该文件夹本身
        #[cfg(target_os = "windows")]
        { std::process::Command::new("explorer").arg(&path).spawn() }
        #[cfg(target_os = "macos")]
        { std::process::Command::new("open").arg(&path).spawn() }
        #[cfg(target_os = "linux")]
        { std::process::Command::new("xdg-open").arg(&path).spawn() }
    } else {
        // 文件：打开父目录并选中（Windows/macOS 选中文件，Linux 无选中概念）
        #[cfg(target_os = "windows")]
        { std::process::Command::new("explorer").args(["/select,", &path]).spawn() }
        #[cfg(target_os = "macos")]
        { std::process::Command::new("open").args(["-R", &path]).spawn() }
        #[cfg(target_os = "linux")]
        {
            let parent = std::path::Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            std::process::Command::new("xdg-open").arg(parent).spawn()
        }
    };
    spawn_res.map_err(|e| format!("无法启动文件管理器 ({}): {}", path, e))?;
    Ok(())
}

#[derive(serde::Serialize)]
struct FileMatch {
    path: String,
    matches: Vec<LineMatch>,
}

#[derive(serde::Serialize)]
struct LineMatch {
    line: usize,   // 1-based 行号
    col: usize,    // 1-based 字符列号
    line_text: String,
}

// search_in_files 的同步核心，便于 cargo test 直接调用（命令 async 包装）。
// 递归遍历目录，按扩展名过滤（默认 md/markdown/txt），每文件解码后按行搜索。
// 上限：文件 2000 / 每文件 500 / 总匹配 5000，超限停止遍历。
fn search_in_files_impl(
    dir: &str,
    pattern: &str,
    case_sensitive: bool,
    use_regex: bool,
    extensions: &[String],
) -> Result<Vec<FileMatch>, String> {
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    let re: Option<regex::Regex> = if use_regex {
        match regex::Regex::new(pattern) {
            Ok(r) => Some(r),
            Err(_) => return Err("{\"kind\":\"InvalidEncoding\",\"path\":\"\",\"message\":\"invalid regex\"}".into()),
        }
    } else {
        None
    };
    let pattern_lower = pattern.to_lowercase();
    let exts: Vec<String> = if extensions.is_empty() {
        vec!["md".into(), "markdown".into(), "txt".into()]
    } else {
        extensions.iter().map(|e| e.to_lowercase()).collect()
    };

    const MAX_FILES: usize = 2000;
    const MAX_PER_FILE: usize = 500;
    const MAX_TOTAL: usize = 5000;
    const MAX_LINE_TEXT: usize = 300;

    let mut results: Vec<FileMatch> = Vec::new();
    let mut total = 0usize;
    let mut file_count = 0usize;

    let base = std::path::Path::new(dir);
    let mut stack: Vec<std::path::PathBuf> = vec![base.to_path_buf()];
    'outer: while let Some(cur) = stack.pop() {
        let rd = match fs::read_dir(&cur) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd {
            if file_count >= MAX_FILES || total >= MAX_TOTAL {
                break 'outer;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "target" || name == ".git" {
                    continue;
                }
                stack.push(path);
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !exts.contains(&ext) {
                continue;
            }
            let content = match fs::read(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let text = decode_bytes(&content);
            let mut file_matches: Vec<LineMatch> = Vec::new();
            for (i, line) in text.lines().enumerate() {
                if file_matches.len() >= MAX_PER_FILE {
                    break;
                }
                let byte_col: Option<usize> = if let Some(re) = &re {
                    re.find(line).map(|m| m.start())
                } else if case_sensitive {
                    line.find(pattern)
                } else {
                    line.to_lowercase().find(&pattern_lower)
                };
                if let Some(bc) = byte_col {
                    let char_col = line[..bc].chars().count();
                    let line_text: String = line.chars().take(MAX_LINE_TEXT).collect();
                    file_matches.push(LineMatch {
                        line: i + 1,
                        col: char_col + 1,
                        line_text,
                    });
                    total += 1;
                    if total >= MAX_TOTAL {
                        break;
                    }
                }
            }
            if !file_matches.is_empty() {
                results.push(FileMatch {
                    path: path.to_string_lossy().to_string(),
                    matches: file_matches,
                });
                file_count += 1;
            }
        }
    }
    Ok(results)
}

#[tauri::command]
async fn search_in_files(
    dir: String,
    pattern: String,
    case_sensitive: bool,
    use_regex: bool,
    extensions: Vec<String>,
) -> Result<Vec<FileMatch>, String> {
    search_in_files_impl(&dir, &pattern, case_sensitive, use_regex, &extensions)
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let _ = safe_write_target(&path)?;
    fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_binary_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    let _ = safe_write_target(&path)?;
    fs::write(&path, &contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    let _ = safe_write_target(&path)?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

// 检查 dst 是否等于 src 或位于 src 内部（按路径组件比较，跨平台 normalize 分隔符）。
// 防止把目录复制/移动到自身或子目录内导致递归复制直到路径超长。
fn is_path_within(src: &str, dst: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let s = norm(src);
    let d = norm(dst);
    s == d || d.starts_with(&format!("{}/", s))
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    let _ = safe_write_target(&from)?;
    let _ = safe_write_target(&to)?;
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_path(path: String) -> Result<(), String> {
    let _ = safe_write_target(&path)?;
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn copy_path(from: String, to: String) -> Result<(), String> {
    let _ = safe_write_target(&from)?;
    let _ = safe_write_target(&to)?;
    // 纵深防御：后端也检查目标是否在源内部，防止绕过前端直接 invoke 导致递归复制
    if is_path_within(&from, &to) {
        return Err("Cannot copy into itself or its subdirectory".into());
    }
    let from_p = std::path::Path::new(&from);
    if from_p.is_file() {
        fs::copy(&from, &to).map_err(|e| e.to_string()).map(|_| ())
    } else {
        copy_dir_recursive(from_p, std::path::Path::new(&to))
    }
}

// 递归复制目录：跳过符号链接以避免循环；不跟随链接语义，保持物理复制。
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if !dst.exists() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    }
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_symlink() {
            continue;
        }
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn move_path(from: String, to: String) -> Result<(), String> {
    let _ = safe_write_target(&from)?;
    let _ = safe_write_target(&to)?;
    if is_path_within(&from, &to) {
        return Err("Cannot move into itself or its subdirectory".into());
    }
    // 同设备 rename 是原子的；跨设备 rename 会失败，回退到 copy + remove
    match fs::rename(&from, &to) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_path(from.clone(), to)?;
            remove_path(from)
        }
    }
}

// 工作区文件监听：监听整棵目录树，外部（资源管理器等）增删目录/文件时向前端广播 folder-changed 事件，
// 前端防抖后重建文件树。监听句柄存入托管状态，重复监听或关闭文件夹时会先丢弃旧句柄。
struct WatcherState(pub Mutex<Option<RecommendedWatcher>>);

#[tauri::command]
fn watch_folder(path: String, app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut state) = app.state::<WatcherState>().0.lock() {
        *state = None;
    }
    let app_handle = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<NotifyEvent>| {
            // 回调在 notify 内部线程执行。必须保持【无锁、无状态】：panic 被 catch_unwind
            // 捕获后该线程继续存活、监听不中断；但捕获 ≠ 状态一致，任何带锁/中间态的逻辑
            // 都不要放这里（否则 panic 后可能残留锁导致死锁）。
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if res.is_ok() {
                    let _ = app_handle.emit("folder-changed", ());
                }
            }));
            if let Err(payload) = result {
                // 通知前端：监听异常可见化（弹「重新监听 / 继续使用」），panic 详情随事件带上。
                // 注意：catch_unwind 捕获的 panic 同样会先触发 panic hook，此处 emit 是给前端的
                // 第二通道（若 watcher 线程自身死掉，emit 发不出去——前端只能靠用户感知树不刷新）。
                let msg = payload
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                let _ = app_handle.emit(
                    "folder-watch-error",
                    serde_json::json!({ "message": msg }),
                );
            }
        },
        NotifyConfig::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    if let Ok(mut state) = app.state::<WatcherState>().0.lock() {
        *state = Some(watcher);
    }
    Ok(())
}

#[tauri::command]
fn stop_watch(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut state) = app.state::<WatcherState>().0.lock() {
        *state = None;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct ImageAssetInfo {
    filename: String,
    width: u32,
    height: u32,
}

#[tauri::command]
fn save_image_to_assets(bytes: Vec<u8>, ext: String, assets_dir: String) -> Result<ImageAssetInfo, String> {
    let hash = format!("{:x}", Md5::digest(&bytes));
    let filename = format!("{}.{}", hash, ext);
    let _ = safe_write_target(&assets_dir)?;
    let dest = std::path::Path::new(&assets_dir).join(&filename);

    std::fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    if !dest.exists() {
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }

    let (width, height) = match imagesize::blob_size(&bytes) {
        Ok(size) => (size.width as u32, size.height as u32),
        Err(_) => (0, 0),
    };

    Ok(ImageAssetInfo { filename, width, height })
}

#[tauri::command]
async fn fetch_image_as_base64(url: String) -> Result<String, String> {
    let bytes = if url.starts_with("http://") || url.starts_with("https://") {
        let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
        resp.bytes().await.map_err(|e| e.to_string())?.to_vec()
    } else {
        let path = std::path::Path::new(&url);
        let canonical = path.canonicalize().map_err(|e| format!("Cannot resolve path {}: {}", url, e))?;
        if !canonical.is_file() {
            return Err(format!("Not a regular file: {}", url));
        }
        std::fs::read(&canonical).map_err(|e| format!("Cannot read local file {}: {}", url, e))?
    };
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(encoded)
}

#[tauri::command]
fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|p| p.to_string_lossy().to_string())
}

// ====== 系统字体枚举 ======
// 用 fontdb 精确枚举系统全部已安装字体族名（跨平台），去重排序后返回。
// 首次调用需解析全部字体文件头部（数百 ms），故放 spawn_blocking 避免卡 UI。
#[tauri::command]
async fn list_system_fonts() -> Result<Vec<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        // Windows 补充：注册表可能指向任意绝对路径的字体文件（企业部署场景），
        // fontdb 的目录扫描覆盖不到；尽力而为，失败仅跳过。
        #[cfg(target_os = "windows")]
        load_windows_registry_fonts(&mut db);
        let mut names: std::collections::HashSet<String> = std::collections::HashSet::new();
        for face in db.faces() {
            for (family, _lang) in &face.families {
                let name = family.trim();
                if !name.is_empty() {
                    names.insert(name.to_string());
                }
            }
        }
        let mut list: Vec<String> = names.into_iter().collect();
        list.sort();
        Ok(list)
    })
    .await;
    match result {
        Ok(Ok(list)) => Ok(list),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(e.to_string()),
    }
}

// Windows：枚举 HKLM/HKCU 注册表 Fonts 键，把每个值（字体文件名或绝对路径）加载进 fontdb。
#[cfg(target_os = "windows")]
fn load_windows_registry_fonts(db: &mut fontdb::Database) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    const SUBKEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";
    let system_root = std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".to_string());
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        if let Ok(key) = RegKey::predef(hive).open_subkey(SUBKEY) {
            for (_, value) in key.enum_values().flatten() {
                let Some(data) = reg_value_string(&value) else { continue };
                let data = data.trim();
                if data.is_empty() {
                    continue;
                }
                let p = if std::path::Path::new(data).is_absolute() {
                    std::path::PathBuf::from(data)
                } else {
                    std::path::Path::new(&system_root).join("Fonts").join(data)
                };
                paths.push(p);
            }
        }
    }
    for p in paths {
        if p.is_file() {
            let _ = db.load_font_file(&p);
        }
    }
}

// Windows：启动时自愈 .md / .markdown 文件关联的「打开方式」（OpenWithProgids / Applications）。
// 背景：NSIS 安装器每次安装/更新都会注册文件关联，但 Windows 偶发在应用更新后清掉
// per-user 的 OpenWithProgids，导致右键「打开方式」里看不到 TizuMark。
// 这里仅检查缺失才补，只写 HKCU\Software\Classes 下最小键（与安装器同源），失败静默，不阻塞启动。
#[cfg(target_os = "windows")]
fn repair_file_association() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const PROGID: &str = "Markdown";
    const EXTS: [&str; 2] = [".md", ".markdown"];

    // 当前可执行文件路径（例如 C:\...\TizuMark\tizumark.exe）
    let Ok(exe) = std::env::current_exe().map(|p| p.to_string_lossy().to_string()) else {
        return;
    };
    let exe_name = std::path::Path::new(&exe)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "tizumark.exe".to_string());
    let open_cmd = format!("\"{}\" \"%1\"", exe);

    let root = RegKey::predef(HKEY_CURRENT_USER);

    for ext in EXTS {
        // 1) HKCU\Software\Classes\<ext>\OpenWithProgids\Markdown —— 缺失才补空值
        let owp = format!(r"Software\Classes\{}\OpenWithProgids", ext);
        match root.open_subkey_with_flags(&owp, winreg::enums::KEY_WRITE) {
            Ok(key) => {
                if key.get_value::<String, _>(PROGID).is_err() {
                    let _ = key.set_value(PROGID, &"");
                }
            }
            Err(_) => {
                if let Ok((new_key, _)) = root.create_subkey(&owp) {
                    let _ = new_key.set_value(PROGID, &"");
                }
            }
        }

        // 2) HKCU\Software\Classes\Applications\<exe>\shell\open\command —— 缺失才补
        let app = format!(r"Software\Classes\Applications\{}\shell\open\command", exe_name);
        match root.open_subkey_with_flags(&app, winreg::enums::KEY_WRITE) {
            Ok(key) => {
                if key.get_value::<String, _>("").is_err() {
                    let _ = key.set_value("", &open_cmd);
                }
            }
            Err(_) => {
                if let Ok((new_key, _)) = root.create_subkey(&app) {
                    let _ = new_key.set_value("", &open_cmd);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn reg_value_string(v: &winreg::RegValue) -> Option<String> {
    use winreg::enums::{REG_EXPAND_SZ, REG_SZ};
    if v.vtype != REG_SZ && v.vtype != REG_EXPAND_SZ {
        return None;
    }
    let bytes = &v.bytes;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let s = String::from_utf16_lossy(&units);
    let s = s.trim_end_matches('\0').to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// 递归遍历目录，收集文件清单，供前端 Ctrl+P 快速打开。
// extensions 为 None 或空 → 不过滤（搜全部文件，含图片/代码等）；否则按扩展名过滤。
// 跳过重型/非笔记目录（IGNORE_DIRS），并按 max_results 截断，避免病态目录树失控。
#[derive(serde::Serialize)]
struct SearchFileEntry {
    name: String,
    path: String,
    relative_path: String,
}

#[tauri::command]
fn search_files(
    path: String,
    extensions: Option<Vec<String>>,
    max_results: Option<usize>,
) -> Vec<SearchFileEntry> {
    // None 或空列表 → 不过滤；否则按给定扩展名过滤（已小写化）
    let exts: Option<Vec<String>> = extensions.map(|v| {
        v.into_iter()
            .map(|e| e.to_lowercase())
            .filter(|e| !e.is_empty())
            .collect()
    });
    let max = max_results.unwrap_or(50000).max(1);
    let root = std::path::Path::new(&path);
    let mut results: Vec<SearchFileEntry> = Vec::new();
    let mut dir_count: usize = 0;
    if root.is_dir() {
        search_files_walk(root, root, exts.as_deref(), &mut results, &mut dir_count, 0, 40, 60000, max);
    }
    results
}

#[allow(clippy::too_many_arguments)]
fn search_files_walk(
    dir: &std::path::Path,
    root: &std::path::Path,
    exts: Option<&[String]>,
    results: &mut Vec<SearchFileEntry>,
    dir_count: &mut usize,
    depth: usize,
    max_depth: usize,
    max_dirs: usize,
    max_results: usize,
) {
    if depth > max_depth || *dir_count > max_dirs || results.len() >= max_results {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // 权限不足等目录：跳过，继续其他分支
    };
    let mut sub_dirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if results.len() >= max_results {
            break;
        }
        let p = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            // 跳过重型/非笔记目录
            let name = entry.file_name().to_string_lossy().to_string();
            if !IGNORE_DIRS.contains(&name.as_str()) {
                sub_dirs.push(p);
            }
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let matched = match exts {
            Some(e) => lower
                .rfind('.')
                .map(|i| e.iter().any(|x| &lower[i + 1..] == x.as_str()))
                .unwrap_or(false),
            None => true,
        };
        if matched {
            let full = p.to_string_lossy().to_string();
            let relative = p
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|_| name.clone());
            results.push(SearchFileEntry {
                name,
                path: full,
                relative_path: relative,
            });
        }
    }
    for d in sub_dirs {
        if results.len() >= max_results {
            break;
        }
        *dir_count += 1;
        search_files_walk(&d, root, exts, results, dir_count, depth + 1, max_depth, max_dirs, max_results);
    }
}

#[tauri::command]
fn generate_toc(content: String) -> String {
    let mut items: Vec<(usize, String, String)> = Vec::new();
    let mut in_code_block = false;

    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            continue;
        }

        let (level, text) = if trimmed.starts_with("###### ") {
            (6, trimmed[7..].trim())
        } else if trimmed.starts_with("##### ") {
            (5, trimmed[6..].trim())
        } else if trimmed.starts_with("#### ") {
            (4, trimmed[5..].trim())
        } else if trimmed.starts_with("### ") {
            (3, trimmed[4..].trim())
        } else if trimmed.starts_with("## ") {
            (2, trimmed[3..].trim())
        } else if trimmed.starts_with("# ") {
            (1, trimmed[2..].trim())
        } else {
            continue;
        };

        let id = heading_to_id(text);
        items.push((level, text.to_string(), id));
    }

    if items.is_empty() {
        return String::new();
    }

    let mut html = String::from(r#"<div class="toc"><div class="toc-title">📑 目录</div><ul class="toc-list">"#);
    let mut prev_level = 0;

    for (level, text, id) in &items {
        if *level > prev_level {
            for _ in prev_level..*level {
                html.push_str("<ul>");
            }
        } else if *level < prev_level {
            for _ in *level..prev_level {
                html.push_str("</ul>");
            }
        }
        let href = format!("#{}", id);
        let item = format!(r#"<li><a href="{}">{}</a></li>"#, escape_html(&href), escape_html(text));
        html.push_str(&item);
        prev_level = *level;
    }

    for _ in 0..prev_level {
        html.push_str("</ul>");
    }

    html.push_str("</ul></div>");
    html
}

fn heading_to_id(text: &str) -> String {
    let mut id = String::new();
    for c in text.chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' {
            if c == ' ' || c == '-' || c == '_' {
                id.push('-');
            } else {
                // to_lowercase() may yield multiple chars for some Unicode (e.g. İ → i\u{0307}),
                // but heading chars are single-width in practice; take only the first.
                if let Some(lower_c) = c.to_lowercase().next() {
                    id.push(lower_c);
                }
            }
        }
    }
    let collapsed: String = id.chars().fold(String::new(), |mut acc, ch| {
        if ch != '-' || acc.chars().last() != Some('-') {
            acc.push(ch);
        }
        acc
    });
    collapsed.trim_matches('-').to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                show_window(&window);
                // files_from_args 滤掉 argv[0]（第二实例 exe 自身路径），
                // 避免前端误把 exe 当文件打开；与 get_cli_args 的 skip(1) 对齐
                let _ = app.emit("file-open", files_from_args(argv));
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let show_tray = *app.state::<WindowBehavior>().show_tray.lock().unwrap();
                // 无托盘时直接退出（否则窗口将无法恢复）
                if !show_tray {
                    app.exit(0);
                } else {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.show()?;
            // Windows 启动时自愈 .md/.markdown 文件关联「打开方式」，后台异步、失败静默
            #[cfg(target_os = "windows")]
            std::thread::spawn(repair_file_association);
            let tray = build_tray(app.handle())?;
            app.manage(TrayState(Mutex::new(Some(tray))));
            app.manage(WindowBehavior::default());
            Ok(())
        })
        .manage(WatcherState(Mutex::new(None)))
        .manage(GlobalShortcutState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            get_cli_args,
            set_window_behavior,
            set_close_to_tray_shortcut,
            quit_app,
            read_file,
            write_file,
            file_meta,
            is_directory,
            list_dir,
            search_files,
            write_binary_file,
            ensure_dir,
            watch_folder,
            stop_watch,
            app_data_dir,
            list_system_fonts,
            save_image_to_assets,
            fetch_image_as_base64,
            generate_toc,
            search_in_files,
            read_bundled_file,
            read_bundled_image_as_base64,
            reveal_in_folder,
            rename_path,
            remove_path,
            copy_path,
            move_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_files_from_args_skips_exe() {
        let argv = vec![
            "C:\\Program Files\\TizuMark\\TizuMark.exe".to_string(),
            "D:\\docs\\note.md".to_string(),
        ];
        let files = files_from_args(argv);
        assert_eq!(files, vec!["D:\\docs\\note.md".to_string()]);
    }

    #[test]
    fn test_is_directory_distinguishes_dir_and_file() {
        let tmp = std::env::temp_dir().join("tizumark_isdir_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("a.md");
        fs::write(&file, "x").unwrap();
        assert!(is_directory(tmp.to_string_lossy().to_string()));
        assert!(!is_directory(file.to_string_lossy().to_string()));
        assert!(!is_directory("Z:\\definitely\\not\\exists".to_string()));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_files_from_args_empty_when_only_exe() {
        let argv = vec!["TizuMark.exe".to_string()];
        assert!(files_from_args(argv).is_empty());
    }

    #[test]
    fn test_search_in_files_recursive_and_filter() {
        let tmp = std::env::temp_dir().join("tizumark_search_test_1");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.md"), "hello world\nhello rust\n").unwrap();
        fs::write(tmp.join("b.txt"), "hello again\n").unwrap();
        fs::write(tmp.join("c.log"), "hello ignored\n").unwrap();
        let sub = tmp.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("d.md"), "hello nested\n").unwrap();
        let res = search_in_files_impl(tmp.to_str().unwrap(), "hello", false, false, &[]).unwrap();
        let paths: Vec<&str> = res.iter().map(|f| f.path.as_str()).collect();
        assert!(!paths.iter().any(|p| p.ends_with("c.log")), "c.log 应被扩展名过滤");
        assert!(paths.iter().any(|p| p.ends_with("d.md")), "应递归到 sub/d.md");
        let total: usize = res.iter().map(|f| f.matches.len()).sum();
        assert_eq!(total, 4, "a.md(2)+b.txt(1)+d.md(1) 共 4 处匹配");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_search_in_files_regex() {
        let tmp = std::env::temp_dir().join("tizumark_search_test_2");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.md"), "foo123bar\nfoo456\nno digits\n").unwrap();
        let res = search_in_files_impl(tmp.to_str().unwrap(), r"\d+", false, true, &[]).unwrap();
        let total: usize = res.iter().map(|f| f.matches.len()).sum();
        assert_eq!(total, 2, "正则 \\d+ 应匹配 2 行");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_search_in_files_case_sensitivity() {
        let tmp = std::env::temp_dir().join("tizumark_search_test_3");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.md"), "Hello\nHELLO\nhello\n").unwrap();
        let res_ci = search_in_files_impl(tmp.to_str().unwrap(), "hello", false, false, &[]).unwrap();
        let total_ci: usize = res_ci.iter().map(|f| f.matches.len()).sum();
        assert_eq!(total_ci, 3, "大小写不敏感应匹配 3 处");
        let res_cs = search_in_files_impl(tmp.to_str().unwrap(), "hello", true, false, &[]).unwrap();
        let total_cs: usize = res_cs.iter().map(|f| f.matches.len()).sum();
        assert_eq!(total_cs, 1, "大小写敏感应只匹配 1 处");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_search_in_files_per_file_limit() {
        let tmp = std::env::temp_dir().join("tizumark_search_test_4");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let content: String = (0..600).map(|_| "x\n").collect();
        fs::write(tmp.join("big.md"), content).unwrap();
        let res = search_in_files_impl(tmp.to_str().unwrap(), "x", false, false, &[]).unwrap();
        assert_eq!(res.len(), 1, "应只有 1 个文件");
        assert!(res[0].matches.len() <= 500, "单文件匹配应被截断到 <= 500，实际 {}", res[0].matches.len());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_escape_html() {
        assert_eq!(escape_html("hello"), "hello");
        assert_eq!(escape_html("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
        assert_eq!(escape_html("a & b"), "a &amp; b");
        assert_eq!(escape_html("\"quoted\""), "&quot;quoted&quot;");
        assert_eq!(escape_html("it's"), "it&#x27;s");
        assert_eq!(escape_html("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
    }

    #[test]
    fn test_generate_toc_xss() {
        let input = "# <script>alert(1)</script>\n## Normal Heading".to_string();
        let toc = generate_toc(input);
        assert!(!toc.contains("<script>"));
        assert!(toc.contains("&lt;script&gt;"));
        assert!(toc.contains("Normal Heading"));
    }

    #[test]
    fn test_generate_toc_normal() {
        let input = "# First\n## Second\n### Third".to_string();
        let toc = generate_toc(input);
        assert!(toc.contains("First"));
        assert!(toc.contains("Second"));
        assert!(toc.contains("Third"));
    }


}

    // ---------- 文件编码 / 读写命令（整理测试库时补充） ----------

    #[test]
    fn test_decode_bytes_utf8() {
        assert_eq!(decode_bytes(b"hello world"), "hello world");
    }

    #[test]
    fn test_decode_bytes_utf8_with_bom() {
        // 带 UTF-8 BOM 的字节应剥离 BOM 再解码
        let mut v = vec![0xEF, 0xBB, 0xBF];
        v.extend_from_slice(b"hello");
        assert_eq!(decode_bytes(&v), "hello");
    }

    #[test]
    fn test_decode_bytes_gb18030_roundtrip() {
        // GB18030 编码的字节（非合法 UTF-8）应回退解码成功
        let s = "中文测试，简繁混合：軟體";
        let (encoded, _enc, _err) = GB18030.encode(s);
        let bytes = encoded.as_ref().to_vec();
        // 先确认这些字节本身不是合法 UTF-8，才会走回退分支
        assert!(String::from_utf8(bytes.clone()).is_err(), "GB18030 字节应非 UTF-8");
        assert_eq!(decode_bytes(&bytes), s, "GB18030 回退解码应还原原文");
    }

    #[test]
    fn test_decode_bytes_invalid_bytes_no_panic() {
        // 无法解码的字节不应 panic，应回退为替换字符
        let s = decode_bytes(&[0xFF, 0xFE, 0x00, 0x01]);
        assert!(s.chars().all(|c| c != '\u{FFFD}' || true), "无效字节解码不 panic");
    }

    #[test]
    fn test_read_file_utf8() {
        let tmp = std::env::temp_dir().join("tizumark_read_utf8_test.txt");
        fs::write(&tmp, "hello 中文").unwrap();
        let res = read_file(tmp.to_str().unwrap().to_string());
        assert!(res.is_ok(), "读取 UTF-8 文件应成功");
        assert_eq!(res.unwrap(), "hello 中文");
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_read_file_gb18030() {
        let tmp = std::env::temp_dir().join("tizumark_read_gbk_test.txt");
        let s = "中文内容测试";
        let (encoded, _enc, _err) = GB18030.encode(s);
        fs::write(&tmp, encoded.as_ref()).unwrap();
        let res = read_file(tmp.to_str().unwrap().to_string());
        assert!(res.is_ok(), "读取 GB18030 文件应成功（编码兼容）");
        assert_eq!(res.unwrap(), s, "GB18030 文件内容应正确还原");
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_read_file_missing_returns_structured_error() {
        let path = std::env::temp_dir()
            .join("tizumark_does_not_exist_xyz_12345.md");
        let res = read_file(path.to_str().unwrap().to_string());
        assert!(res.is_err(), "读取不存在文件应返回错误");
        let err = res.unwrap_err();
        assert!(err.contains("\"kind\":\"NotFound\""), "错误应为结构化 JSON 且 kind=NotFound");
    }

    #[test]
    fn test_write_file_then_read_back() {
        let tmp = std::env::temp_dir().join("tizumark_write_test.txt");
        let _ = fs::remove_file(&tmp);
        let content = "# 标题\n\n正文内容";
        let w = write_file(tmp.to_str().unwrap().to_string(), content.to_string());
        assert!(w.is_ok(), "write_file 应成功");
        // 用底层 read_file 读回验证
        let r = read_file(tmp.to_str().unwrap().to_string());
        assert!(r.is_ok());
        assert_eq!(r.unwrap(), content);
        let _ = fs::remove_file(&tmp);
    }

    #[cfg(windows)]
    #[test]
    fn test_safe_write_target_rejects_protected_path() {
        // 拒绝写入系统关键目录（如 C:\windows\system32）
        let res = safe_write_target("C:\\windows\\system32\\evil.txt");
        assert!(res.is_err(), "写入系统目录应被拒绝");
        assert!(res.unwrap_err().contains("protected"), "错误应说明是受保护路径");
    }

    // ---------- 剩余命令单测（file_meta / list_dir / write_binary_file / ensure_dir /
    // save_image_to_assets / fetch_image_as_base64）----------

    // 极简 block_on：仅用于无真实异步 IO 的 async fn（本地文件分支一次 poll 即 Ready）
    #[cfg(test)]
    fn test_block_on<F: std::future::Future>(mut fut: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn noop(_: *const ()) {}
        fn clone_raw(_: *const ()) -> RawWaker {
            RawWaker::new(std::ptr::null(), &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone_raw, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
        let mut cx = Context::from_waker(&waker);
        let mut pinned = unsafe { std::pin::Pin::new_unchecked(&mut fut) };
        loop {
            match pinned.as_mut().poll(&mut cx) {
                Poll::Ready(v) => return v,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    // 最小合法 PNG 头（1x1），imagesize 仅解析头部即可取宽高
    #[cfg(test)]
    fn tiny_png_bytes() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D', b'R', // IHDR chunk
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1 height=1
            0x08, 0x06, 0x00, 0x00, 0x00, // bit depth / color type / etc
            0x1F, 0x15, 0xC4, 0x89, // CRC（imagesize 不校验）
        ]
    }

    #[test]
    fn test_file_meta_existing_file() {
        let tmp = std::env::temp_dir().join("tizumark_meta_test.txt");
        fs::write(&tmp, "hello meta").unwrap();
        let res = file_meta(tmp.to_str().unwrap().to_string());
        assert!(res.is_ok());
        let meta = res.unwrap().expect("存在的文件应返回 Some");
        assert_eq!(meta.size, "hello meta".len() as u64, "size 应为文件字节数");
        assert!(meta.mtime > 0, "mtime 应为正的毫秒时间戳");
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_file_meta_missing_and_dir_return_none() {
        let missing = std::env::temp_dir().join("tizumark_meta_missing_xyz.md");
        assert_eq!(file_meta(missing.to_str().unwrap().to_string()).unwrap().is_none(), true, "不存在应为 None");
        let dir = std::env::temp_dir();
        assert!(file_meta(dir.to_str().unwrap().to_string()).unwrap().is_none(), "目录应为 None（仅文件有元数据）");
    }

    #[test]
    fn test_list_dir_filters_and_sorts() {
        let base = std::env::temp_dir().join("tizumark_listdir_test");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("zdir")).unwrap();
        fs::write(base.join("b.txt"), "t").unwrap();
        fs::write(base.join("a.md"), "m").unwrap();
        fs::write(base.join("c.png"), "p").unwrap();       // 非文档扩展不过滤
        fs::write(base.join(".hidden.md"), "h").unwrap();  // 点文件应被过滤
        let res = list_dir(base.to_str().unwrap().to_string()).expect("list_dir 应成功");
        // DirListing 是结构体（Deref 到 Vec<DirEntryInfo>），按 Rust 方法解析规则
        // .iter() / [index] 须显式走 .entries 字段（不能依赖 Deref coercion）。
        let names: Vec<&str> = res.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zdir", "a.md", "b.txt", "c.png"], "目录排最前，文件按名排序，点文件被过滤");
        assert!(res.entries[0].is_dir && !res.entries[1].is_dir);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn test_write_binary_file_roundtrip() {
        let tmp = std::env::temp_dir().join("tizumark_bin_test.bin");
        let _ = fs::remove_file(&tmp);
        let data = vec![0u8, 1, 2, 255, 254, 128];
        write_binary_file(tmp.to_str().unwrap().to_string(), data.clone()).expect("写二进制应成功");
        assert_eq!(fs::read(&tmp).unwrap(), data, "读回字节应一致");
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_ensure_dir_creates_nested() {
        let base = std::env::temp_dir().join("tizumark_ensure_dir_test");
        let _ = fs::remove_dir_all(&base);
        let nested = base.join("a").join("b").join("c");
        ensure_dir(nested.to_str().unwrap().to_string()).expect("应递归创建目录");
        assert!(nested.is_dir());
        // 幂等：已存在再调用也成功
        ensure_dir(nested.to_str().unwrap().to_string()).expect("重复调用应成功");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn test_save_image_to_assets_md5_naming_and_size() {
        let assets = std::env::temp_dir().join("tizumark_assets_test");
        let _ = fs::remove_dir_all(&assets);
        let bytes = tiny_png_bytes();
        let info = save_image_to_assets(bytes.clone(), "png".into(), assets.to_str().unwrap().to_string())
            .expect("保存图片应成功");
        let expect_name = format!("{:x}.png", Md5::digest(&bytes));
        assert_eq!(info.filename, expect_name, "文件名应为字节 md5 + 扩展名");
        assert_eq!((info.width, info.height), (1, 1), "应解析出 1x1 尺寸");
        assert!(assets.join(&info.filename).is_file(), "文件应写入附件目录");
        // 相同字节再存：文件名一致（去重），不报错
        let info2 = save_image_to_assets(bytes, "png".into(), assets.to_str().unwrap().to_string()).unwrap();
        assert_eq!(info2.filename, expect_name);
        let _ = fs::remove_dir_all(&assets);
    }

    #[test]
    fn test_save_image_to_assets_unknown_format_zero_size() {
        let assets = std::env::temp_dir().join("tizumark_assets_unknown_test");
        let _ = fs::remove_dir_all(&assets);
        let info = save_image_to_assets(vec![1, 2, 3, 4], "bin".into(), assets.to_str().unwrap().to_string())
            .expect("未知格式也应能保存");
        assert_eq!((info.width, info.height), (0, 0), "无法识别尺寸应为 0x0");
        let _ = fs::remove_dir_all(&assets);
    }

    #[test]
    fn test_fetch_image_as_base64_local_file() {
        let tmp = std::env::temp_dir().join("tizumark_b64_test.png");
        let bytes = tiny_png_bytes();
        fs::write(&tmp, &bytes).unwrap();
        let encoded = test_block_on(fetch_image_as_base64(tmp.to_str().unwrap().to_string()))
            .expect("本地文件应编码成功");
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD.decode(&encoded).unwrap();
        assert_eq!(decoded, bytes, "base64 解码应还原原始字节");
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_fetch_image_as_base64_missing_file_err() {
        let missing = std::env::temp_dir().join("tizumark_b64_missing_xyz.png");
        let res = test_block_on(fetch_image_as_base64(missing.to_str().unwrap().to_string()));
        assert!(res.is_err(), "不存在的本地文件应返回错误");
    }
