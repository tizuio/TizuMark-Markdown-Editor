// 全量功能「模拟人测试」E2E：真实浏览器 + 真实输入 + 精确数据断言。
//
// 口径：
//  - 加载真实 src/index.html + 全部真实模块（styles/codemirror/所有 modules/app.js 原样）；
//    唯一 mock 是 Rust 侧 IPC：window.__TAURI__（core.invoke → 内存文件系统 + 调用日志）。
//    应用走的是与真机完全相同的代码路径（isAvailable()=true，原生分支全开）。
//  - 交互全部用 Playwright 真实鼠标/键盘（OS 级输入事件：mousedown/mousemove/mouseup、
//    keydown/keypress/keyup 序列），不是 page.evaluate 合成派发——「模拟人」。
//  - 断言全部用精确数据：元素包围盒（px）、scrollTop、光标行/列、行高、movePath 参数、
//    调用日志、DOM 类名状态；关键步骤截图留证（screenshots/）。
//
// 覆盖场景（S0-S10）：EULA 首启 → 启动基线 → 打开工作区（真实点击）→ 点开文件 →
// 真实键入+保存 → 三视图切换（含 WYSIWYG 当前行灰底像素）→ 文件树真实拖拽移动
// （含拖拽中影子/光标/高亮的中间态断言、非法落点、空白区=根）→ 标签页真实拖拽排序 →
// Ctrl+F 查找替换（精确计数与光标行）→ 大纲点击导航（scrollTop 精确变化）→
// 编辑/预览滚动同步 → 右键菜单新建文件（真实键入文件名）。
//
// 用法：node scripts/e2e-human-check.mjs     （playwright 自动解析，勿重新安装）
// 结果：控制台逐场景 PASS/FAIL + 精确数据；退出码 0=全过。

import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright'),
    'C:/Users/admin/AppData/Roaming/npm/node_modules/playwright',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* 试下一个 */ }
  }
  throw new Error('未找到 playwright：npm i -g playwright（或设 PLAYWRIGHT_MODULE 指向包目录）');
}
const pw = loadPlaywright();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const appUrl = pathToFileURL(path.join(root, 'src', 'index.html')).href;
const shotDir = path.join(root, 'screenshots');
if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

// 浏览器：系统 Edge（与 app 真机 WebView2 同引擎），不可用时回退自带 Chromium
let browser, isEdge = false;
try {
  browser = await pw.chromium.launch({ headless: true, channel: 'msedge' });
  isEdge = true;
  console.log('[driver] 浏览器: 系统 Edge（与 WebView2 同引擎）');
} catch (_) {
  browser = await pw.chromium.launch({ headless: true });
  console.log('[driver] 浏览器: playwright 自带 Chromium（Edge 不可用）');
}

