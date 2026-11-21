// 回归测试：不成对定界符（$）吞内容 + 孤立 == 高亮丢字符。
// 覆盖 guardMathBlocks 行内/块级分支的 !foundEnd 回退，以及 convertHighlights 的 == 回退。
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../src/unified-renderer.js');

test('不成对 $ 在表格中不吞内容（用户复现）', async () => {
  const md = [
    '## 测试',
    '',
    '| 项目 | 费用 |',
    '| ---- | ---- |',
    '| 配额 | $12/5h 窗口 |',
    '| 单价 | $0.00038/次 |',
    '',
    '正文里有金额 $12/5h 和 $0.00038/次',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  // 表格仍正常渲染
  assert.ok(html.includes('<table'), '应渲染为 <table>');
  assert.ok((html.match(/<td/g) || []).length === 4, '应有 4 个单元格，不错位');
  // 金额以普通文本原样出现，未被包进 MATHBLOCK 占位符
  assert.ok(html.includes('$12/5h 窗口'), '表格单元格金额应原样显示');
  assert.ok(html.includes('$0.00038/次'), '表格单元格金额应原样显示');
  assert.ok(html.includes('正文里有金额 $12/5h 和 $0.00038/次'), '正文金额应原样显示');
  assert.ok(!html.includes('MATHBLOCK'), '不应生成任何 MATHBLOCK（无成对公式）');
});

test('不成对 $ 不跨表格单元格配对（用户复现 v2）', async () => {
  // 同一行两个不成对 $（不同单元格）不应被当一条公式吞掉中间内容
  const md = [
    '## 测试',
    '',
    '| 项目 | 费用 |',
    '| ---- | ---- |',
    '| 配额 | $12/5h 窗口 |',
    '| 单价 | $0.00038/次 |',
    '',
    '正文里有金额 $$12/5h 和 $$0.00038/次 也会被吞。',
    '',
    '$$ 234322 $$',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<table'), '应渲染为 <table>');
  assert.strictEqual((html.match(/<td/g) || []).length, 4, '应有 4 个单元格，不错位');
  assert.ok(html.includes('$12/5h 窗口'), '表格金额应原样显示');
  assert.ok(html.includes('$0.00038/次'), '表格金额应原样显示');
  assert.ok(html.includes('$$12/5h 和 $$0.00038/次'), '正文内联 $$ 应原样显示（不当公式）');
  assert.ok(html.includes('$$ 234322 $$'), '成对 $$...$$ 应保留供 KaTeX 渲染');
  assert.ok(!html.includes('MATHBLOCK'), '不应生成行内 MATHBLOCK');
  assert.ok((html.match(/math-display/g) || []).length === 1, '仅 $$ 234322 $$ 一个块级公式');
});

test('行内 $$ 当字面量，不跨段配对', async () => {
  // 行内的 $$ 不应作为块级公式，也不应与后续 $$ 跨段配对
  const html = renderMarkdown('正文里有金额 $$12/5h 和 $$0.00038/次', { softBreaks: false });
  assert.ok(html.includes('$$12/5h 和 $$0.00038/次'), '行内 $$ 应原样显示');
  assert.ok(!html.includes('math-display'), '行内 $$ 不应生成块级公式占位');
  assert.ok(!html.includes('MATHBLOCK'), '行内 $$ 不应生成行内占占位');
});

test('成对 $...$ 跨单元格不被配对', async () => {
  // 两个单元格各一个 $ 不应拼成一条公式
  const md = '| a | b |\n| - | - |\n| $x | y$ |';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('$x'), '第一格 $ 原样显示');
  assert.ok(html.includes('y$'), '第二格 $ 原样显示');
  assert.ok(!html.includes('MATHBLOCK'), '跨单元格不成对，不生成占位符');
});

test('成对 $...$ 还原为转义文本（KaTeX 在 DOM 阶段渲染）', async () => {
  const html = renderMarkdown('行内 $a+b$ 公式', { softBreaks: false });
  // restoreMathBlocks 会把占位符替换回转义后的纯文本，KaTeX 在浏览器里渲染
  assert.ok(html.includes('$a+b$'), '成对 $...$ 应还原为字面量文本（供后续 KaTeX 渲染）');
  assert.ok(html.includes('公式'), '后续文字不应被吞');
});

test('成对 $$...$$ 还原为块级 math-display', async () => {
  const html = renderMarkdown('$$c^2$$', { softBreaks: false });
  assert.ok(html.includes('math-display'), '成对 $$...$$ 应生成 math-display 占位');
});

test('孤立不成对 $ 原样显示不吞后续', async () => {
  const html = renderMarkdown('价格 $100 起，详见下文', { softBreaks: false });
  assert.ok(html.includes('$100'), '孤立 $ 应原样显示');
  assert.ok(html.includes('详见下文'), '后续内容不应被吞掉');
  assert.ok(!html.includes('MATHBLOCK'), '不应生成 MATHBLOCK');
});

test('行内 $...$ 含 | > ｜ 原样保留供 KaTeX 渲染', async () => {
  const decodeHtml = (s) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  for (const expr of ['$x=x_{a+1|a}$', '$x>0$', '$x｜y$']) {
    const html = renderMarkdown(expr, { softBreaks: false });
    assert.ok(decodeHtml(html).includes(expr), `${expr} 应原样保留在输出中供 KaTeX 渲染`);
    assert.ok(!html.includes('katex-ignore'), `${expr} 不应被 katex-ignore 跳过`);
  }
});

test('代码块/反引号内 $ 不处理', async () => {
  const md = [
    '```',
    '$a+b$',
    '```',
    '',
    '行内 `$c+d$` 示例',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('$a+b$'), '代码块内 $ 应原样保留');
  assert.ok(html.includes('$c+d$'), '反引号内 $ 应原样保留');
  assert.ok(!html.includes('MATHBLOCK'), '代码块/反引号内不应生成 MATHBLOCK');
});

test('$ 后接空格不触发公式', async () => {
  const html = renderMarkdown('金额 $ 100 起', { softBreaks: false });
  assert.ok(html.includes('$ 100'), '$ 空格后 应原样显示');
});

test('孤立 == 原样显示不丢字符（方案 B）', async () => {
  const html = renderMarkdown('x == y 表示相等', { softBreaks: false });
  assert.ok(html.includes('x == y 表示相等'), '孤立 == 应原样显示，不丢 =');
  assert.ok(!html.includes('<mark>'), '孤立 == 不应生成 <mark>');
});

test('成对 ==x== 仍高亮', async () => {
  const html = renderMarkdown('这是 ==重点== 内容', { softBreaks: false });
  assert.ok(html.includes('<mark>重点</mark>'), '成对 == 应高亮');
});

test('关闭扩展语法后 ==x== 不渲染高亮', async () => {
  const html = renderMarkdown('这是 ==重点== 内容', { softBreaks: false, extendedSyntax: false });
  assert.ok(!html.includes('<mark>'), 'extendedSyntax=false 时不应生成 <mark>');
  assert.ok(html.includes('==重点=='), 'extendedSyntax=false 时 ==重点== 应原样显示');
});

test('默认（未传 extendedSyntax）==x== 仍高亮', async () => {
  const html = renderMarkdown('这是 ==重点== 内容', { softBreaks: false });
  assert.ok(html.includes('<mark>重点</mark>'), '未传 extendedSyntax 时默认高亮，保持向后兼容');
});

test('代码块内 == 不被高亮', async () => {
  const md = [
    '```js',
    'if (a == b) {}',
    '```',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('a == b'), '代码块内 == 应原样保留');
  assert.ok(!html.includes('<mark>'), '代码块内 == 不应高亮');
});

test('blockquote 内 lazy continuation 表格渲染为 HTML <table>', async () => {
  const md = [
    '> 引用内容',
    '| 列1 | 列2 |',
    '| --- | --- |',
    '| 数据1 | 数据2 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('blockquote'), '应包含 blockquote');
  assert.ok(html.includes('<table>'), '应包含 table');
  const bqEnd = html.indexOf('</blockquote>');
  const tableStart = html.indexOf('<table>');
  assert.ok(tableStart < bqEnd, 'table 应在 blockquote 内');
  assert.ok(html.includes('数据1'), '表格数据应渲染');
});

test('无序列表内 lazy continuation 表格渲染为 HTML <table>', async () => {
  const md = '- 列表项\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<ul '), '应包含 ul');
  assert.ok(html.includes('<table'), '应包含 table');
  assert.ok(html.includes('</li>'), '应包含 li 闭合');
});

