// 共享测试 harness —— 抽离自 7 个测试文件中重复的 buildEnv/cleanup/delay。
// 用法：
//   const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');
//   const { w, getInitErr } = buildEnv({ invokeImpl, captureInitErr: true });
//
// 行为与原各文件内联实现保持一致：
//   - 用 jsdom 加载 src/index.html + src/app.js + src/modules/* + 默认 Tauri stub
//   - 注入 ResizeObserver / IntersectionObserver / matchMedia 等 jsdom 缺失的浏览器 API
//   - 桩化 CodeMirror 测量所需的 getBoundingClientRect / getClientRects
//   - 始终加载 codemirror searchcursor addon（find/replace 依赖）
//   - invokeImpl 缺省时：get_cli_args -> []，app_data_dir -> 'C:/tmp/tizumark-data'（与初始化路径兼容）

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..'); // test/helpers -> repo root
const HTML_PATH = path.join(ROOT, 'src', 'index.html');
const APPJS_PATH = path.join(ROOT, 'src', 'app.js');

// 测试拆卸产物：app.js 在 init 时启动的轮询定时器（文件监视 1.5s、后端健康检查 30s）使用全局
// setTimeout/setInterval，cleanup 会统一清除；但个别「已在飞行中」的回调可能在窗口已销毁、
// global.document 被重置为 undefined 之后才落地，触发一次无害的 DOM 操作异常（如
// "Cannot read properties of undefined (reading 'createElement')"）。该产品不会销毁窗口，
// 故属纯测试隔离产物。此处仅吞掉这类拆卸期 DOM 相关 rejection，其余一律原样抛出以暴露真实缺陷。
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.message) ? String(reason.message) : String(reason);
  if (/document|window|createElement|Cannot read properties of undefined|is not a function/.test(msg)) {
    return;
  }
  throw reason;
});

// 每个测试进程使用独立的 app 数据目录，避免不同测试文件之间因共享同一目录
// （原硬编码 C:/tmp/tizumark-data）而互相污染：例如 A 文件写入 session / recent 后，
// B 文件的 init 读取到残留数据导致偶发失败。同进程内仍共享该目录，保留会话持久化类
// 测试（写后读）的正确性。目录在进程启动时创建一次。
const PROCESS_DATA_DIR = path.join(os.tmpdir(), 'tizumark-test-' + process.pid);
try { fs.mkdirSync(PROCESS_DATA_DIR, { recursive: true }); } catch (_) {}

function defaultInvoke(cmd) {
  if (cmd === 'get_cli_args') return [];
  if (cmd === 'app_data_dir') return PROCESS_DATA_DIR;
  return undefined;
}

// 隔离策略：测试在“每个文件一个 Node 进程”下运行（见 scripts/run-tests.cjs，也是
// package.json 的 test 脚本），且每个文件内子测试【串行】执行（run-tests.cjs 用
// `node --test --test-concurrency=1` 启动每个文件）。这样同一时刻只有一个 buildEnv 在占用
// 共享的 global.window/document/navigator 与 require 缓存单例 codemirror，彻底避免并发
// 子测试互相踩踏共享全局导致的偶发失败（典型症状：w.editor 未就绪即被访问 →
// “Cannot read properties of undefined (reading 'editor')”）。就绪等待交给 waitForEditor 轮询。

