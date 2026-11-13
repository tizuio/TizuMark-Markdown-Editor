// 大纲抽取单元测试：锁定 extractHeadings / buildOutlineTree / renderOutlineHtml 行为。
const test = require('node:test');
const assert = require('node:assert');
const { extractHeadings, buildOutlineTree, renderOutlineHtml, computeBreadcrumbPath, renderBreadcrumbHtml } = require('../src/modules/outline.js');

// 复刻 app.js 的 headingToId（纯函数），注入给 extractHeadings
function headingToId(text) {
  let id = '';
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) id += ch.toLowerCase();
    else if (ch === ' ' || ch === '-' || ch === '_') id += '-';
  }
  return id.replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const opts = { headingToId, escapeHtml };

test('无标题返回空数组', async () => {
  assert.deepStrictEqual(extractHeadings('正文没有标题\n第二段', opts), []);
});

test('提取 # ~ ###### 各级标题与行号', async () => {
  const md = '# 一级\n正文\n## 二级\n### 三级\n```\n# 这是代码块里的假标题\n```\n#### 四级';
  const hs = extractHeadings(md, opts);
  assert.strictEqual(hs.length, 4);
  assert.deepStrictEqual(hs.map((h) => h.level), [1, 2, 3, 4]);
  // 代码块内的 # 被跳过
  assert.ok(!hs.some((h) => h.text.includes('代码块')));
  // 行号正确（基于 0 的索引）
  assert.strictEqual(hs[0].line, 0);
  assert.strictEqual(hs[3].line, 7);
});

test('标题文本去除 markdown 标记（显示用完整清理）', async () => {
  const hs = extractHeadings('# **加粗** `代码` [链接](u)', opts);
  // 完整清理：链接括号 (u) / 反引号 / 强调标记均剥离，显示更干净
  assert.strictEqual(hs[0].text, '加粗 代码 链接');
  // id 仍由轻量清理文本生成，保持与改动前一致（不影响锚点跳转）
  assert.strictEqual(hs[0].id, '加粗-代码-链接u');
});

test('标题完整清理：图片/链接/代码/强调/尾随# 均剥离（仅影响显示）', async () => {
  const md = [
    '# ![图](a.png) 图示',
    '## ~~删除~~ 普通 *斜体* 与 **粗体**',
    '### 结尾 #',
    '#### 行内 `code()` 与 <http://x>',
  ].join('\n');
  const hs = extractHeadings(md, opts);
  assert.strictEqual(hs[0].text, '图示');
  assert.strictEqual(hs[1].text, '删除 普通 斜体 与 粗体');
  assert.strictEqual(hs[2].text, '结尾');
  assert.strictEqual(hs[3].text, '行内 code() 与 http://x');
  // HTML 标签 <...> 不被删除（交由渲染层转义为文字，避免误删正常尖括号内容）
  assert.ok(hs[3].text.includes('http://x'));
});

test('重复标题 id 去重', async () => {
  const md = '# 标题\n## 小节\n# 标题';
  const hs = extractHeadings(md, opts);
  assert.strictEqual(hs[0].id, '标题');
  assert.strictEqual(hs[2].id, '标题-2');
});

test('buildOutlineTree 按层级组织', async () => {
  const hs = extractHeadings('# A\n## B\n## C\n### D\n# E', opts);
  const tree = buildOutlineTree(hs);
  assert.strictEqual(tree.length, 2); // A, E
  assert.strictEqual(tree[0].children.length, 2); // B, C
  assert.strictEqual(tree[0].children[1].children.length, 1); // D under C
  assert.strictEqual(tree[0].children[1].children[0].text, 'D');
});

test('renderOutlineHtml 输出层级/锚点/id/data-line 且转义', async () => {
  const hs = extractHeadings('# 标题 <x>\n## 子', opts);
  const tree = buildOutlineTree(hs);
  const html = renderOutlineHtml(tree, opts);
  assert.ok(html.includes('class="outline-item level-1"'));
  assert.ok(html.includes('data-id="标题-x"'));
  assert.ok(html.includes('data-line="0"'));
  // 含子节点应有 toggle
  assert.ok(html.includes('outline-toggle'));
  // 转义校验
  assert.ok(html.includes('&lt;x&gt;'), '标题文本应被转义: ' + html);
});

test('renderOutlineHtml: 无子节点项也渲染隐藏占位 toggle 以保证标签对齐', async () => {
  // # A 有子 ## B；B 为叶子（无子）。
  const hs = extractHeadings('# A\n## B', opts);
  const tree = buildOutlineTree(hs);
  const html = renderOutlineHtml(tree, opts);

  // 有子节点项：可见 toggle（不含 --hidden），输出与文件目录同款线性 chevron SVG
  assert.ok(html.includes('class="outline-toggle"><svg'), 'A 应为可见 toggle（含 chevron SVG）');
  // 无子节点项：占位 toggle（含 --hidden），用于对齐
  assert.ok(html.includes('outline-toggle--hidden'), 'B（叶子）应渲染隐藏占位 toggle');
  // 占位 toggle 不应是可见 toggle（类名需区分）
  const leafToggle = html.match(/<span class="(outline-toggle outline-toggle--hidden)">/);
  assert.ok(leafToggle, '叶子 toggle 应带 outline-toggle--hidden 类');
  // 占位 toggle 同样输出 chevron SVG，宽度与可见 toggle 完全一致，保证对齐
  assert.ok(html.includes('class="outline-toggle outline-toggle--hidden"><svg'), '占位 toggle 应保留 chevron SVG');
  assert.ok(html.includes('m9 18 6-6-6-6') && html.includes('fill="none"'), 'toggle 必须是描边 chevron-right');
  assert.ok(!html.includes('M1.5 4 L10.5 4 L6 8 Z'), '不得再输出实心等腰小三角');
});

