// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 错误类型：13 种 ErrorKind 与 Md2ParseError 的字段契约。
// 这 13 种是 md2 规范 §7 的规范错误目录，golden 夹具的 .error.txt 逐一对应。
const test = require('node:test');
const assert = require('node:assert');
const { ErrorKind, Md2ParseError } = require('../src/md2/errors.js');

test('ErrorKind 恰好包含 md2 规范 §7 的 13 种', () => {
  const kinds = Object.keys(ErrorKind).sort();
  assert.strictEqual(kinds.length, 13, '应为 13 种');
  assert.deepStrictEqual(kinds, [
    'AlignmentMarkerMisplaced',
    'BorderCornerMismatch',
    'ColspanOnFirstColumn',
    'ColumnCountMismatch',
    'DuplicateHeaderSeparator',
    'MergeCellHasContent',
    'MergeCrossesHeaderBoundary',
    'MergeShapeMismatch',
    'MixedMergeMarkers',
    'MixedSegmentChars',
    'RowspanOnFirstRow',
    'TableStructure',
    'UnterminatedTable',
  ]);
});

test('ErrorKind 的值与键同名（便于日志与 .error.txt 对照）', () => {
  for (const [k, v] of Object.entries(ErrorKind)) {
    assert.strictEqual(v, k);
  }
});

test('Md2ParseError 携带 kind / line / message，column 可为空', () => {
  const e = new Md2ParseError(ErrorKind.MergeShapeMismatch, 7, 'span is wrong');
  assert.ok(e instanceof Error);
  assert.ok(e instanceof Md2ParseError, 'scan.js 依赖此判据做错误分流'); // ← 新增
  assert.strictEqual(e.name, 'Md2ParseError');
  assert.strictEqual(e.kind, 'MergeShapeMismatch');
  assert.strictEqual(e.line, 7);
  assert.strictEqual(e.column, null);
  assert.strictEqual(e.message, 'span is wrong');
});

test('Md2ParseError 可选列号', () => {
  const e = new Md2ParseError(ErrorKind.TableStructure, 3, 'bad', 12);
  assert.ok(e instanceof Md2ParseError); // ← 新增
  assert.strictEqual(e.column, 12);
});
