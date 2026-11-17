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

test('detach: 菜单 action 分发到 detachTabToWindow(this._contextTabIndex)', async () => {
  const { w, ed } = await makeEditor();
  try {
    let called = null;
    const orig = ed.detachTabToWindow.bind(ed);
    ed.detachTabToWindow = async (i) => { called = i; return true; };
    ed._contextTabIndex = 2;
    ed.executeMenuAction('tab-open-in-window');
    assert.equal(called, 2);
    ed.detachTabToWindow = orig;
  } finally { cleanup(w); }
});

test('detach: 快捷键默认项 Ctrl+Shift+O + globalMap 绑定 + app.js case', () => {
  assert.ok(/detachTab:\s*\{\s*key:\s*'Ctrl\+Shift\+O'/.test(SHORTCUTS),
    'getDefaultShortcuts 应含 detachTab: Ctrl+Shift+O');
  assert.ok(/detachTab:\s*\(\)\s*=>\s*this\.detachTabToWindow\(this\.activeTabIndex\)/.test(SHORTCUTS),
    'globalMap 应绑定 detachTab → detachTabToWindow(activeTabIndex)');
  assert.ok(APP.includes("case 'tab-open-in-window': this.detachTabToWindow(this._contextTabIndex); break;"),
    "app.js executeMenuAction 应含 tab-open-in-window case");
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
