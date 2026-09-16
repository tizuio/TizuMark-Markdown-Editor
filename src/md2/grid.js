// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// 网格表解析（对应 md2 规范 §3 与 md2 仓库 crates/md2-core/src/parse/grid.rs）。
//
// 几何用字符偏移（md2 规范 §2）。边框行是纯 ASCII，字节位置与字符位置一致；
// 内容行按「字符」（码点）索引，因为单元格文本可能非 ASCII —— 因此内容行
// 一律先 Array.from() 得到码点数组再按位取字符（对应 Rust 的 Vec<char>）。
'use strict';

const { ErrorKind, Md2ParseError } = require('./errors.js');
const { Alignment, cell, coveredCell } = require('./ast.js');

/**
 * 提交形状检查（md2 规范 §3.2、§6）：这一行是否开启一个网格表？
 * 行尾空白被忽略（§2）；边框样式行以第 0 列的 `+` 开头、以 `+` 结尾、
 * 且只含边框字符。
 */
function looksLikeBorder(line) {
  const t = line.replace(/\s+$/, '');
  if (t.length < 3) return false;
  if (t[0] !== '+' || t[t.length - 1] !== '+') return false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '+' && c !== '-' && c !== '=' && c !== '.' && c !== ':') return false;
  }
  return true;
}

/**
 * 字符数组 chars 的位置 pos 上是否有**未被转义**的 `|`。
 * 连续反斜杠数为偶数即为真管道（对应 Rust grid.rs:46）。
 */
function unescapedPipeAt(chars, pos) {
  if (chars[pos] !== '|') return false;
  let backslashes = 0;
  let i = pos;
  while (i > 0 && chars[i - 1] === '\\') {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 0;
}

/**
 * 解析一行边框为角位置与段序列（对应 Rust grid.rs:60 parse_border_shape）。
 *
 * 前置条件：`trimmed` 必须**已剥离行尾空白**（§2，调用方负责，通常是 `trimEnd()`），
 * 且已通过本函数自身的字符集校验（或 `looksLikeBorder`）。违反前件会 fail-loud
 * （抛 TableStructure），但 message 会指向「首尾非 +」，掩盖真实原因。
 *
 * 返回对象的不变量（任务 5 依赖，调用方需知）：
 *   - `corners[0] === 0`，且 `corners` 严格升序
 *   - `segs.length === corners.length - 1`
 *   - `segs[i]` 描述 `corners[i]..corners[i + 1]` 之间的段
 *   - `length` 是字符数（非字节数）
 */
function parseBorderShape(lineNo, trimmed) {
  if (trimmed.length === 0 || trimmed[0] !== '+' || trimmed[trimmed.length - 1] !== '+') {
    throw new Md2ParseError(ErrorKind.TableStructure, lineNo, "border line must start and end with '+'");
  }
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c !== '+' && c !== '-' && c !== '=' && c !== '.' && c !== ':') {
      throw new Md2ParseError(
        ErrorKind.TableStructure,
        lineNo,
        "border line contains a character that is not '+', '-', '=', '.' or ':'"
      );
    }
  }

  const corners = [0];
  const segs = [];
  let i = 1;
  while (i < trimmed.length) {
    const start = i;
    while (i < trimmed.length && trimmed[i] !== '+') i++;
    const end = i; // 行尾必为 '+'，故 i 一定落在角上
    if (end === start) {
      throw new Md2ParseError(ErrorKind.TableStructure, lineNo, 'empty border segment');
    }

    // 最多剥离一个紧邻角的对齐冒号
    let lead = false;
    let trail = false;
    let lo = start;
    let hi = end;
    if (trimmed[lo] === ':') {
      lead = true;
      lo += 1;
    }
    if (hi > lo && trimmed[hi - 1] === ':') {
      trail = true;
      hi -= 1;
    }
    if (lo >= hi) {
      throw new Md2ParseError(ErrorKind.TableStructure, lineNo, 'border segment has no border characters');
    }
    if (trimmed.slice(lo, hi).includes(':')) {
      throw new Md2ParseError(
        ErrorKind.AlignmentMarkerMisplaced,
        lineNo,
        "alignment marker ':' is not adjacent to a corner"
      );
    }
    const first = trimmed[lo];
    for (let k = lo; k < hi; k++) {
      if (trimmed[k] !== first) {
        throw new Md2ParseError(ErrorKind.MixedSegmentChars, lineNo, 'border segment mixes border characters');
      }
    }

    const kind = first === '-' ? 'dash' : first === '=' ? 'eq' : 'dot';
    corners.push(end);
    segs.push({ kind, leadColon: lead, trailColon: trail });
    i += 1; // 跳过角上的 '+'
  }

  return { lineNo, corners, segs, length: trimmed.length };
}

