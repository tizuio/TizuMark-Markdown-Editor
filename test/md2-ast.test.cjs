// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 表格 AST 与平铺不变量。
// 采用 md2 的「全网格」表示：每行恰好 columnCount 个 cell，
// 合并区域 = 左上 anchor（带 colspan/rowspan）+ 其余位置 covered。
const test = require('node:test');
const assert = require('node:assert');
const { Alignment, cell, coveredCell, columnCount, validate } = require('../src/md2/ast.js');

// 构造 md2 golden 08 号夹具里的 2x2 合并表（无表头）：
//   +-------+-------+-------+
//   | A 2x2         | B     |
//   +...............+-------+
//   |               | C     |
//   +---------------+-------+
function merged2x2() {
  return {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default, Alignment.Default],
    rows: [
      { cells: [cell('A 2x2', 2, 2), coveredCell(), cell('B')] },
      { cells: [coveredCell(), coveredCell(), cell('C')] },
    ],
  };
}

test('cell / coveredCell 构造器字段正确', () => {
  assert.deepStrictEqual(cell('x'), { content: 'x', colspan: 1, rowspan: 1, covered: false });
  assert.deepStrictEqual(cell('x', 2, 3), { content: 'x', colspan: 2, rowspan: 3, covered: false });
  assert.deepStrictEqual(coveredCell(), { content: '', colspan: 1, rowspan: 1, covered: true });
});

test('columnCount 取首行格数', () => {
  assert.strictEqual(columnCount(merged2x2()), 3);
});

test('columnCount 无行时为 0，空表通过、非空 alignments 的空表被拒', () => {
  const empty = { headerRowCount: 0, alignments: [], rows: [] };
  assert.strictEqual(columnCount(empty), 0);
  assert.deepStrictEqual(validate(empty), { ok: true });

  const mismatch = { headerRowCount: 0, alignments: [Alignment.Default, Alignment.Default], rows: [] };
  assert.strictEqual(validate(mismatch).ok, false);
});

test('validate 接受合法的 2x2 合并', () => {
  assert.deepStrictEqual(validate(merged2x2()), { ok: true });
});

test('validate 拒绝行格数不一致', () => {
  const t = merged2x2();
  t.rows[1].cells.pop();
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /cells/);
});

test('validate 拒绝 anchor 相互重叠', () => {
  // (0,0) 的 rowspan = 2 已经占住了 (1,0)，而 (1,0) 位置上却还是一个 anchor
  // （不是 covered）→ 两个 anchor 争抢同一格。注意不能用「上下各一个 colspan=2
  // 的 anchor」构造，那种布局其实互不相交、是合法的。
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [
      { cells: [cell('a', 1, 2), cell('x')] },
      { cells: [cell('b'), cell('y')] },
    ],
  };
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /overlap/i);
});

test('validate 拒绝跨出网格的 anchor', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [{ cells: [cell('a', 3, 1), coveredCell()] }],
  };
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /past the grid/i);
});

test('validate 拒绝无主 covered 格', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [{ cells: [cell('a'), coveredCell()] }],
  };
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /belongs to no anchor/i);
});

test('validate 拒绝对齐数与列数不一致', () => {
  const t = merged2x2();
  t.alignments = [Alignment.Default]; // 应为 3 个
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /entries, expected/);
});

test('validate 拒绝携带内容或跨度的 covered 格', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [{ cells: [cell('a'), { content: 'JUNK', colspan: 5, rowspan: 9, covered: true }] }],
  };
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /covered cell .* carries content or span/);
});

test('validate 拒绝非正跨度', () => {
  const zero = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [{ cells: [cell('a', 0, 1), coveredCell()] }],
  };
  const rz = validate(zero);
  assert.strictEqual(rz.ok, false, 'colspan = 0 必须被拒绝');
  assert.match(rz.message, /span/);

  const negative = {
    headerRowCount: 0,
    alignments: [Alignment.Default],
    rows: [{ cells: [cell('a', 1, -1)] }],
  };
  const rn = validate(negative);
  assert.strictEqual(rn.ok, false, '负 rowspan 必须被拒绝');
  assert.match(rn.message, /span/);
});

test('validate 拒绝缺失或非数组的 alignments', () => {
  const missing = {
    headerRowCount: 0,
    rows: [{ cells: [cell('a')] }],
  };
  const r = validate(missing);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /must be an array/);

  // 非数组（字符串 / 数字 / null）与「缺失」走同一守卫——用例名声称覆盖两者，
  // 这里把后半句也真正测掉。
  for (const bad of ['nope', 0, null]) {
    const rb = validate({ headerRowCount: 0, alignments: bad, rows: [{ cells: [cell('a')] }] });
    assert.strictEqual(rb.ok, false, `alignments = ${JSON.stringify(bad)} 应被拒绝`);
    assert.match(rb.message, /must be an array/);
  }
});
