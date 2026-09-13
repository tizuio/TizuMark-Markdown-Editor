const { unified } = require('unified');
const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkRehype = require('remark-rehype').default || require('remark-rehype');
const rehypeRaw = require('rehype-raw').default || require('rehype-raw');
// rehype-sanitize 是声明依赖，但某些安装环境下可能未实际装入 node_modules。
// 缺失时降级为仅使用字符串级 sanitizeHTML（不删 width/src），保证渲染不崩且尺寸属性保留。
let rehypeSanitize = null;
try {
  rehypeSanitize = require('rehype-sanitize').default || require('rehype-sanitize');
} catch (_) {
  rehypeSanitize = null;
}
const rehypeStringify = require('rehype-stringify').default || require('rehype-stringify');
const { visit } = require('unist-util-visit');
const { convertMd2Tables } = require('./md2/scan.js');
const { renderTable: renderMd2Table } = require('./md2/html.js');

// ---- md2 表格支持 ----
// 单元格内容重入守卫：md2 禁止表格嵌套（§1.4），因此单元格内容渲染期间
// 不再执行 md2 表格转换。这同时杜绝无限递归——嵌套深度恒为 1，
// 无需设计规格中的「深度上限」。
// ⚠️ 前提：本守卫依赖 renderMarkdown 是**同步**的。若日后改为 async，
// 该模块级标志会在 await 期间被并发渲染串扰，守卫不再可靠。
let _renderingMd2Cell = false;

/**
 * md2 单元格内容渲染器：把单元格内的 Markdown 回灌同一条 unified 管线，
 * 从而获得完整 CommonMark（含行内标记、列表、代码块等）。
 * 产物作为原始 HTML 拼进表格标记，随后由 rehype-raw 重新解析并 sanitize。
 */
function renderMd2CellContent(text) {
  const src = String(text == null ? '' : text);
  if (src.trim() === '') return '';
  if (_renderingMd2Cell) return escapeHTML(src); // 防御：结构上不可达
  _renderingMd2Cell = true;
  try {
    // 剥掉片段相对行号：remarkSourceLine 注入的 data-source-line 是**相对单元格**
    // 的行号，而 preview-sync 会拿它跳转源码位置——留着会跳到错误行。
    // 剥掉后行为统一为「不跳」，优于「跳错」。（表格外层的原始 HTML 本就没有该属性。）
    return renderMarkdown(src, { softBreaks: false }).replace(/\sdata-source-line="[^"]*"/g, '');
  } catch (err) {
    // 管线内异常已被 renderMarkdown 自己兜底；能走到这里说明是管线外前置步骤抛错，
    // 静默吞掉会让这类问题无从诊断。
    console.error('[md2] 单元格内容渲染失败，回退为转义文本:', err);
    return escapeHTML(src);
  } finally {
    _renderingMd2Cell = false;
  }
}

// ---- remark plugin: add data-source-line from AST position ----
function remarkSourceLine() {
  return (tree) => {
    visit(tree, (node) => {
      if (node.position && node.position.start && node.data === undefined) {
        node.data = {};
      }
      if (node.position && node.position.start) {
        node.data.hProperties = node.data.hProperties || {};
        node.data.hProperties['data-source-line'] = String(node.position.start.line);
      }
    });
  };
}

// ---- rehype plugin: assign stable slug ids to headings (for in-doc anchor links) ----
function getTextContent(node) {
  if (node.type === 'text') return node.value;
  if (node.children) return node.children.map(getTextContent).join('');
  return '';
}

// 必须与 app.js 的 headingToId() 保持完全一致：同一套 slug 规则，
// 否则渲染出的 heading id 与大纲/锚点点击定位用的 id 对不上（已有测试守卫）。
// 规则：字母/数字保留并转小写；空格/_/- 统一转连字符；其余字符（标点、中文标点等）跳过；
// 最后合并连续连字符、去掉首尾连字符。
function slugifyHeading(text) {
  let id = '';
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      id += ch.toLowerCase();
    } else if (ch === ' ' || ch === '-' || ch === '_') {
      id += '-';
    }
  }
  return id.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function rehypeHeadingIds() {
  return (tree) => {
    const used = new Map();
    visit(tree, 'element', (node) => {
      if (!/^h[1-6]$/.test(node.tagName)) return;
      const text = getTextContent(node);
      if (!text) return;
      let slug = slugifyHeading(text) || 'section';
      if (used.has(slug)) {
        const n = used.get(slug) + 1;
        used.set(slug, n);
        slug = slug + '-' + n;
      } else {
        used.set(slug, 1);
      }
      node.properties = node.properties || {};
      node.properties.id = slug;
    });
  };
}

// ---- rehype plugin: GitHub 兼容的行内反引号数学 `` `$...$` `` ----
// GitHub 允许用反引号包裹 `$...$`（或 `$$...$$`）写行内数学，用于表达式含与 Markdown
// 冲突的字符（如 `_` `*`）。unified 会把 `` `$...$` `` 解析成 <code>$...$</code>，
// 而 KaTeX（processMath）默认跳过 <code>，于是显示成代码而非公式。
// 此处把「行内 code（父非 pre）且内容恰好是 $...$ / $$...$$」的元素解包为纯文本 $...$，
// 交给现有 KaTeX 管线渲染，与 GitHub 行为一致。
// 排除项：块级代码（pre > code，如 ``` 围栏）即使内容是 $...$ 也保持为代码（GitHub 同理）。
function rehypeInlineBacktickMath() {
  return (tree) => {
    visit(tree, 'element', (node, _index, parent) => {
      if (node.tagName !== 'code') return;
      if (parent && parent.tagName === 'pre') return; // 块级代码保留
      if (!node.children || node.children.length !== 1 || node.children[0].type !== 'text') return;
      const text = node.children[0].value;
      // 单行、以 $ 开头且以 $ 结尾（至少一个 $）；避免误伤普通代码（如 `$ npm install $`）
      if (!/^\$+[^\n]+\$+$/.test(text)) return;
      // 反引号包裹的数学语义上是"行内"，但 $$...$$ 会被 KaTeX 视为 display math（导致换行）。
      // 因此把反引号内的 $$...$$ 归一化为 $...$，保持行内渲染；GitHub 官方写法 $`...`$ 同理。
      const normalized = text.replace(/^\$\$(.*?)\$\$$/, (_, inner) => `$${inner}$`);
      node.type = 'text';
      node.value = normalized;
      delete node.tagName;
      delete node.children;
      delete node.properties;
    });
  };
}