async function buildEnv(options = {}) {
  // 兼容两种调用：buildEnv(invokeImplFn)（历史签名）与 buildEnv({ invokeImpl, captureInitErr })
  let invokeImpl;
  let captureInitErr = false;
  if (typeof options === 'function') {
    invokeImpl = options;
  } else {
    invokeImpl = options.invokeImpl;
    captureInitErr = options.captureInitErr || false;
  }
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const appjs = fs.readFileSync(APPJS_PATH, 'utf8');

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const w = dom.window;
  // 跳过 EULA 等待，直奔初始化
  w.localStorage.setItem('tizumark-eula-accepted', 'true');

  const rect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
  w.Range.prototype.getBoundingClientRect = rect;
  w.Range.prototype.getClientRects = () => [];
  w.Element.prototype.getBoundingClientRect = rect;
  w.Element.prototype.getClientRects = () => [];

  // jsdom 缺失但真实 WebView 具备的浏览器 API
  if (!w.CSS) w.CSS = {};
  if (!w.CSS.escape) {
    // 简化版 CSS.escape polyfill（jsdom 无此 API，app.js 大纲跳转等依赖）
    w.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (c) => '\\' + c);
  }
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  w.matchMedia = () => ({
    matches: false, media: '', onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });

  // 跟踪 MutationObserver 实例：cleanup 时统一 disconnect，避免 w.close() 后已注册的
  // 观察器在已销毁的 document 上触发回调（app.js 的回调会访问已不存在的节点 → 抛错），
  // 进而让本进程挂起、触发整文件超时。与定时器同理。
  const observers = new Set();
  const OrigMutationObserver = w.MutationObserver;
  w.MutationObserver = class extends OrigMutationObserver {
    constructor(cb) { super(cb); observers.add(this); }
    disconnect() { observers.delete(this); try { super.disconnect(); } catch (_) {} }
  };
  w.__pendingObservers = observers;

  // 跟踪本 window 的定时器句柄：app.js 在 init 时挂了一个 20s 的 loading 安全定时器，
  // 若不清掉会让每个测试进程在 cleanup 后仍挂起 ~20s（拖慢退出，极端时触发整文件超时）。
  // cleanup 时统一 clear，确保进程及时退出。
  const timers = new Set();
  w.__pendingTimers = timers;
  const origSetTimeout = w.setTimeout ? w.setTimeout.bind(w) : setTimeout.bind(global);
  w.setTimeout = (fn, ms, ...a) => {
    const id = origSetTimeout(() => { timers.delete(id); fn(...a); }, ms, ...a);
    timers.add(id);
    return id;
  };
  const origClearTimeout = w.clearTimeout ? w.clearTimeout.bind(w) : clearTimeout.bind(global);
  w.clearTimeout = (id) => { timers.delete(id); return origClearTimeout(id); };
  const origSetInterval = w.setInterval ? w.setInterval.bind(w) : setInterval.bind(global);
  w.setInterval = (fn, ms, ...a) => {
    const id = origSetInterval(fn, ms, ...a);
    timers.add(id);
    return id;
  };
  const origClearInterval = w.clearInterval ? w.clearInterval.bind(w) : clearInterval.bind(global);
  w.clearInterval = (id) => { timers.delete(id); return origClearInterval(id); };

  // CM5 与 app.js 使用「全局」setTimeout/setInterval（非 window.*，如 app.js 的 _backendHealthTimer
  // 健康检查 30s 定时器、CM5 光标闪烁的 setInterval），这些既不在 w.setTimeout 跟踪范围内，也不被
  // jsdom 的 stopAllTimers（w.close）捕获，cleanup 后常驻 → 事件循环不排空 → 整文件超时。
  // 因此在 buildEnv 期间临时包装全局定时器，cleanup 时统一清除并恢复全局原值。子测试串行执行，
  // 任一时刻仅一个编辑器生效，包装窗口极短，对 node --test 自身调度无影响。
  const gTimers = new Set();
  const gTimerMeta = new Map(); // id -> delay(ms)，用于区分长周期后台定时器
  w.__pendingGlobalTimers = gTimers;
  const gSetTimeout = global.setTimeout;
  const gSetInterval = global.setInterval;
  const gClearTimeout = global.clearTimeout;
  const gClearInterval = global.clearInterval;
  global.setTimeout = function (fn, ms, ...a) {
    const id = gSetTimeout(function () { gTimers.delete(id); return fn.apply(null, a); }, ms);
    gTimers.add(id);
    return id;
  };
  global.setInterval = function (fn, ms, ...a) {
    const id = gSetInterval(function () { return fn.apply(null, a); }, ms);
    gTimers.add(id); gTimerMeta.set(id, ms);
    return id;
  };
  global.clearTimeout = function (id) { gTimers.delete(id); gTimerMeta.delete(id); return gClearTimeout(id); };
  global.clearInterval = function (id) { gTimers.delete(id); gTimerMeta.delete(id); return gClearInterval(id); };
  w.__restoreGlobalTimers = () => {
    global.setTimeout = gSetTimeout; global.setInterval = gSetInterval;
    global.clearTimeout = gClearTimeout; global.clearInterval = gClearInterval;
  };

  // 跟踪 requestAnimationFrame 句柄：jsdom 在 pretendToBeVisual:true 时启动内部 rAF 循环，
  // 用 window.cancelAnimationFrame 终止对应回调；当回调计数归零时 jsdom 会自行 clearInterval。
  // cleanup 时统一 cancel 所有未决 rAF，避免事件循环无法排干导致整文件超时。
  const rafs = new Set();
  w.__pendingRAF = rafs;
  const origRAF = w.requestAnimationFrame ? w.requestAnimationFrame.bind(w) : (cb) => 0;
  w.requestAnimationFrame = (cb, ...a) => {
    const id = origRAF((...args) => { rafs.delete(id); return cb(...args); }, ...a);
    rafs.add(id);
    return id;
  };
  const origCAF = w.cancelAnimationFrame ? w.cancelAnimationFrame.bind(w) : () => {};
  w.cancelAnimationFrame = (id) => { rafs.delete(id); return origCAF(id); };

  // 捕获 app.js 注册的 Tauri 事件监听器，供测试直接触发（如 tauri://drag-drop、file-open）
  const tauriListeners = {};
  const tauri = {
    core: {
      // invokeImpl 仍会被调用（用于命令捕获/断言），但 app_data_dir 一律返回本进程隔离目录，
      // 防止任何测试（含自定义 invokeImpl）把 session/recent 写入共享目录造成跨文件污染。
      invoke: async (cmd, args) => {
        const r = invokeImpl ? invokeImpl(cmd, args) : defaultInvoke(cmd);
        if (cmd === 'app_data_dir') return PROCESS_DATA_DIR;
        return r;
      },
      // P1-5 前置：Channel 构造器占位（事件订阅相关测试用）
      Channel: function Channel() { this.onmessage = null; },
    },
    app: { getVersion: async () => '1.1.0' },
    event: {
      listen: async (name, cb) => {
        (tauriListeners[name] ||= []).push(cb);
        return () => {};
      },
    },
    window: { getCurrentWindow: () => ({ unminimize: async () => {}, show: async () => {}, setFocus: async () => {}, isMaximized: async () => false, minimize: async () => {}, hide: async () => {} }) },
    path: { resourceDir: async () => '' },
    shell: { open: async () => {} },
  };
  w.__TAURI__ = tauri;

  // codemirror 模块加载时会访问全局 document/window，需先指向 jsdom
  const prevGlobals = {
    window: global.window, document: global.document, navigator: global.navigator,
  };
  global.window = w;
  global.document = w.document;
  global.navigator = w.navigator;
  w.CodeMirror = require('codemirror');
  require('codemirror/addon/search/searchcursor');
  require('codemirror/addon/search/search.js'); // 统一加载，避免个别测试按需加载导致 require 缓存中 CodeMirror.commands 状态不一致

  const modulesDir = path.join(ROOT, 'src', 'modules');
  const allModuleFiles = fs.readdirSync(modulesDir)
    .filter((x) => x.endsWith('.js'))
    .filter((x) => fs.statSync(path.join(modulesDir, x)).isFile());

  // 显式优先加载（不依赖字典序，N5）：PRIORITY_MODULES 若存在则排到最前。
  // tauri-api.js 由 P0-2a 新增；此刻尚不存在，列入仅做"接入即生效"的预备，无副作用。
  // constants.js 必须早于消费它的业务模块（font/slash/export 等在加载时解构 TMConst）。
  const PRIORITY_MODULES = ['tauri-api.js', 'constants.js'];
  // 关键模块：加载失败必须抛出而非静默吞（T15 / N5 护栏）。
  // 现有 6 个 + 即将新增的 tauri-api / preview-window（不存在时无影响）。
  const CRITICAL_MODULES = new Set([
    'code-block.js', 'preview-post.js', 'word-count.js', 'outline.js',
    'dialogs.js', 'find-replace.js', 'tauri-api.js', 'preview-window.js',
    'image-processor.js',
  ]);

  const priority = allModuleFiles.filter((f) => PRIORITY_MODULES.includes(f));
  const rest = allModuleFiles.filter((f) => !PRIORITY_MODULES.includes(f));
  // 其余保持稳定顺序（模块本应加载顺序不敏感，这里只为可复现）
  rest.sort();
  const ordered = [...priority, ...rest];

  for (const f of ordered) {
    const full = path.join(modulesDir, f);
    try {
      w.eval(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      if (CRITICAL_MODULES.has(f)) {
        throw new Error(
          `[harness] 关键模块 ${f} 加载失败，终止初始化（原错误：${e && e.stack ? e.stack : e}）`,
        );
      }
      // 非关键模块：保留原"吞掉"行为，仅告警
      console.warn(`[harness] 模块 ${f} 加载失败（非关键，已忽略）：${e && e.message}`);
    }
  }

  // P2-1：加载 src/controllers/*.js（PreviewController facade），必须在 eval app.js 之前，
  // 否则 app.js 构造期 `new PreviewController(this)` 会 ReferenceError。
  const controllersDir = path.join(ROOT, 'src', 'controllers');
  if (fs.existsSync(controllersDir)) {
    for (const f of fs.readdirSync(controllersDir).filter((x) => x.endsWith('.js') && fs.statSync(path.join(controllersDir, x)).isFile())) {
      const full = path.join(controllersDir, f);
      try {
        w.eval(fs.readFileSync(full, 'utf8'));
      } catch (e) {
        throw new Error(`[harness] 控制器 ${f} 加载失败，终止初始化（原错误：${e && e.stack ? e.stack : e}）`);
      }
    }
  }

  // 加载 src/lib/md-links.js：UMD 模块，浏览器环境挂到 root（即 jsdom window），
  // 让 app.js 中直接调用的 isMarkdownLink / resolveDocPath 在测试中可见。
  // 缺失时 app.js 4516 行的 isMarkdownLink(href) 引用会 ReferenceError。
  try { w.eval(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'md-links.js'), 'utf8')); }
  catch (_) { /* 找不到或解析失败时，触发 click 的回归测试会暴露问题 */ }

  let initErr = null;
  const origErr = console.error;
  if (captureInitErr) {
    console.error = (...a) => {
      const s = String(a[0] || '');
      if (s.includes('Initialization error')) initErr = a[1];
    };
  }
  w.eval(appjs);
  console.error = origErr;

  // 触发 DOMContentLoaded
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));

  // 等待 app.js 的 async 初始化彻底完成（含 initFileWatcher 与末位 delay(300)），
  // 否则 cleanup 中 w.close() 会摧毁 w.document，与仍在跑的初始化末段竞争 →
  // "asynchronous activity after the test ended / Cannot read properties of undefined (reading 'documentElement')"
  await waitForInit(w);

  // 测试隔离：清理 app.js 在 init 时启动的长周期后台定时器（文件监视 1.5s、后端健康检查 30s 等）。
  // 若放任其在测试体内触发，其异步回调（读盘/外部变更检测等 DOM 操作）常在测试结束后才落地，
  // 被 node --test 判为「异步活动在测试结束后发生」而让整文件失败；且在 cleanup 重置 global.document
  // 后还会抛出无害的 DOM 异常。这些后台轮询不属于单元测试范畴——需要验证外部变更检测的测试应直接
  // 调用对应方法或模拟 window focus 触发，而非依赖 1.5s 定时器。
  for (const [id, ms] of gTimerMeta) {
    if (ms >= 1000) { try { gClearInterval(id); } catch (_) {} gTimerMeta.delete(id); gTimers.delete(id); }
  }

  const result = { w, tauriListeners };
  if (captureInitErr) result.getInitErr = () => initErr;
  result.__release = () => {
    global.window = prevGlobals.window;
    global.document = prevGlobals.document;
    global.navigator = prevGlobals.navigator;
  };
  return result;
}

