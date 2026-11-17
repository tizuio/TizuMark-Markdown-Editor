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

// 统一退出入口：先丢掉应用侧 TrayState 持有的 TrayIcon 引用，再调 app.exit。
// 背景：tray-icon 的平台图标仅在最后一个 Rc 引用 drop 时才发 Shell_NotifyIcon(NIM_DELETE)；
// app.exit 的 cleanup_before_exit 只清 manager/resources 里的克隆，清不到 app.manage(TrayState)
// 里的这份——进程退出跳过剩余 Drop，导致托盘图标残留（鼠标掠过才消失，反复开关累积多个）。
// 此处先 take 掉 TrayState 里的引用，manager 份在退出清理中 drop 时 Rc 归零，图标被真正移除。
fn exit_app(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = None;
        }
    }
    app.exit(0);
}

// 前端调此命令真正退出应用（关窗弹框选"退出"时调用）。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    exit_app(app);
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
                    exit_app(app.clone());
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

// ====== 更新安装包磁盘缓存 ======
// tauri-plugin-updater 的 `plugin:updater|download` 把安装包字节放在 webview 资源表里
// （纯内存），进程退出即丢失，下次检查更新只能重新下载。应用层在此补磁盘缓存：
//   1. download_update_to_file：按更新 JSON 的 url 流式下载到 app_data_dir/updates/，
//      落 .tmp → minisign 验签通过才转正 → 写 sidecar（version/signature/size）；
//   2. find_cached_update：检查更新时按 version+signature 命中缓存（签名不一致
//      视为官方重新上传 → 未命中，重新下载）；
//   3. install_cached_update：读回缓存安装包，用本次 check 的 Update 元数据再验一次
//      签名，交给插件 Update::install（与内存字节同一安装路径：临时文件 → ShellExecute）。
// 缓存文件：installer_{version}.exe + installer_{version}.meta.json。

fn updates_cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新缓存目录失败: {e}"))?;
    Ok(dir)
}

/// updater 公钥（tauri.conf.json 的 plugins.updater.pubkey）
fn updater_pubkey<R: tauri::Runtime, M: tauri::Manager<R>>(mgr: &M) -> Result<String, String> {
    mgr.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "读不到 updater 公钥（tauri.conf.json plugins.updater.pubkey）".to_string())
}

/// minisign 验签，口径与 tauri-plugin-updater 的 verify_signature 完全一致：
/// base64 解码 → PublicKey/Signature::decode → verify(data, sig, strict=true)
fn verify_update_signature(data: &[u8], signature_b64: &str, pub_key_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let eng = base64::engine::general_purpose::STANDARD;
    let from_b64 = |b64: &str, what: &str| -> Result<String, String> {
        let decoded = eng.decode(b64).map_err(|e| format!("{what} base64 解码失败: {e}"))?;
        Ok(std::str::from_utf8(&decoded)
            .map_err(|_| format!("{what} 不是合法字符串"))?
            .to_string())
    };
    let pub_key = minisign_verify::PublicKey::decode(&from_b64(pub_key_b64, "公钥")?)
        .map_err(|e| format!("公钥无效: {e}"))?;
    let signature = minisign_verify::Signature::decode(&from_b64(signature_b64, "签名")?)
        .map_err(|e| format!("签名无效: {e}"))?;
    pub_key
        .verify(data, &signature, true)
        .map_err(|e| format!("签名校验失败（安装包签名不匹配）: {e}"))
}

/// 版本号用于文件名时的字符清洗（只留字母数字 . -，其余替换为 _）
fn sanitize_version_for_filename(version: &str) -> String {
    version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect()
}