// GitHub 官方行内反引号数学：`$`...`$`（美元在外、反引号在内）。
// Markdown 解析为 text("$") + code(...) + text("$")，需把三者合并为 $...$ 文本交给 KaTeX。
function rehypeInlineDollarBacktickMath() {
  // GitHub 官方行内反引号数学：$`...`$ （美元在外、反引号在内）。
  // Markdown 解析为 text("$") + code(...) + text("$")，需把三者合并为 $...$ 文本交给 KaTeX。
  // 前导 $ 有两种形态：① 文本以 $ 结尾（如 "uses $`x`$" → 文本 "uses $"）；
  //                     ② `` `$` `` 代码跨度（如 "a `$`x`$ b" → code "$"）。
  const transform = (nodes) => {
    const out = [];
    let i = 0;
    while (i < nodes.length) {
      const n = nodes[i];
      if (n.type === 'element' && n.tagName !== 'code') {
        n.children = transform(n.children || []);
      }
      const prev = out.length ? out[out.length - 1] : null;
      const next = nodes[i + 1];
      if (
        n.type === 'element' && n.tagName === 'code' &&
        n.children && n.children.length === 1 && n.children[0].type === 'text' &&
        next && next.type === 'text' && next.value.startsWith('$')
      ) {
        const codeText = n.children[0].value;
        // 代码内容不得含换行；`\$`（转义）允许，KaTeX 按字面量渲染
        if (!/[\n\r]/.test(codeText)) {
          let removedOpener = false;
          if (prev && prev.type === 'text' && prev.value.endsWith('$')) {
            prev.value = prev.value.slice(0, -1);
            removedOpener = true;
          } else if (
            prev && prev.type === 'element' && prev.tagName === 'code' &&
            prev.children && prev.children.length === 1 && prev.children[0].type === 'text' &&
            prev.children[0].value === '$'
          ) {
            out.pop();
            removedOpener = true;
          }
          if (removedOpener) {
            out.push({ type: 'text', value: '$' + codeText + '$' });
            const rest = next.value.slice(1);
            if (rest.length) out.push({ type: 'text', value: rest });
            i += 2;
            continue;
          }
        }
      }
      out.push(n);
      i++;
    }
    return out;
  };
  return (tree) => { transform(tree.children); };
}


// ---- pre-processing ----

function countBacktickPrefix(s) {
  let count = 0;
  for (const c of s) {
    if (c === '`') count++;
    else break;
  }
  return count;
}

// 判断 content[i] 是否位于「块级起点」：行首，或 markdown 引用前缀（> / > > ...）之后。
// 用于块级 $$...$$ 触发判定——引用块内的 $$ 前是 "> "，字符流上非行首，但语义上是块级起点。
function isAtBlockStart(content, i) {
  if (i === 0) return true;
  if (content[i - 1] === '\n' || content[i - 1] === '\r') return true;
  const lineStart = content.lastIndexOf('\n', i - 1) + 1;
  let j = lineStart;
  while (j < i) {
    if (content[j] === ' ' || content[j] === '\t') { j++; continue; }
    if (content[j] === '>') {
      j++;
      if (j < i && (content[j] === ' ' || content[j] === '\t')) j++;
      continue;
    }
    return false; // 行首到 i 之间出现其他字符（如文字、列表标记），不算块级起点
  }
  return true;
}

// Guard math blocks: $$...$$ → <!--MATHBLOCK_N--> and $...$ → <!--MATHBLOCK_N-->

// 行内 $...$ 允许前后带空格，但前后都带空格时容易误把 "$ 100 $" "$ or $" 这类货币/短词当成数学。
// 用简单启发式判断 inner 是否像数学：含反斜杠、下标/上标、花括号、运算符/关系符等。
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

function guardMathBlocks(content) {
  const placeholders = [];
  let result = '';
  let i = 0;
  const len = content.length;
  let inBacktick = false;
  let inDoubleBacktick = false;
  let inCodeBlock = false;
  let codeFenceCount = 0;
  let inCodeTag = false;

  while (i < len) {
    // Track fenced code blocks (3+ backticks)
    if (content[i] === '`') {
      let btCount = 1;
      while (i + btCount < len && content[i + btCount] === '`') btCount++;
      if (btCount >= 3) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeFenceCount = btCount;
          result += content.substring(i, i + btCount);
          i += btCount;
          continue;
        } else if (btCount >= codeFenceCount) {
          inCodeBlock = false;
          result += content.substring(i, i + btCount);
          i += btCount;
          continue;
        }
      }
    }

    // Inside fenced code block: skip all processing (including double-backtick)
    if (inCodeBlock) {
      result += content[i];
      i++;
      continue;
    }

    // Double backtick code span: ``...`` — toggle as a unit, not per-backtick
    if (content[i] === '`' && content[i + 1] === '`' && (i + 2 >= len || content[i + 2] !== '`')) {
      inDoubleBacktick = !inDoubleBacktick;
      result += '``';
      i += 2;
      continue;
    }

    // Track <code> and </code> tags
    const inAnyCode = inBacktick || inDoubleBacktick;
    if (!inAnyCode) {
      if (content.substring(i, i + 6) === '<code>') {
        inCodeTag = true;
        result += '<code>';
        i += 6;
        continue;
      }
      if (content.substring(i, i + 7) === '</code>') {
        inCodeTag = false;
        result += '</code>';
        i += 7;
        continue;
      }
    }

        // code 标签内的 <center> 等内容是 Markdown 行内代码，必须转义为文本，不能再次作为 HTML 标签。
        if (inCodeTag) {
          result += escapeHTML(content[i]);
          i++;
          continue;
        }

    // Inside double-backtick span: single backticks are content, not toggles
    if (inDoubleBacktick) {
      result += content[i];
      i++;
      continue;
    }

    // Track inline backticks (single `)
    if (content[i] === '`') {
      inBacktick = !inBacktick;
      result += content[i];
      i++;
      continue;
    }

    // \( 与 \[ 故意不拦截：CommonMark 中它们是转义（字面 ( / [），作数学定界符会与
    // 转义语义冲突（如引用 \[J/OL\] 被误渲染为公式）。数学请用 $ / $$。
    else if (content[i] === '$' && i + 1 < len && content[i + 1] === '$') {
      // Display math: $$...$$ — 仅在块级起点（行首或引用前缀后）触发；行内 $$ 一律当字面量，避免跨段配对
      const atBlockStart = isAtBlockStart(content, i);
      if (!atBlockStart) {
        result += '$$';
        i += 2;
        continue;
      }
      const start = i;
      const lineNum = content.substring(0, start).split('\n').length;
      i += 2;
      let foundEnd = false;
      while (i + 1 < len) {
        // 跨空行（\n\n）即停止配对并回退为字面量，避免块级 $$ 吞掉后续段落/列表/引用内容
        if (content[i] === '\n' && (content[i + 1] === '\n' || content[i + 1] === '\r')) {
          break;
        }
        if (content[i] === '$' && content[i + 1] === '$') {
          i += 2;
          const mathBlock = content.substring(start, i);
          const idx = placeholders.length;
          placeholders.push({ text: mathBlock, line: lineNum, display: true });
          const mathContent = content.substring(start, i);
          const newlineCount = (mathContent.match(/\n/g) || []).length;
          result += '<div class="math-placeholder" data-math-idx="' + idx + '" data-source-line="' + lineNum + '"></div>';
          for (let n = 0; n < newlineCount; n++) { result += '\n'; }
          foundEnd = true;
          break;
        }
        i++;
      }
      if (!foundEnd) {
        result += '$$';
        i = start + 2;
      }
    } else if (!inBacktick && content[i] === '$' && i + 1 < len && content[i + 1] !== '\n' && content[i + 1] !== '\r' && content[i + 1] !== '$' && content[i + 1] !== '`' && content[i + 1] !== '<') {
      // Inline math: $...$ — 允许前后带空格，但前后都带空格且内容不像数学时保守拒绝，
      // 避免把 "$ 100 $" 这类货币文本当成公式。
      const start = i;
      i += 1;
      let foundEnd = false;
      while (i < len) {
        // 遇到 HTML 标签开头时立即中断：避免 $...$ 跨 <td></td> 等原始 HTML 标签配对，
        // 把 table 单元格之间的 $ 破坏成字面量（ KaTeX 在 DOM 阶段仍会分别渲染单元格内公式）。
        if (content[i] === '<' && i + 1 < len && (content[i + 1] === '/' || /[a-zA-Z]/.test(content[i + 1]))) {
          break;
        }
        if (content[i] === '$') {
          const inner = content.substring(start + 1, i);
          const prev = content[i - 1];
          const closePrevIsSpace = prev === ' ' || prev === '\n' || prev === '\r' || prev === '\t';
          // 闭合 $ 前是空白且 inner 不像数学：认为这是文本边界，当前开 $ 不成对。
          if (closePrevIsSpace && !looksLikeMath(inner)) {
            break;
          }
          // 不成对/跨行一律不当公式。
          // | 两侧紧邻空白（" | " 或行首/行尾空白+竖线）时视为表格列分隔符，保守拒绝；
          // 紧邻非空白（如 P(A|B)、k|z）是条件概率/绝对值等合法数学符号，放行并保护占位。
          let reject = /[\n\r]/.test(inner);
          if (!reject && inner.includes('|') && /(?:^|\s)\|(?:\s|$)/.test(inner)) {
            reject = true;
          }
          if (!reject) {
            i += 1;
            const mathBlock = content.substring(start, i);
            const idx = placeholders.length;
            placeholders.push({ text: mathBlock, display: false });
            result += '<!--MATHBLOCK_' + idx + '-->';
            foundEnd = true;
            break;
          }
        }
        i++;
      }
      if (!foundEnd) {
        result += '$';
        i = start + 1;
      }
    } else {
      result += content[i];
      i++;
    }
  }
  return { content: result, placeholders };
}