test('有序列表内 lazy continuation 表格渲染为 HTML <table>', async () => {
  const md = '1. 列表项\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<ol '), '应包含 ol');
  assert.ok(html.includes('<table'), '应包含 table');
});

test('任务列表内 lazy continuation 表格渲染为 HTML <table>', async () => {
  const md = '- [x] 已完成\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<input'), '应包含 checkbox');
  assert.ok(html.includes('<table>'), '应包含 table');
});

test('空行隔开时表格不视为 lazy continuation', async () => {
  const md = '> 引用内容\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('blockquote'), '应包含 blockquote');
  assert.ok(html.includes('<table'), '应包含 table');
  const bqEnd = html.indexOf('</blockquote>');
  const tableStart = html.indexOf('<table');
  assert.ok(bqEnd < tableStart, '空行隔开时 table 应在 blockquote 外');
});

test('容器内表格单元格内联 Markdown 被渲染', async () => {
  const md = [
    '> 引用',
    '| **粗体** | `代码` | *斜体* |',
    '| -------- | ------ | ------ |',
    '| ~~删~~ | [链接](/) | 普通 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<strong>粗体</strong>'), '** 应渲染为 strong');
  assert.ok(html.includes('<code>代码</code>'), '` 应渲染为 code');
  assert.ok(html.includes('<em>斜体</em>'), '* 应渲染为 em');
  assert.ok(html.includes('<del>删</del>'), '~~ 应渲染为 del');
  assert.ok(html.includes('<a href="/">链接</a>'), '[]() 应渲染为链接');
});

// ---- 内联 style 安全放开（2026-07-26）：保留合法样式，剥离危险 CSS ----
test('内联 style 合法声明被保留（日期卡片可渲染）', async () => {
  const md = `<div style="display: flex; justify-content: space-between; background-color: #f8f9fa; padding: 15px 20px; border-radius: 12px; margin-bottom: 30px; font-weight: 600; color: #2c3e50; border: 1px solid #e9ecef;">
    <span style="font-size: 1.2rem;">7月22日</span>
    <span style="color: #6c757d;">星期五</span>
</div>`;
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<div'), 'div 应渲染');
  assert.ok(html.includes('display: flex'), 'display:flex 应保留');
  assert.ok(html.includes('justify-content: space-between'), 'justify-content 应保留');
  assert.ok(html.includes('background-color: #f8f9fa'), 'background-color 应保留');
  assert.ok(html.includes('font-size: 1.2rem'), 'font-size 应保留');
  assert.ok(html.includes('color: #6c757d'), 'color 应保留');
  assert.ok(html.includes('7月22日') && html.includes('星期五'), '文本应保留');
});