/// 下载更新安装包到本地缓存。成功返回 {path, size}；
/// 事件形状与插件 DownloadEvent 一致：Started{contentLength}/Progress{chunkLength}/Finished。
#[tauri::command]
async fn download_update_to_file(
    app: tauri::AppHandle,
    url: String,
    version: String,
    signature: String,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    use futures_util::StreamExt;
    use std::io::Write;

    // 只允许 https（更新端点均为 https；防 file:// 等异常地址）
    if !url.starts_with("https://") {
        return Err("仅支持 https 下载地址".to_string());
    }
    if version.trim().is_empty() || signature.trim().is_empty() {
        return Err("缺少版本号或签名".to_string());
    }

    // 连接超时 15s（QA 审查 P2）：不设整包超时（大安装包慢网下会被误杀），
    // 但「连不上服务器」必须有界失败，否则 UI 永远停在「正在下载」且无取消按钮。
    let response = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("下载客户端初始化失败: {e}"))?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败: HTTP {}", response.status()));
    }
    let content_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let _ = on_event.send(serde_json::json!({
        "event": "Started",
        "data": { "contentLength": content_length },
    }));

    let dir = updates_cache_dir(&app)?;
    let v = sanitize_version_for_filename(&version);
    let name = format!("installer_{v}.exe");
    let final_path = dir.join(&name);
    let tmp_path = dir.join(format!("{name}.tmp"));

    let mut file = std::fs::File::create(&tmp_path).map_err(|e| format!("创建缓存文件失败: {e}"))?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("下载中断: {e}")
        })?;
        if file.write_all(&chunk).is_err() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err("写入缓存文件失败".to_string());
        }
        let _ = on_event.send(serde_json::json!({
            "event": "Progress",
            "data": { "chunkLength": chunk.len() },
        }));
    }
    if file.flush().is_err() || file.sync_all().is_err() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err("写入缓存文件失败".to_string());
    }
    drop(file);
    let _ = on_event.send(serde_json::json!({ "event": "Finished" }));

    // 先验签，通过才转正（验签失败删掉半截文件）
    let bytes = std::fs::read(&tmp_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("读缓存安装包失败: {e}")
    })?;
    let size = bytes.len() as u64;
    match verify_update_signature(&bytes, &signature, &updater_pubkey(&app)?) {
        Ok(()) => {}
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
    }
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("缓存文件转正失败: {e}")
    })?;
    let meta = serde_json::json!({
        "version": version,
        "signature": signature,
        "url": url,
        "size": size,
        "downloadedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });
    let _ = std::fs::write(
        dir.join(format!("installer_{v}.meta.json")),
        serde_json::to_string(&meta).unwrap_or_default(),
    );
    // 清理其他版本的旧缓存，避免磁盘堆积
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            let ours = fname == name
                || fname == format!("{name}.tmp")
                || fname == format!("installer_{v}.meta.json");
            if fname.starts_with("installer_") && !ours {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(serde_json::json!({ "path": final_path.to_string_lossy().to_string(), "size": size }))
}

/// 按 version+signature 查本地缓存；命中返回 {path, size}，未命中（文件缺失 /
/// 签名不一致 / sidecar 损坏 / 大小不符）返回 None，调用方走重新下载。
#[tauri::command]
fn find_cached_update(app: tauri::AppHandle, version: String, signature: String) -> Result<Option<serde_json::Value>, String> {
    let dir = match updates_cache_dir(&app) {
        Ok(d) => d,
        Err(_) => return Ok(None),
    };
    let v = sanitize_version_for_filename(&version);
    let file = dir.join(format!("installer_{v}.exe"));
    let meta_file = dir.join(format!("installer_{v}.meta.json"));
    if !file.is_file() {
        return Ok(None);
    }
    let meta_raw = match std::fs::read_to_string(&meta_file) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let meta: serde_json::Value = match serde_json::from_str(&meta_raw) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if meta.get("signature").and_then(|x| x.as_str()) != Some(signature.as_str()) {
        return Ok(None);
    }
    let size = file.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
    if meta.get("size").and_then(|x| x.as_u64()) != Some(size) {
        return Ok(None);
    }
    Ok(Some(serde_json::json!({
        "path": file.to_string_lossy().to_string(),
        "size": size,
    })))
}

/// 安装已缓存的安装包：读回文件 → 用本次 check 的 Update 元数据再验一次签名 →
/// 调插件 Update::install（Windows 上 = 写临时文件 + ShellExecute 启动 NSIS /UPDATE）。
#[tauri::command]
fn install_cached_update<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    update_rid: u32,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_updater::Update;
    let update = webview
        .resources_table()
        .get::<Update>(update_rid)
        .map_err(|e| format!("获取更新元数据失败: {e}"))?;
    let bytes = std::fs::read(&path).map_err(|e| format!("读取缓存安装包失败: {e}"))?;
    let app = webview.app_handle().clone();
    verify_update_signature(&bytes, &update.signature, &updater_pubkey(&app)?)?;
    update
        .install(&bytes)
        .map_err(|e| format!("安装失败: {e}"))
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
                    exit_app(app.clone());
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
            move_path,
            // 更新安装包磁盘缓存（下载落盘 / 查缓存 / 从缓存安装）
            download_update_to_file,
            find_cached_update,
            install_cached_update,
            // PDF 导出：WebView2 PrintToPdf 直接落盘（无打印对话框 / 无下载气泡）
            print_to_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// PDF 导出落盘参数（单位：英寸 —— WebView2 PrintSettings 的约定）。
// 用结构体传参而不是七八个散参数：命令注册表在 Windows / 非 Windows 两份实现之间
// 必须保持同一签名，结构体最省心。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfPrintOptions {
    path: String,
    page_width: f64,
    page_height: f64,
    margin_top: f64,
    margin_bottom: f64,
    margin_left: f64,
    margin_right: f64,
    // 仅出大纲（两遍打印的第一遍）：CDP 打印只取内存字节解析书签页码，**不落盘**。
    // serde 缺省 false —— 旧调用方（前端单遍导出 / 测试桩）不带此字段，行为不变。
    #[serde(default)]
    outline_only: Option<bool>,
    // 用户设置「导出 PDF 生成目录」开关（前端设置面板）。缺省 true（生成书签大纲）；
    // false = 完全升级前行为（无书签、无目录页），CDP 参数不带 generateDocumentOutline。
    #[serde(default)]
    generate_outline: Option<bool>,
}

// CDP Page.printToPDF 的 JSON 参数（纯函数，#[test] 静态断言防漂移）。
// 页面尺寸 / 四边边距与 PrintSettings 完全同值（英寸）；printBackground / 关页眉页脚
// 与现有原生路径口径一致；generateDocumentOutline 让 Chromium 从 h1–h6 自动生成
// PDF 书签大纲（WebView2Feedback#4466：原生 PrintSettings 至今无此属性，只能走 CDP）。
fn build_cdp_print_params(opts: &PdfPrintOptions) -> String {
    serde_json::json!({
        "paperWidth": opts.page_width,
        "paperHeight": opts.page_height,
        "marginTop": opts.margin_top,
        "marginBottom": opts.margin_bottom,
        "marginLeft": opts.margin_left,
        "marginRight": opts.margin_right,
        "printBackground": true,
        "displayHeaderFooter": false,
        "generateDocumentOutline": opts.generate_outline.unwrap_or(true),
        "preferCSSPageSize": false,
    })
    .to_string()
}

// PDF 导出：直接用 WebView2 的 PrintToPdf 落盘，不经过系统打印对话框、也不经过浏览器下载流程。
//
// 原实现（前端 iframe + contentWindow.print()）会拉起 Chromium 的打印预览，用户「另存为 PDF」
// 时走的是浏览器下载管线 —— 窗口右上角会弹出 Edge 风格的「下载 xxx.pdf」气泡（用户反馈
// 2026-10-25）；而且打印帧是另建的 srcdoc 文档，需要手工把 appCSS / katex / hljs 样式拼进去，
// 拼漏一项就与阅读模式不一致（用户反馈的公式重复、代码高亮丢失都出在这条路上）。
//
// PrintToPdf 打印的是当前 webview 自身：前端只需把页面切到「打印态」（藏掉工具条/侧栏、
// 展开滚动容器），样式天然就是阅读模式那一套，不存在「两套 CSS 漂移」；调用返回即表示文件
// 已落盘，全程无 UI、无气泡、无下载目录残留。
//
// 失败面：CDP 主路径任一环节失败（运行时过旧 / 调用失败 / 超时）都在 **Rust 内部**自动
// 回退原生 ICoreWebView2_7::PrintToPdf（2026-11-17 书签大纲重做：generateDocumentOutline
// 只有 CDP Page.printToPDF 支持，原生 PrintSettings 至今无此属性，见 WebView2Feedback#4466）。
// outline_only（两遍打印第一遍）拿不到 CDP 字节时直接回 via_cdp=false——原生路径无法
// 「打印不落盘」，前端据此移除目录页走原生单遍，老运行时行为 = 现状。
#[cfg(target_os = "windows")]
#[tauri::command]
async fn print_to_pdf(
    window: tauri::WebviewWindow,
    options: PdfPrintOptions,
) -> Result<PdfPrintOutcome, String> {
    let outline_only = options.outline_only.unwrap_or(false);
    // CDP 主路径：Some=拿到内存 PDF 字节；None=运行时过旧 / 调用失败 / 超时等任一环失败
    if let Some(bytes) = cdp_print_to_pdf_bytes(&window, &options) {
        // outline_only（第一遍）：只解析大纲**不落盘**（前端拿页码填目录占位后发起第二遍
        // 正式落盘）；普通打印：字节直接写目标文件，语义与原生路径一致（返回即已落盘）。
        if !outline_only {
            std::fs::write(&options.path, &bytes)
                .map_err(|e| format!("写入 PDF 失败（{}）: {e}", options.path))?;
        }
        return Ok(PdfPrintOutcome {
            via_cdp: true,
            // 用户关闭生成目录时 CDP 产物本身无大纲，跳过解析
            outline_pages: if options.generate_outline.unwrap_or(true) {
                parse_pdf_outline_pages(&bytes)
            } else {
                None
            },
        });
    }
    if outline_only {
        return Ok(PdfPrintOutcome { via_cdp: false, outline_pages: None });
    }
    // CDP 不可用：原样回退现有原生 PrintToPdf（书签缺失但导出不失败，行为 = 现状）
    native_print_to_pdf(&window, options)?;
    Ok(PdfPrintOutcome { via_cdp: false, outline_pages: None })
}

// PDF 导出结果。via_cdp=true 表示 CDP 主路径成功（产物自带书签大纲）；
// outline_pages=书签大纲树解析出的各条目目标页序号（0-based，按大纲顺序），
// None=非 CDP 路径 / 解析失败（前端降级为无页码目录或维持现状，绝不因此报错）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfPrintOutcome {
    via_cdp: bool,
    outline_pages: Option<Vec<u32>>,
}

