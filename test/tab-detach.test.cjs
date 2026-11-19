// 撕离动作 detachTabToWindow 回归测试(tab-tearoff-window Task 4):
// - 撕离写交接键并建窗(label 最小空位、几何级联、slot=既有数+1)
// - 源窗口移除 tab 且活动索引正确(活动/非活动/唯一 tab 进空态)
// - 未保存未命名 tab 完整随迁(payload 含 savedContent,无 filePath)
// - 建窗失败 → tab 保留、交接键清除、返回 false
// - 菜单 action 'tab-open-in-window' 分发 + 快捷键默认项/全局 handler 绑定
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');
const MW = require('../src/modules/multi-window.js');
const SHORTCUTS = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'shortcuts.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

async function makeEditor() {
  const { w, getInitErr } = await buildEnv({ captureInitErr: true });
  await delay(300);
  return { w, ed: w.editor, getInitErr };
}

// 标准主窗口几何 mock(Tauri JS API 形态:physical + scaleFactor,Detach 实现内换算 logical)
function mockMainWindow(w, base) {
  w.TauriApi.currentWindow = () => ({
    label: 'main',
    innerPosition: async () => ({ x: base.x, y: base.y }),
    outerSize: async () => ({ width: base.width, height: base.height }),
    scaleFactor: async () => 1,
  });
}

test('detach: 撕离写交接键并建窗(label=editor-1、几何级联 slot=1)', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const created = [];
    w.TauriApi.listEditorWindows = async () => [];
    w.TauriApi.createEditorWindow = async (label, geom) => { created.push({ label, geom }); return { label }; };
    mockMainWindow(w, { x: 100, y: 80, width: 1200, height: 800 });

    await ed.addTab('a.md', '# A', 'D:/a.md');
    const ok = await ed.detachTabToWindow(ed.tabs.length - 1);
    assert.equal(ok, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].label, 'editor-1');
    assert.deepEqual(created[0].geom, { x: 128, y: 108, width: 1200, height: 800 });

    // 交接键内容可读回,消费即清
    const payload = MW.readHandoff('editor-1', w.localStorage);
    assert.ok(payload, '交接键应存在');
    assert.equal(payload.tab.filePath, 'D:/a.md');
    assert.equal(MW.readHandoff('editor-1', w.localStorage) !== null, true, '分离窗口未消费前键保留');
    MW.clearHandoff('editor-1', w.localStorage);
  } finally { cleanup(w); }
});

test('detach: 未保存未命名 tab 完整随迁(savedContent 随行,无 filePath)', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => [];
    w.TauriApi.createEditorWindow = async () => ({ label: 'editor-1' });
    mockMainWindow(w, { x: 0, y: 0, width: 1200, height: 800 });

    await ed.addTab('未命名0', '初始');
    const tab = ed.tabs[ed.tabs.length - 1];
    tab.content = '## 未保存的草稿'; // 模拟用户改了没存
    tab.savedContent = '';
    await ed.detachTabToWindow(ed.tabs.length - 1);

    const payload = MW.readHandoff('editor-1', w.localStorage);
    assert.equal(payload.tab.content, '## 未保存的草稿');
    assert.equal(payload.tab.savedContent, '', 'savedContent 必须随迁(isModified 语义)');
    assert.equal(payload.tab.filePath, null);
    MW.clearHandoff('editor-1', w.localStorage);
  } finally { cleanup(w); }
});

test('detach: 撕活动 tab → tab 移除且活动索引正确;撕唯一 tab → 空态', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => [];
    w.TauriApi.createEditorWindow = async () => ({ label: 'editor-1' });
    mockMainWindow(w, { x: 0, y: 0, width: 1200, height: 800 });

    await ed.addTab('a.md', '# A', 'D:/a.md');
    await ed.addTab('b.md', '# B', 'D:/b.md');
    const bIdx = ed.tabs.findIndex(t => t.filePath === 'D:/b.md');
    await ed.switchTab(bIdx); // 活动为 b
    await ed.detachTabToWindow(bIdx);
    assert.equal(ed.tabs.some(t => t.filePath === 'D:/b.md'), false, 'b.md 应被移除');
    assert.ok(ed.tabs.some(t => t.filePath === 'D:/a.md'), 'a.md 应保留');

    // 其余 tab 逐一撕离 → 空态哨兵 -1
    while (ed.tabs.length) {
      await ed.detachTabToWindow(ed.tabs.length - 1);
    }
    assert.equal(ed.tabs.length, 0);
    assert.equal(ed.activeTabIndex, -1);
    const welcome = w.document.getElementById('empty-welcome');
    assert.ok(welcome && !welcome.classList.contains('hidden'), '空态欢迎页应可见');
  } finally { cleanup(w); }
});

