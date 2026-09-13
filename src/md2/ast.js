// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 表格 AST（对应 md2 仓库 crates/md2-core/src/ast.rs 的表部分）。
//
// 全网格表示（md2 ast.rs:7-20 的设计）：每行恰好 columnCount 个 cell，
// 网格位置 O(1) 可寻址。合并区域由两部分表示：
//   - anchor：矩形左上角的 cell，携带内容与 colspan/rowspan > 1
//   - covered：矩形内其余位置，covered=true、内容为空、colspan=rowspan=1
//
// 与 Rust 版本的差异：content 保存**原始字符串**而非已解析的块。
// md2 用 pulldown-cmark 解析单元格内容；TizuMark 把这一步交给注入的
// 渲染回调（见 html.js），从而让单元格内容回灌 unified 管线获得完整
// CommonMark（含 KaTeX / Mermaid / 脚注等既有后处理）。
'use strict';

const Alignment = Object.freeze({
  Default: 'default',
  Left: 'left',
  Center: 'center',
  Right: 'right',
});

/** 内容单元（合并区域的 anchor）。 */
function cell(content, colspan = 1, rowspan = 1) {
  return { content, colspan, rowspan, covered: false };
}

/** 被合并覆盖的占位单元。 */
function coveredCell() {
  return { content: '', colspan: 1, rowspan: 1, covered: true };
}

/**
 * 列数 = 首行的格数（全网格表示下每行等长）。
 * 无行时为 0 —— 与上游 ast.rs 的 column_count 一致，刻意不回退到 alignments.length。
 */
function columnCount(table) {
  return table.rows.length ? table.rows[0].cells.length : 0;
}

/**
 * 复检平铺不变量（对应 md2 ast.rs:110-178 的 Table::validate）：
 * anchor 恰好铺满网格、不重叠、不留空，每个 covered 落在唯一 anchor 矩形内。
 *
 * 契约边界：本函数只校验**平铺不变量**，不是「全部字段合法性」。
 * 不检查 headerRowCount（与上游一致），也不检查 table.rows 是否为数组
 * ——调用方需保证传入形如 { headerRowCount, alignments, rows } 的良构表。
 * @returns {{ok: true} | {ok: false, message: string}}
 */
function validate(table) {
  // 前置检查对齐上游 ast.rs 的 Table::validate（:112-118 对齐数、:139-141 非正跨度）。
  // alignments 的数组守卫必须先于下面的长度比较：alignments 缺失时那里读
  // `undefined.length` 会抛 TypeError，而不是返回可读的 {ok:false}。
  if (!Array.isArray(table.alignments)) {
    return { ok: false, message: 'table.alignments must be an array' };
  }

  const nCols = columnCount(table);
  const nRows = table.rows.length;

  if (table.alignments.length !== nCols) {
    return { ok: false, message: `alignments has ${table.alignments.length} entries, expected ${nCols}` };
  }

  for (const row of table.rows) {
    if (row.cells.length !== nCols) {
      return { ok: false, message: `row has ${row.cells.length} cells, expected ${nCols}` };
    }
  }

  // owner[r][c] = 该位置是否已被某个 anchor 覆盖
  const owner = Array.from({ length: nRows }, () => new Array(nCols).fill(false));

  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const cl = table.rows[r].cells[c];
      if (cl.covered) {
        // 上游 ast.rs:131-136：covered 格不得携带内容或跨度。
        // 不查的话，html.js 会因跳过 covered 而静默丢弃这些内容。
        if (cl.content !== '' || cl.colspan !== 1 || cl.rowspan !== 1) {
          return { ok: false, message: `covered cell at ${r},${c} carries content or span` };
        }
        continue;
      }
      if (cl.colspan < 1 || cl.rowspan < 1) {
        return { ok: false, message: `anchor at ${r},${c} has a non-positive span` };
      }
      const rEnd = r + cl.rowspan;
      const cEnd = c + cl.colspan;
      if (rEnd > nRows || cEnd > nCols) {
        return { ok: false, message: `cell at ${r},${c} spans past the grid` };
      }
      for (let rr = r; rr < rEnd; rr++) {
        for (let cc = c; cc < cEnd; cc++) {
          if (owner[rr][cc]) {
            return { ok: false, message: `overlap at ${rr},${cc}` };
          }
          owner[rr][cc] = true;
        }
      }
    }
  }

  // 每个 covered 必须落在某个 anchor 矩形内（= 已被 owner 标记）
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      if (table.rows[r].cells[c].covered && !owner[r][c]) {
        return { ok: false, message: `covered cell at ${r},${c} belongs to no anchor` };
      }
    }
  }

  return { ok: true };
}

module.exports = { Alignment, cell, coveredCell, columnCount, validate };
