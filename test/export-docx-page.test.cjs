// 页面尺寸计算：A4 / Letter + 三种边距预设 → docx 用的 page size/margin（单位 twips，1/20 pt）。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('docx 页面尺寸：A4 纵向 / Letter 纵向', async () => {
  await withEditor({}, async (w, ed) => {
    assert.ok(typeof ed._docxPageSize === 'function', '_docxPageSize 应存在');
    const a4 = ed._docxPageSize('A4');
    assert.strictEqual(a4.width, 11906, 'A4 宽 11906 twips');
    assert.strictEqual(a4.height, 16838, 'A4 高 16838 twips');
    const letter = ed._docxPageSize('Letter');
    assert.strictEqual(letter.width, 12240, 'Letter 宽 12240');
    assert.strictEqual(letter.height, 15840, 'Letter 高 15840');
  });
});

test('docx 页面尺寸：A4 横向应交换宽高', async () => {
  await withEditor({}, async (w, ed) => {
    const landscape = ed._docxPageSize('A4', 'landscape');
    assert.strictEqual(landscape.width, 16838, '横向时宽=原高');
    assert.strictEqual(landscape.height, 11906, '横向时高=原宽');
  });
});

test('docx 边距：标准/窄/宽预览', async () => {
  await withEditor({}, async (w, ed) => {
    assert.ok(typeof ed._docxMargins === 'function', '_docxMargins 应存在');
    const normal = ed._docxMargins('normal');
    assert.strictEqual(normal.top, 1440, '标准上边距 1440');
    const narrow = ed._docxMargins('narrow');
    assert.ok(narrow.top < normal.top, '窄边距应小于标准');
    const wide = ed._docxMargins('wide');
    assert.ok(wide.top > normal.top, '宽边距应大于标准');
  });
});