test('detach: 建窗失败 → tab 保留、交接键清除、返回 false', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => [];
    w.TauriApi.createEditorWindow = async () => null; // tauri://error / 浏览器降级
    mockMainWindow(w, { x: 0, y: 0, width: 1200, height: 800 });

    await ed.addTab('a.md', '# A', 'D:/a.md');
    const n = ed.tabs.length;
    const ok = await ed.detachTabToWindow(0);
    assert.equal(ok, false);
    assert.equal(ed.tabs.length, n, 'tab 必须保留(不静默丢内容)');
    assert.equal(MW.readHandoff('editor-1', w.localStorage), null, '交接键应已清除');
  } finally { cleanup(w); }
});

test('detach/copy: 菜单 action 分发——tab-open-in-window=复制保留,tab-move-to-window=移动', async () => {
  const { w, ed } = await makeEditor();
  try {
    let moved = null;
    let copied = null;
    const origMove = ed.detachTabToWindow.bind(ed);
    const origCopy = ed.copyTabToWindow.bind(ed);
    ed.detachTabToWindow = async (i) => { moved = i; return true; };
    ed.copyTabToWindow = async (i) => { copied = i; return true; };
    ed._contextTabIndex = 2;
    ed.executeMenuAction('tab-move-to-window');
    assert.equal(moved, 2, '「移动到新窗口」应走 detachTabToWindow');
    ed.executeMenuAction('tab-open-in-window');
    assert.equal(copied, 2, '「在新窗口打开」应走 copyTabToWindow(原窗口保留)');
    ed.detachTabToWindow = origMove;
    ed.copyTabToWindow = origCopy;
  } finally { cleanup(w); }
});

test('copy: 原窗口保留 tab(复制语义),交接键照常写入', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => [];
    w.TauriApi.createEditorWindow = async (label) => ({ label });
    mockMainWindow(w, { x: 0, y: 0, width: 1200, height: 800 });
    await ed.addTab('a.md', '# A', 'D:/a.md');
    const aIdx = ed.tabs.findIndex(t => t.filePath === 'D:/a.md');
    const before = ed.tabs.length;
    const ok = await ed.copyTabToWindow(aIdx);
    assert.equal(ok, true);
    assert.equal(ed.tabs.length, before, '复制语义:原窗口 tab 保留');
    assert.ok(ed.tabs.some(t => t.filePath === 'D:/a.md'), '文档仍在本窗口');
    const payload = MW.readHandoff('editor-1', w.localStorage);
    assert.ok(payload, '交接键应写入(新窗口开副本)');
    assert.equal(payload.tab.filePath, 'D:/a.md');
    MW.clearHandoff('editor-1', w.localStorage);
  } finally { cleanup(w); }
});

test('copy: 快捷键 Ctrl+Shift+O 绑定 copyTabToWindow + app.js 双 case', () => {
  assert.ok(/openTabInWindow:\s*\{\s*key:\s*'Ctrl\+Shift\+O'/.test(SHORTCUTS),
    'getDefaultShortcuts 应含 openTabInWindow: Ctrl+Shift+O');
  assert.ok(/openTabInWindow:\s*\(\)\s*=>\s*this\.copyTabToWindow\(this\.activeTabIndex\)/.test(SHORTCUTS),
    'globalMap 应绑定 openTabInWindow → copyTabToWindow(activeTabIndex)');
  assert.ok(APP.includes("case 'tab-open-in-window': this.copyTabToWindow(this._contextTabIndex); break;"),
    "app.js executeMenuAction 应含 tab-open-in-window=复制 case");
  assert.ok(APP.includes("case 'tab-move-to-window': this.detachTabToWindow(this._contextTabIndex); break;"),
    "app.js executeMenuAction 应含 tab-move-to-window=移动 case");
});

test('detach: 并发守卫——在途第二次调用拒绝,交接键不被覆盖', async () => {
  // 终审 Critical 2 回归:两次在途撕离都从同一陈旧 listEditorWindows 快照取 label,
  // 第二次 writeHandoff 会覆盖第一份 → create 失败后 clearHandoff 把第一份唯一副本删掉。
  const { w, ed } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => [];
    w.TauriApi.createEditorWindow = async (label) => { await delay(80); return { label }; };
    mockMainWindow(w, { x: 0, y: 0, width: 1200, height: 800 });
    await ed.addTab('a.md', '# A', 'D:/a.md');
    await ed.addTab('b.md', '# B', 'D:/b.md');
    const aIdx = ed.tabs.findIndex(t => t.filePath === 'D:/a.md');
    const p1 = ed.detachTabToWindow(aIdx);
    const ok2 = await ed.detachTabToWindow(ed.tabs.length - 1); // 第一次仍在途
    const ok1 = await p1;
    assert.equal(ok1, true);
    assert.equal(ok2, false, '在途第二次应被守卫拒绝');
    const payload = MW.readHandoff('editor-1', w.localStorage);
    assert.ok(payload, '第一份交接键不得被覆盖/清除');
    assert.equal(payload.tab.filePath, 'D:/a.md');
    MW.clearHandoff('editor-1', w.localStorage);
  } finally { cleanup(w); }
});