// Convert GitHub-style math fences (```math / ```latex / ```tex) into $$...$$ blocks
// so they flow through the existing KaTeX (processMath) pipeline. This keeps TizuMark
// behavior aligned with GitHub/Gitee: the fence body is rendered as block math without
// requiring $$ delimiters inside (matches GitHub's ```math documentation).
function convertMathFences(content) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  const body = [];
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!inFence) {
      const open = trimmed.match(/^(`{3,}|~{3,})\s*(math|latex|tex)\s*$/i);
      if (open) {
        inFence = true;
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        body.length = 0;
        i++;
        continue;
      }
      out.push(line);
      i++;
      continue;
    }
    const close = trimmed.match(/^(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
      out.push('$$');
      for (const b of body) out.push(b);
      out.push('$$');
      inFence = false;
      i++;
      continue;
    }
    body.push(line);
    i++;
  }
  // Unterminated fence: emit as $$ block anyway so it still renders (not raw code)
  if (inFence) {
    out.push('$$');
    for (const b of body) out.push(b);
    out.push('$$');
  }
  return out.join('\n');
}

// Convert > [!TYPE] alerts to placeholders, let unified handle markdown inside
function getAlertType(line) {
  const lower = line.toLowerCase();
  if (lower.startsWith('> [!info]') || lower.startsWith('> [!note]')) return 'note';
  if (lower.startsWith('> [!tip]')) return 'tip';
  if (lower.startsWith('> [!important]')) return 'important';
  if (lower.startsWith('> [!warning]')) return 'warning';
  if (lower.startsWith('> [!caution]')) return 'caution';
  return null;
}

function getAlertTitleHTML(type, customTitle) {
  // callout 图标统一使用 Lucide（内联 SVG，currentColor 继承各类型主题色）。
  // note→sticky-note / tip→lightbulb / important→info / warning→triangle-alert / caution→octagon-alert
  //（Lucide 规范名：triangle-alert / octagon-alert，旧名 alert-triangle / alert-octagon 为 alias）
  const icons = {
    note: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><path d="M15 3v5a1 1 0 0 0 1 1h5"/></svg>',
    tip: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
    important: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    warning: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    caution: '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/></svg>'
  };
  const titles = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
  // customTitle 为用户在 > [!TYPE] 后写的自定义标题；标题按纯文本渲染，需转义防 XSS
  let label = titles[type] || type;
  if (customTitle) {
    label = customTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  return '<div class="alert-title">' + (icons[type] || '') + label + '</div>';
}

function convertAlerts(content) {
  const lines = content.split('\n');
  const result = [];
  const alertBlocks = [];
  let i = 0;
  let inCodeBlock = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      i++;
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }
    const alertType = getAlertType(line);
    if (alertType) {
      // 解析自定义标题：> [!TYPE] 标题文本（[!TYPE] 之后到行尾的内容，去前导空白即标题）
      let customTitle = null;
      const titleMatch = line.match(/^\s*>\s*\[!\w+\]\s*(.*)$/i);
      if (titleMatch && titleMatch[1].trim()) {
        customTitle = titleMatch[1].trim();
      }
      const contentLines = [];
      i++;
      while (i < lines.length && lines[i].startsWith('>')) {
        let stripped = lines[i];
        if (stripped.startsWith('> ')) stripped = stripped.substring(2);
        else if (stripped.startsWith('>')) stripped = stripped.substring(1);
        contentLines.push(stripped);
        i++;
      }
      const idx = alertBlocks.length;
      alertBlocks.push({ type: alertType, title: customTitle, content: contentLines.join('\n') });
      // 将 END 标记附着到最后一行内容末尾，避免增加额外行
      if (contentLines.length > 0) {
        contentLines[contentLines.length - 1] += '<!--ALERTBLOCK_' + idx + '_END-->';
      }
      result.push('<!--ALERTBLOCK_' + idx + '-->');
      result.push(contentLines.join('\n'));
    } else {
      result.push(line);
      i++;
    }
  }
  return { content: result.join('\n'), alertBlocks };
}

function restoreAlerts(html, alertBlocks) {
  if (alertBlocks.length === 0) return html;
  let result = html;
  for (let idx = alertBlocks.length - 1; idx >= 0; idx--) {
    const block = alertBlocks[idx];
    const startMarker = '<!--ALERTBLOCK_' + idx + '-->';
    const endMarker = '<!--ALERTBLOCK_' + idx + '_END-->';
    const startPos = result.indexOf(startMarker);
    const endPos = result.indexOf(endMarker);
    if (startPos !== -1 && endPos !== -1) {
      const before = result.substring(0, startPos);
      const inner = result.substring(startPos + startMarker.length, endPos);
      const after = result.substring(endPos + endMarker.length);
      const titleHTML = getAlertTitleHTML(block.type, block.title);
      result = before + '<div class="alert alert-' + block.type + '">' + titleHTML + '<div class="alert-content">' + inner + '</div></div>' + after;
    }
  }
  return result;
}

// Convert definition lists
// 为 <dl>/<dt>/<dd> 添加 data-source-line，确保滚动同步能映射到这些元素
function convertDefLists(content) {
  const lines = content.split('\n');
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    // Check if next line starts with ": " (definition)
    if (i + 1 < lines.length) {
      const next = lines[i + 1];
      if ((next.startsWith(': ') || next === ':') &&
          trimmed !== '' &&
          !trimmed.startsWith('#') &&
          !trimmed.startsWith('-') &&
          !trimmed.startsWith('*') &&
          !trimmed.startsWith('>') &&
          !trimmed.startsWith('|') &&
          !trimmed.startsWith('`') &&
          !trimmed.startsWith('[') &&
          !trimmed.startsWith('<') &&
          !trimmed.startsWith('!')) {
        const dlLine = i + 1;
        const firstIdx = result.length; // 第一个 dt/dd 在 result 中的索引
        while (i < lines.length && !lines[i].trim().startsWith('#') && !lines[i].trim().startsWith('>') &&
               lines[i].trim() !== '' && !lines[i].trim().startsWith('|') &&
               !lines[i].trim().startsWith('`')) {
          const termLine = i + 1;
          const term = lines[i];
          result.push('<dt data-source-line="' + termLine + '">' + term + '</dt>');
          i++;
          while (i < lines.length && (lines[i].startsWith(': ') || lines[i] === ':')) {
            const defLine = i + 1;
            let def = lines[i];
            if (def.startsWith(': ')) def = def.substring(2);
            else if (def === ':') def = '';
            result.push('<dd data-source-line="' + defLine + '">' + def + '</dd>');
            i++;
          }
        }
        // 将 <dl> 前置到第一个 dt/dd，将 </dl> 后置到最后一行，避免增加额外行
        if (result.length > firstIdx) {
          result[firstIdx] = '<dl data-source-line="' + dlLine + '">' + result[firstIdx];
          result[result.length - 1] += '</dl>';
        }
        continue;
      }
    }
    result.push(line);
    i++;
  }
  return result.join('\n');
}

