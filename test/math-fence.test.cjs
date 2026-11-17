// Tests for GitHub-style math fences (```math / ```latex / ```tex) support.
// TizuMark normalizes these fences into $$...$$ blocks in the renderer, so they
// render through the existing KaTeX (processMath) pipeline — matching GitHub/Gitee
// block-math behavior (fence body needs no $$ wrapping, just like GitHub).
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../src/unified-renderer.js');

function render(md, opts = { softBreaks: false }) {
  return renderMarkdown(md, opts);
}

test('```math fence renders as math-display block', async () => {
  const html = render('```math\nE = m c^2\n```');
  assert.ok(/<span class="math-display"[^>]*>/i.test(html), 'should be math-display span');
  assert.ok(/\$\$/.test(html), 'should carry $$ delimiters for processMath');
  assert.ok(/E = m c\^2/.test(html), 'LaTeX body preserved');
});

test('```latex fence is treated as math', async () => {
  const html = render('```latex\n\\frac{a}{b}\n```');
  assert.ok(/<span class="math-display"/i.test(html), 'latex fence → math-display');
  assert.ok(/\\frac\{a\}\{b\}/.test(html), 'frac preserved');
});

test('```tex fence is treated as math', async () => {
  const html = render('```tex\n\\sum_{i=1}^n i\n```');
  assert.ok(/<span class="math-display"/i.test(html), 'tex fence → math-display');
  assert.ok(/\\sum_\{i=1\}\^n i/.test(html), 'sum preserved');
});

test('complex LaTeX (matrix) inside ```math normalizes', async () => {
  const html = render('```math\n\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}\n```');
  assert.ok(/<span class="math-display"/i.test(html));
  assert.ok(/\\begin\{bmatrix\}/.test(html), 'matrix env preserved');
  assert.ok(/\\end\{bmatrix\}/.test(html), 'matrix close preserved');
});

test('non-math code fence is unaffected', async () => {
  const html = render('```python\nx = 1\n```');
  assert.ok(/<pre><code class="language-python"/.test(html), 'remains a normal code block');
  assert.ok(!/math-display/.test(html), 'no math-display injected');
});