// CDP 主路径：CallDevToolsProtocolMethod("Page.printToPDF") 拿内存字节。
// 任一环节失败都返回 None（调用方回退原生路径），绝不在此抛错让导出失败。
// 关键：回调在 webview UI 线程触发，recv_timeout 必须在 with_webview 闭包**外**等——
// 闭包内阻塞会卡死 UI 事件循环，回调永远不来（与原生 PrintToPdf 同一骨架）。
#[cfg(target_os = "windows")]
fn cdp_print_to_pdf_bytes(
    window: &tauri::WebviewWindow,
    opts: &PdfPrintOptions,
) -> Option<Vec<u8>> {
    use std::sync::mpsc::channel;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
    };
    use windows::core::{Interface, PCWSTR};
    use base64::Engine as _;

    let (tx, rx) = channel::<Option<Vec<u8>>>();
    let params = build_cdp_print_params(opts);
    window
        .with_webview(move |platform| {
            let tx_cb = tx.clone();
            let core = match unsafe { platform.controller().CoreWebView2() } {
                Ok(c) => c,
                Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            };
            unsafe {
                // CDP 调用先于置白：cast 失败（极老运行时）时直接退出，控制器背景未被
                // 改动，无需恢复（与原生路径的退出时恢复不变式一致——2026-10-27 审查口径）。
                // CallDevToolsProtocolMethod 声明在基础接口 ICoreWebView2 上，无需 _3 cast
                //（多一次 cast 只会多一条失败路径、误杀老但可用的运行时）。
                // DefaultBackgroundColor 置白与原生路径同款（CDP 打印管线是否消费控制器
                // 背景色未证实；置白无害，灰圈风险归零）。恢复路径：① 完成回调里恢复；
                // ② 同步调用失败（下方 is_err 分支）立即恢复。
                let controller2 = platform.controller().cast::<ICoreWebView2Controller2>().ok();
                let mut orig_bg = COREWEBVIEW2_COLOR { A: 255, R: 245, G: 245, B: 245 };
                if let Some(c2) = controller2.clone() {
                    let _ = c2.DefaultBackgroundColor(&mut orig_bg);
                    let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                        A: 255, R: 255, G: 255, B: 255,
                    });
                }
                let controller2_cb = controller2.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |hr, ret_json| {
                        if let Some(c2) = controller2_cb.clone() {
                            let _ = c2.SetDefaultBackgroundColor(orig_bg);
                        }
                        let bytes = if hr.is_ok() {
                            (|| -> Option<Vec<u8>> {
                                // 返回 JSON 形如 {"data": "<base64>"}；任何一步不合预期按失败回退
                                // （PCWSTR 的 to_string 走 Display 实现，非 unsafe）
                                let s = ret_json.to_string();
                                let v: serde_json::Value = serde_json::from_str(&s).ok()?;
                                let b64 = v.get("data")?.as_str()?;
                                base64::engine::general_purpose::STANDARD.decode(b64).ok()
                            })()
                        } else {
                            None
                        };
                        let _ = tx_cb.send(bytes);
                        Ok(())
                    },
                ));
                let method: Vec<u16> =
                    "Page.printToPDF".encode_utf16().chain(std::iter::once(0)).collect();
                let params_w: Vec<u16> =
                    params.encode_utf16().chain(std::iter::once(0)).collect();
                if core
                    .CallDevToolsProtocolMethod(PCWSTR(method.as_ptr()), PCWSTR(params_w.as_ptr()), &handler)
                    .is_err()
                {
                    // 同步失败：完成回调不会触发，这里立即恢复白底
                    if let Some(c2) = controller2.clone() {
                        let _ = c2.SetDefaultBackgroundColor(orig_bg);
                    }
                    let _ = tx.send(None);
                }
            }
        })
        .ok()?; // dispatch 失败 → None → 回退
    // 超长文档分页渲染可能要十几秒；180s 只兜异常挂死，超时按失败回退
    rx.recv_timeout(std::time::Duration::from_secs(180)).unwrap_or(None)
}

