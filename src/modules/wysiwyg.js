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
  // 活动块（光标所在块、源码态）行高亮类：与渲染态块明显区分（2026-10-11 用户反馈 #5）。
  // 行「对象」制跟踪（_wysiwygActiveLines / _wysiwygPlainLines / _wysiwygListLines 存
  // getLineHandle 的 CM LineObject，而非行号）：编辑分行/插行使行号位移后，按旧行号
  // getLineHandle 拿到的是该位置的新行对象，撤类打空、旧类残留在位移行上——活动块灰底
  // 残在文末空行即「灰色条」（2026-10-17 用户截图）。对已销毁行对象调 removeLineClass
  // 是安全 no-op（changeLine 内 lineNo==null 直接返回，不抛错、不动 DOM）。
  const ACTIVE_CLASS = 'cm-wysiwyg-active-block';
  // 活动块「整块一体」观感（2026-10-13 用户反馈 #2：逐行小圆角不好看，要像一整块编辑区）：
  // 底色只挂 ACTIVE_CLASS（每行一条、连续无角），首/末行各额外挂一个类，CSS 只在首行上缘、
  // 末行下缘做圆角 → 多行块看起来是一个圆角矩形，而非一排各自带角的小条。
  const ACTIVE_FIRST_CLASS = 'cm-wysiwyg-active-first';
  const ACTIVE_LAST_CLASS = 'cm-wysiwyg-active-last';
  // 代码块灰盒描边类（2026-10-18 用户要求：上下围栏都在灰框内）：挂代码块**整块每行**
  // （开围栏/内容/闭围栏），CSS 用 ::before 内缩盒画 --code-bg 底色 + 1px 边框
  // （与 pre 的 border 同参 --border-color）；内容行另补 29px 顶/底内距（渲染态 pre 内距分解）。
  const ACTIVE_CODE_BOX_CLASS = 'cm-wysiwyg-code-box';
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
    // 收口 constants.js 共享常量（format.js insertLinePrefix 的「引用行原位嵌套」判定同口径）
    quote: TMConst.BLOCKQUOTE_LINE_RE,
    table: /^\s*\|/,
    // setext 标题：上一行文本 + 本行 === / ---
    setext: /^(\s*)(=+|-+)\s*$/,
    // 折叠区块开行（_applyWysiwygActiveHighlight 整块灰盒判定的收口口径，禁止散写同义正则）
    detailsOpen: /^\s*<details[\s>]/i,
    // 块末结构行 Enter 拦截（_wysiwygEnterOnBlockCloseLine）共用：围栏开行（容 0–3 前导空格，
    // 捕获围栏串以校验闭合配对）与 HTML 容器开行（捕获标签名以派生闭标签判定）
    fenceStart: /^\s{0,3}(`{3,}|~{3,})/,
    htmlOpenTag: /^\s{0,3}<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/,
    // 缩进代码块：4 空格 / 制表符
    indentedCode: /^(\t| {4,})\S/,
  };

  // CommonMark 原始 HTML 块（type 6）标签名：行首出现这些标签的开标签即构成 HTML 块
  // （strong/span/u 等行内标签不在集内——它们所在行仍是段落）。
  const HTML_BLOCK_TAGS = {
    address: 1, article: 1, aside: 1, base: 1, basefont: 1, blockquote: 1, body: 1,
    caption: 1, center: 1, col: 1, colgroup: 1, dd: 1, details: 1, dialog: 1, dir: 1,
    div: 1, dl: 1, dt: 1, fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1,
    frame: 1, frameset: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, head: 1,
    header: 1, hr: 1, html: 1, iframe: 1, legend: 1, li: 1, link: 1, main: 1,
    menu: 1, menuitem: 1, nav: 1, noframes: 1, ol: 1, optgroup: 1, option: 1, p: 1,
    param: 1, section: 1, source: 1, summary: 1, table: 1, tbody: 1, td: 1, tfoot: 1,
    th: 1, thead: 1, title: 1, tr: 1, track: 1, ul: 1,
  };

  // 行是否为「HTML 容器块」开行（2026-10-25 用户要求「居中显示等具有编辑按钮的块，
  // 编辑整块源码、都在灰色块中进行编辑」的判定收口，与遮罩侧「挂编辑按钮」口径对应：
  // 渲染结果非列表/标题/TOC/单 <p> 的容器块）。前 ≤3 空格 + HTML 块标签开标签
  // （<center>/<div>/<figure>/…；<details> 亦在集内，details 专属路径先行判定，
  // 本函数为其余容器标签的同一口径）。⚠️ _applyWysiwygActiveHighlight（整块灰盒）
  // 与 _wysiwygApplyActiveDecor（行内距行类）两处必须共用本函数，禁止散写同义正则。
  function isHtmlBlockContainerLine(line) {
    const m = RE.htmlOpenTag.exec(line || '');
    return !!m && !!HTML_BLOCK_TAGS[m[1].toLowerCase()];
  }

  function isBlank(s) { return (s || '').trim() === ''; }

  // 判断「列表能否延续到下一行」：下一个非空行是同级/更深缩进的列表项、或是列表的续行（缩进内容）
  function listContinues(nextLine) {
    if (isBlank(nextLine)) return false;
    return RE.ul.test(nextLine) || RE.ol.test(nextLine) || RE.task.test(nextLine) ||
           /^\s{2,}\S/.test(nextLine);
  }

  // ================== 列表行「隐藏标记前缀区」与 Backspace/Delete 守卫（2026-10-24） ==================
  //
  // 背景（用户截图实测）：WYSIWYG 活动块里列表标记（`- [ ] ` / `- ` / `1. `）是透明/零宽
  // 装饰（wysiwyg-task-prefix 24px 槽 + wysiwyg-task-box-zero 零宽槽等），光标在正文起点
  // 按 Backspace 走 CM 原生逐字符删：任务项要 **7 次**才能并到上一行，且中间态逐次裸露
  // （`- [ ]准备` → ul 回退渲染「• []」、`- [ 准备` 裸 `[ `、`-准备` 裸 `-`）；有序项 4 次
  // （`2.第二步` 裸序号）、无序项 3 次、空任务项 5~6 次。
  // 修复 = wrapper capture 阶段拦截（同 _ensureWysiwygTaskBoxClick 模式）：
  //   Backspace（光标在标记区内或正文起点）→ 一次剥离整个标记（项变普通段落）；**空项**
  //   （正文为空白）→ 整行并入上一行（一次删到上一行，用户诉求）。
  //   Delete（行尾 + 下一行是列表项）→ 剥掉下一行标记后并接（否则原生并出 `- 无序甲- 无序乙`）。
  // 纯函数 listMarkerZoneEnd 供守卫与单测共用（口径与 _wysiwygApplyActiveDecor 的行装饰一致）。
  //
  // 返回该行「隐藏标记区」的终点 ch（= 正文起点）；非标记行返回 0。刻意与装饰分支同源
  // 正则（RE.task/ul/ol + dd 行 `: ` 前缀），保证「看不见的字符」恰好都被区覆盖：
  //   - dd 行 `: `/`:` 前缀是透明 span（wysiwyg-dd-colon，保留真实宽度），同属隐藏前缀。
  //   - 标题 `#`（小灰可见）**不在区内**：可见字符逐字符删即所见即所得，无需拦截。
  //   - 引用 `>` 自 2026-10-31 起也走隐藏槽（wysiwyg-quote-slot）+ 专属守卫，见下。
  //   - `- - -` 这类**集合线**可能被 ul 正则误吞（首 `- `），显式排除：hr 是可见源码行。
  function listMarkerZoneEnd(line) {
    const s = line || '';
    if (!s || RE.hr.test(s)) return 0;
    const m = RE.task.exec(s) || RE.ul.exec(s) || RE.ol.exec(s);
    if (m) return m[0].length;
    // 定义列表 dd 行（_applyWysiwygActiveDecor isDd 同口径）：`: ` 或孤 `:`
    const dd = /^(: |:$)/.exec(s);
    if (dd) return dd[0].length;
    return 0;
  }

  // 引用行「> 前缀区」终点（2026-10-31）：活动引用行的 `> ` 由 wysiwyg-quote-slot 槽隐藏
  // （口径同列表标记区：看得见的正文从槽后开始），光标在区内/正文起点按 Backspace 走 CM
  // 原生会逐字符删出「>文本」「>」等裸露中间态且退不出引用（QA 实测：先动下方 ---、
  // 再误删行尾字符）。与 stripQuotePrefix 同口径（\s{0,3} 前导 + (>[ \t]?)+ 逐层）——
  // 缩进代码行（≥4 空格）不匹配，天然排除；非引用行返回 0。供守卫与单测共用。
  function quoteMarkerZoneEnd(line) {
    const m = /^\s{0,3}(?:>[ \t]?)+/.exec(line || '');
    return m ? m[0].length : 0;
  }


  // ========================== 引用块内多行原子结构识别（2026-10-28） ==========================
  //
  // 背景：引用/提示块活动态按光标行把块切成上下两段独立渲染（_wysiwygApplyQuoteSegments）。
  // 这段切分是「行粒度」的，一旦某**多行结构**的中间某行成为光标行，两段源码各自结构不
  // 完整，remark 的容错解析会产出与渲染态完全不符的结果 —— 用户看到的就是「样式崩了」：
  //   - 围栏代码块：上段补出**空代码盒**、下段把后续正文**吞进代码块**（demo.md 截图）
  //   - 缩进代码块：同围栏
  //   - 表格：下半丢表头分隔行 → 渲染成带裸 `|` 的普通文本
  //   - 展示公式 $$…$$：落单的 `$$` 当字面量显示出来
  //   - HTML 容器（<details> 等）：结构破裂、闭标签裸露
  //   - 列表（含嵌套）：下段的子项被提升成**顶层新列表**（实测 `<ol start="2">` 顶格，
  //     嵌套缩进层级整体丢失）
  //
  // 对策：不再按光标行单点切分，改「**把包含光标行的整个多行结构整块保持源码**」，其余部分
  // 照旧按两段渲染 —— 与顶层代码块/表格/列表「光标进块整块显源码」同一口径。
  //
  // 本组函数纯行级（入参/出参都是字符串数组与下标），可在 node 下直接单测，不依赖 CM/DOM。
  //
  // ⚠️ 宽严取舍：宁可**多留**几行源码（观感只是「这段没渲染」），也不能少留（会产生错误结构）。
  //    故 `_continuation` 类判定（缩进代码/列表续行）对「疑似」按包含处理。

  // 剥引用前缀（口径同 RE.quote / _wysiwygBlockIsQuote）：嵌套 "> > " 逐层剥到内容，
  // 内容自身的**相对缩进**必须保留 —— 缩进代码块、嵌套列表、列表续行的判定全靠它。
  // 无前缀的惰性续行（引用段内不带 > 的连续行）原样返回，内容语义本身不变。
  function stripQuotePrefix(line) {
    return (line || '').replace(/^\s{0,3}(?:>[ \t]?)+/, '');
  }

  // 汇总「已剥前缀的内容行」里全部多行原子结构，返回互不重叠的闭区间数组 [[start, end], …]
  // （0-based、闭区间）。优先级：围栏 > 缩进代码 > 展示公式 > 表格 > HTML 容器 > 列表 ——
  // 先认的行段占住 claimed，后序探测器不得跨越：围栏内部的缩进行必须是**代码内容**，不能被
  // 当成缩进代码块；同理列表里的表格/围栏归各自探测器，列表只吃剩下的连续列表行。
  function quoteAtomicRanges(stripped) {
    const arr = stripped || [];
    const n = arr.length;
    const out = [];
    if (n < 1) return out;
    const claimed = new Array(n).fill(false);
    const claim = (s, e) => {
      for (let i = Math.max(0, s); i <= Math.min(n - 1, e); i++) claimed[i] = true;
    };

    // ① 围栏代码块（口径同 RE.fence：``` / ~~~；闭合须同字符且长度 ≥ 开行、行尾无杂串）
    {
      let open = -1, marker = '', len = 0;
      for (let i = 0; i < n; i++) {
        const ln = arr[i] || '';
        const m = /^(`{3,}|~{3,})/.exec(ln);
        if (m) {
          if (open < 0) {
            const rest = ln.slice(m[1].length);
            // ``` 的信息串不得含反引号（CommonMark）；~~~ 无此限制
            if (!(m[1][0] === '`' && rest.indexOf('`') >= 0)) { open = i; marker = m[1][0]; len = m[1].length; }
          } else if (m[1][0] === marker && m[1].length >= len && ln.slice(m[1].length).trim() === '') {
            out.push([open, i]); claim(open, i); open = -1; marker = ''; len = 0;
          }
          continue;
        }
        if (open >= 0) continue; // 围栏内部不参与其它判定
      }
      if (open >= 0) { out.push([open, n - 1]); claim(open, n - 1); } // 未闭合：吃到块末
    }

    // ② 缩进代码块（行首 4 空格/制表）：连续未认领的缩进行成段；段中空行仅当后面还能接到
    //    缩进行才跨过（否则在最后一个代码行收口，避免把块尾空行算进代码块）
    {
      const isInd = (i) => /^(?:\t| {4,})\S/.test(arr[i] || '');
      let i = 0;
      while (i < n) {
        if (claimed[i] || !isInd(i)) { i++; continue; }
        let last = i;
        for (let k = i + 1; k < n; k++) {
          if (claimed[k]) break;
          if (isInd(k)) { last = k; continue; }
          if (isBlank(arr[k])) {
            let m = k;
            while (m + 1 < n && isBlank(arr[m + 1])) m++;
            if (m + 1 < n && !claimed[m + 1] && isInd(m + 1)) { last = m + 1; k = m + 1; continue; }
          }
          break;
        }
        out.push([i, last]); claim(i, last);
        i = last + 1;
      }
    }

    // ③ 展示公式 $$ … $$（成对，未闭合吃到块末）
    {
      const isDollar = (i) => /^\s{0,3}\$\$\s*$/.test(arr[i] || '');
      for (let i = 0; i < n; i++) {
        if (claimed[i] || !isDollar(i)) continue;
        let close = -1;
        for (let k = i + 1; k < n; k++) { if (!claimed[k] && isDollar(k)) { close = k; break; } }
        const e = close < 0 ? n - 1 : close;
        out.push([i, e]); claim(i, e);
        if (close >= 0) i = close;
      }
    }

    // ④ 表格：连续「≤3 空格 + |」行成段（含表头分隔行）
    {
      let s = -1, last = -1;
      for (let i = 0; i <= n; i++) {
        const isRow = i < n && !claimed[i] && /^\s{0,3}\|/.test(arr[i] || '');
        if (isRow) { if (s < 0) s = i; last = i; }
        else if (s >= 0) { out.push([s, last]); claim(s, last); s = -1; last = -1; }
      }
    }

    // ⑤ HTML 容器块（<details>/<div>/<figure>/… 到闭标签；未闭合吃到块末）。
    //    标签集与 isHtmlBlockContainerLine 共用 HTML_BLOCK_TAGS（CommonMark type 6）；
    //    自闭合标签（<br/>）无内容，不成块。
    {
      for (let i = 0; i < n; i++) {
        if (claimed[i]) continue;
        const m = RE.htmlOpenTag.exec(arr[i] || '');
        if (!m) continue;
        const tag = m[1].toLowerCase();
        if (!HTML_BLOCK_TAGS[tag]) continue;
        if (/\/\s*>\s*$/.test((arr[i] || '').trim())) continue;
        const closeRe = new RegExp('^\\s{0,3}</' + tag + '\\s*>\\s*$', 'i');
        let close = -1;
        for (let k = i + 1; k < n; k++) { if (!claimed[k] && closeRe.test(arr[k] || '')) { close = k; break; } }
        const e = close < 0 ? n - 1 : close;
        out.push([i, e]); claim(i, e);
        if (close >= 0) i = close;
      }
    }

    // ⑥ 列表整体（含嵌套子项）：连续未认领的「标记行 / ≥2 空格续行」成段。
    //    ⚠️ 必须按**整段**而非「单个 item」收貌似更省，但只收 item 治不了撕裂：下段剩下的
    //    兄弟/子项会被提升成顶层新列表（实测 `<ol start="2">` 顶格），嵌套层级整体丢失。
    //    整段收录与顶层列表「光标进列表 → 整列表显源码」完全同口径。
    //    段中空行同理：仅当后面仍接列表行才并入（列表项内空行 + 后续项 = 同一列表）。
    {
      const isMarker = (i) => /^\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(arr[i] || '');
      const isCont = (i) => /^\s{2,}\S/.test(arr[i] || '');
      const isListLine = (i) => !claimed[i] && (isMarker(i) || isCont(i));
      let s = -1, last = -1;
      for (let i = 0; i <= n; i++) {
        if (i < n && isListLine(i)) { if (s < 0) s = i; last = i; continue; }
        if (s < 0) continue;
        if (i < n && isBlank(arr[i]) && !claimed[i]) {
          let m = i;
          while (m + 1 < n && isBlank(arr[m + 1])) m++;
          if (m + 1 < n && isListLine(m + 1)) { i = m + 1; last = m + 1; continue; }
        }
        out.push([s, last]); claim(s, last); s = -1; last = -1;
      }
    }

    return out;
  }

  // 包含 rawLines[cur] 的**最内层**多行原子结构区间（闭区间 [start, end]）；不在任何多行
  // 结构内返回 null（→ 调用方维持「光标行单点源码」旧口径，行为完全不变）。
  // 入参是带引用前缀的**原始块行**，cur 是块内相对行号 —— 免调用方自己剥前缀。
  function quoteAtomicRange(rawLines, cur) {
    const arr = rawLines || [];
    if (cur == null || cur < 0 || cur >= arr.length) return null;
    let best = null;
    for (const r of quoteAtomicRanges(arr.map(stripQuotePrefix))) {
      if (cur < r[0] || cur > r[1]) continue;
      if (!best || (r[1] - r[0]) < (best[1] - best[0])) best = r;
    }
    return best;
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
        let loose = false;
        while (i < total) {
          if (isBlank(arr[i])) {
            // 空行后若仍是列表项则属同一块（松散列表），否则结束
            let k = i;
            while (k < total && isBlank(arr[k])) k++;
            const cont = k < total && (RE.ul.test(arr[k]) || RE.ol.test(arr[k]) || RE.task.test(arr[k]));
            if (!cont) break;
            loose = true;
            i = k;
            continue;
          }
          if (RE.ul.test(arr[i]) || RE.ol.test(arr[i]) || RE.task.test(arr[i]) || listContinues(arr[i])) { i++; continue; }
          break;
        }
        // 紧凑列表（块内无空行）按项切块（与 renderMarkdownBlocks 同一口径，2026-10-21
        // 用户反馈：点列表项只该项显源码、兄弟项保持渲染）：项边界 = 下一个缩进 ≤ 当前项
        // 缩进的标记行（同级/更浅标记开新项；更深标记行与缩进续行归当前项的嵌套行段）。
        // 松散列表（有空行）保持整块；单项列表（含带嵌套子项的单项）也保持整块——孤项
        // 即整列表，14px 列表底距归属它，拆不出「非末项」。
        const itemStarts = [];
        let s = start;
        while (s < i) {
          itemStarts.push(s);
          const itemIndent = (arr[s].match(/^\s*/) || [''])[0].length;
          s++;
          while (s < i) {
            const l = arr[s];
            const m = RE.task.exec(l) || RE.ul.exec(l) || RE.ol.exec(l);
            if (m && m[1].length <= itemIndent) break; // 同级/更浅标记行 = 新项
            s++;
          }
        }
        if (!loose && itemStarts.length > 1) {
          itemStarts.forEach((st, k) => {
            const en = k + 1 < itemStarts.length ? itemStarts[k + 1] : i;
            blocks.push({
              start: st, end: en, lines: arr.slice(st, en),
              listItem: true,
              listItemPos: (k === 0 ? 'first' : k === itemStarts.length - 1 ? 'last' : 'middle'),
            });
          });
        } else {
          blocks.push({ start, end: i, lines: arr.slice(start, i) });
        }
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

  // ---------- 表格行纯函数（Phase 2 单元格就地编辑 / R5，2026-10-13） ----------
  // 把 markdown 表格行切成单元格源码数组。单元格内 \| 视为字面竖线不切分；
  // 记录原行首/行尾是否有竖线（重建时保留原有写法，不强行加/去外管）。
  // 返回 { cells, hasLeading, hasTrailing }；cells 已 trim（remark 忽略单元格首尾空白）。
  function splitTableRow(rowText) {
    let s = String(rowText == null ? '' : rowText).trim();
    let hasLeading = false, hasTrailing = false;
    if (s.charAt(0) === '|') { hasLeading = true; s = s.slice(1); }
    if (s.length > 0 && s.charAt(s.length - 1) === '|') { hasTrailing = true; s = s.slice(0, -1); }
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (c === '\\' && i + 1 < s.length && s.charAt(i + 1) === '|') { cur += '\\|'; i++; continue; }
      if (c === '|') { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim();
    return { cells: cells, hasLeading: hasLeading, hasTrailing: hasTrailing };
  }

  // 把第 colIdx 个单元格回写进表格行：保留行首/行尾竖线风格，新文本中裸 | 自动转义为 \|
  // （先解旧转义再整体转义：原 \| 保持 \|，新敲的 | 变 \|）。
  // 返回新行文本；colIdx 越界时原样返回（调用方视为回写失败，不破坏原行）。
  function editTableRowCell(rowText, colIdx, newText) {
    const t = String(rowText == null ? '' : rowText);
    const info = splitTableRow(t);
    if (!isFinite(colIdx) || colIdx < 0 || colIdx >= info.cells.length) return t;
    let txt = String(newText == null ? '' : newText).replace(/[\r\n]+/g, ' ').trim();
    txt = txt.replace(/\\\|/g, '|').replace(/\|/g, '\\|');
    info.cells[colIdx] = txt;
    const joined = info.cells.join(' | ');
    return (info.hasLeading ? '| ' : '') + joined + (info.hasTrailing ? ' |' : '');
  }

  // ---------- 表格结构纯函数（2026-10-13 用户要求：增行/增列/拖拽换位） ----------
  // tableText = 表格块的源码文本（行 0 = 表头行，行 1 = 分隔行，其余 = 数据行）。
  // 与 editTableRowCell 同一风格约定：保留首/尾竖线风格，竖线用 ' | ' 连接，
  // 空单元格写作空格（remark 按 trim 解析为空）。所有函数对畸形输入返回 null（增列/增行）
  // 或原样返回（移动），由调用方兜底，不破坏原文。

  // 解析表格结构：{ lines, colCount, hasLeading, hasTrailing, dataLines }；非法返回 null
  function parseTableStructure(tableText) {
    const lines = String(tableText == null ? '' : tableText).split('\n');
    if (lines.length < 2) return null;
    const head = splitTableRow(lines[0]);
    const colCount = head.cells.length;
    if (colCount === 0) return null;
    return {
      lines: lines, colCount: colCount,
      hasLeading: head.hasLeading, hasTrailing: head.hasTrailing,
      dataLines: lines.slice(2),
    };
  }

  // 按单元格数组 + 行风格重建表格行（格内裸 | 自动转义，与 editTableRowCell 同规则）
  function buildTableLine(cells, style) {
    const esc = (t) => String(t == null ? '' : t)
      .replace(/\\\|/g, '|').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
    const joined = cells.map(esc).join(' | ');
    return (style.hasLeading ? '| ' : '') + joined + (style.hasTrailing ? ' |' : '');
  }

  // 末尾增一空行（格数与表头一致）；返回新表格文本
  function addTableRow(tableText) {
    const t = parseTableStructure(tableText);
    if (!t) return null;
    const empty = [];
    for (let i = 0; i < t.colCount; i++) empty.push('');
    return t.lines.concat(buildTableLine(empty, t)).join('\n');
  }

  // 末尾增一空列（每行 +1 格，分隔行补 '---'）；返回新表格文本
  function addTableColumn(tableText) {
    const t = parseTableStructure(tableText);
    if (!t) return null;
    const out = t.lines.map((ln, i) => {
      const info = splitTableRow(ln);
      const cells = info.cells.slice(0, t.colCount);
      while (cells.length < t.colCount) cells.push(i === 1 ? '---' : '');
      cells.push(i === 1 ? '---' : '');
      return buildTableLine(cells, t);
    });
    return out.join('\n');
  }

  // 移动一行：fromIdx/toIdx 为「行序列」下标（0 = 表头行，1 = 首个数据行；分隔行不计位，
  // 恒在源码第 2 行）；越界/同位 = 原样返回。返回新表格文本
  function moveTableRow(tableText, fromIdx, toIdx) {
    const t = parseTableStructure(tableText);
    if (!t) return null;
    const rows = [t.lines[0]].concat(t.dataLines);
    if (!isFinite(fromIdx) || !isFinite(toIdx) ||
        fromIdx < 0 || fromIdx >= rows.length || toIdx < 0 || toIdx >= rows.length ||
        fromIdx === toIdx) return String(tableText);
    const moved = rows.splice(fromIdx, 1)[0];
    rows.splice(toIdx, 0, moved);
    return rows[0] + '\n' + t.lines[1] + '\n' + rows.slice(1).join('\n');
  }

  // 移动一列：fromIdx/toIdx 为列下标（0 起）；每行（含分隔行，对齐标记随列移动）同步换位；
  // 越界/同位 = 原样返回。返回新表格文本
  function moveTableColumn(tableText, fromIdx, toIdx) {
    const t = parseTableStructure(tableText);
    if (!t) return null;
    if (!isFinite(fromIdx) || !isFinite(toIdx) ||
        fromIdx < 0 || fromIdx >= t.colCount || toIdx < 0 || toIdx >= t.colCount ||
        fromIdx === toIdx) return String(tableText);
    const out = t.lines.map((ln, i) => {
      const info = splitTableRow(ln);
      const cells = info.cells.slice(0, t.colCount);
      while (cells.length < t.colCount) cells.push(i === 1 ? '---' : '');
      const moved = cells.splice(fromIdx, 1)[0];
      cells.splice(toIdx, 0, moved);
      return buildTableLine(cells, t);
    });
    return out.join('\n');
  }

  // 行内语法渲染化 span 扫描（2026-10-14 用户要求，Typora 式行内）：对活动块的一行源文
  // 单遍扫描产品支持的行内语法，返回 [{ from, to, cls }] text marker 段表：
  //   标记段（** / * / _ / ` / [ ] (url) / ~~ / == / <u></u>）→ wysiwyg-inline-marker
  //     （双态：非光标行 width:0 零宽 + 透明 = 渲染化外观；光标行 width:auto + 次级色
  //      = 源码显示——2026-10-21 S58，见 styles.css .wysiwyg-inline-marker 基础规则与
  //      pre.wysiwyg-inline-cursor-line 覆盖规则）
  //   文本段 → wysiwyg-bold / wysiwyg-italic / wysiwyg-inline-code / wysiwyg-strike /
  //     wysiwyg-highlight / wysiwyg-underline / wysiwyg-inline-link
  //     （观感对齐 preview-content 对应元素）
  // 优先级：行内代码 > 链接 > 粗体 > 斜体 > 删除线 > 高亮 > 下划线；按位置顺序消费、
  // 不重叠（MVP 不做嵌套，如 **a `b` c** 整段按粗体；<u>**x**</u> 整段按下划线）。
  // S98（2026-10-29 代码审查：编辑态 ≠ 渲染态三组实测定位）：触发字符必须「就地」成语法
  // 才消费——正则分支要求左起匹配恰在 slice 0（m.index===0），反引号分支为 CommonMark
  // backtick run 状态机；旧实现把左起匹配按 start=i 直接消费、不校验 m.index → 触发字符
  // 处无法就地成语法而 slice 更后存在合法语法时 span 整体错位（**x* 斜体落错字符 /
  // [a [b](c) 假链接色 / `` `a` 孤立反引号假 chip）；i++ 到真实起点处重新按 index 0
  // 匹配即得正确 span。
  // 已知残差（如实声明）：* / _ 为简化正则匹配，未实现完整 CommonMark 定界符栈
  // （flanking/三倍数规则）——邻接定界符组如 *x **y** 的配对语义会与渲染态有差
  // （编辑态 em("x ")+ital("y") vs 渲染 "*x " 字面 + strong("y")）；边界错位已修，
  // 此为罕见输入的语义配对残差（修复前该输入更糟：bold 落在 " **" 上）。
  // 图片行 ![]() 不解析（图片活动态是独立机制）；下划线变体加词内守卫（snake_case
  // 不误判）；<u> 为渲染器放行的原生 HTML 标签（unified-renderer L1514），仅单标签
  // 成对、不含嵌套标签/换行的行内形态参与装饰。围栏块/表格/frontmatter 由调用方
  // 排除。删除任一标记字符 → 不再成对 → change 钩子重算即自动去样式。
  function parseWysiwygInlineSpans(text) {
    const spans = [];
    if (text == null) return spans;
    const s = String(text);
    const push = (from, to, cls) => { if (to > from) spans.push({ from: from, to: to, cls: cls }); };
    const reLink = /\[([^\[\]\n]+)\]\(([^()\n]*)\)/;
    const reBoldStar = /\*\*([^*\n]+)\*\*/;
    const reBoldUnder = /__([^_\n]+)__/;
    const reItStar = /\*([^*\n]+)\*/;
    const reItUnder = /_([^_\n]+)_/;
    const reStrike = /~~([^~\n]+)~~/;
    const reHighlight = /==([^=\n]+)==/;
    const reUnderline = /^<u>([^<\n]+)<\/u>/;
    // 下划线变体词内守卫：前/后邻接字母数字下划线即视为标识符（snake_case），不成语法
    const isWordish = (ch) => !!ch && /[A-Za-z0-9_]/.test(ch);
    // S98：CommonMark 边缘空格规则（S93 沿用）：内容首尾各带一个空格（且非全空格）→
    // 各剥掉一个，与渲染 <code> 文本一致（remark 同剥）→ 编辑态 chip 宽度 ≡ 渲染态
    // （`` ` `` chip 只包单反引号；剥掉的空格留在 marker span 内，保真实宽度）。
    const stripEdge = (cFrom, cTo) => {
      if (cTo - cFrom >= 2 && s.charAt(cFrom) === ' ' && s.charAt(cTo - 1) === ' ' && s.slice(cFrom + 1, cTo - 1).trim() !== '') {
        return [cFrom + 1, cTo - 1];
      }
      return [cFrom, cTo];
    };
    // 行内代码（S93 2026-10-29 用户截图 demo.md 松散列表「行内代码」行 + S98 状态机化）：
    // CommonMark backtick string 口径（≡ remark/渲染器，2026-10-29 渲染输出实测对齐）：
    //   a. 从反引号起数连续 run 长度 N（`` ``` 的 N=3）；
    //   b. 向后扫描「恰为 N」的 run 作闭合边界（更长的 run 不算：```a`` 不被双闭合）；
    //   c. 内容可含短于 N 的反引号 run（S93 能力保留：`` ` `` → chip 内容单反引号）；
    //   d. 找不到闭合 → 整个 run 是字面量、i 移到 run 尾继续解析（其后更短 run 可另起
    //      span：`` `a` → `` 字面 + `a` 成 span，≡ 渲染器实测）。
    // 旧 reCode 正则两缺陷被取代：① 双反引号内容式不覆盖孤立反引号邻接的更多形态；
    // ② 与其余正则分支同病——左起匹配可能不在 slice 0 却被 start=i 消费（错位）。
    const codeSpanAt = (pos) => {
      let n = 0;
      while (pos + n < s.length && s.charAt(pos + n) === '`') n++;
      let j = pos + n;
      while (j < s.length) {
        if (s.charAt(j) !== '`') { j++; continue; }
        let r = 0;
        while (j + r < s.length && s.charAt(j + r) === '`') r++;
        if (r === n) return { from: pos, to: j + r, cFrom: pos + n, cTo: j };
        j += r;
      }
      return { from: pos, to: pos + n, literal: true };
    };
    // S98：正则只在「触发字符就地成语法」时返回匹配（左起匹配必须从 slice 0 开始）；
    // index>0 = 语法始于位置 i 之后 → 本位置不消费，由 i++ 推进到真实起点处重新匹配。
    const matchAt = (re, pos) => {
      const m = re.exec(s.slice(pos));
      return (m && m.index === 0) ? m : null;
    };
    let i = 0;
    while (i < s.length) {
      let m = null;
      let kind = null;
      const c = s.charAt(i);
      if (c === '`') {
        const cs = codeSpanAt(i);
        if (cs.literal) {
          // 未闭合反引号 run = 字面量（无任何 span），run 尾继续解析
          i = cs.to;
          continue;
        }
        const sc = stripEdge(cs.cFrom, cs.cTo);
        push(cs.from, sc[0], 'wysiwyg-inline-marker');
        push(sc[0], sc[1], 'wysiwyg-inline-code');
        push(sc[1], cs.to, 'wysiwyg-inline-marker');
        i = cs.to;
        continue;
      } else if (c === '[') {
        if (i > 0 && s.charAt(i - 1) === '!') { i++; continue; } // 图片行保持源码
        m = matchAt(reLink, i);
        if (m) kind = 'link';
      } else if (c === '*') {
        m = matchAt(reBoldStar, i);
        if (m) kind = 'bold';
        else { m = matchAt(reItStar, i); if (m) kind = 'ital'; }
      } else if (c === '_') {
        // 词内守卫：开/闭 `_` 紧邻字母数字下划线 → 标识符（snake_case），不成语法
        if (!isWordish(s.charAt(i - 1))) {
          const bM = matchAt(reBoldUnder, i);
          const tM = bM ? null : matchAt(reItUnder, i);
          const picked = bM || tM;
          if (picked && !isWordish(s.charAt(i + picked[0].length))) {
            m = picked;
            kind = bM ? 'bold' : 'ital';
          }
        }
        if (!m) { i++; continue; }
      } else if (c === '~') {
        m = matchAt(reStrike, i);
        if (m) kind = 'strike';
      } else if (c === '=') {
        m = matchAt(reHighlight, i);
        if (m) kind = 'highlight';
      } else if (c === '<') {
        m = matchAt(reUnderline, i);
        if (m) kind = 'underline';
      }
      if (!m) { i++; continue; }
      const start = i;
      const end = i + m[0].length;
      if (kind === 'link') {
        push(start, start + 1, 'wysiwyg-inline-marker');
        push(start + 1, start + 1 + m[1].length, 'wysiwyg-inline-link');
        push(start + 1 + m[1].length, end, 'wysiwyg-inline-marker');
      } else if (kind === 'underline') {
        // 开/闭标签宽度不对称（<u> 3 字符 / </u> 4 字符），不走对称 tick 分支
        push(start, start + 3, 'wysiwyg-inline-marker');
        push(start + 3, end - 4, 'wysiwyg-underline');
        push(end - 4, end, 'wysiwyg-inline-marker');
      } else {
        const tick = (kind === 'ital') ? 1 : 2;
        const cls = 'wysiwyg-' + (kind === 'ital' ? 'italic' : kind === 'strike' ? 'strike' : kind === 'highlight' ? 'highlight' : 'bold');
        push(start, start + tick, 'wysiwyg-inline-marker');
        push(start + tick, end - tick, cls);
        push(end - tick, end, 'wysiwyg-inline-marker');
      }
      i = end;
    }
    return spans;
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
          htmlCache: this._wysiwygFinalHtmlCacheMap(),
        });
        if (blocks) return blocks; // [{ start, end, html }]
      }
      const lines = [];
      for (let i = 0; i < cm.lineCount(); i++) lines.push(cm.getLine(i));
      return splitBlocks(lines);
    },

    // ---------------- 块最终 HTML 缓存（跨进入复用，2026-11-01 性能） ----------------
    // 键 = 块源文本（b.src，与 renderMarkdownBlocks 的 slice 同一文本），值 = **后处理完成
    // 后**的最终 HTML（KaTeX/代码高亮/复选框/标题锚点等同步 stage 在 DOM 上跑完的结果）。
    // 此前每次进入 WYSIWYG / 每次挂遮罩都要重跑整条渲染管线 + 同步后处理（块表快照离开
    // 模式即作废）；命中缓存时两段全部跳过（真实浏览器实测 demo.md 二次进入 ~0.9s→~0.2s 量级）。
    // 失效：键是源文本，编辑过的块自然 miss；影响输出的设置（softBreaks/tabSize/
    // extendedSyntax/代码行号开关/暗色）变化 → 指纹不符整体清空；主题切换在 theme.js
    // rerenderMermaid 里与 _mermaidCache 一起清。异步 stage（mermaid/图片/TOC）不进缓存：
    // mermaid/图片已有实例级缓存（_mermaidCache/_imageBase64Cache），重挂近乎同步，命中块
    // 仍走异步 pass 注入（见 maskWysiwygBlock）。
    _wysiwygFinalHtmlFingerprint() {
      const lnOn = !!(this.preview && this.preview.classList.contains('code-line-numbers'));
      return [
        this.settings.softBreaks ? 1 : 0,
        this.settings.tabSize,
        this.settings.extendedSyntax === false ? 0 : 1,
        this.isDark ? 1 : 0,
        lnOn ? 1 : 0,
      ].join('|');
    },
    _wysiwygFinalHtmlCacheMap() {
      const fp = this._wysiwygFinalHtmlFingerprint();
      if (!this._wysiwygFinalHtmlCache || this._wysiwygFinalHtmlCacheFp !== fp) {
        this._wysiwygFinalHtmlCache = new Map();
        this._wysiwygFinalHtmlCacheFp = fp;
      }
      return this._wysiwygFinalHtmlCache;
    },
    // LRU 写入：命中即重插保新鲜；超大 HTML 不缓存（base64 大图会撑爆内存，
    // 图片重挂走既有 _imageBase64Cache，近乎同步）
    _wysiwygCacheFinalHtml(src, html) {
      if (!src || !html || html.length > 262144) return;
      const map = this._wysiwygFinalHtmlCacheMap();
      if (map.has(src)) map.delete(src);
      map.set(src, html);
      const CAP = 3000;
      if (map.size > CAP) {
        const drop = map.keys().next().value;
        map.delete(drop);
      }
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
          htmlCache: this._wysiwygFinalHtmlCacheMap(), // 命中块跳过整条渲染管线
        });
      }
      if (!blocks) {
        // 回退切块器（无 html，遮罩时按需渲染）
        const lines = [];
        for (let i = 0; i < cm.lineCount(); i++) lines.push(cm.getLine(i));
        blocks = splitBlocks(lines);
      }
      // 防御：滤掉畸形条目（缺 start/end 的 undefined 元素会让下游读 .start 抛
      // "Cannot read properties of undefined"；HMR 混载旧模块时实测出现过，2026-10-12）
      blocks = blocks.filter((b) => b && typeof b.start === 'number' && typeof b.end === 'number' && b.end > b.start);
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

    // 光标所在块的索引；不在任何块内（空行/文档尾）返回 -1。
    // blocks 可传显式块表（刷新路径用旧表做「钳光标在遮罩块」判定时与旧 marks 配套，见
    // _wysiwygActiveIdxFromCursor）。
    wysiwygBlockIndexAt(line, blocks) {
      const table = blocks || this._wysiwygBlocks || [];
      for (let k = 0; k < table.length; k++) {
        if (line >= table[k].start && line < table[k].end) return k;
      }
      return -1;
    },

    // 遮罩点击专用：块表可能滞后于输入（change 后的 250ms 防抖刷新未触发），实时行号
    // 查旧表会漏块返回 -1 → setWysiwygActiveBlock(-1) 会撤掉当前活动块 → 整篇瞬间全遮罩
    // 闪一下（防抖后才自愈）。-1 时先同步轻切块（parseOnly：只切边界不渲染 HTML，廉价），
    // 用最新块表再查；防抖刷新随后照常跑（结果相同，幂等）。
    _wysiwygBlockIndexAtFresh(line) {
      let idx = this.wysiwygBlockIndexAt(line);
      if (idx < 0) {
        try {
          const oldBlocks = this._wysiwygBlocks;
          const fresh = this.computeWysiwygBlocks(true);
          if (fresh) {
            // ⚠️ 切块后必须立即把遮罩标记重键到新表：marks 键是**挂遮罩时那张表**的块索引，
            // 结构变化（如列表内回车续出新项）后新表形状不同，调用方随后拿新表 idx 去
            // setWysiwygActiveBlock → unmaskWysiwygBlock(新idx) 会命中**另一块**的旧键遮罩
            // 撤掉它（2026-10-21 实测 S38：ol 项内回车后，下方引用块遮罩被误撤、源码裸露）。
            // 与全量增量刷新同一口径重键（_wysiwygRekeyMarksToBlocks）；250ms 防抖刷新随后
            // 照常跑，源匹配幂等（无副作用）。
            this._wysiwygRekeyMarksToBlocks(oldBlocks || [], fresh);
          }
        } catch (_) { /* 保留旧表 */ }
        idx = this.wysiwygBlockIndexAt(line);
      }
      return idx;
    },

    // ---------------- 渲染 ----------------

    // 渲染单个块的最新源码为 HTML；失败返回 ''（调用方据此保持源码态）
    renderWysiwygBlockHtml(start, end) {
      const cm = this.cm;
      const lines = [];
      const total = cm.lineCount();
      for (let i = start; i < end && i < total; i++) lines.push(cm.getLine(i));
      return this._wysiwygRenderSource(lines.join('\n'));
    },

    // 渲染任意源码文本（块切片 / 合成源，如 callout 下半段合成的标记行）为 HTML；
    // 失败返回 ''（调用方据此保持源码态）。renderWysiwygBlockHtml 与本方法共用此口径
    //（2026-10-25 引用分段遮罩需要按行段 + 合成源渲染，收口一处）。
    _wysiwygRenderSource(src) {
      if (!src || !src.trim()) return '';
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
      if (b.finalHtml) {
        // 最终缓存命中（html 来自 _wysiwygFinalHtmlCache）：KaTeX/高亮/复选框/锚点等
        // 同步 stage 已包含在缓存 HTML 里，跳过重跑（异步 stage 仍照常登记，见下方）。
      } else {
        this._postProcessWysiwygNode(node);
        // 现渲染块的同步后处理结果回写最终缓存（b.src 与 renderMarkdownBlocks 的 slice
        // 同文本；chrome（编辑按钮/表工具）在下方才挂，此刻 innerHTML 是纯内容）。
        if (b.src) this._wysiwygCacheFinalHtml(b.src, node.innerHTML);
      }
      // 列表块 / 标题块 / 普通文字段落不挂块级「编辑」按钮（2026-10-16 用户反馈 #1：点列表行
      // 直接进该行编辑，块级源码入口多余；2026-10-19 用户反馈 #1：标题块同理；2026-07-13
      // 用户要求：普通文字右侧不需要编辑按钮——遮罩 mousedown 本就把点击映射到源码行，
      // 点行即编辑）。⚠️ 撤按钮后内容元素成为节点 last-child，styles.css 的
      // `> *:last-child { margin-bottom: 0 }` 会把其底边距清零、遮罩矮一截（渲染↔源码切换
      // 跳动）→ 挂 no-btn 类把底边距补回（列表/普通文字段落 14px、标题 12px，各对应该
      // 渲染值），遮罩高度与有按钮时逐像素一致。
      // TOC 判定在挂遮罩时刻取（闭包用）且必须先于普通文字判定：[TOC] 行在异步替换目录
      // 前遮罩就是单个 <p>，若先判普通文字会漏掉「删除」按钮。
      const isTocBlock = this._wysiwygBlockIsToc(b);
      if (this._wysiwygBlockIsList(b)) {
        node.classList.add('wysiwyg-mask-no-btn');
        // 列表逐项块的非末项片段（2026-10-21 用户反馈：点列表项只该项显源码）：no-btn
        // 规则恢复的内容元素 14px 底距是「列表底距」，只归属列表末项；非末项片段底缘
        // 应 = 项间距 4px（li 自身 margin-bottom 折进遮罩底缘——把 ul/ol 底距清零即
        // 得 4px，li 底距不会穿越 BFC 底缘外溢）→ 见 styles.css wysiwyg-mask-li-mid 规则。
        if (b.listItem && b.listItemPos !== 'last') node.classList.add('wysiwyg-mask-li-mid');
      } else if (this._wysiwygBlockIsHeading(b)) node.classList.add('wysiwyg-mask-no-btn-heading');
      // 引用/提示块不挂「编辑」按钮（2026-10-25 用户要求「引用块、提示块的编辑按钮去掉」）：
      // 遮罩 mousedown 点击映射本就直达源码行（点哪行编辑哪行），块级入口多余；no-btn-qc
      // 规则把渲染 blockquote/.alert 的 16px 底距补回（与 14px 的 ul/ol/p 族不同值）。
      else if (this._wysiwygBlockIsQuote(b)) node.classList.add('wysiwyg-mask-no-btn-qc');
      else if (isTocBlock) this._addWysiwygTocDeleteButton(node);
      else if (this._wysiwygMaskIsDefList(node)) node.classList.add('wysiwyg-mask-no-btn-dl');
      else if (this._wysiwygMaskIsPlainText(node)) node.classList.add('wysiwyg-mask-no-btn');
      else this._addWysiwygEditButton(node);
      this._addWysiwygTableTools(node);

      let mark = null;
      const self = this;
      // 点击接管：把点击处的纵向比例映射到块内源码行，让光标落在用户点的那一行附近。
      // marker.find() 拿的是 CM 维护的实时位置（编辑后自动跟shift），故块划分变化也不会错位。
      node.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        // 表格拖拽进行中（pointerdown 先启动：左侧行轨/首格左缘区、顶部列轨；
        // 2026-10-20 起表头格不再是拖拽入口，无例外）：mousedown 是同一次按下的
        // 伴随事件，必须吞掉——落到下方「按点击纵比映射源码行」会撤罩表格块 + 挪光标，
        // 拖拽半途表格变源码（2026-10-13 轨道常驻后 gutter 按下的目标是轨道 span，
        // 非单元格，单元格分支的守卫罩不住它）。
        if (self._wysiwygTableDrag) { ev.preventDefault(); return; }
        // [TOC] 块（2026-10-21 用户要求：目录不允许编辑、点击无反应）：遮罩内任何点击
        // （含目录链接/遮罩空白）一律无反应——不映射源码行、不进编辑、不跳转。保留与通用
        // 路径一致的「先提交在编表格格」，避免点 TOC 把进行中的格编辑悬空；仅右上「删除」
        // 按钮有效（删除 [TOC] 源行，见下）。
        if (isTocBlock) {
          if (self._wysiwygCellEditing) self._wysiwygEndCellEdit(true, false);
          const tocDel = ev.target && ev.target.closest ? ev.target.closest('button[data-toc-delete]') : null;
          ev.preventDefault();
          if (!tocDel) return;
          try {
            const r = mark && mark.find ? mark.find() : null;
            if (r) {
              const s = r.from.line;
              const e = r.to.line;
              const last = cm.lineCount() - 1;
              let from = { line: s, ch: 0 };
              // 连行尾换行一起删（避免留空行）；末行则删到行尾
              let to = (e < last) ? { line: e + 1, ch: 0 }
                : { line: e, ch: (cm.getLine(e) || '').length };
              // 块前后各有一个空行时改删前导换行，避免留下连续两个空行
              if (e < last && s > 0 &&
                  (cm.getLine(s - 1) || '').trim() === '' && (cm.getLine(e + 1) || '').trim() === '') {
                from = { line: s - 1, ch: (cm.getLine(s - 1) || '').length };
              }
              cm.operation(() => { cm.replaceRange('', from, to); });
              cm.focus();
            }
          } catch (_) { /* 标记已失效则忽略本次点击 */ }
          return;
        }
        // 正在编辑的本格：mousedown 交给浏览器原生文本选择（2026-10-14 用户要求：单元格
        // 文字也要支持选中）。必须在 preventDefault 之前 return——preventDefault 会杀死
        // 原生选择；不提交、不重进编辑（重进会先提交+重落光标，反把拖选打断）。
        // CSS 侧配合：.wysiwyg-cell-editing 恢复 user-select:text（遮罩节点默认 none）。
        const hitCell = ev.target && ev.target.closest ? ev.target.closest('td,th') : null;
        if (hitCell && self._wysiwygCellEditing && hitCell === self._wysiwygCellEditing.cell) return;
        // 代码块复制按钮：放行 click（拦截 mousedown 会吞掉 click、光标被拽到源码行，
        // 复制按钮点不动）。按钮自身已阻止冒泡，这里只需不 preventDefault。
        if (ev.target && ev.target.closest && ev.target.closest('button.copy-btn')) return;
        // 块编辑按钮（2026-10-11 用户反馈 #4）：显式「进入本块编辑」入口——先取标记
        // 实时位置（撤遮罩后 mark 失效），再撤遮罩并把光标定位到块首行。
        const editBtnEl = ev.target && ev.target.closest ? ev.target.closest('button.block-edit-btn') : null;
        if (editBtnEl) {
          ev.preventDefault();
          try {
            const r = mark && mark.find ? mark.find() : null;
            if (r) {
              // 先解罩目标块再落光标（与点击定位同一 CM5 clamp 问题）；活动块索引按「目标行」查
              //（Fresh：防抖窗口内的点击块表滞后，-1 会误撤当前活动块 → 整篇遮罩闪烁）
              self.setWysiwygActiveBlock(self._wysiwygBlockIndexAtFresh(r.from.line));
              cm.setSelection({ line: r.from.line, ch: 0 }, { line: r.from.line, ch: 0 }, { scroll: false, origin: '*mouse' });
              try { cm.scrollIntoView({ line: r.from.line, ch: 0 }, 40); } catch (_) { }
              cm.focus();
            }
          } catch (_) { /* 标记已失效则忽略本次点击 */ }
          return;
        }
        ev.preventDefault();
        try {
          // 格编辑中 + 按下点在本格以外的任何处（另一格 / 表 wrap 留白 / 另一块遮罩 /
          // 图片 / 图表 / 工具按钮 / 链接 / 复选框）：先提交本格失焦（2026-10-14 用户要求：
          // 点击其他行或空白处时单元格失去焦点）。settle=false：不挪光标、不抢焦点、不补
          // 空行——光标/焦点由下方各分支接管（另一格 → 新格接管；另一块 → 点击映射落光标；
          // 表 wrap 留白 → 焦点自然归 body）。点本格已在上方 return（原生文本选择）。
          // 下方分支自带的 commit-first（_wysiwygTableAdd/_wysiwygStartCellEdit）此刻为 no-op。
          if (self._wysiwygCellEditing) self._wysiwygEndCellEdit(true, false);
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
          // 表格工具按钮：右下「＋」增行 / 右缘「＋」增列（2026-10-13 用户要求，Typora 式）
          // → 纯函数重建整块回写（行数可能变）→ 自动格编辑新格
          const toolBtn = ev.target && ev.target.closest ? ev.target.closest('.wysiwyg-table-add-row, .wysiwyg-table-add-col') : null;
          if (toolBtn) {
            ev.preventDefault();
            const maskNodeNow = toolBtn.closest('.' + MASK_CLASS);
            if (maskNodeNow) self._wysiwygTableAdd(toolBtn.classList.contains('wysiwyg-table-add-row') ? 'row' : 'col', maskNodeNow);
            return;
          }
          // 表格单元格：点格子 → **该格就地源码编辑**（Phase 2 / R5，2026-10-13，
          // 参考 Typora/有道云笔记「渲染态格内编辑」）。整张表保持遮罩（只有格在编辑），
          // 不再走旧行为「点表格整块变源码」——整块源码入口保留在块右上「编辑」按钮。
          // 格内链接 + Ctrl/Cmd = 跟随链接（落到下方链接分支）；其余点格一律进单元格编辑。
          const cellEl = ev.target && ev.target.closest ? ev.target.closest('td,th') : null;
          if (cellEl && !(cellEl.closest('a') && (ev.ctrlKey || ev.metaKey))) {
            // 行拖拽 / 顶 gutter 列拖拽已在 pointerdown（先于 mousedown）启动：不启动格编辑
            //（2026-10-20 起表头格不再是列拖把手，按下即普通格编辑，无例外）。
            const dragSt = self._wysiwygTableDrag;
            if (dragSt) return;
            const trNow = cellEl.closest('tr');
            const tableNow = cellEl.closest('table');
            const trsNow = tableNow ? Array.from(tableNow.querySelectorAll('tr')) : [];
            // 传点击坐标（viewport）→ 光标落到点击处而非整格全选（用户反馈 #3）
            self._wysiwygStartCellEdit(cellEl,
              trNow ? trsNow.indexOf(trNow) : -1,
              trNow ? Array.from(trNow.children).indexOf(cellEl) : -1,
              { x: ev.clientX, y: ev.clientY });
            return;
          }
          // 表格块遮罩内的其余点击（wrap 上/下留白等杂点）：吞掉不动作——单元格/行列拖
          // 轨道/增行增列条带/块编辑按钮都已在上方分支派完；再落入下方「按纵向比例映射
          // 源码行」会整表撤罩变源码态。整表源码的唯一入口 = 块右上「编辑」按钮
          // （2026-10-14 用户要求：只有点编辑按钮才进源码编辑模式）。
          if (node.querySelector && node.querySelector('.wysiwyg-table-wrap')) return;
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
          // 折叠区块（details/summary）：点 summary → 原地折叠/展开（与阅读模式行为一致，
          // 2026-10-21 用户反馈「折叠区块在实时预览没法折叠展开」）。本 handler 顶部已
          // stopPropagation + 上方已 preventDefault → CM 收不到按下、光标不动、块不撤罩
          //（旧行为落入下方纵比映射 → 整块变源码，折叠框当场被拆）。return 放行原生
          // click 完成 open 切换——**纯 DOM 瞬态，不回写源码**（与阅读模式同口径：渲染
          // 管线 normalizeDetails 每次渲染统一展开，折叠态本就不入源）。⚠️ 切换后遮罩行
          // 盒高度变了但没有 CM 操作 → 必须刷新重测，否则后续内容行位/滚动区错位；
          // 用 toggle 事件（open 变化后触发，晚于 click 默认动作）而非 mousedown 时刻的
          // setTimeout（计时器可能抢在 click 前跑、量到旧高度）。
          const summaryEl = ev.target && ev.target.closest ? ev.target.closest('summary') : null;
          if (summaryEl && summaryEl.closest) {
            const detEl = summaryEl.closest('details');
            if (detEl) {
              detEl.addEventListener('toggle', () => {
                try { cm.refresh(); } catch (_) { /* 刷新失败不阻断折叠动作 */ }
              }, { once: true });
              return;
            }
          }
          // 折叠区块正文（2026-10-22 用户要求「折叠区块不允许点击文字进入编辑态，需要
          // 点击后面的编辑按钮进入」）：details 内除 summary（上方分支保留原地折叠/
          // 展开）之外的文字点击一律吞掉——遮罩不撤、光标不动、块保持渲染态；进源码态
          // 的唯一入口 = 块右上「编辑」按钮（其分支在上方已派发）。
          const detHost = ev.target && ev.target.closest ? ev.target.closest('details') : null;
          if (detHost && node.contains(detHost)) return;
          const r = mark && mark.find ? mark.find() : null;
          if (!r) return;

          // ⚠️ 定位光标前必须先 setWysiwygActiveBlock 撤掉本块遮罩（2026-10-09 实测）：
          //    CM5 对落在 replacedWith 标记区间**内部**的 setSelection 位置会钳制到标记
          //    首/末端——先落光标后撤遮罩（原实现走 cursorActivity 撤遮罩），光标恒落到
          //    块首/块尾行，点块中间永远点不准；撤掉标记后目标行才是真实源码行。
          //    活动块索引按「目标行」查（增量刷新后闭包 idx 可能已位移，行→块才是准的）。

          // 其余块：默认按点击纵向比例映射到块内源码行
          //（表格格点击已在上方路由到 _wysiwygStartCellEdit 就地编辑，不再整块变源码）
          // ⚠️ 「撤罩 + 落光标」在 mousedown 瞬间同步执行（原有时序，harness 模拟点击
          //  只派发 mousedown）；拖选升级在其后按移动距离判定（见下）——mousedown 已
          //  stopPropagation，CM 收不到这次按下，从遮罩起拖的选区完全由本分支自管
          //  （2026-10-16 用户反馈「鼠标选中没法跨块」的根因之二）。
          const rect = node.getBoundingClientRect();
          let target = r.from.line;
          // 列表项精确落行（2026-10-16 用户反馈 #2：点哪行光标落哪行）：比例估算的分母
          // 是遮罩整高（含底 padding）、行数是块全行数（含松散列表项间空行），点中间项
          // 恒偏上一行——实测 5 项列表点第 3 项落第 2 项、3 项列表点第 2 项上半落第 1 项。
          // 渲染 HTML 的 <li>/<p> 自带 data-source-line（remark 插件标注的块切片内 1-based
          // 行号，与任务复选框回写同一机制）：点击落在 <li> 内时取**最内层**标注还原精确
          // 行（= 块首行 + 行号 − 1；松散列表多段 li 点第二段落落该段自身行而非项首行）。
          // 仅列表项启用：代码块 pre 只标块首行号、表格格走上方就地编辑分支，比例对其更准。
          const liEl = ev.target && ev.target.closest ? ev.target.closest('li') : null;
          // 定义列表精确落行（2026-10-18 用户反馈：点 dd 行落 dt 行）——dd 渲染为换行
          // 行盒，比例估算（分母=遮罩整高）恒偏 dt。convertDefLists 给每个 dt/dd 标了
          // 各自源行号（块切片内 1-based，同 remark 插件 li 标注机制）；<dl> 壳虽也标
          // 了行号（= dt 行）但从点击点向上走总先命中 dt/dd，不会误落。
          const dlEl = ev.target && ev.target.closest ? ev.target.closest('dt, dd') : null;
          const exactHost = liEl || dlEl;
          let exactLine = false;
          if (exactHost && node.contains(exactHost)) {
            let el2 = (ev.target && ev.target.nodeType === 1) ? ev.target : (ev.target ? ev.target.parentNode : null);
            let srcLine = null;
            while (el2 && el2 !== exactHost) {
              const v = el2.getAttribute ? el2.getAttribute('data-source-line') : null;
              if (v) { srcLine = parseInt(v, 10); break; }
              el2 = el2.parentNode;
            }
            if (!srcLine && exactHost.getAttribute) {
              srcLine = parseInt(exactHost.getAttribute('data-source-line'), 10) || null;
            }
            if (srcLine && isFinite(srcLine)) {
              target = r.from.line + Math.max(0, srcLine - 1);
              exactLine = true;
            }
          }
          if (!exactLine && rect.height > 0 && r.to.line > r.from.line) {
            const ratio = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
            target = r.from.line + Math.floor(ratio * (r.to.line - r.from.line));
          }
          const line = Math.min(Math.max(target, 0), cm.lineCount() - 1);

          // —— 点击（同步执行，保持原行为）+ 拖选升级（2026-10-16 用户反馈「鼠标选中和
          // 全选没法跨块」）——
          // 本 mousedown 已 stopPropagation+preventDefault：CM 永远不会自行发起拖选，
          // 原生选区也被禁用。旧行为在 mousedown 瞬间「切活动块 + 落光标」，从遮罩起拖
          // 只会跳光标。现点击行为保持 mousedown 同步执行（harness 的模拟点击只派发
          // mousedown、真机点击也须在按下瞬间解罩落光标，时序不可推迟到 mouseup），
          // 再按移动距离**升级**为跨块选区拖拽：
          //  · 移动 ≥4px → 以本遮罩边界为 anchor（向下/水平拖取块首 r.from、向上拖取块末
          //    r.to——atomic 区间不可部分选中，整块作为单元；边界端点因
          //    inclusiveLeft/Right:false 合法不钳制），head 随鼠标经 coordsChar 推进
          //    （落在遮罩内被 skipAtomic 钳到该遮罩边界 → 选区逐遮罩单元跨越），选区视觉
          //    由 _applyWysiwygSelectionMaskClasses 给被覆盖遮罩挂类着色。
          //  · 释放前未移动 → 无追加动作（点击效果已在 mousedown 完成）。
          //  拖拽期间 _wysiwygSelDragging 冻结 syncWysiwygActiveBlock：setSelection 触发的
          //  cursorActivity 若照常切活动块，会把指针下的块解罩、几何变化打断拖拽。
          // Fresh：输入后 250ms 防抖窗口内点遮罩时块表行号滞后 → 旧表漏块 -1 → 误撤
          // 当前活动块（整篇瞬间全遮罩闪烁）；-1 时同步轻切块（parseOnly）再查。
          // 点击锚定：撤遮罩后把该源码行放回点击时的屏幕位置，杜绝点击后视口乱跳。
          // ⚠️ 必须先于 setWysiwygActiveBlock 设置（2026-10-18 回归）：该调用内部的
          // _capture/_restoreWysiwygAnchor 以 click 锚点为守卫整体跳过——若在其后才设，
          // 光标锚点补偿会与点击锚点双补偿，其中 operation 内的延迟补偿（setTimeout）
          // 在 _applyWysiwygClickAnchor 之后执行、把点击锚定的滚动冲掉（S43 段落 Δ104px）。
          const downX = ev.clientX, downY = ev.clientY;
          // 点击锚定参照（S71 2026-10-21 用户反馈「点某行进编辑态再点其他行，页面往下移动
          // 一段距离」）：记录「被点源码行在撤罩前其行顶边的屏幕 y」——撤罩后该行顶边应落回
          // 此处（净位移=真实结构差；块高逐像素一致时位移=0，视口完全不滚）。旧口径把行顶
          // 钉到点击点：点行中部/多行块靠后行时，视口被滚走「点击点在行内的偏移」，表现为
          // 每次点击整页下移一段。行顶的撤罩前位置按宿主取：
          //  · 列表项/定义项：宿主框顶减自身 margin-top（dt 的 8px 顶距属于其源码行行首的
          //    行内留白，行顶边在 dt 边框盒上方；dd/li 顶距为 0，不变）；
          //  · 单行块：遮罩顶=行顶；
          //  · 多行无宿主块（代码等，渲染行近似等高）：按行序均分遮罩高估算。
          let refTop = null;
          try {
            if (exactHost && exactHost.getBoundingClientRect) {
              const hmv = parseFloat(getComputedStyle(exactHost).marginTop) || 0;
              refTop = exactHost.getBoundingClientRect().top - hmv;
            } else if (rect && rect.height > 0 && r.to.line > r.from.line) {
              refTop = rect.top + (line - r.from.line) * (rect.height / (r.to.line - r.from.line + 1));
            } else if (rect) {
              refTop = rect.top;
            }
          } catch (_) { /* 量不到时 _applyWysiwygClickAnchor 回退旧口径 */ }
          self._wysiwygClickAnchor = { y: downY, line, refTop };
          self.setWysiwygActiveBlock(self._wysiwygBlockIndexAtFresh(line));
          // scroll:false，避免 ensureCursorVisible 抢先滚动导致锚定失效
          cm.setSelection({ line, ch: cm.getLine(line).length },
            { line, ch: cm.getLine(line).length }, { scroll: false, origin: '*mouse' });
          cm.focus();
          self._applyWysiwygClickAnchor();
          // 拖选升级：mousedown 后移动 ≥4px → 覆盖点击结果为跨块选区（活动块保持被点块）
          let dragging = false;
          let anchor = null;
          const onMove = (mv) => {
            if (!dragging) {
              if (Math.abs(mv.clientX - downX) + Math.abs(mv.clientY - downY) < 4) return;
              dragging = true;
              self._wysiwygSelDragging = true;
              anchor = mv.clientY >= downY ? { line: r.from.line, ch: r.from.ch }
                : { line: r.to.line, ch: r.to.ch };
              try {
                cm.setSelection(anchor, anchor, { scroll: false, origin: '*mouse' });
              } catch (_) { /* 标记已失效则放弃本次拖拽 */ }
              return;
            }
            try {
              const p = cm.coordsChar({ left: mv.clientX, top: mv.clientY });
              if (!p || !anchor) return;
              const a = anchor, h = p;
              const aFirst = a.line < h.line || (a.line === h.line && a.ch <= h.ch);
              cm.setSelection(aFirst ? a : h, aFirst ? h : a, { scroll: false, origin: '*mouse' });
            } catch (_) { /* 忽略（标记失效/坐标越界） */ }
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (self._wysiwygSelDragging) {
              self._wysiwygSelDragging = false;
              // 释放后活动块归位到光标（选区头）所在块（2026-10-21 逐项切块后口径）：
              // 冻结期 setWysiwygActiveBlock 被跳过，而 mouseup 时 CM 常无新选区变化
              // （head 已在末次 move 落位）→ 无 cursorActivity 补同步，活动块会停在拖选
              // 起始块——逐项语义下光标行的项被遮罩、源码不显示（违背「光标行显示源码」）。
              // 此刻同步安全：拖拽已结束、几何稳定，锚点补偿照护块切换位移。
              self.syncWysiwygActiveBlock();
              self._applyWysiwygSelectionMaskClasses();
            }
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        } catch (_) { /* 标记已失效则忽略本次点击 */ }
      });

      // 表格行/列拖拽换位（2026-10-13 用户要求，Typora 式）：pointerdown 先于 mousedown。
      // 拖拽入口只有两处（2026-10-20 用户要求：表头不允许拖动）：
      // ① 左侧行轨（含首格左缘 16px 把手区，直接 preventDefault，不触发格编辑）；
      // ② 顶部列轨（pill）。表头格按下 = 普通格编辑，不再启动列拖拽。
      node.addEventListener('pointerdown', (ev) => {
        const grabbed = self._wysiwygTableDragStart(ev);
        if (grabbed) ev.preventDefault();
      });

      try {
        mark = cm.markText(from, to, {
          replacedWith: node,
          clearWhenEmpty: false,
          // ⚠️ 两端边界**非包含**（2026-10-16 跨块选区修复，原 inclusiveLeft:true 已移除）：
          // inclusiveLeft:true 时连「恰好落在遮罩起点」的选区端点都算 atomic 区间内部，
          // skipAtomic 把它推到遮罩末端 → Ctrl+A 的锚点 {0,0} 被推到首个块末尾（首块
          // 永远选不中，实测全选 42/47 字符丢首块）、拖选端点也落不到遮罩边缘。
          // 两端非包含后端点可合法停在遮罩边界（遮罩作为整体单元被选中），全选=全篇。
          inclusiveLeft: false,
          inclusiveRight: false,
          atomic: false,
        });
        this._wysiwygMarks.set(idx, mark);
        // 异步 pass（图片 / Mermaid / TOC / 代码块滚动条）不得在 markText 返回瞬间跑：
        // CM5 的 replacedWith 是 collapsed 标记的 widget，markText 返回时显示更新尚未把
        // widget 插进行 DOM（2026-10-11 harness 实测：自动/显式 operation 两种路径此刻
        // node.isConnected 均为 false）→ 旧实现在这里同步调 _wysiwygPostProcessAsync，
        // isConnected 守卫把所有批量挂遮罩的异步 pass 全部静默跳过（TOC/图片/图表缺失根因）。
        // 改为登记待跑 + 等 DOM 落定后由 flushWysiwygAsyncPasses 统一执行。
        // 就绪后高度变化用「测前测后 + 滚动补偿」保持视口（SVG/图片撑高不得冲走用户正在看的内容）。
        this._wysiwygNodeGen = this._wysiwygNodeGen || new Map();
        this._wysiwygMaskGen = (this._wysiwygMaskGen || 0) + 1;
        this._wysiwygNodeGen.set(node, this._wysiwygMaskGen);
        this._wysiwygPendingAsync = this._wysiwygPendingAsync || new Set();
        this._wysiwygPendingAsync.add(node);
        this._scheduleWysiwygAsyncFlush();
      } catch (_) { /* 区间非法则放弃该块遮罩 */ }
    },

    // ---------------- 引用/提示块（callout）活动态「渲染分段 + 光标行源码」（2026-10-25
    // 用户要求：引用块、提示块编辑态样式与渲染态一致，光标在哪一行就显示该行源码编辑）----------------
    // 非光标行不再逐行显示源码，而是按「上段 [start, cursor) / 下段 (cursor, end]」两个
    // 独立遮罩渲染（与阅读态同一渲染管线），光标行保持源码（既有 > 槽/竖条/背景机制，
    // > 在光标行可见）。光标块内移动、输入变更（change 钩子）、防抖重算后重算分段边界
    //（_wysiwygSegState 记录 idx+cursor+两段源文，范围与源文均未变时幂等 no-op）；活动块
    // 失活（整块重遮）时随 _wysiwygClearQuoteSegments 一并清退。
    // callout 下半段渲染需合成块首标记行（`> [!TYPE] 标题`，与渲染器 convertAlerts 同一
    // 口径：无标记行则整段渲染成普通引用），CSS 隐藏其重复的 alert-title。
    _wysiwygSegSource(s, e, markerLine) {
      const cm = this.cm;
      const lines = [];
      const total = cm.lineCount();
      for (let i = s; i < e && i < total; i++) lines.push(cm.getLine(i));
      let src = lines.join('\n');
      if (markerLine) src = markerLine + '\n' + src;
      return src;
    },

    // 块是否为引用（首行 `>` 前缀，与 RE.quote 同一口径；callout 是引用子集同样命中）
    _wysiwygBlockIsQuote(b) {
      const cm = this.cm;
      if (!cm || !b) return false;
      const line = (b.start < cm.lineCount()) ? cm.getLine(b.start) : '';
      return RE.quote.test(line);
    },

    // 块首行的 callout 类型：与渲染器 getAlertType 完全同口径（小写 startsWith、不容
    // 前导空格——渲染器不认的块分段也不得按 callout 处理，否则分段配色与渲染态不符）。
    _wysiwygBlockAlertType(b) {
      const cm = this.cm;
      if (!cm || !b) return null;
      const line = ((b.start < cm.lineCount()) ? cm.getLine(b.start) : '').toLowerCase();
      if (line.startsWith('> [!info]') || line.startsWith('> [!note]')) return 'note';
      if (line.startsWith('> [!tip]')) return 'tip';
      if (line.startsWith('> [!important]')) return 'important';
      if (line.startsWith('> [!warning]')) return 'warning';
      if (line.startsWith('> [!caution]')) return 'caution';
      return null;
    },

    // 清退活动引用块的分段遮罩（整块重遮前 / 离开模式 / 换文档必调，与整块遮罩不重叠）
    _wysiwygClearQuoteSegments() {
      if (this._wysiwygSegMarks) {
        for (const mark of this._wysiwygSegMarks) {
          try { mark.clear(); } catch (_) { /* 已销毁 */ }
          const node = mark && mark.replacedWith;
          if (node && this._wysiwygPendingAsync) this._wysiwygPendingAsync.delete(node);
        }
      }
      this._wysiwygSegMarks = null;
      this._wysiwygSegState = null;
    },

    // 按光标行重挂分段遮罩（幂等：见 _wysiwygSegState 判定）。非引用活动块/光标在块外
    // → 清退并返回。调用点：setWysiwygActiveBlock（激活）、syncWysiwygActiveBlock（光标
    // 移动）、change 钩子（行号/文本变化）、防抖重算 ×2。
    _wysiwygApplyQuoteSegments() {
      const cm = this.cm;
      const idx = this._wysiwygActiveIdx;
      const b = (cm && idx >= 0 && this._wysiwygBlocks) ? this._wysiwygBlocks[idx] : null;
      if (!cm || !b || !this._wysiwygBlockIsQuote(b)) { this._wysiwygClearQuoteSegments(); return; }
      let cur = null;
      try { cur = cm.getCursor('head').line; } catch (_) { this._wysiwygClearQuoteSegments(); return; }
      if (cur < b.start || cur >= b.end) { this._wysiwygClearQuoteSegments(); return; }
      const markerLine = this._wysiwygBlockAlertType(b) ? cm.getLine(b.start) : null;
      // 2026-10-28 多行原子结构整体保源码（根治引用分段撕裂，详见 quoteAtomicRange 注释）：
      // 光标落在围栏 / 缩进代码 / 表格 / 展示公式 / HTML 容器 / 列表 内部时，**整个结构**保持
      // 源码（raw 区扩展到 [rawS, rawE]），不再按光标行从中间劈开 —— 劈开的两段源码各自结构
      // 不完整，remark 容错解析与渲染态不符（空代码盒 / 正文被吞进代码块 / 裸管道符 / 落单
      // $$ / 破折叠盒 / 嵌套子项提升成顶层列表）。与顶层同款结构「光标进块整块显源码」同口径。
      // 光标不在任何多行结构内 → ar 为 null → rawS=rawE=cur，即完全走旧的「光标行单点」口径
      // （零回归面）。块行快照用 CM 现读：change 钩子到本重算之间可能有未同步的编辑。
      const rawLines = [];
      {
        const total = cm.lineCount();
        for (let i = b.start; i < b.end && i < total; i++) rawLines.push(cm.getLine(i) || '');
      }
      const ar = quoteAtomicRange(rawLines, cur - b.start);
      const rawS = ar ? b.start + ar[0] : cur;
      const rawE = ar ? b.start + ar[1] : cur;
      // 2026-10-28 用户①「嵌套换行中间空白」：嵌套开口方向——光标行层级 N 决定段内哪些
      // 嵌套盒朝光标行敞口（层级 2..N 的盒在上段清底、下段清顶，见 styles.css seg-open 规则）。
      // 只清顶层（既有 > blockquote 规则）不够：嵌套盒自身 12px pad + 16px margin 会留在
      // 接缝（实测嵌套 seg-top mask 底 = 盒底 + 16px 白缝）；深层（> N）盒闭合、保留底缘。
      // 前缀内 > 计数 = split('>').length − 1（split 语义：N 个 > 切出 N+1 段）
      const curLvl = (((cm.getLine(cur) || '').match(/^\s*(?:>[ \t]?)+/) || [''])[0].split('>').length - 1);
      // 接缝深侧（2026-10-28 实测）：段末行比光标深（闭合嵌套盒紧邻接缝）时，其 16px
      // 底/顶 margin 会从开口盒背景逸出 = 盒↔带 16px 白条（渲染态该区域在开口盒内、有底色）。
      // deep 标志 → 内层开口盒（层级 N）补 16px 内距吸收该 margin、闭合盒（N+1）margin 清零
      // （见 styles.css seg-deep 规则）
      const lvlOf = (ln) => (((cm.getLine(ln) || '').match(/^\s*(?:>[ \t]?)+/) || [''])[0].split('>').length - 1);
      // 接缝两侧改为「源码区两侧」（多行结构整块保源码后接缝不在光标行两侧，而在 raw 区两侧）
      const deepTop = rawS > b.start && lvlOf(rawS - 1) > curLvl;
      const deepBot = rawE + 1 < b.end && lvlOf(rawE + 1) > curLvl;
      const openCls = curLvl >= 2
        ? ' wysiwyg-quote-seg-open-' + Math.min(curLvl, 6)
        : '';
      // rawS/rawE 进状态键：多行结构的范围随编辑变化（增删表格行、围栏内容、列表项）时，
      // 仅 cur/curLvl/两段源文未变不足以判定「无需重挂」—— 范围变了必须重挂（否则 raw 区
      // 边界陈旧 = 新加的行落进分段渲染、或源码区漏/多）。
      const topSrc = this._wysiwygSegSource(b.start, rawS);
      const botSrc = this._wysiwygSegSource(rawE + 1, b.end, markerLine);
      // 2026-10-28 S91 用户②：光标行层级变化（空嵌套行回车弹级 > > → >、行首删一层 > 等）
      // 时 cur/段源都不变 → 只按 (idx,cur,src) 早退会留陈旧 seg-open-N/deep 类（实测弹级后
      // seg-top 挂旧 open-2：嵌套盒该闭合处仍敞口、pb/mb/radius 全清、块高缺 28px，输入过程
      // 显示异常）。curLvl 进状态键：层级一变即重建两段、open/deep 类按新层级重挂。
      const st = this._wysiwygSegState;
      if (st && st.idx === idx && st.cur === cur && st.curLvl === curLvl && st.rawS === rawS && st.rawE === rawE
        && st.topSrc === topSrc && st.botSrc === botSrc) return;
      this._wysiwygClearQuoteSegments();
      const self = this;
      const mk = (s, e, cls) => {
        if (s >= e) return null;
        const html = this._wysiwygRenderSource(this._wysiwygSegSource(s, e, cls === 'wysiwyg-quote-seg-bottom' ? markerLine : null));
        if (!html) return null;
        const node = document.createElement('div');
        const deepCls = (cls === 'wysiwyg-quote-seg-top' ? deepTop : deepBot) ? ' wysiwyg-quote-seg-deep' : '';
        node.className = MASK_CLASS + ' preview-content ' + cls + openCls + deepCls;
        node.innerHTML = html;
        node.setAttribute('data-block-index', String(idx));
        node.setAttribute('contenteditable', 'false');
        this._wysiwygMaskTypography(node);
        this._postProcessWysiwygNode(node);
        let mark = null;
        // 点击分段 = 把光标映射到段内源码行（与整块遮罩同一纵比口径；块本就活动，
        // setWysiwygActiveBlock 同 idx 早退，仅自愈陈旧状态）；不做表格/TOC/链接分支
        //（引用段内无这些交互，点哪行即编辑哪行）
        node.addEventListener('mousedown', (ev) => {
          ev.stopPropagation();
          if (self._wysiwygTableDrag) { ev.preventDefault(); return; }
          ev.preventDefault();
          try {
            if (self._wysiwygCellEditing) self._wysiwygEndCellEdit(true, false);
            const r = mark && mark.find ? mark.find() : null;
            if (!r) return;
            const rect = node.getBoundingClientRect();
            let target = r.from.line;
            if (rect.height > 0 && r.to.line > r.from.line) {
              const ratio = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
              // 2026-10-25：纵比改「span+1 半区」归一——原 ratio*span 下末行只在
              // ratio→1（节点底缘像素）可达，短段（2 源码行）下半区点击全落倒数第二行；
              // span+1 使每源码行占自己的半区，段内任意位置点击都落到对应行（含末行）
              const span = r.to.line - r.from.line;
              target = r.from.line + Math.min(span, Math.floor(ratio * (span + 1)));
            }
            const line = Math.min(Math.max(target, 0), cm.lineCount() - 1);
            let refTop = null;
            if (rect && rect.height > 0) {
              refTop = (r.to.line > r.from.line)
                ? rect.top + (line - r.from.line) * (rect.height / (r.to.line - r.from.line + 1))
                : rect.top;
            }
            self._wysiwygClickAnchor = { y: ev.clientY, line, refTop };
            // ⚠️ 先清分段再落光标：replacedWith 标记把段内行收成原子单元，段内落点会被
            // 钳到段缘（同整块遮罩点击前必须 unmask 的口径）。清段后目标行是源码行、
            // 可寻址；cursorActivity → sync 会在新光标行重挂分段（几何变化后 _applyWysiwygClickAnchor
            // 按终态几何补偿滚动）。
            self._wysiwygClearQuoteSegments();
            self.setWysiwygActiveBlock(self._wysiwygBlockIndexAtFresh(line));
            cm.setSelection({ line, ch: cm.getLine(line).length },
              { line, ch: cm.getLine(line).length }, { scroll: false, origin: '*mouse' });
            cm.focus();
            self._applyWysiwygClickAnchor();
          } catch (_) { /* 标记已失效则忽略本次点击 */ }
        });
        try {
          const lastLine = Math.min(e - 1, cm.lineCount() - 1);
          mark = cm.markText({ line: s, ch: 0 },
            { line: lastLine, ch: cm.getLine(lastLine).length },
            { replacedWith: node, clearWhenEmpty: false, inclusiveLeft: false, inclusiveRight: false, atomic: false });
        } catch (_) { return null; }
        // 异步 pass 登记（段内图片/图表等，与整块遮罩同机制）
        this._wysiwygNodeGen = this._wysiwygNodeGen || new Map();
        this._wysiwygMaskGen = (this._wysiwygMaskGen || 0) + 1;
        this._wysiwygNodeGen.set(node, this._wysiwygMaskGen);
        this._wysiwygPendingAsync = this._wysiwygPendingAsync || new Set();
        this._wysiwygPendingAsync.add(node);
        this._scheduleWysiwygAsyncFlush();
        return mark;
      };
      const marks = [];
      const top = mk(b.start, rawS, 'wysiwyg-quote-seg-top');
      if (top) marks.push(top);
      const bot = mk(rawE + 1, b.end, 'wysiwyg-quote-seg-bottom');
      if (bot) marks.push(bot);
      this._wysiwygSegMarks = marks;
      this._wysiwygSegState = { idx, cur, curLvl, rawS, rawE, topSrc, botSrc };
      this._applyWysiwygSelectionMaskClasses();
    },

    // 块是否为顶层列表：块首行（前导空格 ≤3）+ 列表标记。块表由 remark 切分，顶层列表块
    // 首行必是标记行；引用内列表首行是 `>`（判为引用块，保留按钮）；缩进 ≥4 空格是代码
    // 不是列表。判据与渲染器切块同一 CommonMark 口径，保证「判为列表」⇔「渲染为 ul/ol」。
    // ⚠️ 标记后允许「空格/Tab/行尾」三选一（CommonMark：`1.` 独占一行也是合法空项标记，
    // 续行缩进承载内容）——只认 `\s` 会把此类有序列表误判为非列表、漏掉 no-btn。
    _wysiwygBlockIsList(b) {
      const cm = this.cm;
      if (!cm || !b) return false;
      const line = (b.start < cm.lineCount()) ? cm.getLine(b.start) : '';
      return /^\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(line);
    },

    // 块是否为标题：单行块 + ATX 标题（与 RE.heading 同一 CommonMark 口径）。
    // 标题块不挂「编辑」按钮（2026-10-19 用户反馈 #1：点标题行即编辑，按钮多余）。
    _wysiwygBlockIsHeading(b) {
      const cm = this.cm;
      if (!cm || !b || b.end - b.start !== 1) return false;
      const line = (b.start < cm.lineCount()) ? cm.getLine(b.start) : '';
      return /^\s{0,3}#{1,6}(\s|$)/.test(line);
    },

    // 块是否为 [TOC]：单行块 + 内容恰为 [TOC]（与 _wysiwygReplaceToc 的 <p> 匹配口径一致，
    // 判为 TOC ⇔ 遮罩会被替换成渲染目录）。TOC 由整篇标题生成、内容本身无编辑意义 →
    // 不挂「编辑」按钮、遮罩内任何点击（含目录链接）无反应，右上改挂「删除」按钮
    //（2026-10-21 用户要求：目录不允许编辑、点击无反应、编辑按钮改删除）。
    _wysiwygBlockIsToc(b) {
      const cm = this.cm;
      if (!cm || !b || b.end - b.start !== 1) return false;
      const line = (b.start < cm.lineCount()) ? cm.getLine(b.start) : '';
      return /^\[TOC\]$/i.test((line || '').trim());
    },

    // 遮罩是否定义列表（2026-10-25 用户要求「定义列表不要编辑按钮」）：渲染结果含
    // <dl>（术语行 + `: 释义` 行块）。同列表/标题/普通文字口径——点行即进编辑
    //（遮罩 mousedown 点击映射本就直达源码行），块级源码入口多余。
    _wysiwygMaskIsDefList(node) {
      return !!(node && node.querySelector('dl'));
    },

    // 遮罩是否「普通文字」段落（2026-07-13 用户要求：普通文字右侧不需要编辑按钮）：
    // 渲染结果恰为单个 <p>（正文段落）且不含图片/公式——点文字经 mousedown 点击映射
    // 直接落光标逐字编辑，与列表/标题同款口径（点行即编辑，块级入口多余）。排除项：
    //  - img：点图片开灯箱（吞掉点击映射），是遮罩上少数点不到源码的块，须保留显式入口；
    //  - .katex 公式：公式非普通文字，保守保留。
    // 表格（.wysiwyg-table-wrap 吞杂点、源码入口=按钮）、围栏（pre）、引用/callout（div）、
    // 隐藏占位（div）等渲染结果不是「单个 <p>」，自然保留按钮。
    // ⚠️ 调用点须在 TOC 判定之后：[TOC] 行在异步替换目录前遮罩就是单个 <p>，先判 TOC。
    _wysiwygMaskIsPlainText(node) {
      if (!node || node.children.length !== 1) return false;
      const first = node.children[0];
      if (!first || first.tagName !== 'P') return false;
      if (node.querySelector('img')) return false;
      if (node.querySelector('.katex')) return false;
      return true;
    },

    // 块右上「编辑」按钮（hover 显示，样式对齐代码块复制按钮，2026-10-11 用户反馈 #4）：
    // 大块内容的显式编辑入口，点击撤遮罩并定位块首行（见 mousedown 接管）。
    // 放在遮罩节点上而非 RenderPost：属所见即所得专属 chrome，阅读模式无「编辑块」概念。
    // 除列表块（2026-10-16 用户反馈 #1）、标题块（2026-10-19 用户反馈 #1）与普通文字段落
    // （2026-07-13 用户要求：点文字即编辑，按钮多余）外统一挂；纯空占位块（引用定义）
    // 也挂，点了直接进该行编辑。
    _addWysiwygEditButton(node) {
      if (!node || node.querySelector('button.block-edit-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'block-edit-btn';
      btn.textContent = this.t ? this.t('editBlock') : '编辑';
      btn.title = btn.textContent;
      node.appendChild(btn);
    },

    // [TOC] 块遮罩的「删除」按钮（2026-10-21 用户要求：目录不允许编辑、点击无反应，
    // 右上「编辑」改为「删除」）：复用编辑按钮的位置/hover 样式，点击删除 [TOC] 源行
    //（见遮罩 mousedown 接管；可 Ctrl+Z 撤销）。
    _addWysiwygTocDeleteButton(node) {
      if (!node || node.querySelector('button.block-edit-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'block-edit-btn';
      btn.setAttribute('data-toc-delete', '1');
      btn.textContent = this.t ? this.t('deleteToc') : '删除';
      btn.title = btn.textContent;
      node.appendChild(btn);
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
        // 行高必须是无单位比率，不能写 getComputedStyle 的 px 已解析值：px 值写进遮罩
        // 子树后是固定值，sub/sup 等小字号元素（0.75em）的行高不再随字号等比缩放，
        // 而阅读模式是无单位 1.7 随字号走——含上下标的行会高几 px（2026-07-13 demo.md
        // 审计实测：H<sub>2</sub>O 行遮罩 37.7 vs 阅读 33.2）。settings.js applySettings
        // 把无单位 String(s.lineHeight) 写在 #preview 内联样式上，优先取作者值；
        // 拿不到（如联调页设置样式晚于建遮罩）再从计算值反推比率，绝不落 px 固定值。
        let lh = (this.preview.style && this.preview.style.lineHeight) || '';
        if (!lh && cs && cs.lineHeight && cs.fontSize) {
          const a = parseFloat(cs.lineHeight), f = parseFloat(cs.fontSize);
          if (f > 0 && a / f > 0.5 && a / f < 4) lh = String(Math.round((a / f) * 1000) / 1000);
        }
        if (lh) node.style.lineHeight = lh;
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
    // ⚠️ renderMarkdown 只产出结构 HTML：后处理走 RenderPost 共享管线（modules/render-post.js）——
    //    与阅读模式 render() 同 stage 同顺序（复选框 → details → emoji → 数学 → 缩写 →
    //    标题锚点 → 复制按钮 → 代码高亮；复制按钮必须在代码高亮之前，按钮才落在 pre 上），
    //    只是容器不同（阅读=整篇 preview，遮罩=单块节点）；异步 stage（图片/mermaid/滚动条）
    //    在 _wysiwygPostProcessAsync 里 DOM 落定后补跑。
    // 缓存的 b.html 同样是未后处理的结构 HTML（后处理只作用于 DOM），所以每次遮罩都要重跑；
    // 各 stage 均幂等（KaTeX 渲染过的节点被 walker 跳过，code-scroll 包裹过的块被跳过）。
    _postProcessWysiwygNode(node) {
      const postOpts = {
        t: (k) => (this.t ? this.t(k) : k),
        isDark: !!this.isDark,
        escapeHtml: (s) => (this.escapeHtml ? this.escapeHtml(s) : String(s == null ? '' : s)),
        escapeAttr: (s) => (this.escapeAttr ? this.escapeAttr(s) : String(s == null ? '' : s)),
        headingToId: (s) => (this.headingToId ? this.headingToId(s) : String(s == null ? '' : s)),
        mermaidCache: this._mermaidCache,
      };
      // 与阅读模式同 stage（RenderPost 共享管线，故障隔离 + 幂等，见其文件头注释）
      RenderPost.enableCheckboxes(node);
      RenderPost.normalizeDetails(node);
      RenderPost.processEmoji(node);
      RenderPost.processMath(node);
      RenderPost.processAbbreviations(node, postOpts);
      RenderPost.processHeadings(node, postOpts);
      RenderPost.addCopyButtons(node, postOpts);
      RenderPost.processCodeBlocks(node, {
        hljs: (typeof window !== 'undefined' ? window.hljs : undefined),
        cache: (this._wysiwygHljsCache = this._wysiwygHljsCache || new Map()),
        // 行号开关与阅读模式同源：看 #preview 的 code-line-numbers 类（同一设置写入）
        lineNumbers: !!(this.preview && this.preview.classList.contains('code-line-numbers')),
      });
    },

    // 异步 pass 调度：maskWysiwygBlock 登记待跑节点后，等「DOM 落定」再统一执行。
    // setTimeout(0) 保证在触发挂遮罩的 CM operation 结束（显示更新已把 widget 插进行 DOM）
    // 之后运行；同一 tick 内多次挂遮罩只排一个计时器。
    _scheduleWysiwygAsyncFlush() {
      if (this._wysiwygAsyncFlushTimer != null) return;
      const self = this;
      this._wysiwygAsyncFlushTimer = setTimeout(() => {
        self._wysiwygAsyncFlushTimer = null;
        self.flushWysiwygAsyncPasses();
      }, 0);
    },

    // 异步 pass 统一冲刷：只处理「节点已入 DOM」的待跑遮罩。未物化的（虚拟模式下
    // 视口±预取窗口外的块，CM 尚未把该行渲染进 DOM）留在待跑集里，由下一次冲刷
    //（滚动触发的 updateWysiwygViewportMasks 收尾）捡回——2026-10-11 探针实测：
    // 视口外行的 widget 连 cm.refresh() 之后都未入 DOM，只有该行真正物化后才 isConnected。
    // 各 pass 均幂等（已加载图片走前缀跳过、已换容器的 mermaid 无 code 可查），重复冲刷廉价。
    flushWysiwygAsyncPasses() {
      const cm = this.cm;
      if (!cm || this.viewMode !== 'wysiwyg') return;
      const pending = this._wysiwygPendingAsync;
      if (!pending || pending.size === 0) return;
      const due = [];
      pending.forEach((node) => { if (node && node.isConnected) due.push(node); });
      for (const node of due) {
        pending.delete(node);
        try { this._wysiwygPostProcessAsync(node); } catch (_) { /* 单块失败不影响他块 */ }
      }
    },

    // 遮罩异步 pass：图片读盘转 base64、Mermaid 渲染、[TOC] 目录、代码块滚动条。
    // 与阅读模式 render() 的异步部分对齐；全部 fire-and-forget，失败静默降级（保持源码/原文）。
    _wysiwygPostProcessAsync(node, idx) {
      const cm = this.cm;
      if (!node || !cm || typeof node.isConnected !== 'boolean' || !node.isConnected) return;
      // 节点级代数：本节点的 pass 只在「本节点标记被撤」时过期（unmask/clear 时 +1）。
      // 旧实现用全局 _wysiwygMaskGen，而 setWysiwygActiveBlock 是「先重挂旧活动块、后撤新
      // 活动块」——撤后全局代数 +1，把刚启动的图片读盘 pass 判成过期（2026-10-11 harness
      // 实测：光标移动后重挂块的图片恒停在占位/原始路径）。
      this._wysiwygNodeGen = this._wysiwygNodeGen || new Map();
      const gen = this._wysiwygNodeGen.get(node) || 1;
      const settled = () => {
        // 本遮罩已重建（代数变化）或节点已摘除：不再动 DOM
        return (this._wysiwygNodeGen.get(node) === gen) && node.isConnected;
      };
      // ⚠️ 存在性守卫必须保留在编排层（2026-10-11 真机卡死回归）：RenderPost 各 stage 对
      // 「无内容可处理」返回已 resolve 的 promise，then 回调仍会执行——若无守卫，每个
      // 纯文本块的三个 pass 都会触发一次 _wysiwygRefreshAfterMaskChange（coordsChar +
      // cm.refresh 全量重测 + scrollTo），大文档几百块 × 3 = 主线程被刷新风暴占满，
      // 「点击所见即所得软件卡住没反应」。只有块里真有对应内容的才启动 pass + 刷新。
      const hasImg = node.querySelector && node.querySelector('img') != null;
      const hasMmd = node.querySelector && node.querySelector('code.language-mermaid') != null;
      const hasToc = node.querySelectorAll
        && Array.from(node.querySelectorAll('p')).some((p) => /^\[TOC\]$/i.test((p.textContent || '').trim()));
      // 图片：相对路径 → 本地读盘 base64（RenderPost 共享 stage；与阅读模式同一纯函数、同一缓存）
      if (hasImg) {
        RenderPost.prepareImages(node, {
          activeTab: this.activeTab,
          imageCache: (this._imageBase64Cache = this._imageBase64Cache || new Map()),
          tauri: (typeof TauriApi !== 'undefined' ? TauriApi : undefined),
          getCachedImageURL: (u) => (this.getCachedImageURL ? this.getCachedImageURL(u) : u),
          getRenderGeneration: () => (this._wysiwygNodeGen ? this._wysiwygNodeGen.get(node) || 0 : 0),
        }).then(() => { if (settled()) this._wysiwygRefreshAfterMaskChange(); })
          .catch((e) => console.warn('[wysiwyg] Images error:', e));
      }
      // Mermaid：RenderPost 共享 stage + 同一 mermaidCache（命中缓存时近乎同步；
      // 串行化/id 唯一化在 processMermaid 内部）
      if (hasMmd) {
        RenderPost.runMermaid(node, {
          t: (k) => (this.t ? this.t(k) : k),
          isDark: !!this.isDark,
          escapeHtml: (s) => (this.escapeHtml ? this.escapeHtml(s) : String(s == null ? '' : s)),
          escapeAttr: (s) => (this.escapeAttr ? this.escapeAttr(s) : String(s == null ? '' : s)),
          headingToId: (s) => (this.headingToId ? this.headingToId(s) : String(s == null ? '' : s)),
          mermaidCache: this._mermaidCache,
        }).then(() => {
          if (settled()) this._wysiwygRefreshAfterMaskChange();
        }).catch((e) => console.warn('[wysiwyg] Mermaid error:', e));
      }
      // [TOC]：阅读模式用 Rust generate_toc 生成整篇目录替换 [TOC] 段，遮罩同款
      //（整篇级 stage，不经 RenderPost，见其文件头注释）
      if (hasToc) {
        // 2026-10-21「输入文字页面乱跳」主修：目录已生成且内容未变时**同步**注入缓存
        // HTML——遮罩重渲染直接以目录全高落 DOM，不再出现「<p>[TOC]</p> 占位（41px）
        // → 异步注入（632px）」的高度阶跃。实测该阶跃正是乱跳源：输入防抖重刷（无
        // pending scroll 的普通操作）在操作末高度复测时按「记录值 631.9 − 占位 41.2」
        // 补偿出 591px 跳顶，后续 refresh 的陈旧滚动重断言 + delta 二次补偿再把页面
        // 甩到过冲位置（harness 实测 3161 → 2570 → 3752）。同步注入无阶跃 → 无跳变。
        const tocCache = this._wysiwygToc;
        if (tocCache && tocCache.html && tocCache.value === cm.getValue()) {
          this._wysiwygApplyTocHtml(node, tocCache.html);
          // flush 在挂遮罩操作之外（setTimeout 0），记录值还停在占位高度 → 必须立刻
          // 刷新复测 + 滚动补偿（cm.refresh 的 pending 重断言已改为取真实滚动，见
          // codemirror.js refresh 注释），否则下一次输入操作末才补出 591px 跳变。
          // ⚠️ 直调 do 版本（不走合帧调度）：本路径要求刷新与注入同一任务内完成
          //（不跳顶修复③ 契约），合帧会让「占位 → 全高」阶跃露出一帧。
          this._wysiwygDoRefreshAfterMaskChange();
        } else {
          this._wysiwygReplaceToc(node).then(() => { if (settled()) this._wysiwygRefreshAfterMaskChange(); });
        }
      }
      // 代码块滚动条：RenderPost 共享 stage（条件唯一来源，与阅读模式同一函数）。
      // 本 pass 由 flush 在 DOM 落定后调用，scrollHeight 读取强制同步回流，高度是准的。
      RenderPost.applyCodeScrollOverflow(node, { codeScroll: this.settings && this.settings.codeScroll });
    },

    // 遮罩内容高度变化（公式/图片/Mermaid/TOC 就绪）后：刷新 CM 测量并补偿滚动，
    // 让视口内容不漂移（与阅读模式「内容长高」的自然观感一致，而不是被推走）。
    // ⚠️ 格编辑进行中禁止 cm.refresh()：refresh → regChange(全区间) → resetView →
    //    patchDisplay 重建全部行 DOM，遮罩 widget（含正在编辑的 contenteditable 格）被
    //    重新 appendChild 移挂——Chromium 对被移动的聚焦元素必触发 blur，格的 blur 处理器
    //    随即登记「下一 tick 提交」→ 正在打的字被回写、cm.focus() 把光标跳到表后
    //    （用户反馈「输入文字时失去焦点、打到一半跳到别处」的真凶：图片/Mermaid/TOC
    //    异步加载恰好在打字途中完成）。改为登记待刷新，格编辑结束后补跑（见
    //    _wysiwygEndCellEdit 末尾 _wysiwygFlushPendingMaskRefresh），几何补偿不丢。
    // 漂移探针：取视口顶附近第一条「已渲染（有 node）且非 hidden」的行，返回其行号与
    // 当前真实窗口 top。行本身的 DOM 盒就是该行在窗口里的真实位置——不依赖 CM 记录行高
    //（记录值可能滞后于真实 DOM，如遮罩占位高度被记录、真实高度已变）。
    // 返回 null = 量不到（调用方按不补偿处理）。
    _wysiwygDomProbe(cm) {
      try {
        const scrollerTop = cm.getScrollerElement().getBoundingClientRect().top;
        const view = cm.display.view;
        for (let i = 0; i < view.length; i++) {
          const lv = view[i];
          if (!lv || lv.hidden || !lv.node || !lv.line) continue;
          const box = lv.node.getBoundingClientRect();
          if (!box || box.bottom < scrollerTop + 4) continue;
          return { lineNo: lv.line.lineNo, top: box.top };
        }
      } catch (_) { /* 量不到就返回 null */ }
      return null;
    },

    // 异步 pass 完成后的刷新入口：**合帧调度**（2026-11-01 性能）。同一帧内多个 pass 完成
    //（图片/mermaid/TOC 批量到齐）只做一次探针+refresh+补偿——旧实现每个 pass 各自全量
    // cm.refresh()（历史刷新风暴：299 块 × no-op promise 曾 65s 占满主线程；存在性守卫
    // 已挡纯文本块，本合帧再挡「真有内容的块批量完成」场景）。格编辑期照旧登记延后。
    _wysiwygRefreshAfterMaskChange() {
      try {
        const cm = this.cm;
        if (!cm) return;
        if (this._wysiwygCellEditing) {
          this._wysiwygPendingRefreshAfterCellEdit = true;
          return;
        }
        if (this._wysiwygRefreshPending) return; // 本帧已排：等那次刷新一并覆盖
        this._wysiwygRefreshPending = true;
        const self = this;
        // ⚠️ wysiwyg.js 禁用 rAF（全局约束，见「块高抖动补偿」测试），合帧用 setTimeout
        this._wysiwygRefreshTimer = setTimeout(() => {
          self._wysiwygRefreshTimer = null;
          self._wysiwygRefreshPending = false;
          if (self.viewMode !== 'wysiwyg') return;
          if (self._wysiwygCellEditing) { self._wysiwygPendingRefreshAfterCellEdit = true; return; }
          self._wysiwygDoRefreshAfterMaskChange();
        }, 16);
      } catch (_) { /* 调度失败退回同步执行 */ this._wysiwygRefreshPending = false; this._wysiwygDoRefreshAfterMaskChange(); }
    },

    // 刷新补偿本体（probe → refresh → 按同一行盒顶漂移补偿）：时序敏感，补偿必须紧贴
    // refresh 前后（见不跳顶修复④），由 _wysiwygRefreshAfterMaskChange 合帧调度调用。
    _wysiwygDoRefreshAfterMaskChange() {
      try {
        const cm = this.cm;
        if (!cm) return;
        const wrapper = cm.getWrapperElement();
        // 2026-10-21「输入文字页面乱跳」补偿基准修复：改用「视口顶探针行的真实 DOM
        // 窗口位置」测 refresh 前后（同一行的盒漂移 = 视口内容的真实漂移），弃用旧
        // coordsChar/charCoords「记录行高」基准。旧基准在记录值滞后真实 DOM 时双重计入：
        // 遮罩占位高度（41px）被记录、真实目录高度（631.9px）已落 DOM，浏览器原生滚动
        // 锚定又已按真实变化移动过实际滚动 → charCoords 把「高度差 + 锚定位移」混进同一
        // delta（实测 591px 过冲，最终位置偏一个目录高）；DOM 盒量的是行本身真实窗口
        // 位置，按其漂移补偿精确、不重计。
        const probe = this._wysiwygDomProbe(cm);
        cm.refresh();
        if (probe) {
          const info = cm.lineInfo(probe.lineNo);
          if (info && info.node) {
            const after = info.node.getBoundingClientRect();
            const delta = after && isFinite(after.top) ? after.top - probe.top : null;
            if (delta != null && delta && Math.abs(delta) < (wrapper.clientHeight || 1e9)) {
              const sc = cm.getScrollInfo();
              cm.scrollTo(sc.left, sc.top + delta);
            }
          }
        }
      } catch (_) { /* 刷新失败无妨，下次输入会重建遮罩 */ }
    },

    // [TOC] 段替换：与阅读模式 render() 的替换规则对齐——阅读模式是对整篇 HTML 用正则
    // 匹配**所有**「内容恰为 [TOC]」的 <p> 并逐个换成 toc-wrapper + Rust 目录 HTML；
    // 旧实现只取节点内第一个 <p>，当块内另有段落排在 [TOC] 段前时永远匹配不上
    // （2026-10-11 用户反馈「目录没加载出来」的成因之一）。
    // TOC 依赖整篇内容，按内容缓存 promise，遮罩频繁重建不重复 invoke；
    // invoke 失败时清缓存可重试（真实 app 中 Rust 侧同步返回字符串，不会 reject，此为防御）。
    _wysiwygReplaceToc(node) {
      if (!node || !node.querySelectorAll) return Promise.resolve();
      const ps = Array.from(node.querySelectorAll('p'))
        .filter((p) => /^\[TOC\]$/i.test((p.textContent || '').trim()));
      if (ps.length === 0) return Promise.resolve();
      if (typeof TauriApi === 'undefined' || typeof TauriApi.generateToc !== 'function') return Promise.resolve();
      const cm = this.cm;
      if (!cm) return Promise.resolve();
      const content = cm.getValue();
      if (!this._wysiwygToc || this._wysiwygToc.value !== content) {
        this._wysiwygToc = { value: content, promise: TauriApi.generateToc({ content }) };
      }
      return this._wysiwygToc.promise.then((tocHtml) => {
        if (!tocHtml) return;
        // 记住已解析的目录 HTML：后续遮罩重渲染且内容未变时同步注入（见
        // _wysiwygPostProcessAsync 的 hasToc 分支），消除占位→异步的高度阶跃
        // （2026-10-21「输入文字页面乱跳」主修）。
        const cache = this._wysiwygToc;
        if (cache && cache.value === content) cache.html = tocHtml;
        this._wysiwygApplyTocHtml(node, tocHtml);
      }).catch((e) => {
        this._wysiwygToc = null; // 失败不缓存：下次挂遮罩按新内容重试，保持 [TOC] 原文
        console.warn('[wysiwyg] TOC error:', e);
      });
    },

    // 把已生成的目录 HTML 注入遮罩节点内**所有**内容恰为 [TOC] 的 <p>
    //（与阅读模式「逐个替换所有 [TOC] 段」的口径一致）。同步 DOM 操作，
    // 调用方保证 tocHtml 非空；节点已摘除时静默跳过。
    _wysiwygApplyTocHtml(node, tocHtml) {
      if (!node || !node.querySelectorAll || !tocHtml) return;
      const ps = Array.from(node.querySelectorAll('p'))
        .filter((p) => /^\[TOC\]$/i.test((p.textContent || '').trim()));
      for (const p of ps) {
        if (!p.isConnected) continue;
        const line = p.getAttribute('data-source-line');
        const wrap = document.createElement('div');
        wrap.className = 'toc-wrapper';
        if (line) wrap.setAttribute('data-source-line', line);
        wrap.innerHTML = tocHtml;
        p.replaceWith(wrap);
      }
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
      // 目标标题在遮罩块内：先解罩该块（恢复源码态）。否则 CM5 把光标 clamp 到遮罩
      // 边缘、滚动落在整块遮罩上——表现为「所见即所得下点目录跳不到对应内容」
      //（2026-10-12 真机反馈；与面包屑跳转同一成因）。
      try {
        const aIdx = this.wysiwygBlockIndexAt(line);
        if (aIdx >= 0 && this._wysiwygMarks && this._wysiwygMarks.has(aIdx)) this.setWysiwygActiveBlock(aIdx);
      } catch (_) { /* 解罩失败不阻塞跳转 */ }
      try {
        cm.operation(() => {
          cm.setSelection({ line, ch: 0 }, { line, ch: cm.getLine(line).length }, { scroll: false });
          cm.focus();
        });
        // 目标行滚到视口中部（与阅读模式锚点跳转观感一致），再闪显
        this._wysiwygScrollLineToCenter(line);
        if (target && target.isConnected) {
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
      // 本块内有格正在源码编辑：先提交，撤遮罩不得静默丢掉正在编辑的内容
      if (this._wysiwygCellEditing && this._wysiwygCellEditing.blockIdx === idx) this._wysiwygEndCellEdit(true);
      const mark = this._wysiwygMarks.get(idx);
      if (!mark) return;
      try { mark.clear(); } catch (_) { /* 已销毁 */ }
      this._wysiwygMarks.delete(idx);
      // 遮罩已换：让旧节点上未完成的异步 pass（图片/Mermaid/TOC）感知过期，停写 DOM
      this._dropWysiwygMaskNode(mark.replacedWith);
    },

    // 作废单个遮罩节点：节点代数 +1（在飞 pass 的代际检查判过期停写）+ 移出待跑冲刷集。
    // 只影响本节点——绝不牵连其他块（全局代数曾让「撤 A 块」作废「刚挂的 B 块」的 pass）。
    _dropWysiwygMaskNode(node) {
      if (!node) return;
      if (this._wysiwygNodeGen) this._wysiwygNodeGen.set(node, (this._wysiwygNodeGen.get(node) || 0) + 1);
      if (this._wysiwygPendingAsync) this._wysiwygPendingAsync.delete(node);
    },

    // 渲染态点击任务复选框：按 data-source-line 精确回写源码行并翻转 [ ]/[x]。
    // ⚠️ data-source-line 是渲染管线写入的「渲染输入（即块切片）内 1-based 行号」，
    // 不是整篇文档行号——必须加上所在块的起始行才是真实源码行（整篇渲染时块起点为 0，二者恰好一致，
    // 阅读模式的勾选框同步因此不受影响；逐块渲染时漏加偏移会勾错行）。
    // 任务行勾选回写（渲染态/编辑态共用口径，2026-10-18 收口——此前渲染态回写正则在
    // toggleWysiwygTaskCheckbox 内单份，编辑态点击接入时不得复制第二份）：切换 lineNo 行
    // 「[ ]」/「[x]」中字符。返回切换后该行正文起始列（= 前缀长 + 分隔空格，供编辑态落
    // 光标）；非任务行返回 null（调用方据此放行默认行为）。
    _wysiwygToggleTaskLine(lineNo) {
      const cm = this.cm;
      if (!cm || !isFinite(lineNo) || lineNo < 0 || lineNo >= cm.lineCount()) return null;
      const line = cm.getLine(lineNo);
      // 2026-10-25 扩引用前缀：引用/提示块内的任务行（`> - [x] 正文`）也挂了
      // wysiwyg-task-prefix 槽（_wysiwygApplyActiveDecor 引用分支），wrapper capture 的
      // 勾选点击会落到这里——原正则只认行首任务标记，引用行返回 null → 点击放行、
      // 勾选无效。`(?:>[ \t]?)*` 吃逐层 `> `（缩进层与 2026-10-28 quoteMarkerZoneEnd
      // 的逐层口径一致），其后才是列表标记。
      const m = line.match(/^(\s*(?:>[ \t]?)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])/);
      if (!m) return null;
      cm.replaceRange(m[2] === ' ' ? 'x' : ' ',
        { line: lineNo, ch: m[1].length }, { line: lineNo, ch: m[1].length + 1 }, '+wysiwygTask');
      let ch = m[0].length;
      if (line.charAt(ch) === ' ') ch += 1;   // 正文起点越过 GFM 分隔空格（与装饰零宽槽边界一致）
      return ch;
    },

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
      if (this._wysiwygToggleTaskLine(n) == null) return;
      // 立即重渲染该块，不等 250ms 防抖（replaceRange 已同步触发 change → refreshWysiwygBlocks 重算块表）
      const blockIdx = this.wysiwygBlockIndexAt(n);
      const b = this._wysiwygBlocks && this._wysiwygBlocks[blockIdx];
      if (b) {
        b.html = this.renderWysiwygBlockHtml(b.start, b.end);
        b.src = this._wysiwygBlockSource(b); // 源文本键同步，全量增量刷新才判得出变化
        b.finalHtml = false; // 结构 HTML（非最终缓存），重挂时须重跑同步后处理并回写缓存
        this.maskWysiwygBlock(blockIdx);
      }
    },

    // ---------------- 表格单元格就地源码编辑（Phase 2 / R5，2026-10-13） ----------------
    // 单元格 contenteditable 显示**该格原始源码**（无损：用户直接编辑源文本，** / \| 等可见可改；
    // 渲染态真内联编辑属 Phase 3 暂缓项）。Enter/失焦/Tab = 提交（纯函数重建整行回写源码行 +
    // 立即重渲本块遮罩）；Esc = 取消（恢复渲染内容，不回写）。同一时刻至多一个格在编辑。
    // ⚠️ 提交会重建遮罩（旧 DOM 节点离场）：所有「提交后还要找格」的路径（Tab 切格 / 点另一格）
    //    必须按 (rowIdx, colIdx) 在新遮罩节点上重新定位，不得持有旧节点引用。
    // clickPoint = {x, y}（viewport 坐标）：点击路径传入用于「光标落到点击处」；
    // Tab/增行增列路径不传 → 光标落到格内文末。
    _wysiwygStartCellEdit(cellEl, rowIdx, colIdx, clickPoint) {
      const cm = this.cm;
      if (!cm || !cellEl) return;
      // 已有格在编辑（点另一格 / Tab 切格）：先提交（settle=false：不挪光标/不补行/不抢焦点，
      // 新格焦点直接接管）；提交若重建了遮罩，本格的旧 DOM 已离场，按 (rowIdx, colIdx) 重新定位
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
      let cell = cellEl;
      if (!cell.isConnected && isFinite(rowIdx) && isFinite(colIdx) && rowIdx >= 0) {
        const mk = this._wysiwygMarks && this._wysiwygMarks.get(this._wysiwygLastCellEditBlockIdx);
        const node = mk && mk.replacedWith;
        const trs = node ? Array.from(node.querySelectorAll('tr')) : [];
        const tr = trs[rowIdx];
        cell = tr ? tr.children[colIdx] : null;
        if (!cell) return;
      }
      this._wysiwygStartCellEditOn(cell, clickPoint);
    },

    // 按 (rowIdx, colIdx) 在遮罩节点上定位目标格并进入编辑（Tab 导航用：提交后遮罩可能已重建）。
    // blockIdx 缺省 = 上次格编辑的块（Tab 场景）；增行/增列回写后块索引可能位移，须显式传新索引。
    _wysiwygStartCellEditAt(rowIdx, colIdx, blockIdx) {
      // 已有格在编辑（Tab/Enter 切格）：先提交（settle=false：见 _wysiwygEndCellEdit 注释）——
      // 状态被新格覆盖后旧格的 blur 守卫（st.cell !== cell）变 no-op，不在此提交则旧格
      // 已输入的内容丢失（2026-10-14 修复）。
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
      const bi = isFinite(blockIdx) ? blockIdx : this._wysiwygLastCellEditBlockIdx;
      const mk = this._wysiwygMarks && this._wysiwygMarks.get(bi);
      const node = mk && mk.replacedWith;
      if (!node) return;
      const trs = Array.from(node.querySelectorAll('tr'));
      const tr = trs[rowIdx];
      const cell = tr ? tr.children[colIdx] : null;
      if (cell) this._wysiwygStartCellEditOn(cell);
    },

    _wysiwygStartCellEditOn(cell, clickPoint) {
      const cm = this.cm;
      if (!cm || !cell) return;
      const maskNode = cell.closest ? cell.closest('.' + MASK_CLASS) : null;
      const idx = maskNode ? parseInt(maskNode.getAttribute('data-block-index'), 10) : NaN;
      const block = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;
      if (!block) return;
      const tableEl = cell.closest('table');
      const tr = cell.closest('tr');
      if (!tableEl || !tr) return;
      const trs = Array.from(tableEl.querySelectorAll('tr'));
      const rIdx = trs.indexOf(tr);
      if (rIdx < 0) return;
      // 行映射：tr 0 = 表头行（= 块首行），其后 tbody 行越过分隔行顺延（与原点击定位同规则）
      const line = block.start + rIdx + (rIdx > 0 ? 1 : 0);
      if (line < 0 || line >= cm.lineCount()) return;
      const col = Array.from(tr.children).indexOf(cell);
      const info = splitTableRow(cm.getLine(line));
      if (col < 0 || col >= info.cells.length) return; // 渲染格数与源码格数不符（畸形表）：不启动
      const self = this;
      this._wysiwygCellEditing = {
        cell: cell, tableEl: tableEl, tr: tr, rowIdx: rIdx, blockIdx: idx,
        line: line, colIdx: col, origSource: info.cells[col], origHtml: cell.innerHTML,
        composing: false,
        lastCompositionEnd: 0,
      };
      // 格编辑已立 → 重遮罩旧活动块（2026-10-14 用户截图「点表格后下面一行还是源码态」）：
      // 遮罩 mousedown 接管后 CM 光标/cursorActivity 不再变化，点格前处于源码态的块
      // （如表格下方的标题）无人失焦重渲，只能在此显式补上。必须在状态立起之后调用
      // （见 _wysiwygReMaskActiveForCellEdit 注释里的 reCheckSelection 钳制连锁）。
      this._wysiwygReMaskActiveForCellEdit(idx);
      cell.classList.add('wysiwyg-cell-editing');
      cell.setAttribute('contenteditable', 'true');
      cell.textContent = info.cells[col]; // 显示原始源码文本（无损）
      // Enter=提交 / Tab·Shift+Tab=行内切格（环绕）/ Esc=取消；失焦=提交；IME 组合期延迟提交
      cell.addEventListener('keydown', (e) => {
        const st = self._wysiwygCellEditing;
        if (!st || st.cell !== cell) return;
        // IME 组合期（中文/日文输入）：此时的 Enter/数字键是「确认拼音/选字」，
        // 不是提交格子。必须整体放行给 IME，否则 preventDefault+blur 会让焦点丢失、
        // 只能输入一个字（2026-10-13 用户反馈「一输入文字光标就失去焦点」）。
        // e.isComposing 覆盖确认键；st.composing（compositionstart/end 维护）兜底
        // 个别浏览器确认键 isComposing 为假但组合未结束的情况。
        if (e.isComposing || st.composing) return;
        // WebView2/Chromium 中文 IME 时序怪癖：compositionend 可能先于「选字确认的
        // Enter」keydown 到达（此刻 isComposing=false、st.composing 已清）——该 Enter
        // 是 IME 确认键的残影，不是用户想提交。若当提交处理：格子被回写重渲染、
        // 焦点跳出格（用户 2026-10-13 反馈「输入完马上失去光标，像被回写了一样」）。
        // 组合刚结束 250ms 内的 Enter 一律只吞掉（preventDefault 防止往格内插换行），
        // 不提交；用户真正的提交 Enter 在更晚按下，正常生效。
        if (e.key === 'Enter' && st.lastCompositionEnd && Date.now() - st.lastCompositionEnd < 250) {
          e.preventDefault();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          // Enter = 移到下一格（2026-10-14 用户要求）：提交本格后进入同行右邻格；
          // 无右邻 → 进入下一行首格；无下一行（末行）= 提交并把焦点还给编辑器
          // （光标落表后行，见 _wysiwygCellEditEndLine）。切格走 _wysiwygStartCellEditAt：
          // 先提交本格（遮罩重建后在新遮罩上按坐标重新定位目标格）。
          const n = st.tr.children.length;
          let nr = st.rowIdx, nc = st.colIdx + 1;
          if (nc >= n) { nr = st.rowIdx + 1; nc = 0; }
          const trsNow = Array.from(st.tableEl.querySelectorAll('tr'));
          if (nr < trsNow.length) {
            self._wysiwygStartCellEditAt(nr, nc);
          } else {
            cell.blur(); // 末行：提交并回编辑器（原行为）
          }
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const n = st.tr.children.length;
          const ni = (st.colIdx + (e.shiftKey ? -1 : 1) + n) % n;
          self._wysiwygStartCellEditAt(st.rowIdx, ni);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          self._wysiwygEndCellEdit(false);
        }
      });
      cell.addEventListener('blur', () => {
        const st = self._wysiwygCellEditing;
        if (!st || st.cell !== cell) return;
        // 提交一律延迟到下一 tick，不得在 blur 里同步 replaceRange + 重挂遮罩：
        // ① blur 常由 CM 自己的 mousedown 同步触发（点源码区 → setSelection 在 CM operation
        //    内），此刻同步重建行 DOM 会毁掉 CM 操作还要移动的节点 → NotFoundError
        //    （appendChild: node no longer a child, "Perhaps it was moved in a blur event
        //    handler"，codemirror.js:1928，2026-10-13 用户报「改单元格内容时出现报错」）；
        // ② IME 组合中（拼音未上屏）浏览器失焦即丢弃组合，立即读文本会读到半截。
        // 计时器触发时若状态已被其他路径先清（点另一格同步提交 / 遮罩清理守卫），则为 no-op。
        setTimeout(() => {
          const st2 = self._wysiwygCellEditing;
          if (!st2 || st2.cell !== cell) return;
          // blur 后焦点又被搬回本格（CM patchDisplay 的 restoreSelection / 焦点保持机制）：
          // 视为从未真正失焦，继续编辑不提交（防「打字到一半被误提交、光标跳走」）
          try { if (document.activeElement === cell) return; } catch (_) { }
          self._wysiwygEndCellEdit(true);
        }, 0);
      });
      cell.addEventListener('compositionstart', () => {
        const st = self._wysiwygCellEditing;
        if (st && st.cell === cell) st.composing = true;
      });
      cell.addEventListener('compositionend', () => {
        const st = self._wysiwygCellEditing;
        // 记录组合结束时刻：紧随其后的 isComposing=false 的 Enter 是 IME 确认键残影
        // （WebView2 时序怪癖），keydown 里按 250ms 窗口识别（见上）。
        if (st && st.cell === cell) { st.composing = false; st.lastCompositionEnd = Date.now(); }
      });
      cell.focus();
      // 光标落位（2026-10-13 用户反馈「点格应光标进格，而非选中整格文字」）：
      // 点击路径 → 落到点击处（原生 caretRangeFromPoint，可把光标定位到格内任意位置）；
      // Tab/增行增列路径（无点击坐标）→ 落到格内文末。不再 selectNodeContents 全选——
      // 全选会让首次击键整格替换，与 mousedown 的 preventDefault 叠加在 WebView2 上易丢焦点。
      try {
        const sel = window.getSelection();
        let placed = false;
        if (clickPoint && typeof document.caretRangeFromPoint === 'function') {
          const r = document.caretRangeFromPoint(clickPoint.x, clickPoint.y);
          if (r && cell.contains(r.startContainer)) {
            sel.removeAllRanges();
            sel.addRange(r);
            placed = true;
          }
        }
        if (!placed) {
          const r = document.createRange();
          r.selectNodeContents(cell);
          r.collapse(false); // 折叠到文末 → 光标在格内末尾
          sel.removeAllRanges();
          sel.addRange(r);
        }
      } catch (_) { /* 选区失败忽略，仍给焦点 */ }
    },

    // 格编辑结束后光标的落位行 = 块后首行。
    // ⚠️ 块是文档最后块时（b.end == lineCount）clamp 会把光标落到块**最后一行**——仍在
    //    replacedWith 区间内 → 块被判定活动块撤遮罩，表格变源码态（2026-10-14 用户报：
    //    「表格下面的一行一旦输入内容，表格就会变成源码格式」：提交后光标就在表上）。
    //    先在块后补一个空行（新行索引 = 原 b.end）再落光标：空行不属于任何块，
    //    其上的输入形成新段落块，表格保持渲染态。
    _wysiwygCellEditEndLine(b) {
      const cm = this.cm;
      if (!cm) return -1;
      const base = b ? b.end : cm.lineCount() - 1;
      if (b && base >= cm.lineCount()) {
        try {
          const last = cm.lineCount() - 1;
          const ch = cm.getLine(last).length;
          cm.replaceRange('\n', { line: last, ch }, { line: last, ch }, '+wysiwygTableCell');
          return base; // 新空行索引 = 原 b.end
        } catch (_) { /* 失败保持原 clamp */ }
      }
      return Math.min(base, cm.lineCount() - 1);
    },

    // 结束单元格编辑。commit=true 提交回写（Enter/失焦/切格/遮罩清理路径）；false 取消恢复。
    // settle=false = 表格内切格（Tab/Enter/点另一格/增行增列）：提交（或取消）本身照做
    // （回写 + 重挂遮罩），但**不**把光标挪到块后行、不补空行、不抢焦点——光标/焦点由
    // 目标格的 _wysiwygStartCellEditOn 直接接管。切格时挪光标会触发活动块判定（表格先
    // 撤罩再重挂一轮），表格是文档最后块时补空行还会造成用户没请求过的文档变更。
    // ⚠️ 首行即清状态：本方法内 replaceRange → cursorActivity → setWysiwygActiveBlock →
    //    unmask/maskWysiwygBlock 会重入 unmaskWysiwygBlock 的单元格守卫，状态先清则重入为 no-op。
    // 格编辑启动时把旧活动块（源码态）重新遮罩（2026-10-14 用户反馈：点表格格后，
    // 点格前正在编辑的块——如表格下方的标题——仍保持源码态+高亮，没「失去焦点」）。
    // ⚠️ 必须在 _wysiwygCellEditing 立起之后调用：markText(replacedWith) 是 atomic
    // 标记，落在被遮区间内的 CM 光标会被 reCheckSelection 钳到块末行（仍在块内）并
    // 触发 cursorActivity → syncWysiwygActiveBlock 会把刚遮的块重新判活动解罩（活动块
    // 是表格块时更会触发解罩守卫连带自动提交格编辑）；sync 里的格编辑守卫拦下连锁。
    _wysiwygReMaskActiveForCellEdit(tableIdx) {
      const cm = this.cm;
      const prev = this._wysiwygActiveIdx;
      if (!cm || prev == null || prev < 0 || prev === tableIdx) return;
      const b = this._wysiwygBlocks && this._wysiwygBlocks[prev];
      if (!b) {
        this._wysiwygActiveIdx = -1;
        this._applyWysiwygActiveHighlight();
        return;
      }
      // 旧块可能刚被编辑过：缓存 html 过期，重渲（与 setWysiwygActiveBlock 的 prev 处理一致）
      if (b.html !== undefined) { b.html = this.renderWysiwygBlockHtml(b.start, b.end); b.finalHtml = false; b.src = this._wysiwygBlockSource(b); }
      // 活动引用块的分段遮罩先清（与整块遮罩区间重叠，2026-10-25 引用分段口径）
      this._wysiwygClearQuoteSegments();
      this._wysiwygActiveIdx = -1;
      this.maskWysiwygBlock(prev);
      this._applyWysiwygActiveHighlight();
    },

    _wysiwygEndCellEdit(commit, settle) {
      if (settle === undefined) settle = true;
      const st = this._wysiwygCellEditing;
      if (!st) return;
      this._wysiwygCellEditing = null;
      this._wysiwygLastCellEditBlockIdx = st.blockIdx;
      const cm = this.cm;
      let text = '';
      try { text = (st.cell.textContent || '').trim(); } catch (_) { st.cell = null; }
      let changed = !!(commit && cm && text !== st.origSource);
      if (changed) {
        try { changed = editTableRowCell(cm.getLine(st.line), st.colIdx, text) !== cm.getLine(st.line); }
        catch (_) { changed = false; }
      }
      if (!changed) {
        // 取消 / 无变化：恢复渲染内容（遮罩若已重建，节点已离场，忽略即可）
        try {
          if (st.cell && st.cell.isConnected) {
            st.cell.classList.remove('wysiwyg-cell-editing');
            st.cell.removeAttribute('contenteditable');
            st.cell.innerHTML = st.origHtml;
          }
        } catch (_) { /* 忽略 */ }
        // Esc 取消后焦点同样不得掉在 body 上（见 _wysiwygRestoreEditorFocus）
        // 切格（settle=false）跳过：光标/焦点由新格接管，不补空行
        if (settle) {
          const bC = this._wysiwygBlocks && this._wysiwygBlocks[this.wysiwygBlockIndexAt(st.line)];
          const endLineC = cm ? this._wysiwygCellEditEndLine(bC) : st.line;
          this._wysiwygRestoreEditorFocus(endLineC);
        }
        // 挂起的遮罩刷新同样在取消路径补跑（见提交路径末尾注释）
        if (this._wysiwygPendingRefreshAfterCellEdit) {
          this._wysiwygPendingRefreshAfterCellEdit = false;
          this._wysiwygRefreshAfterMaskChange();
        }
        return;
      }
      // 提交：重建整行回写源码行（保留首尾竖线风格，格内裸 | 自动转义）
      try {
        const cur = cm.getLine(st.line);
        cm.replaceRange(editTableRowCell(cur, st.colIdx, text),
          { line: st.line, ch: 0 }, { line: st.line, ch: cur.length }, '+wysiwygTableCell');
      } catch (_) { return; }
      // 立即重渲染该块遮罩（与勾选框同模式，不等 250ms 防抖）
      const blockIdx = this.wysiwygBlockIndexAt(st.line);
      const b = this._wysiwygBlocks && this._wysiwygBlocks[blockIdx];
      if (b) {
        b.html = this.renderWysiwygBlockHtml(b.start, b.end);
        b.src = this._wysiwygBlockSource(b); // 源文本键同步：否则全量增量刷新误判「源未变」
        b.finalHtml = false; // 结构 HTML（非最终缓存），重挂时须重跑同步后处理并回写缓存
        this.maskWysiwygBlock(blockIdx);
      }
      // 切格（settle=false）到此为止：回写 + 重挂遮罩已完成，光标/焦点由新格接管。
      if (settle) {
        // 光标移到块后首行：光标不得留在 replacedWith 区间内（CM 会钳制到标记边缘，
        // 下次击键会写进块边缘），落在表后空行 = 非活动块，高亮自然收回；
        // 块是文档最后块时先补空行（见 _wysiwygCellEditEndLine）
        const endLine = this._wysiwygCellEditEndLine(b);
        try {
          cm.setSelection({ line: endLine, ch: 0 }, { line: endLine, ch: 0 },
            { scroll: false, origin: '+wysiwygTableCell' });
          // 同步补焦点：提交路径（Enter/失焦）格 blur 后焦点会掉 body——只挪选区不补
          // 焦点，用户看到的即「输入完光标没了」（2026-10-13 反馈 B2 残留）。本提交代码
          // 始终运行在独立 tick（blur 延迟 / 点击路径在 CM mousedown 之前），可直接
          // cm.focus()，光标立即落在块后行可见；若随后用户点了别处，新焦点自然接管。
          try { cm.focus(); } catch (_) { /* 忽略 */ }
        } catch (_) { /* 忽略 */ }
        // 下一 tick 兜底：同步路径未接住（如焦点被中间事件带走）时按 activeElement
        // 判定恢复；焦点已被新格/CM 输入域接走则自动跳过。
        this._wysiwygRestoreEditorFocus(endLine);
      }
      // 格编辑期间被挂起的遮罩刷新（图片/Mermaid/TOC 异步 pass 恰在打字中完成）：
      // 此刻补跑 cm.refresh()，几何补偿不丢。挂起标志在状态清空后置 false 再调用，
      // 避免重入时又判「编辑中」再挂起。
      if (this._wysiwygPendingRefreshAfterCellEdit) {
        this._wysiwygPendingRefreshAfterCellEdit = false;
        this._wysiwygRefreshAfterMaskChange();
      }
    },

    // 格编辑结束后把焦点还给编辑器（下一 tick 判定）。
    // 延迟 + 条件判定是为了不干扰其他路径已接走的焦点：
    //   · Enter 提交 / Esc 取消 → blur 后焦点掉 body → 命中，光标回落到块后行并聚焦 CM；
    //   · 点另一格 / 点源码行 / 点块编辑按钮 → 下一 tick 焦点已在新格或 CM 输入域 → 跳过。
    // 拖拽进行中不抢焦点（行/列移动后 st.line 可能已位移，避免光标落到错行）。
    _wysiwygRestoreEditorFocus(endLine) {
      const cm = this.cm;
      if (!cm) return;
      setTimeout(() => {
        if (this._wysiwygTableDrag) return;
        let ae = null;
        try { ae = document.activeElement; } catch (_) { return; }
        if (ae && ae !== document.body) return;
        try {
          const l = Math.min(endLine, cm.lineCount() - 1);
          cm.setSelection({ line: l, ch: 0 }, { line: l, ch: 0 },
            { scroll: false, origin: '+wysiwygTableCell' });
          cm.focus();
        } catch (_) { /* 忽略 */ }
      }, 0);
    },

    // ---------------- 表格行/列操作（2026-10-13 用户要求，Typora 式） ----------------
    // hover 表 → 右缘「＋」增列、下缘「＋」增行；表左缘/顶部出拖拽把手换位行列
    // （2026-10-20 用户要求：表头格不可发起拖拽，只有顶部/左侧把手可拖）。
    // 结构变更（行数可能变）整块回写：纯函数重建 → 整块 replaceRange → 立即重算块表
    // + 重挂变化块（_wysiwygCommitTableBlock，不能走单元格单行提交路径）。表格 DOM 被
    // 包进 wysiwyg-table-wrap 锚（div/button 不在 S1 结构标签集，同构判据不受影响；
    // wrap 内不含 tr，单元格编辑的 tr 下标不受影响）。
    _addWysiwygTableTools(node) {
      const self = this; // 闭包（mousemove 拖拽让位等）里读编辑器状态
      const tableEl = node && node.querySelector ? node.querySelector('table') : null;
      if (!tableEl || tableEl.parentElement !== node) return;
      const wrap = document.createElement('div');
      wrap.className = 'wysiwyg-table-wrap';
      node.insertBefore(wrap, tableEl);
      wrap.appendChild(tableEl);
      const mkBtn = (cls, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = '+';
        b.title = title;
        wrap.appendChild(b);
        return b;
      };
      const colBtn = mkBtn('wysiwyg-table-add-col', '添加列');
      const rowBtn = mkBtn('wysiwyg-table-add-row', '添加行');
      // 行/列拖拽「轨道 + 握点」（2026-10-13 用户参考图 2/3/6，边缘邻近触发）：
      // 必须是 wrap 上的真实元素（不能是 td/th 伪元素——table 盒只有网格宽且是滚动容器，
      // 伸到表盒外会被裁剪：不可见/不可命中，2026-10-13 实测 elementFromPoint=PRE）。
      // 轨道 = 整段 gutter 命中区，常驻（透明）：行轨 = 表左缘外 26px × 表全高；列轨 =
      // 表上方 12px（= wrap 上留白）× 表全宽。常驻是关键：gutter 在 wrap 盒外，鼠标到
      // gutter 时目标元素
      // 必须是 wrap 的 DOM 后代，wrap 的 mousemove/pointerdown 才会触发（冒泡按 DOM 树，
      // 不看几何包含）——若轨道随悬停才显示，gutter 里收不到事件，「移到行左边一点」
      // 永远不会亮出把手。握点 = 可见小把手（灰色点阵），JS 定位到悬停行中线 / 列中心。
      // 视觉态：悬停 = 灰点阵（无底色、无行/列高亮）；拖动（超 4px 阈值）= 握点变蓝底
      // 胶囊（轨道挂 wysiwyg-dragging）+ 被拖行/列浅蓝高亮。
      const GRIP = '\u22EE\u22EE'; // ⋮⋮ 点阵
      const rowTrackEl = document.createElement('span');
      rowTrackEl.className = 'wysiwyg-table-row-handle';
      wrap.appendChild(rowTrackEl);
      const rowGripEl = document.createElement('span');
      rowGripEl.className = 'wysiwyg-table-row-grip';
      rowGripEl.textContent = GRIP;
      rowTrackEl.appendChild(rowGripEl);
      const colTrackEl = document.createElement('span');
      colTrackEl.className = 'wysiwyg-table-col-pill';
      wrap.appendChild(colTrackEl);
      const colGripEl = document.createElement('span');
      colGripEl.className = 'wysiwyg-table-col-grip';
      colGripEl.textContent = GRIP;
      colTrackEl.appendChild(colGripEl);
      // 落点指示线（2026-10-13 反馈 #1/#2：淡蓝背景 = 被拖行/列、蓝色线 = 要拖动到的
      // 位置）：行拖 = 横线（表通宽）、列拖 = 竖线（表通高）。只在拖动态显示，JS 定位
      // 到插入目标前的分界处（末尾 = 表格底缘/右缘）。pointer-events:none 不拦命中。
      const dropLineEl = document.createElement('div');
      dropLineEl.className = 'wysiwyg-table-drop-line';
      wrap.appendChild(dropLineEl);
      // hover 状态 JS 托管（2026-10-13 用户反馈 #3「增行/增列点不到，鼠标一移就消失」）：
      // 按钮定位在表格右/下缘之外（left:100%/top:100% + 6px），而 CM 相邻行同为 z-index:2、
      // 段落后于表格行 → 下方块内容压在按钮上层，CSS :hover 既会因空隙丢失、点击也被
      // 段落 DOM 截获。改由 JS 维护「工具悬停」类：离开 wrap 后延迟 200ms 才隐藏（给鼠标
      // 跨隙到按钮的时间），期间进入按钮则取消隐藏；同时给表格行加类抬 z-index 至 3，
      // 让按钮/悬停桥压到下方块内容之上（行 DOM 可能被 CM 重建，故每次现查）。
      let hideTimer = null;
      const showTools = () => {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        wrap.classList.add('wysiwyg-table-tools-hover');
        const line = wrap.closest ? wrap.closest('.CodeMirror-line') : null;
        if (line) line.classList.add('wysiwyg-table-line-hover');
      };
      const doHideTools = () => {
        wrap.classList.remove('wysiwyg-table-tools-hover');
        const line = wrap.closest ? wrap.closest('.CodeMirror-line') : null;
        if (line) line.classList.remove('wysiwyg-table-line-hover');
      };
      const scheduleHideTools = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          hideTimer = null;
          if (wrap.matches(':hover')) return; // 仍在 wrap/桥上 → 不藏
          doHideTools();
        }, 200);
      };
      wrap.addEventListener('mouseenter', showTools);
      wrap.addEventListener('mouseleave', scheduleHideTools);
      Array.from(wrap.querySelectorAll('button')).forEach((b) => {
        b.addEventListener('mouseenter', showTools);
        b.addEventListener('mouseleave', scheduleHideTools);
      });
      // 2026-10-13 反馈 #4/#5：增行/增列改为「边缘条带」（右缘竖条 / 下缘横条，见 CSS），
      // 显示条件 = 鼠标移到表格右边/下边一点——条带自身即悬停区（透明时也恒可命中），
      // 鼠标在表格本体上不再显示按钮。200ms 宽限（条带隐藏宽限，防指针快速划过时闪烁）。
      const armStripHover = (stripEl, cls) => {
        let timer = null;
        const show = () => {
          if (timer) { clearTimeout(timer); timer = null; }
          wrap.classList.add(cls);
        };
        const armHide = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { timer = null; wrap.classList.remove(cls); }, 200);
        };
        stripEl.addEventListener('mouseenter', show);
        stripEl.addEventListener('mouseleave', armHide);
      };
      armStripHover(colBtn, 'wysiwyg-table-add-col-hover');
      armStripHover(rowBtn, 'wysiwyg-table-add-row-hover');
      // 边缘邻近悬停（2026-10-13 用户参考图 2/3）：鼠标移到某行左边一点（左 gutter）→
      // 亮出该行握点；移到某列上边一点（顶 gutter）→ 亮出该列握点；停在单元格上 →
      // 都不亮（只有拖动才高亮，见用户第 6 条）。两轨互不相交（行轨 x<表左缘，列轨
      // y<表顶缘），故任一时刻至多亮一个握点。CSS 无法跨行选「同列」，列悬停仍由 JS
      // 给整列挂 wysiwyg-col-hover 类（仅作状态标记，无样式——高亮只在拖动态）。
      // 带缓存避免 mousemove 高频重复挂类/重定位。
      let colHoverIdx = -1;
      const setColHover = (i) => {
        if (i === colHoverIdx) return;
        colHoverIdx = i;
        const rows = tableEl.querySelectorAll('tr');
        for (const tr of rows) {
          const cells = tr.children;
          for (let k = 0; k < cells.length; k++) {
            if (cells[k]) cells[k].classList.toggle('wysiwyg-col-hover', k === i);
          }
        }
        // 列握点定位到该列中心。握点的 offsetParent = 列轨（非 wrap）——wrap 加了上下
        // 留白 padding 后必须以列轨 rect 为基准（2026-10-13 反馈 #2 留白改造），
        // 否则握点整体偏移上留白 24px
        if (i >= 0 && rows[0] && rows[0].children[i]) {
          const kr = colTrackEl.getBoundingClientRect();
          const hr = rows[0].children[i].getBoundingClientRect();
          colGripEl.style.left = (hr.left - kr.left + hr.width / 2) + 'px';
          colGripEl.style.opacity = '1';
        } else {
          colGripEl.style.opacity = '0';
        }
      };
      // 行悬停类 + 行握点定位。握点 = 行轨内的可见小把手（灰点阵），JS 移到悬停行中线
      // （top = 行中心 - 实测握点高/2，悬停态 16px）。表头行同样出握点（2026-10-13 反馈 #2：
      // 表头行可拖拽——拖走后落到首位的数据行升为新表头）。
      let rowHoverTr = null;
      const setRowHover = (tr) => {
        if (tr === rowHoverTr) return;
        if (rowHoverTr) { try { rowHoverTr.classList.remove('wysiwyg-row-hover'); } catch (_) { } }
        rowHoverTr = tr;
        if (rowHoverTr) {
          try { rowHoverTr.classList.add('wysiwyg-row-hover'); } catch (_) { }
          // 行握点的 offsetParent = 行轨（top:24px，wrap 上留白之下）——以行轨 rect
          // 为基准定位（2026-10-13 反馈 #2 留白改造）
          const kr = rowTrackEl.getBoundingClientRect();
          const rr = rowHoverTr.getBoundingClientRect();
          // 按实测把手高居中（悬停态 16px → -8；按下/拖动态高 = 行高 → -行高/2）
          const gh = rowGripEl.getBoundingClientRect().height || 16;
          rowGripEl.style.top = (rr.top - kr.top + rr.height / 2 - gh / 2) + 'px';
          rowGripEl.style.opacity = '1';
        } else {
          rowGripEl.style.opacity = '0';
        }
      };
      wrap.addEventListener('mousemove', (e) => {
        // 拖拽进行中：握点由 _wysiwygTableDragMove 按指针连续定位（跟随小手），
        // 这里若再按「指针下行/列中心」重定位，两路写入会打架（胶囊跳动/消失）。
        if (self._wysiwygTableDrag && self._wysiwygTableDrag.moved) return;
        const t = e.target;
        const inRowTrack = !!(t && t.closest && t.closest('.wysiwyg-table-row-handle'));
        const inColTrack = !!(t && t.closest && t.closest('.wysiwyg-table-col-pill'));
        const firstRow = tableEl.querySelector('tr');
        const cells0 = firstRow ? firstRow.children : [];
        if (!cells0.length) { setRowHover(null); setColHover(-1); return; }
        const fr = cells0[0].getBoundingClientRect();
        const gridLeft = fr.left, gridTop = fr.top;
        const gridRight = cells0[cells0.length - 1].getBoundingClientRect().right;
        // 顶 gutter（列轨）→ 该列握点
        if (inColTrack && e.clientY < gridTop && e.clientY >= gridTop - 24 && e.clientX >= gridLeft && e.clientX < gridRight) {
          let ci = -1;
          for (let i = 0; i < cells0.length; i++) {
            const cr = cells0[i].getBoundingClientRect();
            if (e.clientX >= cr.left && e.clientX < cr.right) { ci = i; break; }
          }
          setRowHover(null); setColHover(ci); return;
        }
        // 左 gutter（行轨）→ 该行握点。i 从 0 起：表头行也可拖拽（2026-10-13 反馈 #2，
        // 顶部行拖走后落到首位的数据行升为新表头——moveTableRow 按此语义回写）
        if (inRowTrack && e.clientX < gridLeft && e.clientX >= gridLeft - 24) {
          const trsAll = Array.from(tableEl.querySelectorAll('tr'));
          let tr = null;
          for (let i = 0; i < trsAll.length; i++) {
            const br = trsAll[i].getBoundingClientRect();
            if (e.clientY >= br.top && e.clientY < br.bottom) { tr = trsAll[i]; break; }
          }
          setColHover(-1); setRowHover(tr); return;
        }
        // 停在单元格上或其它位置 → 两握点都隐藏（悬停不高亮）
        setRowHover(null); setColHover(-1);
      });
      wrap.addEventListener('mouseleave', () => { setRowHover(null); setColHover(-1); });
    },

    // 整表块回写（增行/增列/行/列换位）。行数可能变 → 旧块表行号整体位移：
    // replaceRange 后立即重算块表 + 重挂变化块，并清 250ms 输入防抖避免重复解析。
    _wysiwygCommitTableBlock(blockIdx, newSource, origin) {
      const cm = this.cm;
      const b = this._wysiwygBlocks && this._wysiwygBlocks[blockIdx];
      if (!cm || !b) return false;
      const cur = this._wysiwygBlockSource(b);
      if (cur === newSource) return true;
      const lastLine = Math.min(b.end - 1, cm.lineCount() - 1);
      if (lastLine < b.start) return false;
      try {
        cm.replaceRange(newSource,
          { line: b.start, ch: 0 }, { line: lastLine, ch: cm.getLine(lastLine).length },
          origin || '+wysiwygTableStruct');
      } catch (_) { return false; }
      if (this._wysiwygMaskTimer) { clearTimeout(this._wysiwygMaskTimer); this._wysiwygMaskTimer = null; }
      if (this._wysiwygFull) {
        this._refreshWysiwygFullIncremental();
      } else {
        const oldBlocks = this._wysiwygBlocks;
        this._wysiwygBlocks = this.computeWysiwygBlocks();
        this._wysiwygVirtual = !!(this._wysiwygBlocks[0] && this._wysiwygBlocks[0].skipped);
        this._ensureWysiwygScrollHook();
        this._wysiwygActiveIdx = this._wysiwygCellEditing ? -1 : this._wysiwygActiveIdxFromCursor(oldBlocks);
        if (this._wysiwygMarks) {
          for (const idx of Array.from(this._wysiwygMarks.keys())) this.unmaskWysiwygBlock(idx);
        }
        this.updateWysiwygViewportMasks();
        this.updateWysiwygBlankLines();
        this._applyWysiwygActiveHighlight();
      }
      return true;
    },

    // ＋增行/增列：纯函数重建整块回写 → 自动进入新格的格编辑（Typora 式无缝续输）
    _wysiwygTableAdd(kind, maskNode) {
      const cm = this.cm;
      const idx = maskNode ? parseInt(maskNode.getAttribute('data-block-index'), 10) : NaN;
      const b = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;
      if (!cm || !b) return;
      // 增行/增列后紧接着进新格编辑：旧格提交用 settle=false（光标由新格接管）
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
      const src = this._wysiwygBlockSource(b);
      const newSrc = (kind === 'row' ? addTableRow : addTableColumn)(src);
      if (!newSrc || newSrc === src) return;
      const startLine = b.start; // 增行/增列不改块首行，回写后按首行找新块索引
      if (!this._wysiwygCommitTableBlock(idx, newSrc, kind === 'row' ? '+wysiwygTableAddRow' : '+wysiwygTableAddCol')) return;
      const newIdx = this.wysiwygBlockIndexAt(startLine);
      const nb = (newIdx >= 0 && this._wysiwygBlocks) ? this._wysiwygBlocks[newIdx] : null;
      if (!nb) return;
      const rows = this._wysiwygBlockSource(nb).split('\n');
      const lastInfo = splitTableRow(rows[rows.length - 1]);
      if (!lastInfo.cells.length) return;
      // 新格 = 新增行/列的第一个单元格（2026-10-14 用户要求：光标要在新增行的第一个单元格）：
      // 增行 = 新末行首格（tr 序 rows.length-2、第 0 列）；增列 = 新末列表头格（第 0 行、末列）
      const tRow = (kind === 'row') ? rows.length - 2 : 0;
      const tCol = (kind === 'row') ? 0 : lastInfo.cells.length - 1;
      this._wysiwygStartCellEditAt(tRow, tCol, newIdx);
    },

    // 行/列拖拽入口（pointerdown，先于 mousedown）：
    // 行拖拽 = 表格外左缘行把手（wrap 上真实元素）或首格左侧 16px 区按下
    //   → 返回 true（preventDefault 抑制兼容 mousedown → 不触格编辑/光标定位）；
    // 列拖拽 = 表上方蓝色胶囊（wrap 上真实元素）或表头格按下
    //   → 返回 true（胶囊非单元格，不动手 = 无事发生；表头格不动手 = 普通格编辑，
    //     移动超 4px 阈值才真正进入拖拽）。
    _wysiwygTableDragStart(ev) {
      if (!ev || ev.button !== 0) return false;
      const wrap = ev.target && ev.target.closest ? ev.target.closest('.wysiwyg-table-wrap') : null;
      if (!wrap) return false;
      const tableEl = wrap.querySelector('table');
      // 行轨道（wrap 上常驻真实元素，覆盖整条左 gutter）：按 = 按下点 y 所在的那行。
      // 轨道是全高命中区（非单行小把手），故按坐标而非元素盒定位行。
      const rowTrackEl = ev.target && ev.target.closest ? ev.target.closest('.wysiwyg-table-row-handle') : null;
      if (rowTrackEl && tableEl) {
        const trsAll = Array.from(tableEl.querySelectorAll('tr'));
        let idx = -1;
        for (let i = 0; i < trsAll.length; i++) { // 表头行也可拖（反馈 #2）
          const br = trsAll[i].getBoundingClientRect();
          if (ev.clientY >= br.top && ev.clientY < br.bottom) { idx = i; break; }
        }
        if (idx >= 0) {
          this._wysiwygBeginTableDrag({
            kind: 'row', wrap: wrap, tableEl: tableEl, trs: trsAll, idx: idx,
            startX: ev.clientX, startY: ev.clientY, moved: false,
          });
          return true;
        }
      }
      // 列轨道（wrap 上常驻真实元素，覆盖整条顶 gutter）：按 = 按下点 x 所在的那列
      const colTrackEl = ev.target && ev.target.closest ? ev.target.closest('.wysiwyg-table-col-pill') : null;
      if (colTrackEl && tableEl) {
        const trsAll = Array.from(tableEl.querySelectorAll('tr'));
        const headerCells = trsAll[0] ? Array.from(trsAll[0].children) : [];
        let cidx = -1;
        for (let i = 0; i < headerCells.length; i++) {
          const cr = headerCells[i].getBoundingClientRect();
          if (ev.clientX >= cr.left && ev.clientX < cr.right) { cidx = i; break; }
        }
        if (cidx >= 0) {
          this._wysiwygBeginTableDrag({
            kind: 'col', wrap: wrap, tableEl: tableEl, trs: trsAll, idx: cidx,
            startX: ev.clientX, startY: ev.clientY, moved: false,
          });
          return true;
        }
      }
      const cell = ev.target && ev.target.closest ? ev.target.closest('td,th') : null;
      if (!tableEl || !cell) return false;
      const tr = cell.closest('tr');
      const trs = tr ? Array.from(tableEl.querySelectorAll('tr')) : [];
      const rIdx = tr ? trs.indexOf(tr) : -1;
      if (rIdx < 0) return false;
      const isHeader = !!(tr.parentElement && tr.parentElement.tagName === 'THEAD');
      const cIdx = Array.from(tr.children).indexOf(cell);
      const cellRect = cell.getBoundingClientRect();
      // 行把手在表格外左缘（2026-10-13 参考图）：点击区 = [格左缘-16, 格左缘+16)，
      // 下界防止行左侧整条空白 gutter 都被误判成行拖拽。
      const dxRow = ev.clientX - cellRect.left;
      if (!isHeader && cIdx === 0 && dxRow < 16 && dxRow >= -16) {
        this._wysiwygBeginTableDrag({
          kind: 'row', wrap: wrap, tableEl: tableEl, trs: trs, idx: rIdx,
          startX: ev.clientX, startY: ev.clientY, moved: false,
        });
        return true;
      }
      // 表头格不再是列拖把手（2026-10-20 用户要求：表头不允许拖动，只有顶部/左侧
      // 把手可发起拖拽）——表头格按下落到格编辑；列拖只从顶部列轨（pill）启动。
      return false;
    },

    // 进入拖拽跟踪：登记 window 监听（move/up/cancel/Esc）；按下即变蓝
    // （_wysiwygTablePressVisual，用户反馈「按下鼠标时就要变蓝」），超 4px 阈值才动
    // 拖拽语义（高亮/落点线/取消格编辑）。
    // st.target = 落点（被拖元素在新序列中的下标，move 中按指针计算，up 时提交）——
    // 2026-10-13 反馈 #1/#2 起拖拽中不再实时重排 DOM（被拖行/列原地淡蓝高亮 + 蓝线
    // 指示落点，对齐参考图），终位以 st.target 为准。
    _wysiwygBeginTableDrag(st) {
      const self = this;
      st.maskNode = st.wrap && st.wrap.closest ? st.wrap.closest('.' + MASK_CLASS) : null;
      st.target = st.idx;
      // 按下时刻已存在的格编辑（用户完成的合法编辑）：4px 阈值处**不取消**，释放时
      // 源码重建前提交回写（2026-10-14 用户反馈：改完格内容立即拖行/列内容丢失）。
      // 本次按下才触发的格编辑（表头格按下、不动=误点击）仍是阈值处取消恢复。
      st.cellEditAtDown = this._wysiwygCellEditing;
      this._wysiwygTableDrag = st;
      st.onMove = (e) => self._wysiwygTableDragMove(e);
      st.onUp = (e) => self._wysiwygTableDragUp(e);
      st.onKey = (e) => { if (e.key === 'Escape') self._wysiwygTableDragCancel(); };
      window.addEventListener('pointermove', st.onMove);
      window.addEventListener('pointerup', st.onUp);
      window.addEventListener('pointercancel', st.onUp);
      window.addEventListener('keydown', st.onKey);
      // 按下即变蓝（用户反馈：拖动手按下鼠标时把手就要变蓝，不等拖动阈值）：
      // 把手进拖拽视觉态（蓝底圆角矩形 + 白点阵 + inline 尺寸），但拖拽语义
      // （取消格编辑、被拖行/列高亮、落点线）仍超 4px 阈值才生效——点击不动仍是点击。
      self._wysiwygTablePressVisual(st);
    },

    // 把手按下/拖拽视觉态：轨道挂 .wysiwyg-dragging（CSS 让把手变蓝底圆角矩形、
    // 点变白），并设 inline 尺寸：行拖 = 竖条（宽 16px、高 = 被拖行实测行高）；
    // 列拖 = 横条（宽 = 被拖列宽、最小 26px、高 16px CSS）。点阵文本恒保持未按下
    // 态的 ⋮⋮ 2×3 点阵（2026-10-14 用户反馈：按下/拖动只变背景蓝，不换成单排
    // 竖点/横点）。pointerdown 即调用（按下即变蓝）；结束态清除回落悬停态。
    _wysiwygTablePressVisual(st) {
      try {
        const track = st.wrap && st.wrap.querySelector(
          st.kind === 'row' ? '.wysiwyg-table-row-handle' : '.wysiwyg-table-col-pill');
        if (!track) return;
        track.classList.add('wysiwyg-dragging');
        const grip = track.querySelector('span');
        if (!grip) return;
        // ⋮⋮ 点阵不变，只由 CSS 加蓝底
        if (st.kind === 'row') {
          // 行拖 = 16px 宽竖条 × 行高（与列拖横条同厚 16px）
          const refRow = st.trs[st.idx];
          if (refRow) {
            const rh = refRow.getBoundingClientRect().height;
            if (rh > 0) {
              grip.style.height = rh + 'px';
              // 高度变了（16 → 行高），立刻按行中线重新居中（拖动跟随接管前不偏位）
              const trackRect = track.getBoundingClientRect();
              const rowRect = refRow.getBoundingClientRect();
              grip.style.top = (rowRect.top - trackRect.top + rowRect.height / 2 - rh / 2) + 'px';
            }
          }
        } else {
          const hc = st.trs[0] ? st.trs[0].children[st.idx] : null;
          const cw = hc ? hc.getBoundingClientRect().width : 0;
          grip.style.width = Math.max(26, Math.round(cw)) + 'px';
        }
      } catch (_) { }
    },

    _wysiwygTableDragMove(e) {
      const st = this._wysiwygTableDrag;
      if (!st || !st.tableEl || !st.tableEl.isConnected) return;
      if (!st.moved) {
        if (Math.abs(e.clientX - st.startX) < 4 && Math.abs(e.clientY - st.startY) < 4) return;
        st.moved = true;
        // 本次按下触发的格编辑（表头格按下不动=误点击）：先取消恢复，再真正进入拖拽。
        // 按下前已存在的格编辑（用户改完内容的合法编辑）不在此取消——取消即内容丢失，
        // 改到释放时源码重建前提交回写（_wysiwygTableDragUp，2026-10-14 用户反馈）。
        if (this._wysiwygCellEditing && this._wysiwygCellEditing !== st.cellEditAtDown) this._wysiwygEndCellEdit(false);
        try { document.body.classList.add('wysiwyg-table-dragging'); } catch (_) { }
        if (st.kind === 'row') {
          try { st.trs[st.idx].classList.add('wysiwyg-table-dragging-row'); } catch (_) { }
        } else {
          st.dragCells = Array.from(st.tableEl.querySelectorAll('tr')).map((tr) => tr.children[st.idx]);
          for (const c of st.dragCells) { if (c) c.classList.add('wysiwyg-table-dragging-col'); }
        }
        // 握点变蓝已提前到按下即刻（_wysiwygTablePressVisual）；这里只补拖拽语义：
        // 取消格编辑、被拖行/列浅蓝高亮、落点线随 move 出现。
      }
      // 拖动态：蓝胶囊跟随指针（2026-10-13 反馈 #1：变蓝的块要跟小手一起移动，
      // 行/列同款）。wrap 的 mousemove 拖拽中已让位（不重写回行/列中心），这里按
      // pointermove 连续定位：行拖 = 跟 y（clamp 到行轨），列拖 = 跟 x（clamp 到列轨）。
      try {
        if (st.wrap && st.wrap.isConnected) {
          const trackEl = st.wrap.querySelector(
            st.kind === 'row' ? '.wysiwyg-table-row-handle' : '.wysiwyg-table-col-pill');
          const gripEl = trackEl ? trackEl.querySelector('span') : null;
          if (gripEl) {
            const tr = trackEl.getBoundingClientRect();
            if (st.kind === 'row') {
              const gh = gripEl.getBoundingClientRect().height || 26;
              let top = e.clientY - tr.top - gh / 2;
              top = Math.max(0, Math.min(tr.height - gh, top));
              gripEl.style.top = top + 'px';
            } else {
              // 列拖胶囊是宽横胶囊（2026-10-13 参考图）：按半宽 clamp，胶囊不探出表格
              const gw = gripEl.getBoundingClientRect().width || 20;
              let left = e.clientX - tr.left;
              left = Math.max(gw / 2, Math.min(tr.width - gw / 2, left));
              gripEl.style.left = left + 'px';
            }
          }
        }
      } catch (_) { }
      // 落点计算（2026-10-13 反馈 #1/#2：拖拽中**不再实时重排 DOM**——被拖行/列原地
      // 淡蓝高亮，蓝线指示要拖动到的位置，对齐参考图；释放时按 st.target 一次换位提交）。
      // target = 插入到 others[target] 之前（others = 除被拖项外的原序），末尾 = others.length。
      const trs = Array.from(st.tableEl.querySelectorAll('tr'));
      if (st.kind === 'row') {
        const dragTr = trs.indexOf(st.trs[st.idx]) >= 0 ? st.trs[st.idx] : trs[st.idx];
        const others = trs.filter((t) => t !== dragTr);
        let target = others.length;
        for (let i = 0; i < others.length; i++) {
          const r = others[i].getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) { target = i; break; }
        }
        st.target = target;
      } else {
        if (!st.dragCells || !st.dragCells[0]) return;
        const headerCells = Array.from(st.trs[0].children);
        const others = headerCells.filter((c) => c !== st.dragCells[0]);
        let target = others.length;
        for (let i = 0; i < others.length; i++) {
          const r = others[i].getBoundingClientRect();
          if (e.clientX < r.left + r.width / 2) { target = i; break; }
        }
        st.target = target;
      }
      // 蓝线定位：行拖横线在 others[target] 顶缘（末尾 = 表格底缘）、列拖竖线在
      // others[target] 左缘（末尾 = 表格右缘），相对 wrap 盒（含上下留白 padding）
      try {
        if (st.wrap && st.wrap.isConnected) {
          const lineEl = st.wrap.querySelector('.wysiwyg-table-drop-line');
          if (lineEl) {
            const wr = st.wrap.getBoundingClientRect();
            if (st.kind === 'row') {
              const all = Array.from(st.tableEl.querySelectorAll('tr'));
              const dragTr = all.indexOf(st.trs[st.idx]) >= 0 ? st.trs[st.idx] : all[st.idx];
              const others = all.filter((t) => t !== dragTr);
              const boundary = st.target < others.length
                ? others[st.target].getBoundingClientRect().top
                : st.tableEl.getBoundingClientRect().bottom;
              lineEl.className = 'wysiwyg-table-drop-line wysiwyg-drop-line-row';
              lineEl.style.left = ''; // 清上一次列拖残留的 inline left（inline 压过 CSS left:0，
                                      // 无提交的拖拽不重建遮罩时残留会让横线从表格右缘起飞）
              lineEl.style.top = (boundary - wr.top - 1) + 'px'; /* 线厚 2px，居中 = 边界 - 1 */
            } else {
              const headerCells = Array.from(st.trs[0].children);
              const others = headerCells.filter((c) => c !== st.dragCells[0]);
              const boundary = st.target < others.length
                ? others[st.target].getBoundingClientRect().left
                : st.tableEl.getBoundingClientRect().right;
              lineEl.className = 'wysiwyg-table-drop-line wysiwyg-drop-line-col';
              lineEl.style.top = ''; // 清上一次行拖残留的 inline top（同理防竖线串位）
              lineEl.style.left = (boundary - wr.left - 1) + 'px'; /* 线厚 2px，居中 = 边界 - 1 */
            }
            lineEl.style.opacity = '1';
          }
        }
      } catch (_) { }
    },

    _wysiwygTableDragUp() {
      const st = this._wysiwygTableDrag;
      if (!st) return;
      const connected = !!(st.tableEl && st.tableEl.isConnected);
      this._wysiwygEndTableDragState();
      if (!st.moved || !connected) {
        // 行/列轨道单击（拖拽未真正发生）或遮罩已失效 + 格仍在编辑：提交失焦
        // （2026-10-14 用户要求：点其他行/空白处单元格失去焦点）。
        // 例外：表头格普通点击——列拖态是表头格 pointerdown 的既有副产物（表头格兼列拖
        // 把手，不动手 = 普通格编辑，反馈 #2），此刻的格编辑是合法点击进的，不得提交。
        // 但真拖过（moved）+ 遮罩已失效时格节点可能已离场，必须立即提交，否则内容丢失。
        const plainHeaderClick = st.kind === 'col' && st.trs && st.trs[0] &&
          !!(this._wysiwygCellEditing && st.trs[0].children[st.idx] === this._wysiwygCellEditing.cell);
        if (this._wysiwygCellEditing && (st.moved || !plainHeaderClick)) this._wysiwygEndCellEdit(true, false);
        return;
      }
      // 拖拽前已存在的格编辑（合法编辑，阈值块未取消）：先提交回写再做源码重建，
      // 内容才不会在重建中丢失（2026-10-14 用户反馈：改完格内容立即拖行/列丢改动；
      // 「先点别处再拖」不丢正是因为 blur 提交已先行）。误触格编辑（表头格按下）
      // 已在阈值块取消，不会到这里。
      // 提交会重挂本块遮罩、旧表格节点离场：st.maskNode 仅剩 data-block-index 属性
      // 可读（detached 节点属性不丢），st.tableEl 供 _wysiwygTableRestoreDom 的
      // 原位释放兜底（作用于离场节点，无害空操作）。
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
      // 终位 = move 中按指针算出的落点 st.target（被拖项在新序列中的下标）。
      // 2026-10-13 反馈 #1/#2 起拖拽中不再实时重排 DOM，这里不能读 DOM 序（恒为原序）。
      const to = (typeof st.target === 'number' && isFinite(st.target)) ? st.target : st.idx;
      // 无效换位（原位释放）直接返回：拖拽期不动 DOM，无需恢复（保留调用兜底：
      // 若未来重引入中途 DOM 变更，空 thead 等坏结构在此恢复）
      if (to < 0 || to === st.idx) {
        this._wysiwygTableRestoreDom(st);
        return;
      }
      const idx = st.maskNode ? parseInt(st.maskNode.getAttribute('data-block-index'), 10) : NaN;
      const b = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;
      if (!b) return;
      const src = this._wysiwygBlockSource(b);
      const newSrc = (st.kind === 'row') ? moveTableRow(src, st.idx, to) : moveTableColumn(src, st.idx, to);
      if (newSrc && newSrc !== src) {
        this._wysiwygCommitTableBlock(idx, newSrc, '+wysiwygTableMove');
      } else {
        this._wysiwygTableRestoreDom(st);
      }
    },

    _wysiwygTableDragCancel() {
      const st = this._wysiwygTableDrag;
      if (!st) return;
      const connected = !!(st.tableEl && st.tableEl.isConnected);
      this._wysiwygEndTableDragState();
      if (connected && st.moved) this._wysiwygTableRestoreDom(st);
      // 取消拖拽时若格仍在编辑（轨道单击未超阈值即取消）：提交失焦（同 dragUp 注释）
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
    },

    _wysiwygTableRestoreDom(st) {
      try {
        if (st.kind === 'row') {
          const trs = Array.from(st.tableEl.querySelectorAll('tr'));
          const dragTr = trs.indexOf(st.trs[st.idx]) >= 0 ? st.trs[st.idx] : null;
          if (!dragTr) return;
          // 表头行（idx 0）：拖拽中离开 thead 会被浏览器自动收进 tbody，
          // 恢复时显式归位 thead（否则留下空 thead + tbody 首行无表头样式的坏结构）
          const thead = st.tableEl.querySelector('thead');
          if (st.idx === 0 && thead && dragTr.parentElement !== thead) {
            thead.appendChild(dragTr);
          } else {
            const others = trs.filter((t) => t !== dragTr);
            dragTr.parentNode.insertBefore(dragTr, others[st.idx] || null);
          }
          dragTr.classList.remove('wysiwyg-table-dragging-row');
        } else {
          if (!st.dragCells) return;
          const rows = Array.from(st.tableEl.querySelectorAll('tr'));
          for (let i = 0; i < rows.length; i++) {
            const cell = st.dragCells[i];
            if (!cell) continue;
            const others = Array.from(rows[i].children).filter((c) => c !== cell);
            rows[i].insertBefore(cell, others[st.idx] || null);
            cell.classList.remove('wysiwyg-table-dragging-col');
          }
        }
      } catch (_) { /* 节点已离场则忽略 */ }
    },

    _wysiwygEndTableDragState() {
      const st = this._wysiwygTableDrag;
      this._wysiwygTableDrag = null;
      if (st) {
        if (st.onMove) window.removeEventListener('pointermove', st.onMove);
        if (st.onUp) window.removeEventListener('pointerup', st.onUp);
        if (st.onUp) window.removeEventListener('pointercancel', st.onUp);
        if (st.onKey) window.removeEventListener('keydown', st.onKey);
        // 握点退出拖动态（提交路径遮罩已重建、旧节点离场，remove 为无害空操作）；
        // 同步清除拖动态的 inline 尺寸（行拖行高胶囊 / 列拖宽横胶囊），回落悬停态
        // ⋮⋮ 点阵（按下不再换点阵文本，textContent 复位为防御性兜底）
        try {
          if (st.wrap && st.wrap.isConnected) {
            const hEls = st.wrap.querySelectorAll('.wysiwyg-dragging');
            for (const el of hEls) {
              el.classList.remove('wysiwyg-dragging');
              const g = el.querySelector('span');
              if (g) {
                g.style.height = '';
                g.style.width = '';
                g.style.top = ''; // 防御：hover 路径本会重写定位，清掉防未来路径漏定位
                g.style.left = '';
                g.textContent = '\u22EE\u22EE';
              }
            }
            // 落点指示线隐藏（2026-10-13 反馈 #1/#2：只在拖动态可见）
            // ⚠️ 必须连 inline 坐标一起清：无提交的拖拽（原位释放/取消）不重建遮罩，同一
            // drop-line 元素存活到下一次拖拽；行拖/列拖各写各的轴（top/left），残留的
            // inline 会压过 CSS left:0/top:24px 让另一方向的线串位（2026-10-14 用户截图
            // 「线跑右边去了」：列拖残留 left=表宽 → 行拖横线从表右缘起飞向右延伸）
            const lineEl = st.wrap.querySelector('.wysiwyg-table-drop-line');
            if (lineEl) {
              lineEl.style.opacity = '0';
              lineEl.style.left = '';
              lineEl.style.top = '';
              lineEl.className = 'wysiwyg-table-drop-line';
            }
          }
        } catch (_) { }
      }
      try { document.body.classList.remove('wysiwyg-table-dragging'); } catch (_) { }
    },

    // 容器块「块末结构行」Enter 语义（2026-10-22 用户报 details「从末尾（</details> 行）
    // 点击回车会跳出编辑态、在块下方新增一行——应该是正常的在灰色框中新增行」）：
    // HTML 容器闭标签行（</details>/</div>/…）按 Enter → 新行插在该结构行**之前**
    // （块内、灰盒内），光标落新行行首——灰盒不缩、编辑态不丢，结构行永不被劈成两半。
    // ⚠️ 围栏块例外（2026-10-25 用户要求「末尾的 ``` 像代码中的普通内容一样可以编辑，
    // 在 ``` 后面回车应在 ``` 下面增加一行」）：闭围栏行不拦截，全部 Enter 位置交回默认
    // 换行——行尾 → 新行落围栏下方（块外，代码块经正常活动块切换重新遮罩，与 Typora 等
    // 主流编辑器一致）；行中 → 围栏行照常被劈开（普通内容行语义）。
    // 处理成功消费该键（调用方直接 return）；格编辑中 / 有选区 / 光标不在块末结构行 /
    // 围栏块一律返回 false 交回原换行逻辑。
    // 判定收口：HTML 容器块（details/div/figure/pre…，块表合并后末行即闭标签行）——末行以
    // 「</容器标签」开头，闭标签正则按开标签名派生，details 不再特判。
    _wysiwygEnterOnBlockCloseLine(cm) {
      if (!cm || this._wysiwygCellEditing) return false;
      if (cm.somethingSelected()) return false;
      const idx = this._wysiwygActiveIdx;
      const b = (idx != null && idx >= 0 && this._wysiwygBlocks) ? this._wysiwygBlocks[idx] : null;
      if (!b) return false;
      const pos = cm.getCursor();
      // 只拦块末行（且不是首行独担——单行块开闭同行，劈行即破坏块本身）；以该行的
      // 实际文本为准（250ms 防抖窗口内块表可能滞后一行）
      if (pos.line !== b.end - 1 || pos.line <= b.start) return false;
      const first = cm.getLine(b.start) || '';
      const lastLine = cm.getLine(pos.line) || '';
      // 围栏块（代码 / mermaid 图表 / 一切围栏）：闭围栏行不拦截（2026-10-25，见头注）
      if (RE.fenceStart.test(first)) return false;
      const om = first.match(RE.htmlOpenTag);
      const isClose = !!(om && new RegExp('^\\s{0,3}</' + om[1] + '\\b', 'i').test(lastLine));
      if (!isClose) return false;
      cm.operation(() => {
        const prev = pos.line - 1;
        const prevLen = cm.getLineHandle(prev).text.length;
        cm.replaceRange('\n', { line: prev, ch: prevLen });
        cm.setCursor({ line: prev + 1, ch: 0 });
      });
      return true;
    },

    // 活动块高亮：只给「光标所在行」加底色（2026-10-14 用户要求：列表/引用/段落等块
    // 原来整块灰底、编辑态与渲染态观感差距大 → 改为仅光标行灰底、随光标在块内移动跟随，
    // 块内其余行保持无底色的源文态；配合活动块源文态装饰，编辑态整体贴近渲染态）。
    // 容器块（代码围栏 / 表格）例外，保持「整块灰盒」：渲染态本身就是容器盒，编辑态也应
    // 是盒（灰盒观感是代码块活动态的既有设计）。先撤旧行号集合（编辑后行号可能已位移）
    // 再按当前活动块重挂；_wysiwygActiveIdx 为 -1（光标在块间空行）时给**光标行**挂
    // 单行灰底（2026-10-21 用户要求：回车新增的块间空行需灰色指示当前编辑行；格编辑
    // 例外不挂），光标不在任何块且非 wysiwyg 态时只撤不挂。
    // 调用点：setWysiwygActiveBlock（含同块光标移动路径 = 底色跟随光标）/
    // renderWysiwygMasks / refreshWysiwygBlocks / _refreshWysiwygFullIncremental /
    // clearWysiwygMasks（撤光）。
    _applyWysiwygActiveHighlight() {
      const cm = this.cm;
      if (!cm) return;
      if (this._wysiwygActiveLines) {
        // 直接对行对象撤类（不按行号取句柄）：分行/插行后行号位移，按旧行号撤会打空、
        // 灰底残留成「文末灰色条」（2026-10-17 用户截图，根因即此处）。
        for (const h of this._wysiwygActiveLines) {
          try {
            if (h) {
              cm.removeLineClass(h, 'background', ACTIVE_CLASS);
              cm.removeLineClass(h, 'background', ACTIVE_FIRST_CLASS);
              cm.removeLineClass(h, 'background', ACTIVE_LAST_CLASS);
              cm.removeLineClass(h, 'background', ACTIVE_CODE_BOX_CLASS);
            }
          } catch (_) { /* 行已销毁（安全 no-op） */ }
        }
      }
      this._wysiwygActiveLines = null;
      const idx = this._wysiwygActiveIdx;
      const b = (idx != null && idx >= 0 && this._wysiwygBlocks) ? this._wysiwygBlocks[idx] : null;
      if (!b) {
        // 光标在块间空行（idx=-1，2026-10-21 用户要求：图片上方回车新增的行没有灰色
        // 明确指示当前编辑行）：光标行同样挂光标行底色——与块内非容器块同一口径
        // （下方 lo=hi=head.line）。块间空行是真实行（可输入成段落、回车出新行），
        // 光标所在就应显示灰底；同时 syncWysiwygActiveBlock / updateWysiwygBlankLines
        // 把该行恢复全高（塌缩 0px 时灰底与光标不可见、cursorCoords 退化 → 锚定补偿
        // 测出垃圾差值放大视口跳）。不显示空行提示（empty-hint.js 对块间空行的抑制
        // 口径不变，2026-10-17）。
        // ⚠️ 格编辑（idx 强制 -1、光标被钳在遮罩表格行内）不挂：光标行属遮罩块。
        if (this.viewMode === 'wysiwyg' && !this._wysiwygCellEditing) {
          let head = null;
          try { head = cm.getCursor('head'); } catch (_) { /* 忽略 */ }
          if (head && head.line >= 0 && head.line < cm.lineCount() && this.wysiwygBlockIndexAt(head.line) < 0) {
            try {
              const h = cm.getLineHandle(head.line);
              if (h) {
                this._wysiwygActiveLines = [h];
                cm.addLineClass(h, 'background', ACTIVE_CLASS);
                // 单行：同一行挂三个类 = 四角全圆（与下方单行路径同口径）
                cm.addLineClass(h, 'background', ACTIVE_FIRST_CLASS);
                cm.addLineClass(h, 'background', ACTIVE_LAST_CLASS);
              }
            } catch (_) { /* 行已销毁 */ }
          }
        }
        return;
      }
      // 引用/提示块不挂活动行灰底（2026-10-25 用户「编辑态不适用灰色代码框、直接与渲染态
      // 样式完全一致」）：光标行由 wysiwyg-quote-line 的 pre 背景盒 + 左竖条自绘渲染盒
      // 本貌，整行 --code-bg 灰底（cm-wysiwyg-active-block）铺在 pre 背景两侧露出 =
      // 「背景太乱、规则互相冲突」的根源，整块跳过（旧行类已在上方循环撤净）。
      if (this._wysiwygBlockIsQuote(b)) return;
      const total = cm.lineCount();
      if (b.start >= total) return;
      const last = Math.min(b.end, total) - 1;
      // 代码围栏：整块灰盒（2026-10-18 用户要求：上下围栏都在灰框内）——开/闭围栏行与
      // 内容行同挂灰底，围栏行另挂代码排版行类（_wysiwygApplyActiveDecor）、文字保持灰显
      // 语法标志；内容行补 29px 顶/底内距 = 渲染态 pre 内距分解（见 styles.css 同名规则）。
      // 未闭合围栏（无闭行）时 hi=last 即末内容行，盒收在末内容行。
      // 表格：整块灰盒（容器观感，维持旧口径）；其余块只光标行（选区头行，钳进块内）。
      const first = cm.getLine(b.start);
      const isFence = RE.fence.test((first || '').trim());
      const isTable = !isFence && RE.table.test(first || '');
      // 折叠区块（2026-10-22 用户要求「进入编辑态时要在灰色块中进行编辑，可以参考代码块」）：
      // 按容器块处理——整块同挂代码盒背景类（ACTIVE_CODE_BOX_CLASS 复用代码盒 ::before
      // 内缩盒：--code-bg 底色 + 1px 描边 + 首/末角），源文行排版类见
      // _wysiwygApplyActiveDecor 的 wysiwyg-details-line（左右 12px 内距，不贴盒竖边）。
      const isDetails = !isFence && !isTable && RE.detailsOpen.test(first || '');
      // HTML 容器块（2026-10-25 用户要求「居中显示等具有编辑按钮的，编辑时是编辑整块源码的，
      // 都在灰色块中进行编辑」）：开行为 CommonMark 原始 HTML 块标签（<center>/<div>/<figure>/…，
      // isHtmlBlockContainerLine 与 _wysiwygApplyActiveDecor 共用口径）→ 同代码块/折叠区块
      // 整块进灰盒（lo/hi 不收敛到光标行）。
      const isHtmlContainer = !isFence && !isTable && !isDetails && isHtmlBlockContainerLine(first);
      let lo = b.start, hi = last;
      if (isFence) {
        // 整块进盒（lo=b.start 含开围栏、hi=last 含闭围栏）：空代码块（仅开/闭两行）
        // 也是两行灰盒，首/末角类由下方循环按 n===lo/hi 挂
      } else if (!isTable && !isDetails && !isHtmlContainer) {
        let head = null;
        try { head = cm.getCursor('head'); } catch (_) { /* 忽略 */ }
        if (head && head.line >= b.start && head.line <= last) { lo = hi = head.line; }
      }
      this._wysiwygActiveLines = [];
      for (let n = lo; n <= hi; n++) {
        try {
          const h = cm.getLineHandle(n);
          if (!h) continue;
          this._wysiwygActiveLines.push(h); // 记行对象（撤除处靠它跟住行位移）
          cm.addLineClass(h, 'background', ACTIVE_CLASS);
          if (isFence || isDetails || isHtmlContainer) cm.addLineClass(h, 'background', ACTIVE_CODE_BOX_CLASS);
          // 单行：同一行挂三个类 = 四角全圆；容器整块：首行仅上角、末行仅下角
          if (n === lo) cm.addLineClass(h, 'background', ACTIVE_FIRST_CLASS);
          if (n === hi) cm.addLineClass(h, 'background', ACTIVE_LAST_CLASS);
        } catch (_) { /* 忽略 */ }
      }
    },

    // ---------------- WYSIWYG 活动块源文态装饰（2026-10-14 用户要求，Typora 式） ----------------
    // 活动块处于未遮罩（源文行）态，按块类型把每行拆若干 text marker 段做「渲染化」显示：
    //   标题（单行）       ：# 前缀小灰 + 正文渲染尺寸/字重（.wysiwyg-heading-*)，h1–h6
    //   列表（ul/ol/task） ：• 圆点 / 数字序号 / ☐☑ 复选框 + 正文预览字族（.wysiwyg-list-*）。
    //                       源字符（-/*/+、[ ]/[x]）宽度收 0 并由 ::before 画出渲染符号
    //                       （光标仍按源字符定位，编辑语义不变：删掉标记字符即退出列表）
    //   代码块（围栏）     ：首行 ```lang / 末行 ``` 灰显（.wysiwyg-code-fence），围栏行在
    //                       灰盒外；内容行挂 wysiwyg-code-line 排版行类 + 活动高亮灰盒
    //                       （2026-10-17 用户要求：编辑态灰盒与渲染态 pre 盒完全一致——
    //                       同 --code-bg / 1px 边框 / 6px 圆角 / 16px 四边内距 / 0.9×预览
    //                       字号 / 行高 1，仅前后多 ``` 围栏，见 styles.css 同名规则）
    //   引用（> 前缀）     ：> 前缀灰显 + 最外层 > 画左竖条（::before）+ 正文预览字体
    //                       （.wysiwyg-quote-*；删掉 > 即退出引用，与预览 blockquote 观感对齐）
    //   行内语法（通用）   ：粗体/斜体/行内代码/删除线/高亮/链接——标记字符透明（保留宽度）、
    //                       文本段渲染化（.wysiwyg-inline-* / -bold / -italic 等，parseWysiwygInlineSpans
    //                       单遍扫描）；可嵌套在标题/列表/引用的块级 span 内。围栏（代码内容）、
    //                       表格（格编辑是独立机制）、frontmatter 不参与
    //   正文排版（通用）   ：非容器块（段落/列表/引用/标题）逐行挂 .wysiwyg-plain-text 行类——
    //                       预览字族 + 渲染字号（--wysiwyg-text-size，同步「预览字号」设置）+
    //                       行高 1.7 + --text-primary，编辑态整体与渲染态遮罩同观感（2026-10-14
    //                       用户要求「编辑时样式要与渲染时的一样」）
    // 先清后挂幂等（markText 不触发 change，无循环）；调用点：setWysiwygActiveBlock（切块）、
    // change 钩子（行内编辑）、renderWysiwygMasks / 防抖 / 全量增量刷新尾、clearWysiwygMasks（清）。
    // 按当前行文本现判类型：行不再符合语法（用户删掉 # / - / 围栏）→ 仅清不挂。
    _wysiwygApplyActiveDecor(idx) {
      const cm = this.cm;
      if (this._wysiwygActiveDecor) {
        for (const m of this._wysiwygActiveDecor) {
          try { m.clear(); } catch (_) { /* 已销毁 */ }
        }
        this._wysiwygActiveDecor = null;
      }
      if (!cm || !this._wysiwygBlocks) return;
      // 正文排版行类同样先清后挂（直接对行对象撤，不受行号位移影响，2026-10-17）
      if (this._wysiwygPlainLines) {
        for (const h of this._wysiwygPlainLines) {
          try {
            if (h) {
              cm.removeLineClass(h, 'text', 'wysiwyg-plain-text');
              cm.removeLineClass(h, 'text', 'wysiwyg-para-line');
              // 折叠区块行类（2026-10-22）：同 para-line 先清后挂
              cm.removeLineClass(h, 'text', 'wysiwyg-details-line');
              // HTML 容器块行类（2026-10-25）：同 details-line 先清后挂
              cm.removeLineClass(h, 'text', 'wysiwyg-html-block-line');
              // 定义列表行类（2026-10-18）：同 para-line 先清后挂
              cm.removeLineClass(h, 'text', 'wysiwyg-dt-line');
              cm.removeLineClass(h, 'text', 'wysiwyg-dd-line');
              // 标题块高补齐行类（S71）：同 para-line 先清后挂（6 个级别类全撤）
              cm.removeLineClass(h, 'text', 'wysiwyg-heading-line');
              for (let n = 1; n <= 6; n++) cm.removeLineClass(h, 'text', 'wysiwyg-heading-line-' + n);
              cm.removeLineClass(h, 'text', 'wysiwyg-block-edge-top');
              cm.removeLineClass(h, 'text', 'wysiwyg-block-edge-bottom');
              // 引用行类（2026-10-20）：行改写成非引用（删掉 >）后须撤掉背景盒/竖条槽
              cm.removeLineClass(h, 'text', 'wysiwyg-quote-line');
              cm.removeLineClass(h, 'text', 'wysiwyg-quote-nested');
              for (let n = 2; n <= 6; n++) cm.removeLineClass(h, 'text', 'wysiwyg-quote-lvl-' + n); // 嵌套层级类随 nested 同撤
              // callout 类型行类 + 引用任务行标记（2026-10-30）：随 quote-line 同撤
              //（decor 引用分支先清后挂、同 tick 内净效果一致，无 2026-10-25 那次的闪烁
              // 问题——那次 decor 不重挂类型类才撤不得；wysiwyg-callout-cursor-line
              // 专用类仍由 sync 差分管，不在此撤）。
              for (const t of ['note', 'tip', 'important', 'warning', 'caution']) {
                cm.removeLineClass(h, 'text', 'wysiwyg-callout-' + t);
              }
              cm.removeLineClass(h, 'text', 'wysiwyg-quote-task-line');
              // 注：callout 光标行类（wysiwyg-callout-cursor-line + wysiwyg-callout-{type}）不在此撤——由
              // syncWysiwygActiveBlock 每 tick 现算挂/撤（同 wysiwyg-quote-cursor-line 机制）：
              // decor 先清后挂会在 sync 现算**之后**跑（setWysiwygActiveBlock 内部），刚一挂上
              // 就被清 → 延迟一 tick 闪烁（2026-10-25 实测）。其行号失效清算由
              // _setWysiwygCalloutCurClass 的 prev/next 差分兜底。
            }
          } catch (_) { /* 行已销毁（安全 no-op） */ }
        }
        this._wysiwygPlainLines = null;
      }
      // 列表块级排版行类（缩进/项间距）同样先清后挂（2026-10-15 编辑态对齐渲染态；
      // 2026-10-17 改行对象制，同上）
      if (this._wysiwygListLines) {
        for (const h of this._wysiwygListLines) {
          try {
            if (h) {
              cm.removeLineClass(h, 'text', 'wysiwyg-list-line');
              cm.removeLineClass(h, 'text', 'wysiwyg-list-indent-ul');
              cm.removeLineClass(h, 'text', 'wysiwyg-list-indent-ol');
              cm.removeLineClass(h, 'text', 'wysiwyg-list-cont');
              for (let n = 2; n <= 6; n++) cm.removeLineClass(h, 'text', 'wysiwyg-list-lvl-' + n);
            }
          } catch (_) { /* 行已销毁（安全 no-op） */ }
        }
        this._wysiwygListLines = null;
      }
      // 代码块内容行排版行类（2026-10-17 编辑态灰盒=渲染态 pre 盒）同样先清后挂
      if (this._wysiwygCodeLines) {
        for (const h of this._wysiwygCodeLines) {
          try {
            if (h) {
              cm.removeLineClass(h, 'text', 'wysiwyg-code-line');
              cm.removeLineClass(h, 'text', 'wysiwyg-code-pad-top');
              cm.removeLineClass(h, 'text', 'wysiwyg-code-pad-bottom');
              cm.removeLineClass(h, 'text', 'wysiwyg-code-slot-bottom');
            }
          } catch (_) { /* 行已销毁（安全 no-op） */ }
        }
        this._wysiwygCodeLines = null;
      }
      this._syncWysiwygTextSize();
      if (idx == null || idx < 0 || idx >= this._wysiwygBlocks.length) return;
      const b = this._wysiwygBlocks[idx];
      if (!b) return;
      if (b.start >= cm.lineCount()) return;
      const first = cm.getLine(b.start);
      const markers = [];
      const add = (lineNo, from, to, cls) => {
        if (to <= from) return;
        try {
          markers.push(cm.markText({ line: lineNo, ch: from }, { line: lineNo, ch: to }, { className: cls }));
        } catch (_) { /* 忽略单段失败 */ }
      };
      if (b.end - b.start === 1 && RE.heading.test(first)) {
        // —— 标题：# 前缀小灰（各级统一 0.8em，2026-10-15 用户要求）+ 正文渲染尺寸 ——
        const m = /^#{1,6}(?=\s|$)/.exec(first);
        if (m) {
          const level = m[0].length;
          add(b.start, 0, m[0].length, 'wysiwyg-heading-hash');
          add(b.start, m[0].length, first.length, 'wysiwyg-heading-text wysiwyg-heading-text-' + level);
        }
        // 块高补齐行类（S71 2026-10-21 用户反馈「点某行进编辑态再点其他行，页面往下移动
        // 一段距离」）：行高 1.3 + 按级底距，活动标题块与遮罩逐像素等高（口径见
        // styles.css 同名规则注释）。标题行同在 _wysiwygPlainLines 登记册（正文排版循环
        // 也给它挂 wysiwyg-plain-text/边缘类）→ 清除时随册撤掉本类。
        const hh = cm.getLineHandle(b.start);
        if (hh) {
          try {
            cm.addLineClass(hh, 'text', 'wysiwyg-heading-line');
            if (m) cm.addLineClass(hh, 'text', 'wysiwyg-heading-line-' + m[0].length);
          } catch (_) { /* 忽略 */ }
        }
      } else if (RE.fence.test(first.trim())) {
        // —— 代码块：整块进灰盒（2026-10-18 用户要求：上下围栏都在灰框内）。围栏行灰显
        //    语法标志（wysiwyg-code-fence span）且同挂代码排版行类（wysiwyg-code-line：
        //    0.9×预览字号 + 行高 1.8 + 左右内距，与内容行同参 → 盒内统一等宽排版）；
        //    内容行同挂排版行类，首/末内容行补 29px 顶/底内距（渲染态 pre 内距分解，
        //    见 styles.css 同名规则）。
        add(b.start, 0, first.length, 'wysiwyg-code-fence');
        const last = Math.min(b.end, cm.lineCount()) - 1;
        const hasClose = last > b.start && /^(`{3,}|~{3,})\s*$/.test((cm.getLine(last) || '').trim());
        if (hasClose) add(last, 0, (cm.getLine(last) || '').length, 'wysiwyg-code-fence');
        const contentEnd = hasClose ? last - 1 : last;
        this._wysiwygCodeLines = [];
        const codeCls = (lineNo) => {
          if (lineNo >= cm.lineCount()) return null;
          const h = cm.getLineHandle(lineNo);
          if (!h) return null;
          cm.addLineClass(h, 'text', 'wysiwyg-code-line');
          this._wysiwygCodeLines.push(h);
          return h;
        };
        codeCls(b.start); // 开围栏行进盒
        for (let lineNo = b.start + 1; lineNo <= contentEnd; lineNo++) {
          const h = codeCls(lineNo);
          if (!h) continue;
          if (lineNo === b.start + 1) cm.addLineClass(h, 'text', 'wysiwyg-code-pad-top');
          if (lineNo === contentEnd) cm.addLineClass(h, 'text', 'wysiwyg-code-pad-bottom');
        }
        if (hasClose) codeCls(last); // 闭围栏行进盒
        // 块底槽位（2026-10-22 用户要求「两个代码块挨着，第一个进编辑态底部与第二个紧密
        // 连在一起」）：渲染态遮罩是 flow-root BFC、含 pre 的 16px 底边距槽；编辑态活动块
        // 原无此槽 → 灰盒底缘贴下一块。块末行（闭围栏行；未闭合围栏时末内容行，与
        // pad-bottom 同行）挂 16px 底内距类，灰盒 ::before 底缘同步上移 16px（styles.css
        // wysiwyg-code-slot-bottom）→ 编辑态盒底↔下一块间距 ≡ 渲染态 16px。
        const slotH = cm.getLineHandle(last);
        if (slotH) cm.addLineClass(slotH, 'text', 'wysiwyg-code-slot-bottom');
      } else if ((RE.ul.test(first) || RE.ol.test(first) || RE.task.test(first)) &&
                 !RE.hr.test(first.trim())) {
        // —— 列表：逐行处理（含嵌套缩进行、续行）——
        // 块级排版行类（2026-10-15 用户反馈：编辑态须与阅读模式一致）：
        // 行类已有同字号/行高（wysiwyg-plain-text），此处补渲染态 ol/ul 的块级参数——
        // 项间距 4px（渲染 li margin-bottom）全列表行；缩进按行型分两种（渲染态正文
        // 统一在 ul/ol padding 缘=行基准+24px，源行 marker 宽度不同：16px 预览字号实测
        // 「- 」≈11px、「1. 」≈16px → ul +13px / ol +8px，两类正文都落回 56px 与渲染
        // 逐像素对齐；任务列表渲染 padding-left:0、复选框贴行首 → 不缩进）。
        const indentList = !RE.task.test(first) && (RE.ul.test(first) || RE.ol.test(first));
        const indentOlBlock = RE.ol.test(first);
        // 嵌套层级（2026-10-17 用户截图：列表有嵌套子项时两态不一致）——渲染态每层多一圈
        // padding-left:24px 且 marker 按层变（ul disc→circle→square→disc…；ol decimal
        // 「N.」→ paren-decimal「N)」），编辑态按层跟随：
        // ① 行前导缩进（源空格）→ 零宽槽 wysiwyg-list-space-zero（同 ol-space 机制）；
        // ② 行类 wysiwyg-list-lvl-N（N=2..6）→ padding-left 按层加 24px（CSS 分 ul 项/
        //    ol 续行/ol 项与任务行三口径）；
        // ③ ol 二级 marker：源「.」透明 + ::after 画「）」（渲染 paren-decimal）；
        //    三级 circled-decimal（①②…）暂不跟随（源数字无法按字形映射，保持源文）。
        // 层级判定：块内条目行缩进的升序去重序列 = 层级（良构列表每层一个缩进档）。
        const itemIndents = [];
        for (let ln = b.start; ln < b.end; ln++) {
          const l = cm.getLine(ln) || '';
          const mm = RE.task.exec(l) || RE.ul.exec(l) || RE.ol.exec(l);
          if (mm) itemIndents.push(mm[1].length);
        }
        itemIndents.sort((x, y) => x - y);
        const lvlSeq = [];
        for (const ind of itemIndents) if (lvlSeq[lvlSeq.length - 1] !== ind) lvlSeq.push(ind);
        const levelOf = (ind) => lvlSeq.indexOf(ind) + 1;
        let lastItemLvl = 1;
        for (let lineNo = b.start; lineNo < b.end; lineNo++) {
          if (lineNo >= cm.lineCount()) break;
          const line = cm.getLine(lineNo);
          if (line.trim() === '') continue;
          const taskM = RE.task.exec(line);
          const ulM = taskM ? null : RE.ul.exec(line);
          const olM = (taskM || ulM) ? null : RE.ol.exec(line);
          const indent = taskM ? taskM[1].length : ulM ? ulM[1].length : olM ? olM[1].length
            : ((line.match(/^\s*/) || [''])[0]).length;
          const lvl = (taskM || ulM || olM) ? levelOf(indent) : lastItemLvl;
          if (taskM || ulM || olM) lastItemLvl = lvl;
          const lh = cm.getLineHandle(lineNo);
          if (lh) {
            try {
              cm.addLineClass(lh, 'text', 'wysiwyg-list-line');
              if (ulM) cm.addLineClass(lh, 'text', 'wysiwyg-list-indent-ul');
              // ⚠️ ol 标记行**不挂** -indent-ol 行缩进：24px 右对齐 marker 槽
              // （wysiwyg-ol-marker inline-block）本身即渲染 ol 的 padding 区，正文落在
              // 行基准+24=li 内容缘；再叠加行缩进会把整行（含正文）推右——2026-10-16
              // 用户反馈「有序列表点入编辑态有向右偏移」的根因之一（旧 +8px 按
              // 「1. 」≈16px 估算，实测 16.48px → 正文偏右 0.48px、序号偏左 ~4px）。
              else if (!taskM && !olM && indentList) {
                // 续行：按块型跟随（渲染态续行正文在 li 内容缘）
                cm.addLineClass(lh, 'text', indentOlBlock ? 'wysiwyg-list-indent-ol' : 'wysiwyg-list-indent-ul');
              }
              // 续行（无 marker）：正文直接落 li 内容缘 = 行基准 + 24×层
              // （2026-10-17；前导缩进已零宽化，旧「+13/+8 + 源空格近似」废弃）
              if (!taskM && !ulM && !olM) cm.addLineClass(lh, 'text', 'wysiwyg-list-cont');
              // 嵌套层级行类（2026-10-17）：padding 按层固定 +24px/层，与源空格数无关
              // （见 CSS wysiwyg-list-lvl-N / wysiwyg-list-cont 口径）
              if (lvl > 1) cm.addLineClass(lh, 'text', 'wysiwyg-list-lvl-' + Math.min(lvl, 6));
              if (indent > 0) add(lineNo, 0, indent, 'wysiwyg-list-space-zero');
              (this._wysiwygListLines = this._wysiwygListLines || []).push(lh);
            } catch (_) { /* 忽略单行失败 */ }
          }
          let textStart = line.length;
          if (taskM) {
            const bulletAt = taskM[1].length;
            const boxAt = bulletAt + 1 + taskM[3].length;
            // 任务行渲染化（2026-10-17 用户截图：任务列表编辑态与渲染态不一致）：
            // bullet 字符单独进固定 24px 前缀槽（CSS .wysiwyg-task-prefix，= 渲染复选框
            // 16px + margin 8px），复选框画在槽左缘（left:0）→ 框恒落行基准 32px；
            // 「空格 + [ ]」进零宽槽（wysiwyg-task-box-zero，同 .wysiwyg-ol-space 机制）
            // → 正文恒落 56px，勾选/未勾选同位。旧「-2ch 偏移 + 框宽随 [x]/[ ] 变」
            // 在预览比例字体下框左漂 6.4px、勾选行正文右漂 4px（S51 实测）。
            // ⚠️ 24px 类不可挂「- [ ]」整段：CM5 会把同一装饰区间按语法 token 拆成多个
            // span（「- 」与「[ ]」是不同 token）→ 两个 24px 槽串联（48px、正文跳 80）。
            // bullet 单字符必为单 token → 24px 类只钉它；其余段零宽，拆几个 span 总宽
            // 都是 0。渲染预览里任务项 list-style:none，只有复选框（槽内字符全透明）。
            add(lineNo, bulletAt, bulletAt + 1,
              'wysiwyg-task-prefix' + (/[xX]/.test(line.charAt(boxAt + 1)) ? ' checked' : ''));
            add(lineNo, bulletAt + 1, boxAt + 3, 'wysiwyg-task-box-zero');
            textStart = boxAt + 3;
          } else if (ulM) {
            const bulletAt = ulM[1].length;
            add(lineNo, bulletAt, bulletAt + 1, 'wysiwyg-list-bullet');
            textStart = bulletAt + 1 + ulM[3].length;
          } else if (olM) {
            const numAt = olM[1].length;
            // 有序序号「1.」→ 24px 右对齐槽（见 CSS .wysiwyg-ol-marker）；源空格零宽
            // （.wysiwyg-ol-space）→ 正文恰好落在行基准+24=渲染 li 内容缘，与渲染态
            // 原生 outside marker 的右对齐口径一致（固定 24px 槽：多位数序号右缘对齐、
            // 正文恒 56px，长序号向左溢出行留白）。
            add(lineNo, numAt, numAt + olM[2].length + 1, 'wysiwyg-ol-marker');
            // ol 二级（嵌套）marker：渲染态 paren-decimal「N)」——源「.」透明 + ::after 画「)」
            // （2026-10-17；源本就是「)」时无需装饰）
            if (lvl === 2 && olM[3] === '.') {
              add(lineNo, numAt + olM[2].length, numAt + olM[2].length + 1, 'wysiwyg-ol-paren');
            }
            // 空有序项（正文空白）：零宽槽使行尾 caret 无盒可锚（rect 0×0 → 光标不可见，
            // 2026-10-31 用户截图）。空项挂例外类 wysiwyg-ol-space-empty（CSS 给 1px），
            // 输入首个字符后装饰重算 span 重建自动回落零宽（非空项正文紧贴槽右缘的
            // 像素口径不受影响）。
            const olItemText = line.slice(numAt + olM[2].length + 1 + olM[4].length);
            add(lineNo, numAt + olM[2].length + 1,
              numAt + olM[2].length + 1 + olM[4].length,
              'wysiwyg-ol-space' + (olItemText.trim() === '' ? ' wysiwyg-ol-space-empty' : ''));
            textStart = numAt + olM[2].length + 1 + olM[4].length;
          } else {
            // 续行（缩进延续）：正文段从首个非空白字符起（前导缩进保留）
            textStart = line.match(/^\s*/)[0].length;
          }
          add(lineNo, textStart, line.length, 'wysiwyg-list-text');
        }
      } else if (RE.quote.test(first.trimStart())) {
        // —— 引用（2026-10-20 用户要求：样式与渲染态完全一致，> 标志只在光标行显示）——
        // 逐行复现渲染 blockquote 几何（见 styles.css 同名规则注释）：每层 ">" **连同其后
        // 空格** → 固定 24px 槽（渲染缩进 = border 4 + padding 20；左竖条画在槽 ::before
        // 上、逐行顶满 → 连续竖条）。空格必须进槽、不能单独零宽：零宽 span 位于行尾时
        // Chromium 的 caret 锚定会把 DOM 差分写乱（2026-10-20 实测："> " 续行键入 CJK，
        // 源空格被挤到行尾、模型变 ">继续内容 "，与空列表项 IME 上屏同源，但走普通
        // insertText 通道也复现）；槽是 24px 真宽盒，行尾 caret 锚定稳定。
        // 正文 → 预览字体 + 次级色。行类 wysiwyg-quote-line/nested 管淡色背景盒与
        // 边缘/嵌套 padding；> 字符默认透明，仅光标行可见（wysiwyg-quote-cursor-line，
        // cursorActivity 管理，_wysiwygQuoteCurLine）。
        // callout 类型（2026-10-30 用户图1）：类型色 --qc-bg/--qc-bar 须落到块内**所有**
        // raw 行（CSS 类型选择器已放宽到非光标行，见 styles.css 同名规则）——此前只有光标行
        // 有类型色，raw 区其余行回落 accent-subtle，同一盒内深浅不一。从块首行 `> [!TYPE]` 现判。
        const calloutM = /^\s*(?:>[ \t]?)*\[!([A-Za-z]+)\]/.exec(cm.getLine(b.start) || '');
        const calloutType = calloutM
          && ['note', 'tip', 'important', 'warning', 'caution'].includes(calloutM[1].toLowerCase())
          ? calloutM[1].toLowerCase() : null;
        for (let lineNo = b.start; lineNo < b.end && lineNo < cm.lineCount(); lineNo++) {
          const line = cm.getLine(lineNo);
          if (!line) continue;
          // 空引用行（`>` 或 `> `，2026-10-30 用户图3）也挂行类：底色盒在 raw 区连续 +
          // callout 类型色不断档；纯空行维持原「不装饰」口径。
          const blankQuote = line.trim() === '';
          if (blankQuote && !/^\s*>/.test(line)) continue;
          const qm = /^(\s*(?:>[ \t]?)+)/.exec(line);
          if (!qm) continue;
          // 2026-10-28 用户要求：嵌套引用光标行只显一个 >（当前编辑的引用块 = 最内层），
          // 外层每层的 > 不再重复显示。最内层槽额外挂 wysiwyg-quote-slot-inner 标记，
          // 光标行显色规则（styles.css）只认这个标记 → 单层行行为不变（唯一槽即最内层）。
          const lvlCount = (qm[1].match(/>/g) || []).length;
          let qTask = null;
          if (!blankQuote) {
          let level = 0, pos = 0;
          while (pos < qm[1].length) {
            const gt = line.indexOf('>', pos);
            if (gt < 0 || gt >= qm[1].length) break;
            level++;
            let end = gt + 1;
            if (line[end] === ' ' || line[end] === '\t') end++; // 空格进槽（caret 锚定，见上）
            add(lineNo, gt, end, 'wysiwyg-quote-slot' + (level === lvlCount ? ' wysiwyg-quote-slot-inner' : ''));
            pos = end;
          }
          add(lineNo, qm[1].length, line.length, 'wysiwyg-quote-text');
          // —— 引用内嵌套任务列表（2026-10-25 用户截图「引用块嵌套任务列表还是显示源码，
          //    参考任务列表的实现方式」）：引用行此前只装饰 `> ` 槽，行内 `- [x] ` 段无任何
          //    装饰 → 光标行（源码行）裸露「> - [x] 正文」，而独立任务列表块走上方列表分支、
          //    复选框恒渲染。剥掉 `> ` 前缀后的剩余文本按 RE.task 匹配时，挂与列表分支
          //    **同一组**装饰（位置整体右移 prefixLen）：bullet 单字符 → 24px 槽（::before
          //    画复选框，恒渲染、可点），「空格 + [ ]」→ 零宽槽。24px 只钉单字符的原因同
          //    列表分支（CM5 token 拆分下整段会拆成两个槽）。几何上天然对齐渲染态：
          //    `> ` 槽 24px = blockquote 缩进（border 4 + padding 20），task 槽 24px =
          //    li 复选框 16 + margin 8 → 正文落 48px，与渲染 li 正文同位。非光标行被
          //    分段遮罩盖住，装饰无碍；光标离开后 span 随文本保留，重算时自动重建。
          //    点击勾选走 wrapper 全局委托 _ensureWysiwygTaskBoxClick（引用行同样命中），
          //    回写靠 _wysiwygToggleTaskLine 的引用前缀扩展。
          //    2026-10-30 用户图5：行命中 RE.task 时另挂 wysiwyg-quote-task-line 行类，
          //    CSS 光标态隐藏 `>` 槽文字（渲染 li 无 >，槽保留 24px 占位、checkbox 不动）。
          const restAfterQuote = line.slice(qm[1].length);
          qTask = RE.task.exec(restAfterQuote);
          if (qTask) {
            const qOff = qm[1].length;
            const qBulletAt = qOff + qTask[1].length;
            const qBoxAt = qBulletAt + 1 + qTask[3].length;
            add(lineNo, qBulletAt, qBulletAt + 1,
              'wysiwyg-task-prefix' + (/[xX]/.test(line.charAt(qBoxAt + 1)) ? ' checked' : ''));
            add(lineNo, qBulletAt + 1, qBoxAt + 3, 'wysiwyg-task-box-zero');
          }
          }
          const h = cm.getLineHandle(lineNo);
          if (h) {
            cm.addLineClass(h, 'text', 'wysiwyg-quote-line');
            if (lvlCount >= 2) cm.addLineClass(h, 'text', 'wysiwyg-quote-nested');
            // 嵌套层级类（2026-10-28）：中间行光标行按层级画渲染同构的逐层底色/全高竖条
            // （styles.css wysiwyg-quote-lvl-N 规则）。先清后挂：层级升降（增/删一层 >）
            // 须换掉旧类；封顶 6（同列表 wysiwyg-list-lvl-N 口径）。
            for (let n = 2; n <= 6; n++) cm.removeLineClass(h, 'text', 'wysiwyg-quote-lvl-' + n);
            if (lvlCount >= 2) cm.addLineClass(h, 'text', 'wysiwyg-quote-lvl-' + Math.min(lvlCount, 6));
            // callout 类型行类（2026-10-30）：先清后挂——类型改写（[!NOTE]→[!TIP]）或退化
            // 为普通引用时换装。与 sync 光标行差分（_setWysiwygCalloutCurClass）叠加不冲突：
            // 本处同 tick 后跑、净效果一致，且不动 wysiwyg-callout-cursor-line 专用类。
            for (const t of ['note', 'tip', 'important', 'warning', 'caution']) {
              cm.removeLineClass(h, 'text', 'wysiwyg-callout-' + t);
            }
            if (calloutType) cm.addLineClass(h, 'text', 'wysiwyg-callout-' + calloutType);
            // 引用内任务行标记（2026-10-30 图5）：先清后挂（行改写离开任务语法须撤）。
            cm.removeLineClass(h, 'text', 'wysiwyg-quote-task-line');
            if (qTask) cm.addLineClass(h, 'text', 'wysiwyg-quote-task-line');
            // callout 光标行类（2026-10-25 分段口径）不再在此挂：激活时 _wysiwygApplyActiveDecor
            // 的 curLine 是旧光标（未落目标行），判不准 → 改由 syncWysiwygActiveBlock 现算
            // 路径 _setWysiwygCalloutCurClass 管理（与 _wysiwygQuoteCurLine 同机制）。
          }
        }
      }
      // —— 行内语法（2026-10-14 用户要求，Typora 式）：围栏/表格/frontmatter 之外的块，
      //    逐行 parseWysiwygInlineSpans 挂「标记透明 + 文本渲染」span（可嵌套在上面的
      //    块级 span 内，markText 允许重叠）。行不再成对 → 下次重算自动去样式。
      const isFenceBlock = RE.fence.test(first.trim());
      const isTableBlock = !isFenceBlock && RE.table.test(first);
      const isFrontmatter = b.start === 0 && (first || '').trim() === '---';
      // 折叠区块（2026-10-22）：整块灰盒见 _applyWysiwygActiveHighlight；源文行挂
      // wysiwyg-details-line（左右 12px 内距，源码文字不贴盒竖边；不挂 code-line，
      // 保持默认正文字族）。判定与高亮处同口径（块首行 <details 标签，共用 RE.detailsOpen）。
      const isDetailsBlock = !isFenceBlock && !isTableBlock && RE.detailsOpen.test(first || '');
      // HTML 容器块（2026-10-25，同 isDetailsBlock 的判定收口）：源文行挂
      // wysiwyg-html-block-line（与 wysiwyg-details-line 共享同一条 CSS 声明：左右 12px
      // 内距，源码文字不贴盒竖边）。
      const isHtmlContainerBlock = !isFenceBlock && !isTableBlock && !isDetailsBlock && isHtmlBlockContainerLine(first);
      if (!isFenceBlock && !isTableBlock && !isFrontmatter) {
        for (let lineNo = b.start; lineNo < b.end && lineNo < cm.lineCount(); lineNo++) {
          const line = cm.getLine(lineNo);
          if (!line) continue;
          const sps = parseWysiwygInlineSpans(line);
          for (let k = 0; k < sps.length; k++) add(lineNo, sps[k].from, sps[k].to, sps[k].cls);
        }
        // —— 正文排版对齐渲染态（2026-10-14 用户要求：编辑时样式要与渲染时一样）：
        //    围栏/表格/frontmatter 之外的块（段落/列表/引用/标题）逐行挂「预览字族 +
        //    渲染字号/行高/颜色」行类（与遮罩 .wysiwyg-block-mask.preview-content 同参：
        //    --font-preview、行高 1.7、--text-primary、字号=用户「预览字号」设置，
        //    经 --wysiwyg-text-size 同步）。标题/列表符号/行内 span 的 em 系尺寸以此为
        //    基准，挂上后即与渲染态同字号；行高一致也使块「渲染↔源文」切换高度不变。
        this._wysiwygPlainLines = [];
        for (let lineNo = b.start; lineNo < b.end && lineNo < cm.lineCount(); lineNo++) {
          try {
            // 块内空行（松散列表项间空行等）不挂：本类行高 1.7 特异性高于空行塌缩规则
            //（.CodeMirror .cm-wysiwyg-blank .CodeMirror-line 12px），挂了会把空行撑回
            // 全高 → 列表编辑态「多出来很多空白行」（2026-10-14 用户截图）。
            // 空引用行例外（2026-10-30 用户图3）：引用分支已给它挂 quote-line/类型行类
            // （底色盒连续），这里只补**跟踪**（不挂 wysiwyg-plain-text，保空行塌缩高度）
            // → 离开块时清理路径能把这些行类撤净。
            if ((cm.getLine(lineNo) || '').trim() === '') {
              if (/^\s*>/.test(cm.getLine(lineNo) || '')) {
                const blankH = cm.getLineHandle(lineNo);
                if (blankH) this._wysiwygPlainLines.push(blankH);
              }
              continue;
            }
            const h = cm.getLineHandle(lineNo);
            if (h) {
              cm.addLineClass(h, 'text', 'wysiwyg-plain-text');
              if (isDetailsBlock) cm.addLineClass(h, 'text', 'wysiwyg-details-line');
              else if (isHtmlContainerBlock) cm.addLineClass(h, 'text', 'wysiwyg-html-block-line');
              this._wysiwygPlainLines.push(h);
              // 块边缘行类（S43 块高补齐用）：首/末行挂标记，CSS 给「14px 边距族」
              // （列表行/段落行）的边缘行加顶/底距，使活动块与遮罩逐像素等高。
              // 不用 cm-wysiwyg-active-first/last——那对非容器块只挂光标行（lo=hi），
              // 不是块边缘。标题/引用行虽也挂边类，但 CSS 不对其加距（边距参数不同）。
              if (lineNo === b.start) cm.addLineClass(h, 'text', 'wysiwyg-block-edge-top');
              // 列表逐项块（2026-10-21）：14px 列表底距（edge-bottom → pb 14）只归属列表
              // **末项**；非末项底缘 = 项间距 4px（wysiwyg-list-line 默认底距）。非末项若
              // 挂 edge-bottom，其编辑态源行比遮罩片段高 10px → 切项解/挂遮罩时页面跳 10px。
              if (lineNo === b.end - 1 && !(b.listItem && b.listItemPos !== 'last')) {
                cm.addLineClass(h, 'text', 'wysiwyg-block-edge-bottom');
              }
              // S43（2026-10-15 用户截图：点块进编辑「内容向上动一下」）：遮罩高度含
              // 渲染元素自身 margin-bottom（ul/ol/p = 14px；> *:last-child 清零规则
              // 被 block-edit-btn 按钮占了 last-child 位而失效）+ 遮罩 padding 1+2 +
              // border-bottom 1；编辑态行盒没有这些 → 活动块比遮罩矮 17px、首行还高
              // 1px（遮罩 padding-top）→ 点入后下方整体跳 17px。段落行（14px 边距族：
              // p/ul/ol 正文行，含列表续行）挂本行类，由 CSS 首行 +1px（顶）/末行
              // +17px（底）补齐，活动块与遮罩逐像素等高。标题（24/12 边距）/引用块
              // 参数不同，不在本次范围。
              const content = cm.getLine(lineNo) || '';
              // 定义列表（2026-10-18 用户截图：编辑态 `: ` 冒号裸露、无缩进、dt 不加粗、
              // 点 dd 行落 dt 行）：行首 `: `/孤 `:` = dd 行（同 unified-renderer
              // convertDefLists 口径），非 dd 行且下一行是 dd = dt 行。行类复现渲染态
              // 指标（见 styles.css 同名规则）：dt 粗 600 + 块首行 8px 顶距，dd 24px 左
              // 缩进 + 次级色 + 8px 底距（块末行 16px）；`: ` 前缀透明 span（保留真实
              // 宽度，光标测量精准，同列表符号教训）。
              const isDd = /^(: |:$)/.test(content);
              const isDt = !isDd && content.trim() !== ''
                && /^(: |:$)/.test(lineNo + 1 < cm.lineCount() ? (cm.getLine(lineNo + 1) || '') : '');
              if (isDt) cm.addLineClass(h, 'text', 'wysiwyg-dt-line');
              if (isDd) {
                cm.addLineClass(h, 'text', 'wysiwyg-dd-line');
                add(lineNo, 0, content.charAt(1) === ' ' ? 2 : 1, 'wysiwyg-dd-colon');
              }
              // 列表行判定直接读 CM5 行对象真实属性（line.textClass，见 codemirror.js
              // addLineClass/changeLine）：上方列表分支刚挂的 wysiwyg-list-line（含续行）
              // 就在本行对象上。旧按行号查 _wysiwygListLines 在分行/位移后失配（2026-10-17
              // 灰色条修复同步把跟踪改为行对象）；读不存在的 lineClasses 字段会 undefined
              // 抛错被吞（2026-10-15 实测：para-line 全漏挂）。
              const isListLine = (h.textClass || '').indexOf('wysiwyg-list-line') !== -1;
              if (!isListLine
                  && !isDt && !isDd
                  && !RE.heading.test(content)
                  && !RE.quote.test(content.trimStart())
                  && !RE.setext.test(content)
                  && !RE.indentedCode.test(content)
                  && !RE.fence.test(content)
                  && !RE.hr.test(content)) {
                cm.addLineClass(h, 'text', 'wysiwyg-para-line');
              }
            }
          } catch (_) { /* 忽略 */ }
        }
      }
      this._wysiwygActiveDecor = markers.length ? markers : null;
    },

    // 编辑态正文字号同步：渲染态遮罩复制 #preview 的计算字号（用户「预览字号」设置，
    // 默认 16px，含缩放），活动块源文行必须同字号才「编辑=渲染」。把当前值写到 CM
    // 容器变量 --wysiwyg-text-size（.wysiwyg-plain-text 消费）；仅在变化时写，避免
    // 每次光标移动都触发样式重算。harness 无 #preview 时回落 settings/16px。
    _syncWysiwygTextSize() {
      try {
        const cm = this.cm;
        if (!cm || !cm.getWrapperElement) return;
        let size = '';
        try {
          if (this.preview && window.getComputedStyle) {
            const cs = getComputedStyle(this.preview);
            if (cs && cs.fontSize) size = cs.fontSize;
          }
        } catch (_) { /* 预览元素不可用 */ }
        if (!size && this.settings && this.settings.previewFontSize) size = this.settings.previewFontSize + 'px';
        if (!size) return;
        const wrap = cm.getWrapperElement();
        if (wrap && wrap.style.getPropertyValue('--wysiwyg-text-size') !== size) {
          wrap.style.setProperty('--wysiwyg-text-size', size);
        }
      } catch (_) { /* 不阻断装饰 */ }
    },

    // change 钩子：编辑交叠活动块时按当前行文本重算装饰。CM 标记随编辑自动扩缩，
    // 但语法变化（# 增减、- 删除/添加、围栏开关、勾选态翻转、换行拆分）须整体重算。
    // IME 组合期顺延到 compositionend 后的防抖刷新尾，不打断输入。
    _ensureWysiwygActiveDecorHook() {
      if (this._wysiwygActiveDecorHooked || !this.cm) return;
      this._wysiwygActiveDecorHooked = true;
      const self = this;
      this.cm.on('change', (cm, c) => {
        if (self.viewMode !== 'wysiwyg' || self._wysiwygComposing) return;
        if (!c || !c.from || !c.to) return;
        const idx = self._wysiwygActiveIdx;
        if (idx == null || idx < 0) return;
        const b = self._wysiwygBlocks && self._wysiwygBlocks[idx];
        if (!b) return;
        // 行号增减（回车/多行粘贴/删行）→ 即时修补块表行号（O(块数)，免重解析）：围栏块内
        // 增行会把闭围栏行号往下推，250ms 防抖窗口内灰盒/装饰若仍按陈旧范围跑，闭围栏就
        // 露在灰盒外——用户看到的「``` 跑到灰色代码块外闪一下又恢复」的根因（2026-10-25
        // 用户截图反馈）。修补后 250ms 防抖重解析照常收敛（幂等）。
        // ⚠️ 闭围栏行下方回车新增的行属块外（markdown 结构上不属于围栏），不扩围栏块
        // 范围（块表保持真实）；该行按块间空行普通口径处理，代码块经正常活动块切换
        // 重新遮罩（2026-10-25 用户口径：尾部 ``` 后回车跳出灰盒）。
        const delta = c.text.length - 1 - (c.to.line - c.from.line);
        if (delta !== 0 && self._wysiwygPatchBlockTableForChange(c, delta)) self._applyWysiwygActiveHighlight();
        // 引用块 end 同步（同围栏 end 扩展的口径，2026-10-25 分段口径配套）：末行之后
        // 新增的行仍是引用行（回车自动 `> ` 续行 / 粘贴引用段落）→ end 即时扩展。不扩展
        // 则分段重挂判「光标在块外」清退分段 → 整块闪回源码 250ms（与围栏闪出同根因）。
        if (delta > 0 && self._wysiwygBlockIsQuote(b) && c.to.line === b.end - 1) {
          let ext = 0;
          for (let i = 0; i < delta && b.end + i < cm.lineCount(); i++) {
            if (RE.quote.test((cm.getLine(b.end + i) || '').trimStart())) ext++;
            else break;
          }
          if (ext > 0) b.end += ext;
        }
        if (c.from.line < b.end && c.to.line >= b.start) self._wysiwygApplyActiveDecor(idx);
        // 引用/提示块活动态（渲染分段 + 光标行源码）：行号/文本变化后重算分段边界
        //（内部幂等：范围与源文未变即 no-op；光标离块 → 清退）
        if (self._wysiwygBlockIsQuote(b)) self._wysiwygApplyQuoteSegments();
      });
    },

    // 行号增减变化后的块表行号修补（O(块数)，免重解析；2026-10-25「代码块内输入时 ``` 闪出
    // 灰盒」修复的配套）：
    //  · 变更行严格在本块上方、或恰在块首行行首（新行落在块首行之前 → 整块下移）：
    //    start/end 整体位移 delta（块身份不变，遮罩 marks 由 CM 自动跟行，
    //    data-block-index 不变 → 仅行号字段更新）；
    //  · 变更点落在某围栏块内（含块首行行内——开围栏行尾回车的新行属围栏内容）：
    //    变更点在闭围栏行之前、或恰在闭围栏行行首（行首回车的新行仍属围栏内容）→
    //    end += delta；
    //  · 变更点在闭围栏行行内/行尾（含闭围栏行下方回车的新行，属块外）或块尾之后：
    //    块范围不变（块表保持真实，块外行按普通口径处理）；
    //  · 非围栏块的范围不即时修（类型边界判断贵，250ms 防抖窗口的既有
    //    _wysiwygBlockIndexAtFresh 即时重切机制照旧兜底，行为不变）。
    // 250ms 防抖重解析随后照常跑，本修补只是消除窗口内的陈旧范围（幂等、可被覆盖）。
    _wysiwygPatchBlockTableForChange(c, delta) {
      const cm = this.cm;
      const blocks = this._wysiwygBlocks;
      if (!cm || !blocks) return false;
      let changed = false;
      for (const blk of blocks) {
        if (blk.start > c.from.line || (blk.start === c.from.line && c.from.ch === 0)) {
          blk.start += delta;
          blk.end += delta;
          // 整块被删（文档缩小）时 start 可能移成负数 / end 越过新行数：
          // getLine(-n) 返回 undefined → _wysiwygApplyActiveDecor 的 first.trim() 崩溃
          // （2026-10-24 真机取证：活动块 [0,1) 时从块首行行首整体删除 → 块表 [[-2,1]]，
          // 既有 b.start >= lineCount 守卫拦不住负数）。钳回合法区间；陈旧块由 250ms
          // 防抖重解析收敛（幂等）。
          blk.start = Math.max(0, Math.min(blk.start, cm.lineCount()));
          blk.end = Math.max(blk.start, Math.min(blk.end, cm.lineCount()));
          changed = true;
        } else if (c.from.line >= blk.start && c.from.line < blk.end) {
          const first = cm.getLine(blk.start) || '';
          if (!RE.fence.test(first.trim())) continue;
          const extendEnd = c.from.line < blk.end - 1 || (c.from.line === blk.end - 1 && c.from.ch === 0);
          if (extendEnd) { blk.end += delta; changed = true; }
        }
      }
      return changed;
    },

    // ---------------- 活动块切换（增量） ----------------

    // 跨块时只处理「旧块恢复遮罩 + 新块撤遮罩」两个块。
    // ⚠️ 绝不可在此做全量重建：曾因每次光标移动触达都全量 clear+重渲染所有块，
    //    造成严重抖动与卡顿（2026-10-06 真机反馈）。
    setWysiwygActiveBlock(idx) {
      // 有格正在源码编辑（表格块仍是遮罩态，不在 prev/idx 里）：登记**下一 tick** 提交。
      // 本方法常由 cursorActivity 调起（CM 的 mousedown operation 内），同步 replaceRange
      // + 重挂遮罩会毁掉 CM 操作还要移动的节点 → NotFoundError（2026-10-13 用户报
      // 「改表格单元格内容时出现报错」）。需要同步提交的场景不受影响：若新活动块正是
      // 在编格所在的表块，unmaskWysiwygBlock 的守卫会在撤罩前同步提交（编辑格 DOM 将被
      // 撤罩销毁），此处的延迟提交届时为 no-op（状态已被守卫清掉）。
      if (this._wysiwygCellEditing) {
        const self = this;
        const cell = this._wysiwygCellEditing.cell;
        setTimeout(() => {
          const st2 = self._wysiwygCellEditing;
          if (!st2 || st2.cell !== cell) return;
          // 延迟 tick 里焦点仍在原格：cursorActivity 是误触发（如 CM 内部刷新带来的
          // 光标事件），继续编辑不提交（防打字到一半被提交、光标跳走）
          try { if (document.activeElement === cell) return; } catch (_) { }
          self._wysiwygEndCellEdit(true);
        }, 0);
      }
      const prev = this._wysiwygActiveIdx;
      if (prev === idx) {
        // ⚠️ 点击锚定必须在这里也消费掉，不能随同 idx 直接 return。
        // 残留的 _wysiwygClickAnchor 会污染下一次普通光标移动：
        // _captureWysiwygAnchor 见它存在而跳过采样，_restoreWysiwygAnchor 却拿陈旧点击
        // 坐标做滚动 → 视口跳到无关位置（2026-10-07 真机反馈「点击后屏幕乱跳」的成因之一）。
        this._restoreWysiwygAnchor();
        // 行号可能已位移（同块内编辑）：高亮跟着重挂，保证底色始终盖在当前块上
        this._applyWysiwygActiveHighlight();
        // 遮罩集合未变但选区覆盖判定的行号基准可能位移（同块内编辑），补刷选中着色
        this._applyWysiwygSelectionMaskClasses();
        return;
      }
      this._captureWysiwygAnchor();
      // ⚠️ 锚点补偿只在真做了挂/撤遮罩工作时执行（2026-10-18 套件回归 S54B）：
      // 幻影切换（如新实例首个 cursorActivity：prev=undefined、idx=-1，两端皆 no-op）
      // 结构未变，而 operation 内采样的 before 是未落定的陈旧几何（cursorCoords 滞后），
      // 延迟到 operation 末用已落定的 after 相减 → 虚假 delta（实测 24px）把视口滚偏、
      // 点击落点错位。HEAD 同步路径「前后同一套陈旧几何」相减≈0 才侥幸无事。
      const hadPrev = prev >= 0;
      if (hadPrev) {
        // 活动引用块的分段遮罩先清（与整块重遮的 mark 区间重叠，2026-10-25 分段口径）
        this._wysiwygClearQuoteSegments();
        // 旧块刚被编辑过，缓存 html 过期，需重渲
        const b = this._wysiwygBlocks && this._wysiwygBlocks[prev];
        if (b && b.html !== undefined) { b.html = this.renderWysiwygBlockHtml(b.start, b.end); b.finalHtml = false; b.src = this._wysiwygBlockSource(b); }
        this.maskWysiwygBlock(prev);
      }
      const hadIdx = idx >= 0;
      if (hadIdx) this.unmaskWysiwygBlock(idx);
      this._wysiwygActiveIdx = idx;
      // 引用/提示块活动态分段遮罩（2026-10-25）：在锚点 restore **之前**挂——分段几何
      // 变化纳入同一次补偿（cursorActivity 路径无点击锚点时走 capture/restore 差值）。
      if (hadIdx) this._wysiwygApplyQuoteSegments();
      if (hadPrev || hadIdx) this._restoreWysiwygAnchor();
      else this._wysiwygAnchorY = null; // 幻影切换：丢弃陈旧采样，不做补偿
      // 活动块源文态装饰（Typora 式：标题#/列表符号/代码围栏）：清旧 + 按新活动块重挂
      // （普通段落等无装饰块为纯清理，no-op）
      this._wysiwygApplyActiveDecor(idx);
      // 撤旧块（prev）行的高亮、给新活动块行挂高亮（一次调用同时完成两端）
      this._applyWysiwygActiveHighlight();
      // 旧块刚重挂遮罩：跨块选区可能正覆盖它，补刷选中着色
      this._applyWysiwygSelectionMaskClasses();
    },

    // 按光标行现算活动块（供结构刷新路径调用：拖拽提交/增行增列重渲、防抖重算、全量
    // 增量刷新）。**已挂遮罩的块不得「激活」**：光标可能正被 reCheckSelection 钳在
    // 某遮罩块内（格编辑期间被钳到旧活动块末行），现算激活它会解罩回源码态
    // （2026-10-14 用户截图「点表格后下面一行还是源代码状态」的重犯路径之一）。
    _wysiwygActiveIdxFromCursor(oldBlocks) {
      const cm = this.cm;
      if (!cm) return -1;
      const line = cm.getCursor().line;
      // ⚠️ 「钳光标在遮罩块内」判定必须用**与 this._wysiwygMarks 同键的块表**（刷新路径传
      // oldBlocks = 旧表 + 旧 marks 配套）。旧实现拿新表索引查旧 marks：新旧表形状不同
      // 时，光标行的**新**索引会与**另一**旧遮罩块的旧索引撞车 → 正在编辑的块（如空行上
      // 新切出的标题块）被误判「已挂遮罩」→ -1 → 活动块被重遮成渲染态、字号跳变
      // （2026-10-19 用户反馈 #2「输入标题字号先缩后胀」的成因之一，空行标题场景实测复现）。
      if (oldBlocks && this._wysiwygMarks) {
        const obi = this.wysiwygBlockIndexAt(line, oldBlocks);
        if (obi >= 0 && this._wysiwygMarks.has(obi)) return -1;
      }
      return this.wysiwygBlockIndexAt(line);
    },

    // ---------------- 跨块选区视觉（2026-10-16 用户反馈「全选/选中只看到当前块」） ----------------
    // CM5 只给可见源码行画选框；遮罩（replacedWith widget）节点永远没有选中态 →
    // 跨块选区看起来像「只选中了当前编辑的一小块」。补齐：选区**完整覆盖**的遮罩块
    // 给遮罩节点挂 wysiwyg-mask-selected（CSS 半透明着色）。覆盖判据
    // range.from ≤ mark.from && mark.to ≤ range.to：atomic 标记本就不可被部分选中
    // （端点被 skipAtomic 钳到遮罩边界），遮罩只有「整块被盖」或「完全不盖」，
    // 该判据天然成立。调用点：selection 事件（每次选区变化）+ 各遮罩挂/撤路径
    // （setWysiwygActiveBlock / renderWysiwygMasks / 增量刷新——遮罩变化不触发
    // selection 事件，必须显式补刷）。
    _applyWysiwygSelectionMaskClasses() {
      const cm = this.cm;
      if (!cm || !this._wysiwygMarks) return;
      const ranges = cm.listSelections();
      const le = (a, b) => a.line < b.line || (a.line === b.line && a.ch <= b.ch);
      // 分段遮罩（引用活动态，2026-10-25）与整块遮罩同口径着色
      const allMarks = Array.from(this._wysiwygMarks.values());
      if (this._wysiwygSegMarks) allMarks.push(...this._wysiwygSegMarks);
      for (const mark of allMarks) {
        const node = mark && mark.replacedWith;
        if (!node) continue;
        let f = null;
        try { f = mark.find(); } catch (_) { continue; }
        if (!f) continue;
        let covered = false;
        for (const rg of ranges) {
          if (le(rg.from(), f.from) && le(f.to, rg.to())) { covered = true; break; }
        }
        if (node.classList) node.classList.toggle('wysiwyg-mask-selected', covered);
      }
    },

    // 选区变化接线（幂等；与 _ensureWysiwygTableClickGuard 同模式）。
    // ⚠️ CM5 **没有 'selection' 事件**（on 未知事件名静默不触发，2026-10-16 实测
    // S49 着色恒 0 的根因）——选区每次变化必触发 cursorActivity（含鼠标拖选），
    // 挂 cursorActivity 即等价。
    _ensureWysiwygSelectionHook() {
      if (this._wysiwygSelectionHooked || !this.cm) return;
      this._wysiwygSelectionHooked = true;
      const self = this;
      this.cm.on('cursorActivity', () => { self._applyWysiwygSelectionMaskClasses(); });
    },

    syncWysiwygActiveBlock() {
      if (this.viewMode !== 'wysiwyg' || !this.cm) return;
      // 跨块选区拖拽进行中：冻结活动块切换。
      // 拖选 setSelection 的 head 会扫过各遮罩边界，若照常同步，指针下的块被解罩、
      // 遮罩行消失行高变化 → 鼠标相对行几何漂移，拖选中途即断（2026-10-16 跨块选区）。
      // 两条拖选路径都要冻：① 遮罩 mousedown 自管的拖选（_wysiwygSelDragging 置位）；
      // ② CM 原生鼠标拖选（leftButtonSelect 期间 cm.state.selectingText 非空）——
      // 从活动块真实行起拖时走 CM 自己的 extend/move，同样会扫过遮罩行。
      // ⚠️ ②只在选区**非折叠**时冻：普通单击的 mousedown→mouseup 窗口内 selectingText
      // 同样非空，但选区是折叠的——照常同步才能让光标行的灰底/高亮跟着点（S14 回归点）；
      // 跨块拖选必然产生非折叠选区，冻结条件天然成立。释放后选区即用户意图，活动块
      // 归位到光标（选区头）所在块（2026-10-21 逐项切块后口径：「光标行显示源码」）：
      // ① 由遮罩 mousedown 的 onUp 同步、② 由 _ensureWysiwygSelEndSync 的 pointerup
      // 延时同步——两条路径释放时 CM 都无新选区变化，不补同步活动块会停在拖选起始行。
      // 拖选冻结前先登记「释放后归位」（2026-07-13）：跨行拖选 mouseup 时 CM 常无新
      // 选区变化（head 已在末次 move 落位）→ 无末次 cursorActivity → 行内标记行类会
      // 停在拖选起始行（S66 跨行拖选断言抓出）。
      if (this._wysiwygSelDragging) { this._ensureWysiwygSelEndSync(); return; }
      if (this.cm.state && this.cm.state.selectingText) {
        const pr = this.cm.listSelections()[0];
        if (pr && !pr.empty()) { this._ensureWysiwygSelEndSync(); return; }
      }
      // 格编辑进行中：焦点在格内 contenteditable，任何 CM 块都不该保持源码态。进格编辑
      // 重遮罩旧块时，被钳制光标（reCheckSelection 推到块末行、仍在块内）会触发本同步——
      // 必须在此拦下，否则刚遮的块被重新解罩回源码态（2026-10-14 用户截图「点表格后
      // 下面一行还是源代码状态」的连锁一环）。收尾 settle 在状态清空后才落光标，
      // 届时本守卫不再拦，活动块照常按光标行现算。
      if (this._wysiwygCellEditing) { this._restoreWysiwygAnchor(); return; }
      if (!this._wysiwygBlocks) this._wysiwygBlocks = this.computeWysiwygBlocks();
      const line = this.cm.getCursor().line;
      // 光标落在空行（2026-10-17 两级语义，2026-10-21 修订）：
      //  · 块内空行（活动块内部，如松散列表项间）：临时恢复全高（光标与「输入 /
      //    可插入内容…」提示需要可见），离开后收回塌缩态；
      //  · 块间独立空行：光标**不在其上**时保持塌缩（点击行与行之间的缝隙不允许出现
      //    「新行」——不创建行，行计数不变，回车才出新行，2026-10-17）；光标**在其上**
      //    时同样恢复全高（2026-10-21 用户要求：图片上方回车新增的行需要灰色明确指示
      //    当前编辑行——0px 塌缩态灰底/光标不可见、cursorCoords 退化，锚定补偿会测出
      //    垃圾差值放大视口跳）。两种空行的光标行都不显示空行提示（empty-hint.js 口径不变）。
      const prevCur = this._wysiwygBlankCurLine;
      if (prevCur != null && prevCur !== line) {
        const blanks = this._wysiwygBlankLines;
        // 光标行因「光标例外」不在集合里（updateWysiwygBlankLines 现算时排除当前光标行）
        // → 集合成员判定恒 false，离开后该行会一直展开到下次输入防抖。补「现在仍是空行」
        // 判定：光标离开即收回塌缩（类 + 间隙表 inline，下方照旧）；期间被输入成非空行
        // 则不收回（已是正文行）。
        let recollapse = !!(blanks && blanks.has(prevCur));
        if (!recollapse) { try { recollapse = this._isWysiwygBlankLine(prevCur); } catch (_) { recollapse = false; } }
        this._setWysiwygBlankClass(prevCur, recollapse);
        // 间隙表 inline 高度随光标离开恢复（2026-10-20）：光标在块内空行上时该行的
        // inline 高度被清除（恢复全高）；离开时按间隙表恢复（块内列表 0px / 块间 Xpx）
        //——间隙表只在输入防抖重算，纯光标移动必须在此落地（渲染行已物化，恒等匹配取 pre）
        const m = this._wysiwygBlankGap;
        if (m) {
          let ph = null;
          try { ph = this.cm.getLineHandle(prevCur); } catch (_) { /* 行已销毁 */ }
          this._applyWysiwygBlankGapEl(this._wysiwygLinePreOf(prevCur), ph ? m.get(ph) : undefined);
        }
      }
      const lineBlockIdx = this.wysiwygBlockIndexAt(line);
      // 块内/块间空行同口径（2026-10-21 修订）：光标所在空行即恢复全高（原
      // lineBlockIdx >= 0 限制只豁免块内空行，块间空行光标行停在 0px 塌缩态 → 无灰底
      // 指示、光标坐标退化，2026-10-21 用户报「图片上方回车新增行没有灰色明确指示」）
      if (this._isWysiwygBlankLine(line)) {
        this._setWysiwygBlankClass(line, false);
        // 进入即清除 inline 高度：此刻间隙表仍是旧值（光标行在表内可能残留 0px 条目，
        // 下次输入防抖重算才会按光标例外摘除）→ 不摘 inline 光标会落在 0px 行里不可见
        this._applyWysiwygBlankGapEl(this._wysiwygLinePreOf(line), null);
        this._wysiwygBlankCurLine = line;
      } else {
        this._wysiwygBlankCurLine = null;
      }
      let activeIdx = lineBlockIdx;
      if (activeIdx < 0) {
        // 块表滞后输入 250ms（防抖刷新未跑）：Enter 续行后的新行 = 活动块 end 的紧邻下一行，
        // 旧表里没有它 → 朴素现算 -1 会把**当前正在编辑的块**立即重遮成渲染态，且防抖刷新的
        // _wysiwygActiveIdxFromCursor 守卫（marks.has → -1）会把重遮固化——活动块再也回不来
        //（2026-10-15 用户反馈：「提示块里按一次回车就退出编辑渲染了，没法正常换行」；
        // 列表/段落/普通引用同一机制，harness 四类型实测复现）。
        // 紧邻活动块末端的行：同步轻切块（parseOnly，与遮罩点击同一机制）按最新表再查——
        // 新行重切后仍在块内（列表/引用续行）→ 保持活动块继续编辑；真在块外（段落/标题
        // 回车后的新空行、用户离开块）→ 照旧 -1、块恢复渲染。只查紧邻行，远处行（真离开）
        // 不做同步重算，省大文档按键开销。
        const pb = this._wysiwygActiveIdx >= 0 ? this._wysiwygBlocks[this._wysiwygActiveIdx] : null;
        if (pb && line === pb.end) activeIdx = this._wysiwygBlockIndexAtFresh(line);
      }
      // —— 引用块：> 标志只在光标行显示（2026-10-20 用户要求）。行类挂在行对象上，
      //    装饰重算（输入防抖）不丢；纯光标移动也必须在此落地（与块内空行
      //    _wysiwygBlankCurLine 同一机制）。光标行非引用行（含离开引用块）→ 撤类。
      const prevQuote = this._wysiwygQuoteCurLine;
      const ab = activeIdx >= 0 ? this._wysiwygBlocks[activeIdx] : null;
      const inQuote = !!(ab && line >= ab.start && line < ab.end
        && RE.quote.test(((this.cm.getLine(line) || '').trimStart())));
      const nextQuote = inQuote ? line : null;
      if (prevQuote != null && prevQuote !== nextQuote) {
        this._setWysiwygQuoteCurClass(prevQuote, false);
        this._setWysiwygQuoteCurPad(prevQuote, false);
      }
      if (nextQuote != null && nextQuote !== prevQuote) {
        this._setWysiwygQuoteCurClass(nextQuote, true);
        this._setWysiwygQuoteCurPad(nextQuote, true, ab);
      }
      // 光标停留同行但块结构变化（回车增行/退格删行改动了行内位置）→ 上下间隙类重判
      //（幂等值差：值未变即 no-op，不触发行重渲染）
      if (nextQuote != null && nextQuote === prevQuote) this._setWysiwygQuoteCurPad(nextQuote, true, ab);
      this._wysiwygQuoteCurLine = nextQuote;
      // —— 引用光标行「空内容」类（2026-10-25 用户截图「回车到新一行时，新一行没有 > 了」）：
      //    光标行剥掉 `> ` 前缀后内容为空白时给 pre 挂 wysiwyg-quote-blank-cur（语义标记，
      //    供 CSS/测试定位；**不再改 > 的显色**——空引用行与有内容的光标行同一口径，只显
      //    最内层一个 >，回车前后视觉连续）。输入首字符后 cursorActivity 重判即撤
      //    （差分挂/撤，同上方 quote-cursor-line 机制）。
      const prevQBlank = this._wysiwygQuoteBlankCurLine;
      let nextQBlank = null;
      if (nextQuote != null && isBlank(stripQuotePrefix((this.cm.getLine(nextQuote) || '')))) nextQBlank = nextQuote;
      if (prevQBlank != null && prevQBlank !== nextQBlank) this._setWysiwygCurLineClass(prevQBlank, 'wysiwyg-quote-blank-cur', false);
      if (nextQBlank != null && nextQBlank !== prevQBlank) this._setWysiwygCurLineClass(nextQBlank, 'wysiwyg-quote-blank-cur', true);
      this._wysiwygQuoteBlankCurLine = nextQBlank;
      // —— callout 光标行类（2026-10-25 分段口径）：活动块是 callout（首行 [!TYPE]）时，
      //    光标行的 > 槽竖条/底色按 callout 类型配色（与上下分段遮罩 .alert 盒同一色板）。
      //    与 _wysiwygQuoteCurLine 同机制：每 tick 现算 prev/next 差分挂/撤——不能用
      //    _wysiwygApplyActiveDecor 开工时判（激活时光标尚未落到目标行，2026-10-25 实测
      //    getCursor 读到旧位置），必须在 cursorActivity 现算路径落地。
      const prevCallout = this._wysiwygCalloutCurLine;
      const nextCallout = inQuote ? this._wysiwygBlockAlertType(ab) : null;
      if (prevCallout != null && prevCallout !== nextQuote) this._setWysiwygCalloutCurClass(prevCallout, false);
      if (nextCallout != null && nextQuote !== prevCallout) this._setWysiwygCalloutCurClass(nextQuote, true, nextCallout);
      this._wysiwygCalloutCurLine = nextCallout ? nextQuote : null;
      // —— callout「标记行」类（2026-10-25 用户截图「编辑态和渲染态不一致」）：光标停在
      //    `> [!NOTE]` 标记行时，这一行源码占的正是渲染态 **标题行** 的位置（实测：标记行
      //    行盒 y 与 .alert-title 行盒重合、正文段起点也随之对齐），但此前该行按普通正文
      //    排版（16px/常规字重/正文色）→ 用户看到的是「盒子顶部一行裸源码，Note 标题没了」。
      //    给 pre 挂 wysiwyg-callout-marker-line，CSS 把这行按标题行排版（0.95em / 700 /
      //    类型主题色 --qc-bar、`> ` 槽透明但保留 22px 占位）→ 标题行仍在原位，只是标题
      //    文字换成了用户正在编辑的源码。与上方 callout 光标行类同机制（差分挂/撤，行号
      //    失效由 prev/next 差分兜底）。
      const prevMarker = this._wysiwygCalloutMarkerLine;
      const nextMarker = (nextCallout && nextQuote != null && ab && nextQuote === ab.start) ? nextQuote : null;
      if (prevMarker != null && prevMarker !== nextMarker) this._setWysiwygCurLineClass(prevMarker, 'wysiwyg-callout-marker-line', false);
      if (nextMarker != null && nextMarker !== prevMarker) this._setWysiwygCurLineClass(nextMarker, 'wysiwyg-callout-marker-line', true);
      this._wysiwygCalloutMarkerLine = nextMarker;
      // —— 行内标记光标行类（2026-07-13 用户反馈：①鼠标选中一段文字时编辑态源码消失
      //    ——active-line addon 对**非空选区清掉全部活动行**（updateActiveLines 跳过非空
      //    range），选区期间光标行回渲染外观；②demo.md 的 <ins> 行光标离开整列表才回
      //    渲染态——addon 类与光标失步）。addon「选区→清行」语义与「光标行显示源码、
      //    光标离开该行即回渲染」契约冲突 → 改 JS 显式挂行类（与上方引用光标行同一
      //    机制）：每次 cursorActivity 同步到光标行（getCursor()=主选区头行=鼠标所在行）；
      //    选区/拖选期间头行即当前行 → 源码保持；光标离开该行 → 撤类、回渲染态。
      //    拖选冻结期（上方早退）类停在拖选起始行，释放后由 _ensureWysiwygSelEndSync
      //    的一次性 pointerup（下一宏任务）归位。
      //    addon 本身保留：光标行底色（codemirror.css #e8f2ff）与失步守卫仍用它。
      this._applyWysiwygInlineCurLine();
      this.setWysiwygActiveBlock(activeIdx);
      // 引用/提示块活动态（2026-10-25 分段口径）：光标块内移动 → 分段边界随光标重算
      //（内部幂等：光标行/段源未变即 no-op）；光标离块 → 清退
      this._wysiwygApplyQuoteSegments();
      // active-line addon 失步守卫（2026-10-21；2026-07-13 起行内源码显示已改 JS 行类
      // 载体 wysiwyg-inline-cursor-line——按钳后光标行号直挂、无视觉行解析，天然不失步，
      // 本守卫只护 addon 余下的光标行底色条 #e8f2ff）：光标落进**被遮罩块**（collapsed
      // replacedWith）时，addon 用的 getLineHandleVisualStart 按「视觉行」解析 = 遮罩
      // 起始行的 Line 对象 → CodeMirror-activeline 被挂到遮罩起始行，且解罩后不自愈
      // （sameArray 比 handle 恒等，无新选区变化就不重解析）。复现路径：跳转行号/程序化
      // setCursor 落进遮罩（点击路径是「先解罩后落选区」，天然不受影响）。
      // 对策：校验 addon 存储 handle 的行号 == 光标行，不符则重放一次当前选区（identical
      // 选区 → setSelectionInner 立即返回、不重复 cursorActivity；addSelectionToHistory
      // 按 equals 去重，不新增撤销步），让 addon 按解罩后的文档重解析。
      // ⚠️ 本函数无局部 cm（全程 this.cm）——裸用 cm 会 ReferenceError 被下方 catch 静默吞
      try {
        const cm2 = this.cm;
        const al = cm2.state && cm2.state.activeLines;
        if (al && al.length) {
          const h0 = al[0];
          const storedNo = (h0 && typeof h0.lineNo == 'function') ? h0.lineNo() : null;
          if (storedNo !== cm2.getCursor().line) {
            const rng = cm2.listSelections()[0];
            if (rng) cm2.operation(() => { cm2.setSelection(rng.anchor, rng.head, { scroll: false }); });
          }
        }
      } catch (_) { /* addon 状态异常不阻断同步 */ }
    },

    // 引用光标行类（2026-10-20）：'text' 域 = pre 元素（CSS pre.wysiwyg-quote-cursor-line
    // 控制该行 > 槽字符可见）。
    _setWysiwygQuoteCurClass(n, on) {
      this._setWysiwygCurLineClass(n, 'wysiwyg-quote-cursor-line', on);
    },

    // 光标行上下间隙动态类（2026-10-28 S90 问题 1：用户截图「光标到不同的行，引用块被撑开
    // 和收缩、高度变化」）。根因 = 光标源行盒高与其替换的渲染行不一致（实测：嵌套中间行
    // +24px、层级组边界段落距 -14px，块总高随光标行 ±19px）。渲染几何（softBreaks 逐行）：
    // · 同层级相邻行 = 同一 <p> 内软换行 → 行间无间隙；
    // · 嵌套盒首行上方 = 14px（外层 <p> margin-bottom）+ 12px（盒 padding-top）；
    // · <p> 末行下方接嵌套盒 = 14px（该 <p> margin-bottom；盒 padding-top 在底段遮罩内）；
    // · 嵌套盒末行下方接外层行 = 12px（盒 padding-bottom）+ 16px（盒 margin-bottom）——盒在
    //   接缝处 open（seg-open 规则清两侧 padding），两段遮罩都不含 → 源行自担。
    // 边缘行（块首/末）维持 edge 类固定 padding（S85/S86 口径）→ 不挂本类。类挂 pre
    // （'text' 域，与光标行类同口径），值差幂等防重渲染。
    _setWysiwygQuoteCurPad(n, on, b) {
      const cm = this.cm;
      if (!cm || n == null) return;
      const CLS = ['wysiwyg-quote-cur-tp-0', 'wysiwyg-quote-cur-tp-26', 'wysiwyg-quote-cur-bp-0', 'wysiwyg-quote-cur-bp-14', 'wysiwyg-quote-cur-bp-28'];
      let h = null;
      try { h = cm.getLineHandle(n); } catch (_) { return; }
      if (!h) return;
      // b = 调用点现算的活动块（sync 差分先于 setWysiwygActiveBlock 落地，
      // this._wysiwygActiveIdx 此刻可能是旧块）
      const key = on ? this._wysiwygQuoteCurPadKey(n, b) : 'off';
      if (this._wysiwygQuoteCurPadLine === n && this._wysiwygQuoteCurPadVal === key) return;
      for (const c of CLS) {
        try { cm.removeLineClass(h, 'text', c); } catch (_) { /* 行已销毁 */ }
      }
      if (on && key !== 'off') {
        const p = key.split('-');
        if (p[1] !== 'off') cm.addLineClass(h, 'text', 'wysiwyg-quote-cur-tp-' + p[1]);
        if (p[3] !== 'off') cm.addLineClass(h, 'text', 'wysiwyg-quote-cur-bp-' + p[3]);
      }
      this._wysiwygQuoteCurPadLine = n;
      this._wysiwygQuoteCurPadVal = key;
    },

    // 光标行上下间隙取值：'tp-X-bp-Y'（off = 该侧维持静态 edge 规则）；'off' = 单行块/不在块内。
    // · pt：顶缘行（块首）静态 12N 恰为渲染值（盒链 padT，无块上内容）→ 不动；其余行
    //   上一行同层 = 同一 <p> 软换行（间隙 0）、上一行浅一层 = 嵌套盒顶（14 <p> 距 + 12 盒 pad）。
    //   ⚠️ 嵌套 edge-bottom 行静态 pt=12（nested 类）在两种情况下都错（同层应 0 / 浅层应 26）→ 必须动态。
    // · pb：底缘行（块末）静态 28N 恰为渲染值（盒链 padB + 整盒底距 16）→ 不动；其余行
    //   下一行同层 = 0、下一行深一层 = 14（本 <p> 距，盒 padT 在下段遮罩内）、下一行浅一层
    //   = 28（本嵌套盒末 12+16，盒在接缝 open、两段遮罩都不含 → 源行自担）。
    //   ⚠️ 嵌套 edge-top 行静态 pb=12 在下一行同层时应 0、深一层时应 14 → 必须动态。
    _wysiwygQuoteCurPadKey(n, b) {
      const cm = this.cm;
      if (!b || n < b.start || n >= b.end) return 'off';
      if (n === b.start && n === b.end - 1) return 'off'; // 单行块：静态 pt 12N / pb 28N 之和恰为渲染值
      const lvlOf = (ln) => {
        let t = '';
        try { t = cm.getLine(ln) || ''; } catch (_) { t = ''; }
        const m = /^(\s*(?:>[ \t]?)+)/.exec(t);
        return m ? (m[1].match(/>/g) || []).length : 0;
      };
      const L = lvlOf(n);
      let pt = 'off', pb = 'off';
      if (n !== b.start) pt = (lvlOf(n - 1) === L - 1) ? 26 : 0;
      if (n !== b.end - 1) {
        const nl = lvlOf(n + 1);
        pb = (nl === L + 1) ? 14 : (nl === L - 1) ? 28 : 0;
      }
      return 'tp-' + pt + '-bp-' + pb;
    },

    // callout 光标行类（2026-10-25 分段口径，同日改版：类型类 alert-{type} →
    // wysiwyg-callout-{type}——pre 带旧类名会直接命中 .alert-{type} 渲染规则
    // （1px inset 内环铺满整行），与 pre 自身背景规则互搏成「灰色框」）：
    // wysiwyg-callout-cursor-line（接管引用行默认盒、切换 callout 配色）+
    // wysiwyg-callout-{type}（note/tip/important/warning/caution 五类，色板经
    // --qc-bg/--qc-bar 变量与渲染/分段 .alert 盒同源——CSS 按类型设两变量，槽
    // ::before 与 pre::before 竖条共用）。
    // 2026-10-30 职责调整：类型类已放宽到块内**所有** raw 行（decor 引用分支统一
    // 先清后挂）。本方法只保证**光标行**类型即时正确（[!NOTE]→[!TIP] 改写时旧类
    // 不残留——两类型类并存时 CSS 按源码序取后者，tip→note 会取错色）；OFF 只撤
    // cursor-line 专用类、**不撤类型类**——setWysiwygActiveBlock 在 idx 未变时提前
    // 返回、decor 不重跑，这里撤掉会让纯光标移动路径在前光标行上出现类型色缺口。
    // 残留无害：CSS 类型选择器全部要求 .wysiwyg-quote-line 同在，decor/cleanup
    // 的先清后挂兜底。
    _setWysiwygCalloutCurClass(n, on, type) {
      if (on) {
        this._setWysiwygCurLineClass(n, 'wysiwyg-callout-note', false);
        this._setWysiwygCurLineClass(n, 'wysiwyg-callout-tip', false);
        this._setWysiwygCurLineClass(n, 'wysiwyg-callout-important', false);
        this._setWysiwygCurLineClass(n, 'wysiwyg-callout-warning', false);
        this._setWysiwygCurLineClass(n, 'wysiwyg-callout-caution', false);
        if (type) this._setWysiwygCurLineClass(n, 'wysiwyg-callout-' + type, true);
        this._setWysiwygCurLineClass(n, 'wysiwyg-callout-cursor-line', true);
      } else {
        this._setWysiwygCurLineClass(n, 'wysiwyg-callout-cursor-line', false);
      }
    },

    // 光标行行类挂/撤（2026-10-20 引用 > 槽；2026-07-13 扩展行内标记源码显示）：
    // 'text' 域 = pre 元素（类落在 pre.CodeMirror-line 上，行对象持久、渲染重建不丢）。
    // 行已销毁时 no-op；行号越界不操作。
    _setWysiwygCurLineClass(n, cls, on) {
      const cm = this.cm;
      if (!cm || n == null || n < 0 || n >= cm.lineCount()) return;
      try {
        const h = cm.getLineHandle(n);
        if (on) cm.addLineClass(h, 'text', cls);
        else cm.removeLineClass(h, 'text', cls);
      } catch (_) { /* 行已销毁（安全 no-op） */ }
    },

    // 行内标记行类归位到光标行（2026-07-13）：syncWysiwygActiveBlock 每次 cursorActivity
    // 调用（拖选冻结期除外）+ 拖选释放后的一次性 pointerup 调用（见
    // _ensureWysiwygSelEndSync）。getCursor() = 主选区头行 = 鼠标所在行；选区保留时
    // 头行即「当前行」→ 源码保持，光标离开该行 → 撤类回渲染态。
    _applyWysiwygInlineCurLine() {
      if (this.viewMode !== 'wysiwyg' || !this.cm) return;
      const line = this.cm.getCursor().line;
      if (this._wysiwygInlineCurLine === line) return;
      if (this._wysiwygInlineCurLine != null)
        this._setWysiwygCurLineClass(this._wysiwygInlineCurLine, 'wysiwyg-inline-cursor-line', false);
      this._setWysiwygCurLineClass(line, 'wysiwyg-inline-cursor-line', true);
      this._wysiwygInlineCurLine = line;
    },

    // 拖选释放后行类归位（2026-07-13）：拖选冻结期（syncWysiwygActiveBlock 早退）行类
    // 停在拖选起始行；mouseup 释放时 CM 常无新选区变化（head 已在末次 move 落位）→
    // 无末次 cursorActivity，行类不会自行归位（S66 跨行拖选抓出）。挂一次性 document
    // pointerup：⚠️ 必须 setTimeout(0) 而非同步——pointerup 先于 mouseup 派发，而 CM 在
    // document mouseup 监听里才清 state.selectingText（codemirror.js initMouseDown），
    // 同步读到的仍是拖选态；下一宏任务保证在 CM mouseup 处理之后。
    _ensureWysiwygSelEndSync() {
      if (this._wysiwygSelEndSyncBound) return;
      this._wysiwygSelEndSyncBound = true;
      const self = this;
      const onUp = () => {
        document.removeEventListener('pointerup', onUp);
        self._wysiwygSelEndSyncBound = false;
        setTimeout(() => {
          self._applyWysiwygInlineCurLine();
          // 释放后活动块归位到光标（选区头）所在块（2026-10-21 逐项切块后口径）：
          // CM 原生拖选（mousedown 落在真实行/行缘 margin 区）释放时 CM 无新选区变化
          // → 无 cursorActivity 补同步，活动块会停在拖选起始行——逐项语义下光标行
          // （head）的项被遮罩、源码不显示（违背「光标行显示源码」）。此刻 selectingText
          // 已清、拖拽结束、几何稳定，完整同步 + 锚点补偿照护块切换位移。
          self.syncWysiwygActiveBlock();
        }, 0);
      };
      document.addEventListener('pointerup', onUp);
    },

    // ---------------- 抖动补偿（同步 / operation 内延迟） ----------------

    // 块在「渲染态 ↔ 源码态」切换时高度会变，锚点行上方/下方内容随之位移。
    // 做法：测量光标**切换前后**的 document 空间 y（'local'，滚动无关）差值并回滚滚动。
    // ⚠️ 用 'local' 而非 'window'：差值必须是**纯结构位移**——window 坐标会把 CM 自己
    //    operation 末的原生滚动（scrollIntoView 保光标可见）混进差值 → 双重补偿。
    // ⚠️ CM operation 进行中（cursorActivity 同步触发，cm.curOp 在）：refresh+测量+滚动
    //    整体延迟到下一 tick（operation 已收尾、DOM 落定）执行——见 _restoreWysiwygAnchor
    //    注释（2026-10-18 真机「空列表项按回车页面跳顶」根因：operation 内 refresh 使
    //    行高计算错乱、测得垃圾几何）。operation 外仍同步执行（本帧内修正，肉眼无跳）。
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
        const c = cm.cursorCoords(null, 'local');
        if (c && typeof c.top === 'number' && isFinite(c.top)) this._wysiwygAnchorY = c.top;
      } catch (_) { /* 量不到就不补偿 */ }
    },

    // 点击锚定的真正执行点：必须由 mousedown handler 在 setSelection 返回之后调用。
    // 此时 CM 的 operation 已结束、DOM 已完成重排，滚动不会被 pending 机制冲掉。
    // ⚠️ 旧实现 scrollIntoView(pos, margin=click.y) 有两处缺陷（2026-10-09 真机「每次点击
    //    都往下滚一段」）：1) scrollIntoView 的 margin 相对**编辑器视口顶**，click.y 是
    //    **窗口坐标**——真机编辑器上方有工具栏+标签栏（约 100px+），基准错位使目标行恒落在
    //    点击点下方「一个工具栏高」处（harness 里编辑器贴窗口顶、基准巧合重合，测不出来）；
    //    2) margin 带内的行完全不做补偿，撤遮罩后行下移多少就停多少。
    //    现改「事后测量 + 差值补偿」（与 _restoreWysiwygAnchor 光标锚点同机制）：点击位置
    //    先换算为编辑器视口内坐标，再把被点源码行顶边精确放回点击处。
    _applyWysiwygClickAnchor() {
      const cm = this.cm;
      const click = this._wysiwygClickAnchor;
      this._wysiwygClickAnchor = null;
      if (!click || !cm) return;
      try {
        const pos = { line: Math.min(Math.max(click.line, 0), cm.lineCount() - 1), ch: 0 };
        const wrapper = cm.getWrapperElement();
        const vh = wrapper ? wrapper.clientHeight : 0;
        // click.y 是窗口坐标，换算成相对编辑器视口顶的位置。
        // ⚠️ 行位置也必须用同一基准：charCoords 的 'window' 坐标减 wrapper 顶。
        //    不能用 'local'——CM5 的 'local' 是文档内容空间（heightAtLine+padding），
        //    不是视口相对坐标，差值会是文档级大数被结构守卫误弃。
        const wrapTop = (wrapper && wrapper.getBoundingClientRect) ? wrapper.getBoundingClientRect().top : 0;
        const localY = click.y - wrapTop;
        const c = cm.charCoords(pos, 'window');
        if (!c || !isFinite(c.top)) return;
        // S71：补偿量 = 结构位移 = 撤罩后行顶的实际屏幕位置 − 撤罩前该行行顶的屏幕位置
        //（refTop，mousedown 时捕获，与 c.top 同为窗口坐标、wrapper 顶相互抵消）。块高
        // 逐像素一致时 delta≈0 → 不滚、页面不动；其他块重挂遮罩产生高度差时，回滚该纯
        // 位移、被点文本恒留在鼠标下。缺 refTop 时回退旧口径（行顶回点击处）。
        const delta = (click.refTop != null && isFinite(click.refTop))
          ? (c.top - click.refTop)
          : (c.top - wrapTop - localY); // >0：行顶已下移过点击处（旧口径）
        if (!delta || !isFinite(delta)) return;
        // 差值过大说明发生了结构级变化，此时补偿反而更糟，放弃
        if (vh && Math.abs(delta) > vh) return;
        const info = cm.getScrollInfo();
        cm.scrollTo(info.left, info.top + delta);
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
      // 补偿本体（两路径共用）：refresh 落定重排 → 测光标 document 空间 y → 差值=纯结构位移 → 回滚。
      const self = this;
      const doRestore = function () {
        try {
          cm.refresh();
          const after = cm.cursorCoords(null, 'local').top;
          const delta = after - before;
          if (!delta || !isFinite(delta)) return;
          // 差值过大说明发生了结构级变化，此时补偿反而更糟，放弃
          const wrapper = cm.getWrapperElement && cm.getWrapperElement();
          const vh = wrapper ? wrapper.clientHeight : 0;
          if (vh && Math.abs(delta) > vh) return;
          const info = cm.getScrollInfo();
          cm.scrollTo(info.left, info.top + delta);
        } catch (_) { /* 已销毁等，忽略 */ }
      };
      if (cm.curOp) {
        // ⚠️⚠️ CM operation 进行中（cursorActivity 同步调起）：必须延迟到下一 tick 执行
        //（2026-10-18 真机「末行空任务项再按一次回车，整页跳到文档顶部」根因）：
        // operation 内 cm.refresh() 会让 CM 行高计算错乱——刚挂的遮罩 widget 高度尚未
        // 应用，实测前缀几何塌缩（块顶 local 544→159、光标 590→189）→ 测得垃圾 delta
        //（-400px 量级）却过视口守卫（<676）→ scrollTo 负值被 operation 末钳到 0=跳顶。
        // 且 operation 内的 scrollTo 只记 pending、operation 末才按**已变化布局**应用，
        // 本就被 CM 原生滚动（保新行可见）冲撞。operation 收尾后 CM 的 updateDisplay +
        // 高度重测已落定布局，此时测量才可信；延迟至多一帧，远优于垃圾值跳顶。
        // 合并守卫：同一 tick 多次块切换（如回车退出块 + 防抖重切）只留最早基准——
        // 延迟时测的是**净**位移，一次滚到位；重复入队会二次补偿。
        if (this._wysiwygAnchorPending) return;
        this._wysiwygAnchorPending = true;
        setTimeout(function () { self._wysiwygAnchorPending = false; doRestore(); }, 0);
      } else {
        doRestore();
      }
    },

    // ---------------- 整体重建 / 清理 ----------------

    // 全量重建：仅在进入模式、切标签、打开文件时调用。
    // 输入过程中禁止调用本方法（每次按键全量重渲染 = 卡顿，见 setWysiwygActiveBlock 注释）。
    // finally 释放预渲染 loading 层：经预渲染管线进入时，loading 必须盖到「遮罩挂完」
    //（挂块 + refresh + 冲刷异步 pass 是数秒同步步骤），否则露「loading 消失 → 源码/空白
    // 数秒 → 才渲染」（2026-10-13 反馈 #1）。所有提前返回路径（在飞守卫/非 wysiwyg/空文档/
    // 空块表）同样在此释放，保证引用计数配对、覆盖层不残留。
    renderWysiwygMasks() {
      const cm = this.cm;
      if (!cm) { this._wysiwygReleasePreRenderLoad(); return; }
      try {
        // 后台预渲染在飞时不得前台现算块表（全量同步预渲染会露数秒源码、且与后台重复劳动）：
        // 预渲染完成时会再走一次 applyViewMode → 本方法携缓存块表重入（_wysiwygPreRendering 已置 false）。
        if (this._wysiwygPreRendering) return;
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
        this._ensureWysiwygTableClickGuard();
        this._ensureWysiwygTaskBoxClick();
        this._ensureWysiwygListKeyGuard();
        this._ensureWysiwygBlankClickGuard();
        this._ensureWysiwygTableTypeGuard();
        this._ensureWysiwygActiveDecorHook();
        this._ensureWysiwygSelectionHook();

        this._wysiwygActiveIdx = this.wysiwygBlockIndexAt(cm.getCursor().line);
        if (full) {
          this._enterWysiwygFullView();
        } else {
          this.updateWysiwygViewportMasks();
        }
        try { cm.refresh(); } catch (_) { /* ignore */ }
        // refresh 后全量模式所有行已物化（viewportMargin=行数+100）：立刻冲刷异步 pass，
        // 不等 0-timer——TOC/图片/图表在首帧渲染时即就绪（阅读模式进入后也是首帧就绪）。
        this.flushWysiwygAsyncPasses();
        this.updateWysiwygBlankLines();
        this._applyWysiwygActiveHighlight();
        this._wysiwygApplyActiveDecor(this._wysiwygActiveIdx);
        // 引用/提示块活动态分段（2026-10-25）：renderWysiwygMasks（切模式/重渲）程序化
        // 激活不触发 cursorActivity（点击路径才触发）→ 无 sync 兜底 → 必须在此显式补挂，
        // 否则非光标行仍是整块源码 pre（无分段渲染遮罩）。幂等（内部范围/源文未变即 no-op）。
        this._wysiwygApplyQuoteSegments();
        this._applyWysiwygSelectionMaskClasses();
        // 遮罩挂完后重挂光标行源码显示类（与 clearWysiwygMasks 的复位配对）：
        // 文档/遮罩重建后当前行立即回到源码显示，不必等下一次 cursorActivity。
        this._applyWysiwygInlineCurLine();
      } finally {
        this._wysiwygReleasePreRenderLoad();
      }
    },

    // 全量视图驻留：把视口扩到整篇（直接写 cm.options，不走 setOption——viewportMargin
    // 选项处理器自带 cm.refresh()，会多一次全量重渲染；renderWysiwygMasks 下方显式
    // cm.refresh() 统一完成全量渲染 + 高度实测）。所有行恒渲染、行高恒实测：CM refresh()
    // 内部 estimateLineHeights（重置回源文估计）会在同一次全量视图重渲中被重测回正——
    // 几何自愈（2026-10-09 实测：任意位置首跳落点误差 ≤0.5px，refresh 后不漂移）。
    // 视口优先（2026-11-01 性能）：先只挂当前视口 ± 预取块（loading 释放即首帧可交互），
    // 其余块 _wysiwygPumpIdleMount 分批补挂（时间片预算）。整篇单 operation 同步挂全部块
    // 是进入耗时的第二大头（实测 demo.md 881ms 中占 ~430ms），分批后首帧 ~视口挂载成本。
    _enterWysiwygFullView() {
      const cm = this.cm;
      if (!cm) return;
      try { cm.options.viewportMargin = cm.lineCount() + 100; } catch (_) { /* 失败退回默认视口 */ }
      const blocks = this._wysiwygBlocks || [];
      let first = -1, last = -1;
      try {
        const info = cm.getScrollInfo();
        // ⚠️ CM5 scrollInfo 无视口高度字段（该取法全局禁用），取 scroller 元素
        const vh = cm.getScrollerElement().clientHeight || 0;
        first = this.wysiwygBlockIndexAt(cm.lineAtHeight(info.top, 'local'));
        last = this.wysiwygBlockIndexAt(cm.lineAtHeight(info.top + vh, 'local'));
      } catch (_) { /* 取不到视口则退回整篇首挂 */ }
      const MARGIN = 15; // 视口上下各多挂 15 块，容住切换锚点恢复期的小幅滚动
      const lo = Math.max(0, (first >= 0 ? first : last) - MARGIN);
      const hi = Math.min(blocks.length, (last >= 0 ? last : first) + 1 + MARGIN);
      const rest = [];
      try {
        cm.operation(() => {
          for (let k = 0; k < blocks.length; k++) {
            if (k === this._wysiwygActiveIdx) continue;
            if (k >= lo && k < hi) this.maskWysiwygBlock(k);
            else rest.push(k);
          }
        });
      } catch (e) { console.error('[wysiwyg] 全量遮罩挂载失败:', e); }
      this._wysiwygIdleMountJob = rest.length ? { blocks, list: rest, pos: 0 } : null;
      this._wysiwygPumpIdleMount();
    },

    // 分批补挂剩余块：每批 ~12ms 时间片预算，setTimeout 让帧，不阻塞输入/渲染。
    // 块表换代（增量刷新/重键替换 _wysiwygBlocks）时按新表重建「未挂」剩余队列；
    // 已挂/活动块跳过（maskWysiwygBlock 幂等，此处再挡一层防重复 innerHTML 解析）。
    _wysiwygPumpIdleMount() {
      const cm = this.cm;
      const job = this._wysiwygIdleMountJob;
      if (!cm || this.viewMode !== 'wysiwyg' || !this._wysiwygFull || !job) { this._wysiwygIdleMountJob = null; return; }
      if (this._wysiwygBlocks !== job.blocks) {
        job.blocks = this._wysiwygBlocks;
        job.list = [];
        const nb = job.blocks || [];
        for (let k = 0; k < nb.length; k++) {
          if (k !== this._wysiwygActiveIdx && !(this._wysiwygMarks && this._wysiwygMarks.has(k))) job.list.push(k);
        }
        job.pos = 0;
      }
      const t0 = Date.now();
      try {
        cm.operation(() => {
          while (job.pos < job.list.length) {
            const k = job.list[job.pos];
            job.pos++;
            if (k === this._wysiwygActiveIdx) continue;
            if (!(this._wysiwygBlocks && this._wysiwygBlocks[k])) continue;
            if (this._wysiwygMarks && this._wysiwygMarks.has(k)) continue;
            this.maskWysiwygBlock(k);
            if (Date.now() - t0 > 12) break;
          }
        });
      } catch (e) { console.error('[wysiwyg] 分批补挂失败:', e); job.pos = job.list.length; }
      if (job.pos < job.list.length) {
        if (this._wysiwygIdleMountTimer) clearTimeout(this._wysiwygIdleMountTimer);
        const self = this;
        this._wysiwygIdleMountTimer = setTimeout(() => { self._wysiwygIdleMountTimer = null; self._wysiwygPumpIdleMount(); }, 16);
      } else {
        this._wysiwygIdleMountJob = null;
        // 补挂完成：冲刷最后一批的异步 pass（mermaid/图片在视口外块上的注入）
        this.flushWysiwygAsyncPasses();
      }
    },

    // 补挂期间滚动到未挂区域：立即同步挂视口 ± 预取块（防源码长闪），剩余队列按
    // 「先视口附近、后其余」重排后继续泵。块表已换代则直接交泵重建。
    _wysiwygFullMountVisible() {
      const cm = this.cm;
      const job = this._wysiwygIdleMountJob;
      if (!cm || this.viewMode !== 'wysiwyg' || !this._wysiwygFull || !job) return;
      const blocks = this._wysiwygBlocks;
      if (!blocks || !blocks.length) return;
      if (blocks !== job.blocks) { this._wysiwygPumpIdleMount(); return; }
      let first = -1, last = -1;
      try {
        const info = cm.getScrollInfo();
        const vh = cm.getScrollerElement().clientHeight || 0; // CM5 scrollInfo 无 clientHeight，取 scroller
        first = this.wysiwygBlockIndexAt(cm.lineAtHeight(info.top, 'local'));
        last = this.wysiwygBlockIndexAt(cm.lineAtHeight(info.top + vh, 'local'));
      } catch (_) { return; }
      if (first < 0 && last < 0) return;
      const MARGIN = 15;
      const lo = Math.max(0, (first >= 0 ? first : last) - MARGIN);
      const hi = Math.min(blocks.length, (last >= 0 ? last : first) + 1 + MARGIN);
      const need = [];
      for (let k = lo; k < hi; k++) {
        if (k !== this._wysiwygActiveIdx && !(this._wysiwygMarks && this._wysiwygMarks.has(k))) need.push(k);
      }
      if (need.length) {
        try {
          cm.operation(() => { for (const k of need) this.maskWysiwygBlock(k); });
        } catch (_) { /* 单批失败由泵兜底 */ }
        this.flushWysiwygAsyncPasses();
      }
      const inWin = (k) => k >= lo && k < hi;
      const near = [];
      const far = [];
      for (let p = job.pos; p < job.list.length; p++) {
        const k = job.list[p];
        (inWin(k) ? near : far).push(k);
      }
      job.list = near.concat(far);
      job.pos = 0;
      this._wysiwygPumpIdleMount();
    },

    // ---------------- IME 组合期标题字号（2026-10-19 用户反馈 #2「输入标题字号闪」） ----------------
    // 根因（探针实测时间线）：① 组合期浏览器把组合文本以裸文本节点插进输入域 DOM——它落在
    // wysiwyg-heading-text span **之外**（span 只覆盖模型已有文本），按 pre 基准字号渲染
    // （16px）；② compositionend 后 CM5 的 readFromDOMSoon **80ms 定时器**才读 DOM 进模型
    // → change → 装饰 span 重挂，这 80ms 空窗里已确认文本仍是基准字号。两者叠加 =
    // H1「32px→16px（组合中）→32px（确认后+80ms）」先缩后胀、H6「14.4px→16px→14.4px」先胀后缩。
    // 修法：compositionstart 给标题行 pre 挂 wysiwyg-ime-heading-{级}（基准字号抬到标题尺寸、
    // 行内 span 反比缩放，见 styles.css）；组合行是引用行时改挂 wysiwyg-ime-quote（槽
    // nowrap 防组合串竖排，见 styles.css 同名规则）；compositionend 摘类 + 立即读一次
    // DOM（跳过 80ms 空窗，span 同任务内重挂）。由 editor-core 输入域原生事件接线（CM
    // 5.65.18 不触发用户级 composition 编辑器事件，cm.on 是死代码——与 _wysiwygComposing
    // 同一教训）。
    _wysiwygImeCompositionStart() {
      const cm = this.cm;
      if (!cm || this.viewMode !== 'wysiwyg' || this._wysiwygCellEditing) return;
      this._wysiwygImeLineCls = null;
      try {
        const line = cm.getCursor().line;
        const text = cm.getLine(line) || '';
        const m = /^\s{0,3}(#{1,6})(?=\s|$)/.exec(text);
        // 引用行（任意层级）：组合串落进 24px 槽自己的文本节点（空续行正文无节点，
        // 2026-10-28 DOM 实测 "> " → "> a's'd'f"）→ pre-wrap 下逐字折行 = 用户截图的
        // 竖排短线。组合期挂 wysiwyg-ime-quote → 槽 nowrap（单行右溢、overflow 可见）；
        // compositionend 摘类恢复 pre-wrap——**只能限组合期**：常驻 nowrap 会让行尾键入
        // 的 CM DOM 差分丢槽内空格（2026-10-28 实测 `> > ` + CJK → `> >内容`，S84 回归），
        // 与 2026-10-18 列表 marker 竖排同源。组合串在槽文本节点内、上屏模型干净 →
        // 无需列表式 JS 修复（列表空格在独立零宽 span、会被重排）。
        const cls = m
          ? 'wysiwyg-ime-heading-' + m[1].length
          : (RE.quote.test(text) ? 'wysiwyg-ime-quote' : null);
        if (!cls) return;
        const node = this._wysiwygLinePreOf(line);
        if (!node || !node.classList) return;
        node.classList.add(cls);
        this._wysiwygImeLineCls = { node, cls };
      } catch (_) { /* 挂不上就不挂，不影响输入 */ }
    },

    // 当前已物化视口行取 pre.CodeMirror-line（CM5：无 lineInfo，视口行 .node 可能是
    // wrapper div，取行内 pre；行号按 LineObject 恒等匹配，防视口重建后行号漂移误配）
    _wysiwygLinePreOf(lineNo) {
      const cm = this.cm;
      try {
        const view = cm.display && cm.display.view;
        if (!view) return null;
        const handle = cm.getLineHandle(lineNo);
        for (const lv of view) {
          if (lv && lv.line === handle) return this._wysiwygGapPreOf(lv.node);
        }
      } catch (_) { /* 视口结构异常 */ }
      return null;
    },

    _wysiwygImeCompositionEnd() {
      const h = this._wysiwygImeLineCls;
      this._wysiwygImeLineCls = null;
      if (h && h.node && h.node.classList) {
        try { h.node.classList.remove(h.cls); } catch (_) { /* 节点已随重排销毁 */ }
      }
    },

    // 立即读输入域 DOM（见 _wysiwygImeCompositionStart 注释②）：组合确认文本 80ms 后才进
    // 模型 → 空窗期标题行无装饰 span、基准字号闪烁。立即读后 change→装饰钩子同任务内重挂；
    // 80ms 定时器随后照旧触发但 DOM 已同步 = no-op（不产生重复 change）。
    // ⚠️ CM5 的 input 实例挂在 display 上（Display 构造 L4389 this.input=input）：
    // cm.input 不存在（cm6 习惯写法，调用即静默 no-op）。
    // 装饰重挂不依赖 change 事件单通道：组合中途被提前提交时（CM5 onFocus 的 webkit 20ms
    // 延迟 reset → forceCompositionEnd，codemirror.js L3353-3356/9165-9171；或组合期
    // mousedown/键位绑定走 ensurePolled），change 钩子会被 _wysiwygComposing 守卫顺延、
    // 真正的 compositionend 时 flush 又查无 diff → span 无人重挂直到 250ms 防抖。
    // 故 flush 后对活动块直接幂等重挂一次（clear+remark 单行，开销可忽略；正常路径与
    // change 钩子同任务内重复执行，浏览器任务末统一重绘，无可见闪烁）。
    _wysiwygImeFlushDOM() {
      const cm = this.cm;
      if (!cm || this.viewMode !== 'wysiwyg') return;
      try {
        const input = cm.display && cm.display.input;
        if (input && typeof input.updateFromDOM === 'function') input.updateFromDOM();
      } catch (_) { /* 读失败交给 80ms 定时器兜底 */ }
      const idx = this._wysiwygActiveIdx;
      if (idx == null || idx < 0) return;
      if (!this._wysiwygBlocks || !this._wysiwygBlocks[idx]) return;
      try { this._wysiwygApplyActiveDecor(idx); } catch (_) { /* 重挂失败由 250ms 防抖兜底 */ }
    },

    // 输入停止后补齐：重算块划分并对非活动块刷新渲染结果。
    // 输入期间只更新行索引缓存（极廉价），把昂贵的渲染推迟到这里。
    // S90 问题 3（2026-10-28 用户「在引用块中输入文字时要等一会才能显示出来」）：判定一次
    // 变更是否为「不触碰行首结构的纯行内文本编辑」。块边界只由 ① 行数 ② 各行行首结构
    // （空行/引用·#·列表·围栏前缀/setext 下划线/水平线/HTML 块）决定——单行、行数不变、
    // 编辑起点严格晚于行首结构区 → 行类型与块成员关系不变，块表无需重解析（整篇 remark
    // 重解析实测 5000 行约 1s，250ms 输入停顿即触发、中文 IME 每次候选上屏停顿都触发，
    // 主线程阻塞是感知延迟主因）。保守口径：拿不准一律 unsafe（照常重解析）。
    _wysiwygChangeIsBoundarySafe(c) {
      if (!c || !c.from || !c.to || !Array.isArray(c.text)) return false;
      if (c.from.line !== c.to.line) return false;
      if (c.text.length !== 1) return false; // 行数不变（多行替换 = 增/删行）
      const cm = this.cm;
      if (!cm) return false;
      const L = c.from.line;
      let line = '';
      try { line = cm.getLine(L) || ''; } catch (_) { return false; }
      if (line.trim() === '') return false; // 行被编辑成空行 = 块边界必变（空行分隔块）
      return c.from.ch > this._wysiwygStructuralPrefixLen(line);
    },

    // 行的行首结构区长度（编辑必须严格晚于它）；整行结构化的行返回 MAX_SAFE_INTEGER
    //（该行任何编辑都 unsafe）。行按**变更后**状态读：结构未变时前后结构区一致；编辑若已
    // 破坏行首结构（如删 >），from.ch 会落回新行首结构区之内 → 判 unsafe。
    _wysiwygStructuralPrefixLen(line) {
      const ALL = Number.MAX_SAFE_INTEGER;
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) return ALL;             // 围栏定界行（删反引号可开/合围栏）
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return ALL;  // 水平线 ---/***/___
      if (/^\s{0,3}([=-])+\s*$/.test(line)) return ALL;               // setext 下划线 ===/---
      if (/^\s{0,3}([-*+]|\d{1,9}[.)])\s*$/.test(line)) return ALL;   // 无内容列表标记（编辑可成列表项）
      if (/^\s{0,3}</.test(line)) return ALL;                         // HTML 块开行
      const hm = /^\s{0,3}#{1,6}[ \t]/.exec(line);                    // 非空 ATX 标题：编辑在正文内安全
      if (hm) {
        if (line.length > hm[0].length) return hm[0].length;
        return ALL;                                                   // 空标题（# / # 空格）
      }
      let i = 0;
      while (i < line.length && i < 3 && (line[i] === ' ' || line[i] === '\t')) i++;
      if (line[i] === '>') {
        // 引用：结构区 = 行首 > 连跑（含其间的空格）；编辑只需晚于最后一个 >
        //（> 后空格非结构：`>x` 同为有效引用，删该空格不改层级）
        let lastGt = -1;
        while (i < line.length) {
          if (line[i] === '>') { lastGt = i; i++; }
          else if (line[i] === ' ' || line[i] === '\t') i++;
          else break;
        }
        return lastGt + 1;
      }
      const lm = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/.exec(line);
      if (lm) return lm[0].length; // 列表标记 + 分隔空格：其后 = 项正文
      return i;                    // 普通文本/缩进代码：前导空白之后编辑保持行类型
    },

    // c 可空（compositionend 兜底/历史调用）= 无法判定 → 按 unsafe 计
    refreshWysiwygBlocks(c) {
      if (this.viewMode !== 'wysiwyg' || !this.cm) return;
      this._wysiwygLastChange = c || null;
      if (this._wysiwygMaskTimer) clearTimeout(this._wysiwygMaskTimer);
      // 安全标志累积：自上次解析以来的**所有**变更都安全才可跳过重解析
      if (this._wysiwygSafeSinceParse == null) this._wysiwygSafeSinceParse = true;
      if (!this._wysiwygChangeIsBoundarySafe(c)) this._wysiwygSafeSinceParse = false;
      const self = this;
      this._wysiwygMaskTimer = setTimeout(() => {
        self._wysiwygMaskTimer = null;
        if (self.viewMode !== 'wysiwyg') return;
        // IME 组合期间重排会打断输入法导致吞字：顺延到 compositionend（那里会再调本方法）。
        // 透传最近变更保留安全判定（无参重调会把中文组合期安全编辑误判 unsafe、
        // 停顿后强制整篇重解析）。
        if (self._wysiwygComposing) {
          self.refreshWysiwygBlocks(self._wysiwygLastChange);
          return;
        }
        // S90 问题 3：块边界未变 → 跳过重解析 + 重键 + 重挂遮罩，只跑轻量尾
        //（decor/分段/高亮均为幂等 no-op 或廉价重刷）。
        const safeSkip = !!(self._wysiwygBlocks && self._wysiwygSafeSinceParse && !self._wysiwygCellEditing);
        self._wysiwygSafeSinceParse = true; // 消耗（无论跳过与否，基线已对齐）
        if (safeSkip) {
          self._applyWysiwygActiveHighlight();
          self._wysiwygApplyActiveDecor(self._wysiwygActiveIdx);
          self._wysiwygApplyQuoteSegments();
          self._applyWysiwygSelectionMaskClasses();
          return;
        }
        // 全量模式：只重切块边界（仅解析、轻）+ 仅重挂源文变化的块——万行文档
        // 每次输入停顿全量重挂（逐块重跑后处理）会卡数秒
        if (self._wysiwygFull) {
          self._refreshWysiwygFullIncremental();
          return;
        }
        // 块重划分（含解析）推迟到此处统一做；索引会位移，活动块按光标行现算。
        // 格编辑中例外：光标被钳在旧活动块末行，现算会把已遮罩的旧块重新判活动
        // （解罩回源码态）；格编辑期恒 -1 = 全部遮罩（2026-10-14 同批修复）。
        const oldBlocks = self._wysiwygBlocks;
        self._wysiwygBlocks = self.computeWysiwygBlocks();
        self._wysiwygActiveIdx = self._wysiwygCellEditing ? -1 : self._wysiwygActiveIdxFromCursor(oldBlocks);
        self._wysiwygVirtual = !!(self._wysiwygBlocks[0] && self._wysiwygBlocks[0].skipped);
        self._ensureWysiwygScrollHook();
        // 全部撤掉再按视口重挂（非虚拟模式窗口=全文，等效于全量重挂）
        if (self._wysiwygMarks) {
          for (const idx of Array.from(self._wysiwygMarks.keys())) self.unmaskWysiwygBlock(idx);
        }
        self.updateWysiwygViewportMasks();
        self.updateWysiwygBlankLines();
        self._applyWysiwygActiveHighlight();
        self._wysiwygApplyActiveDecor(self._wysiwygActiveIdx);
        // 引用/提示块活动态分段（2026-10-25）：块表重切后按新边界重挂（幂等）
        self._wysiwygApplyQuoteSegments();
        self._applyWysiwygSelectionMaskClasses();
        // 2026-10-21「输入文字页面乱跳」：兜底同步冲刷——遮罩重渲染（占位高度）与 TOC
        // 同步注入 + 刷新补偿必须在**同一任务**内完成，否则「占位 → 真实高度」的阶跃被
        // 浏览器绘制一帧（实测 591px 朝目录跳一帧）。updateWysiwygViewportMasks 内已有
        // 一次同步冲刷；此处再补一次兜底节点此刻仍未入 DOM 而被跳过的情况（幂等廉价）。
        self.flushWysiwygAsyncPasses();
      }, 250);
    },

    // ---------------- 块表重切后的遮罩重键（公共口径） ----------------
    // 块表被替换（防抖增量刷新 / 防抖窗口内 _wysiwygBlockIndexAtFresh 的即时切块）后，
    // marks 的键仍是**旧表**的块索引：调用方若直接拿新表 idx 操作遮罩
    //（setWysiwygActiveBlock → unmaskWysiwygBlock(新idx)），会命中**另一块**的旧键遮罩并
    // 撤掉它（2026-10-21 实测 S38：ol 项内回车续行后，下方引用块遮罩被误撤、源码裸露）。
    // 本方法把现有遮罩按「源文本相同 + 文档顺序」重键到新表：未匹配的旧遮罩撤除，
    // 变化/新增/分裂/合并的块重挂（活动块保持源码态）；活动块索引按光标行现算
    //（与旧 marks 配套的钳制判定同原 _refreshWysiwygFullIncremental 注释）。
    // 虚拟（大文档）模式只重键不补挂——视口窗内挂撤归 updateWysiwygViewportMasks，
    // 全量补挂会破坏窗口（窗外遮罩不该存在）。
    _wysiwygRekeyMarksToBlocks(oldBlocks, newBlocks) {
      const cm = this.cm;
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
        // 同一源文本可能对应多个块（重复段落/列表项），队列按文档顺序消费；
        // 其中一块被删/改写后队列会提前取空——取不到就撤掉该旧遮罩走重挂，
        // 绝不能拿 undefined 当新索引（2026-10-09 真机：重复行文档编辑即崩）
        const queue = ob ? srcQueue.get(ob.src) : undefined;
        if (!ob || !queue || !queue.length) continue;
        const ni = queue.shift();
        const nb = newBlocks[ni];
        if (!nb) continue;
        nb.html = (ob.html !== undefined) ? ob.html : nb.html; // 复用缓存 html
        if (ob.html !== undefined) nb.finalHtml = !!ob.finalHtml; // finalHtml 标记随 html 传递（挂遮罩时决定是否跳过后处理）
        nextMarks.set(ni, mark);
        // 块索引位移：同步遮罩节点上的块号，点击映射才落对块
        if (ni !== oi) {
          try { if (mark.replacedWith) mark.replacedWith.setAttribute('data-block-index', String(ni)); } catch (_) { /* 忽略 */ }
        }
      }
      const keptSet = new Set(nextMarks.values());
      this._wysiwygBlocks = newBlocks;
      // 格编辑中例外（同 refreshWysiwygBlocks 注释）；「钳光标在遮罩块」判定传旧表
      // （与此刻仍有效的旧 marks 配套；swap 在下方 operation 内，见 _wysiwygActiveIdxFromCursor）
      const active = this._wysiwygCellEditing ? -1 : this._wysiwygActiveIdxFromCursor(oldBlocks);
      this._wysiwygActiveIdx = active;
      // 格编辑块的索引位移按范围平移（表块不会被拆/并）：不平移则 unmaskWysiwygBlock 的
      // 提交守卫 blockIdx===idx 失配 → 撤罩静默丢掉正在编辑的格内容
      if (this._wysiwygCellEditing && this._wysiwygCellEditing.blockIdx != null) {
        const ob = oldBlocks[this._wysiwygCellEditing.blockIdx];
        if (ob) {
          for (let k = 0; k < newBlocks.length; k++) {
            const b = newBlocks[k];
            if (b.start <= ob.start && ob.end - 1 < b.end) {
              if (this._wysiwygCellEditing.blockIdx !== k) this._wysiwygCellEditing.blockIdx = k;
              break;
            }
          }
        }
      }
      if (!cm) return active;
      try {
        cm.operation(() => {
          // 未匹配旧遮罩撤除（源文变化/分裂/合并/删除）
          for (const mark of Array.from(this._wysiwygMarks.values())) {
            if (!keptSet.has(mark)) {
              try { mark.clear(); } catch (_) { /* 已销毁 */ }
              this._dropWysiwygMaskNode(mark.replacedWith);
            }
          }
          this._wysiwygMarks = nextMarks;
          // 重挂缺口的块（变化/新增/分裂/合并；活动块保持源码态）
          if (!this._wysiwygVirtual) {
            for (let k = 0; k < newBlocks.length; k++) {
              if (k === active || nextMarks.has(k)) continue;
              this.maskWysiwygBlock(k);
            }
          }
        });
      } catch (e) { console.error('[wysiwyg] 块重键重挂失败:', e); }
      return active;
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
      this._wysiwygRekeyMarksToBlocks(oldBlocks, newBlocks);
      // 2026-10-21「输入文字页面乱跳」：同步冲刷异步 pass（同 updateWysiwygViewportMasks
      // 与防抖回调的兜底冲刷）——变化块重挂后的「占位 → 真实高度」阶跃（TOC/图片/Mermaid）
      // 与补偿须在同一任务内落定，避免浏览器绘制一帧阶跃态（跳顶闪烁）。
      this.flushWysiwygAsyncPasses();
      this.updateWysiwygBlankLines();
      this._applyWysiwygActiveHighlight();
      this._wysiwygApplyActiveDecor(this._wysiwygActiveIdx);
      // 引用/提示块活动态分段（2026-10-25）：全量增量刷新后按新边界重挂（幂等）
      this._wysiwygApplyQuoteSegments();
      this._applyWysiwygSelectionMaskClasses();
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
            this._dropWysiwygMaskNode(mark.replacedWith);
          }
        }
        // 挂上窗内缺失遮罩（skipped 块在 mask 时按需渲染切片）
        for (let k = 0; k < blocks.length; k++) {
          if (k === active || this._wysiwygMarks.has(k)) continue;
          if (!inWindow(blocks[k])) continue;
          this.maskWysiwygBlock(k);
        }
      });
      // 显式冲刷异步 pass：operation 已结束、widget 已入 DOM。既覆盖本批新挂的遮罩，
      // 也捡回此前挂上但行未物化、此刻随视口滚动新物化的待跑节点。
      this.flushWysiwygAsyncPasses();
      // 窗内挂/窗外撤了遮罩：跨块选区覆盖的遮罩集合变了，补刷选中着色
      this._applyWysiwygSelectionMaskClasses();

      if (anchor) {
        try {
          // 格编辑进行中不 refresh（同 _wysiwygRefreshAfterMaskChange 的守卫：refresh 会
          // 重建行 DOM、打掉聚焦中的格），滚动锚定补偿一并跳过——下轮滚动会重新锚定。
          if (this._wysiwygCellEditing) return;
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

    // 表格源码态点击守卫（幂等，2026-10-14 用户要求：点表格右侧/下方空白不得让表格变
    // 源码态，只有块右上「编辑」按钮可进源码模式）：点在表格网格同高的行背景（网格左/右
    // 空白）或表格末行之下时，CM 坐标映射会把光标落到表格源码行 → 表格块被判活动块撤罩
    // → 表格变源码。capture 阶段拦截：点击映射行落在某个**已挂遮罩**表格块区间内即
    // preventDefault（CM 的 onMouseDown 先查 defaultPrevented，见 codemirror.js 的
    // signalDOMEvent——不挪光标，表格保持渲染态）。遮罩内部点击（格/轨道/条带/按钮）
    // 由遮罩自己的 mousedown 派发，此处先行排除；表格已是源码态（无遮罩）时不拦，
    // 正常编辑源码行。
    _ensureWysiwygTableClickGuard() {
      if (this._wysiwygTableClickGuarded || !this.cm) return;
      this._wysiwygTableClickGuarded = true;
      const self = this;
      const wrapper = this.cm.getWrapperElement ? this.cm.getWrapperElement() : null;
      if (!wrapper) return;
      wrapper.addEventListener('mousedown', (ev) => {
        if (self.viewMode !== 'wysiwyg' || !ev || ev.button !== 0) return;
        const t = ev.target;
        if (!t || !t.closest) return;
        if (t.closest('.' + MASK_CLASS)) return;     // 遮罩自行派发点击
        if (t.closest('.CodeMirror-gutter')) return; // 行号 gutter 无表格
        const cm = self.cm;
        if (!cm || !cm.coordsChar) return;
        let pos = null;
        try { pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }); } catch (_) { return; }
        if (!pos || !isFinite(pos.line)) return;
        const idx = self.wysiwygBlockIndexAt(pos.line);
        if (idx < 0) return;
        const mk = self._wysiwygMarks && self._wysiwygMarks.get(idx);
        const maskNode = mk && mk.replacedWith;
        if (!maskNode || !maskNode.querySelector || !maskNode.querySelector('.wysiwyg-table-wrap')) return;
        // 格编辑中点表格外空白（本守卫吞掉区）：同样先提交失焦（2026-10-14 用户要求：
        // 点空白处单元格失去焦点）；光标仍不动，表格块保持渲染态
        if (self._wysiwygCellEditing) self._wysiwygEndCellEdit(true, false);
        ev.preventDefault(); // 光标不动：表格块保持遮罩（渲染）态
      }, true);
    },

    // 任务列表编辑态（活动块源文态）复选框点击（2026-10-18 用户反馈「任务列表编辑态时，
    // 勾选框不能勾选」）：活动块里复选框是 .wysiwyg-task-prefix 的 ::before 伪元素（16px 盒
    // 画在 24px 槽左缘，框本体无 DOM 节点，点击命中目标恒为槽 span 或其内层 token span/
    // 文本节点），源文态**没有任何勾选入口**——渲染态入口在遮罩 mousedown 分支（真
    // input[type=checkbox] → toggleWysiwygTaskCheckbox）。修复 = wrapper capture 阶段
    // 拦截（同 _ensureWysiwygTableClickGuard 模式）：命中落在槽 span 内 → 该行调
    // _wysiwygToggleTaskLine（与渲染态共用回写口径）切换 [ ]/[x]，光标落到该行正文起点
    // （同「点该行」语义）；preventDefault 让 CM 跳过自身落光标（否则光标落透明 bullet 上）。
    // change 钩子（_ensureWysiwygActiveDecorHook）随即按新行文本重挂装饰，checked 类/
    // 勾选样式自动刷新。遮罩态（渲染态）点击走遮罩自己的复选框分支，不受此影响；IME
    // 组合期放行不打断组合（与装饰钩子同口径）。
    _ensureWysiwygTaskBoxClick() {
      if (this._wysiwygTaskBoxClickHooked || !this.cm) return;
      this._wysiwygTaskBoxClickHooked = true;
      const self = this;
      const wrapper = this.cm.getWrapperElement ? this.cm.getWrapperElement() : null;
      if (!wrapper) return;
      wrapper.addEventListener('mousedown', (ev) => {
        if (self.viewMode !== 'wysiwyg' || !ev || ev.button !== 0) return;
        if (self._wysiwygComposing) return;      // IME 组合期不打断（同装饰钩子口径）
        // 命中目标可能是文本节点（透明 bullet 字符）：先爬到最近的元素节点再 closest
        let el = ev.target;
        while (el && el.nodeType !== 1) el = el.parentNode;
        if (!el || !el.closest) return;
        if (el.closest('.' + MASK_CLASS)) return;             // 渲染态（遮罩）自有复选框分支
        if (el.closest('.wysiwyg-task-box-zero')) return;     // 零宽槽上的点击 = 点正文，放行
        const slot = el.closest('.wysiwyg-task-prefix');
        if (!slot || !slot.getBoundingClientRect) return;
        const cm = self.cm;
        if (!cm || !cm.coordsChar) return;
        let pos = null;
        try { pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }); } catch (_) { return; }
        if (!pos || !isFinite(pos.line)) return;
        const ch = self._wysiwygToggleTaskLine(pos.line);
        if (ch == null) return;                           // 非任务行（理论上不会：槽只存在于任务行）→ 放行
        ev.preventDefault();
        ev.stopPropagation();
        try {
          cm.setSelection({ line: pos.line, ch }, { line: pos.line, ch }, { scroll: false, origin: '*mouse' });
          cm.focus();
        } catch (_) { /* 落光标失败不影响勾选 */ }
      }, true);
    },

    // 列表/定义列表/引用行 Backspace·Delete 守卫（2026-10-24 用户截图反馈：任务项删到勾选框
    // 「还要按好多次删除才能删到上一行」，且中间态裸露「• []」；2026-10-31 扩引用行：
    // QA 实测引用行首 Backspace 不剥 `>` 反而误动下方内容，且用户截图空引用行裸露 `> `）。
    // 机制与口径见顶部 listMarkerZoneEnd / quoteMarkerZoneEnd 注释。wrapper capture 阶段
    // keydown（同 _ensureWysiwygTaskBoxClick 模式）：capture 在 CM 自身 keydown 监听
    // （后代元素/冒泡）之前运行，preventDefault + stopPropagation 后 CM 完全跳过原生逐字符
    // 删。IME 组合期与修饰键（词删除等）放行。
    _ensureWysiwygListKeyGuard() {
      if (this._wysiwygListKeyHooked || !this.cm) return;
      this._wysiwygListKeyHooked = true;
      const self = this;
      const wrapper = this.cm.getWrapperElement ? this.cm.getWrapperElement() : null;
      if (!wrapper) return;
      wrapper.addEventListener('keydown', (ev) => {
        if (self.viewMode !== 'wysiwyg' || !ev) return;
        if (ev.key !== 'Backspace' && ev.key !== 'Delete') return;
        if (ev.ctrlKey || ev.altKey || ev.metaKey) return;   // 修饰键组合（删词等）走原生
        if (ev.isComposing || self._wysiwygComposing) return; // IME 组合期不打断（同装饰钩子口径）
        const cm = self.cm;
        if (!cm || !cm.replaceRange) return;
        const cur = cm.getCursor('head');
        if (!isFinite(cur.line) || cm.somethingSelected()) return; // 有选区：原生删选区
        const L = cur.line;
        // 字面块（围栏/缩进代码/HTML 容器/frontmatter）行文里的 `- `/`> ` 是**内容**
        // 不是标记 → 全部放行原生（否则 Backspace 会剥改代码内容，2026-10-31 堵漏）
        if (self._wysiwygLineInLiteralBlock(L)) return;
        const line = cm.getLine(L) || '';
        const zoneEnd = listMarkerZoneEnd(line);
        const qZoneEnd = quoteMarkerZoneEnd(line);
        if (ev.key === 'Backspace') {
          if (zoneEnd > 0 && cur.ch <= zoneEnd) {
            ev.preventDefault();
            ev.stopPropagation();
            const content = line.slice(zoneEnd);
            if (L > 0 && isBlank(content)) {
              // 空项（正文空白，含光标停在标记区内任意处）：整行并入上一行，一次删到上一行
              const prevLen = (cm.getLine(L - 1) || '').length;
              cm.replaceRange('', { line: L - 1, ch: prevLen }, { line: L, ch: line.length }, '+wysiwygListKeyGuard');
            } else {
              // 有正文：一次剥离整个隐藏标记（项变普通段落），光标落新正文起点
              cm.replaceRange('', { line: L, ch: 0 }, { line: L, ch: zoneEnd }, '+wysiwygListKeyGuard');
              try {
                cm.setSelection({ line: L, ch: 0 }, { line: L, ch: 0 }, { scroll: false, origin: '*wysiwygListKeyGuard' });
              } catch (_) { /* replaceRange 后 CM 通常已把光标放在删除起点 */ }
            }
            return;
          }
          // 引用行（含嵌套）：区内/正文起点一次剥离整个 `> ` 前缀（退出引用，Typora 同口径；
          // 原生会逐字符删出「>文本」「>」裸露中间态且 QA 实测还误动下方内容）
          if (qZoneEnd > 0 && cur.ch <= qZoneEnd) {
            ev.preventDefault();
            ev.stopPropagation();
            cm.replaceRange('', { line: L, ch: 0 }, { line: L, ch: qZoneEnd }, '+wysiwygQuoteKeyGuard');
            try {
              cm.setSelection({ line: L, ch: 0 }, { line: L, ch: 0 }, { scroll: false, origin: '*wysiwygQuoteKeyGuard' });
            } catch (_) { /* 同上 */ }
          }
          return;
        }
        // —— Delete：行尾把下一行并上来。下一行是列表/dd 标记行 → 剥标记后并接，
        //    避免原生并出「- 无序甲- 无序乙」这类标记残骸；空标记行（如「- 」）整行删掉。
        if (cur.ch !== line.length || L + 1 >= cm.lineCount()) return;
        const nextLine = cm.getLine(L + 1) || '';
        const nzEnd = self._wysiwygLineInLiteralBlock(L + 1) ? 0 : listMarkerZoneEnd(nextLine);
        if (nzEnd > 0) {
          ev.preventDefault();
          ev.stopPropagation();
          if (isBlank(nextLine.slice(nzEnd))) {
            cm.replaceRange('', { line: L, ch: line.length }, { line: L + 1, ch: nextLine.length }, '+wysiwygListKeyGuard');
          } else {
            cm.replaceRange('', { line: L, ch: line.length }, { line: L + 1, ch: nzEnd }, '+wysiwygListKeyGuard');
          }
          return;
        }
        // 下一行是引用行 → 剥其整个 `> ` 前缀后并接（原生并出「> 甲> 乙」标记残骸；
        // 空引用行整行删掉）
        const nqEnd = quoteMarkerZoneEnd(nextLine);
        if (nqEnd > 0) {
          ev.preventDefault();
          ev.stopPropagation();
          if (isBlank(nextLine.slice(nqEnd))) {
            cm.replaceRange('', { line: L, ch: line.length }, { line: L + 1, ch: nextLine.length }, '+wysiwygQuoteKeyGuard');
          } else {
            cm.replaceRange('', { line: L, ch: line.length }, { line: L + 1, ch: nqEnd }, '+wysiwygQuoteKeyGuard');
          }
        }
      }, true);
    },

    // 光标行是否处于「源码即字面内容」的块（围栏代码 / 缩进代码 / HTML 容器 / frontmatter）：
    // 这些块的行文里 `- ` / `> ` 是内容不是标记，键守卫必须放行（2026-10-31 引用守卫引入时
    // 同步堵住列表守卫的同类隐患）。行不在块表内（空行分隔/块表滞后）→ 按文面放行守卫。
    _wysiwygLineInLiteralBlock(L) {
      const cm = this.cm;
      const blocks = this._wysiwygBlocks;
      if (!cm || !blocks || !blocks.length || !isFinite(L)) return false;
      let blk = null;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (L >= b.start && L < b.end) { blk = b; break; }
        if (b.start > L) break;
      }
      if (!blk) return false;
      const firstRaw = (cm.getLine(blk.start) || '');
      const first = firstRaw.trim();
      if (blk.start === 0 && first === '---') return true; // frontmatter（YAML 行文是字面内容）
      if (RE.fence.test(first) || RE.indentedCode.test(firstRaw)) return true;
      return isHtmlBlockContainerLine(first);
    },

    // 块间空行点击守卫（2026-10-31 用户反馈：点标题/块之间的空白会落进空行——光标
    // 「悬在虚空」、无任何可见内容可编辑，与 Typora 直觉不符）。wrapper capture mousedown
    // （同键守卫模式）：点击命中的是**空行**时，按点击点与该行垂直中线的关系归位——
    // 上半 → 上一非空行**行尾**（解罩后落点），下半 → 下一非空行**行首**；连续空行跳到
    // 最近非空行。遮罩/按钮/修饰键/拖选放行。
    _ensureWysiwygBlankClickGuard() {
      if (this._wysiwygBlankClickHooked || !this.cm) return;
      this._wysiwygBlankClickHooked = true;
      const self = this;
      const wrapper = this.cm.getWrapperElement ? this.cm.getWrapperElement() : null;
      if (!wrapper) return;
      wrapper.addEventListener('mousedown', (ev) => {
        if (self.viewMode !== 'wysiwyg' || !ev) return;
        if (ev.button !== 0 || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
        let el = ev.target;
        while (el && el.nodeType !== 1) el = el.parentNode;
        if (!el || !el.closest) return;
        if (el.closest('.' + MASK_CLASS)) return;             // 遮罩自有「纵比映射源码行」
        if (el.closest('button') || el.closest('.CodeMirror-gutters')) return;
        const cm = self.cm;
        if (!cm || !cm.coordsChar) return;
        let pos = null;
        try { pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }); } catch (_) { return; }
        if (!pos || !isFinite(pos.line)) return;
        if ((cm.getLine(pos.line) || '').trim() !== '') return; // 非空行：原生
        let boxTop = 0, boxBottom = 0;
        try {
          const box = cm.charCoords({ line: pos.line, ch: 0 });
          boxTop = box.top; boxBottom = box.bottom;
        } catch (_) { return; }
        const n = cm.lineCount();
        let t = pos.line;
        let target = null;
        if (ev.clientY < (boxTop + boxBottom) / 2) {
          while (t > 0 && (cm.getLine(t - 1) || '').trim() === '') t--;
          if (t > 0) target = { line: t - 1, ch: (cm.getLine(t - 1) || '').length };
        } else {
          while (t < n - 1 && (cm.getLine(t + 1) || '').trim() === '') t++;
          if (t < n - 1) target = { line: t + 1, ch: 0 };
        }
        if (!target) return;                                    // 全文档皆空等极端态 → 放行
        ev.preventDefault();
        ev.stopPropagation();
        try {
          // 目标行可能在遮罩块内：先按 Fresh 索引解罩（与块编辑按钮同一「先解罩后落光标」
          // 口径，否则 replacedWith 把落点钳到块缘）
          self.setWysiwygActiveBlock(self._wysiwygBlockIndexAtFresh(target.line));
          cm.setSelection(target, target, { scroll: false, origin: '*mouse' });
          cm.focus();
        } catch (_) { /* 落点失败不影响 */ }
      }, true);
    },

    // 表下输入守卫（2026-10-14 用户要求 #1 根因修复）：GFM 里表格最后一行**之下紧邻**
    // 的非空文本行（中间没有空行）会被解析成表格的一行——用户在表格正下方空行上输入
    // 内容，块表重算就把该行吸进表格、光标行落入表格块 → 判活动块撤罩 →「表格下面
    // 的一行一旦输入内容，表格就会变成源码格式」。检测「已挂遮罩表格块的末行之下的
    // （原为空白）行被插入非空白文本」，把输入整体下移一行：空行留在表格与文本之间
    // （保持分隔），表格保持渲染态，文本成为独立块。
    // 返回 true = 已下移。
    _wysiwygPushTypedLineBelowTable(L) {
      const cm = this.cm;
      if (!cm || this.viewMode !== 'wysiwyg' || !isFinite(L)) return false;
      const blocks = this._wysiwygBlocks;
      if (!blocks || !blocks.length) return false;
      let bi = -1, above = null;
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].end === L) { above = blocks[i]; bi = i; break; }
        if (blocks[i].start > L) break;
      }
      if (!above) return false;
      const mk = this._wysiwygMarks && this._wysiwygMarks.get(bi);
      const node = mk && mk.replacedWith;
      if (!node || !node.querySelector || !node.querySelector('.wysiwyg-table-wrap')) return false;
      const line = cm.getLine(L);
      if (!line || line.trim() === '') return false;
      try {
        cm.replaceRange('\n', { line: L, ch: 0 }, { line: L, ch: 0 }, '+wysiwygTableTypeGuard');
        cm.setSelection({ line: L + 1, ch: line.length }, { line: L + 1, ch: line.length }, { scroll: false });
      } catch (_) { return false; }
      return true;
    },

    // 表下输入守卫接线（幂等）：
    // · change：直接输入/粘贴路径（纯插入、单行、原行空白、上方是已挂遮罩表格末行）→ 下移；
    // · compositionend：中文输入——组合期 change（*compose 拼音串）跳过（组合中移文字
    //   会打断输入法），compositionend 时文字已落定在该空行上，此时下移。
    // 防抖重算（250ms）在下移之后的稳定结构上运行，表格块边界不再扩张。
    _ensureWysiwygTableTypeGuard() {
      if (this._wysiwygTableTypeGuarded || !this.cm) return;
      this._wysiwygTableTypeGuarded = true;
      const self = this;
      this.cm.on('change', (cm, c) => {
        // CM5 change 事件参数 = 单个 change 对象 {from, to, text, removed, origin}
        if (self.viewMode !== 'wysiwyg' || self._wysiwygComposing) return;
        if (!c || !c.from || !c.to || !Array.isArray(c.text)) return;
        // 仅纯插入（零宽替换 from==to）：CM5 对零宽插入也报告 removed=['']（长度 1），
        // 不能按 removed 判「未删内容」，须按 from/to 同点判
        if (c.from.line !== c.to.line || c.from.ch !== c.to.ch) return;
        const L = c.from.line;
        const ins = c.text.join('');
        if (ins.trim() === '') return; // 纯空白不构成表格行，无需下移
        const lineNow = cm.getLine(L);
        // 插入前的行内容（同行纯插入：从当前行内容中挖掉新插文本，它落在 [from.ch, from.ch+len)）
        const before = lineNow.slice(0, c.from.ch) + lineNow.slice(c.from.ch + ins.length);
        if (before.trim() !== '') return; // 该行原本有内容（不是分隔空行）
        self._wysiwygPushTypedLineBelowTable(L);
      });
      this.cm.on('compositionend', () => {
        const cm = self.cm;
        if (self.viewMode !== 'wysiwyg' || !cm) return;
        const cur = cm.getCursor();
        self._wysiwygPushTypedLineBelowTable(cur.line);
      });
    },

    // scroll 钩子（幂等）：虚拟模式下滚动时增量更新视口内遮罩
    _ensureWysiwygScrollHook() {
      if (this._wysiwygScrollHooked || !this.cm) return;
      this._wysiwygScrollHooked = true;
      let t = null;
      const self = this;
      this.cm.on('scroll', () => {
        if (self.viewMode !== 'wysiwyg') return;
        if (self._wysiwygAnchorRestoring) return; // 滚动锚定的恢复性滚动，不再触发更新
        if (self._wysiwygVirtual) {
          if (t) clearTimeout(t);
          t = setTimeout(() => { t = null; self.updateWysiwygViewportMasks(); }, 120);
        } else if (self._wysiwygFull && self._wysiwygIdleMountJob) {
          // 视口优先补挂未完成时快速滚动：把视口内未挂块立即挂上（防源码长闪），
          // 剩余队列重排为从视口附近继续（60ms 防抖：锚定恢复的连续滚动只算一次）
          if (t) clearTimeout(t);
          t = setTimeout(() => { t = null; self._wysiwygFullMountVisible(); }, 60);
        }
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
      // 面板 loading 层：预渲染期间主区仍是旧视图，盖住它，否则用户看到「全是源码过几秒
      // 才渲染出来」（2026-10-11 用户反馈 #2）。复用引用计数的 _beginPaneLoad/_endPaneLoad
      //（与切标签的 loading 嵌套安全）；harness 等无此函数的环境静默跳过。
      // ⚠️ loading 层**不在预渲染完成时释放**：applyViewMode 的 50ms 计时器之后，
      // renderWysiwygMasks 还要挂全部遮罩（挂块 + refresh + 冲刷异步 pass，大文档数秒的
      // 同步步骤）——早放则「loading 消失 → 数秒源码/空白 → 才渲染」（2026-10-13 用户
      // 反馈 #1）。持有标志按代（gen）配对：释放点 = renderWysiwygMasks 挂完（finally）/
      // 中止 / 取消 / 离开所见即所得，四处恰好其一（见 _wysiwygReleasePreRenderLoad）。
      if (typeof this._beginPaneLoad === 'function') this._beginPaneLoad();
      this._wysiwygPreRenderLoadOpen = true;
      const valueAtStart = cm.getValue(); // 完成后校验源文未变
      this._wysiwygPreRenderedValue = valueAtStart;
      this._wysiwygPreRenderTab = tab || null;
      this._wysiwygPreRenderMode = modeAtStart;
      this._wysiwygPreRenderGen = (this._wysiwygPreRenderGen || 0) + 1;
      const gen = this._wysiwygPreRenderGen;
      this._wysiwygPreRenderLoadGen = gen; // 本代预渲染持有 loading 层（释放时按代配对）
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
          self._wysiwygReleasePreRenderLoad(); // 不进入所见即所得，loading 层在此收尾
          self._setWysiwygButtonRendering(false);
          return;
        }
        self._wysiwygPreRendering = false;
        // 注意：此处**不**释放 loading 层——applyViewMode 的 50ms 计时器之后 renderWysiwygMasks
        // 还要挂全部遮罩（数秒同步步骤），早放会露「源码/空白数秒」（2026-10-13 反馈 #1）；
        // 由 renderWysiwygMasks 的 finally 在挂完后释放。
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
    // 释放本代预渲染持有的 loading 层（beginWysiwygPreRender 里 _beginPaneLoad 的配对收尾）。
    // 按代（gen）配对：只有「当前代」的持有才能释放——若期间已启动新一代预渲染（gen 已推进），
    // 旧路径的迟到释放不得消费新 loading 层（_beginPaneLoad 是引用计数，错配会提前撤罩或残留）。
    // 释放点恰好其一：renderWysiwygMasks 挂完（finally）/ 预渲染中止 / 取消 / 离开所见即所得。
    _wysiwygReleasePreRenderLoad() {
      if (!this._wysiwygPreRenderLoadOpen) return;
      if (this._wysiwygPreRenderLoadGen !== this._wysiwygPreRenderGen) return;
      this._wysiwygPreRenderLoadOpen = false;
      if (typeof this._endPaneLoad === 'function') this._endPaneLoad();
    },

    _cancelWysiwygPreRender() {
      if (!this._wysiwygPreRendering) return;
      this._wysiwygPreRendering = false;
      this._wysiwygReleasePreRenderLoad(); // 必须在 gen 推进前：本代持有的 loading 层在此收尾
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

    // 块渲染 html 的首标签（公共口径：margin 对齐 / 块内空行高度共用）：
    // 优先取块渲染 html 的首标签，无 html（parseOnly 增量刷新）时按块首行源码形态判。
    _wysiwygBlockTag(b) {
      if (!b) return '';
      let tag = '';
      if (b.html) {
        const m = /^<(?:div[^>]*>\s*)?([a-zA-Z][a-zA-Z0-9]*)/.exec(b.html);
        tag = m ? m[1].toLowerCase() : '';
      }
      if (!tag) {
        const line = this.cm.getLine(b.start) || '';
        if (/^#{1,6}\s/.test(line)) tag = 'h1';
        else if (/^(`{3,}|~{3,})/.test(line)) tag = 'pre';
        else if (/^\s*>/.test(line)) tag = 'blockquote';
        else if (/^\s*\|/.test(line)) tag = 'table';
        else if (/^\s*([-*+])\s/.test(line) || /^\s*\d+[.)]\s/.test(line)) tag = 'ul';
        else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) tag = 'hr';
        else tag = 'p';
      }
      return tag;
    },

    // 块的 margin-top/margin-bottom（与阅读模式 .preview-content 逐一对齐，
    // 2026-10-17 块间间隙对齐用）：p/ul/ol = 0/14（styles.css p{mb:14}、
    // ul,ol{mb:14}，全局 * reset 后 mt=0）；h1-h6 = 24/12；blockquote = 0/16；
    // pre = 16/16；table = 12/12；hr = 32/32。
    _wysiwygBlockMargins(b) {
      if (!b) return [0, 14];
      const tag = this._wysiwygBlockTag(b);
      if (tag === 'ul' || tag === 'ol') return [0, 14];
      if (/^h[1-6]$/.test(tag)) return [24, 12];
      if (tag === 'pre' || tag === 'code') return [16, 16];
      if (tag === 'blockquote') return [0, 16];
      if (tag === 'table') return [12, 12];
      if (tag === 'hr') return [32, 32];
      if (tag === 'img') return [0, 0];
      return [0, 14];
    },

    // 块间（独立）空行的逐行间隙高度（2026-10-17 用户要求：实时预览与源码预览
    // 样式完全一致含行间距）：阅读模式的块间间隙 = margin 折叠值
    // max(上块 mb, 下块 mt)。WYSIWYG 侧上块 mb 已随 BFC 内收进遮罩底缘、下块
    // mt 被遮罩 > *:first-child 清零 → 空行高度 X = max(0, 下块 mt − 上块 mb)
    // 即补齐剩余差（列表/段落族 = 0，标题相邻 = 24 − 上块 mb …）。
    // 连续多条空行：仅「紧贴下一块」的那条取 X，其余 0（markdown 语义上多空行
    // 等同一个分隔）。尾随空行（下方无块）= 0（上块 mb 已在遮罩底缘内）。
    // 块内空行：列表块（ul/ol，含任务混合块）进表取 0——渲染态该空行本身不占高度
    //（松散列表 li 间距已含在项距里，列表行 4px padding-bottom 与阅读 li 间距同值）
    //→ 活动态取 0 才与渲染态逐像素一致（2026-10-20 用户截图：任务列表+下方无序列表
    // 合并块激活时 ul 段上方多一行 12px 空白）；其余块型块内空行走类默认 12px。
    // 落地：行 handle（Line 对象，同一性键）→ X 的 Map；renderLine 钩子在每次
    // 行（重新）物化时写 inline line-height 覆盖类默认，另对当前视口行立即应用
    //（renderLine 只在重渲染时触发）。
    _updateWysiwygBlankGap() {
      const cm = this.cm;
      const map = new Map();
      const blocks = this._wysiwygBlocks;
      if (blocks && blocks.length && this._wysiwygBlankLines) {
        const lines = new Set(this._wysiwygBlankLines);
        // 光标所在块内空行不在类集合（光标例外摘类恢复全高，2026-10-17）但必须留在
        // 间隙表（2026-10-20）：否则光标离开时无表项可依恢复列表块内空行的 0px。
        // 应用侧由 _wysiwygBlankCurLine 守卫跳过该行（光标行 inline 由 cursorActivity 管）。
        if (this._wysiwygBlankCurLine != null) lines.add(this._wysiwygBlankCurLine);
        for (const i of lines) {
          let inner = null;
          for (const b of blocks) {
            if (i >= b.start && i < b.end) { inner = b; break; }
          }
          if (inner) {
            // 块内空行：列表块取 0（渲染态该空行不占高度，见上注释）；
            // 其余块型保持类默认 12px（不进表 = 无 inline 覆盖）
            const tag = this._wysiwygBlockTag(inner);
            if (tag === 'ul' || tag === 'ol') {
              try { map.set(cm.getLineHandle(i), 0); } catch (_) { /* 行已销毁 */ }
            }
            continue;
          }
          let nextMt = null;
          let prevMb = 0;
          for (const b of blocks) {
            if (b.start === i + 1) nextMt = this._wysiwygBlockMargins(b)[0];
            else if (b.end === i) prevMb = this._wysiwygBlockMargins(b)[1];
          }
          const x = nextMt == null ? 0 : Math.max(0, nextMt - prevMb);
          try { map.set(cm.getLineHandle(i), x); } catch (_) { /* 行已销毁 */ }
        }
      }
      this._wysiwygBlankGap = map;
      // 光标所在块内空行的行内高度由 cursorActivity 同步管理（进=清、离=恢复）：
      // 此处跳过该行，防重渲染把旧表项（如 0px）覆回光标行（光标落进 0px 行不可见）。
      // handler 只创建一次 → 守卫必须每次调用现读 _wysiwygBlankCurLine（闭包捕获会恒旧）
      const isCursorGapLine = (c, lineObj) => {
        const curL = this._wysiwygBlankCurLine;
        if (curL == null) return false;
        let curH = null;
        try { curH = c.getLineHandle(curL); } catch (_) { return false; } /* 行已销毁 */
        return lineObj === curH;
      };
      if (!this._wysiwygBlankGapBound) {
        this._wysiwygBlankGapBound = true;
        this._wysiwygBlankGapHandler = (c, lineObj, preEl) => {
          const m = this._wysiwygBlankGap;
          if (!m || !preEl) return;
          if (isCursorGapLine(c, lineObj)) return;
          this._applyWysiwygBlankGapEl(preEl, m.get(lineObj));
        };
        try { cm.on('renderLine', this._wysiwygBlankGapHandler); } catch (_) { this._wysiwygBlankGapBound = false; }
      }
      // 当前已物化视口行立即应用（renderLine 只对重渲染行触发）
      try {
        const view = cm.display && cm.display.view;
        if (view) {
          for (const lv of view) {
            const lineObj = lv && lv.line;
            const el = lv && lv.node;
            if (!lineObj || !el) continue;
            if (isCursorGapLine(cm, lineObj)) continue;
            this._applyWysiwygBlankGapEl(this._wysiwygGapPreOf(el), map.get(lineObj));
          }
        }
      } catch (_) { /* 视口结构异常，忽略 */ }
    },

    // 行 DOM 上取 pre.CodeMirror-line（wrap 类在行 wrapper div 上，line-height
    // 规则作用于 pre；lv.node 可能是 wrapper）
    _wysiwygGapPreOf(el) {
      if (!el) return null;
      if (el.tagName && el.tagName === 'PRE') return el;
      return el.querySelector ? el.querySelector('pre.CodeMirror-line') : null;
    },

    _applyWysiwygBlankGapEl(preEl, x) {
      if (!preEl) return;
      if (x != null) {
        if (preEl.style.lineHeight !== x + 'px') preEl.style.lineHeight = x + 'px';
      } else if (preEl.style.lineHeight) {
        preEl.style.lineHeight = '';
      }
    },

    // 全量重算空行塌缩集合（diff 增量挂类，避免整篇 addLineClass 重刷）。
    // 调用时机：进入模式的全量重建 + 输入后的防抖补齐。
    // 光标所在空行（2026-10-17 两级语义，2026-10-21 修订）：光标行（块内或块间）
    // 临时恢复全高——光标与灰底指示需要可见（2026-10-21 用户要求：图片上方回车新增
    // 的块间空行需灰色明确指示当前编辑行）；无光标的块间独立空行保持塌缩（点击行与
    // 行之间的缝隙不出现「新行」观感——不创建行，回车才出新行，2026-10-17），均不显示
    // 空行提示（empty-hint.js 口径不变）。
    updateWysiwygBlankLines() {
      const cm = this.cm;
      if (this.viewMode !== 'wysiwyg' || !cm) return;
      const curLine = cm.getCursor().line;
      const next = new Set();
      const total = cm.lineCount();
      for (let i = 0; i < total; i++) {
        if (cm.getLine(i).trim() !== '') continue;
        if (i === curLine) continue; // 光标所在空行：例外，恢复全高（块内/块间同口径）
        next.add(i);
      }
      const prev = this._wysiwygBlankLines;
      // 单 operation 批量挂/摘类：全量模式下空行可达数千，逐行独立操作 =
      // 数千次全视口 display 更新（万行文档进入/离开时卡数秒，2026-10-09 实测风险）。
      // 间隙表 inline 高度写入也在同一 operation（2026-10-21 修复）：原先类 diff 在
      // operation 内、inline 高度在 operation 外写 → CM5 记录的行高（全高 ~27px）与
      // DOM（0px 间隙）失步，下一次编辑操作末 updateHeightsInViewport 按陈旧差值一次性
      // 补偿 scroller.scrollTop（视口上方 95 条空行 × 27.2px ≈ 2571px = 跳到文档顶）
      // ——2026-10-21 用户报「输入文字时页面乱跳、滚动到目录的位置」。同 operation 内
      // 写入让 CM 同趟重测记录，差值为 0，mustScroll 不再爆炸。
      cm.operation(() => {
        if (prev) {
          for (const i of prev) if (!next.has(i)) this._setWysiwygBlankClass(i, false);
          for (const i of next) if (!prev.has(i)) this._setWysiwygBlankClass(i, true);
        } else {
          for (const i of next) this._setWysiwygBlankClass(i, true);
        }
        this._wysiwygBlankLines = next;
        this._wysiwygBlankCurLine = this._isWysiwygBlankLine(curLine) ? curLine : null;
        this._updateWysiwygBlankGap();
      });
    },

    clearWysiwygMasks() {
      // 有格正在源码编辑：先提交回写（切模式/切标签不得丢内容）；
      // 提交内部会重挂一次遮罩，本方法随后的整体清理把它一并撤掉
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true);
      // 在飞的全量预渲染作废（离开所见即所得 / 切标签 / 打开文件）
      this._cancelWysiwygPreRender();
      // 光标行状态复位（2026-10-17 QA 审查 P2）：_wysiwygInlineCurLine 无其它复位点，
      // 本方法在「离开所见即所得 / 切标签 / 打开文件 / 遮罩整体重建」时必被调用；
      // 不复位时新文档光标行号恰与旧值相同 → _applyWysiwygInlineCurLine 的 === 早退，
      // 该行以渲染态显示（源码行类挂在已销毁行上）直到光标移动。
      // 与 renderWysiwygMasks 末尾的 _applyWysiwygInlineCurLine() 配对，重建后即刻重挂。
      this._wysiwygInlineCurLine = null;
      if (this._wysiwygMaskTimer) {
        clearTimeout(this._wysiwygMaskTimer);
        this._wysiwygMaskTimer = null;
      }
      const cm = this.cm;
      // 单 operation 批量撤遮罩 + 撤空行类：全量模式下遮罩可达数千、空行数千，
      // 逐块独立操作 = 数千次 display 更新（万行文档离开模式卡数秒，2026-10-09）
      try {
        cm.operation(() => {
          // 活动块源文态装饰（text marker：标题/列表/代码围栏）同批清（2026-10-14；
          // 离开模式/换文档后作废）
          if (this._wysiwygActiveDecor) {
            for (const m of this._wysiwygActiveDecor) {
              try { m.clear(); } catch (_) { /* 已销毁，忽略 */ }
            }
            this._wysiwygActiveDecor = null;
          }
          // 引用/提示块活动态分段遮罩同批清（2026-10-25 分段口径）
          this._wysiwygClearQuoteSegments();
          if (this._wysiwygMarks) {
            for (const mark of Array.from(this._wysiwygMarks.values())) {
              try { mark.clear(); } catch (_) { /* 已销毁，忽略 */ }
            }
          }
          if (this._wysiwygBlankLines) {
            for (const i of this._wysiwygBlankLines) this._setWysiwygBlankClass(i, false);
          }
          if (this._wysiwygBlankCurLine != null) this._setWysiwygBlankClass(this._wysiwygBlankCurLine, false);
          // 块间空行逐行间隙高度（inline line-height 覆盖）同批撤（2026-10-17）
          if (this._wysiwygBlankGap) {
            const view = cm.display && cm.display.view;
            if (view) {
              for (const lv of view) {
                const el = lv && lv.node;
                if (!el) continue;
                const pre = this._wysiwygGapPreOf(el);
                if (pre && pre.style.lineHeight) pre.style.lineHeight = '';
              }
            }
          }
          // 活动块高亮同批撤掉（离开模式/换文档后旧行对象一律作废；首/末行角类一并撤；
          // 行对象制见文件头 ACTIVE_CLASS 注释，2026-10-17）
          if (this._wysiwygActiveLines) {
            for (const h of this._wysiwygActiveLines) {
              try {
                if (h) {
                  cm.removeLineClass(h, 'background', ACTIVE_CLASS);
                  cm.removeLineClass(h, 'background', ACTIVE_FIRST_CLASS);
                  cm.removeLineClass(h, 'background', ACTIVE_LAST_CLASS);
                  cm.removeLineClass(h, 'background', ACTIVE_CODE_BOX_CLASS);
                }
              } catch (_) { /* 行已销毁（安全 no-op） */ }
            }
          }
          // 正文排版行类同批撤（2026-10-14：编辑态=渲染态的字号/字族/行高/颜色）
          if (this._wysiwygPlainLines) {
            for (const h of this._wysiwygPlainLines) {
              try {
                if (h) {
                  cm.removeLineClass(h, 'text', 'wysiwyg-plain-text');
                  cm.removeLineClass(h, 'text', 'wysiwyg-details-line');
                  cm.removeLineClass(h, 'text', 'wysiwyg-html-block-line');
                  cm.removeLineClass(h, 'text', 'wysiwyg-quote-line');
                  cm.removeLineClass(h, 'text', 'wysiwyg-quote-nested');
                  for (let n = 2; n <= 6; n++) cm.removeLineClass(h, 'text', 'wysiwyg-quote-lvl-' + n); // 嵌套层级类随 nested 同撤
                  // callout 类型行类 + 引用任务行标记（2026-10-30）：随 quote-line 同撤
                  //（wysiwyg-callout-cursor-line 专用类仍由 sync 差分管，不在此撤）
                  for (const t of ['note', 'tip', 'important', 'warning', 'caution']) {
                    cm.removeLineClass(h, 'text', 'wysiwyg-callout-' + t);
                  }
                  cm.removeLineClass(h, 'text', 'wysiwyg-quote-task-line');
                  // 注：callout 光标行类（wysiwyg-callout-cursor-line + wysiwyg-callout-{type}）不在此撤——
                  // 同下款 wysiwyg-quote-cursor-line 口径：防抖重渲后 pre 按行对象重建自动带回，
                  // 撤掉则用户停手（无 cursorActivity 跟随）时光标行 callout 配色丢（2026-10-25
                  // 实测）；进出由 syncWysiwygActiveBlock 现算差分兜底。
                }
              } catch (_) { /* 行已销毁（安全 no-op） */ }
            }
          }
          // ⚠️ 引用光标行类（wysiwyg-quote-cursor-line）不在这里撤（2026-10-20 实测）：
          // 本方法由 renderWysiwygMasks（含 250ms 输入防抖刷新）调起，撤掉后无 cursorActivity
          // 跟随 → 光标行的 > 标志会在每次输入防抖后消失。行类挂在行对象上，防抖重渲后
          // pre 按行对象重建自动带回；进出由 syncWysiwygActiveBlock 的 cursorActivity
          // 现算（_wysiwygQuoteCurLine 状态同样保留，行号失效时挂/撤均为 no-op）。
          // 列表块级排版行类同批撤（2026-10-15：缩进/项间距）
          if (this._wysiwygListLines) {
            for (const h of this._wysiwygListLines) {
              try {
                if (h) {
                  cm.removeLineClass(h, 'text', 'wysiwyg-list-line');
                  cm.removeLineClass(h, 'text', 'wysiwyg-list-indent-ul');
                  cm.removeLineClass(h, 'text', 'wysiwyg-list-indent-ol');
                  cm.removeLineClass(h, 'text', 'wysiwyg-list-cont');
                  for (let n = 2; n <= 6; n++) cm.removeLineClass(h, 'text', 'wysiwyg-list-lvl-' + n);
                }
              } catch (_) { /* 行已销毁（安全 no-op） */ }
            }
            this._wysiwygListLines = null;
          }
          // 代码块内容行排版行类同批撤（2026-10-17）
          if (this._wysiwygCodeLines) {
            for (const h of this._wysiwygCodeLines) {
              try {
                if (h) {
                  cm.removeLineClass(h, 'text', 'wysiwyg-code-line');
                  cm.removeLineClass(h, 'text', 'wysiwyg-code-pad-top');
                  cm.removeLineClass(h, 'text', 'wysiwyg-code-pad-bottom');
                  cm.removeLineClass(h, 'text', 'wysiwyg-code-slot-bottom');
                }
              } catch (_) { /* 行已销毁（安全 no-op） */ }
            }
            this._wysiwygCodeLines = null;
          }
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
      this._wysiwygBlankGap = null;
      // ⚠️ _wysiwygQuoteCurLine 不在此重置（2026-10-20）：引用光标行类不随防抖重渲
      // 清除（见上方 ⚠️ 注释），状态保留才能让 syncWysiwygActiveBlock 的 prev/next
      // 差分在光标移动时正确换行；行号失效时挂/撤类均为 no-op。
      // renderLine 钩子解绑（重进模式时 _updateWysiwygBlankGap 会重新绑定）
      if (this._wysiwygBlankGapBound && this.cm) {
        try { this.cm.off('renderLine', this._wysiwygBlankGapHandler); } catch (_) { /* 忽略 */ }
      }
      this._wysiwygBlankGapBound = false;
      this._wysiwygBlankGapHandler = null;
      this._wysiwygActiveLines = null;
      this._wysiwygPlainLines = null;
      this._wysiwygCodeLines = null;
      this._wysiwygClickAnchor = null;
      this._wysiwygVirtual = false;
      // 离开全量视图驻留：恢复 CM 默认视口余量（整篇驻留只服务于所见即所得；
      // setOption 会触发一次小视口 refresh，成本可忽略）
      this._wysiwygFull = false;
      try {
        if (this.cm && this.cm.options && this.cm.options.viewportMargin > 10) this.cm.setOption('viewportMargin', 10);
      } catch (_) { /* 忽略 */ }
      // 视口优先补挂队列作废（离开模式/整篇重建）；合帧刷新调度一并取消
      this._wysiwygIdleMountJob = null;
      if (this._wysiwygIdleMountTimer) {
        clearTimeout(this._wysiwygIdleMountTimer);
        this._wysiwygIdleMountTimer = null;
      }
      if (this._wysiwygRefreshTimer != null) {
        clearTimeout(this._wysiwygRefreshTimer);
        this._wysiwygRefreshTimer = null;
      }
      this._wysiwygRefreshPending = false;
      // 预渲染块表在此清空：renderWysiwygMasks 顶部先取走快照再调本方法，
      // 其余清理路径（切模式/切标签）顺带作废未消费的预渲染结果
      this._wysiwygPreRenderedBlocks = null;
      this._wysiwygPreRenderedValue = null;
      this._wysiwygMarks = new Map();
      this._wysiwygBlocks = [];
      this._wysiwygActiveIdx = -1;
      this._wysiwygAnchorY = null;
      // 全量重建：所有旧遮罩节点一并作废——节点代数表/待跑冲刷集整体清空，
      // 在飞异步 pass 的代际检查随即判过期停写；挂起的冲刷计时器也一并取消
      this._wysiwygNodeGen = new Map();
      this._wysiwygPendingAsync = new Set();
      if (this._wysiwygAsyncFlushTimer != null) {
        clearTimeout(this._wysiwygAsyncFlushTimer);
        this._wysiwygAsyncFlushTimer = null;
      }
      // 编辑器外壳（行号/最大宽度）随模式同步：离开所见即所得时恢复行号、撤掉居中内缩
      this.applyWysiwygEditorChrome();
    },
  };
  const api = {
    mixin, MASK_CLASS, splitBlocks, splitTableRow, editTableRowCell,
    parseTableStructure, buildTableLine, addTableRow, addTableColumn, moveTableRow, moveTableColumn,
    // 引用块内多行原子结构识别（2026-10-28 分段撕裂修复）：纯行级函数，直接 require 单测
    stripQuotePrefix, quoteAtomicRanges, quoteAtomicRange,
    // 列表/dd 行隐藏标记前缀区终点（2026-10-24 Backspace·Delete 守卫口径）：纯函数，直接 require 单测
    listMarkerZoneEnd,
    // 引用行 `> ` 前缀区终点（2026-10-31 引用守卫口径）：纯函数，直接 require 单测
    quoteMarkerZoneEnd,
  };
  // 互斥式导出：浏览器 <script> 挂 window，node require 走 module.exports。
  // splitBlocks / splitTableRow / editTableRowCell 是纯函数，测试直接 require 本文件
  // 验证切分/回写行为（无需 DOM/CM）。
  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    window.TMWysiwyg = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
