// 块切分的**行为**测试（不靠静态断言，真的跑切分结果）。
//
// 背景：阶段1 的块遮罩用 isBlockStart（虚拟滚动用的粗粒度判定）切块，实测出阻塞级 bug：
//   - 表格被逐行切碎（| a | b | 与 | --- | --- | 分成两块）
//   - 相邻标题/段落没被切开（光标在正文里，整段连标题一起变源码）
// 本文件直接验证「给定 Markdown → 切出哪些块」，是回归护栏。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { splitBlocks } = require(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'));

const split = (md) => splitBlocks(md.split('\n')).map(b => b.lines);

// ---------- 表格：必须整体一块 ----------

test('表格：多行表格（含分隔行）切为【一块】，不逐行切碎', () => {
  const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
  const bs = split(md);
  assert.strictEqual(bs.length, 1, '表格被切碎了：' + JSON.stringify(bs));
  assert.strictEqual(bs[0].length, 4);
});

test('表格：前后有正文时，表格独立成块', () => {
  const md = ['前面段落', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '后面段落'].join('\n');
  assert.deepStrictEqual(split(md), [['前面段落'], ['| a | b |', '| --- | --- |', '| 1 | 2 |'], ['后面段落']]);
});

// ---------- 相邻标题：必须切开 ----------

test('相邻标题与段落：无空行也要各自成块', () => {
  const md = ['# 标题', '正文一段', '## 子标题', '更多正文', '结尾'].join('\n');
  assert.deepStrictEqual(split(md), [
    ['# 标题'],
    ['正文一段'],
    ['## 子标题'],
    // CommonMark 语义：相邻纯文本行属同一段落，故「更多正文」与「结尾」是一块
    ['更多正文', '结尾'],
  ]);
});

// ---------- 列表：整体一块（含任务列表、嵌套） ----------

test('无序列表：连续列表项切为一块', () => {
  const md = ['- a', '- b', '- c'].join('\n');
  assert.deepStrictEqual(split(md), [['- a', '- b', '- c']]);
});

test('有序列表：连续列表项切为一块', () => {
  const md = ['1. a', '2. b', '3. c'].join('\n');
  assert.deepStrictEqual(split(md), [['1. a', '2. b', '3. c']]);
});

test('任务列表：整体一块（不按 - [ ] 拆）', () => {
  const md = ['- [ ] a', '- [x] b', '- [ ] c'].join('\n');
  assert.deepStrictEqual(split(md), [['- [ ] a', '- [x] b', '- [ ] c']]);
});

test('嵌套列表：缩进子项归属同一块', () => {
  const md = ['- a', '    - b', '        - c'].join('\n');
  assert.deepStrictEqual(split(md), [['- a', '    - b', '        - c']]);
});

test('列表与后续正文分开（空行分隔）', () => {
  const md = ['- a', '- b', '', '后续正文'].join('\n');
  assert.deepStrictEqual(split(md), [['- a', '- b'], ['后续正文']]);
});

// ---------- 引用块 / callout ----------

test('引用块：连续 > 行切为一块', () => {
  const md = ['> 引用1', '> 引用2'].join('\n');
  assert.deepStrictEqual(split(md), [['> 引用1', '> 引用2']]);
});

test('callout（> [!NOTE] 多行）：整体一块', () => {
  const md = ['> [!NOTE]', '> 正文第一行', '> 正文第二行'].join('\n');
  assert.deepStrictEqual(split(md), [['> [!NOTE]', '> 正文第一行', '> 正文第二行']]);
});

test('嵌套引用：多层 > 仍为一块', () => {
  const md = ['> 外层', '> > 内层'].join('\n');
  assert.deepStrictEqual(split(md), [['> 外层', '> > 内层']]);
});

// ---------- 代码围栏 ----------

test('代码围栏：含语言标注与内部空行，整体一块且不误切', () => {
  const md = ['```js', 'const a=1;', '', 'const b=2;', '```'].join('\n');
  assert.deepStrictEqual(split(md), [['`js', 'const a=1;', '', 'const b=2;', '```'].map((s, i) => md.split('\n')[i])]);
});

