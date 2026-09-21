// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// 网格表端到端解析。核心用例对应 md2 golden 夹具 06/07/08/12/13 与 grid.rs 自带测试。
const test = require('node:test');
const assert = require('node:assert');
const { parseGrid } = require('../src/md2/grid.js');
const { ErrorKind, Md2ParseError } = require('../src/md2/errors.js');
const { validate, columnCount } = require('../src/md2/ast.js');

const L = (s) => s.split('\n');

// 网格单元格文本**保留行首空格**（§3.4：4 空格以上缩进会变成缩进代码块），
// 只剥离行尾 padding。断言时按行折叠便于阅读；该行为本身由
// 「单元格文本保留前导空格」一例单独固定，避免这里的折叠把它掩盖掉。
const flat = (s) => s.split('\n').map((l) => l.trim()).join('\n');

test('最简单列表', () => {
  const { table, consumed } = parseGrid(L('+---+\n| x |\n+---+'), 0);
  assert.strictEqual(consumed, 3);
  assert.strictEqual(columnCount(table), 1);
  assert.strictEqual(table.rows.length, 1);
  assert.strictEqual(table.rows[0].cells[0].content.trim(), 'x');
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('表头分隔（=）产生 headerRowCount', () => {
  const { table } = parseGrid(L('+---+---+\n| H | I |\n+===+===+\n| a | b |\n+---+---+'), 0);
  assert.strictEqual(table.headerRowCount, 1);
  assert.strictEqual(table.rows.length, 2);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('仅表头表：分隔符即底边框', () => {
  const { table, consumed } = parseGrid(L('+---+---+\n| H | I |\n+===+===+'), 0);
  assert.strictEqual(consumed, 3);
  assert.strictEqual(table.headerRowCount, 1);
  assert.strictEqual(table.rows.length, 1);
});

test('colspan：省略内部竖线（golden 06 原文）', () => {
  // 逐字取自 C:\s\md2\test_data\golden\06_grid_colspan.md2。
  // 注意第三行 band（C/D/E）不可省略：正是它让最后一条边框在第 8 列
  // 有角（below 活跃），否则会违反角规则。
  const { table } = parseGrid(
    L(
      '+-------+-------+-------+\n' +
        '| H1    | H2    | H3    |\n' +
        '+=======+=======+=======+\n' +
        '| A spans       | B     |\n' +
        '+-------+-------+-------+\n' +
        '| C     | D     | E     |\n' +
        '+-------+-------+-------+'
    ),
    0
  );
  assert.strictEqual(table.headerRowCount, 1);
  assert.strictEqual(table.rows.length, 3);
  const anchor = table.rows[1].cells[0];
  assert.strictEqual(anchor.colspan, 2);
  assert.strictEqual(anchor.rowspan, 1);
  assert.ok(table.rows[1].cells[1].covered);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('rowspan：点线边框（golden 07）', () => {
  const { table } = parseGrid(
    L('+-------+-------+\n| H1    | H2    |\n+=======+=======+\n| R     | B     |\n+.......+-------+\n|       | C     |\n+-------+-------+'),
    0
  );
  const anchor = table.rows[1].cells[0];
  assert.strictEqual(anchor.colspan, 1);
  assert.strictEqual(anchor.rowspan, 2);
  assert.ok(table.rows[2].cells[0].covered);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('2x2 合并：点线 + 省略竖线（golden 08 第一张表原文）', () => {
  // 逐字取自 C:\s\md2\test_data\golden\08_grid_rowcol_span.md2。
  // 底边框是 +---------------+-------+：第 8 列**没有**角，因为该列边界在
  // 上下两个 band 中都不活跃（合并单元格横跨了它）。写成 +---+---+---+ 会
  // 触发 BorderCornerMismatch——这正是角规则要防的错误。
  const { table } = parseGrid(
    L(
      '+-------+-------+-------+\n' +
        '| A 2x2         | B     |\n' +
        '+...............+-------+\n' +
        '|               | C     |\n' +
        '+---------------+-------+'
    ),
    0
  );
  const anchor = table.rows[0].cells[0];
  assert.strictEqual(anchor.colspan, 2);
  assert.strictEqual(anchor.rowspan, 2);
  assert.strictEqual(anchor.content.trim(), 'A 2x2');
  assert.ok(table.rows[0].cells[1].covered);
  assert.ok(table.rows[1].cells[0].covered);
  assert.ok(table.rows[1].cells[1].covered);
  assert.strictEqual(table.rows[1].cells[2].content.trim(), 'C');
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('多段落单元格内容保留换行', () => {
  const { table } = parseGrid(
    L('+-------+-------+\n| First | Second|\n| para. | para. |\n+-------+-------+'),
    0
  );
  assert.strictEqual(flat(table.rows[0].cells[0].content), 'First\npara.');
  assert.strictEqual(flat(table.rows[0].cells[1].content), 'Second\npara.');
});

test('多行表头 + 表头内列合并（golden 12 原文）', () => {
  // 逐字取自 C:\s\md2\test_data\golden\12_grid_two_headers_colspan.md2。
  // "Sales" 横跨两个子列，且整个合并位于**表头块内部**（合法）；
  // 分隔行在第 3 条边框，故 headerRowCount = 2。
  const { table } = parseGrid(
    L(
      '+--------+-------+-------+\n' +
        '| Region |   Sales       |\n' +
        '+--------+-------+-------+\n' +
        '|        | North | South |\n' +
        '+========+=======+=======+\n' +
        '| East   | 10    | 20    |\n' +
        '+--------+-------+-------+'
    ),
    0
  );
  assert.strictEqual(table.headerRowCount, 2);
  assert.strictEqual(table.rows.length, 3);
  assert.strictEqual(table.rows[0].cells[0].content.trim(), 'Region');
  assert.strictEqual(table.rows[0].cells[1].colspan, 2, '"Sales" 应横跨两列');
  assert.ok(table.rows[0].cells[2].covered);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('表头块内的 rowspan（golden 13 原文）', () => {
  // 逐字取自 C:\s\md2\test_data\golden\13_grid_two_headers_rowspan.md2。
  // "ID" 跨越两行表头，整个合并位于表头块内部（合法）。
  const { table } = parseGrid(
    L(
      '+--------+-------+-------+\n' +
        '| ID     | North | South |\n' +
        '+........+-------+-------+\n' +
        '|        | Units | Count |\n' +
        '+========+=======+=======+\n' +
        '| 1      | a     | b     |\n' +
        '+--------+-------+-------+'
    ),
    0
  );
  assert.strictEqual(table.headerRowCount, 2);
  assert.strictEqual(table.rows.length, 3);
  const anchor = table.rows[0].cells[0];
  assert.strictEqual(anchor.colspan, 1);
  assert.strictEqual(anchor.rowspan, 2);
  assert.ok(table.rows[1].cells[0].covered);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('对齐标记取自表头分隔行（§3.6）', () => {
  // 冒号必须在**分隔行**（全 = 那行）上，不能放在顶边框
  const { table } = parseGrid(
    L('+---+---+\n| H | I |\n+:==+==:+\n| a | b |\n+---+---+'),
    0
  );
  assert.deepStrictEqual(table.alignments, ['left', 'right']);
});

test('错误：顶边框上的对齐标记 → AlignmentMarkerMisplaced', () => {
  assert.throws(
    () => parseGrid(L('+:---+---:+\n| H | I |\n+===+===+\n| a | b |\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.AlignmentMarkerMisplaced
  );
});

test('非 ASCII 单元格按字符列取值', () => {
  const { table } = parseGrid(L('+----+\n| ä  |\n+----+'), 0);
  assert.strictEqual(table.rows[0].cells[0].content.trim(), 'ä');
});

test('单元格文本保留前导空格、剥离行尾 padding（§3.4）', () => {
  // 前导空格必须保留：4 空格以上会被 CommonMark 读成缩进代码块
  const { table } = parseGrid(L('+-------+\n|   x   |\n+-------+'), 0);
  assert.strictEqual(table.rows[0].cells[0].content, '   x');
});

test('错误：无 band 的顶边框 → UnterminatedTable', () => {
  assert.throws(
    () => parseGrid(L('+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.UnterminatedTable && e.line === 1
  );
});

test('错误：相邻边框形成空 band → TableStructure', () => {
  assert.throws(
    () => parseGrid(L('+---+---+\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 2
  );
});

test('错误：缺少角（违反角规则）→ BorderCornerMismatch', () => {
  // 上下两个 band 在第 2 列边界上都有竖线（即该边界活跃），
  // 但中间那条边框却没有对应的 '+' 角。
  assert.throws(
    () =>
      parseGrid(
        L('+-------+-------+\n| a     | b     |\n+---------------+\n| c     | d     |\n+-------+-------+'),
        0
      ),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.BorderCornerMismatch && e.line === 3
  );
});

test('错误：band 内竖线时有时无 → TableStructure', () => {
  assert.throws(
    () => parseGrid(L('+-------+-------+\n| a     | b     |\n| c             |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 2
  );
});

test('错误：点线跨与上下单元格范围不符 → MergeShapeMismatch', () => {
  // 上方 band 的单元格跨第 1..2 列，点线却只覆盖第 1 列 → 形状不符
  assert.throws(
    () =>
      parseGrid(
        L('+-------+-------+-------+\n| A             | B     |\n+.......+-------+-------+\n| x     | y     | z     |\n+-------+-------+-------+'),
        0
      ),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeShapeMismatch && e.line === 3
  );
});

test('错误：顶边框上的点线 → TableStructure', () => {
  assert.throws(
    () => parseGrid(L('+...+---+\n| a     |\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('错误：多于一个表头分隔符 → DuplicateHeaderSeparator', () => {
  assert.throws(
    () =>
      parseGrid(L('+---+---+\n| a | b |\n+===+===+\n| c | d |\n+===+===+\n| e | f |\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.DuplicateHeaderSeparator && e.line === 5
  );
});

test('错误：制表符 → TableStructure（须断言 message，否则会绿在几何分支上）', () => {
  // 删掉 tab 检查后，'|\tx|' 会落到「无闭合管道」分支，kind 仍是 TableStructure。
  // 只有 message 能把这条规则钉住。（'\t' 是真实制表符，不是字面反斜杠+t。）
  const lines = ['+---+', '|\tx|', '+---+'];
  assert.throws(
    () => parseGrid(lines, 0),
    (e) =>
      e instanceof Md2ParseError &&
      e.kind === ErrorKind.TableStructure &&
      /tab character/.test(e.message)
  );
});

test('错误：边框长度与顶边框不符 → TableStructure', () => {
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\n+--+--+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('错误：全 = 顶边框 → TableStructure@1（上游 invalid_grid_separator_at_top）', () => {
  assert.throws(
    () => parseGrid(L('+=======+=======+\n| A     | B     |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 1
  );
});

test('错误：点线出现在顶边框 → TableStructure@1（上游 invalid_grid_dots_on_outer_border）', () => {
  assert.throws(
    () => parseGrid(L('+.......+-------+\n| A     | B     |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 1
  );
});

test('错误：段内混用 - 与 = → MixedSegmentChars@3（上游 invalid_grid_mixed_segment）', () => {
  assert.throws(
    () => parseGrid(L('+-------+-------+\n| A     | B     |\n+--=----+-------+\n| C     | D     |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedSegmentChars && e.line === 3
  );
});

test('错误：内容行缺闭合管道 → TableStructure@4（上游 invalid_grid_bad_content_line）', () => {
  assert.throws(
    () => parseGrid(L('+-------+-------+\n| A     | B     |\n+-------+-------+\n| broken'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 4
  );
});

test('错误：点线与 = 分隔段混用 → MergeCrossesHeaderBoundary@3（上游 invalid_grid_rowspan_header_body）', () => {
  // 这是 §3.8「合并不许跨表头/表体边界」在网格路径上的**唯一实现**
  // （checkSegmentMix 的 hasEq && hasDot 半边）。删掉整个 checkSegmentMix 后
  // 原有 22 个用例零反应——本条是该函数的唯一回归网。
  assert.throws(
    () => parseGrid(L('+-------+-------+\n| H1    | H2    |\n+.......+=======+\n| cont  | C     |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeCrossesHeaderBoundary && e.line === 3
  );
});

test('错误：band 未闭合（下一行既非内容行也非边框）→ UnterminatedTable@2', () => {
  // 该分支传的是**裸 idx**（见实现里那条「不要改成 idx + 1」的注释）：
  // idx 已被推进到 band 之后，而 band 最后一条内容行的 1-based 行号恰好等于 idx。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\nafter'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.UnterminatedTable && e.line === 2
  );
});

test('consumed 只覆盖表格自身，不含后续行', () => {
  const lines = L('+---+---+\n| a | b |\n+---+---+');
  lines.push('after');
  const { consumed } = parseGrid(lines, 0);
  assert.strictEqual(consumed, 3);
  assert.strictEqual(lines[consumed], 'after');
});

test('start 非 0：consumed 与行号都以表格起点为基准', () => {
  const lines = ['preamble', '', '+---+---+', '| a | b |', '+---+---+', 'tail'];
  const { table, consumed } = parseGrid(lines, 2);
  assert.strictEqual(consumed, 3, 'consumed 只算表格自身行数');
  assert.strictEqual(columnCount(table), 2);
  // 行号绝对化：顶边框改坏后行号应为 3（= start + 1），而非 1
  assert.throws(
    () => parseGrid(['preamble', '', '+=======+=======+', '| A | B |', '+---+---+'], 2),
    (e) => e instanceof Md2ParseError && e.line === 3
  );
});

test('错误：顶边框混用 = 与 - → MixedSegmentChars@1', () => {
  // 各段独立均匀，故 parseBorderShape 放行；由 B0 规则的 hasEq 拦下。
  assert.throws(
    () => parseGrid(L('+===+---+\n| A | B |\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedSegmentChars && e.line === 1
  );
});

test('错误：非顶边框混用 = 与 - → MixedSegmentChars@5（checkSegmentMix 的 hasEq && hasDash 半边）', () => {
  // 已覆盖的是 hasEq && hasDot 半边；这条钉住另一半。
  // 去掉它会让 +===+---+ 形态的边框被静默接受。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\n+===+===+\n| c | d |\n+===+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedSegmentChars && e.line === 5
  );
});

test('错误：底边框上的点线 → TableStructure@3', () => {
  // 去掉 k >= m 守卫后此处会抛裸 TypeError（findIndex of undefined），
  // 而非 Md2ParseError——这条是该守卫的唯一回归网。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\n+...+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 3
  );
});

test('错误：闭合管道后有非空白字符 → TableStructure@2', () => {
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b | x\n+---+---+'), 0),
    (e) =>
      e instanceof Md2ParseError &&
      e.kind === ErrorKind.TableStructure &&
      e.line === 2 &&
      /after the closing boundary pipe/.test(e.message)
  );
});

test('错误：输入在 band 内结束 → UnterminatedTable@2', () => {
  // 两个上游夹具 invalid_grid_unterminated*.md2 走的正是这条分支，但本套件从未喂过它。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.UnterminatedTable && e.line === 2
  );
});

test('错误：边框长度与顶边框不符（角仍在 P 内）→ TableStructure@3', () => {
  // 与已有的「边框长度与顶边框不符」用例不同：那条的 '+--+--+' 会先撞上**角位置**
  // 检查，因而掩盖了长度检查。这里 '+---+' 的角 0 与 4 都在顶边框角集内，
  // 只有长度检查能拦下它——去掉长度检查后该输入会被**成功解析**。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\n+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 3
  );
});