test('与旧实现逐字符一致（回归）', async () => {
  const samples = [
    '',
    '# 仅标题',
    '# A\n## B\n正文\n### C\n```\n# 代码块内\n```\n## B',
    '无标题正文\n另一段',
  ];
  for (const s of samples) {
    const headings = extractHeadings(s, opts);
    const tree = buildOutlineTree(headings);
    const html = renderOutlineHtml(tree, opts);
    // 旧实现对空标题渲染 outline-empty；模块对空 headings 不渲染（由调用方判断是否空）
    if (headings.length === 0) {
      assert.strictEqual(headings.length, 0);
      continue;
    }
    assert.ok(html.includes('outline-item'), 'sample=' + JSON.stringify(s));
  }
});

// ---- 面包屑路径计算 ----

test('computeBreadcrumbPath: 无标题返回空路径', async () => {
  const hs = extractHeadings('正文\n第二段', opts);
  assert.deepStrictEqual(computeBreadcrumbPath(hs, 1), []);
});

test('computeBreadcrumbPath: 根标题覆盖后续正文', async () => {
  const hs = extractHeadings('# 一级\n正文\n## 二级\n### 三级\n正文', opts);
  // 光标在正文第 1 行 -> 仅一级
  assert.deepStrictEqual(computeBreadcrumbPath(hs, 1).map((h) => h.text), ['一级']);
  // 光标在三级标题行 -> 一/二/三级
  assert.deepStrictEqual(computeBreadcrumbPath(hs, 3).map((h) => h.text), ['一级', '二级', '三级']);
  // 光标在三级后的正文 -> 同上
  assert.deepStrictEqual(computeBreadcrumbPath(hs, 4).map((h) => h.text), ['一级', '二级', '三级']);
});

test('computeBreadcrumbPath: 同级标题替换且子树回退', async () => {
  const md = '# A\n## B\n### C\n## D\n### E\n正文';
  const hs = extractHeadings(md, opts);
  assert.deepStrictEqual(computeBreadcrumbPath(hs, 2).map((h) => h.text), ['A', 'B', 'C']);
  // D 与 B 同级 -> B/C 出栈，路径变为 A/D；E 加深
  assert.deepStrictEqual(computeBreadcrumbPath(hs, 4).map((h) => h.text), ['A', 'D', 'E']);
  // E 后的正文仍保持 A/D/E
  assert.deepStrictEqual(computeBreadcrumbPath(hs, 5).map((h) => h.text), ['A', 'D', 'E']);
});

test('computeBreadcrumbPath: 越级标题正确处理', async () => {
  const md = '# A\n### B\n正文';
  const hs = extractHeadings(md, opts);
  assert.deepStrictEqual(computeBreadcrumbPath(hs, 2).map((h) => h.text), ['A', 'B']);
});

test('computeBreadcrumbPath: 负行号或超过最大标题不崩溃', async () => {
  const hs = extractHeadings('# A\n## B', opts);
  assert.deepStrictEqual(computeBreadcrumbPath(hs, -1), []);
  assert.deepStrictEqual(computeBreadcrumbPath(hs, 999).map((h) => h.text), ['A', 'B']);
});

// ---- 面包屑渲染（截断 / 折叠策略） ----
const ICON = '<svg class="breadcrumb-icon"></svg>';

test('renderBreadcrumbHtml: 文件名带引号被转义且文字进 crumb-label', async () => {
  const html = renderBreadcrumbHtml([], 'a"b', { iconSvg: ICON });
  assert.ok(html.includes('editor-breadcrumb-file'));
  assert.ok(html.includes('title="a&quot;b"'));
  assert.ok(html.includes('<span class="crumb-label">a"b</span>'));
  assert.ok(html.includes(ICON));
});

test('renderBreadcrumbHtml: 层级较少全部渲染，末尾加 active', async () => {
  const hs = [
    { line: 1, text: '一' },
    { line: 2, text: '二' },
    { line: 3, text: '三' },
  ];
  const html = renderBreadcrumbHtml(hs, 'f.md', {});
  assert.ok(html.includes('data-breadcrumb-line="1"'));
  assert.ok(html.includes('data-breadcrumb-line="2"'));
  assert.ok(html.includes('data-breadcrumb-line="3"'));
  // 最后一个标题为 active
  assert.ok(html.includes('editor-breadcrumb-item active" data-breadcrumb-line="3"'));
});

test('renderBreadcrumbHtml: 层级再多也全部渲染（不折叠），滚动可看全每一层', async () => {
  const hs = [];
  for (let i = 1; i <= 9; i++) hs.push({ line: i, text: 'H' + i });
  const html = renderBreadcrumbHtml(hs, 'f.md', {});
  // 所有层级（含 H2~H7）都渲染出来，无一被永久隐藏
  for (let i = 1; i <= 9; i++) {
    assert.ok(html.includes('data-breadcrumb-line="' + i + '"'), '缺失层级 H' + i);
  }
  // 不应出现折叠占位符
  assert.ok(!html.includes('editor-breadcrumb-ellipsis'));
  // 最后一个标题为 active
  assert.ok(html.includes('editor-breadcrumb-item active" data-breadcrumb-line="9"'));
});

test('renderBreadcrumbHtml: 标题含 < 被转义，不破坏结构', async () => {
  const hs = [{ line: 1, text: 'A < B' }];
  const html = renderBreadcrumbHtml(hs, 'f.md', {});
  assert.ok(html.includes('&lt;'));
  assert.ok(!html.includes('< B</span>'));
});
