// 文件操作扩展测试：newFile / openFilePath 去重与懒加载 / closeTab 未保存弹框 /
// closeOtherTabs / closeAllTabs / copyTabPath / batchSaveTabs / reloadFile
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay, waitForEditor } = require('./helpers/app-env.cjs');

async function makeEditor(invokeImpl) {
  const { w } = await buildEnv({ captureInitErr: true, invokeImpl });
  const ed = await waitForEditor(w);
  // 公共副作用桩
  ed.saveSession = () => {};
  ed.setStatus = () => {};
  ed.updatePreview = async () => {};
  ed.updateTabDisplay = () => {};
  ed.refreshFileMeta = async () => {};
  ed.updateWordCount = () => {};
  return { w, ed };
}

test('fileops-extra: newFile 新建未命名标签并切到编辑模式', async () => {
  const { w, ed } = await makeEditor();
  try {
    const before = ed.tabs.length;
    ed.newFile();
    await delay(20);
    assert.strictEqual(ed.tabs.length, before + 1, '应新增标签');
    assert.strictEqual(ed.activeTabIndex, ed.tabs.length - 1, '新标签应为活动标签');
    assert.strictEqual(ed.activeTab.filePath, null, '新标签无关联路径');
    assert.strictEqual(ed.viewMode, 'edit', '应切到编辑模式');
  } finally { cleanup(w); }
});

test('fileops-extra: openFilePath 打开新文件（read_file + 新标签 + 预览模式）', async () => {
  const calls = [];
  const { w, ed } = await makeEditor(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'read_file') return '# 新文档\r\n第二行';
    return undefined;
  });
  try {
    ed.applyViewMode = () => {};
    ed._beginPaneLoad = () => {};
    ed._endPaneLoad = () => {};
    const before = ed.tabs.length;
    await ed.openFilePath('C:/docs/x.md');
    assert.strictEqual(ed.tabs.length, before + 1, '应新增标签');
    assert.strictEqual(ed.activeTab.filePath, 'C:/docs/x.md');
    assert.strictEqual(ed.activeTab.content, '# 新文档\n第二行', 'CRLF 应归一化为 LF');
    assert.strictEqual(ed.viewMode, 'preview', '打开文件默认进入预览模式');
    assert.ok(calls.some((c) => c.cmd === 'read_file' && c.args.path === 'C:/docs/x.md'));
  } finally { cleanup(w); }
});

test('fileops-extra: openFilePath 去重——已打开路径切标签而非重复读取', async () => {
  const calls = [];
  const { w, ed } = await makeEditor(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'read_file') return 'A 内容';
    return undefined;
  });
  try {
    ed.applyViewMode = () => {};
    ed._beginPaneLoad = () => {};
    ed._endPaneLoad = () => {};
    await ed.openFilePath('C:/docs/a.md');
    await ed.addTab('b.md', 'B 内容', 'C:/docs/b.md'); // 切走
    const count = ed.tabs.length;
    const readsBefore = calls.filter((c) => c.cmd === 'read_file').length;
    await ed.openFilePath('C:/docs/a.md'); // 重复打开
    assert.strictEqual(ed.tabs.length, count, '不应新增标签');
    assert.strictEqual(ed.activeTab.filePath, 'C:/docs/a.md', '应切换到已有标签');
    const readsAfter = calls.filter((c) => c.cmd === 'read_file').length;
    assert.strictEqual(readsAfter, readsBefore, '去重路径不应再次 read_file');
  } finally { cleanup(w); }
});

test('fileops-extra: closeTab 未保存标签——cancel 不关闭 / discard 关闭', async () => {
  const { w, ed } = await makeEditor();
  try {
    await ed.addTab('m.md', '原始', 'C:/tmp/m.md');
    ed.activeTab.savedContent = '原始';
    ed.activeTab.content = '已改动';
    assert.ok(ed.activeTab.isModified, '前置：标签应为已修改');
    const idx = ed.activeTabIndex;
    const total = ed.tabs.length;

    ed.showSaveDialog = async () => 'cancel';
    await ed.closeTab(idx);
    assert.strictEqual(ed.tabs.length, total, 'cancel 不应关闭标签');

    ed.showSaveDialog = async () => 'discard';
    await ed.closeTab(idx);
    assert.strictEqual(ed.tabs.length, total - 1, 'discard 应关闭标签');
    assert.ok(!ed.tabs.some((t) => t.filePath === 'C:/tmp/m.md'), '目标标签应被移除');
  } finally { cleanup(w); }
});

test('fileops-extra: closeOtherTabs 仅保留指定标签', async () => {
  const { w, ed } = await makeEditor();
  try {
    // harness 初始化的某些 tab 可能处于已修改状态，closeOtherTabs 会弹保存对话框；
    // 这里模拟用户选择 discard（对话框是事件驱动，不点按钮会永久挂起）。
    ed.showSaveDialog = async () => 'discard';
    await ed.addTab('a.md', 'A', 'C:/t/a.md');
    await ed.addTab('b.md', 'B', 'C:/t/b.md');
    const keep = ed.tabs.findIndex((t) => t.filePath === 'C:/t/a.md');
    await ed.closeOtherTabs(keep);
    assert.strictEqual(ed.tabs.length, 1, '应只剩一个标签');
    assert.strictEqual(ed.tabs[0].filePath, 'C:/t/a.md');
    assert.strictEqual(ed.activeTabIndex, 0);
  } finally { cleanup(w); }
});