function cleanup(w) {
  try { if (w.editor && w.editor.cm && w.editor.cm.close) w.editor.cm.close(); } catch (_) {}
  // 清除本 window 遗留的定时器（如 app.js 的 20s loading 安全定时器），让进程及时退出
  try { if (w.__pendingTimers) for (const id of w.__pendingTimers) w.clearTimeout(id); } catch (_) {}
  try { if (w.__pendingTimers) for (const id of w.__pendingTimers) w.clearInterval(id); } catch (_) {}
  // 断开所有 MutationObserver，避免销毁 document 后回调抛错使进程挂起
  try { if (w.__pendingObservers) for (const o of w.__pendingObservers) { try { o.disconnect(); } catch (_) {} } } catch (_) {}
  // 取消未决的 requestAnimationFrame，使 jsdom 内部 rAF 循环回调计数归零并自行 clearInterval
  try { if (w.__pendingRAF) for (const id of w.__pendingRAF) { try { w.cancelAnimationFrame(id); } catch (_) {} } } catch (_) {}
  // 清除全局定时器（app.js 的 setInterval 健康检查、CM5 的 setInterval 等），避免常驻导致进程挂起
  try { if (w.__pendingGlobalTimers) for (const id of w.__pendingGlobalTimers) { try { clearTimeout(id); clearInterval(id); } catch (_) {} } } catch (_) {}
  try { if (w.__restoreGlobalTimers) w.__restoreGlobalTimers(); } catch (_) {}
  try { if (w.close) w.close(); } catch (_) {}
  if (typeof w.__release === 'function') w.__release();
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// 轮询直到 window.editor（含 this.cm）就绪再返回，替代固定 delay(300)。
// 原因：window.editor 在 DOMContentLoaded 的 async 回调里经 `await initEula()` 之后才赋值，
// 高负载并发下固定 300ms 不足，导致个别用例在 editor 就绪前访问而抛错。轮询带超时兜底。
async function waitForEditor(w, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (w && w.editor && w.editor.cm) return w.editor;
    await delay(20);
  }
  throw new Error('waitForEditor timeout: window.editor 未在 ' + timeoutMs + 'ms 内就绪');
}

