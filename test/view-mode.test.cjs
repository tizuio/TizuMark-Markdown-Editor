// 视图模式测试：初始值 / toggleViewMode 循环 / applyViewMode / toggleCollapse 折叠
// 与 app-core 的 setViewMode 互补，避免重复。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

async function makeEditor() {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  // 隔离异步 DOM 副作用，聚焦视图模式状态切换
  ed.updateSideButtons = () => {};
  ed.setStatus = () => {};
  ed._resumeScroll = () => {};
  ed.cm.refresh = () => {};
  return { w, ed };
}

test('viewmode: 初始化 viewMode 继承 settings.defaultView', async () => {
  const { w, ed } = await makeEditor();
  try {
    assert.strictEqual(ed.viewMode, ed.settings.defaultView, 'viewMode 应等于默认视图设置');
  } finally { cleanup(w); }
});

test('viewmode: toggleViewMode 在 阅读/源码/所见即所得 三模式间循环', async () => {
  const { w, ed } = await makeEditor();
  try {
    const container = w.document.querySelector('.editor-container');
    // 从源码起步：阅读 → 源码 → 所见即所得 → 阅读
    if (ed.viewMode === 'preview') ed.setViewMode('edit');
    assert.strictEqual(ed.viewMode, 'edit');
    assert.ok(!container.classList.contains('preview-mode'));
    // 给一点内容，确保走到全量预渲染路径（空文档 lineCount=1 也走，但内容可覆盖块挂遮罩）
    ed.cm.setValue('# 标题\n\n正文行。\n');

    // 所见即所得走后台全量预渲染（2026-10-09 设计）：toggleViewMode 返回时
    // 预渲染在飞（视图仍停留在源码、按钮显示「渲染中」），完成回调后才真正切模式
    ed.toggleViewMode();
    assert.strictEqual(ed._wysiwygPreRendering, true, '进入所见即所得应走后台预渲染（不再同步切换）');
    assert.strictEqual(ed.viewMode, 'edit', '预渲染在飞时视图应停留在源码');
    await delay(1500); // 等预渲染 50ms 计时器 + applyViewMode 的 50ms 遮罩计时器落地
    assert.strictEqual(ed._wysiwygPreRendering, false, '预渲染完成后状态应复位');
    assert.strictEqual(ed.viewMode, 'wysiwyg', '预渲染完成后应切到所见即所得');
    assert.ok(container.classList.contains('wysiwyg-mode'), '切到 wysiwyg 应有 wysiwyg-mode 类');

    ed.toggleViewMode();
    assert.strictEqual(ed.viewMode, 'preview', '所见即所得之后应循环回阅读');
    assert.ok(container.classList.contains('preview-mode'), '切到 preview 应有 preview-mode 类');

    ed.toggleViewMode();
    assert.strictEqual(ed.viewMode, 'edit', '阅读之后应循环到源码');
    assert.ok(!container.classList.contains('preview-mode'));
    assert.ok(!container.classList.contains('wysiwyg-mode'), '离开所见即所得应清掉 wysiwyg-mode');
  } finally { cleanup(w); }
});

test('viewmode: applyViewMode(preview) 加 preview-mode 类并隐藏侧栏', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.setViewMode('edit');
    ed.viewMode = 'preview';
    ed.applyViewMode();
    const container = w.document.querySelector('.editor-container');
    assert.ok(container.classList.contains('preview-mode'));
    const sideLeft = w.document.getElementById('btn-side-left');
    if (sideLeft) assert.ok(sideLeft.classList.contains('side-hidden'), 'preview 模式应隐藏侧栏按钮');
  } finally { cleanup(w); }
});

test('viewmode: toggleCollapse 折叠/展开编辑器与预览（edit 模式）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.setViewMode('edit');
    const container = w.document.querySelector('.editor-container');
    ed.toggleCollapse('editor');
    assert.ok(container.classList.contains('editor-collapsed'), '应折叠编辑器');
    ed.toggleCollapse('editor');
    assert.ok(!container.classList.contains('editor-collapsed'), '再次切换应展开编辑器');
    ed.toggleCollapse('preview');
    assert.ok(container.classList.contains('preview-collapsed'), '应折叠预览');
  } finally { cleanup(w); }
});

test('viewmode: 纯预览模式下 toggleCollapse 不生效', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.setViewMode('preview');
    const container = w.document.querySelector('.editor-container');
    ed.toggleCollapse('editor');
    assert.ok(!container.classList.contains('editor-collapsed'), 'preview 模式下折叠编辑器应无效');
  } finally { cleanup(w); }
});