test('fileops-extra: closeAllTabs 关闭全部后进入空态（0 标签）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSaveDialog = async () => 'discard';
    await ed.addTab('a.md', 'A', 'C:/t/a.md');
    await ed.addTab('b.md', 'B', 'C:/t/b.md');
    await ed.closeAllTabs();
    assert.strictEqual(ed.tabs.length, 0, '应允许关闭所有标签');
    assert.strictEqual(ed.activeTabIndex, -1);
    assert.strictEqual(ed.cm.getValue(), '', '编辑器应清空');
    assert.ok(!w.document.getElementById('empty-welcome').classList.contains('hidden'),
      '应显示空态欢迎页');
  } finally { cleanup(w); }
});

test('fileops-extra: closeAllTabs 有未保存修改且 cancel 时不关闭', async () => {
  const { w, ed } = await makeEditor();
  try {
    await ed.addTab('a.md', 'A', 'C:/t/a.md');
    ed.tabs[ed.activeTabIndex].savedContent = '旧';
    const total = ed.tabs.length;
    ed.showSaveDialog = async () => 'cancel';
    await ed.closeAllTabs();
    assert.strictEqual(ed.tabs.length, total, 'cancel 应保持原状');
  } finally { cleanup(w); }
});

test('fileops-extra: copyTabPath 写剪贴板 / 无路径提示未保存', async () => {
  const { w, ed } = await makeEditor();
  try {
    const written = [];
    w.navigator.clipboard ||= {};
    w.navigator.clipboard.writeText = async (s) => { written.push(s); };
    const statuses = [];
    ed.setStatus = (s) => statuses.push(s);

    await ed.addTab('p.md', 'P', 'C:/t/p.md');
    await ed.copyTabPath(ed.activeTabIndex);
    assert.deepStrictEqual(written, ['C:/t/p.md'], '应把路径写入剪贴板');

    ed.newFile();
    await delay(20);
    await ed.copyTabPath(ed.activeTabIndex);
    assert.strictEqual(written.length, 1, '无路径标签不应写剪贴板');
    assert.ok(statuses.length >= 2, '应有状态提示');
  } finally { cleanup(w); }
});

test('fileops-extra: batchSaveTabs 批量写文件；对话框取消返回 false', async () => {
  const calls = [];
  const { w, ed } = await makeEditor(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'plugin:dialog|save') return null; // 用户取消
    return undefined;
  });
  try {
    const t1 = { filePath: 'C:/t/1.md', content: '一', savedContent: '旧一', name: '1.md' };
    const t2 = { filePath: 'C:/t/2.md', content: '二', savedContent: '旧二', name: '2.md' };
    Object.defineProperty(t1, 'isModified', { get() { return this.content !== this.savedContent; } });
    Object.defineProperty(t2, 'isModified', { get() { return this.content !== this.savedContent; } });
    const ok = await ed.batchSaveTabs([t1, t2]);
    assert.strictEqual(ok, true);
    const writes = calls.filter((c) => c.cmd === 'write_file');
    assert.strictEqual(writes.length, 2, '两个已修改标签均应写入');
    assert.strictEqual(t1.savedContent, '一');
    assert.strictEqual(t2.savedContent, '二');

    // 无路径标签且对话框取消 → false
    const t3 = { filePath: null, content: 'x', savedContent: 'y', name: 'u' };
    Object.defineProperty(t3, 'isModified', { get() { return this.content !== this.savedContent; } });
    const ok2 = await ed.batchSaveTabs([t3]);
    assert.strictEqual(ok2, false, '取消保存对话框应返回 false');
  } finally { cleanup(w); }
});

test('fileops-extra: reloadFile 重新读盘并覆盖内容', async () => {
  const { w, ed } = await makeEditor(async (cmd) => {
    if (cmd === 'read_file') return '磁盘最新内容';
    return undefined;
  });
  try {
    ed.showLoading = () => {};
    ed.hideLoading = () => {};
    await ed.addTab('r.md', '内存旧内容', 'C:/t/r.md');
    ed.activeTab.savedContent = '内存旧内容';
    await ed.reloadFile();
    assert.strictEqual(ed.activeTab.content, '磁盘最新内容');
    assert.strictEqual(ed.activeTab.savedContent, '磁盘最新内容');
    assert.strictEqual(ed.cm.getValue(), '磁盘最新内容');
    assert.ok(!ed.activeTab.isModified, '重载后不应为已修改');
  } finally { cleanup(w); }
});

test('fileops-extra: ensureTabLoaded 懒加载与失败兜底', async () => {
  let fail = false;
  const { w, ed } = await makeEditor(async (cmd) => {
    if (cmd === 'read_file') {
      if (fail) throw JSON.stringify({ kind: 'NotFound', path: 'C:/t/x.md', message: 'gone' });
      return '懒加载内容';
    }
    return undefined;
  });
  try {
    ed.reportError = () => {};
    const tab = { filePath: 'C:/t/lazy.md', content: '', savedContent: '' };
    await ed.ensureTabLoaded(tab);
    assert.strictEqual(tab.content, '懒加载内容');
    assert.strictEqual(tab._loaded, true);

    fail = true;
    const bad = { filePath: 'C:/t/x.md', content: '?', savedContent: '?' };
    await ed.ensureTabLoaded(bad);
    assert.strictEqual(bad._loadError, true, '读取失败应标记 _loadError');
    assert.strictEqual(bad.content, '', '失败时内容置空避免脏数据');
    assert.strictEqual(bad._loaded, true, '失败也应标记已加载避免死循环');
  } finally { cleanup(w); }
});
