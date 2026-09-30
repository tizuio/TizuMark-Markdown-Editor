// 反斜杠转义与数学定界符测试。
// 关键语义（v1.2.2 起保守恢复 \(...\) 与 \[...\] 数学支持）：
//   - inner 具备 LaTeX 数学特征（反斜杠命令 \frac/\alpha/... 或上标 ^）→ 当公式渲染。
//   - inner 无数学特征（如文献引用 \[J/OL\]、\[1\]）→ 保持 CommonMark 转义，输出字面 [J/OL]、[1]。
//   - 数学也可直接用 $ ... $（行内）与 $$ ... $$（块级），或 ```math 围栏。
//   - 不成对 / 跨行（行内） / 围栏与行内代码内 → 一律字面量。
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../src/unified-renderer.js');

function render(md) {
  return renderMarkdown(md, { softBreaks: false });
}

// ---- LaTeX 特征 → 当公式 ----

test('行内 \\(...\\) 含 LaTeX 命令 → 渲染为数学公式', () => {
  const html = render('这是公式 \\(S=\\pi r^2\\)');
  assert.ok(html.includes('$S=\\pi r^2$'), '应归一化为 $...$ 占位: ' + html);
  assert.ok(!html.includes('\\('), '不应残留 \\(: ' + html);
  assert.ok(!html.includes('(S='), '不应渲染为字面 (S=...): ' + html);
});

test('行内 \\(...\\) 含上标 → 渲染为数学公式', () => {
  const html = render('勾股 \\(a^2+b^2=c^2\\) 定理');
  assert.ok(html.includes('$a^2+b^2=c^2$'), '应归一化为 $...$ 占位: ' + html);
  assert.ok(!html.includes('\\('), '不应残留 \\(: ' + html);
});

test('块级 \\[...\\] 含 LaTeX 命令 → 渲染为 display 公式', () => {
  const html = render('\\[\nS=\\pi r^2\n\\]');
  assert.ok(html.includes('math-display'), '应渲染为 math-display: ' + html);
  assert.ok(html.includes('$$S=\\pi r^2$$') || html.includes('$$S=\\pi r^2\n$$') || !html.includes('\\['), '不应残留 \\[: ' + html);
});

test('行内 \\(...\\) 单行配对，跨行不配对 → 字面量', () => {
  const md = '开始 \\(a\n\\alpha\\) 跨行';
  const html = render(md);
  assert.ok(!/katex|math/i.test(html.replace(/ mathematical /g, '')), '跨行不应生成数学: ' + html);
});

// ---- 无 LaTeX 特征 → 字面量（文献引用回归场景）----

test('块级 \\[...\\] 无 LaTeX 特征（文献引用）→ 字面方括号', () => {
  const html = render('\\[J/OL\\]');
  assert.ok(html.includes('[J/OL]'), '应渲染为字面 [J/OL]: ' + html);
  assert.ok(!html.includes('\\['), '不应残留 \\[: ' + html);
  assert.ok(!/katex|math-display|math-inline/.test(html), '不应生成数学块: ' + html);
});

test('下划线文件名 \\[my_paper_v2\\] → 字面（下划线不作数学特征）', () => {
  const html = render('\\[my_paper_v2\\]');
  assert.ok(html.includes('[my_paper_v2]'), '应渲染为字面 [my_paper_v2]: ' + html);
  assert.ok(!/math-display|math-placeholder/.test(html), '不应生成数学块: ' + html);
});

test('上标 ^ 仍触发数学：\\(x^2\\) → 公式', () => {
  const html = render('\\(x^2\\)');
  assert.ok(html.includes('$x^2$'), '应归一化为 $...$ 占位: ' + html);
});