test('内联 style 危险 CSS 逐条剥离，安全声明保留', async () => {
  const md = `<div style="color:red; display:none; padding:8px; @import 'evil.css'; visibility:hidden; width:exp/* */ression(alert(1)); -moz-binding:url(x.xml);">x</div>`;
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(!/display\s*:\s*none/.test(html), 'display:none 应被剥离');
  assert.ok(!/visibility\s*:\s*hidden/.test(html), 'visibility:hidden 应被剥离');
  assert.ok(!/expression\s*\(/i.test(html), 'expression() 应被剥离');
  assert.ok(!/@import/i.test(html), '@import 应被剥离');
  assert.ok(!/-moz-binding/i.test(html), '-moz-binding 应被剥离');
  // 安全声明逐条保留（defense in depth：rehype-sanitize + sanitizeStyleValue 双重过滤）
  assert.ok(html.includes('color: red'), 'color:red 安全声明应保留');
  assert.ok(html.includes('padding: 8px'), 'padding 安全声明应保留');
  assert.ok(html.includes('x'), '正文应保留');
});

test('内联 style 含 url(javascript:) 时整条属性被丢弃', async () => {
  // rehype-sanitize 对 url(javascript:) 采取整条 style 丢弃策略（同属性下的安全声明一并移除，属正常安全行为）
  const md = `<div style="background:url(javascript:alert(1)); color:red;">x</div>`;
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(!/javascript:/i.test(html), 'url(javascript:) 不应出现');
  assert.ok(!/color:\s*red/i.test(html), '含危险 url 的整条 style 被丢弃');
  assert.ok(html.includes('x'), '正文应保留');
});

test('非 div/span 标签的内联 style 也保留', async () => {
  const md = `<p style="text-align:center; line-height:1.8;">居中段落</p>`;
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<p'), 'p 应渲染');
  assert.ok(html.includes('text-align: center'), 'text-align 应保留');
  assert.ok(html.includes('line-height: 1.8'), 'line-height 应保留');
});

test('事件处理器 on* 仍被剥离', async () => {
  const md = `<div style="color:red" onclick="alert(1)">x</div>`;
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(!/onclick/i.test(html), 'onclick 应被剥离');
  assert.ok(html.includes('color: red'), '合法 style 仍保留');
});

// ===== 引用块内块级公式（blockquote + $$...$$）回归 =====

test('引用块内规范写法 > $$...$$ 渲染为块级公式', async () => {
  const md = [
    '> **数学提示**：速率为 $v$，通量分别为',
    '> $$',
    '> \\rho v,\\; p+\\rho v^{2}',
    '> $$',
    '> 上述通量相等',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('blockquote'), '应保留引用块结构');
  assert.ok((html.match(/math-display/g) || []).length === 1, '应生成一个块级公式占位');
  assert.ok(!html.includes('MATHBLOCK'), '不应残留未替换占位符');
});

test('引用块 lazy continuation 写法不影响下方独立公式和列表', async () => {
  // 用户复现：> $$ 开头、中间行无 > 前缀（markdown lazy continuation），
  // 下方还有独立公式和列表——上方公式配对绝不能跨段吞掉下方内容。
  const md = [
    '> **数学提示**：若气体速率为 $v$，则通量分别为',
    '> $$',
    '\\rho v,\\; p+\\rho v^{2}',
    '$$',
    '> 当控制体内没有源时，上述通量相等。',
    '',
    '- 32323',
    '- 322323',
    '',
    '$$',
    '\\rho v,\\; p+\\rho v^{2}',
    '$$',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  const displays = html.match(/math-display/g) || [];
  assert.strictEqual(displays.length, 2, '引用块公式 + 下方独立公式各一个块级占位');
  assert.ok((html.match(/<li/g) || []).length === 2, '列表项不应被公式配对吞掉');
  assert.ok(html.includes('32323') && html.includes('322323'), '列表内容应保留');
  assert.ok(!html.includes('MATHBLOCK'), '不应残留未替换占位符');
});

test('空行隔开的两个独立 $$...$$ 不互相跨段配对', async () => {
  const md = [
    '公式一：',
    '$$',
    'a^2',
    '$$',
    '',
    '公式二：',
    '$$',
    'b^2',
    '$$',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  const displays = html.match(/math-display/g) || [];
  assert.strictEqual(displays.length, 2, '两个独立公式各生成一个块级占位');
  assert.ok(html.includes('公式一') && html.includes('公式二'), '段落文字应保留');
  assert.ok(!html.includes('MATHBLOCK'), '不应残留未替换占位符');
});

// ===== 表格单元格内行内公式含 | 不被切断（用户复现）=====

test('表格单元格内成对公式含 | 不切断表格列', async () => {
  // 用户复现：$p(x_k|z_{1:k-1})$ 中的 | 曾被 markdown-it 当列分隔符切断成两列。
  // 现在成对公式优先保护，表格保持 4 列、公式完整留在单个 td 内供 DOM 阶段 KaTeX 渲染。
  const md = [
    '| 表述 | 出发点 | 过程 | 结果 |',
    '| --- | --- | --- | --- |',
    '| **CK 积分** | 整个分布 $p(x_k|z_{1:k-1})$ | 全概率 + 马尔可夫 | 完整预测分布(含 $\\mu$) |',
    '| **条件期望捷径** | 只用均值 $\\hat{x}_{k|k-1}$ | 直接算 $E[x_k|z_{1:k-1}]$ | 只用均值 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<table'), '应渲染为 <table>');
  assert.strictEqual((html.match(/<td/g) || []).length, 8, '4 列 × 2 行 = 8 个单元格，不错位');
  assert.ok(html.includes('$p(x_k|z_{1:k-1})$'), '成对公式应完整保留在单个单元格内');
  assert.ok(html.includes('$\\hat{x}_{k|k-1}$'), '含 | 的下标公式应完整保留');
  assert.ok(html.includes('$E[x_k|z_{1:k-1}]$'), '含 | 的期望公式应完整保留');
});

test('跨单元格的孤立 $ 不配对成公式', async () => {
  // 原有保守规则：$x 与 y$ 分处两个单元格时，不应跨单元格配对成 $x | y$ 吞掉列分隔符
  const md = '| a | b |\n| - | - |\n| $x | y$ |';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.strictEqual((html.match(/<td/g) || []).length, 2, '数据行 2 个单元格（表头是 th 不计数）');
  assert.ok(html.includes('$x') && html.includes('y$'), '孤立 $ 各自保留在单元格内');
  assert.ok(!html.includes('MATHBLOCK'), '不应生成跨单元格 MATHBLOCK');
});

// ===== 原始 HTML 表格内联公式不跨标签配对（用户复现）=====

test('原始 HTML table 单元格内 $...$ 不跨 <td></td> 配对', async () => {
  // 用户复现：<table><tr><td>$ \varphi_k $</td><td>$ M_b $</td>...</table>
  // guardMathBlocks 曾把 "$</td><td>$" 误判为行内公式，导致整行单元格被合并、
  // 后续标签被 escape。修复后每个 $...$ 应留在各自 <td> 内，table 结构完整。
  const md = `<table border=1><tr><td>$ \\varphi_{k} $</td><td>$ M_{b} $</td><td>$ M_{d} $</td><td>$ M_{c} $</td></tr></table>`;
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<table'), '应保留 <table>');
  // 4 个数据单元格（无 thead，统一算 td）
  assert.strictEqual((html.match(/<td/g) || []).length, 4, '应有 4 个 <td>，单元格不错位');
  assert.ok(html.includes('<td>$ \\varphi_{k} $</td>'), 'φ 公式应留在第一个 td');
  assert.ok(html.includes('<td>$ M_{b} $</td>'), 'Mb 公式应留在第二个 td');
  assert.ok(html.includes('<td>$ M_{d} $</td>'), 'Md 公式应留在第三个 td');
  assert.ok(html.includes('<td>$ M_{c} $</td>'), 'Mc 公式应留在第四个 td');
  assert.ok(!html.includes('MATHBLOCK'), '不应生成跨标签 MATHBLOCK');
  assert.ok(!html.includes('&lt;/td&gt;'), '不应出现被 escape 的 </td>');
});

test('原始 HTML table 表头与数据行均含 $...$ 时结构保持', async () => {
  const md = `<table><tr><th>$ x $</th><th>$ y $</th></tr><tr><td>$ a $</td><td>$ b $</td></tr></table>`;
  const html = renderMarkdown(md, { softBreaks: false });
  assert.strictEqual((html.match(/<th/g) || []).length, 2, '应有 2 个 th');
  assert.strictEqual((html.match(/<td/g) || []).length, 2, '应有 2 个 td');
  assert.ok(html.includes('<th>$ x $</th>') && html.includes('<th>$ y $</th>'), '表头公式保留');
  assert.ok(html.includes('<td>$ a $</td>') && html.includes('<td>$ b $</td>'), '数据行公式保留');
  assert.ok(!html.includes('MATHBLOCK'), '不应生成 MATHBLOCK');
});

// ===== 行内 $...$ 前后带空格（用户复现：规范条文公式）=====

test('行内 $...$ 前后带空格且含数学标记时被保护并还原', async () => {
  // 用户粘贴的规范条文：$ f_{a} $、$ A_{b} $ 等，前后都有空格
  const md = '式中： $ f_{a} $——由土的抗剪强度指标确定';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('$ f_{a} $'), '带空格的行内公式文本应完整保留');
  assert.ok(html.includes('——由土的抗剪强度指标确定'), '公式后中文应保留');
});

test('原始 HTML table 单元格内 $...$（带空格、含数学标记）仍独立渲染且结构完整', async () => {
  const md = `<table border=1><tr><td>$ \\varphi_{k}(°) $</td><td>$ M_{b} $</td><td>$ M_{d} $</td><td>$ M_{c} $</td></tr></table>`;
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<table'), '应保留 <table>');
  assert.strictEqual((html.match(/<td/g) || []).length, 4, '应有 4 个 <td>');
  assert.ok(html.includes('<td>$ \\varphi_{k}(°) $</td>'), 'φ 公式应留在第一个 td');
  assert.ok(html.includes('<td>$ M_{b} $</td>'), 'Mb 公式应留在第二个 td');
  assert.ok(!html.includes('&lt;/td&gt;'), '不应出现被 escape 的 </td>');
});

test('前后带空格但内容不像数学的 $...$ 保持字面量', async () => {
  // "$ 100 $" 这种货币/数字文本不应被当成公式
  const md = '金额 $ 100 起，另 $ 200';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('$ 100'), '孤立 $ 应原样显示');
  assert.ok(!html.includes('MATHBLOCK'), '不应生成 MATHBLOCK');
});

test('行内 $...$ 前后带空格且为单字母变量时也被保护并还原', async () => {
  // 用户复现：规范条文 " $ c $——黏聚力" 中 c 是单字母变量
  const md = ' $ c $——黏聚力； $ \u03BD $ 泊松比';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('$ c $'), '单字母变量公式应完整保留');
  assert.ok(html.includes('$ \u03BD $'), '单希腊字母变量公式应完整保留');
  assert.ok(html.includes('黏聚力') && html.includes('泊松比'), '公式后中文应保留');
});

