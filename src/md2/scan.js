// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 表格前置扫描器。
//
// 形态与 src/unified-renderer.js 既有的 convertContainerTables 一致：
// 在 unified 管线【之前】逐行扫描，把认领到的表格转成原始 HTML 再交给 remark。
// 两者职责分离——本模块只认领 md2 语法（网格表 + 带合并标记的管道表），
// 容器内的普通 GFM 表格仍由 convertContainerTables 处理。
//
// 上下文限制（md2 §1.4）：网格表与带标记的管道表都**只在顶层块上下文**识别。
'use strict';

const { Md2ParseError } = require('./errors.js');
const { looksLikeBorder, parseGrid } = require('./grid.js');
const { hasUnescapedPipe, splitCells, isDelimiterRow, findDelimiter, parsePipe } = require('./pipe.js');

/** 该行是否属于网格表区域（用于解析失败时确定消费范围）。 */
function isGridish(line) {
  const t = line.replace(/\s+$/, '');
  return looksLikeBorder(t) || t.startsWith('|');
}

/** 连跑中是否存在未转义的 `>>` / `^^` 标记（决定是否接管这张管道表）。 */
function runHasMarker(run, delim) {
  for (let r = 0; r < run.length; r++) {
    if (r === delim) continue;
    for (const cell of splitCells(run[r])) {
      const t = cell.trim();
      if (t.startsWith('\\')) continue; // 转义：字面文本
      if (t.startsWith('>>') || t.startsWith('^^')) return true;
    }
  }
  return false;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 默认错误块。只使用 class（rehype-sanitize 的 schema 允许 `*` 上的 class），
 * 不使用 data-* 属性，避免被 sanitize 剥离导致样式失效。
 */
function defaultRenderError(err, rawLines) {
  return (
    `<div class="md2-error">` +
    `<strong>md2 ${escapeHtml(err.kind)}</strong> (line ${err.line}): ${escapeHtml(err.message)}` +
    `<pre>${escapeHtml(rawLines.join('\n'))}</pre>` +
    `</div>`
  );
}

/** 围栏标记：返回 { char, len, info } 或 null。
 *  info 取标记之后的剩余子串，而不用正则 `(.*)$` 捕获：JS 的 `.` 不匹配 `\r`
 *  （`\r` 是行终止符），`(.*)$` 会让 CRLF 输入的 "```\r" 整体匹配失败 → 围栏态
 *  彻底失效（本模块的 content 契约不要求调用方先归一化换行，故不能依赖它）。 */
function fenceInfo(line) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  return { char: m[1][0], len: m[1].length, info: line.slice(m[0].length) };
}

/** ATX 标题：`#` 后必须跟空白或行尾（`#foo` 是普通段落文本）。 */
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;

/** 主题分隔线：3 个以上同类符号，符号间可含空白。 */
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

/**
 * 第 `i` 行之前是否存在**块边界**——即从 `i` 开始的管道连跑是新块，而非段落延续。
 *
 * 这是 md2 §4.3 段落中断规则的本地近似。md2 规定：管道表只有在**不中断段落**时
 * 才成立，而中断仅允许「分隔行位于第 2 行」（GFM 形态）；两行及以上表头必须位于
 * 块边界之后。规则只取决于分隔行位置，与是否带 `>>` / `^^` 标记无关——已用真实
 * `md2.exe render` 对照确认（带标记但紧跟段落的连跑，md2 输出的是段落）。
 *
 * 能识别：文档开头、空行、围栏（开或闭）、ATX 标题、主题分隔线、网格表边框。
 * **不能识别**（已知缺口，见计划「已知缺口」节）：列表项、块引用、HTML 块、
 * 缩进代码。未识别时一律按「非边界」处理——即不认领、退化为改动前的行为，
 * 只会少认，不会多认。
 */
function precededByBlockBoundary(lines, i) {
  if (i === 0) return true;
  const prev = lines[i - 1];
  if (prev.trim() === '') return true;
  if (fenceInfo(prev)) return true;
  if (ATX_HEADING.test(prev)) return true;
  if (THEMATIC_BREAK.test(prev)) return true;
  if (looksLikeBorder(prev)) return true;
  return false;
}

/**
 * 把一行分隔行「中性化」：转义其中第一个 `-` 或 `:`，使它不再匹配 remark-gfm 的
 * 分隔行形态。**可见文本不变**——段落里的 `\-` 与 `-` 等价、`\:` 与 `:` 等价。
 *
 * 为什么需要：判定为「整块其实是段落」的连跑，仅靠不认领还不够。remark-gfm 会
 * 从段落尾部把「最后一行 + 下一行分隔行」再拼成一张表（md2 对照：同样输入 md2
 * 输出的是**一个** `<p>`，我们只放行的话会得到 `<p>…</p><table>…</table>`）。
 *
 * 只需转义一个字符即可：分隔行的**每一格**都必须是 `:?-+:?`，破坏任意一格整行即失效。
 */
function neutralizeDelimiterRow(line) {
  return line.replace(/[-:]/, '\\$&');
}

