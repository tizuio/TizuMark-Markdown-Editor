/**
 * tauri-api.js —— 统一 IPC 边界（ADR-1 / N11 / N21 / N29）
 *
 * 设计要点（任何偏离都会破坏方案硬约束，勿擅自改动）：
 *  - COMMANDS 是 28 个自定义命令的【唯一真源】；方法由其生成。契约测试反解析
 *    src-tauri/src/lib.rs 的 generate_handler! 块校验集合一致（C17）。
 *  - 延迟求值：调用时才读取 window.__TAURI__.core.invoke（根治 app.js:1 白屏单点，N4）。
 *  - 语义空操作（硬约束 N21）：resolve 原样返回，reject 原样抛出；
 *    不 try/catch、不包装错误、不做会抛异常的参数校验。唯一守卫是 __TAURI__ 缺失时抛明确错误。
 *    理由：_mapReadFileError 依赖 Rust 原始 JSON，任何包装都会把 5 类文件错误静默塌缩成 E_IO，
 *    而现有 54 个测试查不出这种退化（C16 验收门专门防这一条）。
 *  - plugin 类（updater/dialog/webview）本质就是 core.invoke，属 P0-2b 收敛范围（N32）。
 *  - 双导出：浏览器挂 window.TauriApi；node 走 module.exports（互斥式，N29）。
 */
(function () {
  'use strict';

  // 自定义命令（唯一真源）；方法由其生成。契约测试反解析 lib.rs 的 generate_handler! 校验集合一致。
  const COMMANDS = [
    'read_file', 'write_file', 'write_binary_file', 'file_meta', 'is_directory',
    'list_dir', 'search_files', 'ensure_dir', 'app_data_dir', 'list_system_fonts', 'read_bundled_file',
    'read_bundled_image_as_base64', 'fetch_image_as_base64', 'save_image_to_assets',
    'watch_folder', 'stop_watch', 'search_in_files', 'generate_toc',
    'get_cli_args', 'quit_app', 'open_devtools', 'set_window_behavior',
    'set_close_to_tray_shortcut',
    'reveal_in_folder',
    // 文件树右键操作（合并自 PR #36）：重命名 / 删除 / 复制 / 移动
    'rename_path', 'remove_path', 'copy_path', 'move_path',
  ];

  // 延迟求值：调用时才读取 invoke（根治白屏单点）
  function getInvoke() {
    if (typeof window === 'undefined' ||
        !window.__TAURI__ || !window.__TAURI__.core ||
        typeof window.__TAURI__.core.invoke !== 'function') {
      throw new Error('Tauri 运行时不可用：window.__TAURI__.core.invoke 缺失（应用可能未在 Tauri 环境中启动）');
    }
    return window.__TAURI__.core.invoke;
  }

  // 语义空操作：原样透传 resolve / reject，不包装、不 try/catch、不参数校验
  function invokeCmd(cmd, args) {
    return getInvoke()(cmd, args || {});
  }

  function camel(name) {
    return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  const api = {};

  // 由 COMMANDS 生成对应方法（单一真源 → 方法）
  for (const cmd of COMMANDS) {
    api[camel(cmd)] = function (args) { return invokeCmd(cmd, args); };
  }

  // plugin 类命令（本质是 core.invoke，P0-2b 收敛范围，N32）
  api.dialogOpen = function (options) { return invokeCmd('plugin:dialog|open', { options }); };
  api.dialogSave = function (options) { return invokeCmd('plugin:dialog|save', { options }); };
  // 注意：open_devtools 已是 COMMANDS 生成的自定义方法；webview 内部开关单独命名避免冲突
  api.toggleDevtools = function () { return invokeCmd('plugin:webview|internal_toggle_devtools'); };

  api.updater = {
    check() { return invokeCmd('plugin:updater|check'); },
    download(payload) { return invokeCmd('plugin:updater|download', payload || {}); },
    install(payload) { return invokeCmd('plugin:updater|install', payload || {}); },
  };

  // P1-5：收敛非 core 命名空间（shell / event / app / window / path）到 TauriApi，
  // 全部带守卫——对应命名空间缺失时 no-op / 返回默认值，不改变既有 guarded 行为。
  // 这样 ADR-1 的「唯一 IPC 边界」才真正成立：app.js 不再出现 window.__TAURI__.*，
  // 全部收口到本模块（本模块是刻意保留 __TAURI__ 引用的唯一位置）。
  function getNs(name) {
    if (typeof window === 'undefined' || !window.__TAURI__) return null;
    return window.__TAURI__[name] || null;
  }

  // shell.open：成功打开返回 true；命名空间缺失（浏览器环境）返回 false，供调用方回退 window.open
  api.shellOpen = function (target) {
    const ns = getNs('shell');
    if (!ns || typeof ns.open !== 'function') return Promise.resolve(false);
    return Promise.resolve(ns.open(target)).then(() => true).catch(() => false);
  };

  // event.listen：命名空间缺失时 no-op 并返回已 resolve 的 unlisten 占位
  api.onEvent = function (name, cb) {
    const ns = getNs('event');
    if (!ns || typeof ns.listen !== 'function') return Promise.resolve(() => {});
    return ns.listen(name, cb);
  };

  // app.getVersion：命名空间缺失时返回 null（调用方 try/catch 或判空处理）
  api.getVersion = function () {
    const ns = getNs('app');
    if (!ns || typeof ns.getVersion !== 'function') return Promise.resolve(null);
    return ns.getVersion();
  };

  // window.getCurrentWindow：命名空间缺失时返回 null（调用方判空后降级）
  api.currentWindow = function () {
    const ns = getNs('window');
    if (!ns || typeof ns.getCurrentWindow !== 'function') return null;
    return ns.getCurrentWindow();
  };

  // path.resourceDir：命名空间缺失时返回 null（调用方 || '' 兜底）
  api.resourceDir = function () {
    const ns = getNs('path');
    if (!ns || typeof ns.resourceDir !== 'function') return Promise.resolve(null);
    return ns.resourceDir();
  };

  // tauri.convertFileSrc：把本地绝对路径转换为前端可安全用于 <img src> 的 asset URL。
  // 命名空间缺失（浏览器环境）时原样返回路径，供调用方降级。
  api.convertFileSrc = function (filePath) {
    const ns = getNs('tauri');
    if (!ns || typeof ns.convertFileSrc !== 'function') return filePath;
    try {
      return ns.convertFileSrc(filePath);
    } catch (e) {
      return filePath;
    }
  };

  // 运行环境判定：是否处于 Tauri 运行时。供 app.js 区分「Tauri 原生能力分支」与
  // 「浏览器降级分支」（如原生拖拽 vs DOM 拖拽），避免在浏览器环境误触 __TAURI__。
  api.isAvailable = function () {
    return typeof window !== 'undefined' && !!(window.__TAURI__ && window.__TAURI__.core);
  };

  // Channel 构造器：延迟读取，避免模块加载期访问 __TAURI__（P0-2b 由 tauriApi 接管 channel 绑定）
  Object.defineProperty(api, 'Channel', {
    configurable: true,
    get() {
      if (typeof window === 'undefined' ||
          !window.__TAURI__ || !window.__TAURI__.core ||
          !window.__TAURI__.core.Channel) {
        throw new Error('Tauri Channel 不可用：window.__TAURI__.core.Channel 缺失');
      }
      return window.__TAURI__.core.Channel;
    },
  });

  api.COMMANDS = COMMANDS;

  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    window.TauriApi = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