test('行内 $...$ 前后带空格且含比较运算符时被保护并还原', async () => {
  // 用户复现：图注 "$  (e > b/6)  $" 含 > / ( ) /
  const md = '<div style="text-align: center;">图 5.2.2 偏心荷载  $  (e > b/6)  $</div>';
  const html = renderMarkdown(md, { softBreaks: false });
  // 数学块复原时 > 会被 escapeHtml 转义为 &gt;
  assert.ok(html.includes('$  (e &gt; b/6)  $'), '带空格比较公式应完整保留');
  assert.ok(!html.includes('katex-ignore'), '不应被 katex-ignore 跳过');
});

test('原始 HTML table 单元格内数学含 HTML 实体 &lt; &gt; 时只转义一次', async () => {
  // 用户复现：规范表格中 $ 24 &lt; H_{{g}} \le 60 $ 被复原为 $ 24 &amp;lt; ... $，
  // 浏览器看到的是 &lt; 字面量，KaTeX 解析失败显示红色。
  const md = `<table border=1><tr><td>$ 24 &lt; H_{{g}} \\le 60 $</td><td>$ H_{{g}} &gt; 100 $</td></tr></table>`;
  const html = renderMarkdown(md, { softBreaks: false });
  // 应只转义一次：最终 HTML 里实体保持 &lt; / &gt;，不应二次转义为 &amp;lt; / &amp;gt;
  assert.ok(html.includes('<table'), '应保留 <table>');
  assert.ok(html.includes('$ 24 &lt; H_{{g}} \\le 60 $'), '应只转义一次 &lt;');
  assert.ok(html.includes('$ H_{{g}} &gt; 100 $'), '应只转义一次 &gt;');
  assert.ok(!html.includes('&amp;lt;'), '不应出现 &amp;lt;');
  assert.ok(!html.includes('&amp;gt;'), '不应出现 &amp;gt;');
});

test('行内 $...$ 前后带空格且含 ASCII 单引号（素数/导数标记）时被保护并还原', async () => {
  // 用户复现：表格中 "$ R&#x27; $" 经浏览器解码后 inner 为 "R'"，
  // 启发式需把 ASCII 单引号视为数学标记，避免被当成文本边界 break。
  const md = '<table border=1><tr><td>再加荷比  $ R&#x27; $</td></tr></table>';
  const html = renderMarkdown(md, { softBreaks: false });
  // 复原后应保持为合法的 HTML 实体 &#x27;，浏览器解码后 KaTeX 看到 R'
  assert.ok(html.includes('$ R&#x27; $'), "R' 公式应完整保留");
  assert.ok(!html.includes('katex-ignore'), '不应被 katex-ignore 跳过');
});

test('行内 $...$ 含小于号紧邻字母（\\sum_{k<j}）不被当作 HTML 标签截断', async () => {
  // 用户复现：Cholesky 笔记中 $a_{jj}=\underbrace{\sum_{k<j}...}...$ 渲染为字面文本。
  // guardMathBlocks 行内分支曾把 "<j" 误判为 HTML 标签开头提前 break，导致 $ 不配对，
  // 公式被 Markdown 解析成强调。修复后整条公式应完整保留（< 仅转义一次）。
  const md = '- **对角**（$i=j$）：$a_{jj}=\\underbrace{\\sum_{k<j}l_{jk}^2}_{\\text{前面列，已算好}}+\\;l_{jj}^2$ → 移项开根；';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(
    html.includes('$a_{jj}=\\underbrace{\\sum_{k&lt;j}l_{jk}^2}_{\\text{前面列，已算好}}+\\;l_{jj}^2$'),
    '整条公式应完整保留（< 仅转义一次）: ' + html,
  );
  assert.ok(!html.includes('<em'), '下标不应被 Markdown 解析成强调: ' + html);
});

test('行内 $...$ 跨越 Office 命名空间标签时仍中断，标签不被转义进公式', async () => {
  // 标签名字符集曾漏掉 `:`，导致 <o:p>/<w:t> 不再触发中断，公式把标签吞进数学文本，
  // 最终被 escapeHTML 成可见字面量（KaTeX 解析失败）。修复后应恢复：标签交由
  // rehypeCleanOfficeNamespaces 清洗，不进入公式正文。
  const md = '<table><tr><td>$x<o:p></o:p>$</td></tr></table>';
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(html.includes('<td>$x$</td>'), '命名空间标签应被清洗而非转义进单元格: ' + html);
  assert.ok(!html.includes('&lt;o:p'), '不应出现转义的 <o:p 字面量: ' + html);
});

test('未闭合 $ 后大量不等式不触发二次方标签扫描（性能护栏）', async () => {
  // 标签判定曾对每个 `<` 用 [^>]* 扫到文末并回溯：未闭合 $ + 大量 a<b 时 O(n²)。
  // 160KB 输入旧实现约 6.5s，修复后应线性完成（实测阈值取 2s 留足机器差异余量）。
  const md = '$' + 'a<b '.repeat(40000);
  const t0 = Date.now();
  renderMarkdown(md, { softBreaks: false });
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, '渲染耗时 ' + ms + 'ms，疑似 HTML 标签判定 O(n²) 回归');
});

test('HTML 实体按 HTML 标准解码（&nbsp; &amp; &lt; &gt; &copy; 等）', async () => {
  // 内容被原生 HTML 包裹时，实体应交给 HTML 解析器解码，不应残留命名实体字面量。
  const md = '<div>与 &amp; 或 &lt;b&gt; 及 &copy; 2026 &nbsp;尾</div>';
  const html = renderMarkdown(md, { softBreaks: false });
  // 命名实体应被解码，不应残留字面量
  assert.ok(!html.includes('&amp;'), '不应残留 &amp;');
  assert.ok(!html.includes('&lt;'), '不应残留 &lt;');
  assert.ok(!html.includes('&gt;'), '不应残留 &gt;');
  assert.ok(!html.includes('&copy;'), '不应残留 &copy;');
  assert.ok(!html.includes('&nbsp;'), '不应残留 &nbsp;');
  // 解码后的实际字符应出现
  assert.ok(html.includes('©'), '应解码出 ©');
  assert.ok(html.includes(' '), '应解码出不换行空格');
});

test('Word/Excel 命名空间标签与 mso-* 样式被清洗，结构与 class 保留', async () => {
  // 用户复现：粘入 Word/Excel 导出的 HTML 会带 <o:p>/<w:*> 与 mso-* 样式。
  const md = '<table class="MsoTableGrid" border="1">'
    + '<tr><td style="mso-padding:1.0pt; text-align:center">'
    + '<p class="MsoNormal">中、低压缩性土<o:p></o:p></p></td></tr></table>'
    + '<w:tbl><w:tr><w:tc>cell</w:tc></w:tr></w:tbl>'
    + '<div style="mso-element:para; text-align:center">图 1</div>';
  const html = renderMarkdown(md, { softBreaks: false });
  // 命名空间标签应被清除
  assert.ok(!/<o:p/i.test(html), 'o:p 应被清除');
  assert.ok(!/<w:/i.test(html), 'w: 命名空间标签应被清除');
  assert.ok(!/mso-/i.test(html), 'mso-* 样式应被清除');
  // 内部文本 / 结构保留
  assert.ok(html.includes('中、低压缩性土'), '单元格文本应保留');
  assert.ok(html.includes('cell'), 'w:tc 内文本应保留');
  assert.ok(html.includes('图 1'), 'div 文本应保留');
  // 合法 style 与 class 应保留
  assert.ok(html.includes('text-align'), '合法 style 应保留');
  assert.ok(html.includes('MsoTableGrid'), 'class 属性应保留');
});