test('围栏内的 # 与 | 不得被当成块起点', () => {
  const md = ['```', '# not a heading', '| not | a table |', '```'].join('\n');
  assert.strictEqual(split(md).length, 1, '围栏内部被误切');
});

test('未闭合围栏：剩余全部归一块（不得吞掉后续文档）', () => {
  const md = ['```', 'a', 'b'].join('\n');
  assert.strictEqual(split(md).length, 1);
});

// ---------- 其他块级 ----------

test('水平分割线：单独成块', () => {
  const md = ['a', '', '---', '', 'b'].join('\n');
  assert.deepStrictEqual(split(md), [['a'], ['---'], ['b']]);
});

test('front matter：--- 到 --- 之间为一块', () => {
  const md = ['---', 'title: x', '---', '', '正文'].join('\n');
  assert.deepStrictEqual(split(md), [['---', 'title: x', '---'], ['正文']]);
});

test('普通段落：连续文本为一块', () => {
  const md = ['第一行', '第二行', '第三行'].join('\n');
  assert.deepStrictEqual(split(md), [['第一行', '第二行', '第三行']]);
});

test('混合文档：逐块切分正确（覆盖典型场景）', () => {
  const md = [
    '# 标题',
    '正文段落',
    '## 子标题',
    '- 列表A',
    '- 列表B',
    '',
    '| 表头 | 二 |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '> [!WARNING]',
    '> 注意',
    '',
    '```py',
    'print(1)',
    '```',
    '',
    '结尾',
  ].join('\n');
  assert.deepStrictEqual(split(md), [
    ['# 标题'],
    ['正文段落'],
    ['## 子标题'],
    ['- 列表A', '- 列表B'],
    ['| 表头 | 二 |', '| --- | --- |', '| 1 | 2 |'],
    ['> [!WARNING]', '> 注意'],
    ['```py', 'print(1)', '```'],
    ['结尾'],
  ]);
});

// ---------- 边界 ----------

test('空文档 / 全空行：不产生任何块', () => {
  assert.deepStrictEqual(split(''), []);
  assert.deepStrictEqual(split('\n\n\n'), []);
});

test('块内不含空行（空行一律作分隔，不归属任何块）', () => {
  for (const b of split('# a\n\n正文\n\n- x\n\n> y')) {
    assert.ok(!b.some(l => l.trim() === ''), '块内混入了空行：' + JSON.stringify(b));
  }
});

test('行号区间与块内容一致（start/end 精确）', () => {
  const lines = ['# t', 'p', '', '- a', '- b'];
  const bs = splitBlocks(lines);
  for (const b of bs) {
    assert.deepStrictEqual(lines.slice(b.start, b.end), b.lines, '行号区间与内容不符');
  }
});

// ---------- remark 解析器切块（renderMarkdownBlocks，主路径） ----------
// 手写 splitBlocks 与 CommonMark 边界有系统性偏差，遮罩切块已改为 remark 解析器
// （与阅读模式同一套解析），保证逐块渲染与阅读模式完全一致。
// 渲染器是纯 CommonJS（require('unified') 等），Node 可直接加载做行为验证。

const { renderMarkdownBlocks } = require('../src/unified-renderer.js');

test('remark 切块：`1.` 独立行 + 缩进内容必须是一个有序列表块（不得拆出空列表项）', () => {
  // 曾被手写切块器拆成两块：`1.` 渲染成空列表项（只剩序号）、缩进行渲染成独立块
  // —— 即真机截图里「带有序号的空行」。remark 解析与阅读模式一致，必须整块。
  const md = ['1.', '    收到任务，先检查是否有匹配的 skill', '', '2.', '    设计先于编码'].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  assert.strictEqual(blocks.length, 1, '应切为 1 块（整个有序列表），实际 ' + blocks.length);
  assert.strictEqual(blocks[0].start, 0);
  assert.strictEqual(blocks[0].end, 5);
  const html = blocks[0].html;
  assert.match(html, /<ol/, '应渲染为有序列表');
  assert.match(html, /收到任务/, '列表项内容不得丢失');
  assert.match(html, /设计先于编码/, '第二个列表项内容不得丢失');
  assert.doesNotMatch(html, /<li>\s*<\/li>/, '不得出现空列表项（只剩序号的空行）');
});