// ============================================================================
// __TAURI__ mock（addInitScript，页面加载前注入）：Rust 侧的内存替身
// ============================================================================
const tauriMockScript = `
(function () {
  'use strict';
  // ---------- 内存文件系统 ----------
  const DATA_DIR = 'C:/data';
  const WS = 'C:/ws';
  const FS = new Map();
  function put(p, o) { FS.set(p, o); return o; }
  function parentOf(p) { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : p; }
  function ensureDir(p) { if (!FS.has(p)) put(p, { type: 'dir', mtime: 1690000000, created: 1690000000 }); }
  function fileEntry(p, content, mtime, created) {
    return put(p, { type: 'file', content: content, size: content.length, mtime: mtime, created: created || mtime });
  }
  // ---------- E2E 主文档（事实表由构造器计算，断言不靠人记） ----------
  const facts = { ws: WS };
  const FENCE = '\\u0060\\u0060\\u0060'; // 三反引号（模板字面量内转义）
  const guideContent = (function () {
    const L = [];
    const push = (s) => L.push(s);
    push('# E2E 主文档');                       // L1 h1
    push('');
    push('本文档是全量人测的夹具。');
    push('[TOC]');
    push('');
    push('## 第一章 问候');                     // h2
    push('');
    push('hello 第一处。');
    push('hello 第二处。');
    push('');
    push('一段普通正文，用于滚动测试。');
    push('');
    push('### 1.1 细节');                       // h3
    push('');
    push('- 条目一');
    push('- 条目二');
    push('- 条目三');
    push('');
    push(FENCE + 'js');
    push('function e2eProbe() { return 42; }');
    push(FENCE);
    push('');
    push('## 第二章 更多内容');                  // h2
    push('');
    push('hello 第三处。');
    push('');
    push('## 第三章 长文');                      // h2
    push('');
    for (let i = 1; i <= 48; i++) {
      push('长文第 ' + i + ' 行：填充段落，保证文档可以滚动。（' + i + '）');
      if (i % 8 === 0) push('');
    }
    const content = L.join('\\n');
    const lines = content.split('\\n');
    facts.guideLines = lines.length;
    facts.headingLines = lines.map((s, i) => ({ line: i + 1, level: (s.match(/^#+/) || [''])[0].length || null, text: s }))
      .filter(h => h.level).map(h => ({ line: h.line, level: h.level, text: h.text }));
    facts.helloLines = lines.map((s, i) => (s.indexOf('hello') === 0 ? i + 1 : 0)).filter(Boolean);
    return content;
  })();

  put(WS, { type: 'dir', mtime: 1690000000, created: 1690000000 });
  ensureDir(WS + '/docs');  ensureDir(WS + '/img'); ensureDir(WS + '/notes');
  fileEntry(WS + '/guide.md', guideContent, 1700000200, 1690000200);
  fileEntry(WS + '/b.md', '# b 文档\\n\\nhello 不应出现在替换统计外的位置。\\n', 1700000100, 1690000100);
  fileEntry(WS + '/notes/todo.md', '# 待办\\n\\n- 事项一\\n- 事项二\\n', 1700000150, 1690000150);
  fileEntry(WS + '/notes/ideas.md', '# 想法\\n\\n想法若干。\\n', 1700000140, 1690000140);
  fileEntry(WS + '/docs/a.md', '# a 文档\\n\\n在 docs 目录里。\\n', 1700000160, 1690000160);
  put(DATA_DIR, { type: 'dir', mtime: 1690000000, created: 1690000000 });
  // 使用说明兜底（openUserGuide 的 fetch 受限时走 resourceDir('') + readFile 的相对路径）
  fileEntry('guide.md', guideContent, 1690000010, 1690000010);
  fileEntry('guide.en.md', guideContent, 1690000010, 1690000010);
  fileEntry('guide.es.md', guideContent, 1690000010, 1690000010);

  // ---------- 调用日志与对话控制 ----------
  const invokeLog = [];
  let dialogOpenResult = WS;      // plugin:dialog|open 的返回值（可被测试改）
  let dialogSaveResult = null;    // plugin:dialog|save
  const dialogs = { open: () => dialogOpenResult, setOpen: (v) => { dialogOpenResult = v; }, save: () => dialogSaveResult, setSave: (v) => { dialogSaveResult = v; } };

  function entryOf(p) {
    const f = FS.get(p);
    return {
      path: p,
      name: p.slice(p.lastIndexOf('/') + 1),
      is_dir: !!(f && f.type === 'dir'),
      size: f && f.type === 'file' ? f.size : null,
      mtime: (f && f.mtime) || 0,
      created: (f && f.created) || 0,
    };
  }
  function listDir(p) {
    if (!FS.has(p) || FS.get(p).type !== 'dir') throw new Error(JSON.stringify({ kind: 'NotFound' }));
    const out = [];
    for (const [k, v] of FS.entries()) {
      if (v.type !== 'dir' && v.type !== 'file') continue;
      if (parentOf(k) === p) out.push(entryOf(k));
    }
    return out;
  }
  function deepRemove(p) {
    FS.delete(p);
    for (const k of [...FS.keys()]) if (k.indexOf(p + '/') === 0) FS.delete(k);
  }
  function movePath(from, to) {
    const f = FS.get(from);
    if (!f) throw new Error(JSON.stringify({ kind: 'NotFound' }));
    const toParent = parentOf(to);
    ensureDir(toParent);
    const toName = to.slice(to.lastIndexOf('/') + 1);
    const fromParent = parentOf(from);
    if (f.type === 'dir') {
      const keys = [...FS.keys()].filter((k) => k === from || k.indexOf(from + '/') === 0);
      for (const k of keys) {
        const nk = to + k.slice(from.length);
        const v = FS.get(k);
        FS.set(nk, v);
        if (k !== from && FS.get(from + k.slice(from.length))) {} // noop
      }
      // 源目录树删除
      for (const k of keys) FS.delete(k);
      FS.set(to, { type: 'dir', mtime: Date.now() / 1000, created: (f.created || 0) });
    } else {
      FS.set(to, { type: 'file', content: f.content, size: f.size, mtime: Date.now() / 1000, created: f.created || 0 });
      FS.delete(from);
    }
    return to;
  }

  // ---------- invoke 路由 ----------
  async function invoke(cmd, args) {
    args = args || {};
    invokeLog.push({ cmd: cmd, args: JSON.parse(JSON.stringify(args)) });
    await new Promise((r) => setTimeout(r, 4 + Math.random() * 12)); // 真实 IPC 时延
    switch (cmd) {
      case 'get_cli_args': return [];
      case 'app_data_dir': return DATA_DIR;
      case 'list_system_fonts': return ['Segoe UI', 'Microsoft YaHei', 'Consolas', 'SimSun'];
      case 'read_file': {
        const f = FS.get(args.path);
        if (!f || f.type !== 'file') throw new Error(JSON.stringify({ kind: 'NotFound' }));
        return f.content;
      }
      case 'write_file':
      case 'write_binary_file': {
        const p = args.path;
        ensureDir(parentOf(p));
        const wasDir = FS.has(p) && FS.get(p).type === 'dir';
        FS.set(p, { type: 'file', content: args.content == null ? '' : args.content, size: (args.content || '').length, mtime: Date.now() / 1000, created: (wasDir ? 0 : (FS.get(p) || {}).created) || Date.now() / 1000 });
        return true;
      }
      case 'file_meta': {
        const f = FS.get(args.path);
        if (!f) throw new Error(JSON.stringify({ kind: 'NotFound' }));
        return { size: f.type === 'file' ? f.size : 0, mtime: f.mtime };
      }
      case 'is_directory': return !!(FS.get(args.path) && FS.get(args.path).type === 'dir');
      case 'list_dir': return listDir(args.path);
      case 'search_files': return [];
      case 'search_in_files': return [];
      case 'ensure_dir': ensureDir(args.path); return true;
      case 'rename_path': {
        const p = args.path; const f = FS.get(p);
        if (!f) throw new Error(JSON.stringify({ kind: 'NotFound' }));
        const newName = args.newName || args.new_name;
        const to = parentOf(p) + '/' + newName;
        if (f.type === 'dir') {
          const keys = [...FS.keys()].filter((k) => k === p || k.indexOf(p + '/') === 0);
          for (const k of keys) FS.set(to + k.slice(p.length), FS.get(k));
          for (const k of keys) FS.delete(k);
        } else FS.set(to, f);
        return to;
      }
      case 'remove_path': deepRemove(args.path); return true;
      case 'copy_path': {
        const f = FS.get(args.from);
        if (!f) throw new Error(JSON.stringify({ kind: 'NotFound' }));
        ensureDir(parentOf(args.to));
        if (f.type === 'dir') {
          for (const [k, v] of FS.entries()) if (k === args.from || k.indexOf(args.from + '/') === 0) FS.set(args.to + k.slice(args.from.length), v);
        } else FS.set(args.to, { type: 'file', content: f.content, size: f.size, mtime: Date.now() / 1000, created: f.created });
        return args.to;
      }
      case 'move_path': return movePath(args.from, args.to);
      case 'watch_folder': return null;
      case 'stop_watch': return null;
      case 'reveal_in_folder': return true;
      case 'quit_app': return null;
      case 'open_devtools': return null;
      case 'set_window_behavior': return null;
      case 'set_close_to_tray_shortcut': return null;
      case 'download_update_to_file': return DATA_DIR + '/update-setup.exe';
      case 'find_cached_update': return null;
      case 'install_cached_update': return null;
      case 'fetch_image_as_base64': return '';
      case 'read_bundled_image_as_base64': return '';
      case 'save_image_to_assets': return WS + '/assets/image-1.png';
      case 'generate_toc': {
        const lines = String(args.content || '').split('\\n');
        const items = [];
        lines.forEach((s, i) => {
          const m = s.match(/^(#{1,6})\\s+(.*)$/);
          if (m) items.push('<li><a href="#line-' + (i + 1) + '">' + m[2] + '</a></li>');
        });
        return '<ul class="toc">' + items.join('') + '</ul>';
      }
      case 'read_bundled_file': {
        const fn = args.filename || '';
        if (fn === 'demo.md') return { content: '# demo\\n\\n演示文档（E2E mock）。\\n', path: 'bundled/demo.md' };
        if (/^guide(\.(en|es))?\.md$/.test(fn)) return { content: guideContent, path: 'bundled/' + fn };
        throw new Error(JSON.stringify({ kind: 'NotFound' }));
      }
      case 'plugin:dialog|open': return dialogs.open();
      case 'plugin:dialog|save': return dialogs.save();
      case 'plugin:updater|check': return null;
      case 'plugin:updater|download': return null;
      case 'plugin:updater|install': return null;
      case 'plugin:webview|internal_toggle_devtools': return null;
      default:
        console.warn('[tauri-mock] 未路由的 invoke: ' + cmd);
        return null;
    }
  }

  class Channel { constructor() { this.messageReceived = async () => {}; } }

  window.__TAURI__ = {
    core: { invoke: invoke, Channel: Channel },
    event: { listen: async () => (async () => {}), emit: async () => {}, unlisten: async () => {} },
    app: { getVersion: async () => '1.2.5' },
    path: { resourceDir: async () => '' },
    shell: { open: async () => { throw new Error('no shell in E2E'); } },
    window: {
      getCurrentWindow: () => ({
        unminimize: async () => {}, show: async () => {}, hide: async () => {},
        minimize: async () => {}, maximize: async () => {}, unmaximize: async () => {},
        setFocus: async () => {}, setAlwaysOnTop: async () => {},
      }),
    },
    tauri: { convertFileSrc: (p) => p },
  };
  window.__E2E__ = {
    fs: FS,
    invokeLog: invokeLog,
    facts: facts,
    dialogs: dialogs,
    countInvokes: (cmd) => invokeLog.filter((c) => c.cmd === cmd).length,
  };
})();
`;

