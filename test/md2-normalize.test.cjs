// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// 一致性归一化器自身的测试。归一化器是门禁的度量工具，它错了门禁就失去意义。
const test = require('node:test');
const assert = require('node:assert');
const { extractTables } = require('./helpers/md2-normalize.cjs');

test('提取表格骨架与合并跨度', () => {
  const html =
    '<table><tbody>' +
    '<tr><td colspan="2" rowspan="2">A</td><td>B</td></tr>' +
    '<tr><td>C</td></tr>' +
    '</tbody></table>';
  const [t] = extractTables(html);
  assert.strictEqual(t.rows.length, 2);
  assert.strictEqual(t.rows[0].length, 2);
  assert.strictEqual(t.rows[0][0].colspan, 2);
  assert.strictEqual(t.rows[0][0].rowspan, 2);
  assert.strictEqual(t.rows[1].length, 1);
});

test('covered 省略即体现为行内 cell 数差异', () => {
  const html =
    '<table><tbody>' +
    '<tr><td rowspan="2">R</td><td>B</td></tr>' +
    '<tr><td>C</td></tr>' +
    '</tbody></table>';
  const [t] = extractTables(html);
  assert.strictEqual(t.rows[0].length, 2);
  assert.strictEqual(t.rows[1].length, 1);
});

test('对齐：align 属性与内联 style 归一到同一值', () => {
  const a = extractTables('<table><tr><td align="center">x</td></tr></table>');
  const b = extractTables('<table><tr><td style="text-align: center">x</td></tr></table>');
  assert.strictEqual(a[0].rows[0][0].align, 'center');
  assert.strictEqual(b[0].rows[0][0].align, 'center');
  assert.deepStrictEqual(a, b);
});

test('缺省对齐归一为 default', () => {
  const [t] = extractTables('<table><tr><td>x</td></tr></table>');
  assert.strictEqual(t.rows[0][0].align, 'default');
});

test('单元格文本空白折叠', () => {
  const [t] = extractTables('<table><tr><td>  a   b  </td></tr></table>');
  assert.strictEqual(t.rows[0][0].text, 'a b');
});

test('headerRowCount 取自 thead 的行数', () => {
  const html = '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
  const [t] = extractTables(html);
  assert.strictEqual(t.headerRowCount, 1);
});

test('无 thead 时 headerRowCount 为 0', () => {
  const [t] = extractTables('<table><tbody><tr><td>a</td></tr></tbody></table>');
  assert.strictEqual(t.headerRowCount, 0);
});

test('th 与 td 都计为 cell', () => {
  const [t] = extractTables('<table><tr><th>a</th><td>b</td></tr></table>');
  assert.strictEqual(t.rows[0].length, 2);
});
