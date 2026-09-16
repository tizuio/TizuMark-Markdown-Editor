// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// 管道表解析（md2 规范 §4）。
// 正向用例对应上游 crates/md2-core/src/parse/pipe.rs 的 #[cfg(test)] mod tests
// 与 golden 夹具 09/10；**7 个错误用例是为本移植新写的**——上游 pipe.rs 的
// tests 模块一个错误 kind 都没断言，golden 09/10 也均为纯正向夹具。
// 注意：上游的 trailing_backslash_hard_break 用例在本移植中刻意缺席，
// 因为 parse_pipe_cell_content 不移植（见 src/md2/pipe.js 文件头说明）。
const test = require('node:test');
const assert = require('node:assert');
const {
  hasUnescapedPipe,
  splitCells,
  isDelimiterRow,
  findDelimiter,
  parsePipe,
} = require('../src/md2/pipe.js');
const { ErrorKind, Md2ParseError } = require('../src/md2/errors.js');
const { validate, columnCount } = require('../src/md2/ast.js');

test('管道行检测（含转义）', () => {
  assert.strictEqual(hasUnescapedPipe('a | b'), true);
  assert.strictEqual(hasUnescapedPipe('|'), true);
  assert.strictEqual(hasUnescapedPipe('a \\| b'), false); // 仅转义管道
  assert.strictEqual(hasUnescapedPipe('no pipes'), false);
  assert.strictEqual(hasUnescapedPipe('\\\\| x'), true); // 转义反斜杠 + 真管道
});

test('分格：可选外管道被丢弃，转义保留原样', () => {
  assert.deepStrictEqual(splitCells('| A | B |'), [' A ', ' B ']);
  assert.deepStrictEqual(splitCells('A | B'), ['A ', ' B']);
  assert.deepStrictEqual(splitCells('| A | B'), [' A ', ' B']);
  assert.deepStrictEqual(splitCells('| a \\| b |'), [' a \\| b ']);
  assert.strictEqual(splitCells('| A |  | B |').length, 3); // 中间空格
});

test('分隔行检测', () => {
  assert.strictEqual(isDelimiterRow('| --- | --- |'), true);
  assert.strictEqual(isDelimiterRow('| :--- | :---: | ---: | ---- |'), true);
  assert.strictEqual(isDelimiterRow('--- | ---'), true);
  assert.strictEqual(isDelimiterRow('| a | b |'), false);
  assert.strictEqual(isDelimiterRow('| --x | --- |'), false);
  assert.strictEqual(isDelimiterRow('no pipes'), false);
  assert.strictEqual(isDelimiterRow('| \\--- |'), false); // 转义短横 = 文本
});

test('findDelimiter 返回首个分隔行下标', () => {
  assert.strictEqual(findDelimiter(['| a | b |', '| - | - |']), 1);
  assert.strictEqual(findDelimiter(['| a | b |']), null);
});

test('规范 2x2 合并工作示例（§4.6）', () => {
  const run = ['| H1 | H2 |', '| -- | -- |', '| A  | >> |', '| ^^ | >> |'];
  const t = parsePipe(run, 1, 2);
  assert.strictEqual(t.headerRowCount, 1);
  assert.strictEqual(t.rows.length, 3);
  const a = t.rows[1].cells[0];
  assert.strictEqual(a.colspan, 2);
  assert.strictEqual(a.rowspan, 2);
  assert.strictEqual(a.content, 'A');
  assert.ok(t.rows[1].cells[1].covered);
  assert.ok(t.rows[2].cells[0].covered);
  assert.ok(t.rows[2].cells[1].covered);
  assert.deepStrictEqual(validate(t), { ok: true });
});

test('colspan 锚点的内容取自左侧格', () => {
  const t = parsePipe(['| H | H2 |', '| - | -- |', '| Blend | >> |'], 1, 1);
  const anchor = t.rows[1].cells[0];
  assert.strictEqual(anchor.colspan, 2);
  assert.strictEqual(anchor.content, 'Blend');
});

test('rowspan 连链得到 rowspan = 3', () => {
  const run = ['| H | B |', '| - | - |', '| R | x |', '| ^^ | y |', '| ^^ | z |'];
  const t = parsePipe(run, 1, 1);
  assert.strictEqual(t.rows[1].cells[0].rowspan, 3);
  assert.deepStrictEqual(validate(t), { ok: true });
});

test('转义标记视为字面文本', () => {
  const t = parsePipe(['| C | D |', '| - | - |', '| \\>> | x |'], 1, 1);
  assert.strictEqual(t.rows[1].cells[0].colspan, 1);
  assert.strictEqual(t.rows[1].cells[0].content, '\\>>');
});

test('多行表头：分隔行之上的每一行都是表头（§4.3）', () => {
  const t = parsePipe(['| A | B |', '| C | D |', '| - | - |', '| 1 | 2 |'], 2, 1);
  assert.strictEqual(t.headerRowCount, 2);
  assert.deepStrictEqual(validate(t), { ok: true });
});