// Convert container-embedded GFM tables (lazy continuation)
// e.g., > text\n| a | b |\n| - | - |\n| 1 | 2 |
// Converts to HTML <table> before unified pipeline so remark doesn't miss them
function convertContainerTables(content) {
  const lines = content.split('\n');
  const result = [];
  let i = 0;
  let inCodeBlock = false;
  // 容器上下文（块引用 / 列表）懒续状态：遇到显式带前缀的行进入，空行退出
  let inContainer = false;
  let curContainerPrefix = '';

  while (i < lines.length) {
    const line = lines[i];

    if (/^ {0,3}(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      inContainer = false;
      curContainerPrefix = '';
      result.push(line);
      i++;
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }

    const sp = stripContainerPrefix(line);
    // 更新容器状态：空行打破懒续；显式带容器前缀的行刷新前缀并进入容器；
    // 其余情况（非空、无容器前缀 → 懒续）保持容器状态不变
    if (line.trim() === '') {
      inContainer = false;
      curContainerPrefix = '';
    } else if (sp.prefix.trim() !== '') {
      inContainer = true;
      curContainerPrefix = sp.prefix;
    }

    if (i + 1 < lines.length) {
      const spNext = stripContainerPrefix(lines[i + 1]);
      if (isTableRow(sp.body) && isTableSep(spNext.body)) {
        const prevIdx = prevNonBlankLine(lines, i - 1);
        // 触发条件（任一满足即转换）：
        //  1) 当前处于容器上下文（块引用/列表懒续，或本行本身带容器前缀）→ 表格在容器内
        //  2) 紧邻上一行非空（无空行分隔）→ 修复"文字段 + 表格紧挨"不渲染表格。
        //  说明：GFM 表格需与上文用空行分隔，remark-gfm 对"无空行紧接的表格"不会识别，
        //  此处统一转为 HTML；有空行分隔的表格由 remark-gfm 正常处理，不重复转换。
        const inContainerCtx = inContainer || sp.prefix.trim() !== '';
        const adjacentNoBlank = prevIdx !== -1 && prevIdx === i - 1;
        if (inContainerCtx || adjacentNoBlank) {
          const tableLines = [sp.body, spNext.body];
          let j = i + 2;
          while (j < lines.length) {
            const s = stripContainerPrefix(lines[j]);
            if (isTableRow(s.body)) {
              tableLines.push(s.body);
              j++;
            } else {
              break;
            }
          }
          const tableHtml = gfmTableToHtml(tableLines);
          // 容器内表格加回前缀（> / 列表符），确保 <table> 仍位于容器内；
          // 顶层段落紧随的表格则不加前缀，直接作为顶层表格渲染。
          const prefix = sp.prefix.trim() !== '' ? sp.prefix : (inContainer ? curContainerPrefix : '');
          const prefixedHtml = prefix
            ? tableHtml.split('\n').map(l => l === '' ? l : prefix + l).join('\n')
            : tableHtml;
          result.push(prefixedHtml);
          i = j;
          continue;
        }
      }
    }

    result.push(line);
    i++;
  }

  return result.join('\n');
}

function isContainerLine(line) {
  const t = line.trimStart();
  return /^>/.test(t) || /^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t);
}

function isTableRow(line) {
  return /^\|.+\|$/.test(line.trim());
}

function isTableSep(line) {
  const t = line.trim();
  return /^\|[-:| ]+\|$/.test(t) && /---/.test(t);
}
function stripContainerPrefix(line) {
  const m = line.match(/^(\s*(?:>\s*)*)([\s\S]*)$/);
  return { prefix: m[1], body: m[2] };
}

function prevNonBlankLine(lines, startIdx) {
  for (let i = startIdx; i >= 0; i--) {
    if (lines[i].trim() !== '') return i;
  }
  return -1;
}

function gfmTableToHtml(tableLines) {
  const allLines = tableLines.map(l => l.trim());
  const headerLine = allLines[0];
  const sepLine = allLines[1];
  const dataLines = allLines.slice(2).filter(l => l !== '');

  const headerCells = headerLine.split('|').filter((c, i, a) => i > 0 && i < a.length - 1);
  const colCount = headerCells.length;

  const sepCells = sepLine.split('|').filter((c, i, a) => i > 0 && i < a.length - 1);
  const aligns = sepCells.map(cell => {
    const t = cell.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.endsWith(':')) return 'right';
    if (t.startsWith(':')) return 'left';
    return null;
  });

  let html = '<table>\n<thead>\n<tr>\n';
  for (let ci = 0; ci < colCount; ci++) {
    const align = aligns[ci] || null;
    html += '<th' + (align ? ' style="text-align:' + align + '"' : '') + '>' + renderCellContent(headerCells[ci].trim()) + '</th>\n';
  }
  html += '</tr>\n</thead>\n';

  if (dataLines.length > 0) {
    html += '<tbody>\n';
    for (const row of dataLines) {
      const cells = row.split('|').filter((c, i, a) => i > 0 && i < a.length - 1);
      html += '<tr>\n';
      for (let ci = 0; ci < colCount; ci++) {
        const cell = ci < cells.length ? cells[ci].trim() : '';
        html += '<td>' + renderCellContent(cell) + '</td>\n';
      }
      html += '</tr>\n';
    }
    html += '</tbody>\n';
  }

  html += '</table>';
  return html;
}

function renderCellContent(text) {
  let result = escapeHTML(text);

  const codeSpans = [];
  result = result.replace(/`(.+?)`/g, (m, code) => {
    const idx = codeSpans.length;
    codeSpans.push(code);
    return '%%CODE' + idx + '%%';
  });

  result = result
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');

  result = result.replace(/%%CODE(\d+)%%/g, (m, idx) => {
    return '<code>' + codeSpans[parseInt(idx)] + '</code>';
  });

  return result;
}

// Extract abbreviations and hide from output
function extractAbbreviations(content) {
  const abbrs = [];
  const lines = content.split('\n');
  const result = [];
  for (const line of lines) {
    if (line.startsWith('*[')) {
      const bracketEnd = line.indexOf(']: ');
      if (bracketEnd !== -1) {
        const term = line.substring(2, bracketEnd);
        const def = line.substring(bracketEnd + 3);
        if (term.trim() !== '') {
          abbrs.push([term, def]);
        }
        result.push(''); // hide abbreviation definition
        continue;
      }
    }
    result.push(line);
  }
  return { content: result.join('\n'), abbreviations: abbrs };
}

// ---- post-processing ----

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function decodeHtmlEntities(s) {
  // 把数学块里用户写的 HTML 实体（&lt; &gt; &amp; 等）先还原成真实字符，
  // 再经 escapeHTML 重新编码为合法 HTML，避免 &lt; 被二次转义成 &amp;lt;。
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, '\u00A0');
}