/** 角位置在边界数组 P 中的下标（对应 Rust grid.rs:520 p_index_of）。 */
function pIndexOf(p, pos) {
  const i = p.indexOf(pos);
  if (i === -1) throw new Error(`corner position ${pos} is not in P`);
  return i;
}

/** 校验内容行（对应 Rust grid.rs:578 check_content_line）。 */
function checkContentLine(trimmedLine, chars, lineNo, p) {
  if (trimmedLine.includes('\t')) {
    throw new Md2ParseError(ErrorKind.TableStructure, lineNo, 'tab character in grid table line');
  }
  const pn = p[p.length - 1];
  if (chars.length < pn + 1 || chars[pn] !== '|') {
    throw new Md2ParseError(
      ErrorKind.TableStructure,
      lineNo,
      'content line has no closing boundary pipe at the last column boundary'
    );
  }
  if (chars.length > pn + 1) {
    throw new Md2ParseError(ErrorKind.TableStructure, lineNo, 'non-space characters after the closing boundary pipe');
  }
}

/** 校验边框与顶边框一致（对应 Rust grid.rs:609 check_border_against_top）。 */
function checkBorderAgainstTop(border, top) {
  if (border.length !== top.length) {
    throw new Md2ParseError(ErrorKind.TableStructure, border.lineNo, 'border line length differs from the top border');
  }
  for (const c of border.corners) {
    if (!top.corners.includes(c)) {
      throw new Md2ParseError(ErrorKind.TableStructure, border.lineNo, `corner at column ${c} is not a top-border position`);
    }
  }
}

/** 校验一行内的段类型组合（对应 Rust grid.rs:629 check_segment_mix）。 */
function checkSegmentMix(border) {
  const hasEq = border.segs.some((s) => s.kind === 'eq');
  const hasDash = border.segs.some((s) => s.kind === 'dash');
  const hasDot = border.segs.some((s) => s.kind === 'dot');
  if (hasEq && hasDot) {
    throw new Md2ParseError(
      ErrorKind.MergeCrossesHeaderBoundary,
      border.lineNo,
      "border line mixes '=' separator segments with dotted rowspan segments"
    );
  }
  if (hasEq && hasDash) {
    throw new Md2ParseError(ErrorKind.MixedSegmentChars, border.lineNo, "border line mixes '=' with '-' segments");
  }
}

// ---- 并查集：键为 "row,col" 字符串（对应 Rust 的 HashMap<(usize,usize),(usize,usize)>） ----

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
 * 提取 band 内某单元格的文本（对应 Rust grid.rs:533 cell_text）。
 * 取该单元格边界列之间、band 各行的字符，按行拼接。
 * 行尾 padding 被剥离（装饰性，不可变成 CommonMark 的两空格硬换行）；
 * 行首空格保留（4 空格以上缩进 → 缩进代码块）。
 */