test('```math is visually equivalent to $$...$$ block', async () => {
  const fence = render('```math\nE = m c^2\n```');
  const dollar = render('$$E = m c^2$$');
  // Both become a math-display span carrying the same LaTeX under $$ delimiters
  const fenceM = fence.match(/<span class="math-display"[^>]*>([\s\S]*?)<\/span>/);
  const dollarM = dollar.match(/<span class="math-display"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(fenceM && dollarM, 'both produce a math-display span');
  assert.ok(fenceM[1].includes('E = m c^2') && dollarM[1].includes('E = m c^2'));
});

test('```math after a paragraph (no blank line) still renders', async () => {
  const html = render('下面是方程：\n\n```math\nE = mc^2\n```');
  assert.ok(/<p[^>]*>下面是方程：<\/p>/.test(html), 'paragraph kept');
  assert.ok(/<span class="math-display"/i.test(html), 'math fence after paragraph renders');
});

test('unterminated ```math fence still renders as math (not raw code)', async () => {
  const html = render('```math\nE = mc^2');
  assert.ok(/<span class="math-display"/i.test(html), 'unterminated fence → math-display');
  assert.ok(!/language-math/.test(html), 'not left as a code block');
});

test('math fence works under both soft-break modes', async () => {
  const off = render('```math\nE = mc^2\n```', { softBreaks: false });
  const on = render('```math\nE = mc^2\n```', { softBreaks: true });
  assert.ok(/<span class="math-display"/i.test(off));
  assert.ok(/<span class="math-display"/i.test(on));
});

// ---- GitHub 兼容：行内反引号数学 `` `$...$` `` ----

test('inline backtick `$E=mc^2$` is unwrapped to math text (not code)', async () => {
  const html = render('能量公式 `$E=mc^2$` 来自爱因斯坦');
  assert.ok(!/<code[^>]*>\$E=mc\^2\$<\/code>/.test(html), 'should NOT stay in <code>');
  assert.ok(/能量公式 \$E=mc\^2\$ 来自爱因斯坦/.test(html), 'unwrapped to plain $...$ text for KaTeX');
});

test('inline backtick `$$E=mc^2$$` is normalized to inline $...$', async () => {
  // 反引号包裹的数学语义上是行内；保留 $$ 会被 KaTeX 渲染成 display math（导致换行），
  // 因此统一归一化为 $...$。
  const html = render('块级反引号 `$$E=mc^2$$` 写法');
  assert.ok(!/<code/.test(html), 'no <code> remaining');
  assert.ok(/\$E=mc\^2\$/.test(html), 'normalized to inline $...$ text');
  assert.ok(!/\$\$E=mc\^2\$\$/.test(html), 'no $$...$$ display delimiter remains');
});

test('inline backtick protects Markdown-conflicting chars (e.g. underscore)', async () => {
  // GitHub uses backticks precisely so `_`/`*` inside math are not parsed as emphasis.
  const html = render('求和 `$\\sum_i a_i$` 示例');
  assert.ok(!/<code/.test(html), 'not in <code>');
  assert.ok(/\$\\sum_i a_i\$/.test(html), 'underscore preserved literally for KaTeX');
});

test('block code fence containing $x^2$ stays as code (not math)', async () => {
  const html = render('```\n$x^2$\n```');
  assert.ok(/<pre><code[^>]*>\$x\^2\$/.test(html), 'block code preserved');
  assert.ok(!/\$x\^2\$/.test(html.replace(/<pre><code[^>]*>\$x\^2\$\n<\/code><\/pre>/, '')), 'formula not leaked outside code');
});

test('normal inline code stays as code', async () => {
  const html = render('运行 `npm install` 安装');
  assert.ok(/<code[^>]*>npm install<\/code>/.test(html), 'plain inline code untouched');
});

test('backtick math inside table cell is unwrapped', async () => {
  const html = render('| 公式 | 说明 |\n|------|------|\n| `$a^2$` | 平方 |');
  assert.ok(/<td[^>]*>\$a\^2\$<\/td>/.test(html), 'cell content unwrapped to $a^2$ text');
  assert.ok(!/<td[^>]*><code/.test(html), 'no <code> in cell');
});

test('mixed inline backtick math on one line stays inline (no display delimiter)', async () => {
  // 用户场景：`$E=mc^2$` / `$$E=mc^2$$` / `$\sum_i a_i$`
  const md = '`$E=mc^2$` / `$$E=mc^2$$` / `$\\sum_i a_i$`';
  const html = render(md);
  assert.ok(!/<code/.test(html), 'all backtick math unwrapped');
  assert.ok(!/\$\$/.test(html), 'no $$ display delimiter remains, so KaTeX renders inline');
  assert.ok(/\$E=mc\^2\$/.test(html), 'first inline math preserved');
  assert.ok(/\$\\sum_i a_i\$/.test(html), 'third inline math preserved');
});

test('standard non-backtick `$E=mc^2$` still renders as math text', async () => {
  const html = render('标准写法 $E=mc^2$ 兼容');
  // 行内公式占位符现包 <span>（防行首 HTML 块陷阱，见 unified-renderer.js inlineMathPlaceholder），
  // 故公式文本外会有中性 span 包裹，不再与前后文字紧邻
  assert.ok(/标准写法 (<span>)?\$E=mc\^2\$(<\/span>)? 兼容/.test(html), 'unchanged behavior for plain $...$');
  assert.ok(!/<code/.test(html), 'not wrapped in code');
});

// ---- GitHub 官方反引号数学：$`...`$ （美元在外、反引号在内）----

test('GitHub official $`\\sqrt{x}`$ is merged into inline $...$', async () => {
  const html = render('This sentence uses $`\\sqrt{3x-1}+(1+x)^2`$ to show math inline.');
  assert.ok(!/<code/.test(html), 'code span consumed, no literal backticks');
  assert.ok(/\$\\sqrt\{3x-1\}\+\(1\+x\)\^2\$/.test(html), 'merged into single $...$ math text');
});

test('$`...`$ with escaped $ (GitHub doc example) keeps literal $ in code', async () => {
  const html = render('This expression uses `$` to display a dollar sign: $`\\sqrt{\\$4}`$');
  assert.ok(/<code[^>]*>\$<\/code>/.test(html), 'leading `$` stays as literal code');
  assert.ok(/\$\\sqrt\{\\\$4\}\$/.test(html), 'trailing math merged');
});

test('$`...`$ mixed with our `$...$` backtick form on one line', async () => {
  const md = '一个 `$x^2$` 另一个 $`y^2`$ 混合';
  const html = render(md);
  assert.ok(!/<code/.test(html), 'both forms unwrapped, no <code>');
  assert.ok(/\$x\^2\$/.test(html), 'our form `$x^2$` → $x^2$');
  assert.ok(/\$y\^2\$/.test(html), 'GitHub form $`y^2`$ → $y^2$');
});

test('$`...`$ regression: guardMathBlocks must NOT swallow it as inline math', async () => {
  // 历史 bug：guardMathBlocks 会把 $`...`$ 误判为行内数学占位符，导致代码跨度丢失
  const html = render('前缀 $`\\frac{a}{b}`$ 后缀');
  assert.ok(!/MATHBLOCK/.test(html), 'no placeholder injected (would mean swallowed)');
  assert.ok(/\$\\frac\{a\}\{b\}\$/.test(html), 'correctly merged into $...$');
});
