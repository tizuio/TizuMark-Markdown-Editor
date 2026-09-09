// 大纲面板 UI 与字数统计 UI 测试：updateOutline 渲染/点击跳转/折叠、updateWordCount、
// headingToId / escapeHtml / escapeAttr / escapeMdText
// 使用 withEditor 串行化，避免 node:test 并发子测试互相踩踏共享的 global.window/document。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

const DOC = '# 一级标题\n\n正文\n\n## 二级 A\n\n### 三级 B\n\n## 二级 C\n';

test('outline-ui: 无标题渲染空提示', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('只有正文，没有标题');
  ed.updateOutline();
  const oc = w.document.getElementById('outline-content');
  assert.ok(oc.querySelector('.outline-empty'), '应渲染 outline-empty');
}));

test('outline-ui: 渲染层级结构与 data-line', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue(DOC);
  ed.updateOutline();
  const oc = w.document.getElementById('outline-content');
  const items = [...oc.querySelectorAll('.outline-item')];
  assert.strictEqual(items.length, 4, '应渲染 4 个标题项');
  const lines = items.map((i) => i.dataset.line);
  assert.deepStrictEqual(lines, ['0', '4', '6', '8'], 'data-line 应为标题所在行号');
  assert.ok(oc.textContent.includes('一级标题') && oc.textContent.includes('二级 C'));
}));

test('outline-ui: 点击标题项跳转编辑器光标并激活', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue(DOC);
  ed.updateOutline();
  const oc = w.document.getElementById('outline-content');
  const target = [...oc.querySelectorAll('.outline-item')].find((i) => i.dataset.line === '6');
  assert.ok(target, '应找到三级 B 项');
  target.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(ed.cm.getCursor().line, 6, '光标应跳到标题行');
  assert.ok(target.classList.contains('active'), '被点击项应激活');
  const actives = oc.querySelectorAll('.outline-item.active');
  assert.strictEqual(actives.length, 1, '只应有一个激活项');
}));

test('outline-ui: 点击折叠开关切换子级显隐', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue(DOC);
  ed.updateOutline();
  const oc = w.document.getElementById('outline-content');
  const toggle = oc.querySelector('.outline-toggle');
  assert.ok(toggle, '有子级的标题应有折叠开关');
  const wrapper = toggle.closest('.outline-item-wrapper');
  const children = wrapper.querySelector('.outline-children');
  assert.ok(children && !children.classList.contains('collapsed'), '初始应展开');
  toggle.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(children.classList.contains('collapsed'), '点击后应折叠');
  assert.ok(toggle.classList.contains('collapsed'), '点击后 toggle 应带 collapsed 类（CSS 旋转成 ▶）');
  toggle.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(!children.classList.contains('collapsed'), '再点应展开');
  assert.ok(!toggle.classList.contains('collapsed'), '再点后 toggle 不应带 collapsed 类（恢复 ▼ 向下）');
}));

// 状态栏三项计数：原始字数（原文字符数）/ 预览字数 / 行数。
// 旧版是「词数 + 字符数 + 行数」（charCountEl），底部栏改原文/预览双口径后
// charCountEl 已移除，改由 wordCountEl 承载原始字数、previewWordCountEl 承载预览字数。
test('wordcount-ui: updateWordCount 更新状态栏三项计数', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.settings.language = 'zh';
  const text = 'hello world 你好\n第二行 abc';
  ed.cm.setValue(text);
  ed.updateWordCount();
  assert.ok(/\d+/.test(ed.wordCountEl.textContent), '原始字数应为数字');
  assert.ok(ed.lineCountEl.textContent.endsWith('2'), '行数应为 2');
  const chars = parseInt(ed.wordCountEl.textContent.match(/(\d+)/)[1], 10);
  assert.strictEqual(chars, text.length, '原始字数应为全文字符数');
  assert.ok(ed.previewWordCountEl, '状态栏应存在预览字数元素');
  assert.ok(/\d+/.test(ed.previewWordCountEl.textContent), '预览字数应为数字');

  ed.cm.setValue('');
  ed.updateWordCount();
  assert.ok(ed.wordCountEl.textContent.endsWith('0'), '空文档原始字数为 0');
}));

test('outline-ui: headingToId 生成规则', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  assert.strictEqual(ed.headingToId('Hello World'), 'hello-world');
  assert.strictEqual(ed.headingToId('中文 标题'), '中文-标题');
  assert.strictEqual(ed.headingToId('  A -- B__C  '), 'a-b-c');
  assert.strictEqual(ed.headingToId('!!!'), '', '纯符号应为空串');
  assert.strictEqual(ed.headingToId('Ver 2.0'), 'ver-20', '点号被移除');
}));