function restoreMathBlocks(html, placeholders) {
  let result = html;
  for (let idx = 0; idx < placeholders.length; idx++) {
    const ph = placeholders[idx];
    const text = typeof ph === 'string' ? ph : ph.text;
    const escaped = escapeHTML(decodeHtmlEntities(text));
    if (ph.display) {
      // 显示数学：占位符是 <div class="math-placeholder" data-math-idx="N" ...>，替换为带 data-source-line 的 span
      const marker = '<div class="math-placeholder" data-math-idx="' + idx + '" data-source-line="' + ph.line + '"></div>';
      const wrapped = '<span class="math-display" data-source-line="' + ph.line + '">' + escaped + '</span>';
      result = result.split(marker).join(wrapped);
    } else {
      // 行内数学：占位符是 <!--MATHBLOCK_N-->，直接恢复
      const marker = '<!--MATHBLOCK_' + idx + '-->';
      result = result.split(marker).join(escaped);
    }
  }
  return result;
}

function sanitizeHTML(html) {
  const dangerousTags = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'select', 'button', 'link', 'meta', 'base'];
  let result = '';
  let i = 0;
  const len = html.length;

  while (i < len) {
    if (html[i] === '<' && i + 1 < len) {
      if (html[i + 1] === '/') {
        // Closing tag
        let end = html.indexOf('>', i);
        if (end === -1) { result += html[i]; i++; continue; }
        let inner = html.substring(i + 2, end);
        let tagName = inner.split(/\s/)[0].toLowerCase();
        if (dangerousTags.includes(tagName)) {
          i = end + 1;
          continue;
        }
        result += html.substring(i, end + 1);
        i = end + 1;
      } else if (html[i + 1] === '!') {
        // Comment or DOCTYPE
        if (html.substring(i, i + 4) === '<!--' && html.indexOf('-->', i) !== -1) {
          let end = html.indexOf('-->', i) + 3;
          result += html.substring(i, end);
          i = end;
        } else {
          let end = html.indexOf('>', i);
          if (end === -1) { result += html[i]; i++; continue; }
          result += html.substring(i, end + 1);
          i = end + 1;
        }
      } else {
        // Opening or self-closing tag
        let end = html.indexOf('>', i);
        if (end === -1) { result += html[i]; i++; continue; }
        let inner = html.substring(i + 1, end);
        let tagName = inner.split(/\s/)[0].toLowerCase();
        if (dangerousTags.includes(tagName)) {
          i = end + 1;
          continue;
        }
        // Sanitize attributes
        let sanitizedTag = sanitizeTagAttributes(tagName, inner);
        result += '<' + sanitizedTag + '>';
        i = end + 1;
      }
    } else {
      result += html[i];
      i++;
    }
  }
  return result;
}

// 安全过滤内联 style 值：保留合法声明，剥离可执行 / 可隐藏正文的危险 CSS。
// 目的：在放开内联样式（让 <div style="display:flex"> 这类卡片能正常渲染）的同时，
// 仍挡住 CSS 注入 —— expression()、url(javascript:)、@import、-moz-binding:、behavior:，
// 以及 display:none / visibility:hidden 把正文藏掉等。
function sanitizeStyleValue(css) {
  if (!css || typeof css !== 'string') return '';
  // 先去掉 /* ... */ 注释，避免借注释走私危险内容（如 ex/* */pression(...)）
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const decl of cleaned.split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue; // 不完整声明直接丢弃
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (!prop || !val) continue;
    const valLower = val.toLowerCase();
    // 脚本协议 / 表达式 / 导入
    if (/javascript:/i.test(valLower)) continue;
    if (/vbscript:/i.test(valLower)) continue;
    if (/expression\s*\(/i.test(valLower)) continue;
    if (/@import/i.test(valLower)) continue;
    // 绑定行为（仅老 IE / 火狐，但保留防御）
    if (/^(behavior|-moz-binding)$/.test(prop)) continue;
    // url() 内嵌危险协议
    if (/url\s*\(\s*['"]?\s*(javascript|vbscript|data:text\/html)/i.test(valLower)) continue;
    // 隐藏正文：display:none / visibility:hidden
    if (prop === 'display' && /^\s*none\s*$/i.test(val)) continue;
    if (prop === 'visibility' && /^\s*hidden\s*$/i.test(val)) continue;
    out.push(prop + ': ' + val);
  }
  return out.join('; ');
}

function sanitizeTagAttributes(tagName, inner) {
  // Remove dangerous event handlers and javascript: URLs
  let attrs = inner.substring(tagName.length);
  let cleaned = '';
  let j = 0;
  while (j < attrs.length) {
    // Skip whitespace
    while (j < attrs.length && /\s/.test(attrs[j])) { cleaned += attrs[j]; j++; }
    if (j >= attrs.length) break;

    // Read attribute name
    let nameStart = j;
    while (j < attrs.length && attrs[j] !== '=' && !/\s/.test(attrs[j])) j++;
    let attrName = attrs.substring(nameStart, j).toLowerCase();

    if (j < attrs.length && attrs[j] === '=') {
      j++; // skip =
      let quote = '';
      if (j < attrs.length && (attrs[j] === '"' || attrs[j] === "'")) {
        quote = attrs[j]; j++;
        while (j < attrs.length && attrs[j] !== quote) j++;
        j++; // skip closing quote
      } else {
        while (j < attrs.length && !/\s/.test(attrs[j])) j++;
      }
      let raw = attrs.substring(nameStart, j);
      // 危险事件处理器 / javascript: URL：直接丢弃
      if (attrName.startsWith('on') || /javascript:/i.test(raw)) {
        continue;
      }
      // 内联样式：保留但做安全过滤（剥离 expression()/url(javascript:)/display:none 等）
      if (attrName === 'style') {
        const val = quote
          ? raw.slice(attrName.length + 2, raw.length - 1)   // 含引号：style="..."
          : raw.slice(attrName.length + 1);                  // 不含引号：style=...
        const safe = sanitizeStyleValue(val);
        if (safe) cleaned += ' style="' + safe + '"';
        continue;
      }
      cleaned += raw;
    } else {
      let raw = attrs.substring(nameStart, j);
      if (attrName.startsWith('on') || /javascript:/i.test(raw) || attrName === 'style') {
        continue;
      }
      cleaned += raw;
    }
  }
  return tagName + cleaned;
}

function embedAbbrData(html, abbreviations) {
  if (abbreviations.length === 0) return html;
  const json = JSON.stringify(abbreviations).replace(/'/g, '&#x27;');
  return html + '<div id="abbr-data" style="display:none" data-abbrs=\'' + json + '\'></div>';
}

function convertHighlights(html) {
  let result = '';
  let i = 0;
  const len = html.length;
  const skipTags = ['code', 'pre', 'katex', 'mermaid', 'script', 'style', 'textarea'];
  const skipStack = [];

  while (i < len) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) { result += html[i]; i++; continue; }
      const inner = html.substring(i + 1, end);
      const tagName = inner.split(/\s/)[0].toLowerCase();

      if (tagName[0] === '/') {
        const closingTag = tagName.substring(1);
        if (skipStack[skipStack.length - 1] === closingTag) skipStack.pop();
      } else if (skipTags.includes(tagName)) {
        skipStack.push(tagName);
      }

      result += html.substring(i, end + 1);
      i = end + 1;
    } else if (skipStack.length === 0 && html[i] === '=' && html[i + 1] === '=' && (i === 0 || html[i - 1] !== '=')) {
      const end = html.indexOf('==', i + 2);
      if (end !== -1 && html[end + 2] !== '=') {
        const text = html.substring(i + 2, end);
        if (text.length > 0 && !/[\n\r]/.test(text)) {
          result += '<mark>' + text + '</mark>';
          i = end + 2;
          continue;
        }
      }
            result += '==';
            i += 2;
          } else {
            result += html[i];
            i++;
          }
        }
        return result;
      }

// ---- remark plugin: convert soft breaks & hard breaks to <br> ----
// When softBreaks is enabled, both single newlines (softbreak) and
// "two spaces + newline" (break) render as <br>, matching the user's
// writing habit (回车即换行).
// Note: remark keeps single newlines INSIDE text nodes rather than as
// separate softbreak nodes, so we split text nodes on "\n" and insert
// <br> between the fragments. Inline code / fenced code are untouched
// because their content lives in `.value`, not in `.children`.
// remarkBreaks: convert \n inside paragraphs/headings to <br>
// Always active — handles single-line breaks within block-level text.
function remarkBreaks() {
  return (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      if (parent && (parent.type === 'paragraph' || parent.type === 'heading')) {
        const parts = node.value.split('\n');
        if (parts.length > 1) {
          const children = [];
          for (let i = 0; i < parts.length; i++) {
            if (i > 0) children.push({ type: 'break' });
            if (parts[i] !== '') children.push({ type: 'text', value: parts[i] });
          }
          parent.children.splice(index, 1, ...children);
          return index + children.length;
        }
      }
    });
  };
}