test('完整文献引用行：\\[J/OL\\] 与 \\[1\\] 均作字面量', () => {
  const md = '王良, 管玉, 张晓东, 等. 数据集\\[J/OL\\]. 中国科学数据, 2026. 引用序号\\[1\\]. DOI: 10.x/abc';
  const html = render(md);
  assert.ok(html.includes('[J/OL]'), '应出现字面 [J/OL]: ' + html);
  assert.ok(html.includes('[1]'), '应出现字面 [1]: ' + html);
  assert.ok(!/math/.test(html), '不应生成数学: ' + html);
});

test('行内 \\(...\\) 无 LaTeX 特征 → 字面圆括号', () => {
  const html = render('普通文本 \\(hello world\\) 不变');
  assert.ok(html.includes('(hello world)'), '应渲染为字面 (...): ' + html);
  assert.ok(!html.includes('\\('), '不应残留 \\(: ' + html);
  assert.ok(!/katex|math-display|math-inline/.test(html), '不应生成数学: ' + html);
});

test('无特征与有特征混排：\\(x\\) 字面 与 \\(\\alpha\\) 数学共存', () => {
  const md = '字面 \\(x\\) 与公式 \\(\\alpha\\) 共存';
  const html = render(md);
  assert.ok(html.includes('(x)'), '\\(x\\) 应还原为字面 (x): ' + html);
  assert.ok(html.includes('$\\alpha$'), '\\(\\alpha\\) 应归一化为 $...$: ' + html);
});

// ---- 代码上下文 / 不成对 → 字面量 ----

test('围栏代码块内的 \\(...\\) 保持字面量', () => {
  const md = '```\n\\(x\\)\n```';
  const html = render(md);
  assert.ok(html.includes('\\(x\\)'), '代码块内应保持 \\(x\\): ' + html);
});

test('行内代码（`...`）内的 \\(...\\) 保持字面量', () => {
  const html = render('`\\(x^2\\)`');
  assert.ok(html.includes('\\(x^2\\)'), '行内代码内应保持 \\(x^2\\): ' + html);
  assert.ok(!/katex/i.test(html), '行内代码内不应渲染数学: ' + html);
});

test('不成对的 \\( 还原为字面 (', () => {
  const html = render('文字 \\( 没有闭合');
  assert.ok(!html.includes('\\('), '不成对 \\( 应被转义: ' + html);
  assert.ok(html.includes('('), '应渲染为字面 (: ' + html);
});

test('不成对的 \\[ 还原为字面 [', () => {
  const html = render('\\[ 没有闭合');
  assert.ok(!html.includes('\\['), '不成对 \\[ 应被转义: ' + html);
  assert.ok(html.includes('['), '应渲染为字面 [: ' + html);
});

// ---- 原有 $ 语义不受影响 ----

test('回归：行内 $...$ 仍正常渲染', () => {
  const html = render('行内 $E=mc^2$ 公式');
  assert.ok(html.includes('$E=mc^2$'), '原有 $ 行内数学应保留: ' + html);
});

test('回归：块级 $$...$$ 仍正常渲染', () => {
  const html = render('$$\nS=\\pi r^2\n$$');
  assert.ok(html.includes('math-display'), '块级 $$ 应渲染为 math-display: ' + html);
});

test('回归：货币文本 $ 100 $ 仍保守拒绝', () => {
  const html = render('价格 $ 100 $ 美元');
  assert.ok(!/katex/i.test(html), '货币文本不应渲染为数学: ' + html);
});

test('混合：LaTeX 定界符数学 与 字面引用 与 $ 数学共存', () => {
  const md = '公式 \\(\\frac{a}{b}\\)、引用 \\[J/OL\\]、美元数学 $E=mc^2$';
  const html = render(md);
  assert.ok(html.includes('$\\frac{a}{b}$'), 'LaTeX 行内应归一化为 $...$: ' + html);
  assert.ok(html.includes('[J/OL]'), '引用应保持字面: ' + html);
  assert.ok(html.includes('$E=mc^2$'), '原有 $ 应保留: ' + html);
});
