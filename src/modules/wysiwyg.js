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
  // 全量预渲染 + 全量视图驻留：行数 ≤ 该值时，进入所见即所得先在后台一次性渲染全部块（模式按钮
  // 显示「渲染中」），并把整篇文档设为 CM 视口——所有行恒渲染、行高恒实测、不释放不重估，几何自愈，
  // 根治快速滚动时的源码闪现与落点漂移（2026-10-09 用户实测需求）。超过该值仍走虚拟按需 + 增强预取。
  const WYSIWYG_FULL_RENDER_MAX_LINES = 10000;
  // 虚拟模式（>上限的大文档）增强预取边距（行）：沿滚动方向加大遮罩窗口，
  // 让用户到达之前遮罩已就绪（快速滚动零源码闪现）；尾随方向保持原边距防新露区闪
  const WYSIWYG_PREFETCH_MARGIN = 200;

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
    // parseOnly：只切块边界不渲染 html（skipHtml）——全量模式输入后的增量刷新只需新块边界，
    // 未变块的 markText 标记由 CM 自动跟随文本（marker.find() 实时位置），仅重挂变化块。
    computeWysiwygBlocks(parseOnly) {
      const cm = this.cm;
      if (!cm || !cm.lineCount) return [];
      if (typeof UnifiedRenderer !== 'undefined' && UnifiedRenderer.renderMarkdownBlocks) {
        const blocks = UnifiedRenderer.renderMarkdownBlocks(cm.getValue(), {
          softBreaks: this.settings.softBreaks,
          tabSize: this.settings.tabSize,
          extendedSyntax: this.settings.extendedSyntax,
          skipHtml: !!parseOnly,
          maxBlocks: parseOnly ? undefined : WYSIWYG_MAX_BLOCKS,
        });
        if (blocks) return blocks; // [{ start, end, html }]
      }
      const lines = [];
      for (let i = 0; i < cm.lineCount(); i++) lines.push(cm.getLine(i));
      return splitBlocks(lines);
    },

    // 全量预渲染（后台步骤）：全部块边界 + 全部块 html 一次渲染完成（唯一昂贵步骤，
    // 1–3 秒量级）。返回带 html 的块表；解析失败等异常返回 null 由调用方兜底。
    precomputeWysiwygBlocksFull() {
      const cm = this.cm;
      if (!cm || !cm.lineCount || cm.lineCount() === 0) return null;
      let blocks = null;
      if (typeof UnifiedRenderer !== 'undefined' && UnifiedRenderer.renderMarkdownBlocks) {
        blocks = UnifiedRenderer.renderMarkdownBlocks(cm.getValue(), {
          softBreaks: this.settings.softBreaks,
          tabSize: this.settings.tabSize,
          extendedSyntax: this.settings.extendedSyntax,
          maxBlocks: Infinity, // 一块不跳：全量预渲染
        });
      }
      if (!blocks) {
        // 回退切块器（无 html，遮罩时按需渲染）
        const lines = [];
        for (let i = 0; i < cm.lineCount(); i++) lines.push(cm.getLine(i));
        blocks = splitBlocks(lines);
      }
      // 块源文本 = 增量刷新的同一性键（源未变 → 标记/高度可保留）
      for (const b of blocks) b.src = this._wysiwygBlockSource(b);
      return blocks;
    },

    // 块的源文本切片（同一性键）
    _wysiwygBlockSource(b) {
      const cm = this.cm;
      if (!cm || !b) return '';
      const total = cm.lineCount();
      const end = Math.min(b.end, total);
      const parts = [];
      for (let i = b.start; i < end; i++) parts.push(cm.getLine(i));
      return parts.join('\n');
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
      this._wysiwygMaskTypography(node);
      this._postProcessWysiwygNode(node);

      let mark = null;
      const self = this;
      // 点击接管：把点击处的纵向比例映射到块内源码行，让光标落在用户点的那一行附近。
      // marker.find() 拿的是 CM 维护的实时位置（编辑后自动跟shift），故块划分变化也不会错位。
      node.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        // 代码块复制按钮：放行 click（拦截 mousedown 会吞掉 click、光标被拽到源码行，
        // 复制按钮点不动）。按钮自身已阻止冒泡，这里只需不 preventDefault。
        if (ev.target && ev.target.closest && ev.target.closest('button.copy-btn')) return;
        ev.preventDefault();
        try {
          // 图片：打开灯箱（与阅读模式一致）。src 未就绪（相对路径/裂图）时落到行定位，
          // 方便直接编辑图片这一行。
          const imgEl = ev.target && ev.target.closest ? ev.target.closest('img') : null;
          if (imgEl) {
            const imgSrc = imgEl.getAttribute('src');
            if (imgSrc && /^(data:|https?:|blob:)/.test(imgSrc) && self.showImageLightbox) {
              self.showImageLightbox(imgSrc);
              return;
            }
          }
          // Mermaid 图表：打开图表查看器（与阅读模式一致，锚点取容器内 svg）
          const mermaidEl = ev.target && ev.target.closest ? ev.target.closest('.mermaid-container') : null;
          if (mermaidEl) {
            const svg = mermaidEl.querySelector('svg');
            if (svg && self.showLightbox) self.showLightbox(svg, 'svg');
            return;
          }
          // 链接：与阅读模式同一分派（页内锚点滚动 / 外链系统浏览器 / .md 开 tab）
          const linkEl = ev.target && ev.target.closest ? ev.target.closest('a') : null;
          if (linkEl && self.handlePreviewLinkClick) {
            self.handlePreviewLinkClick(linkEl);
            return;
          }
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
        // 异步 pass（图片 / Mermaid / TOC / 代码块滚动条）：节点入 DOM 后才跑，
        // 就绪后高度变化用「测前测后 + 滚动补偿」保持视口（SVG/图片撑高不得冲走用户正在看的内容）。
        this._wysiwygPostProcessAsync(node, idx);
      } catch (_) { /* 区间非法则放弃该块遮罩 */ }
    },

    // 遮罩排版同步：所见即所得的渲染态必须与阅读模式「完全一致」，而阅读模式的字体/字号/
    // 行高/代码字体是 applySettings 以**内联样式**写在 #preview 上的（字号 16px、行高 1.7、
    // 预览字体栈、--font-code-preview），CSS 变量只承载字重。遮罩节点不在 #preview 子树里，
    // 若只靠 .preview-content 的 CSS，字号会继承 CodeMirror 的 14px、字体族/代码字体丢失——
    // 与阅读模式肉眼可辨（2026-10-08 用户截图反馈）。故逐项复制 #preview 的**计算值**。
    _wysiwygMaskTypography(node) {
      try {
        if (!this.preview) return;
        const cs = getComputedStyle(this.preview);
        if (cs && cs.fontSize) node.style.fontSize = cs.fontSize;
        if (cs && cs.lineHeight) node.style.lineHeight = cs.lineHeight;
        if (cs && cs.fontFamily) node.style.fontFamily = cs.fontFamily;
        const codeFont = this.preview.style.getPropertyValue('--font-code-preview');
        if (codeFont) node.style.setProperty('--font-code-preview', codeFont);
        // 代码块行号/换行/滚动条的显示由 #preview 上的类控制（CSS 作用域 .preview-content.xxx），
        // 遮罩同带 preview-content 类，需同步同类才吃到同样式
        for (const cls of ['code-line-numbers', 'code-wrap', 'code-no-scroll']) {
          node.classList.toggle(cls, this.preview.classList.contains(cls));
        }
      } catch (_) { /* 排版同步失败不阻断遮罩 */ }
    },

    // 遮罩节点补跑预览后处理，保证与阅读模式渲染完全一致。
    // ⚠️ renderMarkdown 只产出结构 HTML：阅读模式的后处理链（preview-controller.js render()）依次是
    //    图片(processImages) → emoji → 数学(KaTeX) → 缩写 → 脚注(点击) → 标题锚点 → Mermaid →
    //    复制按钮 → 代码高亮，遮罩里逐一补跑（同步部分在此，异步部分见 _wysiwygPostProcessAsync），
    //    顺序与阅读模式一致（复制按钮必须在代码高亮之前，按钮才落在 pre 上）。
    // 缓存的 b.html 同样是未后处理的结构 HTML（后处理只作用于 DOM），所以每次遮罩都要重跑；
    // 各 pass 均幂等（KaTeX 渲染过的节点被 walker 跳过，code-scroll 包裹过的块被跳过）。
    _postProcessWysiwygNode(node) {
      const postOpts = {
        t: (k) => (this.t ? this.t(k) : k),
        isDark: !!this.isDark,
        escapeHtml: (s) => (this.escapeHtml ? this.escapeHtml(s) : String(s == null ? '' : s)),
        escapeAttr: (s) => (this.escapeAttr ? this.escapeAttr(s) : String(s == null ? '' : s)),
        headingToId: (s) => (this.headingToId ? this.headingToId(s) : String(s == null ? '' : s)),
        mermaidCache: this._mermaidCache,
      };
      // 任务列表复选框：remark-gfm 输出 disabled，与预览一致地在渲染后移除才能点击切换
      node.querySelectorAll && node.querySelectorAll('input[type="checkbox"][disabled]')
        .forEach((cb) => cb.removeAttribute('disabled'));
      // details 展开（阅读模式 render() 同款：折叠块在预览里默认全展开）
      try {
        node.querySelectorAll && node.querySelectorAll('details:not([open])')
          .forEach((el) => { el.open = true; });
      } catch (_) {}
      try {
        if (window.PreviewPost && typeof window.PreviewPost.processEmojiShortcodes === 'function') {
          window.PreviewPost.processEmojiShortcodes(node);
        }
      } catch (_) { /* emoji 失败保持短码原文 */ }
      try {
        if (window.PreviewPost && typeof window.PreviewPost.processMath === 'function') {
          window.PreviewPost.processMath(node);
        }
      } catch (_) { /* 公式渲染失败保持原文 */ }
      try {
        if (window.PreviewPost && typeof window.PreviewPost.processAbbreviations === 'function') {
          window.PreviewPost.processAbbreviations(node, postOpts);
        }
      } catch (_) { /* 缩写失败保持原文 */ }
      try {
        if (window.PreviewPost && typeof window.PreviewPost.processHeadings === 'function') {
          window.PreviewPost.processHeadings(node, postOpts);
        }
      } catch (_) { /* 锚点失败不影响显示 */ }
      try {
        if (window.PreviewPost && typeof window.PreviewPost.addCopyButtons === 'function') {
          window.PreviewPost.addCopyButtons(node, postOpts);
        }
      } catch (_) { /* 复制按钮失败不影响显示 */ }
      try {
        if (window.CodeBlock && typeof window.CodeBlock.processCodeBlocks === 'function'
          && typeof window.hljs !== 'undefined') {
          // 行号开关与阅读模式同源：看 #preview 的 code-line-numbers 类（同一设置写入）
          window.CodeBlock.processCodeBlocks(node, {
            hljs: window.hljs,
            cache: (this._wysiwygHljsCache = this._wysiwygHljsCache || new Map()),
            lineNumbers: !!(this.preview && this.preview.classList.contains('code-line-numbers')),
          });
        }
      } catch (_) { /* 高亮失败保持原文 */ }
    },

    // 遮罩异步 pass：图片读盘转 base64、Mermaid 渲染、[TOC] 目录、代码块滚动条。
    // 与阅读模式 render() 的异步部分对齐；全部 fire-and-forget，失败静默降级（保持源码/原文）。
    _wysiwygPostProcessAsync(node, idx) {
      const cm = this.cm;
      if (!node || !cm || typeof node.isConnected !== 'boolean' || !node.isConnected) return;
      const gen = (this._wysiwygMaskGen = this._wysiwygMaskGen || 0);
      const settled = () => {
        // 遮罩已重建（gen 变化）或节点已摘除：不再动 DOM
        if (this._wysiwygMaskGen !== gen || !node.isConnected) return false;
        return true;
      };
      // 图片：相对路径 → 本地读盘 base64（与阅读模式 processImages 同一纯函数、同一缓存）
      try {
        if (typeof ImageProcessor !== 'undefined' && ImageProcessor.processImages
            && typeof TauriApi !== 'undefined' && node.querySelector('img')) {
          ImageProcessor.processImages(node, {
            activeTab: this.activeTab,
            imageCache: (this._imageBase64Cache = this._imageBase64Cache || new Map()),
            tauri: TauriApi,
            getCachedImageURL: (u) => (this.getCachedImageURL ? this.getCachedImageURL(u) : u),
            getRenderGeneration: () => this._wysiwygMaskGen,
          }).then(() => { if (settled()) this._wysiwygRefreshAfterMaskChange(); })
            .catch((e) => console.warn('[wysiwyg] Images error:', e));
        }
      } catch (e) { console.warn('[wysiwyg] Images error:', e); }
      // Mermaid：与阅读模式同一 pass + 同一 mermaidCache（命中缓存时近乎同步）
      try {
        if (typeof mermaid !== 'undefined' && window.PreviewPost
            && typeof window.PreviewPost.processMermaid === 'function'
            && node.querySelector('code.language-mermaid')) {
          const postOpts = {
            t: (k) => (this.t ? this.t(k) : k),
            isDark: !!this.isDark,
            escapeHtml: (s) => (this.escapeHtml ? this.escapeHtml(s) : String(s == null ? '' : s)),
            escapeAttr: (s) => (this.escapeAttr ? this.escapeAttr(s) : String(s == null ? '' : s)),
            headingToId: (s) => (this.headingToId ? this.headingToId(s) : String(s == null ? '' : s)),
            mermaidCache: this._mermaidCache,
          };
          window.PreviewPost.processMermaid(node, postOpts).then(() => {
            if (settled()) this._wysiwygRefreshAfterMaskChange();
          }).catch((e) => console.warn('[wysiwyg] Mermaid error:', e));
        }
      } catch (e) { console.warn('[wysiwyg] Mermaid error:', e); }
      // [TOC]：阅读模式用 Rust generate_toc 生成整篇目录替换 [TOC] 段，遮罩同款
      try { this._wysiwygReplaceToc(node).then(() => { if (settled()) this._wysiwygRefreshAfterMaskChange(); }); }
      catch (_) { /* TOC 失败保持 [TOC] 原文 */ }
      // 代码块滚动条：阅读模式按 codeScroll 设置控制 overflowY（同步做，与阅读模式同款；
      // 节点此刻已在 DOM 里，scrollHeight 读取会强制同步回流，高度是准的）
      try {
        if (this.settings && this.settings.codeScroll === false) {
          node.querySelectorAll('pre > code > .code-scroll').forEach((cs2) => {
            cs2.style.overflowY = cs2.scrollHeight > cs2.clientHeight ? 'auto' : 'hidden';
          });
        }
      } catch (_) {}
    },

    // 遮罩内容高度变化（公式/图片/Mermaid/TOC 就绪）后：刷新 CM 测量并补偿滚动，
    // 让视口内容不漂移（与阅读模式「内容长高」的自然观感一致，而不是被推走）。
    _wysiwygRefreshAfterMaskChange() {
      try {
        const cm = this.cm;
        if (!cm) return;
        const wrapper = cm.getWrapperElement();
        const topY = wrapper.getBoundingClientRect().top + 2;
        const anchor = cm.coordsChar({ left: 0, top: topY }, 'window');
        if (!anchor) { cm.refresh(); return; }
        const before = cm.charCoords(anchor, 'window').top;
        cm.refresh();
        const after = cm.charCoords(anchor, 'window').top;
        const delta = after - before;
        if (delta && Math.abs(delta) < (wrapper.clientHeight || 1e9)) {
          const info = cm.getScrollInfo();
          cm.scrollTo(info.left, info.top + delta);
        }
      } catch (_) { /* 刷新失败无妨，下次输入会重建遮罩 */ }
    },

    // [TOC] 段替换：阅读模式 render() 的 replace 逻辑同款（正则找 <p>[TOC]</p>，
    // 换成 toc-wrapper + Rust 生成的目录 HTML）。TOC 依赖整篇内容，按内容缓存 promise，
    // 遮罩频繁重建不重复 invoke。
    _wysiwygReplaceToc(node) {
      const p = node && node.querySelector ? node.querySelector('p') : null;
      if (!p || !/^\[TOC\]$/i.test((p.textContent || '').trim())) return Promise.resolve();
      if (typeof TauriApi === 'undefined' || typeof TauriApi.generateToc !== 'function') return Promise.resolve();
      const cm = this.cm;
      if (!cm) return Promise.resolve();
      const content = cm.getValue();
      if (!this._wysiwygToc || this._wysiwygToc.value !== content) {
        this._wysiwygToc = { value: content, promise: TauriApi.generateToc({ content }) };
      }
      return this._wysiwygToc.promise.then((tocHtml) => {
        if (!tocHtml || !node.isConnected) return;
        const line = p.getAttribute('data-source-line');
        const wrap = document.createElement('div');
        wrap.className = 'toc-wrapper';
        if (line) wrap.setAttribute('data-source-line', line);
        wrap.innerHTML = tocHtml;
        p.replaceWith(wrap);
      });
    },

    // 所见即所得的编辑器外壳同步：
    //   1) 行号——所见即所得下隐藏（与阅读模式一致，无编辑 gutter），离开时按设置恢复；
    //   2) 最大宽度——设置 maxWidth 时与阅读模式同款居中（阅读模式是 #preview 内联
    //      max-width + margin:0 auto，遮罩在 CM 行流里，对 .CodeMirror-lines 做等价处理）。
    // 在 renderWysiwygMasks（进入）/ clearWysiwygMasks（离开）/ applySettings（设置变更）调用。
    applyWysiwygEditorChrome() {
      const cm = this.cm;
      if (!cm) return;
      const on = this.viewMode === 'wysiwyg';
      try {
        cm.setOption('lineNumbers', on ? false : !!(this.settings && this.settings.lineNumbers));
      } catch (_) { /* 切换失败不阻断 */ }
      let linesEl = null;
      try {
        const wrapper = cm.getWrapperElement();
        linesEl = wrapper ? wrapper.querySelector('.CodeMirror-lines') : null;
      } catch (_) {}
      if (linesEl) {
        const inset = on && this.settings && this.settings.maxWidth;
        linesEl.style.maxWidth = inset ? this.settings.maxWidth + 'px' : '';
        linesEl.style.marginLeft = inset ? 'auto' : '';
        linesEl.style.marginRight = inset ? 'auto' : '';
      }
    },

    // 所见即所得下的 #锚点 跳转（TOC 链接 / 文中交叉引用）：目标标题在某个遮罩节点里，
    // 优先用「块偏移 + data-source-line」还原绝对行号；遮罩未渲染（大文档虚拟模式）时
    // 回退为按 headingToId 匹配源码标题行。定位后复用点击锚定机制，滚动行为与点遮罩一致。
    _wysiwygScrollToAnchor(id) {
      const cm = this.cm;
      if (!cm || !id) return;
      let line = null;
      let target = null;
      try {
        const el = document.getElementById ? document.getElementById(id)
          : (document.querySelector && (typeof CSS !== 'undefined' ? document.querySelector(`#${CSS.escape(id)}`) : null));
        if (el) {
          target = el;
          const mask = el.closest ? el.closest('.' + MASK_CLASS) : null;
          if (mask) {
            const idx = parseInt(mask.getAttribute('data-block-index'), 10);
            const block = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;
            let el2 = el;
            let srcLine = null;
            while (el2 && el2 !== document) {
              const v = el2.getAttribute && el2.getAttribute('data-source-line');
              if (v) { srcLine = parseInt(v, 10); break; }
              el2 = el2.parentNode;
            }
            if (srcLine && block) line = block.start + Math.max(0, srcLine - 1);
          }
        }
      } catch (_) {}
      if (line == null) {
        // 回退：源码里找 id 匹配的标题行（虚拟模式/目标块未渲染时兜底）
        try {
          const toId = this.headingToId || ((t) => t);
          const n = cm.lineCount();
          for (let i = 0; i < n; i++) {
            const m = cm.getLine(i).match(/^ {0,3}(#{1,6})\s+(.*)$/);
            if (m && toId(m[2].trim()) === id) { line = i; break; }
          }
        } catch (_) {}
      }
      if (line == null || line < 0 || line >= cm.lineCount()) return;
      try {
        cm.operation(() => {
          cm.setSelection({ line, ch: 0 }, { line, ch: cm.getLine(line).length }, { scroll: false });
          cm.focus();
        });
        // 目标行滚到视口中部（与阅读模式锚点跳转观感一致），再闪显
        this._wysiwygScrollLineToCenter(line);
        if (target) {
          target.classList.add('footnote-flash');
          setTimeout(() => target.classList.remove('footnote-flash'), 1300);
        }
      } catch (_) { /* 定位失败静默 */ }
    },

    // 把指定源码行滚动到编辑视口垂直中部（scrollIntoView 的 margin 语义做不到「居中」，
    // 用 charCoords 实测 + scrollTo 精确补偿）
    _wysiwygScrollLineToCenter(line) {
      try {
        const cm = this.cm;
        if (!cm) return;
        const info = cm.getScrollInfo();
        const top = cm.charCoords({ line, ch: 0 }, 'local').top;
        const bottom = cm.charCoords({ line, ch: cm.getLine(line).length }, 'local').bottom;
        const h = Math.max(1, bottom - top);
        // 视口高用 scroller 元素实测（CM5 scrollInfo 的可视高度字段各版本不一）
        let scroller = null;
        try { scroller = cm.getScrollerElement ? cm.getScrollerElement() : null; } catch (_) {}
        const viewportH = (scroller && scroller.clientHeight) || 600;
        cm.scrollTo(info.left, Math.max(0, top - (viewportH - h) / 2));
      } catch (_) {}
    },

    // 撤掉单个块的遮罩（该块回到源码态）
    unmaskWysiwygBlock(idx) {      if (!this._wysiwygMarks) return;
      const mark = this._wysiwygMarks.get(idx);
      if (!mark) return;
      try { mark.clear(); } catch (_) { /* 已销毁 */ }
      this._wysiwygMarks.delete(idx);
      // 遮罩已换：让旧节点上未完成的异步 pass（图片/Mermaid/TOC）感知过期，停写 DOM
      this._wysiwygMaskGen = (this._wysiwygMaskGen || 0) + 1;
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
        b.src = this._wysiwygBlockSource(b); // 源文本键同步，全量增量刷新才判得出变化
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
        // 旧块刚被编辑过，缓存 html 过期，需重渲
        const b = this._wysiwygBlocks && this._wysiwygBlocks[prev];
        if (b && b.html !== undefined) { b.html = this.renderWysiwygBlockHtml(b.start, b.end); b.src = this._wysiwygBlockSource(b); }
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
      // 先取走后台预渲染的块表快照（clearWysiwygMasks 会清掉未消费的结果）
      const preBlocks = this._wysiwygPreRenderedBlocks;
      const preValue = this._wysiwygPreRenderedValue;
      this._wysiwygPreRenderedBlocks = null;
      this._wysiwygPreRenderedValue = null;
      this.clearWysiwygMasks();
      if (this.viewMode !== 'wysiwyg') return;
      if (!cm.lineCount || cm.lineCount() === 0) return;
      // 进入/停留在所见即所得：编辑器外壳按阅读模式对齐（去行号、maxWidth 居中）
      this.applyWysiwygEditorChrome();

      // 全量预渲染：行数 ≤ 上限 → 整篇文档成为 CM 视口（所有行恒渲染 + 恒实测高度、
      // 不释放不重估、几何自愈）；超限 → 虚拟模式（视口 ± 增强预取按需挂遮罩）
      const full = cm.lineCount() <= WYSIWYG_FULL_RENDER_MAX_LINES;
      this._wysiwygFull = full;

      // 块表：优先复用后台预渲染结果（昂贵步骤已完成、且预渲染期间源文未变）；
      // 否则全量模式前台全量渲染（单一同步任务：遮罩就绪后浏览器一次成帧，
      // 不露源码中间态），虚拟模式保持原逻辑
      let blocks = (preBlocks && preValue != null && cm.getValue() === preValue) ? preBlocks : null;
      if (!blocks) blocks = full ? this.precomputeWysiwygBlocksFull() : this.computeWysiwygBlocks();
      this._wysiwygBlocks = blocks || [];
      this._wysiwygMarks = this._wysiwygMarks || new Map();
      if (this._wysiwygBlocks.length === 0) return;
      // 大文档：块数超限 → 渲染器跳过逐块渲染（skipped），滚动时按视口按需渲染
      this._wysiwygVirtual = !full && !!(this._wysiwygBlocks[0] && this._wysiwygBlocks[0].skipped);
      this._ensureWysiwygScrollHook();

      this._wysiwygActiveIdx = this.wysiwygBlockIndexAt(cm.getCursor().line);
      if (full) {
        this._enterWysiwygFullView();
      } else {
        this.updateWysiwygViewportMasks();
      }
      try { cm.refresh(); } catch (_) { /* ignore */ }
      this.updateWysiwygBlankLines();
    },

    // 全量视图驻留：挂全部非活动块遮罩（单 operation 批量 DOM），并把视口扩到整篇
    // （直接写 cm.options，不走 setOption——viewportMargin 选项处理器自带 cm.refresh()，
    // 会多一次全量重渲染；下方显式 cm.refresh() 统一完成全量渲染 + 高度实测）。
    // 所有行恒渲染、行高恒实测：CM refresh() 内部 estimateLineHeights（重置回源文估计）
    // 会在同一次全量视图重渲中被重测回正——几何自愈（2026-10-09 实测：任意位置
    // 首跳落点误差 ≤0.5px，refresh 后不漂移）。
    _enterWysiwygFullView() {
      const cm = this.cm;
      if (!cm) return;
      try { cm.options.viewportMargin = cm.lineCount() + 100; } catch (_) { /* 失败退回默认视口 */ }
      try {
        cm.operation(() => {
          for (let k = 0; k < this._wysiwygBlocks.length; k++) {
            if (k === this._wysiwygActiveIdx) continue;
            this.maskWysiwygBlock(k);
          }
        });
      } catch (e) { console.error('[wysiwyg] 全量遮罩挂载失败:', e); }
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
        // 全量模式：只重切块边界（仅解析、轻）+ 仅重挂源文变化的块——万行文档
        // 每次输入停顿全量重挂（逐块重跑后处理）会卡数秒
        if (self._wysiwygFull) {
          self._refreshWysiwygFullIncremental();
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

    // 全量模式增量刷新：重切块边界（仅解析），源文未变的块保留旧 markText 标记
    //（CM 标记在编辑后自动跟随文本，marker.find() 为实时位置；节点、实测行高不动），
    // 仅重挂变化/新增/分裂/合并的块——零闪烁、无全量重渲染（2026-10-09）。
    _refreshWysiwygFullIncremental() {
      const cm = this.cm;
      if (!cm) return;
      const oldBlocks = this._wysiwygBlocks || [];
      const newBlocks = this.computeWysiwygBlocks(true) || [];
      // 行数可能变化：重设全量视图驻留
      try { cm.options.viewportMargin = cm.lineCount() + 100; } catch (_) { /* 忽略 */ }
      // 源文本 → 新块索引队列（同源多块按文档顺序匹配）
      const srcQueue = new Map();
      for (let i = 0; i < newBlocks.length; i++) {
        const b = newBlocks[i];
        b.src = this._wysiwygBlockSource(b);
        if (!srcQueue.has(b.src)) srcQueue.set(b.src, []);
        srcQueue.get(b.src).push(i);
      }
      const nextMarks = new Map(); // 新块索引 → 复用的旧标记
      for (const [oi, mark] of Array.from(this._wysiwygMarks || [])) {
        const ob = oldBlocks[oi];
        if (!ob || !srcQueue.has(ob.src)) continue;
        const ni = srcQueue.get(ob.src).shift();
        const nb = newBlocks[ni];
        nb.html = (ob.html !== undefined) ? ob.html : nb.html; // 复用缓存 html
        nextMarks.set(ni, mark);
        // 块索引位移：同步遮罩节点上的块号，点击映射才落对块
        if (ni !== oi) {
          try { if (mark.replacedWith) mark.replacedWith.setAttribute('data-block-index', String(ni)); } catch (_) { /* 忽略 */ }
        }
      }
      // 未匹配旧遮罩撤除（源文变化/分裂/合并/删除）
      const keptSet = new Set(nextMarks.values());
      this._wysiwygBlocks = newBlocks;
      this._wysiwygActiveIdx = this.wysiwygBlockIndexAt(cm.getCursor().line);
      try {
        cm.operation(() => {
          for (const mark of Array.from(this._wysiwygMarks.values())) {
            if (!keptSet.has(mark)) { try { mark.clear(); } catch (_) { /* 已销毁 */ } }
          }
          this._wysiwygMarks = nextMarks;
          // 重挂缺口的块（变化/新增/分裂/合并；活动块保持源码态）
          for (let k = 0; k < newBlocks.length; k++) {
            if (k === this._wysiwygActiveIdx || nextMarks.has(k)) continue;
            this.maskWysiwygBlock(k);
          }
        });
      } catch (e) { console.error('[wysiwyg] 全量增量刷新失败:', e); }
      this.updateWysiwygBlankLines();
    },

    // 视口受限遮罩：小文档（≤ maxBlocks）遮全部非活动块；大文档只遮视口 ± 边距内的块，
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
        // 增强预取：沿滚动方向加大遮罩窗口（双余量），用户到达前遮罩已就绪
        //（快速滚动零源码闪现）；尾随方向保持原余量防新露区闪
        let above = WYSIWYG_VIEWPORT_MARGIN;
        let below = WYSIWYG_VIEWPORT_MARGIN;
        try {
          const top = cm.getScrollInfo().top;
          if (this._wysiwygLastScrollTop != null) {
            if (top > this._wysiwygLastScrollTop) { above = WYSIWYG_PREFETCH_MARGIN; below = WYSIWYG_PREFETCH_MARGIN * 2; }
            else if (top < this._wysiwygLastScrollTop) { above = WYSIWYG_PREFETCH_MARGIN * 2; below = WYSIWYG_PREFETCH_MARGIN; }
          }
          this._wysiwygLastScrollTop = top;
        } catch (_) { /* 读不到滚动位置退回默认余量 */ }
        lo = Math.max(0, vp.from - above);
        hi = Math.min(cm.lineCount(), vp.to + below);
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

      // 撤窗外 + 挂窗内（单 operation 批量：逐块独立操作 = 多次 display 更新）
      cm.operation(() => {
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
      });

      if (anchor) {
        try {
          cm.refresh();
          // 迭代收敛：markText 后 CM 的高度重算与滚动落定存在时序差，单次 scrollTo
          // 常被部分 clamp（实测残留 80~120px）。每轮量一次残差、滚一次，2px 内收敛；
          // 残差不收敛（连续同值）说明 DOM 高度尚未落定，继续也无益，随即放弃。
          let prevDelta = Infinity;
          for (let i = 0; i < 6; i++) {
            const c = cm.charCoords({ line: anchor.line, ch: 0 }, 'window');
            const delta = c && isFinite(c.top) ? c.top - anchor.winTop : 0;
            if (!delta || !isFinite(delta) || Math.abs(delta) < 2) break;
            if (delta === prevDelta) break;        // 滚了但没效果，DOM 未落定
            prevDelta = delta;
            const info = cm.getScrollInfo();
            // 大位移（一次性滚到远处、顶部渲染块撤掉造成结构级位移）直接一步补偿：
            // CM 会把 scrollTop 钳制在可滚动范围内不会越界，循环复测残差直至收敛
            //（旧的「delta > 视口高即放弃」会让视口停在错误位置，远距跳转时露出别处内容）。
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

    // ---------------- 全量预渲染（≤ WYSIWYG_FULL_RENDER_MAX_LINES 行） ----------------

    // 全量预渲染入口（Q9a，2026-10-09 用户确认）：由 theme.js setViewMode('wysiwyg')
    // 拦截调用。当前视图保持不动，模式按钮显示「渲染中」，后台（让出一帧后的
    // setTimeout）完成全部块 html 的昂贵渲染；完成后才切换到所见即所得视图并挂遮罩——
    // 全程不露源码中间态。返回 true = 预渲染已启动（调用方须立即中止同步切换流程）。
    beginWysiwygPreRender() {
      const cm = this.cm;
      if (!cm || !cm.lineCount || cm.lineCount() === 0) return false;
      if (cm.lineCount() > WYSIWYG_FULL_RENDER_MAX_LINES) return false;
      if (this._wysiwygPreRendering) return true; // 已在飞，不重启
      // 切换前快照：滚动锚点（复制 setViewMode 的取值逻辑，此刻视图仍是旧模式）
      const tab = this.activeTab;
      const modeAtStart = this.viewMode;
      if (tab) {
        if (this.preview) tab.previewScrollTop = this.preview.scrollTop;
        if (modeAtStart === 'edit') {
          try {
            const si = cm.getScrollInfo();
            tab.scrollPos = { top: si.top, left: si.left };
            this._pendingSwitchAnchorLine = cm.lineAtHeight(si.top, 'local') + 1;
          } catch (_) { /* 忽略 */ }
        } else if (this.preview && modeAtStart === 'preview') {
          try { this._pendingSwitchAnchorLine = this._lineAtPreviewTop(this.preview.scrollTop); } catch (_) { /* 忽略 */ }
        }
      } else {
        this._pendingSwitchAnchorLine = null;
      }
      this._wysiwygPreRendering = true;
      const valueAtStart = cm.getValue(); // 完成后校验源文未变
      this._wysiwygPreRenderedValue = valueAtStart;
      this._wysiwygPreRenderTab = tab || null;
      this._wysiwygPreRenderMode = modeAtStart;
      this._wysiwygPreRenderGen = (this._wysiwygPreRenderGen || 0) + 1;
      const gen = this._wysiwygPreRenderGen;
      this._setWysiwygButtonRendering(true);
      const self = this;
      // 先让按钮 spinner 绘一帧再跑昂贵同步步骤（wysiwyg.js 禁用 rAF，用 setTimeout）
      this._wysiwygPreRenderTimer = setTimeout(() => {
        self._wysiwygPreRenderTimer = null;
        if (!self._wysiwygPreRendering || self._wysiwygPreRenderGen !== gen) return; // 已取消
        let blocks = null;
        try { blocks = self.precomputeWysiwygBlocksFull(); }
        catch (e) { console.error('[wysiwyg] 预渲染失败，退回前台渲染:', e); }
        if (!self._wysiwygPreRendering || self._wysiwygPreRenderGen !== gen) return; // 渲染中又被取消
        if (self.activeTab !== self._wysiwygPreRenderTab || self.viewMode !== self._wysiwygPreRenderMode) {
          // 期间切了标签 / 改了模式：放弃本次进入，不切视图
          self._wysiwygPreRendering = false;
          self._setWysiwygButtonRendering(false);
          return;
        }
        self._wysiwygPreRendering = false;
        self._setWysiwygButtonRendering(false);
        // 执行真正的模式切换（applyViewMode 的 50ms 计时器会消费预渲染块表挂遮罩）
        self.viewMode = 'wysiwyg';
        const t = self.activeTab;
        if (t && t.filePath && window.FileTypes && window.FileTypes.classifyFile(t.filePath) === 'markdown') {
          self._sessionMdViewMode = 'wysiwyg';
        }
        self.applyViewMode();
        // 预渲染结果在 applyViewMode 内部 clearWysiwygMasks 之后写入、
        // 50ms 计时器 renderWysiwygMasks 消费之前落位，时序恰好
        self._wysiwygPreRenderedBlocks = blocks;
        self._wysiwygPreRenderedValue = valueAtStart;
      }, 50);
      return true;
    },

    // 取消在飞的全量预渲染（用户抢先切到别的模式 / 切标签 / 离开所见即所得）
    _cancelWysiwygPreRender() {
      if (!this._wysiwygPreRendering) return;
      this._wysiwygPreRendering = false;
      this._wysiwygPreRenderGen = (this._wysiwygPreRenderGen || 0) + 1;
      if (this._wysiwygPreRenderTimer) {
        clearTimeout(this._wysiwygPreRenderTimer);
        this._wysiwygPreRenderTimer = null;
      }
      this._wysiwygPreRenderedBlocks = null;
      this._wysiwygPreRenderedValue = null;
      // 预渲染开始时保存的切换锚点一并作废（切标签等路径下，残留锚点会被
      // 新视图的 50ms 计时器消费，导致滚动落到无关位置）
      this._pendingSwitchAnchorLine = null;
      this._setWysiwygButtonRendering(false);
    },

    // 模式按钮「渲染中」指示：spinner 类 + 文案替换（完成后还原）
    _setWysiwygButtonRendering(on) {
      let btn = null;
      try { btn = document.getElementById('btn-view-wysiwyg'); } catch (_) { return; }
      if (!btn || !btn.classList) return;
      btn.classList.toggle('wysiwyg-rendering', !!on);
      const span = btn.querySelector ? btn.querySelector('span') : null;
      if (!span) return;
      if (on) {
        if (this._wysiwygBtnText == null) this._wysiwygBtnText = span.textContent;
        span.textContent = this.t ? this.t('viewModeWysiwygRendering') : '渲染中…';
      } else if (this._wysiwygBtnText != null) {
        span.textContent = this._wysiwygBtnText;
        this._wysiwygBtnText = null;
      }
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
      // 单 operation 批量挂/摘类：全量模式下空行可达数千，逐行独立操作 =
      // 数千次全视口 display 更新（万行文档进入/离开时卡数秒，2026-10-09 实测风险）
      cm.operation(() => {
        if (prev) {
          for (const i of prev) if (!next.has(i)) this._setWysiwygBlankClass(i, false);
          for (const i of next) if (!prev.has(i)) this._setWysiwygBlankClass(i, true);
        } else {
          for (const i of next) this._setWysiwygBlankClass(i, true);
        }
      });
      this._wysiwygBlankLines = next;
      this._wysiwygBlankCurLine = this._isWysiwygBlankLine(curLine) ? curLine : null;
    },

    clearWysiwygMasks() {
      // 在飞的全量预渲染作废（离开所见即所得 / 切标签 / 打开文件）
      this._cancelWysiwygPreRender();
      if (this._wysiwygMaskTimer) {
        clearTimeout(this._wysiwygMaskTimer);
        this._wysiwygMaskTimer = null;
      }
      const cm = this.cm;
      // 单 operation 批量撤遮罩 + 撤空行类：全量模式下遮罩可达数千、空行数千，
      // 逐块独立操作 = 数千次 display 更新（万行文档离开模式卡数秒，2026-10-09）
      try {
        cm.operation(() => {
          if (this._wysiwygMarks) {
            for (const mark of Array.from(this._wysiwygMarks.values())) {
              try { mark.clear(); } catch (_) { /* 已销毁，忽略 */ }
            }
          }
          if (this._wysiwygBlankLines) {
            for (const i of this._wysiwygBlankLines) this._setWysiwygBlankClass(i, false);
          }
          if (this._wysiwygBlankCurLine != null) this._setWysiwygBlankClass(this._wysiwygBlankCurLine, false);
        });
      } catch (_) {
        if (this._wysiwygMarks) {
          for (const mark of Array.from(this._wysiwygMarks.values())) {
            try { mark.clear(); } catch (_) { /* 已销毁，忽略 */ }
          }
        }
      }
      this._wysiwygBlankLines = null;
      this._wysiwygBlankCurLine = null;
      this._wysiwygClickAnchor = null;
      this._wysiwygVirtual = false;
      // 离开全量视图驻留：恢复 CM 默认视口余量（整篇驻留只服务于所见即所得；
      // setOption 会触发一次小视口 refresh，成本可忽略）
      this._wysiwygFull = false;
      try {
        if (this.cm && this.cm.options && this.cm.options.viewportMargin > 10) this.cm.setOption('viewportMargin', 10);
      } catch (_) { /* 忽略 */ }
      // 预渲染块表在此清空：renderWysiwygMasks 顶部先取走快照再调本方法，
      // 其余清理路径（切模式/切标签）顺带作废未消费的预渲染结果
      this._wysiwygPreRenderedBlocks = null;
      this._wysiwygPreRenderedValue = null;
      this._wysiwygMarks = new Map();
      this._wysiwygBlocks = [];
      this._wysiwygActiveIdx = -1;
      this._wysiwygAnchorY = null;
      // 全量重建：在飞异步 pass 一律过期
      this._wysiwygMaskGen = (this._wysiwygMaskGen || 0) + 1;
      // 编辑器外壳（行号/最大宽度）随模式同步：离开所见即所得时恢复行号、撤掉居中内缩
      this.applyWysiwygEditorChrome();
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
