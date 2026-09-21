// 标签页拖拽排序 —— 回归测试
// 验证：用指针事件（mousedown/mousemove/mouseup）实现的拖拽排序能正确重排 tabs 并跟踪 activeTabIndex。
// 根因背景：Tauri v2 默认 dragDropEnabled 接管原生 HTML5 DnD，导致 draggable+dragstart/dragover/drop 拖不动，
// 故改用指针事件。本测试覆盖核心 reorderTab 逻辑与真实指针事件接线两端。
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const appjs = require('./helpers/app-bundle.cjs').readBundle();
// P1-5：app.js 运行时依赖 window.TauriApi，须先注入 tauri-api.js（同生产 index.html 顺序）。
const tauriApiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'tauri-api.js'), 'utf8');
// 本次重构后 app.js（initEventListeners 内）依赖 window.Select，须先于 app.js 注入（同生产 index.html 顺序）
const selectSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'select.js'), 'utf8');
// P2-1：app.js 构造期 new PreviewController(this) 需要本 facade 先注入（同生产 index.html 顺序）。
const previewControllerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'preview-controller.js'), 'utf8');

const HTML = `<!DOCTYPE html><html><body></body></html>`;
const dom = new JSDOM(HTML, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });

// 注入 Tauri 桩（app.js 顶部 const { invoke } = window.__TAURI__.core 需要；event.listen 让走 Tauri 分支，不挂 app 级文件拖放）
dom.window.__TAURI__ = {
  core: { invoke: () => Promise.resolve(null) },
  path: {}, app: {}, event: { listen: () => Promise.resolve({ unlisten() {} }) }, shell: {},
};
dom.window.__APPJS_SOURCE = appjs;

