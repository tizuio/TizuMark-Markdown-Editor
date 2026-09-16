// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 一致性门禁（硬门禁）：网格夹具必须与 md2 的 .html 快照结构等价。
//
// 「结构等价」= 归一化后的表格骨架、colspan/rowspan、covered 省略、
// 单元格文本、对齐值全部相同。不含单元格内部标记细节（见归一化器注释）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderMarkdown } = require('../src/unified-renderer.js');
const { extractTables } = require('./helpers/md2-normalize.cjs');

const FIX = path.join(__dirname, 'fixtures', 'md2-golden');

// 网格夹具：硬门禁（「网格严格」原则）
const GRID_FIXTURES = [
  '04_grid_multiline_cells',
  '06_grid_colspan',
  '07_grid_rowspan',
  '08_grid_rowcol_span',
  '12_grid_two_headers_colspan',
  '13_grid_two_headers_rowspan',
  'grid_alignment',
];

for (const name of GRID_FIXTURES) {
  test(`一致性（硬门禁）：${name}`, () => {
    const src = fs.readFileSync(path.join(FIX, `${name}.md2`), 'utf8');
    const expected = fs.readFileSync(path.join(FIX, `${name}.html`), 'utf8');
    const actual = renderMarkdown(src, { softBreaks: false });

    const ours = extractTables(actual);
    const theirs = extractTables(expected);

    assert.ok(theirs.length > 0, 'md2 夹具应至少含一张表');
    assert.strictEqual(
      ours.length,
      theirs.length,
      `表格数量不一致：TizuMark ${ours.length}，md2 ${theirs.length}`
    );
    assert.deepStrictEqual(ours, theirs);
  });
}

test('夹具文件齐全', () => {
  for (const name of GRID_FIXTURES) {
    assert.ok(fs.existsSync(path.join(FIX, `${name}.md2`)), `缺少 ${name}.md2`);
    assert.ok(fs.existsSync(path.join(FIX, `${name}.html`)), `缺少 ${name}.html`);
  }
  assert.ok(fs.existsSync(path.join(FIX, 'README.md')), '缺少来源说明 README.md');
});