function cellText(trimmed, band, p, c1, c2) {
  const lo = p[c1 - 1] + 1;
  const hi = p[c2];
  const parts = [];
  for (const lineIdx of band) {
    const chars = Array.from(trimmed[lineIdx]);
    parts.push(chars.slice(lo, hi).join('').replace(/\s+$/, ''));
  }
  return parts.join('\n');
}

/**
 * 网格表入口（对应 Rust grid.rs:156 parse_grid）。
 * lines[start] 是顶边框（调用方已用 looksLikeBorder 确认）。
 * @returns {{table: object, consumed: number}} consumed 为消费的行数（B0 到 Bm 含）
 */
function parseGrid(lines, start) {
  const nTotal = lines.length;
  const trimmed = lines.map((l) => l.replace(/\s+$/, ''));

  // ---- B0（顶边框） ----
  const topLine = trimmed[start];
  if (topLine.includes('\t')) {
    throw new Md2ParseError(ErrorKind.TableStructure, start + 1, 'tab character in grid table line');
  }
  const top = parseBorderShape(start + 1, topLine);
  const p = top.corners.slice();
  const nCols = p.length - 1;
  for (let w = 0; w < nCols; w++) {
    if (p[w + 1] - p[w] < 2) {
      throw new Md2ParseError(ErrorKind.TableStructure, start + 1, 'column width must be at least 1');
    }
  }
  const hasEq = top.segs.some((s) => s.kind === 'eq');
  const hasDot = top.segs.some((s) => s.kind === 'dot');
  const allEq = top.segs.every((s) => s.kind === 'eq');
  if (hasDot) {
    throw new Md2ParseError(ErrorKind.TableStructure, start + 1, 'dotted segment on the top border has no band above to join');
  }
  if (allEq) {
    throw new Md2ParseError(ErrorKind.TableStructure, start + 1, 'the header separator cannot be the top border');
  }
  if (hasEq) {
    throw new Md2ParseError(ErrorKind.MixedSegmentChars, start + 1, "top border mixes '=' with '-' segments");
  }
  if (top.segs.some((s) => s.leadColon || s.trailColon)) {
    throw new Md2ParseError(ErrorKind.AlignmentMarkerMisplaced, start + 1, 'alignment markers are allowed only on the header separator');
  }

  // ---- 扫描 band 与边框 ----
  const borders = [top];
  const bands = [];
  let separator = null; // 边框下标（0 = B0）
  let idx = start + 1;
  for (;;) {
    const bandStart = idx;
    while (idx < nTotal) {
      const chars = Array.from(trimmed[idx]);
      if (!unescapedPipeAt(chars, 0)) break;
      checkContentLine(trimmed[idx], chars, idx + 1, p);
      idx += 1;
    }

    if (idx === bandStart) {
      if (borders.length === 1) {
        // B0 之后完全没有 band（§3.11）——紧邻的边框是空 band（§3.3）
        if (idx < nTotal && looksLikeBorder(trimmed[idx])) {
          throw new Md2ParseError(ErrorKind.TableStructure, idx + 1, 'empty band between adjacent border lines');
        }
        throw new Md2ParseError(ErrorKind.UnterminatedTable, start + 1, 'grid table has no band after its top border');
      }
      break; // 表在最后一条边框处结束（§3.11）
    }

    const band = [];
    for (let t = bandStart; t < idx; t++) band.push(t);
    bands.push(band);

    if (idx >= nTotal) {
      throw new Md2ParseError(ErrorKind.UnterminatedTable, idx, 'input ends inside an open band');
    }

    const line = trimmed[idx];
    if (looksLikeBorder(line)) {
      if (line.includes('\t')) {
        throw new Md2ParseError(ErrorKind.TableStructure, idx + 1, 'tab character in grid table line');
      }
      const border = parseBorderShape(idx + 1, line);
      checkBorderAgainstTop(border, borders[0]);
      checkSegmentMix(border);

      if (border.segs.every((s) => s.kind === 'eq')) {
        if (separator !== null) {
          throw new Md2ParseError(ErrorKind.DuplicateHeaderSeparator, idx + 1, 'more than one header separator');
        }
        separator = borders.length;
      } else if (border.segs.some((s) => s.leadColon || s.trailColon)) {
        throw new Md2ParseError(ErrorKind.AlignmentMarkerMisplaced, idx + 1, 'alignment markers are allowed only on the header separator');
      }

      borders.push(border);
      idx += 1;
    } else {
      // 注意：此处传的是裸 idx，**不要**改成 idx + 1。
      // idx 已被推进到 band 之后的那一行，而 band 最后一条内容行的 0-based
      // 下标是 idx - 1，其 1-based 行号恰好等于 idx。上游 grid.rs:299 同样
      // 传裸 idx 并注明 "last content line (1-based)"——这是有意为之，
      // 与同函数内其它抛出点（idx + 1）语义不同。
      throw new Md2ParseError(ErrorKind.UnterminatedTable, idx, 'grid table band is not closed by a border line');
    }
  }

  const m = bands.length;

  // ---- 边界活跃度（§3.4）----
  // active[k][i] = 边界 p_{i+1} 在 band k 中是否活跃（i 索引 0..nCols-1，最后一个未使用）
  const active = [];
  for (let k = 0; k < m; k++) {
    const band = bands[k];
    const acts = [];
    for (let ii = 1; ii < p.length; ii++) {
      const pos = p[ii];
      let withPipe = 0;
      for (const lineIdx of band) {
        const chars = Array.from(trimmed[lineIdx]);
        if (unescapedPipeAt(chars, pos)) withPipe += 1;
      }
      if (withPipe === 0) acts.push(false);
      else if (withPipe === band.length) acts.push(true);
      else {
        throw new Md2ParseError(
          ErrorKind.TableStructure,
          bands[k][0] + 1,
          'boundary pipe present on some band lines but not all (§3.4 uniformity)'
        );
      }
    }
    active.push(acts);
  }

  // ---- 角规则（§3.4）for B1..Bm ----
  for (let k = 1; k < borders.length; k++) {
    const border = borders[k];
    for (let i = 1; i < nCols; i++) {
      const pos = p[i];
      const hasCorner = border.corners.includes(pos);
      const above = active[k - 1][i - 1];
      const below = k < m && active[k][i - 1];
      if (hasCorner !== (above || below)) {
        throw new Md2ParseError(
          ErrorKind.BorderCornerMismatch,
          border.lineNo,
          `corner at column ${pos} violates the corner rule (§3.4)`
        );
      }
    }
  }

  // ---- 每个 band 的单元格（§3.4）----
  // bandCells[k] = [[c1, c2], ...]，1-based 闭区间列号
  const bandCells = [];
  for (const acts of active) {
    const cells = [];
    let c1 = 1;
    for (let i = 1; i < nCols; i++) {
      if (acts[i - 1]) {
        cells.push([c1, i]);
        c1 = i + 1;
      }
    }
    cells.push([c1, nCols]);
    bandCells.push(cells);
  }

  // ---- Rowspan：点线段（§3.7）----
  // 点线跨是两条角之间最大的 '.' 段连跑；当且仅当其正上、正下的 band 单元格
  // 恰好跨同一列范围时有效。有效跨把两个单元格并起来（并查集）；链式给出 rowspan >= 3。
  const parent = new Map();
  for (let k = 1; k < borders.length; k++) {
    const border = borders[k];
    let si = 0;
    while (si < border.segs.length) {
      if (border.segs[si].kind !== 'dot') {
        si += 1;
        continue;
      }
      const runStart = si;
      while (si < border.segs.length && border.segs[si].kind === 'dot') si += 1;

      if (k >= m) {
        throw new Md2ParseError(ErrorKind.TableStructure, border.lineNo, 'dotted segment on the bottom border has no band below to join');
      }

      const c1 = pIndexOf(p, border.corners[runStart]) + 1;
      const c2 = pIndexOf(p, border.corners[si]);
      // c1 ∈ [1, nCols] 必然落在 bandCells[k-1] 的某一格内（该数组是 1..nCols 的
      // 连续划分），故 findIndex 恒命中，不会返回 -1；与上游此处的 .unwrap() 同义。
      const above = bandCells[k - 1].findIndex(([a, b]) => a <= c1 && c1 <= b);
      const below = bandCells[k].findIndex(([a, b]) => a <= c1 && c1 <= b);
      const ab = bandCells[k - 1][above];
      const bl = bandCells[k][below];
      if (ab[0] !== c1 || ab[1] !== c2 || bl[0] !== c1 || bl[1] !== c2) {
        throw new Md2ParseError(
          ErrorKind.MergeShapeMismatch,
          border.lineNo,
          `dotted span covers columns ${c1}..${c2}, but the cell above spans ${ab[0]}..${ab[1]} and the cell below spans ${bl[0]}..${bl[1]}`
        );
      }
      ufUnion(parent, ufKey(k - 1, above), ufKey(k, below));
    }
  }

  // ---- 分组元数据 ----
  const members = new Map();
  for (let k = 0; k < bandCells.length; k++) {
    for (let ci = 0; ci < bandCells[k].length; ci++) {
      const root = ufFind(parent, ufKey(k, ci));
      if (!members.has(root)) members.set(root, []);
      members.get(root).push([k, ci]);
    }
  }
  const info = new Map();
  for (const [root, list] of members) {
    list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const [topK, topCi] = list[0];
    const [c1, c2] = bandCells[topK][topCi];
    // §3.7：合并后的内容 = 各成员 band 单元格文本，最上 band 在前
    const texts = list.map(([k]) => cellText(trimmed, bands[k], p, c1, c2));
    info.set(root, { top: topK, height: list.length, content: texts.join('\n') });
  }

  // ---- 对齐（§3.6）与 header_row_count（§3.5）----
  let alignments;
  if (separator === null) {
    alignments = new Array(nCols).fill(Alignment.Default);
  } else {
    alignments = new Array(nCols).fill(Alignment.Default);
    const border = borders[separator];
    for (let si2 = 0; si2 < border.segs.length; si2++) {
      const seg = border.segs[si2];
      const colLo = pIndexOf(p, border.corners[si2]) + 1;
      const colHi = pIndexOf(p, border.corners[si2 + 1]);
      let a = Alignment.Default;
      if (seg.leadColon && seg.trailColon) a = Alignment.Center;
      else if (seg.leadColon) a = Alignment.Left;
      else if (seg.trailColon) a = Alignment.Right;
      for (let c = colLo; c <= colHi; c++) alignments[c - 1] = a;
    }
  }
  // 分隔行在边框下标 s ⇒ band 1..s 都是表头行（§3.5）；因此「边框下标」与
  // 「表头行数」是同一个数的两种读法，不是巧合。
  const headerRowCount = separator === null ? 0 : separator;

  // ---- 组装行（全网格合并表示）----
  const rows = [];
  for (let k = 0; k < bandCells.length; k++) {
    const cells = [];
    for (let ci = 0; ci < bandCells[k].length; ci++) {
      const [c1, c2] = bandCells[k][ci];
      const root = ufFind(parent, ufKey(k, ci));
      const g = info.get(root);
      if (k === g.top) {
        cells.push(cell(g.content, c2 - c1 + 1, g.height));
        for (let x = c1; x < c2; x++) cells.push(coveredCell());
      } else {
        for (let x = c1; x <= c2; x++) cells.push(coveredCell());
      }
    }
    rows.push({ cells });
  }

  return { table: { headerRowCount, alignments, rows }, consumed: idx - start };
}

module.exports = { looksLikeBorder, unescapedPipeAt, parseBorderShape, pIndexOf, parseGrid };