/**
 * 扫描并把 md2 表格替换为 HTML。
 * @param {string} content 整篇 markdown
 * @param {object} opts
 * @param {(table: object, renderCellContent: Function) => string} opts.renderTable 表格渲染器（来自 html.js）
 * @param {(content: string) => string} opts.renderCellContent 单元格内容渲染回调
 * @param {(err: Md2ParseError, rawLines: string[]) => string} [opts.renderError]
 * @returns {string}
 */
function convertMd2Tables(content, opts) {
  const renderTable = opts.renderTable;
  const renderCellContent = opts.renderCellContent;
  const renderError = opts.renderError || defaultRenderError;

  const lines = content.split('\n');
  const out = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const f = fenceInfo(line);
    if (f) {
      if (!inFence) {
        inFence = true;
        fenceChar = f.char;
        fenceLen = f.len;
      } else if (f.char === fenceChar && f.len >= fenceLen && f.info.trim() === '') {
        // 闭合围栏不得带 info string（CommonMark）；否则 ```` ```js ```` 会被
        // 误当成闭合行，提前退出围栏态并认领仍在围栏内的表格。
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      out.push(line);
      i += 1;
      continue;
    }
    if (inFence) {
      out.push(line);
      i += 1;
      continue;
    }

    // ---- 网格表（仅顶层）----
    if (looksLikeBorder(line)) {
      try {
        const { table, consumed } = parseGrid(lines, i);
        out.push(renderTable(table, renderCellContent));
        i += consumed;
        continue;
      } catch (e) {
        if (!(e instanceof Md2ParseError)) throw e;
        let j = i;
        while (j < lines.length && isGridish(lines[j])) j += 1;
        out.push(renderError(e, lines.slice(i, j)));
        i = j;
        continue;
      }
    }

    // ---- 管道表（仅当含合并标记时接管）----
    if (hasUnescapedPipe(line)) {
      let j = i;
      while (j < lines.length && hasUnescapedPipe(lines[j])) j += 1;
      const run = lines.slice(i, j);
      const delim = findDelimiter(run);
      // §4.2 / 上游 parse/mod.rs `Some(0) => false`：分隔行不得是连跑首行。
      // 否则 parsePipe 会静默产出 headerRowCount = 0 的表（把表头当表体）。
      //
      // §4.3 多行表头：分隔行之前的每一行都是表头行。GFM 只认「分隔行在第 2 行」，
      // 故多行表头的连跑必须由本模块认领——否则 remark-gfm 会把首行甩成段落、
      // 只留最后一行当表头。
      //
      // 三个合取项：
      //   1. `delim !== 0`    —— 分隔行不得是首行（§4.2）
      //   2. 不中断段落       —— 仅 `delim === 1` 允许中断；多行表头须在块边界之后
      //   3. 值得认领         —— `delim > 1`（GFM 表达不了），或存在合并标记
      //
      // `delim === 1` 时第 2 项恒真 ⇒ 既有的标记路径行为完全不变。
      // `delim > 1` 时第 3 项恒真 ⇒ 无标记的多行表头表也获得支持。
      const blockBoundary = precededByBlockBoundary(lines, i);
      const claimable =
        delim !== null &&
        delim !== 0 &&
        (delim === 1 || blockBoundary) &&
        (delim > 1 || runHasMarker(run, delim));
      if (claimable) {
        try {
          const table = parsePipe(run, delim, i + 1);
          out.push(renderTable(table, renderCellContent));
          i = j;
          continue;
        } catch (e) {
          if (!(e instanceof Md2ParseError)) throw e;
          out.push(renderError(e, run));
          i = j;
          continue;
        }
      }
      // 未认领：整条连跑一次跳过（围栏标记行除外——它必须回到主循环切换围栏态）。
      //
      // 不能退化成 `i += 1`：那会在段落中间重新起算「子连跑」，把一个本该整段
      // 是段落的块，误判成从中间某行开始的表格。md2 §4.3 是**块级**判定，不
      // 允许这样切分——已用真实 md2.exe 对照确认（段落中间的 `| c | d |` /
      // `| - | - |` 不构成表格；退化成 `i += 1` 会认出一张 h=1 的假表）。
      //
      // 顺带：这也让大 GFM 表不再触发 O(m²) 重推导（未跳过整条时实测 4000 行
      // ~1.9s、20000 行 ~40s；改为一次跳过整条后 4ms）。
      //
      // 整块其实是段落（§4.3：多行表头不得中断段落）⇒ 不认领还不够，连跑里的
      // 分隔行必须中性化，否则 remark-gfm 会从段落尾部自行再拼一张表出来。
      const paragraphBlock = delim !== null && delim > 1 && !blockBoundary;

      let k = i + 1;
      while (k < j && !fenceInfo(lines[k])) k += 1;
      for (let x = i; x < k; x += 1) {
        const ln = lines[x];
        out.push(paragraphBlock && isDelimiterRow(ln) ? neutralizeDelimiterRow(ln) : ln);
      }
      i = k;
      continue;
    }

    out.push(line);
    i += 1;
  }

  return out.join('\n');
}

module.exports = { convertMd2Tables };
