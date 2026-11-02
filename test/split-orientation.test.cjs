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

// ===== 分屏折叠钮（拖拽条内）：折叠入口收进拖拽条 + 折叠态贴边停靠常驻 =====

test('_syncFoldButtons: 横向折叠态图标/title/side-active 状态机', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const foldEditor = w.document.getElementById('btn-fold-editor');
    const foldPreview = w.document.getElementById('btn-fold-preview');
    const splitRow = getSplitRow(w);
    enterEditSplit(w);
    ed.viewMode = 'edit';
    splitRow.classList.remove('split-vertical');
    ed.settings.splitOrientation = 'horizontal';

    ed._syncFoldButtons();
    assert.strictEqual(foldEditor.dataset.icon, 'chevron-left', '横向未折叠：编辑钮 chevron-left');
    assert.strictEqual(foldPreview.dataset.icon, 'chevron-right', '横向未折叠：预览钮 chevron-right');
    assert.ok(foldEditor.querySelector('svg'), '图标应为内联 SVG');
    assert.ok(!foldEditor.classList.contains('side-active'), '未折叠无激活态');

    ed.toggleCollapse('editor');
    assert.ok(container.classList.contains('editor-collapsed'), '应折叠编辑器');
    assert.strictEqual(foldEditor.dataset.icon, 'chevron-right', '横向编辑器折叠：恢复图标 chevron-right');
    assert.strictEqual(foldEditor.title, ed.t('restoreEditor'), 'title 应切为「恢复编辑器」');
    assert.ok(foldEditor.classList.contains('side-active'), '折叠态编辑钮应 accent 常亮');
    assert.ok(!foldPreview.classList.contains('side-active'), '预览钮不应被牵连激活');
    assert.strictEqual(foldPreview.dataset.icon, 'chevron-right', '未折叠侧预览钮图标不变');

    ed.toggleCollapse('editor');
    assert.strictEqual(foldEditor.dataset.icon, 'chevron-left', '展开后应恢复折叠图标');

    ed.toggleCollapse('preview');
    assert.strictEqual(foldPreview.dataset.icon, 'chevron-left', '横向预览折叠：恢复图标 chevron-left');
    assert.strictEqual(foldPreview.title, ed.t('restorePreview'), 'title 应切为「恢复预览」');
    assert.ok(foldPreview.classList.contains('side-active'), '折叠态预览钮应 accent 常亮');
  });
});

test('_syncFoldButtons: 纵向折叠态图标转 chevron-up/down + toggleSplitOrientation 联动', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const foldEditor = w.document.getElementById('btn-fold-editor');
    const foldPreview = w.document.getElementById('btn-fold-preview');
    const orientation = w.document.getElementById('btn-split-orientation');
    const splitRow = getSplitRow(w);
    enterEditSplit(w);
    ed.viewMode = 'edit';
    splitRow.classList.add('split-vertical');
    ed.settings.splitOrientation = 'vertical';

    ed._syncFoldButtons();
    assert.strictEqual(foldEditor.dataset.icon, 'chevron-up', '纵向未折叠：编辑钮 chevron-up');
    assert.strictEqual(foldPreview.dataset.icon, 'chevron-down', '纵向未折叠：预览钮 chevron-down');
    assert.strictEqual(orientation.dataset.icon, 'rows-2', '纵向方向钮应显示 rows-2');

    ed.toggleCollapse('editor');
    assert.strictEqual(foldEditor.dataset.icon, 'chevron-down', '纵向编辑器折叠：恢复图标 chevron-down');
    ed.toggleCollapse('editor');

    ed.toggleCollapse('preview');
    assert.strictEqual(foldPreview.dataset.icon, 'chevron-up', '纵向预览折叠：恢复图标 chevron-up');
    assert.ok(foldPreview.classList.contains('side-active'), '折叠态预览钮应 accent 常亮');
    ed.toggleCollapse('preview');

    // 方向切换（经 toggleSplitOrientation → updateSideButtons → _syncFoldButtons）图标应跟着转
    ed.settings.splitOrientation = 'horizontal';
    splitRow.classList.remove('split-vertical');
    ed.toggleSplitOrientation();
    assert.ok(splitRow.classList.contains('split-vertical'), '应切到纵向');
    assert.strictEqual(foldEditor.dataset.icon, 'chevron-up', '切纵向后编辑钮应为 chevron-up');
    assert.strictEqual(foldPreview.dataset.icon, 'chevron-down', '切纵向后预览钮应为 chevron-down');
    // 切回横向：方向钮应显示 columns-2
    ed.toggleSplitOrientation();
    assert.strictEqual(orientation.dataset.icon, 'columns-2', '横向方向钮应显示 columns-2');
  });
});

test('折叠钮接线：点击拖拽条内折叠钮触发 toggleCollapse', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const foldEditor = w.document.getElementById('btn-fold-editor');
    const foldPreview = w.document.getElementById('btn-fold-preview');
    enterEditSplit(w);
    ed.viewMode = 'edit';
    assert.ok(foldEditor && foldPreview, '应存在分屏折叠钮');

    foldEditor.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.ok(container.classList.contains('editor-collapsed'), '点击编辑折叠钮应折叠编辑器');
    foldEditor.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.ok(!container.classList.contains('editor-collapsed'), '再点应展开');

    foldPreview.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.ok(container.classList.contains('preview-collapsed'), '点击预览折叠钮应折叠预览');
  });
});

test('CSS 静态断言：折叠态拖拽条保留定位锚 + 四向停靠选择器齐备', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  // 折叠态 resizer 不再 display:none（恢复钮要贴边常驻），改为宽/高归零保留定位锚
  assert.ok(!/\.editor-container\.editor-collapsed \.resizer \{ display: none/.test(css),
    '折叠态 resizer 不应再 display:none（恢复钮需贴边常驻）');
  assert.ok(css.includes('.editor-container.editor-collapsed .resizer'), '折叠态 resizer 定位锚规则应存在');
  // 四向停靠
  assert.ok(css.includes('.editor-container.editor-collapsed #btn-fold-editor'), '横向编辑折叠停靠（左缘）');
  assert.ok(css.includes('.editor-container.preview-collapsed #btn-fold-preview'), '横向预览折叠停靠（右缘）');
  assert.ok(css.includes('.editor-container.editor-collapsed .editor-row.split-vertical #btn-fold-editor'), '纵向编辑折叠停靠（顶缘）');
  assert.ok(css.includes('.editor-container.preview-collapsed .editor-row.split-vertical #btn-fold-preview'), '纵向预览折叠停靠（底缘）');
  // 可见性选择器：单栏守卫排除 preview-mode/wysiwyg-mode/text-only + 对侧折叠排除
  assert.ok(css.includes(':not(.preview-collapsed) #btn-fold-editor'), '编辑折叠钮可见性应排除预览折叠态');
  assert.ok(css.includes(':not(.editor-collapsed) #btn-fold-preview'), '预览折叠钮可见性应排除编辑折叠态');
  // 旧入口应已移除
  assert.ok(!css.includes('.side-btn'), '旧 .side-btn 簇应已删除');
});