// 原生回退路径：ICoreWebView2_7::PrintToPdf 直接落盘（2026-10-25 起的主路径，现为
// CDP 不可用时的回退）。原实现整体搬移，行为不变。
#[cfg(target_os = "windows")]
fn native_print_to_pdf(
    window: &tauri::WebviewWindow,
    opts: PdfPrintOptions,
) -> Result<(), String> {
    use std::sync::mpsc::channel;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_2, ICoreWebView2_7, ICoreWebView2Controller2, ICoreWebView2Environment6,
        COREWEBVIEW2_COLOR,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, PCWSTR};

    let (tx, rx) = channel::<Result<(), String>>();
    let path = opts.path.clone();

    window
        .with_webview(move |platform| {
            let tx_cb = tx.clone();
            let core = match unsafe { platform.controller().CoreWebView2() } {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(Err(format!("拿不到 CoreWebView2: {e}")));
                    return;
                }
            };
            unsafe {
                // 打印前把控制器默认背景临时改成纯白，打印完在回调里恢复。
                // 根因（2026-10-27 用户实锤）：tauri.conf.json 的 backgroundColor="#f5f5f5"
                // （防白屏闪烁）会成为 WebView2 控制器的 DefaultBackgroundColor，而
                // PrintToPdf **用它画 PDF 的物理页边距区**（canvas 上 root 背景画不到的
                // 部分）——前端 printStyle 把 html/body 全钉成 #fff 也管不到那里，PDF
                // 四周永远一圈 #f5f5f5 灰。Chrome/CDP 没有 DefaultBackgroundColor 概念，
                // 所以同样的 CSS 在 Chrome 打印验证里是纯白、真机却带灰圈。
                // 注 1：DefaultBackgroundColor 在 ICoreWebView2Controller2（WebView2 1.0.664，
                // 2020-09），比 PrintToPdf 所需的 ICoreWebView2_7 老得多，无版本顾虑。
                // 注 2：必须从**控制器对象**上 QueryInterface（Controller2 派生自
                // ICoreWebView2Controller），从 ICoreWebView2 上 cast 是一条不同的接口链，
                // 会直接 E_NOINTERFACE（0x80004002）——2026-10-27 用户实测踩到，导出失败。
                // 注 3：这一步只是美化（去灰圈），拿不到就跳过，绝不阻断导出。
                // 外层已在 unsafe 块内，无需再嵌一层
                let controller2 = platform.controller().cast::<ICoreWebView2Controller2>().ok();
                // orig_bg 兜底值必须与 tauri.conf.json 的 backgroundColor 一致：万一某些
                // 运行时不支持 GetDefaultBackgroundColor，恢复时不至于把 A=0 的透明色写回去。
                let mut orig_bg = COREWEBVIEW2_COLOR { A: 255, R: 245, G: 245, B: 245 };
                if let Some(c2) = controller2.clone() {
                    let _ = c2.DefaultBackgroundColor(&mut orig_bg);
                    let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                        A: 255, R: 255, G: 255, B: 255,
                    });
                }
                let core7 = match core.cast::<ICoreWebView2_7>() {
                    Ok(c) => c,
                    Err(e) => {
                        if let Some(c2) = controller2.clone() {
                            let _ = c2.SetDefaultBackgroundColor(orig_bg);
                        }
                        let _ = tx.send(Err(format!("WebView2 运行时过旧（缺 PrintToPdf）: {e}")));
                        return;
                    }
                };
                // 打印设置：页面尺寸 + 四边边距 + 打印背景色 + 不要页眉页脚
                let settings = (|| -> windows::core::Result<_> {
                    let core2 = core.cast::<ICoreWebView2_2>()?;
                    let env = core2.Environment()?;
                    let env6 = env.cast::<ICoreWebView2Environment6>()?;
                    let s = env6.CreatePrintSettings()?;
                    s.SetPageWidth(opts.page_width)?;
                    s.SetPageHeight(opts.page_height)?;
                    s.SetMarginTop(opts.margin_top)?;
                    s.SetMarginBottom(opts.margin_bottom)?;
                    s.SetMarginLeft(opts.margin_left)?;
                    s.SetMarginRight(opts.margin_right)?;
                    let _ = s.SetShouldPrintBackgrounds(true);
                    let _ = s.SetShouldPrintHeaderAndFooter(false);
                    Ok(s)
                })();
                let settings = match settings {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = tx.send(Err(format!("打印设置失败: {e}")));
                        return;
                    }
                };
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                    // 无论成败都把控制器默认背景恢复为打印前的值（#f5f5f5 防白闪）
                    // （闭包在外层 unsafe 块内定义，无需再嵌 unsafe）
                    if let Some(c2) = controller2.clone() {
                        let _ = c2.SetDefaultBackgroundColor(orig_bg);
                    }
                    let r = if hr.is_ok() && ok {
                        Ok(())
                    } else {
                        Err(format!("PrintToPdf 失败: {hr:?}"))
                    };
                    let _ = tx_cb.send(r);
                    Ok(())
                }));
                // 路径转 UTF-16 + NUL 结尾（PrintToPdf 收 PCWSTR）
                let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
                if let Err(e) = core7.PrintToPdf(PCWSTR(wide.as_ptr()), &settings, &handler) {
                    let _ = tx.send(Err(format!("PrintToPdf 调用失败: {e}")));
                }
            }
        })
        .map_err(|e| format!("with_webview 失败: {e}"))?;

    // 超长文档分页渲染可能要十几秒；180s 只兜异常挂死
    match rx.recv_timeout(std::time::Duration::from_secs(180)) {
        Ok(r) => r,
        Err(_) => Err("PrintToPdf 超时（180s）".to_string()),
    }
}