function remarkSoftBreaks() {
  return (tree) => {
    const toBr = () => ({ type: 'html', value: '<br>' });

    const walk = (node) => {
      if (!node.children) return;
      const out = [];
      for (const child of node.children) {
        if (child.type === 'break' || child.type === 'softbreak') {
          out.push(toBr());
          continue;
        }
        if (child.type === 'text' && child.value.indexOf('\n') !== -1) {
          const parts = child.value.split('\n');
          for (let i = 0; i < parts.length; i++) {
            if (parts[i] !== '') out.push({ type: 'text', value: parts[i] });
            if (i < parts.length - 1) out.push(toBr());
          }
          continue;
        }
        walk(child);
        out.push(child);
      }
      node.children = out;
    };

    walk(tree);
  };
}

// 软换行关闭时：仅硬换行（两空格 / 反斜杠）转为 <br>，
// 单换行（softbreak）保持默认（标准 markdown 行为：不生成 <br>）。
function remarkHardBreaksOnly() {
  return (tree) => {
    const toBr = () => ({ type: 'html', value: '<br>' });
    const walk = (node) => {
      if (!node.children) return;
      const out = [];
      for (const child of node.children) {
        if (child.type === 'break') {
          out.push(toBr());
          continue;
        }
        // softbreak（单换行）原样保留，由默认处理器渲染（非 <br>）
        walk(child);
        out.push(child);
      }
      node.children = out;
    };
    walk(tree);
  };
}

// ---- main pipeline ----

// --- Footnote extraction (pre-processing) ---
// Extracts [^id]: definition lines, supports multi-paragraph definitions
// (continuation lines indented by at least 2 spaces or a tab).
function extractFootnotes(content) {
  const lines = content.split('\n');
  const cleaned = [];
  const definitions = [];
  let inCodeBlock = false;
  let codeFence = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track fenced code blocks
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = trimmed.substring(0, 3);
      } else if (trimmed.startsWith(codeFence)) {
        inCodeBlock = false;
      }
      cleaned.push(line);
      continue;
    }

    if (inCodeBlock) {
      cleaned.push(line);
      continue;
    }

    // Check for footnote definition: [^id]: text
    const defMatch = line.match(/^\[\^([^\]]+)\]\s*:\s*(.*)/);
    if (defMatch) {
      const id = defMatch[1];
      let defBody = defMatch[2];

      // Collect continuation lines (indented by 2+ spaces or tab)
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next === '' || next.startsWith('  ') || next.startsWith('\t')) {
          if (next === '') {
            defBody += '\n';
          } else {
            defBody += '\n' + next.replace(/^\s{2}|\t/, '');
          }
          j++;
        } else {
          break;
        }
      }

      definitions.push({ id, definition: defBody.trim(), line: i + 1 });
      // Replace definition lines with empty lines to preserve line numbering
      for (let k = i; k < j; k++) cleaned.push('');
      i = j - 1;
      continue;
    }

    cleaned.push(line);
  }

  return { content: cleaned.join('\n'), definitions };
}

// --- Footnote rendering (post-processing) ---
// Replaces [^id] references with superscript links and appends footnote section.
function renderFootnotes(html, definitions) {
  if (definitions.length === 0) return html;

  // Build ID map with collision avoidance
  const usedIds = new Map(); // id → count
  const fnIds = []; // [{ id, elementId }]

  for (const def of definitions) {
    let baseId = def.id.toLowerCase().replace(/[\s"'<>&#]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
    if (!baseId) baseId = 'fn';
    const count = usedIds.get(baseId) || 0;
    const elementId = count === 0 ? baseId : baseId + '-' + count;
    usedIds.set(baseId, count + 1);
    fnIds.push({ id: def.id, displayId: def.id, elementId, definition: def.definition });
  }

  // Replace [^id] references with linked superscripts
  // Guard: skip inside <code>, <pre>, <a>, <katex> tags
  let result = '';
  let i = 0;
  const skipTags = ['code', 'pre', 'a', 'katex'];
  const skipStack = [];

  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) { result += html[i]; i++; continue; }
      const inner = html.substring(i + 1, end);
      const tagName = inner.split(/\s/)[0].toLowerCase();

      if (tagName.startsWith('/')) {
        const closing = tagName.substring(1);
        const idx = skipStack.lastIndexOf(closing);
        if (idx !== -1) skipStack.splice(idx, 1);
      } else if (skipTags.includes(tagName)) {
        skipStack.push(tagName);
      }

      result += html.substring(i, end + 1);
      i = end + 1;
    } else if (skipStack.length === 0) {
      // Look for [^id]
      const refMatch = html.substring(i).match(/\[\^([^\]]+)\]/);
      if (refMatch && refMatch.index === 0) {
        const refId = refMatch[1];
        const fn = fnIds.find(f => f.id === refId);
        if (fn) {
          result += '<sup class="footnote-ref" id="fnref-' + fn.elementId + '">';
          result += '<a href="#fn-' + fn.elementId + '">[' + fn.displayId + ']</a>';
          result += '</sup>';
        } else {
          // Undefined reference: keep as plain text
          result += '[^' + refId + ']';
        }
        i += refMatch[0].length;
      } else {
        result += html[i];
        i++;
      }
    } else {
      result += html[i];
      i++;
    }
  }

  // Build footnote section
  let section = '\n<hr class="footnotes-sep">\n<section class="footnotes">\n<ol>\n';
  for (const fn of fnIds) {
    // 定义走最小管线渲染 + sanitize（修复：原实现把 raw 源文本直接拼入 <p>，
    // `[^1]: <img onerror=...>` 可注入未净化 HTML 造成 XSS；顺带让定义内的
    // **bold** / [链接](url) 等 markdown 语法正常渲染而非显示为字面量）。
    let defHtml = unifiedToHtml(fn.definition);
    const backref = ' <a href="#fnref-' + fn.elementId + '" class="footnote-backref" title="返回文中">↩</a>';
    if (defHtml.startsWith('<p') && defHtml.endsWith('</p>')) {
      // 段落级输出：backref 挂在段落末尾内，保持与旧结构一致
      defHtml = defHtml.slice(0, -4) + backref + '</p>';
    } else {
      defHtml += backref;
    }
    section += '<li id="fn-' + fn.elementId + '" class="footnote-definition">\n' + defHtml + '\n</li>\n';
  }
  section += '</ol>\n</section>';

  return result + section;
}

