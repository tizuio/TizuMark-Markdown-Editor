// 预览后处理聚合：emoji 短码、数学(KaTeX)、缩写(abbr)、标题锚点、Mermaid、复制按钮。
// 从 app.js 的 renderPreview 中抽取，独立后可单独测试、降低改动爆炸半径。
//
// 设计：每个函数接收 (preview, opts)，依赖通过 opts 注入，不隐式读取全局 this：
//   - preview: 预览容器元素
//   - opts.t: i18n 函数（复制按钮文案）
//   - opts.isDark: 是否深色主题（Mermaid 主题）
//   - opts.escapeHtml / escapeAttr / headingToId: 纯函数（由 app.js 传入，保持既有一致行为）
// 全局依赖：document / navigator / getComputedStyle / mermaid / renderMathInElement（浏览器环境提供）。

// Mermaid ELK 布局注册：frontmatter `config: layout: elk` 需要独立包 @mermaid-js/layout-elk
// （mermaid 核心不含 elk，未注册时渲染抛「Unknown layout algorithm: elk」整图失败）。
// vendor 经 ensure-vendor 打包为全局 MermaidElkLayouts，在此注册一次即全局生效
// （预览 / 主题切换 / DOCX·PDF 导出共用同一个 mermaid 单例，无需各自注册）。
try {
  if (typeof window !== 'undefined' && window.mermaid && window.MermaidElkLayouts
      && typeof window.mermaid.registerLayoutLoaders === 'function') {
    window.mermaid.registerLayoutLoaders(window.MermaidElkLayouts);
  }
} catch (_) { /* 注册失败不阻断预览：elk 图渲染报错，但不影响其它图 */ }

const EMOJI_MAP = {
  ':smile:': '😄', ':joy:': '😂', ':heart:': '❤️', ':thumbsup:': '👍',
  ':thumbsdown:': '👎', ':clap:': '👏', ':wave:': '👋', ':fire:': '🔥',
  ':star:': '⭐', ':check:': '✅', ':x:': '❌', ':warning:': '⚠️',
  ':memo:': '📝', ':bulb:': '💡', ':info:': 'ℹ️', ':question:': '❓',
  ':exclamation:': '❗', ':ok:': '👌', ':cool:': '😎', ':sad:': '😢',
  ':angry:': '😠', ':love:': '😍', ':laughing:': '😆', ':wink:': '😉',
  ':thinking:': '🤔', ':rocket:': '🚀', ':100:': '💯', ':tada:': '🎉',
  ':trophy:': '🏆', ':eyes:': '👀', ':pray:': '🙏', ':muscle:': '💪',
  ':sparkles:': '✨', ':zap:': '⚡', ':sunny:': '☀️', ':cloud:': '☁️',
  ':rain:': '🌧️', ':snow:': '🌨️', ':coffee:': '☕', ':book:': '📖',
  ':pencil:': '✏️', ':computer:': '💻', ':phone:': '📱', ':email:': '📧',
  ':calendar:': '📅', ':clock:': '⏰', ':gift:': '🎁', ':balloon:': '🎈',
  ':party:': '🎉', ':crown:': '👑', ':gem:': '💎', ':key:': '🔑',
  ':lock:': '🔒', ':bell:': '🔔', ':mag:': '🔍', ':package:': '📦',
  ':earth:': '🌍', ':moon:': '🌙', ':rainbow:': '🌈', ':umbrella:': '☂️',
  ':cyclone:': '🌀', ':ocean:': '🌊', ':seedling:': '🌱', ':tree:': '🌳',
  ':flower:': '🌼', ':rose:': '🌹', ':dog:': '🐕', ':cat:': '🐈',
  ':bear:': '🐻', ':bird:': '🐦', ':fish:': '🐟', ':turtle:': '🐢',
  ':octopus:': '🐙', ':penguin:': '🐧', ':butterfly:': '🦋', ':bee:': '🐝',
  ':art:': '🎨', ':music:': '🎵', ':film:': '🎬', ':camera:': '📷',
  ':unlock:': '🔓', ':link:': '🔗', ':scissors:': '✂️', ':pushpin:': '📌'
};