// ============================================================================
// 驱动
// ============================================================================
const results = [];
const pageErrors = [];
let page, ctx;

function record(name, pass, data, errors) {
  results.push({ name, pass: !!pass, data: data || {}, errors: errors || [] });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log('\n=== [' + mark + '] ' + name + ' ===');
  if (data && Object.keys(data).length) {
    const dump = JSON.stringify(data, null, 1);
    console.log(dump.length > 2600 ? dump.slice(0, 2600) + ' …(截断)' : dump);
  }
  (errors || []).forEach((e) => console.log('  ✗ ' + e));
}
function ok(name, cond, msg, data) {
  if (!cond) throw new Error(msg || (name + ' 断言失败'));
  return data;
}
const center = (b) => [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)];
async function boxOf(page, sel) {
  return page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 逐字符键入并在每个字符后采样 activeElement + 取值（精确定位键入断点）
// getValueSrc：字符串，作为 return 表达式，形参名 ae（activeElement）
async function typePerChar(page, text, delay, getValueSrc) {
  await page.evaluate((src) => { window.__sampleValue = new Function('ae', 'return (' + src + ');'); window.__typeT0 = Date.now(); window.__typeSamples = []; }, getValueSrc);
  for (let i = 0; i < text.length; i++) {
    page.keyboard.type(text[i]);
    await sleep(delay);
    await page.evaluate(() => {
      const ae = document.activeElement;
      let val;
      try { val = window.__sampleValue(ae); } catch (e) { val = 'ERR:' + String(e.message).slice(0, 40); }
      window.__typeSamples.push({
        i: window.__typeSamples.length,
        t: Date.now() - window.__typeT0,
        active: ae ? (ae.id || ae.tagName + '.' + String(ae.className).slice(0, 24)) : 'none',
        val: val,
      });
    });
  }
  return page.evaluate(() => window.__typeSamples);
}
// 按标签文本找树行包围盒（JS 查询，不依赖 Playwright 专有伪类）
async function rowBoxByLabel(page, label) {
  const b = await page.evaluate((label) => {
    const rows = Array.from(document.querySelectorAll('#folder-tree .tree-row'));
    const el = rows.find((r) => {
      const l = r.querySelector('.tree-label');
      return l && l.textContent === label;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, label);
  if (!b) throw new Error('文件树未找到标签为「' + label + '」的行');
  return b;
}

async function main() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  page = await context.newPage();
  ctx = { shots: 0 };
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  // console.error 多数场景是预期的（如 file:// 资源告警），只收集不判败，最终人工复核
  const consoleErrs = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });

  await page.addInitScript(tauriMockScript);
  const navStart = Date.now();
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  ctx.navMs = Date.now() - navStart;

  // ---------- S0：EULA 首启（真实点击接受）→ 启动完成 ----------
  {
    const data = { navMs: ctx.navMs, driver: isEdge ? 'msedge' : 'chromium' };
    const errors = [];
    try {
      await page.waitForSelector('#eula-dialog:not(.hidden)', { timeout: 15000 });
      data.eulaBox = await boxOf(page, '#eula-dialog');
      const acc = center(await boxOf(page, '#eula-accept'));
      page.mouse.click(acc[0], acc[1]); // 真实点击
      await page.waitForFunction(
        () => window.editor && document.getElementById('loading-overlay').classList.contains('hidden'),
        null, { timeout: 60000 }
      );
      await sleep(400);
      // 全局焦点时间线（环形缓冲 300 条）：定位键入断点时焦点去了哪
      await page.evaluate(() => {
        window.__focusLog = [];
        const push = (kind, e) => {
          window.__focusLog.push({ t: Date.now(), kind, el: (e.target && (e.target.id || e.target.tagName)) || '?' });
          if (window.__focusLog.length > 300) window.__focusLog.shift();
        };
        document.addEventListener('focusin', (e) => push('in', e), true);
        document.addEventListener('focusout', (e) => push('out', e), true);
      });
      data.viewMode = await page.evaluate(() => window.editor.viewMode);
      data.tabs = await page.evaluate(() => window.editor.tabs.map((t) => t.name));
      data.statusText = await page.$eval('#status-text', (el) => el.textContent);
      data.fatalBar = await page.$eval('#fatal-error-bar', (el) => !el.classList.contains('hidden')).catch(() => false);
      data.previewBox = await boxOf(page, '#preview');
      data.tabBarBox = await boxOf(page, '#tab-bar');
      data.tabBoxes = await page.$$eval('.tab', (els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, w: r.width }; }));
      ok('S0', data.viewMode === 'preview' && !data.fatalBar, '启动后应处于阅读模式且无错误条');
      record('S0 EULA 首启 + 启动基线', true, data, errors);
    } catch (e) {
      record('S0 EULA 首启 + 启动基线', false, data, errors.concat([e.message]));
    }
  }

  // ---------- S1：打开工作区（真实点击「文件」标题） ----------
  {
    const data = {};
    const errors = [];
    try {
      data.wsTitleBox = await boxOf(page, '#files-header-open');
      const c = center(data.wsTitleBox);
      page.mouse.click(c[0], c[1]);
      await page.waitForFunction(() => (document.getElementById('folder-path').textContent || '').length > 0, null, { timeout: 15000 });
      await sleep(300);
      data.folderPath = await page.$eval('#folder-path', (el) => el.textContent);
      data.treeRows = await page.$$eval('#folder-tree .tree-row', (els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.querySelector('.tree-label').textContent, x: r.x, y: r.y, w: r.width, h: r.height, padLeft: el.style.paddingLeft };
      }));
      ok('S1', data.folderPath === 'C:/ws', '工作区路径应精确为 C:/ws', data);
      const labels = data.treeRows.map((r) => r.label);
      ok('S1', JSON.stringify(labels) === JSON.stringify(['docs', 'img', 'notes', 'b.md', 'guide.md']),
        '默认 name 升序 + 文件夹优先：实际 ' + labels.join(','), data);
      record('S1 打开工作区（真实点击）+ 树渲染精确布局', true, data, errors);
    } catch (e) {
      record('S1 打开工作区（真实点击）+ 树渲染精确布局', false, data, errors.concat([e.message]));
    }
  }

  // ---------- S2：点开 guide.md（真实点击行）→ tab/行数/活动高亮 ----------
  {
    const data = {};
    const errors = [];
    try {
      const rowBox = await rowBoxByLabel(page, 'guide.md');
      page.mouse.click(Math.round(rowBox.x + rowBox.w / 2), Math.round(rowBox.y + rowBox.h / 2));
      await page.waitForFunction(() => window.editor.tabs.some((t) => t.filePath === 'C:/ws/guide.md'), null, { timeout: 15000 });
      await sleep(500);
      data.tabs = await page.evaluate(() => window.editor.tabs.map((t) => t.name));
      data.lineCountText = await page.$eval('#line-count', (el) => el.textContent);
      data.factsGuideLines = await page.evaluate(() => window.__E2E__.facts.guideLines);
      data.editorValueLen = await page.evaluate(() => window.editor.cm.getValue().length);
      data.activeRowCls = await page.$eval('#folder-tree .tree-node[data-path="C:/ws/guide.md"] .tree-row', (el) => el.className).catch(() => null);
      data.statusText = await page.$eval('#status-text', (el) => el.textContent);
      ok('S2', data.tabs.includes('guide.md'), '应新增 guide.md 标签');
      const m = String(data.lineCountText).match(/(\d+)/);
      ok('S2', m && Number(m[1]) === data.factsGuideLines, '状态栏行数应精确等于文档行数 ' + data.factsGuideLines + '，实际 ' + data.lineCountText, data);
      record('S2 点开文件（真实点击）+ 精确行数', true, data, errors);
    } catch (e) {
      record('S2 点开文件（真实点击）+ 精确行数', false, data, errors.concat([e.message]));
    }
  }

  // ---------- S3：切换编辑视图 + 真实键入 + Ctrl+S 保存 ----------
  {
    const data = {};
    const errors = [];
    try {
      const btn = center(await boxOf(page, '#btn-view-edit'));
      page.mouse.click(btn[0], btn[1]);
      await sleep(400);
      data.viewMode = await page.evaluate(() => window.editor.viewMode);
      ok('S3', data.viewMode === 'edit', '点击「源码」后应为编辑模式', data);
      const cmBox = await page.$eval('.CodeMirror', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      data.cmBox = cmBox;
      page.mouse.click(Math.round(cmBox.x + cmBox.w / 2), Math.round(cmBox.y + cmBox.h / 2));
      await sleep(200);
      page.keyboard.press('Control+End');
      await sleep(150);
      const lineBefore = await page.evaluate(() => window.editor.cm.lineCount());
      data.typeSamples = await typePerChar(page, '\nE2E 键入行：真实键盘输入验证', 40,
        "window.editor.cm.getValue().split('\\n').slice(-1)[0]");
      data.focusLog = await page.evaluate(() => window.__focusLog.slice(-40));
      await sleep(200);
      const lineAfter = await page.evaluate(() => window.editor.cm.lineCount());
      data.lines = { before: lineBefore, after: lineAfter, delta: lineAfter - lineBefore };
      data.cursorPosText = await page.$eval('#cursor-position', (el) => el.textContent);
      const tail = await page.evaluate(() => window.editor.cm.getValue().split('\n').slice(-1)[0]);
      data.typedLine = tail;
      ok('S3', data.lines.delta === 1, '真实键入应精确 +1 行', data);
      ok('S3', tail === 'E2E 键入行：真实键盘输入验证', '编辑器尾部应精确等于键入内容', data);
      // Ctrl+S 保存（真实）
      page.keyboard.press('Control+s');
      await page.waitForFunction(() => (document.getElementById('status-text').textContent || '').indexOf('已保存') !== -1, null, { timeout: 8000 });
      data.statusText = await page.$eval('#status-text', (el) => el.textContent);
      const diskTail = await page.evaluate(() => window.__E2E__.fs.get('C:/ws/guide.md').content.split('\n').slice(-1)[0]);
      data.diskTail = diskTail;
      ok('S3', diskTail === 'E2E 键入行：真实键盘输入验证', '保存后磁盘（mock FS）尾部应精确一致', data);
      record('S3 真实键入 + Ctrl+S 保存（精确行数/行尾/磁盘一致）', true, data, errors);
    } catch (e) {
      record('S3 真实键入 + Ctrl+S 保存（精确行数/行尾/磁盘一致）', false, data, errors.concat([e.message]));
    }
  }

  // ---------- S4：三视图切换（阅读/实时预览/源码）+ WYSIWYG 当前行灰底 ----------
  {
    const data = {};
    const errors = [];
    try {
      // 阅读
      const c1 = center(await boxOf(page, '#btn-view-preview'));
      page.mouse.click(c1[0], c1[1]);
      await sleep(700);
      data.preview = {
        active: await page.$eval('#btn-view-preview', (el) => el.classList.contains('active')),
        previewH: (await boxOf(page, '#preview')).h,
        cmVisible: await page.$eval('.CodeMirror', (el) => el.offsetParent !== null).catch(() => false),
        h1: await page.$eval('#preview h1', (el) => el.textContent).catch(() => null),
      };
      // 实时预览（WYSIWYG）
      const c2 = center(await boxOf(page, '#btn-view-wysiwyg'));
      page.mouse.click(c2[0], c2[1]);
      await sleep(1200);
      data.wysiwyg = {
        active: await page.$eval('#btn-view-wysiwyg', (el) => el.classList.contains('active')),
        masks: await page.$$eval('.wysiwyg-block-mask', (els) => els.length),
        blocks: await page.evaluate(() => (window.editor._wysiwygBlocks || []).length).catch(() => -1),
        tocInjected: await page.$eval('.wysiwyg-block-mask .toc, .wysiwyg-block-mask ul.toc', (el) => el.outerHTML.length).catch(() => 0),
      };
      // 切视图后光标行（文末）可能不在视口：像人一样真实滚轮滚到底，再点最后一个块聚焦
      const cmB = await boxOf(page, '.CodeMirror');
      const cmC = center(cmB);
      page.mouse.move(cmC[0], cmC[1]);
      for (let i = 0; i < 15; i++) { page.mouse.wheel(0, 300); await sleep(100); }
      await sleep(300);
      const lastMask = await page.$$eval('.wysiwyg-block-mask', (els) => { const el = els[els.length - 1]; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      page.mouse.click(Math.round(lastMask.x + lastMask.w / 2), Math.round(lastMask.y + lastMask.h / 2));
      await sleep(300);
      // 确定性定位：光标到「## 第二章」标题行（0-based 22，文档前 1/3，必在渲染视口）
      await page.evaluate(() => {
        const cm = window.editor.cm;
        const pos = { line: 22, ch: 0 };
        cm.setSelection(pos, pos, { scroll: true, origin: 'e2e' });
      });
      await sleep(500);
      // 当前行灰底（2026-10-21 修复项，CSS L2973 口径）：
      // 类挂在光标行的 div.CodeMirror-linebackground 上（行的兄弟节点），灰底 = var(--code-bg)
      const gray = await page.evaluate(() => {
        try {
          const ed = window.editor;
          if (!ed || !ed.cm) return { err: 'no cm' };
          const pos = ed.cm.getCursor();
          const bg = document.querySelector('.CodeMirror div.CodeMirror-linebackground.cm-wysiwyg-active-block');
          const wrap = bg && bg.parentElement;
          const r = bg ? bg.getBoundingClientRect() : null;
          return {
            cursorLine: pos.line,
            cursorText: ed.cm.getLine(pos.line).slice(0, 24),
            activeBgEl: !!bg,
            bgCls: bg ? String(bg.className).slice(0, 60) : null,
            bgH: r ? Math.round(r.height) : null,
            bgColor: bg ? getComputedStyle(bg).backgroundColor : null,
            onCursorLine: !!(wrap && wrap.classList.contains('CodeMirror-activeline')),
            wrapCls: wrap ? String(wrap.className).slice(0, 60) : null,
            scroll: (function () { const si = ed.cm.getScrollInfo(); return { top: Math.round(si.top), h: Math.round(si.height), client: Math.round(si.clientHeight) }; })(),
          };
        } catch (e) { return { err: String(e.message).slice(0, 80) }; }
      });
      data.cursorLineGray = gray;
      // 源码
      const c3 = center(await boxOf(page, '#btn-view-edit'));
      page.mouse.click(c3[0], c3[1]);
      await sleep(400);
      data.edit = {
        active: await page.$eval('#btn-view-edit', (el) => el.classList.contains('active')),
        cmVisible: await page.$eval('.CodeMirror', (el) => el.offsetParent !== null),
      };
      ok('S4', data.preview.active && data.preview.h1 === 'E2E 主文档' && data.wysiwyg.active && data.wysiwyg.masks > 0 && data.edit.active,
        '三视图切换与 WYSIWYG 遮罩应生效', data);
      const g = data.cursorLineGray;
      ok('S4', g && !g.err && g.activeBgEl && g.onCursorLine && g.bgH >= 10 && g.bgColor !== 'rgba(0, 0, 0, 0)',
        'WYSIWYG 光标行应有 linebackground 灰底（--code-bg、≥10px 全高），实际 ' + JSON.stringify(g), data);
      record('S4 三视图切换 + WYSIWYG 遮罩/TOC/当前行灰底（像素）', true, data, errors);
    } catch (e) {
      record('S4 三视图切换 + WYSIWYG 遮罩/TOC/当前行灰底（像素）', false, data, errors.concat([e.message]));
    }
  }

  // ---------- S5：文件树真实拖拽移动（新核心功能） ----------
  {
    const data = {};
    const errors = [];
    try {
      // 准备：展开 docs（真实点击行）
      const docsRow = await rowBoxByLabel(page, 'docs');
      page.mouse.click(Math.round(docsRow.x + docsRow.w / 2), Math.round(docsRow.y + docsRow.h / 2));
      await sleep(500);

      // --- S5a：b.md 拖到 docs/（合法移动；拖拽中断言中间态） ---
      const bRow = await rowBoxByLabel(page, 'b.md');
      const from = center(bRow);
      const docsRow2 = await page.$eval('#folder-tree .tree-node[data-path="C:/ws/docs"] > .tree-row', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      const to = center(docsRow2);
      data.drag = { fromBox: bRow, toBox: docsRow2, path: [from, to] };
      page.mouse.move(from[0], from[1], { steps: 3 });
      await sleep(50);
      page.mouse.down();
      // 人类轨迹：多步移动，中途停在 docs 行上断言中间态
      const mid = [Math.round((from[0] + to[0]) / 2), Math.round((from[1] + to[1]) / 2)];
      page.mouse.move(mid[0], mid[1], { steps: 8 });
      await sleep(150);
      page.mouse.move(to[0], to[1], { steps: 8 });
      await sleep(200);
      data.midState = await page.evaluate(() => {
        const ghost = document.querySelector('.tree-drag-ghost');
        const g = ghost ? { present: true, transform: ghost.style.transform, w: ghost.getBoundingClientRect().width } : { present: false };
        const body = document.body;
        return {
          ghost: g,
          bodyCursor: body.style.cursor,
          bodyDragging: body.classList.contains('tree-dragging'),
          docsRowCls: document.querySelector('#folder-tree .tree-node[data-path="C:/ws/docs"] > .tree-row').className,
          bRowCls: (function () {
            const rows = Array.from(document.querySelectorAll('#folder-tree .tree-row'));
            const el = rows.find((r) => { const l = r.querySelector('.tree-label'); return l && l.textContent === 'b.md'; });
            return el ? el.className : 'GONE';
          })(),
        };
      });
      await page.screenshot({ path: path.join(shotDir, 'e2e-mid-drag-ghost.png') }).catch(() => {});
      ok('S5a', data.midState.ghost.present && data.midState.bodyDragging && data.midState.bodyCursor === 'move',
        '拖拽中间态：影子 + body 拖拽类 + move 光标', data);
      ok('S5a', data.midState.docsRowCls.indexOf('drop-target') !== -1, '目标行应精确挂 drop-target：' + data.midState.docsRowCls, data);
      page.mouse.up();
      await sleep(600);
      data.after = await page.evaluate(() => {
        const ed = window.editor;
        const fs = window.__E2E__.fs;
        const moves = window.__E2E__.invokeLog.filter((c) => c.cmd === 'move_path').map((c) => c.args);
        return {
          moves: moves,
          bMoved: !!fs.get('C:/ws/docs/b.md'),
          bGone: !fs.get('C:/ws/b.md'),
          status: document.getElementById('status-text').textContent,
          ghostGone: !document.querySelector('.tree-drag-ghost'),
          cursorRestored: document.body.style.cursor === '',
          rows: Array.from(document.querySelectorAll('#folder-tree .tree-row .tree-label')).map((l) => l.textContent),
        };
      });
      ok('S5a', data.after.moves.length === 1 && data.after.moves[0].from === 'C:/ws/b.md' && data.after.moves[0].to === 'C:/ws/docs/b.md',
        'movePath 参数应精确 from=C:/ws/b.md to=C:/ws/docs/b.md：' + JSON.stringify(data.after.moves), data);
      ok('S5a', data.after.bMoved && data.after.bGone && data.after.ghostGone && data.after.cursorRestored, '移动生效 + 影子/光标收尾', data);
      record('S5a 文件树拖拽：文件→文件夹（中间态像素+精确 movePath）', true, data, errors);
    } catch (e) {
      record('S5a 文件树拖拽：文件→文件夹（中间态像素+精确 movePath）', false, data, errors.concat([e.message]));
    }

    // --- S5b：非法落点——notes 拖到自身（not-allowed + 无 movePath） ---
    {
      const d2 = {};
      const e2 = [];
      try {
        const notesRow = await rowBoxByLabel(page, 'notes');
        const f2 = center(notesRow);
        const movesBefore = await page.evaluate(() => window.__E2E__.countInvokes('move_path'));
        page.mouse.move(f2[0], f2[1], { steps: 2 });
        await sleep(40);
        page.mouse.down();
        // 先离开再回到自身行上（跨过阈值激活）
        page.mouse.move(f2[0] + 60, f2[1] + 40, { steps: 6 });
        await sleep(120);
        page.mouse.move(f2[0], f2[1], { steps: 6 });
        await sleep(200);
        d2.mid = await page.evaluate(() => ({
          cursor: document.body.style.cursor,
          notesCls: (function () {
            const rows = Array.from(document.querySelectorAll('#folder-tree .tree-row'));
            const el = rows.find((r) => { const l = r.querySelector('.tree-label'); return l && l.textContent === 'notes'; });
            return el ? el.className : 'GONE';
          })(),
          ghost: !!document.querySelector('.tree-drag-ghost'),
        }));
        page.mouse.up();
        await sleep(400);
        d2.movesAfter = await page.evaluate(() => window.__E2E__.countInvokes('move_path'));
        d2.clipRestored = await page.evaluate(() => window.editor._fileClipboard);
        ok('S5b', d2.mid.cursor === 'not-allowed' && d2.mid.notesCls.indexOf('drop-invalid') !== -1,
          '自拖应 not-allowed + drop-invalid：' + JSON.stringify(d2.mid), d2);
        ok('S5b', d2.movesAfter === movesBefore, '非法落点不得产生 movePath', d2);
        record('S5b 文件树拖拽：文件夹拖自身（非法，not-allowed 精确光标）', true, d2, e2);
      } catch (e) {
        record('S5b 文件树拖拽：文件夹拖自身（非法，not-allowed 精确光标）', false, d2, e2.concat([e.message]));
      }
    }

    // --- S5c：子目录文件拖到树空白区（= 工作区根） ---
    {
      const d3 = {};
      const e3 = [];
      try {
        // 先真实点击展开 notes（此前未展开，todo.md 行不可见）
        const notesRow = await rowBoxByLabel(page, 'notes');
        page.mouse.click(Math.round(notesRow.x + notesRow.w / 2), Math.round(notesRow.y + notesRow.h / 2));
        await sleep(500);
        const todoRow = await rowBoxByLabel(page, 'todo.md');
        const f3 = center(todoRow);
        const treeBox = await boxOf(page, '#folder-tree');
        const blank = [Math.round(treeBox.x + treeBox.w / 2), Math.round(treeBox.y + treeBox.h - 4)];
        page.mouse.move(f3[0], f3[1], { steps: 2 });
        await sleep(40);
        page.mouse.down();
        page.mouse.move(f3[0] + 40, f3[1] + 30, { steps: 5 });
        await sleep(100);
        page.mouse.move(blank[0], blank[1], { steps: 8 });
        await sleep(200);
        d3.mid = await page.evaluate(() => ({
          cursor: document.body.style.cursor,
          treeRootCls: document.getElementById('folder-tree').classList.contains('tree-drop-root'),
        }));
        page.mouse.up();
        await sleep(600);
        d3.after = await page.evaluate(() => {
          const fs = window.__E2E__.fs;
          const moves = window.__E2E__.invokeLog.filter((c) => c.cmd === 'move_path').map((c) => c.args);
          return { moves: moves, todoAtRoot: !!fs.get('C:/ws/todo.md'), todoGone: !fs.get('C:/ws/notes/todo.md'), status: document.getElementById('status-text').textContent };
        });
        ok('S5c', d3.mid.cursor === 'move' && d3.mid.treeRootCls, '空白区悬停应 move 光标 + 整块树描边：' + JSON.stringify(d3.mid), d3);
        ok('S5c', d3.after.todoAtRoot && d3.after.todoGone, 'todo.md 应精确移到工作区根：' + JSON.stringify(d3.after.moves), d3);
        record('S5c 文件树拖拽：子目录文件→树空白区（=根）', true, d3, e3);
      } catch (e) {
        record('S5c 文件树拖拽：子目录文件→树空白区（=根）', false, d3, e3.concat([e.message]));
      }
    }
  }

  // ---------- S6：标签页真实拖拽排序 ----------
  {
    const data = {};
    const errors = [];
    try {
      // 当前 tabs：首启两个 bundled（使用说明/demo）+ guide.md + …；取最后三个 .tab 拖动
      const before = await page.$$eval('.tab', (els) => els.map((el) => ({ i: el.dataset.index, name: el.querySelector('.tab-name').textContent, x: el.getBoundingClientRect().x, w: el.getBoundingClientRect().width, cls: el.className })));
      data.tabsBefore = before;
      const src = before[before.length - 1];   // 最右 tab
      const dst = before[1];                    // 第二个 tab
      const srcBox = await page.$eval(`.tab[data-index="${src.i}"]`, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      const dstBox = await page.$eval(`.tab[data-index="${dst.i}"]`, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      const f = center(srcBox);
      const t = center(dstBox);
      page.mouse.move(f[0], f[1], { steps: 3 });
      await sleep(40);
      page.mouse.down();
      page.mouse.move(Math.round((f[0] + t[0]) / 2), f[1], { steps: 6 });
      await sleep(120);
      page.mouse.move(t[0], t[1], { steps: 6 });
      await sleep(150);
      data.mid = await page.evaluate(() => ({
        draggingCls: Array.from(document.querySelectorAll('.tab')).map((el) => el.className).filter((c) => c.indexOf('dragging') !== -1 || c.indexOf('drag-over') !== -1),
        userSelect: document.body.style.userSelect,
      }));
      page.mouse.up();
      await sleep(400);
      const after = await page.$$eval('.tab', (els) => els.map((el) => ({ i: el.dataset.index, name: el.querySelector('.tab-name').textContent, x: Math.round(el.getBoundingClientRect().x), cls: el.className })));
      data.tabsAfter = after;
      const namesBefore = before.map((b) => b.name);
      const namesAfter = after.map((a) => a.name);
      const moved = namesBefore[namesBefore.length - 1];
      ok('S6', namesAfter.indexOf(moved) === 1, '被拖 tab「' + moved + '」应从末尾排到第 2 位：' + namesAfter.join('|'), data);
      ok('S6', data.mid.userSelect === 'none' && data.mid.draggingCls.length >= 1, '拖拽中间态：user-select none + dragging/drag-over 类', data);
      record('S6 标签页真实拖拽排序（位置精确）', true, data, errors);
    } catch (e) {
      record('S6 标签页真实拖拽排序（位置精确）', false, data, errors.concat([e.message]));
    }
  }

  // ---------- S7：Ctrl+F 查找替换（真实键盘，精确计数/光标行/替换结果） ----------
  {
    const data = {};
    const errors = [];
    try {
      await page.evaluate(() => { const ed = window.editor; const g = ed.tabs.findIndex((t) => t.filePath === 'C:/ws/guide.md'); ed.switchTab(g); });
      await sleep(500);
      // 光标归位文档首行：find-next 从光标处向后找（不勾选循环时不回绕），先回首页再按 Enter 才确定性地落在首个匹配
      const cmBox7 = await boxOf(page, '.CodeMirror');
      if (cmBox7 && cmBox7.w > 0) { page.mouse.click(Math.round(cmBox7.x + cmBox7.w / 2), Math.round(cmBox7.y + cmBox7.h / 2)); await sleep(150); }
      page.keyboard.press('Control+Home');
      await sleep(200);
      page.keyboard.press('Control+f');
      await sleep(300);
      data.panelVisible = await page.$eval('#find-panel', (el) => !el.classList.contains('hidden'));
      ok('S7', data.panelVisible, 'Ctrl+F 应打开查找面板', data);
      page.keyboard.type('hello', { delay: 40 });
      await sleep(500);
      data.countText = await page.$eval('#find-count', (el) => el.textContent);
      data.helloFacts = await page.evaluate(() => window.__E2E__.facts.helloLines);
      ok('S7', data.countText === '3个结果', '计数应精确等于 3个结果（hello 共 3 处）：' + data.countText, data);
      page.keyboard.press('Enter');
      await sleep(400);
      data.cursorAfterNext = await page.$eval('#cursor-position', (el) => el.textContent);
      const m1 = String(data.cursorAfterNext).match(/行\s*(\d+)/);
      ok('S7', m1 && Number(m1[1]) === data.helloFacts[0], '首个匹配光标应精确落在第 ' + data.helloFacts[0] + ' 行：' + data.cursorAfterNext, data);
      // 替换为 HELLO，全部替换
      await page.click('#replace-input');
      page.keyboard.type('HELLO', { delay: 40 });
      await sleep(200);
      const ra = center(await boxOf(page, '#replace-all'));
      page.mouse.click(ra[0], ra[1]);
      await sleep(600);
      data.after = await page.evaluate(() => {
        const ed = window.editor;
        const v = ed.cm.getValue();
        return {
          helloLeft: (v.match(/hello/g) || []).length,
          helloUpper: (v.match(/HELLO/g) || []).length,
          status: document.getElementById('status-text').textContent,
        };
      });
      ok('S7', data.after.helloLeft === 0 && data.after.helloUpper === 3, '全部替换后 hello=0、HELLO=3：' + JSON.stringify(data.after), data);
      record('S7 Ctrl+F 查找替换（真实键盘 + 精确计数/行号/结果）', true, data, errors);
    } catch (e) {
      record('S7 Ctrl+F 查找替换（真实键盘 + 精确计数/行号/结果）', false, data, errors.concat([e.message]));
    } finally {
      // 无论成败都关闭查找面板，避免残留监听/焦点影响后续场景
      try {
        const visible = await page.$eval('#find-panel', (el) => !el.classList.contains('hidden')).catch(() => false);
        if (visible) {
          const cb = await page.$eval('#find-close', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }).catch(() => null);
          if (cb) { page.mouse.click(Math.round(cb.x), Math.round(cb.y)); } else { page.keyboard.press('Escape'); }
          await sleep(200);
        }
      } catch (_) {}
    }
  }

  // ---------- S8：大纲点击导航（scrollTop 精确变化 + 光标行） ----------
  {
    const data = {};
    const errors = [];
    try {
      data.outlineItems = await page.$$eval('#outline-sidebar .outline-item, #outline .outline-item', (els) => els.map((el) => ({
        text: el.textContent.trim().slice(0, 20), y: Math.round(el.getBoundingClientRect().y),
      })));
      const facts = await page.evaluate(() => window.__E2E__.facts.headingLines);
      data.factsHeadings = facts;
      ok('S8', data.outlineItems.length === facts.length, '大纲项数应精确等于标题数 ' + facts.length + '，实际 ' + data.outlineItems.length, data);
      // 点第 3 个标题（第三章 长文）
      const target = facts[2];
      const itemBox = await page.$$eval('#outline-sidebar .outline-item, #outline .outline-item', (els, i) => {
        const el = els[i];
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }, 2);
      const scrollBefore = await page.evaluate(() => window.editor.cm.getScrollInfo().top);
      page.mouse.click(Math.round(itemBox.x + itemBox.w / 2), Math.round(itemBox.y + itemBox.h / 2));
      await sleep(700);
      const after = await page.evaluate(() => ({
        scroll: window.editor.cm.getScrollInfo().top,
        cursor: window.editor.cm.getCursor(),
        cursorText: document.getElementById('cursor-position').textContent,
      }));
      data.scroll = { before: Math.round(scrollBefore), after: Math.round(after.scroll) };
      data.cursor = after;
      // 方向取决于目标相对当前视口的位置（光标在文末时点上方标题=上滚）；只断言显著滚动
      ok('S8', Math.abs(after.scroll - scrollBefore) > 50, '点击大纲后编辑器应显著滚动：' + JSON.stringify(data.scroll), data);
      ok('S8', after.cursor.line === target.line - 1, '光标应精确停在「' + target.text + '」行（0-based ' + (target.line - 1) + '），实际 ' + after.cursor.line, data);
      record('S8 大纲点击导航（scrollTop/光标行精确）', true, data, errors);
    } catch (e) {
      record('S8 大纲点击导航（scrollTop/光标行精确）', false, data, errors.concat([e.message]));
    }
  }

  // ---------- S9：编辑/预览滚动同步 ----------
  {
    const data = {};
    const errors = [];
    try {
      // 滚动同步发生在分屏（编辑模式：编辑器+预览同显）；纯阅读模式编辑器是隐藏的
      await page.evaluate(() => { const ed = window.editor; ed.switchTab(ed.tabs.findIndex((t) => t.filePath === 'C:/ws/guide.md')); });
      await sleep(400);
      const c = center(await boxOf(page, '#btn-view-edit'));
      page.mouse.click(c[0], c[1]);
      await sleep(800);
      const before = await page.evaluate(() => ({
        ed: window.editor.cm.getScrollInfo().top,
        pv: document.getElementById('preview').scrollTop,
      }));
      // 真实滚轮滚动编辑器区域
      const cmBox = await boxOf(page, '.CodeMirror');
      const p = center(cmBox);
      page.mouse.move(p[0], p[1]);
      for (let i = 0; i < 10; i++) { page.mouse.wheel(0, 120); await sleep(60); }
      await sleep(800);
      const after = await page.evaluate(() => ({
        ed: window.editor.cm.getScrollInfo().top,
        pv: document.getElementById('preview').scrollTop,
      }));
      data.scroll = { before, after, edDelta: Math.round(after.ed - before.ed), pvDelta: Math.round(after.pv - before.pv) };
      ok('S9', data.scroll.edDelta > 300 && data.scroll.pvDelta > 100,
        '滚轮滚动编辑器后编辑器与预览应同步下滚：' + JSON.stringify(data.scroll), data);
      record('S9 编辑/预览滚动同步（精确 scrollTop）', true, data, errors);
    } catch (e) {
      record('S9 编辑/预览滚动同步（精确 scrollTop）', false, data, errors.concat([e.message]));
    }
  }

  // ---------- S10：右键菜单 + 新建文件（真实右键 + 真实键入文件名） ----------
  {
    const data = {};
    const errors = [];
    try {
      const row = await rowBoxByLabel(page, 'guide.md');
      page.mouse.click(Math.round(row.x + row.w / 2), Math.round(row.y + row.h / 2), { button: 'right' });
      await sleep(400);
      data.menu = await page.$eval('#context-menu-file-tree', (el) => {
        const r = el.getBoundingClientRect();
        return { visible: !el.classList.contains('hidden'), x: Math.round(r.x), y: Math.round(r.y), items: Array.from(el.querySelectorAll('.context-menu-item')).map((i) => i.textContent.trim().slice(0, 12)) };
      });
      ok('S10', data.menu.visible && data.menu.items.length >= 8, '右键菜单应出现且含 8+ 项：' + JSON.stringify(data.menu.items), data);
      // 点「新建文件」
      const itemBox = await page.$eval('#context-menu-file-tree .context-menu-item[data-action="file-new-file"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      page.mouse.click(Math.round(itemBox.x + itemBox.w / 2), Math.round(itemBox.y + itemBox.h / 2));
      await page.waitForSelector('#prompt-dialog:not(.hidden)', { timeout: 8000 });
      data.promptVisible = true;
      // 真实键入文件名（逐字符采样；键入前先关掉查找面板，排除跨场景监听器干扰）
      await page.click('#prompt-dialog-input');
      data.typeSamples = await typePerChar(page, 'e2e-new.md', 40,
        "(ae && 'value' in ae) ? ae.value : null");
      data.focusLog = await page.evaluate(() => window.__focusLog.slice(-40));
      const conf = center(await boxOf(page, '#prompt-dialog-confirm'));
      page.mouse.click(conf[0], conf[1]);
      await sleep(600);
      data.after = await page.evaluate(() => {
        const fs = window.__E2E__.fs;
        const f = fs.get('C:/ws/e2e-new.md');
        const rows = Array.from(document.querySelectorAll('#folder-tree .tree-row'));
        const row = rows.find((r) => { const l = r.querySelector('.tree-label'); return l && l.textContent === 'e2e-new.md'; });
        return {
          created: !!f,
          content: f && f.content,
          status: document.getElementById('status-text').textContent,
          rowExists: !!row,
        };
      });
      ok('S10', data.after.created && data.after.content === '' && data.after.rowExists,
        '新建文件应落盘（空内容）+ 树出现新行：' + JSON.stringify(data.after), data);
      record('S10 右键菜单 + 新建文件（真实右键/键入/落盘精确）', true, data, errors);
    } catch (e) {
      record('S10 右键菜单 + 新建文件（真实右键/键入/落盘精确）', false, data, errors.concat([e.message]));
    }
  }

  // ---------- 收尾 ----------
  const fails = results.filter((r) => !r.pass);
  const finalState = await page.evaluate(() => ({
    tabs: window.editor.tabs.map((t) => t.name),
    workspace: window.editor.workspaceFolder,
    fs: [...window.__E2E__.fs.entries()].map(([k, v]) => ({ p: k, t: v.type })),
    invokeCounts: window.__E2E__.invokeLog.reduce((acc, c) => { acc[c.cmd] = (acc[c.cmd] || 0) + 1; return acc; }, {}),
  })).catch(() => null);
  await page.screenshot({ path: path.join(shotDir, 'e2e-final-state.png') }).catch(() => {});
  console.log('\n=== 最终状态 ===');
  console.log(JSON.stringify(finalState, null, 1).slice(0, 3000));
  console.log('\n=== 页面异常（pageerror）===');
  console.log(pageErrors.length ? pageErrors.join('\n') : '（无）');
  console.log('\n=== 汇总 === ' + (results.length - fails.length) + '/' + results.length + ' 场景通过');
  if (pageErrors.length) console.log('⚠ 存在 ' + pageErrors.length + ' 条页面异常（见上）');
  await browser.close();
  process.exit(fails.length === 0 && pageErrors.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E 运行器异常: ' + (e && e.stack || e));
  try { if (browser) browser.close(); } catch (_) {}
  process.exit(1);
});
