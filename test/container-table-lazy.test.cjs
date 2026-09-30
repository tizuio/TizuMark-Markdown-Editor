// 回归测试：引用块懒续 + 文字段紧接表格 的渲染。
// 历史 bug：原 convertContainerTables 仅在「表格紧邻 > 行」或「表格行本身带 >」时转换；
// 当引用块首行带 >、后续多段普通文字（无 >）懒续、末尾接表格（无空行）时，
// 表格检测失败，整段被当纯文本，<table> 不生成。
// 修复后：追踪容器懒续状态，且「无空行紧接的表格」统一转 HTML。
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../src/unified-renderer.js');

test('引用块首行带> + 多段普通文字懒续 + 末尾表格(无空行) → 表格渲染进引用块内', async () => {
  const md = [
    '> **本节结论**：平台以开发者代码场景为主。',
    '**分类体系**：12 类，多信号融合。',
    '**整体分布**：',
    '| 意图 | 总量 | 占比 |',
    '|------|------|------|',
    '| other | 5,482 | 27.0% |',
    '| code_review | 5,374 | 26.5% |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<table/.test(html), '应生成 <table>');
  assert.ok(/<blockquote[^>]*>[\s\S]*<table/.test(html), '表格应在 <blockquote> 内');
});

test('顶层段落紧接表格(无空行) → 渲染为顶层表格', async () => {
  const md = [
    '**整体分布**：',
    '| 意图 | 总量 |',
    '|------|------|',
    '| other | 5,482 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<table/.test(html), '应生成 <table>');
  assert.ok(!/<blockquote/.test(html), '顶层表格不应在 blockquote 内');
});

test('有空行分隔的顶层表格 → 仍正常(remark 处理)', async () => {
  const md = [
    '以下是数据：',
    '',
    '| 意图 | 总量 |',
    '|------|------|',
    '| other | 5,482 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<table/.test(html), '有空行分隔的表格应正常渲染');
});

test('引用块内每行带>的表格 → 仍在引用块内', async () => {
  const md = [
    '> **整体分布**：',
    '> | 意图 | 总量 |',
    '> |------|------|',
    '> | other | 5,482 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<table/.test(html), '应生成 <table>');
  assert.ok(/<blockquote[^>]*>[\s\S]*<table/.test(html), '表格应在 <blockquote> 内');
});

// ---- 表格单元格内 <br> 换行（自定义表格路径 renderCellContent）----
// 历史 bug：该路径 escapeHTML 转义一切标签，<br> 显示为字面文本；
// remark-gfm 路径（有空行分隔）却支持 → 两路径行为不一致。

test('无空行紧接表格：单元格 <br> 还原为真 <br> 标签', async () => {
  const md = [
    '表：',
    '| 内容 |',
    '|------|',
    '| 第一行<br>第二行 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<td>第一行<br>第二行<\/td>/.test(html), '应为真 <br>，实际: ' + html.match(/<td>[^<]*<[^>]*>[^<]*<\/td>/));
  assert.ok(!/&lt;br/.test(html), '不应残留转义实体');
});

test('blockquote 内表格：单元格 <br> 同样还原', async () => {
  const md = [
    '> | 内容 |',
    '> |------|',
    '> | 第一行<br>第二行 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<td>第一行<br>第二行<\/td>/.test(html), '应为真 <br>');
});

test('blockquote 内先有文字后接表格（真机用户场景）：单元格 <br> 同样还原', async () => {
  const md = [
    '> 引用块里的表格也应支持换行：',
    '>',
    '> | 场景 | 写法 |',
    '> |------|------|',
    '> | 基础换行 | 第一行<br>第二行 |',
  ].join('\n');
  for (const softBreaks of [false, true]) {
    const html = renderMarkdown(md, { softBreaks });
    assert.ok(/<td>基础换行<\/td>[\s\S]*?<td>第一行<br>第二行<\/td>/.test(html),
      'softBreaks=' + softBreaks + ' 应为真 <br>，实际: ' + html);
  }
});

test('<br> 变体均还原：<BR>、<br/>、<br />', async () => {
  const md = [
    '表：',
    '| a | b | c |',
    '|---|---|---|',
    '| x<BR>y | x<br/>y | x<br />y |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  // 注：HTML 管线（rehype-raw）会把标签名规范化为小写，三种变体最终均输出 <br>
  assert.ok(/<td>x<br>y<\/td>[\s\S]*<td>x<br>y<\/td>[\s\S]*<td>x<br>y<\/td>/.test(html), '三种变体均应还原为真 <br>，实际: ' + html);
  assert.ok(!/&lt;br|&#x3C;br/i.test(html), '不应残留转义实体');
});

test('行内代码里的 <br> 保持字面显示，不还原为标签', async () => {
  const md = [
    '表：',
    '| 内容 |',
    '|------|',
    '| 用 `<br>` 换行 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<code>(?:&lt;|&#x3C;)br(?:&gt;|&#x3E;|>)<\/code>/.test(html), '行内代码应保持转义实体，实际: ' + html);
  assert.ok(!/<code><br><\/code>/.test(html), '行内代码不应出现真 <br> 标签');
});

test('其他 HTML 标签（如 <u>）仍被转义，不受影响', async () => {
  const md = [
    '表：',
    '| 内容 |',
    '|------|',
    '| <u>下划线</u> |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/(?:&lt;|&#x3C;)u(?:&gt;|&#x3E;|>)/.test(html), '<u> 应保持转义，实际: ' + html);
  assert.ok(!/<u>/.test(html), '不应生成真 <u> 标签');
});

test('有空行分隔的表格（remark-gfm 路径）<br> 行为不变', async () => {
  const md = [
    '表：',
    '',
    '| 内容 |',
    '|------|',
    '| 第一行<br>第二行 |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(/<td[^>]*>第一行<br>第二行<\/td>/.test(html), 'remark 路径应保持原有支持，实际: ' + html);
});