function processEmojiShortcodes(preview) {
  const emojiMap = EMOJI_MAP;
  const skipTags = ['CODE', 'PRE', 'ABBR', 'SCRIPT', 'STYLE', 'TEXTAREA', 'A'];
  const walker = document.createTreeWalker(
    preview,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        let p = node.parentElement;
        while (p) {
          if (skipTags.includes(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (p.classList && p.classList.contains('katex')) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    },
    false
  );
  const textNodes = [];
  let node;
  while (node = walker.nextNode()) textNodes.push(node);

  textNodes.forEach(textNode => {
    const text = textNode.textContent;
    if (!text.includes(':')) return;
    let newText = text;
    for (const [code, emoji] of Object.entries(emojiMap)) {
      if (newText.includes(code)) newText = newText.split(code).join(emoji);
    }
    if (newText !== text) textNode.textContent = newText;
  });
}

// 将文本中"不成对"的 $ / $$ 包进 <span class="katex-ignore">，让 KaTeX 跳过后处理、
// 原样显示 $，同时避免 KaTeX 把孤 $ 跨段配对吞掉内容。
// 规则：成对 $...$ / $$...$$ 保持原样（交给 KaTeX 渲染）；不成对的 $ 包忽略 span。
function isLineBoundary(ch) {
  return ch === undefined || ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t';
}

// 判断行内 $...$ 的内容是否像数学公式（含反斜杠、下标/上标、花括号、运算符等），
// 用于在前后都带空格时避免把 "$ 100 $" "$ or $" 这类货币/短词误判为公式。
function looksLikeMath(inner) {
  const t = inner.trim();
  if (!t) return false;
  // 包含明显数学标记：反斜杠、下标/上标、花括号、对齐符、
  // 常用数学运算符/关系符（> < = + - * / |）以及 ° ± × ÷ ≤ ≥ ≠ ≈ ∞ 等符号；
  // ASCII 单引号 ' 视为求导/素数标记（如 R'、f'）。
  if (/[\\{}_^&#@=+\-*/|<>°±×÷≤≥≠≈∞∈∪∩⊂⊃∑∏∫√′″']/.test(t)) return true;
  // 单字母变量（含希腊字母 Unicode 范围）也视为数学符号；
  // 仅放行单字符，避免 "$ 100 $" "$ or $" 等货币/短词被误判。
  if (/^[A-Za-z\u0370-\u03FF\u1F00-\u1FFF]$/.test(t)) return true;
  return false;
}

function protectUnpairedDollar(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '$' && i + 1 < n && text[i + 1] === '$') {
      // 仅当 $$ 处于"块级"边界（前后为行首/行尾/空白）时才视为显示公式 $$...$$
      const openOk = isLineBoundary(text[i - 1]);
      const close = text.indexOf('$$', i + 2);
      // 块级放宽：只要 $$ 自身成对 + 闭合 $$ 后跟行边界就信任，让 KaTeX 自己用 throwOnError:false 容错。
      // 块级允许跨行（多行 LaTeX 公式），也允许内含 | > ｜（条件概率/绝对值/范数/比较符号等是合法 LaTeX）。
      // 行内 $...$ 也允许 | > ｜；仅在文本节点里还存在另一个 | 时保守跳过，避免把表格单元格分隔符吞进数学。
      const closeOk = close !== -1 &&
        (close + 2 === n || isLineBoundary(text[close + 2])) &&
        (text[close - 1] !== '$');
      if (openOk && closeOk) {
        out += text.substring(i, close + 2);
        i = close + 2;
        continue;
      }
      // 不成对的 $$：包忽略 span（两个独立 $）
      out += '<span class="katex-ignore">$$</span>';
      i += 2;
    } else if (text[i] === '$') {
      // 行内 $...$ 允许前后带空格，但闭合 $ 前是空白且 inner 不像数学时，
      // 保守视为文本边界（如 "$ 100 $"），避免跨段配对吞掉后续真正公式。
      if (i + 1 < n && text[i + 1] !== '$' && text[i + 1] !== '\n' && text[i + 1] !== '\r') {
        const close = text.indexOf('$', i + 1);
        const inner = text.substring(i + 1, close);
        const closePrevIsSpace = close !== -1 &&
          (text[close - 1] === ' ' || text[close - 1] === '\n' || text[close - 1] === '\r' || text[close - 1] === '\t');
        if (close !== -1 &&
            !(closePrevIsSpace && !looksLikeMath(inner)) &&
            !/[\n\r]/.test(inner) &&
            // | 在 inner 内紧邻空白（^|\s \|(?:\s|$)）才是表格列分隔符形态；
            // 紧邻非空白（如 P(A|B)、k|z）是合法数学符号。
            // 修复：只检查 inner 内部的 | 紧邻空白，不再去 $ 前后整个文本里找 |，
            // 否则相邻多个含 | 的合法公式（如 $F\hat{x}_{k-1|k-1}$ $\hat{x}_{k|k-1}=...$）
            // 会因为下一个公式的 | 误把前一个 reject、成对公式被错误包成 ignore span，
            // 导致 KaTeX 跳过 → 预览里只剩 $...$ 源码。
            !/(?:^|\s)\|(?:\s|$)/.test(inner) &&
            (close + 1 >= n || text[close + 1] !== '$')) {
          out += text.substring(i, close + 1);
          i = close + 1;
          continue;
        }
      }
      out += '<span class="katex-ignore">$</span>';
      i += 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}
function processMath(preview) {
  if (typeof renderMathInElement === 'undefined') {
    if (typeof console !== 'undefined') console.warn('[math] renderMathInElement not loaded');
    return;
  }
  try {
    // 先把不成对的 $ / $$ 包进 <span class="katex-ignore">，让 KaTeX 跳过、原样显示 $，
    // 避免孤 $ 跨段配对吞掉正文/表格。
    const skipTags = ['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA'];
    const walker = document.createTreeWalker(
      preview,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          let p = node.parentElement;
          while (p) {
            if (skipTags.includes(p.tagName)) return NodeFilter.FILTER_REJECT;
            if (p.classList && p.classList.contains('katex')) return NodeFilter.FILTER_REJECT;
            p = p.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );
    const toProtect = [];
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.includes('$')) toProtect.push(node);
    }
    for (const t of toProtect) {
      const protectedHTML = protectUnpairedDollar(t.textContent);
      if (protectedHTML !== t.textContent) {
        // 用临时容器把含 span 的 HTML 解析为节点片段，替换原文本节点
        const tmp = document.createElement('div');
        tmp.innerHTML = protectedHTML;
        const frag = document.createDocumentFragment();
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        t.parentNode.replaceChild(frag, t);
      }
    }

    renderMathInElement(preview, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true }
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
      ignoredClasses: ['katex-ignore']
    });
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[math] auto-render error:', e);
  }
}

function processAbbreviations(preview, opts) {
  const { escapeAttr, escapeHtml } = opts;
  const dataDiv = preview.querySelector('#abbr-data');
  if (!dataDiv) return;
  try {
    const abbrs = JSON.parse(dataDiv.getAttribute('data-abbrs'));
    if (!abbrs || !abbrs.length) { dataDiv.remove(); return; }

    abbrs.sort((a, b) => b[0].length - a[0].length);

    const skipTags = ['CODE', 'PRE'];
    const walker = document.createTreeWalker(
      preview,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          let p = node.parentElement;
          while (p) {
            if (skipTags.includes(p.tagName)) return NodeFilter.FILTER_REJECT;
            if (p.classList && p.classList.contains('katex')) return NodeFilter.FILTER_REJECT;
            p = p.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );

    const replacements = [];
    let node;
    while (node = walker.nextNode()) {
      let text = node.textContent;
      let modified = false;

      for (const [term, def] of abbrs) {
        if (!text.includes(term)) continue;
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, 'g');
        if (regex.test(text)) {
          modified = true;
          const safeDef = escapeAttr(def);
          const safeTerm = escapeHtml(term);
          text = text.replace(regex, `<abbr title="${safeDef}">${safeTerm}</abbr>`);
        }
      }

      if (modified) replacements.push({ node, html: text });
    }

    for (const { node, html } of replacements) {
      const span = document.createElement('span');
      span.innerHTML = html;
      node.replaceWith(...span.childNodes);
    }

    dataDiv.remove();
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[preview] Abbreviations error:', e);
    dataDiv.remove();
  }
}

function processHeadings(preview, opts) {
  const { headingToId } = opts;
  const idCount = {};
  preview.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
    if (heading.id) return;
    const text = heading.textContent;
    let id = headingToId(text);
    if (idCount[id]) {
      idCount[id]++;
      heading.id = id + '-' + idCount[id];
    } else {
      idCount[id] = 1;
      heading.id = id;
    }
  });
}