test('S91 引用层级回退 = 层级感知分块（回退行不并入嵌套 P，2026-10-28 用户反馈②渲染态展示不出来）', async () => {
  // CommonMark 惰性延续会把「嵌套后的浅层行」并进最内层打开的段落（实测 > a/> > b/> c
  // → c 进嵌套 P）= 用户在外层输入的行在渲染态「消失」进嵌套盒。修复：回退行前插
  // 目标层级空引用行（不产生节点）→ 深层盒闭合、回退行独立成 P（与 wysiwyg 块表同口径）。
  const html = renderMarkdown('> A\n> B\n> C\n> > s\n> > d\n> > m\n> x', { softBreaks: true });
  // 外层 = P(ABC) | 嵌套盒(s,d,m) | P(x)：x 不得并入嵌套 P
  const bqMatch = html.match(/<blockquote[^>]*>([\s\S]*)<\/blockquote>\s*$/);
  assert.ok(bqMatch, '应渲染出最外层 blockquote');
  const outer = bqMatch[1];
  assert.ok(!/s<br>d<br>m<br>x/.test(outer), '回退行 x 不得并入嵌套 P（惰性延续回归）');
  assert.ok(/s<br>d<br>m<\/p>\s*<\/blockquote>/.test(outer), '嵌套盒 P 应止于 m（回退前闭合）');
  assert.ok(/<p[^>]*>x<\/p>\s*$/.test(outer.trim()), '回退行 x 应独立成外层 P（块尾）');
  // 源行号映射：x 指向原始行 7（插入的空引用行不占行号）
  assert.ok(/<p data-source-line="7"[^>]*>x<\/p>/.test(outer), '回退行 x 的 data-source-line 应为 7（lineMap 含插入行）');
  // 3→1 跳级：两个深层盒都闭合，回退行独立
  const html2 = renderMarkdown('> a\n> > b\n> > > c\n> d', { softBreaks: true });
  assert.ok(/<p data-source-line="3"[^>]*>c<\/p>/.test(html2), '3→1：最深盒 P(c) 独立闭合');
  assert.ok(/<p data-source-line="4"[^>]*>d<\/p>/.test(html2), '3→1：回退行 d 独立 P');
  // 3→2：只闭合 lvl-3 盒，d 在 lvl-2 成新 P（无空 P 产生）
  const html3 = renderMarkdown('> a\n> > b\n> > > c\n> > d', { softBreaks: true });
  const pCount3 = (html3.match(/<p data-source-line="4"/g) || []).length;
  assert.strictEqual(pCount3, 1, '3→2：d 恰好一个 P（插入空行不得产生空段落）');
  // 回退后升层：回退行 P、升层行新嵌套盒
  const html4 = renderMarkdown('> a\n> > b\n> c\n> > d\n> > e', { softBreaks: true });
  assert.ok(/<p data-source-line="3"[^>]*>c<\/p>/.test(html4), '2→1→2：c 独立外层 P');
  assert.ok(/<p data-source-line="4"[^>]*>d<br>e<\/p>/.test(html4), '2→1→2：d,e 新嵌套盒 P');
});

test('S91 引用层级回退无回归：无回退块/空行分隔/引用后普通段落行为不变', async () => {
  // 无回退（同级合并 + 嵌套盒）保持原样
  const html = renderMarkdown('> a\n> b\n> > c\n> > d', { softBreaks: true });
  assert.ok(/<p data-source-line="1"[^>]*>a<br>b<\/p>/.test(html), '同级软换行合并不变');
  assert.ok(/<p data-source-line="3"[^>]*>c<br>d<\/p>\s*<\/blockquote>/.test(html), '嵌套盒不变');
  // 空行分隔的引用块互不影响（两个顶层 blockquote：前者单层、后者含一层嵌套 = 标签共 3 个）
  const html2 = renderMarkdown('> a\n\n> > b', { softBreaks: true });
  assert.ok((html2.match(/<blockquote data-source-line="1"/g) || []).length === 1 &&
            (html2.match(/<blockquote data-source-line="3"/g) || []).length === 2, '空行分隔 = 两个独立引用块（后块含嵌套层）');
  assert.ok(/<p data-source-line="1"[^>]*>a<\/p>\s*<\/blockquote>/.test(html2), '前块单独闭合（a 不并入后块）');
  // 引用后空行再普通段落：普通段落仍独立（原行为）
  const html3 = renderMarkdown('> 行一\n\n普通段落。', { softBreaks: true });
  assert.ok(/<blockquote data-source-line="1">[\s\S]*?<p data-source-line="1"[^>]*>行一<\/p>\s*<\/blockquote>\s*<p data-source-line="3"[^>]*>普通段落。<\/p>/.test(html3), '引用块不变、普通段落独立');
  assert.ok(/<p[^>]*>普通段落。<\/p>/.test(html3), '普通段落独立');
});



