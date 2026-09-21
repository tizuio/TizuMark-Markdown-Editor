// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// 网格表几何原语。测试用例逐条对应 md2 crates/md2-core/src/parse/grid.rs
// 的 #[cfg(test)] mod tests（border_shape_recognition 等）。
const test = require('node:test');
const assert = require('node:assert');
const { looksLikeBorder, unescapedPipeAt, parseBorderShape } = require('../src/md2/grid.js');
const { ErrorKind, Md2ParseError } = require('../src/md2/errors.js');

test('looksLikeBorder：识别合法的边框行', () => {
  assert.strictEqual(looksLikeBorder('+---+---+'), true);
  assert.strictEqual(looksLikeBorder('+===+===+'), true);
  assert.strictEqual(looksLikeBorder('+...+---+'), true);
  // 上游 grid.rs:659：「commits; parse_grid rejects it」——形状检查刻意宽松，
  // 真正的拒绝在 parseGrid。这条语义边界若不钉住，日后收紧 looksLikeBorder 不会被发现。
  assert.strictEqual(looksLikeBorder('+:+'), true);
  assert.strictEqual(looksLikeBorder('+: +'), false); // 含空格：字符集不通过
  // 上游 grid.rs:660 的「list marker territory」：末字符非 '+'，与上一条走的是**不同分支**
  assert.strictEqual(looksLikeBorder('+ ---'), false);
  assert.strictEqual(looksLikeBorder('+---+---+ trailing'), false); // 尾部有文字
  assert.strictEqual(looksLikeBorder('\\+---+---+'), false); // 以反斜杠开头
  assert.strictEqual(looksLikeBorder(''), false);
  assert.strictEqual(looksLikeBorder('++'), false); // 长度 < 3
});

test('looksLikeBorder：忽略行尾空白', () => {
  assert.strictEqual(looksLikeBorder('+---+   '), true);
});

test('unescapedPipeAt：偶数个反斜杠才是真管道', () => {
  const c1 = Array.from('a|b');
  assert.strictEqual(unescapedPipeAt(c1, 1), true);

  const c2 = Array.from('a\\|b'); // 转义管道
  assert.strictEqual(unescapedPipeAt(c2, 2), false);

  const c3 = Array.from('a\\\\|b'); // 转义反斜杠 + 真管道
  assert.strictEqual(unescapedPipeAt(c3, 3), true);

  const c4 = Array.from('ab');
  assert.strictEqual(unescapedPipeAt(c4, 0), false); // 非管道
});

test('parseBorderShape：角与段', () => {
  const b = parseBorderShape(1, '+---+---+');
  assert.deepStrictEqual(b.corners, [0, 4, 8]);
  assert.strictEqual(b.segs.length, 2);
  assert.strictEqual(b.segs[0].kind, 'dash');
  assert.strictEqual(b.length, 9);
});

test('parseBorderShape：段类型 dash / eq / dot', () => {
  assert.strictEqual(parseBorderShape(1, '+---+').segs[0].kind, 'dash');
  assert.strictEqual(parseBorderShape(1, '+===+').segs[0].kind, 'eq');
  assert.strictEqual(parseBorderShape(1, '+...+').segs[0].kind, 'dot');
});

test('parseBorderShape：对齐冒号被剥离为 lead/trail', () => {
  const b = parseBorderShape(1, '+:---+---:+');
  assert.strictEqual(b.segs[0].leadColon, true);
  assert.strictEqual(b.segs[0].trailColon, false);
  assert.strictEqual(b.segs[1].leadColon, false);
  assert.strictEqual(b.segs[1].trailColon, true);
});

test('parseBorderShape：段内混用边框字符 → MixedSegmentChars', () => {
  assert.throws(
    () => parseBorderShape(1, '+-=+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedSegmentChars && e.line === 1
  );
});

test('parseBorderShape：冒号不紧邻角 → AlignmentMarkerMisplaced', () => {
  assert.throws(
    () => parseBorderShape(1, '+--:--+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.AlignmentMarkerMisplaced
  );
});

test('parseBorderShape：空段 → TableStructure', () => {
  // 断言 message 是必须的：仅凭 kind + line 无法与下面的 `lo >= hi` 分支区分，
  // 删掉 empty-border-segment 分支后 12 个用例仍会全绿（审查者用变异副本证实）。
  assert.throws(
    () => parseBorderShape(1, '++'),
    (e) =>
      e instanceof Md2ParseError &&
      e.kind === ErrorKind.TableStructure &&
      /empty border segment/.test(e.message)
  );
});

test('parseBorderShape：段内只有冒号 → TableStructure', () => {
  // '+::+' 的段是 '::'：两个冒号都被当作对角冒号剥离后，段内无边框字符
  assert.throws(
    () => parseBorderShape(1, '+::+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('parseBorderShape：非法字符 → TableStructure', () => {
  assert.throws(
    () => parseBorderShape(1, '+--x--+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('parseBorderShape：非 ASCII 在形状校验阶段即报错', () => {
  // 边框行必须是纯 ASCII；校验在分段之前，故走 TableStructure
  assert.throws(
    () => parseBorderShape(1, '+--ä--+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('parseBorderShape：行号原样传递给错误对象', () => {
  // 契约级保护：其余用例一律传 lineNo=1，若实现把行号写成字面量将无人察觉。
  // golden 夹具的 .error.txt 比对 kind + 行号，故这一条必须有。
  assert.throws(
    () => parseBorderShape(7, '+--x--+'),
    (e) => e instanceof Md2ParseError && e.line === 7
  );
});
