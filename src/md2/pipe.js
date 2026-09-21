// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// 管道表解析（md2 规范 §4，对应 md2 仓库 crates/md2-core/src/parse/pipe.rs）。
//
// 与 Rust 版本的差异：parse_pipe_cell_content（pipe.rs:359）不移植 ——
// 单元格内容保留原始字符串，由 html.js 注入的回调渲染（见 ast.js 顶部说明）。
'use strict';

const { ErrorKind, Md2ParseError } = require('./errors.js');
const { Alignment, cell, coveredCell } = require('./ast.js');

/** §4.1：管道行至少含一个未被转义的 `|`。 */
function hasUnescapedPipe(line) {
  let escaped = false;
  for (const c of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') escaped = true;
    else if (c === '|') return true;
  }
  return false;
}

/**
 * 把一个管道行切成原始格文本（§4.1）。转义序列原样保留（交给渲染阶段处理）；
 * 最多丢弃一个前导、一个尾随的空段（可选外管道）。
 */
function splitCells(line) {
  const segs = [''];
  const chars = Array.from(line);
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\\') {
      segs[segs.length - 1] += c;
      i += 1;
      if (i < chars.length) {
        segs[segs.length - 1] += chars[i];
        i += 1;
      }
    } else if (c === '|') {
      segs.push('');
      i += 1;
    } else {
      segs[segs.length - 1] += c;
      i += 1;
    }
  }
  if (segs.length >= 2 && segs[0].trim() === '') segs.shift();
  if (segs.length >= 2 && segs[segs.length - 1].trim() === '') segs.pop();
  return segs;
}

/** §4.1：每个格匹配 `:?-+:?`，至少一格。 */
function isDelimiterRow(line) {
  const cells = splitCells(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => {
    const t = cell.trim();
    if (t.length === 0) return false;
    let i = t[0] === ':' ? 1 : 0;
    const dashStart = i;
    while (i < t.length && t[i] === '-') i += 1;
    if (i === dashStart) return false;
    if (i < t.length && t[i] === ':') i += 1;
    return i === t.length;
  });
}

/** 连跑中首个分隔行的下标，无则 null（§4.2）。 */
function findDelimiter(run) {
  const i = run.findIndex((line) => isDelimiterRow(line));
  return i === -1 ? null : i;
}

/** §4.9：从单个分隔格取对齐。 */
function delimiterAlignment(cell) {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right && t.length > 1) return Alignment.Center;
  if (left && !right) return Alignment.Left;
  if (!left && right) return Alignment.Right;
  return Alignment.Default;
}

/** 表格行 r（已剔除分隔行的 0-based 序）的 1-based 绝对行号。
 *  连跑中下标 >= delim 的行在物理上被分隔行推移了一行，故要 +1；表头行不加。
 *  （上游 pipe.rs:340 有同样的说明；丢掉它会让「条件移位」变成无从判断的魔法。） */
function rowLineNo(r, delim, firstLineNo) {
  return firstLineNo + r + (r >= delim ? 1 : 0);
}

/** `true` 当且仅当 t 是 unit 的非空重复。 */
function isRepeat(t, unit) {
  if (t.length === 0) return false;
  if (t.length % unit.length !== 0) return false;
  for (let i = 0; i < t.length; i += unit.length) {
    if (t.slice(i, i + unit.length) !== unit) return false;
  }
  return true;
}

// ---- 并查集：键为 "行,组下标" 字符串 ----
// ⚠️ 注意键域与 grid.js 的并查集**不同**：grid 用 (band, 单元格下标)，
// 这里用 (剔除分隔行后的行序, Pass 1 的组下标)。对应上游 pipe.rs:382-413。
// （不抽共享助手是有意的：这 25 行算法封闭，两处各对应一个上游 Rust 文件，
//  抽取会让「文件 ↔ 上游文件」的一一对应断开，而那是逐段等价核验的唯一手段。）
function ufKey(a, b) {
  return `${a},${b}`;
}

function ufFind(parent, x) {
  let root = x;
  for (;;) {
    const px = parent.get(root);
    if (px === undefined || px === root) break;
    root = px;
  }
  let cur = x;
  while (cur !== root) {
    const next = parent.get(cur) === undefined ? cur : parent.get(cur);
    parent.set(cur, root);
    cur = next;
  }
  return root;
}

function ufUnion(parent, a, b) {
  const ra = ufFind(parent, a);
  const rb = ufFind(parent, b);
  if (ra !== rb) parent.set(ra, rb);
}

/**
 * 解析一张管道表。
 *
 * 前置条件（调用方保证，本函数不校验）：
 *   - `run.length >= 1`，且 `0 < delim < run.length`（§4.2：分隔行不得是连跑首行）
 *   - `run` 中每行都满足 `hasUnescapedPipe`（否则会漏行）
 * 违反时 `run[delim]` 为 undefined，会在 splitCells 的 Array.from 处抛 TypeError，
 * 而非 Md2ParseError；`delim === 0` 不报错，但会静默产出 headerRowCount = 0 的表。
 *
 * @param {string[]} run 管道行的最大连跑
 * @param {number} delim 分隔行在 run 中的下标
 * @param {number} firstLineNo run[0] 的 1-based 绝对行号
 */
