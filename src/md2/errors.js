// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 表格类型化解析错误（对应 md2 规范 §7 的规范错误目录）。
// 这 13 种与 md2 仓库 crates/md2-core/src/error.rs 的 ErrorKind 一一对应；
// golden 夹具的 .error.txt 逐条记录了期望的 kind 与行号。
'use strict';

const ErrorKind = Object.freeze({
  /** 通用几何违规：边框形状错误、缺/多边界管道、内容行畸形、闭合管道后有内容、制表符、空 band、全 `=` 顶边框、顶/底边框上的点线段 */
  TableStructure: 'TableStructure',
  /** 单个边框段混用边框字符，或一行混用 `=` 与 `-` */
  MixedSegmentChars: 'MixedSegmentChars',
  /** 角规则（§3.4）中 `+` 的存在/缺失不符 */
  BorderCornerMismatch: 'BorderCornerMismatch',
  /** 点线跨的列范围与实际单元格范围不符（网格）；`^^` 范围与上一行不符（管道） */
  MergeShapeMismatch: 'MergeShapeMismatch',
  /** 合并在表头/表体边界上跨越：分隔行上的点线，或 `^^` 把表体格与表头格相连 */
  MergeCrossesHeaderBoundary: 'MergeCrossesHeaderBoundary',
  /** 多于一条全 `=` 边框行 */
  DuplicateHeaderSeparator: 'DuplicateHeaderSeparator',
  /** 管道表首行出现 `^^` */
  RowspanOnFirstRow: 'RowspanOnFirstRow',
  /** 管道表首列出现 `>>` */
  ColspanOnFirstColumn: 'ColspanOnFirstColumn',
  /** 合并延续格里包含标记以外的内容 */
  MergeCellHasContent: 'MergeCellHasContent',
  /** 管道行的格数与分隔行定义的列数不同 */
  ColumnCountMismatch: 'ColumnCountMismatch',
  /** 对齐标记 `:` 出现在非分隔边框行上 */
  AlignmentMarkerMisplaced: 'AlignmentMarkerMisplaced',
  /** 网格表不完整：输入在 band 内结束，或顶边框后没有 band */
  UnterminatedTable: 'UnterminatedTable',
  /** 单个管道格同时混用 `>>` 与 `^^` */
  MixedMergeMarkers: 'MixedMergeMarkers',
});

/**
 * md2 解析错误。line 为 1-based 绝对行号；column 仅在有意义时给出。
 * 与 md2 的 ParseError 不同，本实现不派生自任何框架错误类型，
 * 便于 scan.js 用 `instanceof` 精确区分「md2 语法错误」与「程序 bug」。
 */
class Md2ParseError extends Error {
  constructor(kind, line, message, column = null) {
    super(message);
    this.name = 'Md2ParseError';
    this.kind = kind;
    this.line = line;
    this.column = column;
  }
}

module.exports = { ErrorKind, Md2ParseError };