async function processMermaid(preview, opts) {
  const { isDark, mermaidCache } = opts;
  if (typeof mermaid === 'undefined') return;

  const blocks = Array.from(preview.querySelectorAll('code.language-mermaid'));
  if (blocks.length === 0) return;

  const themeKey = isDark ? 'dark' : 'light';
  const toRender = []; // cache miss：需调 mermaid.run 的容器

  blocks.forEach((block, index) => {
    const pre = block.parentElement;
    const sourceLine = block.dataset.sourceLine;
    const code = block.textContent;
    const cacheKey = themeKey + '::' + code;

    const container = document.createElement('div');
    container.className = 'mermaid-container';
    container.id = 'mermaid-' + Date.now() + '-' + index;
    container.setAttribute('data-code', code);
    if (sourceLine) container.setAttribute('data-source-line', sourceLine);

    const cached = mermaidCache ? mermaidCache.get(cacheKey) : null;
    if (cached) {
      // 命中缓存：直接复用上次的 SVG，不进 mermaid.run
      container.innerHTML = cached;
    } else {
      // 未命中：放入待渲染队列（textContent 必须是原始 code，mermaid.run 才能解析）
      container.textContent = code;
      toRender.push({ container, cacheKey });
    }
    pre.replaceWith(container);
  });

  // 只渲染未命中的（命中复用的不再跑 mermaid.run，避免 "already rendered" 报错）
  if (toRender.length === 0) return;

  try {
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      // strict：转义图内嵌 HTML 标签/click 事件（loose 允许 <img onerror> 在预览执行，XSS 面）
      securityLevel: 'strict',
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif',
    });
    await mermaid.run({ nodes: toRender.map(x => x.container) });
    // 渲染成功后存入缓存（仅缓存含 SVG 的成功结果，错误信息不缓存）
    if (mermaidCache) {
      for (const { container, cacheKey } of toRender) {
        if (container.querySelector('svg')) {
          mermaidCache.set(cacheKey, container.innerHTML);
        }
      }
    }
  } catch (e) {
    if (typeof console !== 'undefined') console.error('Mermaid rendering error:', e);
  }
}