// 统一的 rehype-sanitize 扩展 schema：放开常用原生 HTML 标签与内联 style
//（危险 CSS 由下游 sanitizeHTML -> sanitizeStyleValue 兜底过滤）、img 尺寸、
// file: scheme（demo.md 声明支持 file:// 写法）。主管线片段渲染共用。
function buildSanitizeSchema() {
  const base = rehypeSanitize.defaultSchema;
  return {
    ...base,
    // 放开常用原生 HTML 标签：demo.md 与用户文档里会用到的 <u>/<center>/<progress>/
    // <mark>/<figure>/<figcaption> 等。注意 <mark> 也由 convertHighlights（==高亮==）
    // 在净化之后生成，这里放开原始 <mark> 不影响那条路径。
    tagNames: [...(base.tagNames || []), 'u', 'center', 'progress', 'mark', 'figure', 'figcaption'],
    attributes: {
      ...base.attributes,
      // 放开内联 style：具体危险 CSS 由下游 sanitizeHTML -> sanitizeStyleValue 兜底过滤
      '*': [...(base.attributes['*'] || []), 'style', 'class'],
      img: [...(base.attributes.img || ['src', 'alt', 'title']), 'width', 'height', 'srcset', 'loading'],
      progress: ['value', 'max'],
    },
    allowedSchemes: [...(base.allowedSchemes || ['http', 'https', 'mailto', 'tel']), 'file'],
  };
}

// ============================================================
// 清洗 Word / Excel 导出的 HTML 命名空间标签与 mso-* 内联样式
// ------------------------------------------------------------
// 用户常把 Word / Excel 导出的表格直接粘进编辑器，这类 HTML 带有大量
// Office 专属标签（<o:p>、<w:tbl>、<v:rect> 等，标签名含冒号）与 mso-* 样式
// （mso-padding / mso-element / mso-spacerun …）。它们既不是标准 HTML，也
// 不被预览 CSS 识别，只会残留成「垃圾标签」。
// 此 rehype 插件在 rehypeRaw 解析出真实 HTML 树之后运行：
//   - 含冒号的命名空间元素（<o:p> <w:*> <v:*> …）直接展开为子节点（保留内部文本/结构）；
//   - 其余元素 style 里的 mso-* / epub-* 等 Office 声明被剥离，合法声明（text-align
//     等）交给下游 sanitizeStyleValue 兜底过滤。
// math 占位符是注释节点，不会被触碰；实体解码在 restoreMathBlocks 阶段完成。
// ============================================================
function stripOfficeStyle(css) {
  if (!css || typeof css !== 'string') return '';
  const out = [];
  for (const decl of css.split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    if (!prop) continue;
    // 剥离 Office 专属声明（mso-* / epub-*），其余保留由下游 sanitizeStyleValue 处理
    if (/^(mso-|epub-)/.test(prop)) continue;
    out.push(decl.trim());
  }
  return out.join('; ');
}

function rehypeCleanOfficeNamespaces() {
  return (tree) => {
    visit(tree, 'element', (node, index, parent) => {
      const tag = node.tagName || '';
      // 命名空间标签（标签名含冒号）：<o:p> / <w:tbl> / <v:rect> / <wx:*> 等
      if (tag.includes(':')) {
        if (parent && typeof index === 'number') {
          parent.children.splice(index, 1, ...(node.children || []));
          return index; // 重新访问被提升的子节点
        }
        return;
      }
      if (node.properties && node.properties.style) {
        const raw = Array.isArray(node.properties.style)
          ? node.properties.style.join(' ')
          : node.properties.style;
        const cleaned = stripOfficeStyle(raw);
        if (cleaned) node.properties.style = cleaned;
        else delete node.properties.style;
      }
    });
  };
}

// 最小安全渲染管线：把脚注定义等片段渲染为 HTML 并完成 sanitize。
// 与 renderMarkdown 主管线区分：不做 extractFootnotes/convertAlerts 等预处理
// （防嵌套递归），不注入 data-source-line，按默认软换行规则渲染。
function unifiedToHtml(md) {
  let html;
  try {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm, { singleTilde: false })
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw);
    if (rehypeSanitize && rehypeSanitize.defaultSchema) {
      processor.use(rehypeSanitize, buildSanitizeSchema());
    }
    processor.use(rehypeStringify, { allowDangerousHtml: true });
    html = processor.processSync(md).toString();
  } catch (e) {
    console.error('Unified fragment rendering error:', e);
    return '<pre>' + escapeHTML(md) + '</pre>';
  }
  return sanitizeHTML(html);
}

// ============================================================
// 列表缩进归一化（让「每 tabSize 空格 / 1 个 Tab = 缩进一级」的直观模型成立）
// ------------------------------------------------------------
// CommonMark 的有序列表缩进是「按 marker 宽度对齐的列」模型，而不是「固定步长」模型：
//   - 无序列表 marker 占 2 列（- / * / + 后跟空格），子列表 marker 落在第 2 列即可，
//     所以「每 4 空格升一级」天然成立；
//   - 有序列表 marker 占 3 列（如 "1. "），子列表 marker 需落在父项文本起始列（第 3 列），
//     因此第二级是 3 空格、第三级是 6 空格……与「4 空格升一级」错位，
//     且缩进过头（≥ 父项文本列 + 4）会被 CommonMark 当成代码块。
// 本项目 Tab 默认 4 空格，用户一直按「4 空格升一级」书写，于是有序列表深层嵌套会乱套、
// 并无故变成代码块。
//
// 此函数把源码的视觉缩进（按 tabSize 折算成「层级」）rewrite 成 CommonMark 要求的精确列，
// 使有序列表也能像无序列表一样按固定步长缩进，并消除过缩进导致的代码块。
// 处理时跳过围栏代码块（``` / ~~~）内部，避免改动其中内容。
// 对已是 CommonMark 合规缩进的文档结果幂等。
// ============================================================
function normalizeListIndentation(content, tabSize) {
  const ts = tabSize && tabSize > 0 ? tabSize : 4;
  const lines = content.split('\n');
  const out = [];
  // lineMap[i] = 规范后第 i+1 行对应的「原始源码行号（1-based）」。
  // 渲染后所有 data-source-line 都基于此映射还原，使点击勾选框能正确回写源码——
  // 即便嵌套有序非 1 项前插入了空行使行数变化，行号也不会整体偏移。
  const lineMap = [];
  const emit = (text, origLine) => { out.push(text); lineMap.push(origLine); };
  // 栈：每个打开的列表项 { indent: 视觉缩进（空格数）, contentColumn: 文本起始列, delta }
  const stack = [];
  // 匹配列表项起始：前导空白 + 无序(-*+/+) 或 有序(\d+[.)]) + 分隔空白
  const itemRe = /^(\s*)(?:([-*+])|(\d+[.)]))(\s+)/;
  let inFence = false;
  let fenceMarker = '';
  let prevEmittedDepth = 0; // 上一个已输出列表项的嵌套深度（0 = 无）

  const expand = (s) => s.replace(/\t/g, ' '.repeat(ts));

  let origLine = 1; // 当前输入行对应的原始行号（1-based）
  for (const line of lines) {
    // —— 围栏代码块：进入/离开均跳过归一化 ——
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      const len = fenceMatch[2].length;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker + len;
      } else if (marker === fenceMarker[0] && len >= fenceMarker[1]) {
        inFence = false;
        fenceMarker = '';
      }
      emit(line, origLine++);
      continue;
    }
    if (inFence) {
      emit(line, origLine++);
      continue;
    }

    const m = line.match(itemRe);
    if (!m) {
      // 非列表行：按当前最深层列表项的 delta 平移前导空白（保持与 marker 的相对位置），
      // 以兼容多行列表项 / 代码块等延续行；无列表上下文则原样保留。
      if (stack.length) {
        const delta = stack[stack.length - 1].delta;
        if (delta !== 0) {
          const lead = line.match(/^ */)[0];
          const rest = line.slice(lead.length);
          if (lead === expand(lead)) {
            emit(' '.repeat(Math.max(0, lead.length + delta)) + rest, origLine++);
            continue;
          }
        }
      }
      emit(line, origLine++);
      continue;
    }

    // —— 列表项行 ——
    const leading = m[1];
    const indent = expand(leading).length;
    const isOrdered = m[3] !== undefined;
    const markerText = isOrdered ? m[3] : m[2];
    const startNum = isOrdered ? parseInt(markerText, 10) : 1;
    const markerWidth = markerText.length + 1; // +1 = 分隔空格
    // 弹出同级或更浅的项
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const contentColumn = stack.length ? stack[stack.length - 1].contentColumn : 0;
    const myDepth = stack.length + 1;
    // CommonMark：有序列表项若起始数字 ≠ 1，且紧跟在父项内容之后（无空行），
    // 会被当成父项段落的“惰性延续”而非嵌套列表。此处对其前插空行，使其被正确识别为
    // 嵌套列表（保留原起始数字，如 4/5/6 不会被重排成 1）。仅在「刚进入更深一层」时插入，
    // 避免兄弟项之间重复空行。插入的空行不改变 lineMap 的正确性（映射到当前项原行）。
    if (isOrdered && startNum !== 1 && myDepth > prevEmittedDepth && out.length && out[out.length - 1].trim() !== '') {
      emit('', origLine); // 空行映射到当前项原行（空行本身不产生带位置的节点）
    }
    const delta = contentColumn - indent;
    emit(' '.repeat(contentColumn) + line.slice(leading.length), origLine++);
    stack.push({ indent, contentColumn: contentColumn + markerWidth, delta });
    prevEmittedDepth = myDepth;
  }
  return { text: out.join('\n'), lineMap };
}