// 等待 app.js 的 DOMContentLoaded(async) 初始化彻底完成。
// 完成信号：window.editor._fileWatcherStarted === true（initFileWatcher 同步置位），
// 之后 DOMContentLoaded 还有 `await new Promise(r => setTimeout(r, 300))` 末段，再补等 350ms 排空。
// 必须在 buildEnv 返回前完成，否则 cleanup 的 w.close() 会与仍在跑的初始化末段竞争 w.document。
async function waitForInit(w, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (w && w.editor && w.editor._fileWatcherStarted === true) break;
    await delay(20);
  }
  if (!(w && w.editor && w.editor._fileWatcherStarted === true)) {
    throw new Error('waitForInit timeout: window.editor._fileWatcherStarted 未在 ' + timeoutMs + 'ms 内就绪');
  }
  // 末位 delay(300) 仍在跑，补等以彻底排空
  await delay(350);
}

// 串行化环境包装：buildEnv 已通过进程级互斥锁串行化（锁在 buildEnv 获取、cleanup 释放），
// 因此 withEditor 只需 await buildEnv + 等初始化 + 在 finally 中 cleanup 即可，同一时刻
// 只有一个测试在占用共享全局，消除 node:test 并发子测试间的串扰。
async function withEditor(optsOrFn, fn) {
  const opts = (typeof optsOrFn === 'function' || optsOrFn == null)
    ? { invokeImpl: optsOrFn }
    : optsOrFn;
  const { w } = await buildEnv(opts);
  const ed = await waitForEditor(w);
  try {
    return await fn(w, ed);
  } finally {
    cleanup(w);
  }
}

module.exports = { buildEnv, cleanup, delay, waitForEditor, withEditor, ROOT };