// 回归（2026-11-15，用户文件场景）：convertDefLists 在 remark 解析前逐行改写源文本，
// 原先无围栏状态跟踪 → 代码块内 ": " 行被误改写成 <dl> 字面文本：
//   顶格合法围栏：代码块内容被换成转义的 <dl><dt> 标记（bash 命令被毁）；
//   围栏行写歪（行首 4 空格/不可见空白）：内容炸成真正的定义列表结构、引号丢失。
test('deflist 预处理不进入围栏：顶格合法围栏内 ": " 行原样保留', () => {
  const md = [
    '```bash',
    ': "${KRG_CUTOFF:?请先确认截止时间并配置 KRG_SCOPE}"',
    ': "${KRG_ACTOR:?请先确认操作者}"',
    'read -r -p x KRG_START_TIME',
    '```',
  ].join('\n');
  const html = renderMarkdown(md, {});
  assert.ok(/language-bash/.test(html), '应渲染为 bash 代码块');
  // 代码内容逐字保留（HTML 转义后 : 与引号仍在），绝不能出现 dl 标记（含转义形式）
  assert.ok(html.includes(': &quot;${KRG_CUTOFF:?') || html.includes(': "${KRG_CUTOFF:?'),
    '": " 行应原样留在代码块内');
  assert.ok(html.includes('read -r -p x KRG_START_TIME'), 'read 命令应原样保留');
  assert.ok(!/&#x3C;dl|<dl[\s>]/.test(html), '不应出现任何 dl 标记（含转义形式）');
});

test('deflist 预处理不进入围栏：歪围栏（4 空格缩进）不炸成定义列表', () => {
  const md = [
    '前文段落。',
    '',
    '    ```bash',
    ': "${KRG_CUTOFF:?请先确认截止时间并配置 KRG_SCOPE}"',
    ': "${KRG_ACTOR:?请先确认操作者}"',
    'read -r -p x KRG_START_TIME',
    '```',
  ].join('\n');
  const html = renderMarkdown(md, {});
  // 围栏失效是 CommonMark 语义（缩进代码块），但 ": " 行绝不能被改写成 dl 结构
  assert.ok(!/&#x3C;dl|<dl[\s>]/.test(html), '不应出现任何 dl 定义列表（含转义形式）');
  assert.ok(html.includes('read -r -p x KRG_START_TIME'), 'read 命令应保留为普通文本');
  assert.ok(html.includes('KRG_CUTOFF'), 'KRG_CUTOFF 内容不应丢失');
});

test('deflist 正常转换不回归：围栏外术语+定义仍转 dl', () => {
  const md = 'some term\n: definition A\n: definition B\n';
  const html = renderMarkdown(md, {});
  assert.ok(/<dl[\s>]/.test(html), '围栏外 deflist 仍应正常转换');
  assert.ok(html.includes('<dd'), '定义项应保留');
});

// 回归（2026-11-15 代码块保真审计）：解析前文本级改写器对围栏的感知补齐。
// 审计发现两处真缺陷：
//   ① extractAbbreviations 无围栏跟踪 → 代码块内 *[ABC]: def 字面量行被偷走（行清空
//      + 注入 abbr-data），代码内容被毁；
//   ② convertAlerts / guardMathBlocks 只认 ``` 不认 ~~~ → 波浪线围栏内的 > [!NOTE]
//      与 $$...$$ 字面量被误转成提示块/数学占位符。
test('缩写定义行在围栏内不提取（字面量保留）', () => {
  const md = '```bash\n*[ABC]: 缩写定义\n[^1]: 脚注定义\necho ok\n```';
  const html = renderMarkdown(md, {});
  assert.ok(html.includes('*[ABC]: 缩写定义'), '缩写定义行应原样留在代码块内');
  assert.ok(!html.includes('abbr-data'), '不应注入 abbr-data（围栏内不提取缩写）');
  // 围栏外缩写仍正常工作
  const html2 = renderMarkdown('*[ABC]: 缩写定义\n\n正文提及 ABC 缩写。', {});
  assert.ok(html2.includes('abbr-data'), '围栏外缩写提取不回归');
});

test('波浪线围栏 ~~~ 内 callout/数学/缩写字面量全部保留', () => {
  const inner = [
    '> [!NOTE]',
    '> [!TIP] 提示文字',
    '*[ABC]: 缩写定义',
    '$$',
    'x = 1',
    '$$',
  ].join('\n');
  const html = renderMarkdown('~~~text\n' + inner + '\n~~~', {});
  const m = html.match(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/);
  assert.ok(m, '应渲染出代码块');
  const text = m[1].replace(/&#x3C;/g, '<').replace(/&#x26;/g, '&').replace(/&quot;/g, '"');
  assert.strictEqual(text.replace(/\n$/, ''), inner, '~~~ 围栏内内容必须逐字一致');
  assert.ok(!html.includes('alert-') || !html.includes('ALERTBLOCK'), '不应出现提示块占位');
  assert.ok(!html.includes('math-placeholder'), '不应出现数学占位');
});

test('围栏字符感知：``` 块内的 ~~~ 字面量不翻转状态', () => {
  // ``` 块里出现 ~~~（markdown 示例常见）：deflist/缩写跟踪不能被 ~~~ 误翻转，
  // 否则其后的 ": " 行会在"伪围栏外"被改写成定义列表。
  const md = [
    '```markdown',
    '~~~python',
    'print(1)',
    '~~~',
    '',
    'term',
    ': definition inside code',
    '```',
  ].join('\n');
  const html = renderMarkdown(md, {});
  assert.ok(!/<dl[\s>]|&#x3C;dl/.test(html), '代码块内 ": " 行不得被改写成定义列表');
  assert.ok(html.includes(': definition inside code'), '": " 行应保留在代码块内');
  assert.ok(html.includes('~~~python'), '~~~ 字面量应保留');
});

// ============================================================
// 宽松删除线（relaxStrikethrough，2026-11-17「预览放宽」方案）
// 用户报告：闭合 ~~ 左侧是空白、或左侧是标点且右侧不是空白/标点（全/半角）时，
// remark-gfm flanking 规则拒绝配对、预览原样显示 ~~。方案：恰好 2 波浪配对成功
// 且内容非空 → 改写成 <del> 原生 HTML；remark 本来就能渲染的形态一律不动。
// ============================================================

// 从渲染 HTML 中提取 <del> 的可见文本（无 del 时返回 null）
function delTexts(html) {
  const out = [];
  const re = /<del[^>]*>([\s\S]*?)<\/del>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

test('宽松删除线：闭合前空格的配对改写为 <del>', () => {
  const html = renderMarkdown('~~测试 ~~你好', {});
  const dels = delTexts(html);
  assert.strictEqual(dels.length, 1, '应改写出一个 <del>');
  assert.strictEqual(dels[0], '测试 ', '划线内容 = 「测试 」');
  assert.ok(html.includes('你好'), '后续文字保留');
  assert.ok(!/~~/.test(html), '不应残留 ~~ 字面量');
});

test('宽松删除线：闭合前全角标点、右侧字母 → 改写', () => {
  const html = renderMarkdown('~~测试，~~你好', {});
  const dels = delTexts(html);
  assert.strictEqual(dels.length, 1);
  assert.strictEqual(dels[0], '测试，');
  assert.ok(!/~~/.test(html));
});

test('宽松删除线：闭合前半角标点/括号、右侧字母 → 改写', () => {
  for (const src of ['~~测试,~~你好', '~~测试。~~你好', '~~测试、~~你好', '~~测试（）~~你好', '~~测试()~~你好']) {
    const html = renderMarkdown(src, {});
    assert.strictEqual(delTexts(html).length, 1, src + ' 应改写出一个 <del>');
    assert.ok(!/~~/.test(html), src + ' 不应残留 ~~');
  }
});

test('宽松删除线：开侧失败（字母+标点+~~）同样改写', () => {
  // 「测试~~，~~你好」：opener 后是标点、前是字母 → left-flanking 失败
  const html = renderMarkdown('测试~~，~~你好', {});
  const dels = delTexts(html);
  assert.strictEqual(dels.length, 1);
  assert.strictEqual(dels[0], '，');
  assert.ok(!/~~/.test(html));
});

test('宽松删除线：remark 原生可渲染的形态一律不动（保持管线原路径）', () => {
  const cases = [
    ['~~测试~~你好', '测试'],
    ['~~测试~~ 你好', '测试'],
    ['~~测试~~，你好', '测试'],
    ['~~测试~~（你好）', '测试'],
    ['~~测试，~~ 你好', '测试，'],
    ['~~测试(~~ 你好', '测试('],
  ];
  for (const [src, expected] of cases) {
    const html = renderMarkdown(src, {});
    const dels = delTexts(html);
    assert.strictEqual(dels.length, 1, src + ' 应由 remark-gfm 原生渲染出 <del>');
    assert.strictEqual(dels[0], expected, src + ' 划线内容不符');
    assert.ok(!/~~/.test(html), src + ' 不应残留 ~~');
  }
});

test('宽松删除线：3+ 波浪绝不参与配对（围栏语义/字面量）', () => {
  // singleTilde:false 口径：长度不等的 run 不配对，保持字面量
  const html = renderMarkdown('~~测试~~~你好', {});
  assert.strictEqual(delTexts(html).length, 0, '~~ 与 ~~~ 不应配对');
  assert.ok(html.includes('~~测试~~~你好') || /~~测试~~/.test(html), '波浪应原样保留');
});

test('宽松删除线：代码块内一字不动', () => {
  for (const fence of ['```', '~~~']) {
    const md = fence + 'bash\n: "${VAR:?msg}"  # ~~测试，~~你好\n' + fence;
    const html = renderMarkdown(md, {});
    assert.strictEqual(delTexts(html).length, 0, fence + ' 围栏内不得出现 <del>');
    const m = html.match(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/);
    assert.ok(m, fence + ' 应渲染出代码块');
    const text = m[1].replace(/&#x3C;/g, '<').replace(/&#x26;/g, '&').replace(/&quot;/g, '"');
    assert.ok(text.includes('~~测试，~~你好'), fence + ' 围栏内波浪字面量应逐字保留');
  }
});

test('宽松删除线：歪围栏（行首 4 空格）内的波浪也不动', () => {
  const md = '    ```bash\n    ~~测试，~~你好\n    ```';
  const html = renderMarkdown(md, {});
  assert.strictEqual(delTexts(html).length, 0, '缩进围栏内不得出现 <del>');
});

test('宽松删除线：行内代码内的波浪不动', () => {
  const html = renderMarkdown('代码 `~~测试，~~你好` 保持原样', {});
  assert.strictEqual(delTexts(html).length, 0, '行内代码内不得出现 <del>');
  assert.ok(html.includes('~~测试，~~你好'), '行内代码内容应逐字保留');
});

test('宽松删除线：改写后内容仍走 remark 行内解析（粗体/行内代码生效）', () => {
  const html = renderMarkdown('~~测试**加粗**，~~你好', {});
  const dels = delTexts(html);
  assert.strictEqual(dels.length, 1, '应改写出一个 <del>');
  assert.ok(/<strong(\s[^>]*)?>加粗<\/strong>/.test(dels[0]), '<del> 内的粗体应正常渲染');
});

test('宽松删除线：一行多对混合（可渲染 + 不可渲染）', () => {
  const html = renderMarkdown('~~正常~~与~~异常，~~混排', {});
  const dels = delTexts(html);
  assert.strictEqual(dels.length, 2, '两对都应渲染出 <del>');
  assert.strictEqual(dels[0], '正常');
  assert.strictEqual(dels[1], '异常，');
  assert.ok(!/~~/.test(html));
});

test('宽松删除线：行尾闭合（后无字符）不误改写（remark 原生渲染）', () => {
  const html = renderMarkdown('这是一段~~测试，~~', {});
  const dels = delTexts(html);
  assert.strictEqual(dels.length, 1, '行尾闭合是合法 right-flanking，remark 原生渲染');
  assert.strictEqual(dels[0], '测试，');
});

test('宽松删除线：无波浪内容零开销快速返回（幂等不变）', () => {
  const md = '普通文本，没有波浪线。\n\n第二段。\n';
  assert.strictEqual(renderMarkdown(md, {}), renderMarkdown(md, {}), '重复渲染结果一致');
  assert.ok(renderMarkdown(md, {}).includes('普通文本'), '普通文本正常渲染');
});

// ============================================================
// restoreMathBlocks 直测（P1-9 性能修复安全网，2026-11-21）
// 三种标记形态与 guardMathBlocks 发射（:478/:509 div、inlineMathPlaceholder span）
// 逐字节耦合；restore 从逐占位符 split/join 全文扫描（O(n·m)）改单趟正则（O(n)），
// 行为必须逐字节不变——期望值已与旧实现行为逐字节比对（旧实现补导出后全过），
// 改动后由本组守护回退（评审 2026-11-21 P3-1：旧版未导出本函数，"旧实现直跑全过"不成立）。
// ============================================================
const { restoreMathBlocks } = require('../src/unified-renderer.js');

test('restoreMathBlocks: div 形态（display）替换为 math-display span', () => {
  const html = '<p>前置</p><div class="math-placeholder" data-math-idx="0" data-source-line="3"></div><p>后置</p>';
  const out = restoreMathBlocks(html, [{ display: true, line: 3, text: 'c^2' }]);
  assert.strictEqual(out,
    '<p>前置</p><span class="math-display" data-source-line="3">c^2</span><p>后置</p>',
    'div 占位符应替换为带 data-source-line 的 math-display span');
});

test('restoreMathBlocks: span 包裹形态（行内）连壳剥掉', () => {
  const html = 'a <span><!--MATHBLOCK_0--></span> b';
  const out = restoreMathBlocks(html, [{ display: false, line: 1, text: 'x<y' }]);
  assert.strictEqual(out, 'a x&lt;y b', '行内占位符应连 span 壳替换为转义公式文本');
});

test('restoreMathBlocks: 裸注释形态兜底（rehype-raw 重序列化分离 span 后）', () => {
  const html = 'a <!--MATHBLOCK_0--> b';
  const out = restoreMathBlocks(html, [{ display: false, line: 1, text: 'x<y' }]);
  assert.strictEqual(out, 'a x&lt;y b', '裸 MATHBLOCK 标记应兜底替换');
});

test('restoreMathBlocks: 占位符为纯字符串（防御分支；管线占位符恒为对象）', () => {
  const html = '<span><!--MATHBLOCK_0--></span>';
  const out = restoreMathBlocks(html, ['x<y']);
  assert.strictEqual(out, 'x&lt;y', '字符串占位符按行内公式处理');
});

test('restoreMathBlocks: 多占位符交错不串位（行内×2 + display×1）', () => {
  const html = '<span><!--MATHBLOCK_0--></span> 中 <span><!--MATHBLOCK_1--></span> 尾 '
    + '<div class="math-placeholder" data-math-idx="2" data-source-line="9"></div>';
  const out = restoreMathBlocks(html, [
    { display: false, line: 1, text: 'a_1' },
    { display: false, line: 2, text: 'b&c' },
    { display: true, line: 9, text: 'e=mc^2' },
  ]);
  assert.strictEqual(out,
    'a_1 中 b&amp;c 尾 <span class="math-display" data-source-line="9">e=mc^2</span>',
    '三个占位符各归各位，转义与 display 包装互不串扰');
});

test('restoreMathBlocks: 越界 idx 标记原样放行（eb21434 契约）', () => {
  // html 中的标记串数量超过占位符数组（用户键入字面标记等）时，旧实现按
  // placeholders.length 为界永不触达 → 原样保留；新实现必须同口径。
  const html = '<span><!--MATHBLOCK_5--></span> 和 <!--MATHBLOCK_9-->';
  const out = restoreMathBlocks(html, [{ display: false, line: 1, text: 'x' }]);
  assert.strictEqual(out, html, '越界标记必须原样保留（放行，非报错）');
});

test('restoreMathBlocks: 形状匹配但来源不符的标记不替换（精确匹配契约）', () => {
  // 旧实现按「由占位符重建的标记串」精确匹配：div 形态但占位符为行内、
  // 或 data-source-line 与 ph.line 不符 → 标记串对不上 → 原样保留。
  const html = '<div class="math-placeholder" data-math-idx="0" data-source-line="7"></div>';
  // out1 数据与标记 line 一致（7）：display/inline 交叉检查成为唯一拒绝路径——
  // 若 line 不一致，line 比对会先拦住，删掉 display 检查测试仍绿（评审 2026-11-21 P2-2）。
  const out1 = restoreMathBlocks(html, [{ display: false, line: 7, text: 'x<y' }]);
  assert.strictEqual(out1, html, 'div 形态但占位符为行内 → 不替换（仅 display/inline 交叉检查可拒）');
  const out2 = restoreMathBlocks(html, [{ display: true, line: 1, text: 'e' }]);
  assert.strictEqual(out2, html, 'div 形态但 data-source-line 与 ph.line 不符 → 不替换（仅 line 比对可拒）');
});

test('restoreMathBlocks: 非规范数字串（前导零）原样放行', () => {
  // (\d+) 会命中前导零拼写，Number 归一后误命中缓存；旧实现按重建标记串精确匹配
  // 永不命中（评审 2026-11-21 P2-1 实证：007 → 旧原样 / 新误替换为占位符文本）。
  // 放行口径 = eb21434「用户键入标记串不触碰」在非规范拼写的延续。
  const phs = [];
  for (let i = 0; i < 8; i++) phs.push({ display: false, line: i + 1, text: 't' + i });
  const html = '<span><!--MATHBLOCK_07--></span> 与 <!--MATHBLOCK_007--> 与 <!--MATHBLOCK_00-->';
  assert.strictEqual(restoreMathBlocks(html, phs), html, '前导零 idx 拼写必须原样放行');
  // 阳性对照：规范拼写仍正常替换（防规范校验过紧把合法路径一并放行）
  assert.strictEqual(restoreMathBlocks('<!--MATHBLOCK_7-->', phs), 't7', '规范 idx 仍须替换');
});

test('restoreMathBlocks: span/裸标记遇 display 占位符不替换（交叉形态对称契约）', () => {
  // display 占位符只发 div 形态；span/裸标记若出现在 html 中（用户字面输入），
  // 行内 cache 未定义必须放行——对称于「div 标记遇行内占位符」（评审 2026-11-21 P2-2 补对称覆盖）。
  const html = '<span><!--MATHBLOCK_0--></span> 与 <!--MATHBLOCK_1-->';
  const out = restoreMathBlocks(html, [
    { display: true, line: 1, text: 'a' },
    { display: true, line: 2, text: 'b' },
  ]);
  assert.strictEqual(out, html, 'display 占位符的 span/裸标记不得被行内替换路径触碰');
});

test('restoreMathBlocks: 实体回环——decode 后再 escape 恰好一次', () => {
  // 占位符文本先 decodeHtmlEntities 再 escapeHTML（与旧实现同序），用户实体不得
  // 二次转义成 &amp;lt;（评审 2026-11-21 P3-7：直测组补覆盖，此前仅集成测试触达）。
  const out = restoreMathBlocks('<span><!--MATHBLOCK_0--></span>', ['a &lt; b &amp; c']);
  assert.strictEqual(out, 'a &lt; b &amp; c', 'decode→escape 回环后实体应保持单次转义');
});

test('restoreMathBlocks: 占位符输出不再含标记串（单趟替换与多趟顺序等价的前提）', () => {
  // 替换输出经 escapeHTML 后不可能再产生任何标记形态——单趟一次替换因此与
  // 旧实现「div 全换完再换 span、再换裸标记」的顺序语义等价。
  const html = '<span><!--MATHBLOCK_0--></span><div class="math-placeholder" data-math-idx="1" data-source-line="2"></div>';
  const out = restoreMathBlocks(html, [
    { display: false, line: 1, text: '<span><!--MATHBLOCK_9--></span>' },
    { display: true, line: 2, text: '<!--MATHBLOCK_9-->' },
  ]);
  assert.strictEqual(out,
    '&lt;span&gt;&lt;!--MATHBLOCK_9--&gt;&lt;/span&gt;'
    + '<span class="math-display" data-source-line="2">&lt;!--MATHBLOCK_9--&gt;</span>',
    '公式内容中的标记串必须被转义，不得产生可再匹配的标记');
});

test('restoreMathBlocks: 空 placeholders 输入原样返回', () => {
  const html = '<span><!--MATHBLOCK_0--></span><p>plain</p>';
  assert.strictEqual(restoreMathBlocks(html, []), html);
  // null/undefined 防御性放行（旧实现抛 TypeError，实现注释第 6 条声明）——必须由测试
  // 锁定，否则该早退守卫是哑弹：删除后无任何测试变红（复审 2026-11-21 14:07 P3-2）。
  assert.strictEqual(restoreMathBlocks(html, null), html, 'null 放行且原样返回');
  assert.strictEqual(restoreMathBlocks(html, undefined), html, 'undefined 放行且原样返回');
});

test('P1-9 性能基线：公式密集文档（63KB/4000 行内公式）整篇渲染记录耗时', () => {
  // 仅记录，不设硬阈值（机器差异 flaky，同 N17 约定）。修复前后同输入比对：
  // 旧实现（逐占位符 split/join 全文扫描 O(n·m)）实测 ≈1150-1250ms；
  // 单趟正则（O(n)）预期降至 ≈200-400ms（remark 解析占比为主）。
  // 断言只锁「无占位符残留 + 无 MATHBLOCK 字面量」行为不变。
  const para = '在区间 $[a, b]$ 上 $x<y$ 且 $f(x)=g(y)$ 成立，另有 $\hat{x}_{k-1|k-1}$ 项。';
  const md = Array(1000).fill(para).join('\n\n');
  renderMarkdown(md, {}); // 预热（processor 缓存），与首测口径一致
  const t0 = Date.now();
  const html = renderMarkdown(md, {});
  const dt = Date.now() - t0;
  assert.ok(!/<!--MATHBLOCK_\d+-->/.test(html), '行内占位符应全部还原');
  assert.ok(!html.includes('math-placeholder'), 'div 占位符应全部还原');
  assert.ok((html.match(/&lt;y/g) || []).length >= 1000, '公式文本应大量还原（转义 < 存在）');
  console.log(`[P1-9 基线] 63KB/4000 公式整篇渲染 ${dt}ms`);
});

test('P1-9 回归门：restoreMathBlocks 不得回退为逐占位符全文扫描（自相对断言）', () => {
  // 评审 2026-11-21 P3-4：整篇基线仅记录无阈值，实现回退到 O(n·m) 时测试仍绿。
  // 本测试内嵌修复前的算法形状（逐占位符 split/join 全文扫描）作同机同输入标尺，
  // 单趟实现必须快于标尺的 1/2——机器无关（两份耗时随机器同比缩放），无 flaky 面。
  // 标尺是刻意的第二实现，只作时间基线不作输出 oracle——输出契约由直测组锁定。
  const N = 4000;
  const phs = [];
  const parts = [];
  for (let i = 0; i < N; i++) {
    phs.push({ display: false, line: i + 1, text: 'x_' + i });
    parts.push('<span><!--MATHBLOCK_' + i + '--></span>');
  }
  const html = parts.join('');
  const legacy = (h, ps) => {
    let r = h;
    for (let idx = 0; idx < ps.length; idx++) {
      r = r.split('<span><!--MATHBLOCK_' + idx + '--></span>').join(ps[idx].text);
      r = r.split('<!--MATHBLOCK_' + idx + '-->').join(ps[idx].text);
    }
    return r;
  };
  legacy(html, phs); // 预热（JIT）
  restoreMathBlocks(html, phs);
  const t0 = Date.now();
  legacy(html, phs);
  const dtOld = Date.now() - t0;
  const t1 = Date.now();
  const out = restoreMathBlocks(html, phs);
  const dtNew = Date.now() - t1;
  assert.ok(!out.includes('MATHBLOCK'), '单趟实现应全部还原占位符');
  assert.ok(
    dtNew * 2 < dtOld,
    `单趟实现必须快于 O(n·m) 标尺的 1/2（实测 新=${dtNew}ms vs 标尺=${dtOld}ms）——失败说明实现已回退为逐占位符全文扫描`
  );
  console.log(`[P1-9 回归门] 单趟 ${dtNew}ms vs O(n·m) 标尺 ${dtOld}ms（同机同输入）`);
});