test('outline-ui: escapeHtml / escapeAttr / escapeMdText 转义', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  assert.strictEqual(ed.escapeHtml('<b>&"x"'), '&lt;b&gt;&amp;"x"');
  assert.strictEqual(ed.escapeAttr('a"b<c>&d'), 'a&quot;b&lt;c&gt;&amp;d');
  assert.strictEqual(ed.escapeMdText('a]b\\c'), 'a\\]b\\\\c');
}));

function setActiveFileName(ed, name) {
  // activeTab 是 getter（指向 tabs[activeTabIndex]），直接改 tab 对象即可
  ed.tabs[ed.activeTabIndex].name = name;
}

test('breadcrumb-ui: 有标题时面包屑显示文件名+标题链', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  setActiveFileName(ed, 'a.md');
  ed.cm.setValue('# 一级\n正文\n## 二级');
  ed.cm.setCursor({ line: 2, ch: 0 });
  ed.updateOutline();
  const bc = w.document.getElementById('editor-breadcrumb');
  const content = bc.querySelector('.editor-breadcrumb-content');
  assert.ok(!bc.classList.contains('hidden'), '有标题时不应被隐藏');
  assert.ok(content.textContent.includes('a.md'), '应显示文件名 a.md，实际：' + content.textContent);
  assert.ok(content.textContent.includes('一级'), '应显示一级标题');
  assert.ok(content.textContent.includes('二级'), '应显示二级标题');
}));

test('breadcrumb-ui: 光标在第一标题前时仍显示文件名（不隐藏，避免编辑区跳动）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  setActiveFileName(ed, '1L1FUPSRCDEFAULTBUF.md');
  // 模拟截图中的文档：4 行空行 + 标题 + 表格起始
  ed.cm.setValue('\n\n\n\n# HW 接口\n\n| 端口 | 方向 |\n');
  ed.cm.setCursor({ line: 1, ch: 0 });
  ed.updateOutline();
  const bc = w.document.getElementById('editor-breadcrumb');
  const content = bc.querySelector('.editor-breadcrumb-content');
  assert.ok(!bc.classList.contains('hidden'), '光标在第一标题前时面包屑也不应被隐藏');
  const fileEl = content.querySelector('.editor-breadcrumb-file');
  assert.ok(fileEl, '应保留文件名项');
  assert.ok(fileEl.textContent.includes('1L1FUPSRCDEFAULTBUF.md'), '文件名应保留，实际：' + fileEl.textContent);
  // 不应有标题层级
  assert.strictEqual(content.querySelectorAll('.editor-breadcrumb-item').length, 0, '无路径时不应渲染标题项');
}));

test('breadcrumb-ui: updateBreadcrumb 路径：光标在标题前不隐藏', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  setActiveFileName(ed, 'b.md');
  ed.cm.setValue('# 标题 A\n\n## 标题 B');
  // 先用 updateOutline 预热
  ed.updateOutline();
  const bc = w.document.getElementById('editor-breadcrumb');
  assert.ok(!bc.classList.contains('hidden'), '初始有标题时应显示');
  // 把光标移到第一标题前
  ed.cm.setCursor({ line: 0, ch: 0 });
  // 显式传 line=-1 模拟「光标在所有标题之前」的极端情况
  ed.updateBreadcrumb(false, -1);
  assert.ok(!bc.classList.contains('hidden'), '光标在第一标题前时仍应保留栏体（不 .hidden），避免编辑区上下跳动');
  const content = bc.querySelector('.editor-breadcrumb-content');
  assert.ok(content.querySelector('.editor-breadcrumb-file'), '应保留文件名项');
  assert.strictEqual(content.querySelectorAll('.editor-breadcrumb-item').length, 0, '无路径时不应追加标题项');
}));

test('breadcrumb-ui: 无标题文档仍显示文件名（不隐藏）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  setActiveFileName(ed, 'plain.md');
  ed.cm.setValue('只有正文，没有标题\n第二行');
  ed.updateOutline();
  const bc = w.document.getElementById('editor-breadcrumb');
  const content = bc.querySelector('.editor-breadcrumb-content');
  assert.ok(!bc.classList.contains('hidden'), '无标题文档也不应隐藏面包屑');
  assert.ok(content.textContent.includes('plain.md'), '应显示文件名');
}));

test('outline-ui: 纯符号标题点击不抛 SyntaxError', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  // headingToId('===') 产出空串；点击空 data-id 时 querySelector('#') 曾抛 SyntaxError
  ed.cm.setValue('# ===\n\n## 正常标题');
  ed.updateOutline();
  const oc = w.document.getElementById('outline-content');
  const symbolItem = [...oc.querySelectorAll('.outline-item')].find((i) => i.dataset.id === '');
  assert.ok(symbolItem, '纯符号标题应渲染为空 data-id');
  assert.doesNotThrow(() => {
    symbolItem.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  }, '点击空 id 标题不得抛 SyntaxError');
  assert.strictEqual(ed.cm.getCursor().line, 0, '光标应跳到标题行');
}));