// 取代码块原始文本（不含行号、保留缩进与换行）。
// 渲染后结构为 .code-scroll > .code-line >(.code-line-num + .code-line-text)，
// 若直接读 code.textContent 会把「行号数字」和「代码」无换行地拼在一起，
// 导致粘贴后格式/缩进丢失且混入行号。这里只取每行 .code-line-text。
function getRawCodeText(pre) {
  const code = pre.querySelector('code');
  if (!code) return pre.textContent;
  const lineTexts = code.querySelectorAll('.code-line-text');
  if (lineTexts.length === 0) {
    // 单行块（无 .code-line 包裹）或未做行号包裹的原始 <code>：
    // 直接 textContent 即可，已含正确换行与缩进，且不含行号。
    const t = code.textContent;
    return t === ' ' ? '' : t;
  }
  // 多行块：逐行取 .code-line-text（仅原始代码，不含行号），按 \n 还原。
  // 渲染时空行被替换为 &nbsp; 占位，这里还原为空，避免粘贴出多余不间断空格。
  return Array.from(lineTexts, span => {
    const t = span.textContent;
    return t === ' ' ? '' : t;
  }).join('\n');
}

function addCopyButtons(preview, opts) {
  const { t } = opts;
  preview.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-btn')) return;
    if (pre.querySelector('code.language-mermaid')) return;

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = t('copy');
    btn.title = t('copyCode');

    btn.addEventListener('click', async () => {
      const text = getRawCodeText(pre);
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = t('copied');
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = t('copy');
          btn.classList.remove('copied');
        }, 2000);
      } catch (err) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        btn.textContent = t('copied');
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = t('copy');
          btn.classList.remove('copied');
        }, 2000);
      }
    });

    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
}

// 浏览器：作为独立 <script> 加载，挂到全局 PreviewPost
if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.PreviewPost = {
    processEmojiShortcodes, processMath, processAbbreviations,
    processHeadings, processMermaid, addCopyButtons, getRawCodeText,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processEmojiShortcodes, processMath, processAbbreviations,
    processHeadings, processMermaid, addCopyButtons, EMOJI_MAP,
    protectUnpairedDollar, getRawCodeText,
  };
}
