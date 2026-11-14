// Markdown 渲染盲点测试（整理测试库时补充）：
// 直接调用打包后的 unified 渲染器（src/lib/unified-bundle.js），验证 GFM 常见语法的输出，
// 不依赖 DOM / Tauri。覆盖：任务列表、表格、删除线、脚注、定义列表、围栏代码、标题、链接、图片。
//
// 该包导出 module.exports = { renderMarkdown }，可在 node 直接 require。

const test = require('node:test');
const assert = require('node:assert');
const { loadUnifiedRenderer } = require('./helpers/load-bundle.cjs');
const { JSDOM } = require('jsdom');

// 渲染包在浏览器里以 <script> 加载，定义全局 UnifiedRenderer（不走 module.exports），
// 且初始化时引用 document（HTML 实体解码依赖 DOM）。这里用 jsdom 窗口 eval 加载。
const _dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const _w = _dom.window;
global.window = _w;
global.document = _w.document;
global.navigator = _w.navigator;

// 产物加载统一走 helpers/load-bundle.cjs（P0-0e）：缺失时给可操作指引而非 ENOENT 堆栈。
const renderMarkdown = loadUnifiedRenderer(_w).renderMarkdown;

function render(md, opts = { softBreaks: false }) {
  return renderMarkdown(md, opts);
}

test('render: 任务列表渲染 checkbox', async () => {
  const html = render('- [ ] 待办\n- [x] 已完成');
  assert.ok(html.includes('type="checkbox"'), '任务列表应渲染 checkbox');
  assert.ok(html.includes('disabled'), '渲染的 checkbox 应禁用（只读预览）');
  assert.ok(html.includes('checked'), '已勾选项应带 checked');
});

test('render: 表格渲染 thead/tbody', async () => {
  const html = render('| 列1 | 列2 |\n| --- | --- |\n| a | b |');
  assert.ok(html.includes('<table'), '应渲染 table');
  assert.ok(html.includes('<th'), '应渲染表头 th');
  assert.ok(html.includes('<td'), '应渲染单元格 td');
});

test('render: 删除线 ~~x~~', async () => {
  const html = render('这是 ~~删除~~ 文本');
  assert.ok(html.includes('<del'), '删除线应渲染为 <del>');
});

test('render: 脚注', async () => {
  const html = render('正文有脚注[^1]\n\n[^1]: 脚注内容');
  assert.ok(html.includes('footnote') || html.includes('id="fn'), '应渲染脚注区块');
});

test('render: 脚注定义注入被净化（XSS）', async () => {
  // 脚注定义原文不得拼入 HTML（历史 bug：sanitize 后直接拼接 raw 源文本）
  const html = render('正文[^1]\n\n[^1]: <img src=x onerror=alert(1)> 内容');
  assert.ok(!html.includes('onerror'), '脚注定义中的事件处理器应被剥离');
  assert.ok(!html.includes('alert(1)'), '脚注定义中的脚本不应出现');
  assert.ok(html.includes('id="fn-'), '应仍渲染脚注区块');
});

test('render: 脚注定义内 markdown 语法正常渲染', async () => {
  // 附带修复：定义内 **bold** 渲染为 <strong> 而非字面量
  const html = render('正文[^1]\n\n[^1]: 定义含 **加粗** 与 [链接](https://x.com)');
  assert.ok(html.includes('<strong>加粗</strong>'), '脚注定义内 **bold** 应渲染');
  assert.ok(html.includes('href="https://x.com"'), '脚注定义内链接应渲染');
});

test('render: 定义列表', async () => {
  const html = render('术语\n: 解释');
  assert.ok(html.includes('<dl') || html.includes('<dt') || html.includes('<dd'),
    '定义列表应渲染 dl/dt/dd');
});

test('render: 围栏代码带语言类', async () => {
  const html = render('```js\nconst a = 1;\n```');
  assert.ok(html.includes('<pre') && html.includes('<code'), '应渲染 pre/code');
  assert.ok(/class="[^"]*language-js/.test(html), '代码块应带 language-js 类');
});

test('render: 标题渲染', async () => {
  const html = render('# 一级标题\n## 二级');
  assert.ok(html.includes('<h1'), '应渲染 h1');
  assert.ok(html.includes('<h2'), '应渲染 h2');
});

test('render: 链接与图片', async () => {
  const html = render('[百度](https://baidu.com)\n![图](img.png)');
  assert.ok(html.includes('href="https://baidu.com"'), '应渲染链接 href');
  assert.ok(html.includes('<img') && html.includes('src="img.png"'), '应渲染 img 标签');
});

test('render: 软换行选项 softBreaks', async () => {
  const withBr = render('第一行\n第二行', { softBreaks: true });
  const noBr = render('第一行\n第二行', { softBreaks: false });
  assert.ok(withBr.includes('<br'), 'softBreaks=true 应插入 <br>');
  assert.ok(!noBr.includes('<br'), 'softBreaks=false 不应插入 <br>');
});

