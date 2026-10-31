// 编辑模式分屏方向（左右 ↔ 上下）切换：
// - 双击拖拽条 / 点击拖拽条中央按钮 → 切换 splitOrientation 并切 split-vertical 类
// - 上下分屏按比例 settings.editorSplitRatioV 还原高度；左右分屏按 settings.editorSplitRatioH 还原宽度
//   （比例制：窗口缩放/重启后分屏比例不变；旧 px 值 previewPaneWidth 惰性迁移）
// - 单栏/折叠态（preview-mode / wysiwyg-mode / text-only / editor-collapsed / preview-collapsed）
//   不得清除 split-vertical（否则下次回分屏方向丢失）
// - 切换视图模式后 applyViewMode 应保留已选方向（不回退到左右）
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

// jsdom 的 offsetHeight/offsetWidth 恒为 0，测试需要尺寸时按元素注入
function setDim(el, h, w) {
  if (h != null) Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
  if (w != null) Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
}

// harness 默认编辑器处于预览模式（容器带 preview-mode 类），分屏相关方法会被守卫提前返回。
// 进入「编辑分屏」态：清掉所有单栏/折叠类，使双栏均可见。
function enterEditSplit(w) {
  const c = w.document.querySelector('.editor-container');
  c.classList.remove('preview-mode', 'wysiwyg-mode', 'text-only', 'editor-collapsed', 'preview-collapsed');
}

// 分屏方向类 split-vertical 作用于「编辑器+预览」双栏区（.editor-row），
// 左侧文件/大纲侧栏是 .editor-container 的另一个子元素，与方向无关
function getSplitRow(w) {
  return w.document.querySelector('.editor-row');
}

test('toggleSplitOrientation: 翻转 splitOrientation 并切换 split-vertical 类', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const splitRow = getSplitRow(w);
    enterEditSplit(w);
    ed.settings.splitOrientation = 'horizontal';
    splitRow.classList.remove('split-vertical');
    ed.toggleSplitOrientation();
    assert.strictEqual(ed.settings.splitOrientation, 'vertical', '应翻转成 vertical');
    assert.ok(splitRow.classList.contains('split-vertical'), '双栏区应加 split-vertical');
    assert.ok(!container.classList.contains('split-vertical'), '侧栏所在的 container 不应被牵连');
    ed.toggleSplitOrientation();
    assert.strictEqual(ed.settings.splitOrientation, 'horizontal', '再次切换应回 horizontal');
    assert.ok(!splitRow.classList.contains('split-vertical'), '双栏区应去掉 split-vertical');
  });
});

test('applyPreviewPaneWidth: splitOrientation=vertical 时按 editorSplitRatioV 还原上下比例并加类', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const editorPane = w.document.getElementById('editor-pane');
    const previewPane = w.document.getElementById('preview-pane');
    const resizer = w.document.getElementById('resizer');
    enterEditSplit(w);
    setDim(container, 800);
    const splitRow0 = getSplitRow(w);
    setDim(splitRow0, 800); setDim(resizer, 6); // 纵向高度以双栏区(.editor-row)为基准
    ed.settings.splitOrientation = 'vertical';
    ed.settings.editorSplitRatioV = 0.7;
    ed.applyPreviewPaneWidth();
    const splitRow = getSplitRow(w);
    assert.ok(splitRow.classList.contains('split-vertical'), '双栏区应加 split-vertical');
    assert.ok(!container.classList.contains('split-vertical'), '侧栏所在的 container 不应被牵连');
    assert.strictEqual(editorPane.style.flex, '0 0 auto', '纵向应用 flex none（避免 grow 分不出高度白屏）');
    // 比例 0.7 → editorH = round((800-6)*0.7)=556，previewH = 794-556=238
    assert.strictEqual(editorPane.style.height, '556px', '编辑器高度应≈0.7*794');
    assert.strictEqual(previewPane.style.height, '238px', '预览高度应=794-556');
  });
});