test('drag: 拖出窗口边界松手 → 复制(原窗口保留,落点建窗)', async () => {
  // 二期拖拽撕离:复用指针拖拽基础设施,越界 mouseup 触发 _openTabInWindow。
  // 默认复制语义(原窗口保留,用户 2026-11-18 定);Ctrl/Cmd+拖拽 = 移动。
  const { w, ed } = await makeEditor();
  try {
    const created = [];
    w.TauriApi.listEditorWindows = async () => [];
    w.TauriApi.createEditorWindow = async (label, geom) => { created.push({ label, geom }); return { label }; };
    mockMainWindow(w, { x: 100, y: 80, width: 1200, height: 800 });
    await ed.addTab('a.md', '# A', 'D:/a.md');
    await ed.addTab('b.md', '# B', 'D:/b.md');
    const aIdx = ed.tabs.findIndex(t => t.filePath === 'D:/a.md');
    const tabEl = w.document.querySelector(`.tab[data-index="${aIdx}"]`);
    const fire = (type, x, y, target, mods) => {
      target.dispatchEvent(new w.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }, mods || {})));
    };
    fire('mousedown', 50, 12, tabEl);
    fire('mousemove', 60, 20, w.document);   // 越过 5px 阈值激活
    fire('mousemove', 60, -30, w.document);  // 拖出上边界
    fire('mouseup', 60, -30, w.document);
    await delay(30);
    assert.equal(created.length, 1, '越界松手应建新窗');
    // 落点建窗:base(100,80)+client(60,-30) → (160,50)
    assert.equal(created[0].geom.x, 160, '新窗左上角 = 窗口原点+落点');
    assert.equal(created[0].geom.y, 50);
    assert.equal(ed.tabs.some(t => t.filePath === 'D:/a.md'), true, '复制语义:原窗口文档保留');
    const payload = MW.readHandoff('editor-1', w.localStorage);
    assert.ok(payload && payload.tab.filePath === 'D:/a.md', '交接键随迁');
    MW.clearHandoff('editor-1', w.localStorage);

    // Ctrl+拖拽 = 移动语义(原窗口移除)
    const aIdx2 = ed.tabs.findIndex(t => t.filePath === 'D:/a.md');
    const tabEl2 = w.document.querySelector(`.tab[data-index="${aIdx2}"]`);
    fire('mousedown', 50, 12, tabEl2);
    fire('mousemove', 60, 20, w.document);
    fire('mouseup', 60, -30, w.document, { ctrlKey: true });
    await delay(30);
    assert.equal(created.length, 2, 'Ctrl+拖拽仍建新窗');
    assert.equal(ed.tabs.some(t => t.filePath === 'D:/a.md'), false, 'Ctrl+拖拽 = 移动:原窗口 tab 移除');
    MW.clearHandoff('editor-1', w.localStorage);
  } finally { cleanup(w); }
});

test('drag: 窗口内松手不撕离,既有重排不受影响', async () => {
  const { w, ed } = await makeEditor();
  try {
    let created = 0;
    w.TauriApi.listEditorWindows = async () => [];
    w.TauriApi.createEditorWindow = async (label, geom) => { created++; return { label }; };
    mockMainWindow(w, { x: 0, y: 0, width: 1200, height: 800 });
    await ed.addTab('a.md', '# A', 'D:/a.md');
    await ed.addTab('b.md', '# B', 'D:/b.md');
    const names0 = ed.tabs.map(t => t.name);
    const tabEl0 = w.document.querySelector('.tab[data-index="0"]');
    const fire = (type, x, y, target) => {
      target.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    };
    // 窗口内拖动并松手:elementFromPoint mock 不了逐点位,此处不命中 tab → 不重排、不撕离
    fire('mousedown', 50, 12, tabEl0);
    fire('mousemove', 200, 200, w.document);
    fire('mouseup', 200, 200, w.document);
    await delay(30);
    assert.equal(created, 0, '窗内松手不得建窗撕离');
    assert.deepEqual(ed.tabs.map(t => t.name), names0, '顺序不变');
  } finally { cleanup(w); }
});