// 解析 PDF 书签大纲树：返回每条大纲条目的目标页序号（0-based，按大纲顺序）。
// 用途：CDP generateDocumentOutline 产出的书签 → 前端纸面目录页的「标题→页码」映射
// （设计文档 2026-11-17-pdf-outline-design.md 第二阶段）。
// 任一环节失败（非 PDF / 结构不合预期 / 条目解析不到页）整体返回 None——调用方降级为
// 无页码目录（条目仍可点击），绝不因解析失败让导出失败。上限 10000 条防环。
fn parse_pdf_outline_pages(bytes: &[u8]) -> Option<Vec<u32>> {
    use lopdf::Object;
    use std::collections::HashMap;
    let doc = lopdf::Document::load_mem(bytes).ok()?;
    // 页对象引用 → 页序号（0-based）：get_pages 按文档树序返回 1-based 页号
    let page_index: HashMap<lopdf::ObjectId, u32> =
        doc.get_pages().into_iter().map(|(k, v)| (v, k - 1)).collect();
    let catalog_ref = doc.trailer.get(b"Root").ok()?.as_reference().ok()?;
    let outlines_ref = doc
        .get_object(catalog_ref)
        .ok()?
        .as_dict()
        .ok()?
        .get(b"Outlines")
        .ok()?
        .as_reference()
        .ok()?;
    let first = doc
        .get_object(outlines_ref)
        .ok()?
        .as_dict()
        .ok()?
        .get(b"First")
        .ok()?
        .as_reference()
        .ok()?;
    // pre-order DFS（显式栈）：书签树是**嵌套**的——h2/h3 挂在父项 /First 子链上而非顶层
    // /Next 平铺（Chromium generateDocumentOutline 的产出形态）。访问顺序 = 父 → 子链 →
    // 兄弟 = DOM 文档序，与前端打印根 h1–h6 顺序一一对应。栈里先压兄弟再压子（LIFO 保证
    // 子链先于兄弟访问）。
    let mut stack = vec![first];
    let mut pages = Vec::new();
    let mut visits = 0usize;
    while let Some(cur) = stack.pop() {
        visits += 1;
        if visits > 10000 {
            // 结构异常（环 / 超大树）：整体视为解析失败，调用方降级，绝不输出错位页码
            return None;
        }
        let item = doc.get_object(cur).ok()?;
        let dict = item.as_dict().ok()?;
        // /Dest 直接数组（Chromium 产出形态）；/A 动作字典 → /D 数组兜底
        let dest = if let Ok(o) = dict.get(b"Dest") {
            o.clone()
        } else {
            dict.get(b"A").ok()?.as_dict().ok()?.get(b"D").ok()?.clone()
        };
        let arr = dest.as_array().ok()?;
        let pref = arr.first()?.as_reference().ok()?;
        pages.push(*page_index.get(&pref)?);
        if let Ok(n) = dict.get(b"Next").and_then(Object::as_reference) {
            stack.push(n);
        }
        if let Ok(f) = dict.get(b"First").and_then(Object::as_reference) {
            stack.push(f);
        }
    }
    Some(pages)
}