test('applyPreviewPaneWidth: splitOrientation=horizontal 时移除 split-vertical 并还原宽度比例', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const editorPane = w.document.getElementById('editor-pane');
    const previewPane = w.document.getElementById('preview-pane');
    const resizer = w.document.getElementById('resizer');
    const outline = w.document.getElementById('outline-sidebar');
    const splitRow = getSplitRow(w);
    enterEditSplit(w);
    // 隐藏侧栏、定宽，简化比例验算
    outline.classList.add('hidden');
    setDim(container, 600, 1000); setDim(resizer, 6, 4); setDim(outline, 0, 0);
    ed.settings.splitOrientation = 'horizontal';
    ed.settings.editorSplitRatioH = 0.6;
    splitRow.classList.add('split-vertical'); // 先处于纵向
    ed.applyPreviewPaneWidth();
    assert.ok(!splitRow.classList.contains('split-vertical'), 'horizontal 应移除 split-vertical');
    assert.strictEqual(editorPane.style.flex, '0.6000 0 0px', '编辑器宽度比例应=0.6（比例制）');
    assert.strictEqual(previewPane.style.flex, '0.4000 0 0px', '预览宽度比例应=0.4（比例制）');
  });
});

test('applyPreviewPaneWidth: 旧 px 值惰性迁移为比例（回归）', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const resizer = w.document.getElementById('resizer');
    const outline = w.document.getElementById('outline-sidebar');
    enterEditSplit(w);
    outline.classList.add('hidden');
    setDim(container, 600, 1000); setDim(resizer, 6, 4); setDim(outline, 0, 0);
    // 模拟旧版 settings：只有 px 宽，无比例
    ed.settings.editorSplitRatioH = null;
    // totalContentWidth = 1000 - 0(outline) - 4(resizer) = 996 → 迁移 ratio = (996-400)/996
    ed.settings.previewPaneWidth = 400;
    ed.applyPreviewPaneWidth();
    assert.ok(Math.abs(ed.settings.editorSplitRatioH - 596 / 996) < 1e-6, '应由 px 宽迁移出比例 (996-400)/996');
    const editorPane = w.document.getElementById('editor-pane');
    assert.strictEqual(editorPane.style.flex, (596 / 996).toFixed(4) + ' 0 0px', '迁移后按比例还原');
  });
});

test('applyPreviewPaneWidth: 单栏/折叠态不清除 split-vertical（回归）', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const splitRow = getSplitRow(w);
    ed.settings.splitOrientation = 'vertical';
    splitRow.classList.add('split-vertical');

    // 进入纯预览
    ed.viewMode = 'preview';
    container.classList.add('preview-mode');
    ed.applyPreviewPaneWidth();
    assert.ok(splitRow.classList.contains('split-vertical'), 'preview-mode 下不应清除 split-vertical');

    // 所见即所得
    container.classList.remove('preview-mode');
    ed.viewMode = 'wysiwyg';
    container.classList.add('wysiwyg-mode');
    ed.applyPreviewPaneWidth();
    assert.ok(splitRow.classList.contains('split-vertical'), 'wysiwyg-mode 下不应清除 split-vertical');

    // 折叠编辑器
    container.classList.remove('wysiwyg-mode');
    ed.viewMode = 'edit';
    container.classList.add('editor-collapsed');
    ed.applyPreviewPaneWidth();
    assert.ok(splitRow.classList.contains('split-vertical'), 'editor-collapsed 下不应清除 split-vertical');
  });
});

test('applyViewMode 切换视图后保留已选分屏方向（回归）', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const splitRow = getSplitRow(w);
    ed.settings.splitOrientation = 'vertical';
    ed.settings.editorSplitRatioV = 0.5;
    splitRow.classList.add('split-vertical');
    // 当前在 edit，切到 preview 再 applyViewMode，方向应保留
    ed.viewMode = 'preview';
    ed.applyViewMode();
    assert.ok(splitRow.classList.contains('split-vertical'), '切到预览再 applyViewMode 后方向应保留');
    // 切回 edit 方向也应保留
    ed.viewMode = 'edit';
    ed.applyViewMode();
    assert.ok(splitRow.classList.contains('split-vertical'), '切回编辑后方向应保留');
  });
});

test('initResizer 接线：双击拖拽条切换方向、点击按钮切换方向', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const resizer = w.document.getElementById('resizer');
    const btn = w.document.getElementById('btn-split-orientation');
    enterEditSplit(w);
    assert.ok(btn, '应存在分屏方向切换按钮');

    const before = ed.settings.splitOrientation;
    // 双击拖拽条（target=resizer，非按钮区）→ 切换
    resizer.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
    assert.notStrictEqual(ed.settings.splitOrientation, before, '双击拖拽条应切换方向');

    const mid = ed.settings.splitOrientation;
    // 点击按钮（target=按钮）→ 再次切换
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.notStrictEqual(ed.settings.splitOrientation, mid, '点击按钮应切换方向');
  });
});