test('对齐从分隔行提取（§4.9）', () => {
  const t = parsePipe(['| A | B | C |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |'], 1, 1);
  assert.deepStrictEqual(t.alignments, ['left', 'center', 'right']);
});

test('错误：格数与分隔行不符 → ColumnCountMismatch', () => {
  assert.throws(
    () => parsePipe(['| a | b |', '| - | - |', '| 1 | 2 | 3 |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.ColumnCountMismatch && e.line === 3
  );
});

test('错误：首列 >> → ColspanOnFirstColumn', () => {
  assert.throws(
    () => parsePipe(['| a | b |', '| - | - |', '| >> | x |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.ColspanOnFirstColumn && e.line === 3
  );
});

test('错误：首行 ^^ → RowspanOnFirstRow', () => {
  // 注意：`r` 是**剔除分隔行后**的行序，r = 0 指分隔行上方那一行。
  // 把 ^^ 放在分隔行**下方**（如 ['| a | b |','| - | - |','| ^^ | x |']）时
  // r = 1，不会走这个分支，而是撞上 MergeCrossesHeaderBoundary。
  assert.throws(
    () => parsePipe(['| ^^ | x |', '| - | - |', '| a | b |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.RowspanOnFirstRow && e.line === 1
  );
});

test('错误：延续格含内容 → MergeCellHasContent', () => {
  assert.throws(
    () => parsePipe(['| a | b |', '| - | - |', '| x | >> junk |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeCellHasContent && e.line === 3
  );
});

test('错误：混用标记 → MixedMergeMarkers', () => {
  assert.throws(
    () => parsePipe(['| a | b |', '| - | - |', '| x | >>^^ |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedMergeMarkers && e.line === 3
  );
});

test('错误：^^ 跨表头/表体边界 → MergeCrossesHeaderBoundary', () => {
  // 表头两行 + 表体首行的 ^^ 指向表头行
  assert.throws(
    () => parsePipe(['| a | b |', '| c | d |', '| - | - |', '| ^^ | x |'], 2, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeCrossesHeaderBoundary && e.line === 4
  );
});

test('错误：^^ 上方无同范围组 → MergeShapeMismatch', () => {
  assert.throws(
    () => parsePipe(['| a | b | c |', '| - | - | - |', '| x | y | z |', '| ^^ | >> | >> |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeShapeMismatch && e.line === 4
  );
});

test('错误行号按物理行计算（分隔行占一行）', () => {
  try {
    parsePipe(['| a | b |', '| - | - |', '| 1 | 2 | 3 |'], 1, 10);
    assert.fail('应抛错');
  } catch (e) {
    assert.strictEqual(e.line, 12); // 第 3 行 → 10 + 2
  }
});

test('行号移位：表头行不多算一行（§4.3 多行表头）', () => {
  // r < delim 的表头行不加那 1；把一个错误放在**第二行表头**上，
  // 就能把「条件移位」与「无条件 +1」区分开。
  // （唯一那条 `e.line === 12` 的断言用的是 r = 1 / delim = 1，两者恰好同值，测不出移位。）
  assert.throws(
    () => parsePipe(['| a | b |', '| >> | x |', '| - | - |', '| z | w |'], 2, 7),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.ColspanOnFirstColumn && e.line === 8
  );
});

test('表头块内部的 ^^ 是合法的 rowspan（§4.3 允许 N 行表头；§4.7 只禁止跨边界）', () => {
  // 若 crosses 退化为只留前一个合取项，这条合法输入会被误判为跨边界。
  const t = parsePipe(['| a | b |', '| ^^ | y |', '| - | - |', '| 1 | 2 |'], 2, 1);
  assert.strictEqual(t.headerRowCount, 2);
  assert.strictEqual(t.rows[0].cells[0].rowspan, 2);
  assert.ok(t.rows[1].cells[0].covered);
  assert.deepStrictEqual(validate(t), { ok: true });
});

test('findDelimiter 取**首个**分隔行（§4.2）', () => {
  // §4.2 用粗体强调：The first delimiter row delimits the table;
  // any later delimiter-shaped row is an ordinary body row.
  assert.strictEqual(findDelimiter(['| x | y |', '| - | - |', '| - | - |', '| p | q |']), 1);
});

test('splitCells / isDelimiterRow：外管道前后的空白不影响分格（§4.1）', () => {
  // 上游把段落行**原样**交给分格，行首缩进与行尾空格都不会被预先剥离，
  // 故必须靠 trim 判定「空段」。去掉 trim 会让缩进的管道表静默退化成普通段落。
  assert.deepStrictEqual(splitCells('  | a | b |'), [' a ', ' b ']);
  assert.deepStrictEqual(splitCells('| a | b |   '), [' a ', ' b ']);
  assert.strictEqual(isDelimiterRow('  | - | - |  '), true);
});