test('render: 有序/无序列表', async () => {
  const html = render('1. 一\n2. 二\n\n- 甲\n- 乙');
  assert.ok(html.includes('<ol') && html.includes('<li'), '有序列表应渲染 ol/li');
  assert.ok(html.includes('<ul') && (html.match(/<li[ >]/g) || []).length >= 4, '无序列表应渲染 ul/li');
});

test('render: 引用块', async () => {
  const html = render('> 引用内容');
  assert.ok(html.includes('<blockquote'), '应渲染 blockquote');
});

// C12（P1-7）：承接 Rust render_markdown 退役用例的 XSS 语义 —— 前端 unified-renderer 是
// 唯一生产渲染路径，其 sanitizeHTML/sanitizeTagAttributes 必须挡住同类注入。
test('render: XSS 标题内 script 被剥离但文本保留', async () => {
  const html = render('# <script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), '标题内 script 标签必须被剥离');
  assert.ok(html.includes('alert(1)'), '脚本文本内容应作为纯文本保留');
});

test('render: 文本内 img onerror 被剥离但 img 保留', async () => {
  const html = render('Hello <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('onerror'), '内联 onerror 事件处理器必须被剥离');
  assert.ok(html.includes('<img'), 'img 标签本身应保留');
});

test('render: 裸 script 标签被剥离', async () => {
  const html = render('Text <script>document.cookie</script> more');
  assert.ok(!html.includes('<script>'), 'script 开标签必须被剥离');
  assert.ok(!html.includes('</script>'), 'script 闭标签必须被剥离');
  assert.ok(html.includes('Text') && html.includes('more'), '前后文本应保留');
});

test('render: iframe 被剥离', async () => {
  const html = render('Text <iframe src="evil.com"></iframe> more');
  assert.ok(!html.includes('<iframe'), 'iframe 开标签必须被剥离');
  assert.ok(!html.includes('</iframe>'), 'iframe 闭标签必须被剥离');
});

test('render: 图片 src 保留', async () => {
  const html = render('![alt](https://example.com/img.png)');
  assert.ok(html.includes('<img'), '应渲染 img 标签');
  assert.ok(html.includes('src='), '图片 src 属性应保留');
});

test('render: 数字实体编码的 javascript: 绕过被拦截', async () => {
  const html = render('<a href="&#x6A;avascript:alert(1)">click</a>');
  assert.ok(!html.includes('javascript:'), '数字实体解码后的 javascript: 必须被拦截');
  assert.ok(html.includes('click'), '链接文本应保留');
});

test('render: 明文 javascript: 链接被拦截', async () => {
  const html = render('<a href="javascript:alert(1)">x</a>');
  assert.ok(!html.includes('javascript:'), '明文 javascript: 必须被拦截');
});

// ---- 行首行内公式的 HTML 块陷阱 ----
// guardMathBlocks 把行首 $…$ 换成 <!--MATHBLOCK_N--> 占位注释后，CommonMark 把行首
// HTML 注释解析为 HTML 块（type 2），整行不再做内联解析 → 该行后续的 **加粗** /
// 斜体 / 链接全部字面化（用户 MOT 笔记实测）。占位符包 <span> 后回到段落上下文。
test('render: 行首行内公式不吞并该行其余内联语法（HTML 块陷阱）', async () => {
  const html = render('$4.5 / 8.33 = 0.54$，雷达在**加粗**——测试', { softBreaks: false });
  assert.ok(/<strong[\s>]/.test(html), '行首公式之后的 **加粗** 必须正常渲染');
  assert.ok(html.includes('<p'), '该行应渲染为段落而非 HTML 块');
  assert.ok(html.includes('$4.5 / 8.33 = 0.54$'), '公式须还原为公式文本（交给 KaTeX 渲染）');
  // span 包裹只服务于 remark 解析阶段，restore 时须剥掉（最终输出与历史版本一致）
  assert.ok(!/<span>\$4\.5 \/ 8\.33 = 0\.54\$<\/span>/.test(html), '还原后不应残留包裹 span');
});

test('render: 行内公式在行中时行为不变（还原输出与历史版本逐字节一致）', async () => {
  const html = render('前文 $x=1$，雷达在**加粗**——测试', { softBreaks: false });
  assert.ok(/<strong[\s>]/.test(html), '行中公式的粗体应正常渲染');
  assert.ok(html.includes('$x=1$'), '公式须还原为公式文本');
  assert.ok(!/<span>\$x=1\$<\/span>/.test(html), '行中公式还原后同样不应残留包裹 span');
});

test('render: 列表项内行首行内公式同样不吞内联语法', async () => {
  const html = render('- $x=1$ 列表内**加粗**', { softBreaks: false });
  assert.ok(/<li[\s>]/.test(html), '应渲染为列表项');
  assert.ok(/<strong[\s>]/.test(html), '列表项内行首公式后的粗体必须正常渲染');
});
