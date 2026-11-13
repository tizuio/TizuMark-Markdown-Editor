// 标签页操作盲点测试（整理测试库时补充）：
//   addTab / closeTab / switchTab / reorderTab 的纯数据层行为。
// 这些路径会触发 updatePreview / saveSession / updateTabBar 等副作用，测试中以桩隔离，
// 专注验证标签数组与 activeTabIndex 的正确性（与既有 openFilePath 等测试形成互补覆盖）。

const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

// 隔离标签操作涉及的副作用方法，避免触达真实 Tauri 命令 / 渲染器
function stubTabSideEffects(ed) {
  ed.saveSession = () => {};
  ed.updateTabBar = () => {};
  ed.updatePreview = async () => {};
  ed.addRecentFile = () => {};
  ed.ensureTabLoaded = async () => {};
  ed.updateTabDisplay = () => {};
  ed.updateWordCount = () => {};
  ed.updateOutline = () => {};
  ed.updateExternalChangeBanner = () => {};
  ed.highlightTreeActiveFile = () => {};
  ed._beginPaneLoad = () => {};
  ed._endPaneLoad = () => {};
  ed.refreshFileMeta = () => {};
}

test('tab: addTab 追加标签并成为活动标签', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  stubTabSideEffects(ed);
  const before = ed.tabs.length;
  await ed.addTab('a.md', '# hello', null);
  assert.strictEqual(ed.tabs.length, before + 1, 'addTab 应追加一个标签');
  assert.strictEqual(ed.activeTabIndex, ed.tabs.length - 1, '新标签应为活动标签');
  cleanup(w);
});

test('tab: closeTab 移除当前标签', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  stubTabSideEffects(ed);
  ed.showSaveDialog = async () => 'cancel'; // 隔离未保存确认弹窗
  // 先确保至少 2 个标签，验证「移除」而不归零
  await ed.addTab('a.md', '# hello', null);
  const before = ed.tabs.length;
  await ed.closeTab(ed.activeTabIndex);
  assert.strictEqual(ed.tabs.length, before - 1, 'closeTab 应移除一个标签');
  assert.ok(ed.tabs.length >= 1, '还剩一个标签时不应归零');
  cleanup(w);
});

test('tab: closeTab 允许关到 0 标签（activeTabIndex 为 -1 哨兵）', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  stubTabSideEffects(ed);
  ed.showSaveDialog = async () => 'discard';
  while (ed.tabs.length > 0) await ed.closeTab(ed.activeTabIndex);
  assert.strictEqual(ed.tabs.length, 0, '应允许 0 个标签');
  assert.strictEqual(ed.activeTabIndex, -1, '无活动文档时索引为 -1');
  assert.strictEqual(ed.activeTab, undefined);
  cleanup(w);
});

test('tab: switchTab 切换活动标签', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  stubTabSideEffects(ed);
  await ed.addTab('b.md', 'bbb', null); // 至少 2 个标签，活动为最后一个
  const last = ed.activeTabIndex;
  const first = last === 0 ? 1 : 0;
  await ed.switchTab(first);
  assert.strictEqual(ed.activeTabIndex, first, 'switchTab 应切换活动标签');
  cleanup(w);
});

test('tab: reorderTab 调整顺序并跟踪 activeTab', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  stubTabSideEffects(ed);
  await ed.addTab('c.md', 'ccc', null);
  await ed.addTab('d.md', 'ddd', null);
  const orderBefore = ed.tabs.map(t => t.name).join(',');
  const activeBefore = ed.activeTabIndex;
  ed.reorderTab(0, 1); // 把第 0 个拖到第 1 个
  const orderAfter = ed.tabs.map(t => t.name).join(',');
  assert.notStrictEqual(orderAfter, orderBefore, 'reorderTab 应改变顺序');
  if (activeBefore === 0) {
    assert.strictEqual(ed.activeTabIndex, 1, '原活动标签被拖动时，activeTabIndex 应跟随');
  }
  cleanup(w);
});

