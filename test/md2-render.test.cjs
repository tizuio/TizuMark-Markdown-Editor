// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// 端到端：renderMarkdown 产出带 colspan/rowspan 的表格。
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../src/unified-renderer.js');

test('网格表 2x2 合并端到端渲染', () => {
  const md = [
    '+-------+-------+-------+',
    '| A 2x2         | B     |',
    '+...............+-------+',
    '|               | C     |',
    '+---------------+-------+',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<table>/);
  assert.match(html, /<td colspan="2" rowspan="2">/);
  assert.match(html, /A 2x2/);
  assert.match(html, /C/);
});

test('管道表 >> 标记端到端渲染', () => {
  const md = ['| H1 | H2 | H3 |', '| -- | -- | -- |', '| A spans | >> | B |'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<td colspan="2">/);
  assert.match(html, /A spans/);
});

test('管道表 ^^ 标记端到端渲染', () => {
  const md = ['| H1 | H2 |', '| -- | -- |', '| R | B |', '| ^^ | C |'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<td rowspan="2">/);
});

test('无标记的普通 GFM 表格输出不变（回归）', () => {
  const md = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<table/);
  assert.match(html, /<th[^>]*>a<\/th>/);
  assert.ok(!/colspan|rowspan/.test(html), '普通表格不应出现合并属性');
});

test('表格内的行内标记照常渲染', () => {
  // 边框宽度必须容得下最宽的单元格内容，故取 21 个短横（闭合竖线落在第 22 列）
  const md = ['+---------------------+', '| **bold** and `code` |', '+---------------------+'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  // 单元格内容回灌完整管线，故元素上带 remarkSourceLine 注入的 data-source-line 属性，
  // 断言都用 [^>]* 容忍该属性（这里要验证的是「行内标记被渲染成真元素」而非属性形态）。
  assert.match(html, /<strong[^>]*>bold<\/strong>/);
  assert.match(html, /<code[^>]*>code<\/code>/);
});

test('单元格内列表渲染为真实列表', () => {
  const md = [
    '+----------------+',
    '| - item one     |',
    '| - item two     |',
    '+----------------+',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<ul[^>]*>/);
  assert.match(html, /<li[^>]*>item one<\/li>/);
});

test('块引用内的网格表不被认领（md2 §1.4：仅顶层）', () => {
  const md = ['> +---+', '> | a |', '> +---+'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(!/<table/.test(html), '容器内不应生成 md2 表格');
  assert.ok(!/md2-error/.test(html), '也不应报 md2 错误');
});

test('单元格内容中的表格语法不产生嵌套表（重入守卫）', () => {
  // 单元格文本是 " +---+"，若不设重入守卫，递归渲染时它会被 md2 扫描
  // 再次认领成一张表。守卫使嵌套深度恒为 1（md2 §1.4 本身也禁止单元格内嵌表格）。
  const md = [
    '+-----------+',
    '| +---+     |',
    '+-----------+',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  const tables = html.match(/<table/g) || [];
  assert.strictEqual(tables.length, 1, '只应有一张表，不应嵌套');
});

test('错误块可见且文档其余部分仍渲染', () => {
  const md = ['# Title', '', '| a |', '| - |', '| 1 | 2 |', '', 'tail'].join('\n');
  // 该表无 >> / ^^ 标记 → 放行给 remark-gfm，不产生 md2 错误
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /tail/);
});

test('网格表语法错误时产出 .md2-error 块且后续内容继续渲染', () => {
  const md = [
    '+---+---+',
    '| a | b | c |',
    '+---+---+',
    '',
    'after',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /class="md2-error"/);
  assert.match(html, /after/);
});

test('两行表头的管道表端到端渲染（md2 §4.3）', () => {
  // 对照真实 md2.exe render：<thead> 内两个 <tr>，全部是 <th>；无一残留为段落。
  const md = [
    '| Region | North | South |',
    '| Metric | Units | Count |',
    '| ------ | ----- | ----- |',
    '| East   | 10    | 20    |',
    '| West   | 12    | 18    |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<table/);
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(html);
  assert.ok(thead, '应有 thead');
  assert.strictEqual((thead[1].match(/<tr/g) || []).length, 2, 'thead 内应有 2 个表头行');
  assert.ok(!/<td/.test(thead[1]), '表头行内不应出现 td');
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(html);
  assert.strictEqual((tbody[1].match(/<tr/g) || []).length, 2, 'tbody 内应有 2 个数据行');
  assert.ok(!/Region/.test(html.replace(thead[1], '')), '首行不得残留在表外');
});

test('紧跟段落的多行表头表整块作为段落（不得吐出表格）', () => {
  // md2 render 对照：整个输入是一个 <p>；此处断言「没有表」这一关键点。
  const md = [
    'Some paragraph.',
    '| Region | North | South |',
    '| Metric | Units | Count |',
    '| ------ | ----- | ----- |',
    '| East   | 10    | 20    |',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(!/<table/.test(html), '不应生成表格');
  assert.match(html, /Some paragraph\./, '段落文本保留');
  assert.match(html, /\| Region \| North \| South \|/, '表格行作为字面文本保留');
});

test('围栏代码块内的网格表保持原样', () => {
  const md = ['```', '+---+', '| a |', '+---+', '```'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(!/<table/.test(html), '围栏内不应生成表格');
  assert.match(html, /\+---\+/);
});
