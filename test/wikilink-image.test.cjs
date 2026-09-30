// Obsidian 风格图片嵌入 ![[图片路径]] 的渲染测试。
// 直接调用源渲染器（src/unified-renderer.js），验证「占位注释 → <img>」转换的正确性，
// 以及代码区/非图片 wikilink 不被误识别。真图显示由 image-processor 的 processImages 负责（需真机/集成验证）。

const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../src/unified-renderer.js');

const render = (md) => renderMarkdown(md, { softBreaks: false });

test('![[相对图片路径]] 渲染为 <img>，路径与 ![]() 一致', () => {
  const html = render('![[assets/figures/coupling_curves.png]]');
  assert.ok(html.includes('<img src="assets/figures/coupling_curves.png"'), '应生成对应 <img>');
  assert.ok(html.includes('alt="coupling_curves"'), 'alt 默认取文件名（去扩展名）');
});

test('![[图片|600]] 等比宽度：仅 width，无 height', () => {
  const html = render('![[a.png|600]]');
  assert.ok(html.includes('<img src="a.png"'), '应生成 <img>');
  assert.ok(html.includes('width="600"'), '应包含 width="600"');
  assert.ok(!/height=/.test(html), '不应含 height');
});

test('![[图片|600x400]] 指定宽×高', () => {
  const html = render('![[a.png|600x400]]');
  assert.ok(html.includes('width="600"'), '应包含 width="600"');
  assert.ok(html.includes('height="400"'), '应包含 height="400"');
});

test('![[图片|非数字后缀]] 作为 alt 文本，仍显示图片', () => {
  const html = render('![[a.png|示意图]]');
  assert.ok(html.includes('<img src="a.png"'), '应生成 <img>');
  assert.ok(html.includes('alt="示意图"'), '非数字后缀应作为 alt');
});

test('非图片扩展名 ![[note.md]] 不识别为图片（最小可用范围）', () => {
  const html = render('![[note.md]] 和 ![[doc.txt]]');
  assert.ok(!html.includes('<img'), '不应生成 <img>');
  assert.ok(html.includes('![[note.md]]'), '原文 ![[note.md]] 应保留');
});

test('无 ! 的 [[图片.png]] 不识别为图片', () => {
  const html = render('[[assets/pic.png]]');
  assert.ok(!html.includes('<img'), '不应生成 <img>');
});

test('行内代码 `![[...]]` 不被当作图片', () => {
  const html = render('示例 `![[assets/pic.png]]` 结束');
  assert.ok(!html.includes('<img'), '行内代码内不应生成 <img>');
  assert.ok(html.includes('![[assets/pic.png]]'), '行内代码内原文应保留');
});

test('围栏代码块内的 ![[...]] 不被当作图片', () => {
  const html = render('```\n![[assets/pic.png]]\n```');
  assert.ok(!html.includes('<img'), '代码块内不应生成 <img>');
  assert.ok(html.includes('![[assets/pic.png]]'), '代码块内原文应保留');
});

test('多个图片嵌入各自正确映射路径', () => {
  const html = render('先 ![[a.png]] 再 ![[b.jpg|200x100]] 末');
  assert.ok(html.includes('<img src="a.png"'), 'a.png 应映射');
  assert.ok(html.includes('<img src="b.jpg"'), 'b.jpg 应映射');
  assert.ok(html.includes('width="200"') && html.includes('height="100"'), 'b.jpg 尺寸应生效');
});

test('图片路径含 & 或 " 时属性被正确转义', () => {
  const html = render('![[a&b".png]]');
  // 不应产生属性截断导致的非法 <img ...=" 结构；至少应含转义后的 src 片段
  assert.ok(html.includes('src="') && html.includes('a&amp;b&quot;.png'), '特殊字符应被 escapeHTML 转义');
});