test('remark 切块：表格含对齐行整体一块，标题/段落/列表各自成块，空行不归属', () => {
  const md = [
    '# 标题',
    '',
    '正文一段',
    '',
    '- 项目 A',
    '- 项目 B',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '结尾',
  ].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  assert.strictEqual(blocks.length, 5, '标题/段落/列表/表格/段落各一块，实际 ' + blocks.length);
  assert.deepStrictEqual(blocks.map(b => [b.start, b.end]), [[0, 1], [2, 3], [4, 6], [7, 10], [11, 12]]);
  const table = blocks[3];
  assert.match(table.html, /<table/, '表格整体渲染（含分隔行与数据行）');
  for (const b of blocks) assert.ok(b.html && b.html.trim(), '每个内容块都应有渲染 html');
});

test('remark 切块：围栏代码块内部空行/井号不切断，HTML 注释单块', () => {
  const md = [
    '```js',
    '# 不是标题',
    '',
    'const a = 1;',
    '```',
    '',
    '<!-- 注释 -->',
  ].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].end, 5, '围栏吃到闭合行为止');
  assert.match(blocks[0].html, /<code|<pre/, '代码块渲染');
  assert.strictEqual(blocks[1].start, 6);
});

test('remark 切块：块边界与阅读模式一致（逐块 html 与整篇渲染同构）', () => {
  const md = ['## 小节', '', '段落文本', '', '1. 甲', '2. 乙'].join('\n');
  const { renderMarkdown } = require('../src/unified-renderer.js');
  const blocks = renderMarkdownBlocks(md, {});
  // 逐块渲染的标签序列应与整篇渲染一致（同一套 remark 解析的必然结果）
  const tagsOf = (h) => (h.match(/<(h\d|p|ol|ul|li|table)[ >]/g) || []).join(',');
  const whole = tagsOf(renderMarkdown(md, {}));
  const byBlocks = blocks.map(b => tagsOf(b.html)).join(',');
  assert.strictEqual(byBlocks, whole, '逐块渲染的标签序列应与整篇一致');
});

test('remark 切块：多行展示公式内含独占一行的 `=`（setext 下划线）必须整块且渲染为公式而非巨型 h1', () => {
  // 真机 demo.md 矩阵乘法公式（2026-10-08 用户截图）：公式内部有一行单独的 `=`，
  // 若切块前未做公式守卫，remark 会把 `=` 当 setext 标题下划线，把公式劈成两块、
  // 前半渲染成一个装着公式源码的巨型 h1。切块必须先经 guardMathBlocks 保护。
  const md = [
    '矩阵乘法：',
    '',
    '$$',
    '\\begin{bmatrix}',
    'a_{11} & a_{12} \\\\',
    'a_{21} & a_{22}',
    '\\end{bmatrix}',
    '=',
    '\\begin{bmatrix}',
    'c_{11} & c_{12} \\\\',
    'c_{21} & c_{22}',
    '\\end{bmatrix}',
    '$$',
    '',
    '结尾段落',
  ].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  // 公式（行 2..12，0-based）必须是【一个】块，不得被 `=` 行劈开
  const mathBlock = blocks.find(b => b.start <= 2 && 2 < b.end);
  assert.ok(mathBlock, '应存在覆盖公式起始行的块');
  assert.strictEqual(mathBlock.start, 2, '公式块应从 `$$` 行开始');
  assert.strictEqual(mathBlock.end, 13, '公式块应吃到闭合 `$$` 行（含），实际 end=' + mathBlock.end);
  assert.doesNotMatch(mathBlock.html, /<h1[\s>]/, '公式块不得渲染出巨型 h1（setext 误判）');
  assert.match(mathBlock.html, /math-display/, '公式块应渲染为展示公式容器');
  // 公式前后的普通块不受影响
  assert.ok(blocks.some(b => /矩阵乘法/.test(b.html)), '公式前段落块应保留');
  assert.ok(blocks.some(b => /结尾段落/.test(b.html)), '公式后段落块应保留');
});