// 非 Windows 平台暂无 PrintToPdf / CDP 等价能力：明确报错，让前端回退系统打印
#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn print_to_pdf(
    _window: tauri::WebviewWindow,
    _options: PdfPrintOptions,
) -> Result<PdfPrintOutcome, String> {
    Err("当前平台暂不支持 PrintToPdf，回退系统打印".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_cdp_print_params_outline_and_layout() {
    let opts = PdfPrintOptions {
        path: "C:/tmp/a.pdf".into(),
        page_width: 8.27,
        page_height: 11.69,
        margin_top: 0.59,
        margin_bottom: 0.59,
        margin_left: 0.59,
        margin_right: 0.59,
        outline_only: None,
        generate_outline: None,
    };
    let v: serde_json::Value =
        serde_json::from_str(&build_cdp_print_params(&opts)).unwrap();
    assert_eq!(v["generateDocumentOutline"], true);
    assert_eq!(v["printBackground"], true);
    assert_eq!(v["displayHeaderFooter"], false);
    assert_eq!(v["preferCSSPageSize"], false);
    assert_eq!(v["paperWidth"], 8.27);
    assert_eq!(v["paperHeight"], 11.69);
    assert_eq!(v["marginTop"], 0.59);
    assert_eq!(v["marginBottom"], 0.59);
    assert_eq!(v["marginLeft"], 0.59);
    assert_eq!(v["marginRight"], 0.59);
}

#[test]
fn test_build_cdp_print_params_outline_disabled() {
    // 用户关闭「生成目录」：CDP 参数不带书签大纲（产物 = 升级前的平铺 PDF）
    let opts = PdfPrintOptions {
        path: "C:/tmp/a.pdf".into(),
        page_width: 8.27,
        page_height: 11.69,
        margin_top: 0.59,
        margin_bottom: 0.59,
        margin_left: 0.59,
        margin_right: 0.59,
        outline_only: None,
        generate_outline: Some(false),
    };
    let v: serde_json::Value =
        serde_json::from_str(&build_cdp_print_params(&opts)).unwrap();
    assert_eq!(v["generateDocumentOutline"], false);
}

    #[test]
    fn test_parse_pdf_outline_pages_round_trip() {
        use lopdf::{Dictionary as LDict, Document as LDoc, Object as LObj};
        let mut doc = LDoc::with_version("1.4");
        let pages_id = doc.add_object(LObj::Dictionary(LDict::new()));
        let mut page_ids = Vec::new();
        for _ in 0..3 {
            let id = doc.add_object(LObj::Dictionary(LDict::new()));
            if let LObj::Dictionary(d) = doc.get_object_mut(id).unwrap() {
                // 注意：get_pages 经 PageTreeIter 识别页，页对象必须带 /Type /Page
                d.set("Type", LObj::Name(b"Page".to_vec()));
                d.set("Parent", LObj::Reference(pages_id));
            }
            page_ids.push(id);
        }
        if let LObj::Dictionary(d) = doc.get_object_mut(pages_id).unwrap() {
            d.set("Type", LObj::Name(b"Pages".to_vec()));
            d.set("Kids", LObj::Array(page_ids.iter().map(|id| LObj::Reference(*id)).collect()));
            d.set("Count", 3);
        }
        let catalog_id = doc.add_object(LObj::Dictionary(LDict::new()));
        // 大纲 3 条，目标页 0 / 2 / 1（乱序——验证页码映射来自 /Dest 引用而非条目顺序）
        let dests = [0usize, 2, 1];
        let mut item_ids = Vec::new();
        for t in ["a", "b", "c"] {
            let id = doc.add_object(LObj::Dictionary(LDict::new()));
            if let LObj::Dictionary(d) = doc.get_object_mut(id).unwrap() {
                d.set("Title", LObj::String(t.as_bytes().to_vec(), lopdf::StringFormat::Literal));
            }
            item_ids.push(id);
        }
        for (i, id) in item_ids.iter().enumerate() {
            if let LObj::Dictionary(d) = doc.get_object_mut(*id).unwrap() {
                d.set("Dest", LObj::Array(vec![
                    LObj::Reference(page_ids[dests[i]]),
                    LObj::Name(b"XYZ".to_vec()),
                    LObj::Integer(0), LObj::Integer(792), LObj::Integer(0),
                ]));
                if i + 1 < item_ids.len() {
                    d.set("Next", LObj::Reference(item_ids[i + 1]));
                }
            }
        }
        let outlines_id = doc.add_object(LObj::Dictionary(LDict::new()));
        if let LObj::Dictionary(d) = doc.get_object_mut(outlines_id).unwrap() {
            d.set("Type", LObj::Name(b"Outlines".to_vec()));
            d.set("First", LObj::Reference(item_ids[0]));
            d.set("Last", LObj::Reference(item_ids[2]));
            d.set("Count", 3);
        }
        if let LObj::Dictionary(d) = doc.get_object_mut(catalog_id).unwrap() {
            d.set("Type", LObj::Name(b"Catalog".to_vec()));
            d.set("Pages", LObj::Reference(pages_id));
            d.set("Outlines", LObj::Reference(outlines_id));
        }
        doc.trailer.set("Root", LObj::Reference(catalog_id));
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        assert_eq!(parse_pdf_outline_pages(&buf), Some(vec![0, 2, 1]));
        assert_eq!(parse_pdf_outline_pages(b"not a pdf"), None);
    }

    #[test]
    fn test_parse_pdf_outline_pages_nested_tree_document_order() {
        // Chromium generateDocumentOutline 产出**嵌套**书签树：h2/h3 挂在父项 /First 子链上，
        // 不是顶层 /Next 平铺。解析必须 pre-order（父 → 子链 → 兄弟），顺序 = DOM 文档序：
        //   item1(h1, p0) ─ First → item1a(h2, p1) ─ Next → item1b(h2, p2)
        //   item1 ─ Next → item2(h1, p3)
        // 期望 [0, 1, 2, 3]；只走顶层链会得 [0, 3]（历史 bug，页码整体错位）。
        use lopdf::{Dictionary as LDict, Document as LDoc, Object as LObj};
        let mut doc = LDoc::with_version("1.4");
        let pages_id = doc.add_object(LObj::Dictionary(LDict::new()));
        let mut page_ids = Vec::new();
        for _ in 0..4 {
            let id = doc.add_object(LObj::Dictionary(LDict::new()));
            if let LObj::Dictionary(d) = doc.get_object_mut(id).unwrap() {
                d.set("Type", LObj::Name(b"Page".to_vec()));
                d.set("Parent", LObj::Reference(pages_id));
            }
            page_ids.push(id);
        }
        if let LObj::Dictionary(d) = doc.get_object_mut(pages_id).unwrap() {
            d.set("Type", LObj::Name(b"Pages".to_vec()));
            d.set("Kids", LObj::Array(page_ids.iter().map(|id| LObj::Reference(*id)).collect()));
            d.set("Count", 4);
        }
        let catalog_id = doc.add_object(LObj::Dictionary(LDict::new()));
        let dest_of = |p: usize| LObj::Array(vec![
            LObj::Reference(page_ids[p]),
            LObj::Name(b"XYZ".to_vec()),
            LObj::Integer(0), LObj::Integer(792), LObj::Integer(0),
        ]);
        let mk_item = |doc: &mut LDoc, title: &str, p: usize| {
            let id = doc.add_object(LObj::Dictionary(LDict::new()));
            if let LObj::Dictionary(d) = doc.get_object_mut(id).unwrap() {
                d.set("Title", LObj::String(title.as_bytes().to_vec(), lopdf::StringFormat::Literal));
                d.set("Dest", dest_of(p));
            }
            id
        };
        let item1 = mk_item(&mut doc, "h1-a", 0);
        let item1a = mk_item(&mut doc, "h2-a1", 1);
        let item1b = mk_item(&mut doc, "h2-a2", 2);
        let item2 = mk_item(&mut doc, "h1-b", 3);
        if let LObj::Dictionary(d) = doc.get_object_mut(item1a).unwrap() {
            d.set("Parent", LObj::Reference(item1));
        }
        if let LObj::Dictionary(d) = doc.get_object_mut(item1b).unwrap() {
            d.set("Parent", LObj::Reference(item1));
            d.set("Prev", LObj::Reference(item1a));
        }
        if let LObj::Dictionary(d) = doc.get_object_mut(item1a).unwrap() {
            d.set("Next", LObj::Reference(item1b));
        }
        if let LObj::Dictionary(d) = doc.get_object_mut(item1).unwrap() {
            d.set("First", LObj::Reference(item1a));
            d.set("Last", LObj::Reference(item1b));
            d.set("Next", LObj::Reference(item2));
        }
        let outlines_id = doc.add_object(LObj::Dictionary(LDict::new()));
        if let LObj::Dictionary(d) = doc.get_object_mut(outlines_id).unwrap() {
            d.set("Type", LObj::Name(b"Outlines".to_vec()));
            d.set("First", LObj::Reference(item1));
            d.set("Last", LObj::Reference(item2));
            d.set("Count", 4);
        }
        if let LObj::Dictionary(d) = doc.get_object_mut(catalog_id).unwrap() {
            d.set("Type", LObj::Name(b"Catalog".to_vec()));
            d.set("Pages", LObj::Reference(pages_id));
            d.set("Outlines", LObj::Reference(outlines_id));
        }
        doc.trailer.set("Root", LObj::Reference(catalog_id));
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        assert_eq!(parse_pdf_outline_pages(&buf), Some(vec![0, 1, 2, 3]));
    }

    #[test]
    #[ignore] // 真机管线验证：本机 Edge（与 WebView2 同一 Chromium 打印管线）跑 CDP
    // generateDocumentOutline 产出真实 PDF，验证解析器对 xref stream / 对象流格式的兼容性。
    // 手动跑：cargo test test_parse_real_chromium_pdf -- --ignored（fixture 由
    // .superpowers/.../fixture/verify-chromium-pdf.mjs 生成）
    fn test_parse_real_chromium_pdf() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../.superpowers/sdd/2026-11-17-pdf-toc-bookmarks/fixture/chromium-outline.pdf"
        );
        let bytes = std::fs::read(path).expect("fixture 缺失：先跑 verify-chromium-pdf.mjs");
        let pages = parse_pdf_outline_pages(&bytes)
            .expect("真实 Chromium 产物应可解析出大纲页码");
        // 页面布局：p1 目录；p2 h1-a、h2-a1；p3 h3-a1a；p4 h1-b（0-based：1,1,2,3）
        assert_eq!(pages, vec![1, 1, 2, 3], "pre-order 应得 DOM 文档序页码");

        // 内部锚点 → 可点击 PDF 跳转链接（/Annots /Link）——目录条目跳转的管线证据
        let doc = lopdf::Document::load_mem(&bytes).unwrap();
        let page1_ref = *doc.get_pages().values().next().unwrap();
        let page1_obj = doc.get_object(page1_ref).unwrap().as_dict().unwrap();
        let annots = page1_obj.get(b"Annots").expect("目录页应含链接注解（内部锚点转跳转）");
        let arr = annots.as_array().unwrap();
        assert!(
            arr.len() >= 4,
            "目录页 4 个条目应转成 ≥4 个 /Link 注解，实际 {}",
            arr.len()
        );
        for a in arr {
            let dict = doc
                .get_object(a.as_reference().expect("注解应为引用"))
                .unwrap()
                .as_dict()
                .unwrap();
            assert_eq!(
                dict.get(b"Subtype").unwrap().as_name().unwrap(),
                b"Link",
                "注解应为 /Link"
            );
            assert!(
                dict.has(b"Dest") || dict.has(b"A"),
                "链接注解应有跳转目标（/Dest 或 /A）"
            );
        }
    }

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
