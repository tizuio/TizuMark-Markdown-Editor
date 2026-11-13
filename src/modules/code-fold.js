// 源码模式（viewMode='edit'）区块折叠的「折叠范围」纯函数。
//
// CodeMirror 5 的 addon/fold/markdown-fold.js 只认标题，且它把「# 标题」当作唯一折叠头。
// 本模块自定义 rangeFinder，覆盖用户要求的三类可折叠内容：
//   ① 标题章节：ATX（#~######）/ Setext（=== / --- 下划线），折到下一个同级或更高层标题前；
//   ② 围栏代码块（``` / ~~~）与展示公式（$$）：从开栏行折到闭栏行；
//   ③ GFM 表格（表头 + 分隔行 + 若干数据行）：整表折叠，表头行保留可见——表格是结构块，
//     不看行数、每张都有箭头（2026-11-14 用户截图回归：原来「连续 ≥6 行长段落」规则
//     只碰巧盖到 11 行的大表、5 行的表没箭头，同一文档两张表行为不一致）；
//   ④ 连续的大段正文（默认 ≥ 6 行，不含标题/围栏/公式/表格/列表/引用/水平线）：折到该段最后一行，第一行保留可见。
//
// 纯函数只依赖 cm 的 getLine / firstLine / lastLine / getTokenTypeAt，返回普通
// { from:{line,ch}, to:{line,ch} }（CM5 接受普通 Pos 对象），因此 jsdom/Node 可直接单测，
// 不需要真实排版引擎。浏览器侧挂到 window.TMCodeFold，editor-core 把它写进 foldOptions。
(function () {
  'use strict';

  // 连续正文达到该行数才给折叠标记；太短的段落折叠没有意义，也会让 gutter 太吵。
  const MIN_BLOCK_LINES = 6;
  const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
  const SETEXT_RE = /^ {0,3}(=+|-{2,})[ \t]*$/;
  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
  // 展示公式按「独占一行的 $$」识别（$$...$$ 单行形式不折，避免误吞相邻内容）。
  const MATH_RE = /^ {0,3}\$\$[ \t]*$/;
  const MATH_END_RE = MATH_RE;
  // 结构边界（2026-11-14 用户截图回归）：列表项 / 引用 / 水平线不属于「连续正文」。
  // 长段落折叠遇到它们必须断开，它们自身也不能当块首——否则从列表项起会把整个
  // 章节的平级列表、段落、引用全部扫进同一个「块」，点一下箭头就吞掉 14 行平级内容。
  const LIST_RE = /^ {0,3}(?:[-+*]|\d+[.)])(?:[ \t]+|$)/;
  const QUOTE_RE = /^ {0,3}>/;
  const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  // GFM 表格：数据行以 | 开头（≤3 空格缩进）；分隔行只含 | : - 空格且既有 | 又有 -。
  const TABLE_ROW_RE = /^ {0,3}\|/;
  const isTableSeparator = (line) =>
    /^[ \t>|:-]+$/.test(line) && line.includes('|') && line.includes('-');
  const isBlockLine = (line) =>
    LIST_RE.test(line) || QUOTE_RE.test(line) || HR_RE.test(line) || TABLE_ROW_RE.test(line);

  // 全文档围栏/公式标记索引（按 changeGeneration 缓存）。fenceRange 判开闭栏奇偶、
  // isInsideFence 判「行是否在未闭合块内」都要扫全文档——没有缓存时每个围栏行都是
  // O(n) 正则扫描，大文档 + 多代码块时 foldgutter 每次刷新（每次按键）都会累计 O(n²)。
  let fenceIndexCache = null;
  function fenceMarkIndex(cm) {
    if (typeof cm.changeGeneration === 'function') {
      const gen = cm.changeGeneration();
      if (fenceIndexCache && fenceIndexCache.gen === gen && fenceIndexCache.len === cm.lastLine()) {
        return fenceIndexCache.marks;
      }
      const marks = scanFenceMarks(cm);
      fenceIndexCache = { gen, marks, len: cm.lastLine() };
      return marks;
    }
    return scanFenceMarks(cm); // 纯函数单测桩（无 changeGeneration）：不缓存
  }
  function scanFenceMarks(cm) {
    const marks = [];
    for (let i = cm.firstLine(); i <= cm.lastLine(); i++) {
      const line = lineText(cm, i);
      const mark = fenceMark(line) || (MATH_RE.test(line) ? '$' : null);
      if (mark) marks.push({ line: i, mark });
    }
    return marks;
  }
  // 行 n 是否处于某个未闭合的围栏/公式内部（同种标记出现奇数次 = 在块内）。
  // 代码块/公式内部行绝不能按「长段落」挂折叠箭头——整块折叠由 fenceRange 负责。
  function isInsideFence(cm, n) {
    const counts = {};
    for (const m of fenceMarkIndex(cm)) {
      if (m.line >= n) break;
      counts[m.mark] = (counts[m.mark] || 0) + 1;
    }
    for (const k in counts) if (counts[k] % 2 === 1) return true;
    return false;
  }

  const pos = (line, ch) => ({ line, ch });
  const lineText = (cm, n) => (n <= cm.lastLine() ? (cm.getLine(n) || '') : '');

  // 标题判定优先用 mode 的 tokenType（"header header-1"）：围栏代码块里的 `# xxx`
  // 不会被 markdown 模式标成 header，天然避免误折叠；纯函数单测可只按文本降级判定。
  function isHeader(cm, n) {
    if (typeof cm.getTokenTypeAt === 'function') {
      const tt = cm.getTokenTypeAt(pos(n, 0));
      // 注意：不能「tt 为 null 就退回文本判定」——围栏代码块里的 `# xxx` 同样返回 null，
      // 一退回就会把代码里的井号误判成标题。有 mode 时以 tokenType 为唯一依据。
      return !!(tt && /\bheader\b/.test(tt));
    }
    // 无 mode 的纯函数环境（单测桩）：按文本降级判定
    const line = lineText(cm, n);
    return ATX_RE.test(line) || (SETEXT_RE.test(line) && n > 0 && !!lineText(cm, n - 1).trim());
  }

  // 返回标题层级（1~6），非标题返回 null。Setext 的下划线在下一行，层级 1/2。
  function headingLevel(cm, n) {
    const line = lineText(cm, n);
    const m = line.match(ATX_RE);
    if (m && isHeader(cm, n)) return m[1].length;
    const under = lineText(cm, n + 1);
    const u = under.match(SETEXT_RE);
    if (u && line.trim() && isHeader(cm, n + 1)) return u[1][0] === '=' ? 1 : 2;
    return null;
  }

  function fenceMark(line) {
    const m = line.match(FENCE_RE);
    return m ? m[1][0] : null;
  }

  // ② 围栏代码块 / 展示公式：只在「开栏行」返回范围，闭栏行必须存在。
  function fenceRange(cm, start) {
    const n = start.line;
    const first = lineText(cm, n);
    const mark = fenceMark(first);
    // 开栏/闭栏成对出现（``` / ~~~ / $$）：统计前面同种标记出现的次数，奇数说明
    // 当前行是【闭栏行】，不能再挂一个折叠箭头（否则会把下一个代码块一起吞进去）。
    const curMark = mark || (MATH_RE.test(first) ? '$' : null);
    let prevSame = 0;
    if (curMark) {
      for (const m of fenceMarkIndex(cm)) {
        if (m.line >= n) break;
        if (m.mark === curMark) prevSame++;
      }
    }
    const isMath = !mark && curMark === '$';
    if (!mark && !isMath) return null;
    if (prevSame % 2 === 1) return null; // 闭栏行
    let end = -1;
    for (let i = n + 1; i <= cm.lastLine(); i++) {
      const line = lineText(cm, i);
      if (isMath) {
        if (MATH_END_RE.test(line)) { end = i; break; }
      } else {
        const m = line.match(FENCE_RE);
        if (m && m[1][0] === mark) { end = i; break; }
      }
    }
    if (end < 0 || end - n < 2) return null; // 至少要有 1 行内容才值得折
    return { from: pos(n, first.length), to: pos(end, lineText(cm, end).length) };
  }

  // ① 标题章节：折到下一个层级 <= 当前层级的标题之前，去掉尾部空行。
  function headingRange(cm, start) {
    const n = start.line;
    const level = headingLevel(cm, n);
    if (level == null) return null;
    let end = n;
    for (let i = n + 1; i <= cm.lastLine(); i++) {
      const l = headingLevel(cm, i);
      if (l != null && l <= level) break;
      end = i;
    }
    while (end > n && !lineText(cm, end).trim()) end--;
    if (end <= n) return null;
    return { from: pos(n, lineText(cm, n).length), to: pos(end, lineText(cm, end).length) };
  }

  // ③ GFM 表格：表头行 + 分隔行 + 连续数据行整表折叠（不看行数，每张表都有箭头）。
  //    表头行保留可见，折叠占位出现在表头行尾；分隔行缺失（孤立 | 行）不算表格。
  function tableRange(cm, start) {
    const n = start.line;
    const first = lineText(cm, n);
    if (isInsideFence(cm, n)) return null; // 代码块内的表格由围栏规则负责
    if (!TABLE_ROW_RE.test(first)) return null;
    if (!isTableSeparator(lineText(cm, n + 1))) return null;
    let end = n + 1;
    for (let i = n + 2; i <= cm.lastLine(); i++) {
      if (TABLE_ROW_RE.test(lineText(cm, i))) end = i;
      else break;
    }
    // 至少 表头 + 分隔行 + 1 行数据 才是一张完整的表
    if (end - n + 1 < 3) return null;
    return { from: pos(n, first.length), to: pos(end, lineText(cm, end).length) };
  }

  // ④ 连续大段正文：只在块首行给标记（上一行非空则不是块首；列表/引用/水平线/表格行
  //    既不是块首、也是扫描边界），允许块内单个空行，遇到标题/围栏/公式/列表/
  //    引用/水平线/表格行即断开；不足 MIN_BLOCK_LINES 行不给标记。
  function longBlockRange(cm, start, minLines) {
    const n = start.line;
    const first = lineText(cm, n);
    if (!first.trim()) return null;
    // 处于未闭合围栏/公式内部的行绝不能当块首（整块折叠由 fenceRange 负责）：
    // 否则 ``` 后第一行、块内空行后的正文都会挂出「块内折叠」箭头。
    if (isInsideFence(cm, n)) return null;
    if (headingLevel(cm, n) != null || fenceMark(first) || MATH_RE.test(first)) return null;
    if (isBlockLine(first)) return null; // 列表/引用/水平线不是长段落的块首
    if (n > cm.firstLine()) {
      const prev = lineText(cm, n - 1);
      // 上一行也是正文 => 本行不是块首；围栏/公式闭栏行、列表/引用/水平线
      // 属于结构边界，其后的正文仍可作为新块首
      if (prev.trim() && !fenceMark(prev) && !MATH_END_RE.test(prev) && !isBlockLine(prev)) return null;
    }
    let end = n;
    let blanks = 0;
    for (let i = n + 1; i <= cm.lastLine(); i++) {
      const line = lineText(cm, i);
      if (!line.trim()) {
        blanks++;
        if (blanks >= 2) break; // 连续空行视为块结束
        end = i;
        continue;
      }
      blanks = 0;
      if (headingLevel(cm, i) != null || fenceMark(line) || MATH_RE.test(line) || isBlockLine(line)) break;
      end = i;
    }
    while (end > n && !lineText(cm, end).trim()) end--;
    const min = minLines == null ? MIN_BLOCK_LINES : minLines;
    if (end - n + 1 < min) return null;
    return { from: pos(n, first.length), to: pos(end, lineText(cm, end).length) };
  }

  // 优先级：围栏/公式 > 表格 > 标题 > 长段落。foldgutter 会对视口内每一行调用本函数。
  function rangeFinder(cm, start) {
    if (!cm || !start) return null;
    return fenceRange(cm, start) || tableRange(cm, start) || headingRange(cm, start)
      || longBlockRange(cm, start, MIN_BLOCK_LINES);
  }

  const api = {
    MIN_BLOCK_LINES,
    isHeader, headingLevel, isBlockLine, isInsideFence, isTableSeparator,
    fenceRange, tableRange, headingRange, longBlockRange, rangeFinder,
  };

  if (typeof window !== 'undefined') window.TMCodeFold = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