function renderMarkdown(content, options) {
  const opts = options || {};
  const softBreaks = opts.softBreaks === true;
  const extendedSyntax = opts.extendedSyntax !== false;
  // 0. 统一换行符为 LF，避免 CRLF 的 \r 污染后续行数统计
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 0. Convert GitHub-style math fences (```math/```latex/```tex) → $$...$$ blocks
  content = convertMathFences(content);

  // 0.5 列表缩进归一化：把「每 tabSize 空格升一级」模型转换为 CommonMark 列对齐模型，
  // 让有序列表深层嵌套按用户预期工作，并消除过缩进产生的代码块。
  // 同时返回 lineMap（规范后行 → 原始源码行），用于下方还原 data-source-line。
  const norm = normalizeListIndentation(content, opts.tabSize);
  content = norm.text;
  const listLineMap = norm.lineMap;

  // 1. Extract abbreviations
  const abbrResult = extractAbbreviations(content);
  const abbreviations = abbrResult.abbreviations;

  // 2. Guard math blocks
  const mathResult = guardMathBlocks(abbrResult.content);
  const placeholders = mathResult.placeholders;

  // 3. Convert alerts to placeholders
  const alertResult = convertAlerts(mathResult.content);
  const alertBlocks = alertResult.alertBlocks;

  // 4. Convert definition lists
  let processed = convertDefLists(alertResult.content);

  // md2 表格（网格语法 + 带 >> / ^^ 标记的管道表）：仅顶层、且不在单元格重入时执行。
  // 必须在 convertContainerTables 之前——两者职责分离：本步只认领 md2 语法，
  // 容器内的普通 GFM 表格仍由下一步处理。
  if (!_renderingMd2Cell) {
    processed = convertMd2Tables(processed, {
      renderTable: renderMd2Table,
      renderCellContent: renderMd2CellContent,
    });
  }

  // 4.5. Convert container-embedded tables (lazy continuation)
  processed = convertContainerTables(processed);

  // 4.6. Extract footnotes (before unified pipeline to avoid parsing issues)
  const footnoteResult = extractFootnotes(processed);
  processed = footnoteResult.content;
  const footnoteDefs = footnoteResult.definitions;

  // 5. Unified pipeline
  let html;
  try {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm, { singleTilde: false })
      .use(remarkSourceLine);
    if (softBreaks) {
      // 软换行开启：所有换行（单 \n 与硬换行）统一渲染为 <br>
      processor.use(remarkBreaks);
      processor.use(remarkSoftBreaks);
    } else {
      // 软换行关闭：仅硬换行（两空格 / 反斜杠）渲染为 <br>，单 \n 保持默认软换行（不生成 br）
      processor.use(remarkHardBreaksOnly);
    }
    processor
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeCleanOfficeNamespaces);
    // 若 rehype-sanitize 可用，用扩展 schema：保留 img 的 width/height/srcset（让「指定显示尺寸」生效），
    // 并允许 file: scheme（demo.md 声明支持 file:// 写法）。缺失时跳过，由下方 sanitizeHTML 兜底净化。
    if (rehypeSanitize && rehypeSanitize.defaultSchema) {
      processor.use(rehypeSanitize, buildSanitizeSchema());
    }
    processor.use(rehypeHeadingIds);
    processor.use(rehypeInlineBacktickMath);
    processor.use(rehypeInlineDollarBacktickMath);
    processor.use(rehypeStringify, { allowDangerousHtml: true });
    html = processor.processSync(processed).toString();
  } catch (e) {
    // Fallback: return raw content wrapped in <pre>
    console.error('Unified rendering error:', e);
    return '<pre>' + escapeHTML(content) + '</pre>';
  }

  // 7. Restore math blocks
  html = restoreMathBlocks(html, placeholders);

  // 8. Restore alert blocks
  html = restoreAlerts(html, alertBlocks);

  // 9. Sanitize
  html = sanitizeHTML(html);

  // 9b. 预览图片以 no-referrer 加载：webview 加载 <img> 会携带应用自身源
  //（localhost / asset.localhost）作为 Referer，微信等按 Referer 放/拦的 CDN 会据此
  // 返回占位图/403（Obsidian/Typora 不发 Referer 故正常显示）。注入 referrerpolicy
  // 使图片请求不带 Referer，微信即返回真图。在 sanitizeHTML 之后注入，字符串级净化
  // 保留未知属性，故不会被剥除；rehype-sanitize 已在管线内早于此处执行，不再二次净化。
  html = html.replace(/<img([^>]*)>/g, '<img$1 referrerpolicy="no-referrer">');

  // 10. Convert ==highlight== to <mark>（可由 extendedSyntax 关闭）
  if (extendedSyntax) {
    html = convertHighlights(html);
  }

  // 11. Render footnotes (references + definition section)
  html = renderFootnotes(html, footnoteDefs);

  // 12. Embed abbreviation data
  html = embedAbbrData(html, abbreviations);

  // 12.5 还原 data-source-line：把「规范后行号」映射回原始源码行号（1-based），
  // 确保点击预览中任务列表勾选框时，回写的是正确源码行。否则嵌套有序非 1 项前插入的
  // 空行会让行号整体偏移，导致勾选框修改了错误的 `- [ ]` 行（任务列表勾选不同步的根因）。
  if (listLineMap && listLineMap.length) {
    html = html.replace(/data-source-line="(\d+)"/g, (m, n) => {
      const orig = listLineMap[parseInt(n, 10) - 1];
      return orig ? `data-source-line="${orig}"` : m;
    });
  }

  return html;
}

// Export for Node.js bundling; also expose as global for browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderMarkdown };
}
return { renderMarkdown };