function parsePipe(run, delim, firstLineNo) {
  const headerRowCount = delim; // §4.3：分隔行之上的每一行
  const delimCells = splitCells(run[delim]);
  const nCols = delimCells.length;
  const alignments = delimCells.map(delimiterAlignment);

  // 物理顺序的全部表格行（表头在前，表体在后）
  const rowLines = run.filter((_, i) => i !== delim);
  const nRows = rowLines.length;

  // ---- 分格、列数校验、标记识别 ----
  // markers[r][c] / texts[r][c]：r 为**剔除分隔行后**的 0-based 行序，c 为 0-based 列号。
  // （注意与 headerRowCount 的域不同：那个是 run 的下标域。）
  const markers = [];
  const texts = [];
  for (let r = 0; r < nRows; r++) {
    const cells = splitCells(rowLines[r]);
    if (cells.length !== nCols) {
      throw new Md2ParseError(
        ErrorKind.ColumnCountMismatch,
        rowLineNo(r, delim, firstLineNo),
        `row has ${cells.length} cells but the delimiter row defines ${nCols} columns`
      );
    }
    const rowMarkers = [];
    const rowTexts = [];
    for (let c = 0; c < nCols; c++) {
      const t = cells[c].trim();
      let marker = 'none';
      if (t.startsWith('\\')) {
        marker = 'none'; // 转义：`\>>` / `\^^` 是字面文本（§4.5）
      } else if (t.startsWith('>>')) {
        if (c === 0) {
          throw new Md2ParseError(ErrorKind.ColspanOnFirstColumn, rowLineNo(r, delim, firstLineNo), '`>>` in the first column has no cell to merge with');
        }
        if (t.includes('^^')) {
          throw new Md2ParseError(ErrorKind.MixedMergeMarkers, rowLineNo(r, delim, firstLineNo), 'cell mixes `>>` and `^^` markers');
        }
        if (!isRepeat(t, '>>')) {
          throw new Md2ParseError(ErrorKind.MergeCellHasContent, rowLineNo(r, delim, firstLineNo), 'colspan continuation cell contains more than the marker');
        }
        marker = 'colspan';
      } else if (t.startsWith('^^')) {
        if (r === 0) {
          throw new Md2ParseError(ErrorKind.RowspanOnFirstRow, rowLineNo(r, delim, firstLineNo), '`^^` in the first row has no row above to merge with');
        }
        if (t.includes('>>')) {
          throw new Md2ParseError(ErrorKind.MixedMergeMarkers, rowLineNo(r, delim, firstLineNo), 'cell mixes `>>` and `^^` markers');
        }
        if (!isRepeat(t, '^^')) {
          throw new Md2ParseError(ErrorKind.MergeCellHasContent, rowLineNo(r, delim, firstLineNo), 'rowspan continuation cell contains more than the marker');
        }
        marker = 'rowspan';
      }
      rowMarkers.push(marker);
      rowTexts.push(t);
    }
    markers.push(rowMarkers);
    texts.push(rowTexts);
  }

  // ---- Pass 1：水平分组（§4.6）----
  const rowGroups = [];
  for (let r = 0; r < nRows; r++) {
    const groups = [];
    for (let c = 0; c < nCols; c++) {
      if (markers[r][c] === 'colspan') {
        // 并入左侧组（必然存在：列号 > 0）
        groups[groups.length - 1].c2 = c + 1;
      } else {
        groups.push({ c1: c + 1, c2: c + 1, anchorText: texts[r][c], caret: markers[r][c] === 'rowspan' });
      }
    }
    rowGroups.push(groups);
  }

  // ---- Pass 2：垂直合并（§4.6）----
  const parent = new Map();
  for (let r = 1; r < nRows; r++) {
    for (let gi = 0; gi < rowGroups[r].length; gi++) {
      const g = rowGroups[r][gi];
      if (!g.caret) continue;
      const ai = rowGroups[r - 1].findIndex((pg) => pg.c1 === g.c1 && pg.c2 === g.c2);
      if (ai === -1) {
        throw new Md2ParseError(
          ErrorKind.MergeShapeMismatch,
          rowLineNo(r, delim, firstLineNo),
          `\`^^\` group covers columns ${g.c1}..${g.c2}, but no single group above spans exactly that range`
        );
      }
      // §4.7：合并不得跨越表头/表体边界
      const crosses = r - 1 < headerRowCount && r >= headerRowCount;
      if (crosses) {
        throw new Md2ParseError(
          ErrorKind.MergeCrossesHeaderBoundary,
          rowLineNo(r, delim, firstLineNo),
          '`^^` would merge a body cell with a header cell'
        );
      }
      ufUnion(parent, ufKey(r - 1, ai), ufKey(r, gi));
    }
  }

  // ---- 分组元数据 ----
  const members = new Map();
  for (let r = 0; r < rowGroups.length; r++) {
    for (let gi = 0; gi < rowGroups[r].length; gi++) {
      const root = ufFind(parent, ufKey(r, gi));
      if (!members.has(root)) members.set(root, []);
      members.get(root).push([r, gi]);
    }
  }
  const regions = new Map();
  for (const [root, list] of members) {
    list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const [top, gi] = list[0];
    regions.set(root, { topRow: top, height: list.length, anchorText: rowGroups[top][gi].anchorText });
  }

  // ---- 组装行（全网格合并表示）----
  const rows = [];
  for (let r = 0; r < nRows; r++) {
    const cells = [];
    for (let gi = 0; gi < rowGroups[r].length; gi++) {
      const g = rowGroups[r][gi];
      const root = ufFind(parent, ufKey(r, gi));
      const region = regions.get(root);
      if (r === region.topRow) {
        cells.push(cell(region.anchorText, g.c2 - g.c1 + 1, region.height));
        for (let x = g.c1; x < g.c2; x++) cells.push(coveredCell());
      } else {
        for (let x = g.c1; x <= g.c2; x++) cells.push(coveredCell());
      }
    }
    rows.push({ cells });
  }

  return { headerRowCount, alignments, rows };
}

module.exports = {
  hasUnescapedPipe,
  splitCells,
  isDelimiterRow,
  findDelimiter,
  delimiterAlignment,
  parsePipe,
};