const harnessFn = function () {
  const results = [];
  if (typeof MarkdownEditor !== 'function') { results.push(['加载', false]); return results; }

  const ed = Object.create(MarkdownEditor.prototype);
  ed.cm = { getScrollInfo: () => ({ top: 0, height: 100 }), scrollTo() {}, refresh() {} };
  ed.t = (k) => k;
  ed.saveSession = () => {};
  ed.updateTabScrollArrows = () => {};
  ed.switchTab = () => {};
  ed.closeTab = () => {};
  ed.clearPreviewHighlight = () => {};
  ed.hideAllContextMenus = () => {};
  ed.refreshRecentFiles = () => {};
  ed.tabs = [
    { name: 'A.md', isModified: false },
    { name: 'B.md', isModified: false },
    { name: 'C.md', isModified: false },
  ];
  ed.activeTabIndex = 1; // B 激活
  ed.settings = { language: 'zh' };

  // 动态创建 app.js 里所有 getElementById 用到的 id（空元素），避免 initEventListeners 因缺元素抛错
  const src = window.__APPJS_SOURCE;
  const ids = [...new Set([...src.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
  // 另有三个工具栏按钮来自 toolbarDropdowns 数组变量（非 getElementById 字面量），需显式补齐
  const extraIds = ['btn-file', 'btn-view', 'btn-help'];
  [...ids, ...extraIds].forEach(id => {
    if (document.getElementById(id)) return;
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  });
  // initEventListeners 里另有用 querySelector 取的容器元素，按需补建
  ['tab-bar-wrapper', 'editor-container', 'editor-pane', 'preview-pane'].forEach(cls => {
    if (document.querySelector('.' + cls)) return;
    const el = document.createElement('div');
    el.className = cls;
    document.body.appendChild(el);
  });
  // 三个工具栏按钮需包在 .dropdown 内（initEventListeners 用 closest('.dropdown')）
  ['btn-file', 'btn-view', 'btn-help'].forEach(bid => {
    const btn = document.getElementById(bid);
    if (btn && !btn.closest('.dropdown')) {
      const dd = document.createElement('div');
      dd.className = 'dropdown';
      btn.parentNode.insertBefore(dd, btn);
      dd.appendChild(btn);
    }
  });

  let initOk = true;
  try { ed.initEventListeners(); } catch (e) { initOk = false; }
  results.push(['initEventListeners 成功挂载（含 document 级鼠标监听）', initOk]);

  // ---- 核心逻辑：reorderTab 直接测（activeTabIndex 跟踪）----
  const t0 = ed.tabs.map(t => t.name);
  ed.reorderTab(0, 2); // [A,B,C] -> [B,C,A]；active 原=1(B)，from0<active1<=to2 → active--
  results.push(['reorderTab(0,2) 顺序正确 [B,C,A]', JSON.stringify(ed.tabs.map(t => t.name)) === JSON.stringify(['B.md', 'C.md', 'A.md'])]);
  results.push(['reorderTab(0,2) active 跟随到 0(B)', ed.activeTabIndex === 0]);

  const t1 = ed.tabs.map(t => t.name);
  ed.reorderTab(2, 0); // [B,C,A] -> [A,B,C]；active 原=0(B)，from2>active0>=to0 → active++
  results.push(['reorderTab(2,0) 顺序正确 [A,B,C]', JSON.stringify(ed.tabs.map(t => t.name)) === JSON.stringify(['A.md', 'B.md', 'C.md'])]);
  results.push(['reorderTab(2,0) active 跟随到 1(B)', ed.activeTabIndex === 1]);

  // 边界：from===to / 越界 不应改动
  const before = JSON.stringify(ed.tabs.map(t => t.name));
  ed.reorderTab(1, 1);
  ed.reorderTab(0, 99);
  ed.reorderTab(-1, 1);
  results.push(['reorderTab 边界(from===to/越界) 不改顺序', JSON.stringify(ed.tabs.map(t => t.name)) === before]);

  // ---- 指针事件接线：真实 mousedown/mousemove/mouseup + mock elementFromPoint ----
  ed.activeTabIndex = 0; // 重置
  ed.updateTabBar(); // 渲染 .tab[data-index]，并挂上真实 per-tab mousedown/click 监听
  const tabEls = [...document.querySelectorAll('.tab')];
  results.push(['updateTabBar 渲染 3 个 .tab', tabEls.length === 3]);

  // mock：elementFromPoint 始终返回「目标 tab」（data-index=2，即 C.md）
  const target = tabEls[2];
  document.elementFromPoint = () => target;

  // 1) mousedown（左键）在 tab0 上 → 记录 _dragState，未激活
  tabEls[0].dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
  results.push(['mousedown 左键记录 _dragState.from=0', !!ed._dragState && ed._dragState.from === 0]);
  results.push(['mousedown 后未激活（active=false）', ed._dragState && ed._dragState.active === false]);

  // 2) mousemove 超阈值(50px) → 激活拖拽，源 tab 加 .dragging，目标 tab 加 .drag-over
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 0, bubbles: true }));
  results.push(['mousemove 超阈值激活拖拽', ed._dragState && ed._dragState.active === true]);
  results.push(['源 tab 加 .dragging', tabEls[0].classList.contains('dragging')]);
  results.push(['目标 tab 加 .drag-over', target.classList.contains('drag-over')]);

  // 3) mouseup → 落点 = tab2（C），reorderTab(0,2)，_dragState 清空
  const orderBefore = ed.tabs.map(t => t.name).join(',');
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: 50, clientY: 0, bubbles: true }));
  results.push(['mouseup 触发 reorder(0,2) 顺序变 [B,C,A]', JSON.stringify(ed.tabs.map(t => t.name)) === JSON.stringify(['B.md', 'C.md', 'A.md'])]);
  results.push(['mouseup 后 _dragState 清空', ed._dragState === null]);
  results.push(['拖拽后 _suppressClick=true（抑制误切换）', ed._suppressClick === true]);
  results.push(['拖拽确实改变了顺序', orderBefore !== ed.tabs.map(t => t.name).join(',')]);

  // 4) 纯点击（mousedown+mouseup 不移动）不应触发拖拽/重排
  const orderPreClick = ed.tabs.map(t => t.name).join(',');
  const fresh = [...document.querySelectorAll('.tab')];
  fresh[1].dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: 0, clientY: 0, bubbles: true }));
  results.push(['无移动点击不触发重排', ed.tabs.map(t => t.name).join(',') === orderPreClick]);
  results.push(['无移动点击不置 _dragState', ed._dragState === null]);

  // 5) 中键 mousedown 不应启动拖拽（应走关闭逻辑，此处 closeTab 已 stub）
  const fresh2 = [...document.querySelectorAll('.tab')];
  fresh2[0].dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: 0, clientY: 0, bubbles: true }));
  results.push(['中键 mousedown 不启动拖拽', ed._dragState === null]);

  return results;
};

const combined = selectSrc + '\n;\n' + tauriApiSrc + '\n;\n' + previewControllerSrc + '\n;\n' + appjs + '\n;window.__harnessPromise = (' + harnessFn.toString() + ')();';
const s = dom.window.document.createElement('script');
s.textContent = combined;
dom.window.document.body.appendChild(s);

const NAMES = [
  'initEventListeners 成功挂载（含 document 级鼠标监听）',
  'reorderTab(0,2) 顺序正确 [B,C,A]',
  'reorderTab(0,2) active 跟随到 0(B)',
  'reorderTab(2,0) 顺序正确 [A,B,C]',
  'reorderTab(2,0) active 跟随到 1(B)',
  'reorderTab 边界(from===to/越界) 不改顺序',
  'updateTabBar 渲染 3 个 .tab',
  'mousedown 左键记录 _dragState.from=0',
  'mousedown 后未激活（active=false）',
  'mousemove 超阈值激活拖拽',
  '源 tab 加 .dragging',
  '目标 tab 加 .drag-over',
  'mouseup 触发 reorder(0,2) 顺序变 [B,C,A]',
  'mouseup 后 _dragState 清空',
  '拖拽后 _suppressClick=true（抑制误切换）',
  '拖拽确实改变了顺序',
  '无移动点击不触发重排',
  '无移动点击不置 _dragState',
  '中键 mousedown 不启动拖拽',
];

for (const name of NAMES) {
  test(name, async () => {
    const results = await dom.window.__harnessPromise;
    const item = results.find(r => r[0] === name);
    assert.ok(item && item[1] === true, name + (item ? '' : ' (结果缺失)'));
  });
}