// 鼠标悬停显示完整路径（含文件名）：带 filePath 的标签 title 应为完整路径，
// 未保存（filePath=null）标签回退为文件名。
test('tab: 带路径标签 hover title 显示完整路径', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  // 隔离与断言无关的副作用，但保留 updateTabBar 真实执行（验证 title 设置）
  ed.saveSession = () => {};
  ed.updatePreview = async () => {};
  ed.addRecentFile = () => {};
  ed.ensureTabLoaded = async () => {};
  ed.updateTabDisplay = () => {};
  ed.updateWordCount = () => {};
  ed.updateOutline = () => {};
  ed.updateExternalChangeBanner = () => {};
  ed.highlightTreeActiveFile = () => {};
  ed._beginPaneLoad = () => {};
  ed._endPaneLoad = () => {};
  ed.refreshFileMeta = () => {};
  const fp = 'C:/Users/admin/docs/demo.md';
  await ed.addTab('demo.md', '# hello', fp);
  const idx = ed.tabs.length - 1;
  const tabEl = w.document.querySelector(`.tab[data-index="${idx}"]`);
  assert.ok(tabEl, '应渲染出标签元素');
  assert.strictEqual(tabEl.getAttribute('title'), fp, 'hover title 应为完整路径');
  cleanup(w);
});

test('tab: 未保存标签 hover title 回退为文件名', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  ed.saveSession = () => {};
  ed.updatePreview = async () => {};
  ed.addRecentFile = () => {};
  ed.ensureTabLoaded = async () => {};
  ed.updateTabDisplay = () => {};
  ed.updateWordCount = () => {};
  ed.updateOutline = () => {};
  ed.updateExternalChangeBanner = () => {};
  ed.highlightTreeActiveFile = () => {};
  ed._beginPaneLoad = () => {};
  ed._endPaneLoad = () => {};
  ed.refreshFileMeta = () => {};
  await ed.addTab('未命名', '', null);
  const idx = ed.tabs.length - 1;
  const tabEl = w.document.querySelector(`.tab[data-index="${idx}"]`);
  assert.ok(tabEl, '应渲染出标签元素');
  assert.strictEqual(tabEl.getAttribute('title'), '未命名', '未保存标签 title 应回退为文件名');
  cleanup(w);
});

// 标签页右键「打开所在目录」：tab 均为文件（markdown），应以 isDir=false 调用
// 通用 openContainingFolder（打开父目录并选中该文件）。
test('tab: openTabContainingFolder 以文件身份调用 openContainingFolder', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  stubTabSideEffects(ed);
  let opened = null;
  ed.openContainingFolder = async (p, d) => { opened = { p, d }; };
  await ed.addTab('demo.md', '# hello', 'C:/Users/admin/docs/demo.md');
  ed._contextTabIndex = ed.tabs.length - 1;
  await ed.openTabContainingFolder(ed._contextTabIndex);
  assert.ok(opened, '应调用 openContainingFolder');
  assert.strictEqual(opened.p, 'C:/Users/admin/docs/demo.md');
  assert.strictEqual(opened.d, false, 'tab 是文件，isDir 应为 false');
  cleanup(w);
});

test('tab: 未保存标签「打开所在目录」提示未保存且不调用', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  stubTabSideEffects(ed);
  let opened = false;
  ed.openContainingFolder = async () => { opened = true; };
  let status = null;
  ed.setStatus = (s) => { status = s; };
  await ed.addTab('未命名', '', null);
  ed._contextTabIndex = ed.tabs.length - 1;
  await ed.openTabContainingFolder(ed._contextTabIndex);
  assert.strictEqual(opened, false, '未保存标签不应调用 openContainingFolder');
  assert.strictEqual(status, ed.t('notSaved'), '应提示未保存');
  cleanup(w);
});

// 右键菜单动作分发已注册 tab-open-containing（防止 case 遗漏导致点击无反应）。
test('tab: executeMenuAction 分发 tab-open-containing 到 openTabContainingFolder', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  stubTabSideEffects(ed);
  let called = false;
  ed.openTabContainingFolder = async () => { called = true; };
  await ed.addTab('demo.md', '# hello', 'C:/x/demo.md');
  ed._contextTabIndex = ed.tabs.length - 1;
  ed.executeMenuAction('tab-open-containing');
  await delay(10); // 等待 async 分支落地
  assert.strictEqual(called, true, 'executeMenuAction 应分发到 openTabContainingFolder');
  cleanup(w);
});
