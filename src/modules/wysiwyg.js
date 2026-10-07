// 所见即所得核心：块级遮罩（Typora 式「光标进块显源码，移开即恢复渲染」）。
//
// 原理（单一数据源，不做 DOM→MD 逆序列化）：
//   文本层始终是 CM 里的真实 Markdown（唯一真相）；渲染结果只是**替换源码文本的视图**
//   （markText + replacedWith，CM 自动 collapsed 隐藏块内其余源码行）。
//   光标所在块撤掉替换、显源码；移开后按最新源码重渲染并替换。
//   因为从不把渲染 DOM 反推成 Markdown，公式/图表/callout 永不损坏。
//
// 块划分：首选 UnifiedRenderer.renderMarkdownBlocks —— 用 remark 解析器的 node.position
// 切块（与阅读模式同一套解析），逐块渲染才与阅读模式一致。手写行级切块器 splitBlocks
// 仅作渲染器不可用时的回退（它对 CommonMark 边界有系统性偏差，曾把 `1.` 独立行 +
// 缩进内容拆成两块，渲染出「只剩序号的空列表项」，2026-10-07 真机反馈）。
//
// 块高抖动（用户明确要求必须消除）：
//   切换块时「渲染态高度 ↔ 源码态高度」变化会让视口内容位移。
//   做法：切换前后同步测量光标的视口 y（cursorCoords 'window'），差值回滚 scrollTop，
//   全程同帧无 rAF（异步补偿本身就是可见跳动）。
(function () {
  'use strict';

  const MASK_CLASS = 'wysiwyg-block-mask';
  // 所见即所得下「块间空行」塌缩类：Typora 式段落间距。
  // 空行若按全高渲染，块与块之间会出现一整行空白（2026-10-07 真机反馈「间隔了很多空行」）；
  // 光标所在空行例外（要显示光标与占位提示），见 syncWysiwygActiveBlock。
  const BLANK_CLASS = 'cm-wysiwyg-blank';
  // 大文档虚拟遮罩：块数超过 maxBlocks 时渲染器只切边界不渲染（skipped），
  // 遮罩按视口 ±margin 行按需挂载（阶段3 计划项「大文档整合」的落地形式）
  const WYSIWYG_MAX_BLOCKS = 80;
  const WYSIWYG_VIEWPORT_MARGIN = 60;

  // ---- 块级行解析（不依赖 mdast：mdast-util-from-markdown 只是 remark 的传递依赖，
  //      把它提升为直接依赖需重打 unified-bundle，而那属于「构建」动作，需用户授权。
  //      故用行级状态机自研，语义与 CommonMark 块级结构对齐，且可独立单测。） ----

  const RE = {
    heading: /^#{1,6}(\s|$)/,
    fence: /^(`{3,}|~{3,})/,
    hr: /^(\s*)(-\s*|\*\s*|_\s*){3,}$/,
    ul: /^(\s*)([-*+])(\s+)/,
    ol: /^(\s*)(\d{1,9})([.)])(\s+)/,
    task: /^(\s*)([-*+])(\s+)\[[ xX]\]\s+/,
    quote: /^(\s*)>/,
    table: /^\s*\|/,
    // setext 标题：上一行文本 + 本行 === / ---
    setext: /^(\s*)(=+|-+)\s*$/,
    // 缩进代码块：4 空格 / 制表符
    indentedCode: /^(\t| {4,})\S/,
  };

  function isBlank(s) { return (s || '').trim() === ''; }

  // 判断「列表能否延续到下一行」：下一个非空行是同级/更深缩进的列表项、或是列表的续行（缩进内容）
  function listContinues(nextLine) {
    if (isBlank(nextLine)) return false;
    return RE.ul.test(nextLine) || RE.ol.test(nextLine) || RE.task.test(nextLine) ||
           /^\s{2,}\S/.test(nextLine);
  }

  // 切分顶层块。返回 [{ start, end, lines }]，start/end 为 0-based 开区间 [start, end)。
  // 规则要点：
  //   - 空行只作分隔，不归属任何块（故块内不含空行）
  //   - 围栏吃到闭合围栏为止，内部 # / | / 空行都不切
  //   - 表格连续 | 行归一块
  //   - 列表（无序/有序/任务/嵌套）连续行归一块
  //   - 引用（含 callout、嵌套）连续 > 行归一块
  //   - 水平线 / 标题 / 分割线各自成块
  //   - 文档开头的 --- ... --- 视为 front matter 一块
  function splitBlocks(lines) {
    const arr = lines || [];
    const total = arr.length;
    const blocks = [];
    let i = 0;

    // front matter：首行 --- 且能找到闭合 ---
    if (total && arr[0].trim() === '---') {
      let close = -1;
      for (let k = 1; k < total; k++) {
        if (arr[k].trim() === '---') { close = k; break; }
      }
      if (close > 0) {
        blocks.push({ start: 0, end: close + 1, lines: arr.slice(0, close + 1) });
        i = close + 1;
      }
    }

    while (i < total) {
      if (isBlank(arr[i])) { i++; continue; }
      const start = i;
      const cur = arr[i];
      const curTrim = cur.trim();

      // 1) 围栏代码块
      const fence = curTrim.match(RE.fence);
      if (fence) {
        const marker = fence[1][0];
        const closeRe = new RegExp('^\\s*' + marker + '{3,}\\s*$');
        i++;
        while (i < total && !closeRe.test(arr[i])) i++;
        if (i < total) i++; // 含闭合行
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 2) 水平线（须在块首，避免把 setext 的 --- 误判）
      if (RE.hr.test(cur) && RE.hr.test(curTrim)) {
        i++;
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 3) ATX 标题：单行
      if (RE.heading.test(cur)) {
        i++;
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 4) 表格：连续 | 行（含分隔行）
      if (RE.table.test(cur)) {
        i++;
        while (i < total && RE.table.test(arr[i]) && !isBlank(arr[i])) i++;
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 5) 引用块 / callout：连续 > 行（允许 callout 内含空行？否——空行即分隔）
      if (RE.quote.test(cur)) {
        i++;
        while (i < total && (RE.quote.test(arr[i]) || (isBlank(arr[i]) && i + 1 < total && RE.quote.test(arr[i + 1])))) {
          if (isBlank(arr[i])) i++; // 吃掉 callout 中的空行
          i++;
        }
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 6) 列表（无序/有序/任务/嵌套）：连续列表行 + 其缩进续行
      if (RE.ul.test(cur) || RE.ol.test(cur) || RE.task.test(cur)) {
        i++;
        while (i < total) {
          if (isBlank(arr[i])) {
            // 空行后若仍是列表项则属同一块（松散列表），否则结束
            let k = i;
            while (k < total && isBlank(arr[k])) k++;
            const cont = k < total && (RE.ul.test(arr[k]) || RE.ol.test(arr[k]) || RE.task.test(arr[k]));
            if (!cont) break;
            i = k;
            continue;
          }
          if (RE.ul.test(arr[i]) || RE.ol.test(arr[i]) || RE.task.test(arr[i]) || listContinues(arr[i])) { i++; continue; }
          break;
        }
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 7) setext 标题（文本行 + 下一行 === / ---）
      if (i + 1 < total && !isBlank(cur) && RE.setext.test(arr[i + 1]) && !RE.hr.test(arr[i + 1].trim() + '  -')) {
        // 仅当下一行是纯 === 或 ---（不含其它内容）
        if (/^\s*=+\s*$/.test(arr[i + 1]) || /^\s*-{3,}\s*$/.test(arr[i + 1])) {
          i += 2;
          blocks.push({ start, end: i, lines: arr.slice(start, i) });
          continue;
        }
      }

      // 8) 缩进代码块
      if (RE.indentedCode.test(cur)) {
        i++;
        while (i < total && (isBlank(arr[i]) || /^\s{4,}/.test(arr[i]) || arr[i].trim() === '')) {
          if (isBlank(arr[i])) {
            let k = i;
            while (k < total && isBlank(arr[k])) k++;
            if (k < total && /^\s{4,}/.test(arr[k])) { i = k; continue; }
            break;
          }
          i++;
        }
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 9) 兜底：普通段落，吃到下一个块起点或空行为止
      i++;
      while (i < total && !isBlank(arr[i]) &&
             !RE.heading.test(arr[i]) && !RE.fence.test(arr[i].trim()) &&
             !RE.table.test(arr[i]) && !RE.quote.test(arr[i]) &&
             !(RE.ul.test(arr[i]) || RE.ol.test(arr[i]) || RE.task.test(arr[i])) &&
             !RE.hr.test(arr[i])) {
        i++;
      }
      blocks.push({ start, end: i, lines: arr.slice(start, i) });
    }

    return blocks;
  }

  const mixin = {
    // 把整篇源码切成顶层块：[{ start, end, html? }]，end 为 0-based 开区间。
    //
    // ⚠️ 首选 remark 解析器切块（UnifiedRenderer.renderMarkdownBlocks）：与阅读模式
    // 同一套解析，逐块渲染才可能与阅读模式完全一致。手写 splitBlocks 与 CommonMark
    // 边界有系统性偏差（实测 `1.` 独立行 + 缩进内容被拆开 → 渲染出「只剩序号的空列表项」，
    // 2026-10-07 真机反馈「带有序号的空行」），仅作渲染器不可用时的回退。
    computeWysiwygBlocks() {
      const cm = this.cm;
      if (!cm || !cm.lineCount) return [];
      if (typeof UnifiedRenderer !== 'undefined' && UnifiedRenderer.renderMarkdownBlocks) {
        const blocks = UnifiedRenderer.renderMarkdownBlocks(cm.getValue(), {
          softBreaks: this.settings.softBreaks,
          tabSize: this.settings.tabSize,
          extendedSyntax: this.settings.extendedSyntax,
          maxBlocks: WYSIWYG_MAX_BLOCKS,
        });
        if (blocks) return blocks; // [{ start, end, html }]
      }
      const lines = [];
      for (let i = 0; i < cm.lineCount(); i++) lines.push(cm.getLine(i));
      return splitBlocks(lines);
    },

    // 光标所在块的索引；不在任何块内（空行/文档尾）返回 -1
    wysiwygBlockIndexAt(line) {
      const blocks = this._wysiwygBlocks || [];
      for (let k = 0; k < blocks.length; k++) {
        if (line >= blocks[k].start && line < blocks[k].end) return k;
      }
      return -1;
    },

    // ---------------- 渲染 ----------------

    // 渲染单个块的最新源码为 HTML；失败返回 ''（调用方据此保持源码态）
    renderWysiwygBlockHtml(start, end) {
      const cm = this.cm;
      const lines = [];
      const total = cm.lineCount();
      for (let i = start; i < end && i < total; i++) lines.push(cm.getLine(i));
      const src = lines.join('\n');
      if (!src.trim()) return '';
      try {
        if (typeof UnifiedRenderer === 'undefined' || !UnifiedRenderer.renderMarkdown) return '';
        return UnifiedRenderer.renderMarkdown(src, {
          softBreaks: this.settings.softBreaks,
          tabSize: this.settings.tabSize,
          extendedSyntax: this.settings.extendedSyntax,
        }) || '';
      } catch (err) {
        console.error('[wysiwyg] 块渲染失败，保持源码态:', err);
        return '';
      }
    },

    // 给单个块盖遮罩（已存在则先撤掉重建）
    //
    // ⚠️ 三点踩坑史（2026-10-06 真机反馈后定型）：
    //   1) **不能用 addLineWidget**：只在行下方「附加」，不隐藏源码行 → 源码与渲染重复显示。
    //      必须 markText + replacedWith，把源码文本**真正替换**掉。
    //   2) 遮罩节点必须带 `preview-content` 类：预览排版 CSS 的作用域是 `.preview-content xxx`
    //      （styles.css 1801 起），不带该类则标题/表格/列表全部无样式，渲染完全走形。
    //   3) **不能设 pointer-events:none**：那是 overlay 时代的写法；文本已被替换，
    //      pointer-events:none 会让点击穿透到空白，CM 的坐标映射拿不到有效位置 → 点不进块。
    //      改为遮罩自己 mousedown 接管，按点击纵向比例估算目标源码行，确定性可控。
    maskWysiwygBlock(idx) {
      const cm = this.cm;
      if (!cm || !this._wysiwygBlocks) return;
      const b = this._wysiwygBlocks[idx];
      if (!b) return;
      if (!this._wysiwygMarks) this._wysiwygMarks = new Map();
      this.unmaskWysiwygBlock(idx);

      // 有缓存 html（remark 切块时已逐块渲染）直接用；否则现渲染（回退路径/旧块内容已变）
      const html = (!b.skipped && b.html !== undefined) ? b.html : this.renderWysiwygBlockHtml(b.start, b.end);
      if (!html) return;

      const total = cm.lineCount();
      const lastLine = Math.min(b.end - 1, total - 1);
      if (lastLine < b.start) return;
      const from = { line: b.start, ch: 0 };
      const to = { line: lastLine, ch: cm.getLine(lastLine).length };
      if (to.line === from.line && to.ch <= from.ch) return;

      const node = document.createElement('div');
      node.className = MASK_CLASS + ' preview-content';
      node.innerHTML = html;
      node.setAttribute('data-block-index', String(idx));
      node.setAttribute('contenteditable', 'false');
      this._postProcessWysiwygNode(node);

      let mark = null;
      const self = this;
      // 点击接管：把点击处的纵向比例映射到块内源码行，让光标落在用户点的那一行附近。
      // marker.find() 拿的是 CM 维护的实时位置（编辑后自动跟shift），故块划分变化也不会错位。
      node.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        try {
          // 任务复选框：渲染态直接切换（与阅读模式行为一致，阶段2 计划项）。
          // 渲染 HTML 带 data-source-line（勾选框同步的同一机制），可精确回写源码行。
          const box = ev.target && ev.target.closest ? ev.target.closest('input[type="checkbox"]') : null;
          if (box && !box.disabled) {
            self.toggleWysiwygTaskCheckbox(box);
            return;
          }
          const r = mark && mark.find ? mark.find() : null;
          if (!r) return;

          // 表格：点击哪一格 → 光标落到那一行的源码（阶段2 计划项「表格渲染态定位」）。
          // 源码行映射：第 0 个 tr 是表头行（= 块首行），其后每个 tbody 行 = 表头分隔行之后顺延。
          const cellEl = ev.target && ev.target.closest ? ev.target.closest('td,th') : null;
          if (cellEl) {
            const tableEl = cellEl.closest('table');
            const trs = tableEl ? Array.from(tableEl.querySelectorAll('tr')) : [];
            const rowIdx = trs.indexOf(cellEl.closest('tr'));
            if (rowIdx >= 0) {
              const line = Math.min(r.from.line + rowIdx + (rowIdx > 0 ? 1 : 0), cm.lineCount() - 1);
              self._wysiwygClickAnchor = { y: ev.clientY, line };
              // ⚠️ 必须 scroll:false：CM 的 setSelection 默认会 ensureCursorVisible（codemirror.js:5195），
              //    它会自作主张滚一次，把行顶到视口边缘；而 scrollIntoView 判定「已可见」便不再动作，
              //    锚定就此失效。滚动权要独占在 _applyWysiwygClickAnchor 手里。
              cm.setSelection({ line, ch: cm.getLine(line).length },
                { line, ch: cm.getLine(line).length }, { scroll: false, origin: '*mouse' });
              cm.focus();
              self._applyWysiwygClickAnchor();
              return;
            }
          }

          // 其余块：按点击纵向比例映射到块内源码行
          const rect = node.getBoundingClientRect();
          let target = r.from.line;
          if (rect.height > 0 && r.to.line > r.from.line) {
            const ratio = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
            target = r.from.line + Math.floor(ratio * (r.to.line - r.from.line));
          }
          const line = Math.min(Math.max(target, 0), cm.lineCount() - 1);
          // 点击锚定：撤遮罩后把该源码行放回点击时的屏幕位置，杜绝点击后视口乱跳
          self._wysiwygClickAnchor = { y: ev.clientY, line };
          // 同上：scroll:false，避免 ensureCursorVisible 抢先滚动导致锚定失效
          cm.setSelection({ line, ch: cm.getLine(line).length },
            { line, ch: cm.getLine(line).length }, { scroll: false, origin: '*mouse' });
          cm.focus();
          self._applyWysiwygClickAnchor();
        } catch (_) { /* 标记已失效则忽略本次点击 */ }
      });

      try {
        mark = cm.markText(from, to, {
          replacedWith: node,
          clearWhenEmpty: false,
          inclusiveLeft: true,
          atomic: false,
        });
        this._wysiwygMarks.set(idx, mark);
      } catch (_) { /* 区间非法则放弃该块遮罩 */ }
    },

    // 遮罩节点补跑预览后处理，保证与阅读模式渲染完全一致。
    // ⚠️ renderMarkdown 只产出结构 HTML：公式（KaTeX）与代码高亮（highlight.js）都是预览端
    //    独立的后处理 pass（preview-controller.js:207/217），遮罩里不补跑就会露出原始
    //    $$...$$ 源码与未高亮代码（真机 demo.md 实测，2026-10-07 用户反馈）。
    // 缓存的 b.html 同样是未后处理的结构 HTML（后处理只作用于 DOM），所以每次遮罩都要重跑；
    // 两个 pass 都是幂等的（KaTeX 渲染过的节点被 walker 跳过，code-scroll 包裹过的块被跳过）。
    _postProcessWysiwygNode(node) {
      // 任务列表复选框：remark-gfm 输出 disabled，与预览一致地在渲染后移除才能点击切换
      node.querySelectorAll && node.querySelectorAll('input[type="checkbox"][disabled]')
        .forEach((cb) => cb.removeAttribute('disabled'));
      try {
        if (window.PreviewPost && typeof window.PreviewPost.processMath === 'function') {
          window.PreviewPost.processMath(node);
        }
      } catch (_) { /* 公式渲染失败保持原文 */ }
      try {
        if (window.CodeBlock && typeof window.CodeBlock.processCodeBlocks === 'function'
          && typeof window.hljs !== 'undefined') {
          window.CodeBlock.processCodeBlocks(node, {
            hljs: window.hljs,
            cache: (this._wysiwygHljsCache = this._wysiwygHljsCache || new Map()),
            lineNumbers: !!(this.settings && this.settings.codeLineNumbers),
          });
        }
      } catch (_) { /* 高亮失败保持原文 */ }
    },

    // 撤掉单个块的遮罩（该块回到源码态）
    unmaskWysiwygBlock(idx) {      if (!this._wysiwygMarks) return;
      const mark = this._wysiwygMarks.get(idx);
      if (!mark) return;
      try { mark.clear(); } catch (_) { /* 已销毁 */ }
      this._wysiwygMarks.delete(idx);
    },

    // 渲染态点击任务复选框：按 data-source-line 精确回写源码行并翻转 [ ]/[x]。
    // ⚠️ data-source-line 是渲染管线写入的「渲染输入（即块切片）内 1-based 行号」，
    // 不是整篇文档行号——必须加上所在块的起始行才是真实源码行（整篇渲染时块起点为 0，二者恰好一致，
    // 阅读模式的勾选框同步因此不受影响；逐块渲染时漏加偏移会勾错行）。
    toggleWysiwygTaskCheckbox(box) {
      const cm = this.cm;
      if (!cm || !box) return;
      // 所在块：从遮罩节点的 data-block-index 取当前块表（重划分后 mask 会重建，索引即时有效）
      const maskNode = box.closest ? box.closest('.' + MASK_CLASS) : null;
      const idx = maskNode ? parseInt(maskNode.getAttribute('data-block-index'), 10) : NaN;
      const block = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;

      let el = box;
      let srcLine = null;
      while (el && el !== document) {
        const v = el.getAttribute && el.getAttribute('data-source-line');
        if (v) { srcLine = parseInt(v, 10); break; }
        el = el.parentNode;
      }
      if (!srcLine || !isFinite(srcLine)) return;
      const n = (block ? block.start : 0) + srcLine - 1;
      if (n < 0 || n >= cm.lineCount()) return;
      const m = cm.getLine(n).match(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])/);
      if (!m) return;
      cm.replaceRange(m[2] === ' ' ? 'x' : ' ',
        { line: n, ch: m[1].length }, { line: n, ch: m[1].length + 1 }, '+wysiwygTask');
      // 立即重渲染该块，不等 250ms 防抖（replaceRange 已同步触发 change → refreshWysiwygBlocks 重算块表）
      const blockIdx = this.wysiwygBlockIndexAt(n);
      const b = this._wysiwygBlocks && this._wysiwygBlocks[blockIdx];
      if (b) {
        b.html = this.renderWysiwygBlockHtml(b.start, b.end);
        this.maskWysiwygBlock(blockIdx);
      }
    },

    // ---------------- 活动块切换（增量） ----------------

    // 跨块时只处理「旧块恢复遮罩 + 新块撤遮罩」两个块。
    // ⚠️ 绝不可在此做全量重建：曾因每次光标移动触达都全量 clear+重渲染所有块，
    //    造成严重抖动与卡顿（2026-10-06 真机反馈）。
    setWysiwygActiveBlock(idx) {
      const prev = this._wysiwygActiveIdx;
      if (prev === idx) {
        // ⚠️ 点击锚定必须在这里也消费掉，不能随同 idx 直接 return。
        // 残留的 _wysiwygClickAnchor 会污染下一次普通光标移动：
        // _captureWysiwygAnchor 见它存在而跳过采样，_restoreWysiwygAnchor 却拿陈旧点击
        // 坐标做滚动 → 视口跳到无关位置（2026-10-07 真机反馈「点击后屏幕乱跳」的成因之一）。
        this._restoreWysiwygAnchor();
        return;
      }
      this._captureWysiwygAnchor();
      if (prev >= 0) {
        // 旧块刚被编辑过（活动块不遮罩、输入直接落在其中），缓存 html 已过期，
        // 必须按最新源码重渲染该块的切片
        const b = this._wysiwygBlocks && this._wysiwygBlocks[prev];
        if (b && b.html !== undefined) b.html = this.renderWysiwygBlockHtml(b.start, b.end);
        this.maskWysiwygBlock(prev);
      }
      this.unmaskWysiwygBlock(idx);
      this._wysiwygActiveIdx = idx;
      this._restoreWysiwygAnchor();
    },

    syncWysiwygActiveBlock() {
      if (this.viewMode !== 'wysiwyg' || !this.cm) return;
      if (!this._wysiwygBlocks) this._wysiwygBlocks = this.computeWysiwygBlocks();
      const line = this.cm.getCursor().line;
      // 光标落在空行：该行临时恢复全高（光标与「输入 / 可插入内容…」提示需要可见），
      // 离开后由下一次 cursorActivity / 防抖刷新收回塌缩态
      const prevCur = this._wysiwygBlankCurLine;
      if (prevCur != null && prevCur !== line) {
        const blanks = this._wysiwygBlankLines;
        this._setWysiwygBlankClass(prevCur, !!(blanks && blanks.has(prevCur)));
      }
      if (this._isWysiwygBlankLine(line)) {
        this._setWysiwygBlankClass(line, false);
        this._wysiwygBlankCurLine = line;
      } else {
        this._wysiwygBlankCurLine = null;
      }
      this.setWysiwygActiveBlock(this.wysiwygBlockIndexAt(line));
    },

    // ---------------- 抖动补偿（同步） ----------------

    // 块在「渲染态 ↔ 源码态」切换时高度会变，锚点行上方/下方内容随之位移。
    // 做法：**同步**测量光标前后视口 y 的差值并回滚滚动。
    // ⚠️ 不用 rAF：异步补偿本身就是一次可见跳动（曾经错误的写法）。
    // cm.refresh() 同步完成重排后立即测量，本帧内即修正，肉眼无跳。
    //
    // ⚠️ 点击场景不能用本机制（2026-10-07 真机反馈「点击屏幕乱跳」）：
    //    点击时 setCursor 落进**被遮罩块内部的隐藏行**，capture 在隐藏行上取
    //    cursorCoords 得到垃圾值 → 差值要么巨大被放弃（无补偿=可见跳动）、要么错误滚动。
    //    点击走 _wysiwygClickAnchor（把点击的源码行放回点击时的屏幕 y），见下方。
    _captureWysiwygAnchor() {
      const cm = this.cm;
      this._wysiwygAnchorY = null;
      if (!cm || this._wysiwygClickAnchor) return; // 点击场景走点击锚定
      try {
        const c = cm.cursorCoords(null, 'window');
        if (c && typeof c.top === 'number' && isFinite(c.top)) this._wysiwygAnchorY = c.top;
      } catch (_) { /* 量不到就不补偿 */ }
    },

    // 点击锚定的真正执行点：必须由 mousedown handler 在 setSelection 返回之后调用。
    // 此时 CM 的 operation 已结束、DOM 已完成重排，滚动不会被 pending 机制冲掉。
    // margin 语义经实测标定：目标行**精确落在距视口顶 margin 处**（80→80、337→337 线性）。
    _applyWysiwygClickAnchor() {
      const cm = this.cm;
      const click = this._wysiwygClickAnchor;
      this._wysiwygClickAnchor = null;
      if (!click || !cm) return;
      try {
        const pos = { line: Math.min(Math.max(click.line, 0), cm.lineCount() - 1), ch: 0 };
        const vh = (cm.getWrapperElement() || {}).clientHeight || 0;
        cm.scrollIntoView(pos, vh ? Math.max(8, Math.min(click.y, vh - 24)) : 80);
        // 兜底：行高超过视口等极端情况下仍在视口外，拉回距顶 80px 至少保证可见
        const c = cm.charCoords(pos, 'window');
        if (c && isFinite(c.top) && (c.top < 0 || (vh && c.top > vh - 20))) cm.scrollIntoView(pos, 80);
      } catch (_) { /* 已销毁等，忽略 */ }
    },

    _restoreWysiwygAnchor() {
      const cm = this.cm;
      // 点击场景：这里**不消费** click 锚点，滚动交给 _applyWysiwygClickAnchor。
      // ⚠️ 本方法由 cursorActivity 调起，而 cursorActivity 在 setSelection 的 operation 内部
      //    同步触发——此刻 DOM 尚未重排，CM 会把滚动记为 pending，等 operation 结束时按那时
      //    已变化的布局再应用，锚定必被冲掉（实测落点 505 而点击处是 337，差 168px）。
      //    必须等 setSelection 返回（operation 结束、DOM 已更新）后滚才有效。
      if (this._wysiwygClickAnchor) { this._wysiwygAnchorY = null; return; }
      const before = this._wysiwygAnchorY;
      this._wysiwygAnchorY = null;
      if (before == null || !cm) return;
      try {
        cm.refresh();
        const after = cm.cursorCoords(null, 'window').top;
        const delta = after - before;
        if (!delta || !isFinite(delta)) return;
        // 差值过大说明发生了结构级变化，此时补偿反而更糟，放弃
        const wrapper = cm.getWrapperElement && cm.getWrapperElement();
        const vh = wrapper ? wrapper.clientHeight : 0;
        if (vh && Math.abs(delta) > vh) return;
        const info = cm.getScrollInfo();
        cm.scrollTo(info.left, info.top + delta);
      } catch (_) { /* 已销毁等，忽略 */ }
    },

    // ---------------- 整体重建 / 清理 ----------------

    // 全量重建：仅在进入模式、切标签、打开文件时调用。
    // 输入过程中禁止调用本方法（每次按键全量重渲染 = 卡顿，见 setWysiwygActiveBlock 注释）。
    renderWysiwygMasks() {
      const cm = this.cm;
      if (!cm) return;
      this.clearWysiwygMasks();
      if (this.viewMode !== 'wysiwyg') return;
      if (!cm.lineCount || cm.lineCount() === 0) return;

      const blocks = this.computeWysiwygBlocks();
      this._wysiwygBlocks = blocks;
      this._wysiwygMarks = this._wysiwygMarks || new Map();
      if (blocks.length === 0) return;
      // 大文档：块数超限 → 渲染器跳过逐块渲染（skipped），滚动时按视口按需渲染
      this._wysiwygVirtual = !!(blocks[0] && blocks[0].skipped);
      this._ensureWysiwygScrollHook();

      this._wysiwygActiveIdx = this.wysiwygBlockIndexAt(cm.getCursor().line);
      this.updateWysiwygViewportMasks();
      try { cm.refresh(); } catch (_) { /* ignore */ }
      this.updateWysiwygBlankLines();
    },

    // 输入停止后补齐：重算块划分并对非活动块刷新渲染结果。
    // 输入期间只更新行索引缓存（极廉价），把昂贵的渲染推迟到这里。
    refreshWysiwygBlocks() {
      if (this.viewMode !== 'wysiwyg' || !this.cm) return;
      if (this._wysiwygMaskTimer) clearTimeout(this._wysiwygMaskTimer);
      const self = this;
      this._wysiwygMaskTimer = setTimeout(() => {
        self._wysiwygMaskTimer = null;
        if (self.viewMode !== 'wysiwyg') return;
        // IME 组合期间重排会打断输入法导致吞字：顺延到 compositionend（那里会再调本方法）
        if (self._wysiwygComposing) {
          self.refreshWysiwygBlocks();
          return;
        }
        // 块重划分（含解析）推迟到此处统一做；索引会位移，活动块按光标行现算
        self._wysiwygBlocks = self.computeWysiwygBlocks();
        self._wysiwygVirtual = !!(self._wysiwygBlocks[0] && self._wysiwygBlocks[0].skipped);
        self._ensureWysiwygScrollHook();
        self._wysiwygActiveIdx = self.wysiwygBlockIndexAt(self.cm.getCursor().line);
        // 全部撤掉再按视口重挂（非虚拟模式窗口=全文，等效于全量重挂）
        if (self._wysiwygMarks) {
          for (const idx of Array.from(self._wysiwygMarks.keys())) self.unmaskWysiwygBlock(idx);
        }
        self.updateWysiwygViewportMasks();
        self.updateWysiwygBlankLines();
      }, 250);
    },

    // 视口受限遮罩：小文档（≤ maxBlocks）遮全部非活动块；大文档只遮视口 ±60 行内的块，
    // 滚动时由 scroll 钩子增量挂/撤——超大文档（如 18k 行）不可能整篇挂遮罩。
    updateWysiwygViewportMasks() {
      const cm = this.cm;
      if (this.viewMode !== 'wysiwyg' || !cm || !this._wysiwygBlocks) return;
      const blocks = this._wysiwygBlocks;
      const active = this._wysiwygActiveIdx;
      let lo = 0;
      let hi = cm.lineCount();
      if (this._wysiwygVirtual) {
        const vp = cm.getViewport();
        lo = Math.max(0, vp.from - WYSIWYG_VIEWPORT_MARGIN);
        hi = Math.min(cm.lineCount(), vp.to + WYSIWYG_VIEWPORT_MARGIN);
      }
      const inWindow = (b) => b.end > lo && b.start < hi;

      // —— 滚动锚定 ——
      // 挂/撤遮罩会改变文档高度（渲染态块 ≠ 源码态块高度），不补偿则视口内容漂移，
      // 用户感知为「滚动/点击时到处乱跳」（2026-10-07 真机反馈，大文档虚拟模式最明显）。
      // 做法：更新前取视口顶行及其窗口位置，更新 + refresh 后把该行滚回原位。
      let anchor = null;
      if (this._wysiwygVirtual) {
        try {
          const wrapTop = cm.getWrapperElement().getBoundingClientRect().top;
          const topChar = cm.coordsChar({ left: 0, top: wrapTop + 2 }, 'window');
          if (topChar && typeof topChar.line === 'number' && topChar.line >= 0) {
            anchor = { line: topChar.line, winTop: cm.charCoords(topChar, 'window').top };
          }
        } catch (_) { /* 量不到就不补偿 */ }
      }

      // 撤掉窗外遮罩
      for (const [idx, mark] of Array.from(this._wysiwygMarks)) {
        const b = blocks[idx];
        if (!b || !inWindow(b)) {
          try { mark.clear(); } catch (_) { /* 已销毁 */ }
          this._wysiwygMarks.delete(idx);
        }
      }
      // 挂上窗内缺失遮罩（skipped 块在 mask 时按需渲染切片）
      for (let k = 0; k < blocks.length; k++) {
        if (k === active || this._wysiwygMarks.has(k)) continue;
        if (!inWindow(blocks[k])) continue;
        this.maskWysiwygBlock(k);
      }

      if (anchor) {
        try {
          cm.refresh();
          // 迭代收敛：markText 后 CM 的高度重算与滚动落定存在时序差，单次 scrollTo
          // 常被部分 clamp（实测残留 80~120px）。每轮量一次残差、滚一次，2px 内收敛；
          // 残差不收敛（连续同值）说明 DOM 高度尚未落定，继续也无益，随即放弃。
          let prevDelta = Infinity;
          for (let i = 0; i < 4; i++) {
            const c = cm.charCoords({ line: anchor.line, ch: 0 }, 'window');
            const delta = c && isFinite(c.top) ? c.top - anchor.winTop : 0;
            if (!delta || !isFinite(delta) || Math.abs(delta) < 2) break;
            const vh = (cm.getWrapperElement() || {}).clientHeight || 0;
            if (vh && Math.abs(delta) > vh) break; // 结构级变化，补偿只会更糟
            if (delta === prevDelta) break;        // 滚了但没效果，DOM 未落定
            prevDelta = delta;
            const info = cm.getScrollInfo();
            // 标志位防止恢复性滚动再次触发 scroll 钩子 → 二次更新 → 循环
            this._wysiwygAnchorRestoring = true;
            try { cm.scrollTo(info.left, info.top + delta); }
            finally { const self = this; setTimeout(() => { self._wysiwygAnchorRestoring = false; }, 0); }
          }
        } catch (_) { /* 忽略 */ }
      }
    },

    // scroll 钩子（幂等）：虚拟模式下滚动时增量更新视口内遮罩
    _ensureWysiwygScrollHook() {
      if (this._wysiwygScrollHooked || !this.cm) return;
      this._wysiwygScrollHooked = true;
      let t = null;
      const self = this;
      this.cm.on('scroll', () => {
        if (self.viewMode !== 'wysiwyg' || !self._wysiwygVirtual) return;
        if (self._wysiwygAnchorRestoring) return; // 滚动锚定的恢复性滚动，不再触发更新
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; self.updateWysiwygViewportMasks(); }, 120);
      });
    },

    // ---------------- 块间空行塌缩 ----------------

    _isWysiwygBlankLine(n) {
      const cm = this.cm;
      if (!cm || n < 0 || n >= cm.lineCount()) return false;
      return cm.getLine(n).trim() === '';
    },

    _setWysiwygBlankClass(n, on) {
      const cm = this.cm;
      if (!cm || n == null || n < 0 || n >= cm.lineCount()) return;
      try {
        const h = cm.getLineHandle(n);
        if (on) cm.addLineClass(h, 'wrap', BLANK_CLASS);
        else cm.removeLineClass(h, 'wrap', BLANK_CLASS);
      } catch (_) { /* 行已销毁 */ }
    },

    // 全量重算空行塌缩集合（diff 增量挂类，避免整篇 addLineClass 重刷）。
    // 调用时机：进入模式的全量重建 + 输入后的防抖补齐。光标所在空行不塌缩。
    updateWysiwygBlankLines() {
      const cm = this.cm;
      if (this.viewMode !== 'wysiwyg' || !cm) return;
      const curLine = cm.getCursor().line;
      const next = new Set();
      const total = cm.lineCount();
      for (let i = 0; i < total; i++) {
        if (i !== curLine && cm.getLine(i).trim() === '') next.add(i);
      }
      const prev = this._wysiwygBlankLines;
      if (prev) {
        for (const i of prev) if (!next.has(i)) this._setWysiwygBlankClass(i, false);
        for (const i of next) if (!prev.has(i)) this._setWysiwygBlankClass(i, true);
      } else {
        for (const i of next) this._setWysiwygBlankClass(i, true);
      }
      this._wysiwygBlankLines = next;
      this._wysiwygBlankCurLine = this._isWysiwygBlankLine(curLine) ? curLine : null;
    },

    clearWysiwygMasks() {
      if (this._wysiwygMarks) {
        for (const mark of Array.from(this._wysiwygMarks.values())) {
          try { mark.clear(); } catch (_) { /* 已销毁，忽略 */ }
        }
      }
      if (this._wysiwygMaskTimer) {
        clearTimeout(this._wysiwygMaskTimer);
        this._wysiwygMaskTimer = null;
      }
      // 撤掉所有空行塌缩类（离开模式后空行恢复全高）
      if (this._wysiwygBlankLines) {
        for (const i of this._wysiwygBlankLines) this._setWysiwygBlankClass(i, false);
      }
      if (this._wysiwygBlankCurLine != null) this._setWysiwygBlankClass(this._wysiwygBlankCurLine, false);
      this._wysiwygBlankLines = null;
      this._wysiwygBlankCurLine = null;
      this._wysiwygClickAnchor = null;
      this._wysiwygVirtual = false;
      this._wysiwygMarks = new Map();
      this._wysiwygBlocks = [];
      this._wysiwygActiveIdx = -1;
      this._wysiwygAnchorY = null;
    },
  };
  const api = { mixin, MASK_CLASS, splitBlocks };
  // 互斥式导出：浏览器 <script> 挂 window，node require 走 module.exports。
  // splitBlocks 是纯函数，测试直接 require 本文件验证块切分行为（无需 DOM/CM）。
  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    window.TMWysiwyg = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
