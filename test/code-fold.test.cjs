// 源码模式区块折叠回归：① 纯函数折叠范围（标题/围栏/公式/长段落）② 生产接线静态契约。
// 真实布局与点击交互由 test/browser/code-fold.test.cjs 用系统 Chrome 验证。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FOLD = require('../src/modules/code-fold.js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 模拟 CM5：headers 显式给出「哪些行被 mode 标成 header」（真实环境由
// cm.getTokenTypeAt 返回 "header header-N"），其余行返回 null。
function makeCm(lines, headers = {}) {
  return {
    lines,
    firstLine: () => 0,
    lastLine: () => lines.length - 1,
    getLine: (n) => (lines[n] === undefined ? '' : lines[n]),
    getTokenTypeAt: ({ line }) => (headers[line] ? `header header-${headers[line]}` : null),
  };
}
const at = (line) => ({ line, ch: 0 });

// ---------------- ① 纯函数：标题章节 ----------------
test('折叠范围：一级标题折到下一个同级标题前（含其内部的下级标题）', () => {
  const cm = makeCm(['# A', 'a1', 'a2', '## A.1', 'a3', '# B', 'b1'], { 0: 1, 3: 2, 5: 1 });
  const r = FOLD.rangeFinder(cm, at(0));
  assert.deepStrictEqual(r.from, { line: 0, ch: 3 });
  assert.strictEqual(r.to.line, 4, '应折到下一个一级标题前一行');
});

test('折叠范围：三级标题遇到二级标题即结束，不吞掉上级章节', () => {
  const cm = makeCm(['## A', 'a', '### A.1', 'b', '## B', 'c'], { 0: 2, 2: 3, 4: 2 });
  const r = FOLD.rangeFinder(cm, at(2));
  assert.strictEqual(r.to.line, 3);
});

test('折叠范围：Setext 标题（=== / --- 下划线）按 1/2 级折叠', () => {
  const cm = makeCm(['Title', '=====', 'x', 'y', 'Sub', '-----', 'z'], { 1: 1, 5: 2 });
  const r = FOLD.rangeFinder(cm, at(0));
  assert.ok(r, 'Setext 一级标题应可折叠');
  assert.strictEqual(r.to.line, 6, '二级 Sub 属于一级章节，应一起折进去');
});

test('折叠范围：只有标题行、无正文时不给折叠标记', () => {
  const cm = makeCm(['# A', '# B'], { 0: 1, 1: 1 });
  assert.strictEqual(FOLD.rangeFinder(cm, at(0)), null);
});

test('折叠范围：围栏代码块里的 # 未被 mode 标为 header，不会误折成标题', () => {
  const cm = makeCm(['```', '# not a heading', 'x', '```']);
  assert.strictEqual(FOLD.headingRange(cm, at(1)), null);
});

// ---------------- ② 纯函数：围栏 / 展示公式 ----------------
test('折叠范围：围栏代码块从开栏行折到闭栏行', () => {
  const cm = makeCm(['```js', 'const a = 1;', 'const b = 2;', '```', '正文']);
  const r = FOLD.rangeFinder(cm, at(0));
  assert.strictEqual(r.from.line, 0);
  assert.strictEqual(r.to.line, 3);
});

test('折叠范围：~~~ 围栏只认同种闭栏标记', () => {
  const cm = makeCm(['~~~', 'a', 'b', '```', 'c', '~~~']);
  const r = FOLD.rangeFinder(cm, at(0));
  assert.strictEqual(r.to.line, 5);
});

test('折叠范围：没有闭栏行的围栏不折叠（避免吞掉整篇）', () => {
  const cm = makeCm(['```js', 'a', 'b']);
  assert.strictEqual(FOLD.fenceRange(cm, at(0)), null);
});

test('折叠范围：围栏闭栏行不再挂折叠箭头（否则会吞掉下一个代码块）', () => {
  const cm = makeCm(['```', 'a', '```', '', '```', 'b', '```']);
  assert.ok(FOLD.fenceRange(cm, at(0)), '开栏行应可折叠');
  assert.strictEqual(FOLD.fenceRange(cm, at(2)), null, '第一块的闭栏行不能再折');
  assert.ok(FOLD.fenceRange(cm, at(4)), '第二块的开栏行应可折叠');
  assert.strictEqual(FOLD.fenceRange(cm, at(6)), null);
});

test('折叠范围：展示公式 $$ 块整体折叠', () => {
  const cm = makeCm(['$$', 'E = mc^2', 'x = 1', '$$', '正文']);
  const r = FOLD.rangeFinder(cm, at(0));
  assert.strictEqual(r.from.line, 0);
  assert.strictEqual(r.to.line, 3);
});

// ---------------- ③ 纯函数：连续大段正文 ----------------
test('折叠范围：连续 ≥6 行大段正文可折叠，首行保留', () => {
  const cm = makeCm(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', '', '# H', 'x'], { 8: 1 });
  const r = FOLD.rangeFinder(cm, at(0));
  assert.ok(r, '长段落应有折叠范围');
  assert.deepStrictEqual(r.from, { line: 0, ch: 2 });
  assert.strictEqual(r.to.line, 6);
});

test('折叠范围：不足 6 行的短段落不折叠（避免 gutter 太吵）', () => {
  const cm = makeCm(['p1', 'p2', 'p3', '', 'p4']);
  assert.strictEqual(FOLD.rangeFinder(cm, at(0)), null);
});

test('折叠范围：只在块首行给标记，块内行不再重复挂箭头', () => {
  const cm = makeCm(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.ok(FOLD.rangeFinder(cm, at(0)));
  for (let i = 1; i < 6; i++) assert.strictEqual(FOLD.longBlockRange(cm, at(i), 6), null);
});

test('折叠范围：块内单个空行允许，连续两个空行视为块结束', () => {
  const cm = makeCm(['p1', 'p2', 'p3', '', 'p4', 'p5', 'p6', '', '', 'tail']);
  const r = FOLD.longBlockRange(cm, at(0), 6);
  assert.strictEqual(r.to.line, 6);
});

test('折叠范围：长段落遇到标题/围栏开栏即断开', () => {
  const cm = makeCm(['p1', 'p2', 'p3', '```', 'code', '```', 'p4'], {});
  const r = FOLD.longBlockRange(cm, at(0), 6);
  assert.strictEqual(r, null, '围栏之前的 3 行不足 6 行，不应折叠');
});

test('折叠范围：minLines 可覆盖（自定义阈值入口）', () => {
  const cm = makeCm(['a', 'b', 'c']);
  assert.strictEqual(FOLD.longBlockRange(cm, at(0), 6), null);
  const r = FOLD.longBlockRange(cm, at(0), 3);
  assert.strictEqual(r.to.line, 2);
});

// ---- 2026-11-14 用户截图回归：列表/引用/水平线是结构边界，平级内容不得被吞 ----
test('折叠范围：列表项不再挂长段落箭头，平级内容不被收缩进来（用户截图）', () => {
  // 用户真实场景：## 章节 + 段落 + 5 个空行分隔的列表项 + 段落 + 引用 + --- + 下一个 ##
  const lines = [
    '## 基础文本格式',            // 0  (h2)
    'TizuMark 支持所有 GFM 格式。', // 1
    '',                            // 2
    '- **粗体文本**：说明一',       // 3  列表项
    '',                            // 4
    '- *斜体文本*：说明二',         // 5
    '',                            // 6
    '- ~~删除线~~：说明三',         // 7
    '',                            // 8
    '- `行内代码`：说明四',         // 9
    '',                            // 10
    '- ==高亮标记==：说明五',       // 11
    '',                            // 12
    '上标和下标的说明段落。',        // 13
    '',                            // 14
    '> 引用行说明。',               // 15
    '>',                           // 16
    '---',                         // 17 水平线
    '',                            // 18
    '## 标题层级',                  // 19 (h2)
    '后续内容',                     // 20
  ];
  const cm = makeCm(lines, { 0: 2, 19: 2 });
  for (const i of [3, 5, 7, 9, 11]) {
    assert.strictEqual(FOLD.rangeFinder(cm, at(i)), null, `列表项行 ${i} 不应再有折叠箭头`);
  }
  assert.strictEqual(FOLD.rangeFinder(cm, at(1)), null, '首段正文遇列表应断开（1 行不足阈值）');
  assert.strictEqual(FOLD.rangeFinder(cm, at(13)), null, '引用前的段落遇引用应断开');
  // 标题章节折叠不受影响：仍折到下一个同级标题前，尾部空行裁剪
  const h = FOLD.rangeFinder(cm, at(0));
  assert.ok(h && h.to.line === 17, `标题章节应折到 --- 行（下一个 ## 前），实际 to.line=${h && h.to.line}`);
});

test('折叠范围：列表/引用/水平线之后的纯段落仍可作为新块首', () => {
  const cm = makeCm(['> quote', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], {});
  const r = FOLD.rangeFinder(cm, at(1));
  assert.ok(r && r.to.line === 7, '引用边界之后的连续正文应可折叠');
  const cm2 = makeCm(['p1', 'p2', 'p3', 'p4', 'p5', '- list', 'p6'], {});
  assert.strictEqual(FOLD.longBlockRange(cm2, at(0), 6), null, '扫描遇列表即断开：5 行不足阈值');
});

// ---- 2026-11-14 代码审查回归：围栏/公式内部行不得按长段落挂箭头 ----
test('折叠范围：代码块内部行不挂长段落箭头（开栏后首行）', () => {
  const cm = makeCm(['```js', 'const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'const f = 6;', '```', '']);
  assert.strictEqual(FOLD.rangeFinder(cm, at(1)), null, '代码块内首行不应有块内箭头');
  assert.strictEqual(FOLD.rangeFinder(cm, at(3)), null, '代码块内任意行不应有箭头');
  assert.ok(FOLD.rangeFinder(cm, at(0)), '开栏行本身仍应折叠整块');
});

test('折叠范围：代码块内空行后的正文也不挂箭头', () => {
  const cm = makeCm(['```', 'a', 'b', 'c', '', 'd', 'e', 'f', 'g', 'h', '```', '']);
  assert.strictEqual(FOLD.rangeFinder(cm, at(5)), null, '块内空行后的正文仍在块内，不挂箭头');
});

test('折叠范围：展示公式内部行不挂长段落箭头', () => {
  const cm = makeCm(['$$', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', '$$', '']);
  assert.strictEqual(FOLD.rangeFinder(cm, at(1)), null, '公式内首行不应有箭头');
  assert.ok(FOLD.rangeFinder(cm, at(0)), '公式开栏行本身仍应折叠整块');
});

test('折叠范围：未闭合围栏内的行一律不挂箭头', () => {
  const cm = makeCm(['```', 'a', 'b', 'c', '', 'd', 'e', 'f', 'g', 'h']);
  for (let i = 1; i <= 9; i++) assert.strictEqual(FOLD.rangeFinder(cm, at(i)), null, `未闭合围栏内行 ${i} 不应有箭头`);
  assert.strictEqual(FOLD.rangeFinder(cm, at(0)), null, '未闭合的开栏行也不折叠');
});

test('折叠范围：闭栏行之后的正文仍可作为新块首（开/闭栏区分）', () => {
  const cm = makeCm(['```', 'a', 'b', '```', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', '']);
  const r = FOLD.rangeFinder(cm, at(4));
  assert.ok(r && r.to.line === 10, '闭栏后的连续正文应可折叠');
});

// ---- 2026-11-14 用户截图回归：表格是结构块，每张表都有折叠箭头（不看行数）----
// 用户场景：基础表格 11 行有箭头（被「≥6 行长段落」规则碰巧盖到）、对齐表格 5 行
// 没有箭头 → 同一文档两张表行为不一致。修复后表格整表折叠、与行数无关。
test('折叠范围：GFM 表格整表折叠（5 行小表与 11 行大表行为一致）', () => {
  const big = [
    '### 基础表格',                                  // 0
    '',                                              // 1
    '| 特性 | 说明 | 状态 |',                         // 2  表头
    '| --- | --- | --- |',                            // 3  分隔行
    '| 实时预览 | 编辑时即时渲染 | 已支持 |',          // 4
    '| 多标签页 | 同时编辑多个文件 | 已支持 |',        // 5
    '| 智能大纲 | 标题导航一键跳转 | 已支持 |',        // 6
    '| 流程图 | Mermaid 图表渲染 | 已支持 |',          // 7
    '| 数学公式 | KaTeX 渲染引擎 | 已支持 |',          // 8
    '| macOS 版 | 原生 macOS 适配 | 即将推出 |',       // 9
    '| 移动端 | iOS / Android | 计划中 |',            // 10
    '',                                              // 11
    '### 对齐表格',                                  // 12
    '',                                              // 13
    '| 左对齐（默认） | 居中对齐 | 右对齐 |',          // 14 表头
    '|:---|:---:|---:|',                              // 15 分隔行（带对齐冒号）
    '| TizuMark | 轻量级 | 最快 |',                   // 16
    '| 实时预览 | 流畅输入 | 极速 |',                  // 17
    '| 原生性能 | Rust 引擎 | <50MB |',                // 18
  ];
  const cm = makeCm(big, { 0: 3, 12: 3 });
  const r1 = FOLD.rangeFinder(cm, at(2));
  assert.ok(r1 && r1.to.line === 10, `大表应折到最后一行数据（实际 to.line=${r1 && r1.to.line}）`);
  assert.deepStrictEqual(r1.from, { line: 2, ch: 16 }, '表头行保留可见（from 在表头行尾）');
  const r2 = FOLD.rangeFinder(cm, at(14));
  assert.ok(r2 && r2.to.line === 18, '小表（5 行）也应有整表折叠箭头');
  assert.strictEqual(FOLD.rangeFinder(cm, at(3)), null, '分隔行不是表格起点');
  assert.strictEqual(FOLD.rangeFinder(cm, at(4)), null, '数据行不是表格起点');
});

test('折叠范围：孤立 | 行（无分隔行）不是表格，不折叠', () => {
  const cm = makeCm(['| 只有这一行 |', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.strictEqual(FOLD.rangeFinder(cm, at(0)), null, '无分隔行不算表格');
  assert.strictEqual(FOLD.longBlockRange(cm, at(0), 6), null, '表格行也不当长段落块首');
});

test('折叠范围：表格行是长段落扫描边界，前后正文各自独立折叠', () => {
  const cm = makeCm(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', '| a | b |', '| --- |', '', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']);
  const before = FOLD.rangeFinder(cm, at(0));
  assert.ok(before && before.to.line === 5, '表格前的正文折到表格前，不跨表');
  const after = FOLD.rangeFinder(cm, at(9));
  assert.ok(after && after.to.line === 15, '表格（含空行）后的正文仍可作为新块首');
});

test('折叠范围：代码块里的表格由围栏规则负责，不重复挂箭头', () => {
  const cm = makeCm(['```markdown', '| a | b |', '| --- |', '| 1 | 2 |', '| 3 | 4 |', '```', '']);
  assert.strictEqual(FOLD.rangeFinder(cm, at(1)), null, '围栏内的表格行不应有箭头');
  assert.ok(FOLD.rangeFinder(cm, at(0)), '围栏开栏行折叠整块');
});

// ---------------- ④ 生产接线静态契约 ----------------
test('接线：index.html 按序加载 fold addon 与 code-fold.js（在 editor-core 之前）', () => {
  const html = read('src/index.html');
  const iCode = html.indexOf('addon/fold/foldcode.js');
  const iGutter = html.indexOf('addon/fold/foldgutter.js');
  const iModule = html.indexOf('src="modules/code-fold.js"');
  const iCore = html.indexOf('src="modules/editor-core.js"');
  assert.ok(iCode > 0 && iGutter > iCode, 'foldcode 必须先于 foldgutter');
  assert.ok(iModule > iGutter && iModule < iCore, 'code-fold.js 必须在 editor-core.js 之前');
});

test('接线：editor-core 把 TMCodeFold.rangeFinder 写进 foldOptions，且 gutterClick 放行折叠槽', () => {
  const src = read('src/modules/editor-core.js');
  assert.match(src, /foldOptions: window\.TMCodeFold \? \{[\s\S]{0,200}rangeFinder: window\.TMCodeFold\.rangeFinder/,
    'CM 初始化未固化自定义折叠范围函数');
  assert.match(src, /minFoldSize: 1/, '应至少 2 行才折叠');
  assert.match(src, /if \(gutter === 'CodeMirror-foldgutter'\) return;/,
    '行号点击选行必须放行折叠槽，否则点箭头会同时选中整行');
  for (const m of ['_syncCodeFolding()', '_clearAllFolds(cm)', 'toggleFoldAtCursor()',
    'unfoldAtCursor()', 'foldAllBlocks()', 'unfoldAllBlocks()']) {
    assert.ok(src.includes(m), `editor-core 缺方法 ${m}`);
  }
  assert.match(src, /_syncCodeFolding\(\)[\s\S]{0,500}this\._clearAllFolds\(cm\)/,
    '离开源码模式必须展开所有折叠（WYSIWYG 遮罩依赖真实行高）');
  assert.match(src, /_clearAllFolds\(cm\)[\s\S]{0,300}getAllMarks\(\)[\s\S]{0,160}__isFold/,
    '_clearAllFolds 必须按 __isFold 标记清掉折叠 mark');
});

test('接线：视图切换 / 设置应用都会同步折叠槽，且有设置开关', () => {
  assert.match(read('src/modules/theme.js'), /applyViewMode\(\)[\s\S]{0,1500}this\._syncCodeFolding\(\);/);
  const settings = read('src/modules/settings.js');
  assert.match(settings, /codeFolding: true/, '默认应开启源码折叠');
  assert.ok(settings.includes("getElementById('set-code-folding').checked"), '设置面板未回填');
  assert.ok(settings.includes('this.settings.codeFolding = e.target.checked'), '设置面板未写入');
  assert.match(settings, /if \(this\._syncCodeFolding\) this\._syncCodeFolding\(\);/, 'applySettings 未即时同步');
  assert.ok(read('src/index.html').includes('id="set-code-folding"'), '设置面板缺开关 DOM');
  const i18n = read('src/modules/i18n.js');
  assert.ok(i18n.includes("setRowLabel('set-code-folding', t('codeFolding'))"), '设置项未接 i18n');
  const dict = read('src/modules/i18n-data.js');
  assert.strictEqual((dict.match(/codeFolding: '/g) || []).length, 3, '三语文案不齐');
});

test('接线：4 个折叠快捷键登记、派发与方括号键归一化', () => {
  const src = read('src/modules/shortcuts.js');
  for (const [id, key] of [['foldBlock', 'Ctrl+Shift+['], ['unfoldBlock', 'Ctrl+Shift+]'],
    ['foldAll', 'Ctrl+Alt+['], ['unfoldAll', 'Ctrl+Alt+]']]) {
    assert.ok(src.includes(`${id}: { key: '${key}'`), `${id} 默认键位缺失`);
    assert.ok(src.includes(`${id}: () => this.`), `${id} 未接 editorMap`);
  }
  assert.match(src, /e\.code === 'BracketLeft'\) baseKey = '\['/,
    'Shift+[ 的 e.key 是 {，不按物理键位归一化会匹配不上快捷键');
  assert.match(src, /e\.code === 'BracketRight'\) baseKey = '\]'/);
  assert.match(src, /'foldBlock', 'unfoldBlock', 'foldAll', 'unfoldAll'/, '快捷键面板分组未收录');
  assert.match(read('scripts/check-globals.cjs'), /'TMCodeFold'/, '全局导出白名单未登记');
});

// ---------------- ⑤ 展开折叠符号统一 + 折叠态视觉（2026-11-14） ----------------
test('统一 disclosure：文件目录 / 大纲 / CodeMirror 折叠槽同款 chevron，无小三角', () => {
  const css = read('src/styles.css');
  const filesSrc = read('src/modules/files.js');
  const outlineSrc = read('src/modules/outline.js');

  // 单一来源：CSS mask 的 data URI 与两处内联 SVG 都用同一条 Lucide chevron-right
  assert.match(css, /--tm-disclosure:\s*url\([^)]*m9 18 6-6-6-6/, '折叠槽 mask 应使用文件目录同款 chevron-right');
  const treeChevron = filesSrc.match(/const CHEVRON = '([^']+)';/);
  const outlineChevron = outlineSrc.match(/const DISCLOSURE = '([^']+)';/);
  assert.ok(treeChevron && outlineChevron, '两处内联 SVG 常量都应存在');
  assert.strictEqual(outlineChevron[1], treeChevron[1], '大纲必须与文件目录使用完全相同的 SVG');
  assert.ok(outlineChevron[1].includes('fill="none"') && outlineChevron[1].includes('stroke="currentColor"'),
    '必须是描边线性 chevron，不得是实心小三角');
  assert.ok(!outlineSrc.includes('M1.5 4 L10.5 4 L6 8 Z'), '大纲不得残留旧实心等腰三角路径');
  assert.ok(!css.includes("content: '\\25BE'") && !css.includes("content: '\\25B8'"),
    'CodeMirror 折叠槽不得再用字符小三角');

  // 旋转语义：展开 = 向下（90deg），折叠 = 向右（0deg），三处一致
  assert.match(css, /\.CodeMirror-foldgutter-open::after,\s*\.CodeMirror-foldgutter-folded::after\s*\{[\s\S]{0,600}-webkit-mask:\s*var\(--tm-disclosure\)/,
    '折叠槽箭头应走 mask 变量并继承 currentColor');
  assert.match(css, /\.CodeMirror-foldgutter-open::after\s*\{\s*transform:\s*rotate\(90deg\);\s*\}/,
    '可折叠箭头应向下');
  assert.match(css, /\.CodeMirror-foldgutter-folded::after\s*\{\s*transform:\s*rotate\(0deg\);\s*\}/,
    '已折叠箭头应向右');
  assert.match(css, /\.outline-toggle svg\s*\{[\s\S]{0,400}transform:\s*rotate\(90deg\)/,
    '大纲展开态箭头应向下');
  assert.match(css, /\.outline-toggle\.collapsed svg\s*\{[\s\S]{0,120}transform:\s*rotate\(0deg\)/,
    '大纲折叠态箭头应向右');
});

test('折叠占位：主题色胶囊 + 折叠行数三语，折叠行有明显底色与竖条', () => {
  const css = read('src/styles.css');
  const core = read('src/modules/editor-core.js');
  const dict = read('src/modules/i18n-data.js');
  assert.match(core, /widget:\s*\(from, to\)\s*=>/, 'widget 必须是函数才能拿到折叠行数');
  assert.ok(core.includes("this.t('foldedLines', { n })"), '折叠行数应走 i18n');
  assert.strictEqual((dict.match(/foldedLines: '/g) || []).length, 3, '折叠行数三语文案不齐');
  assert.match(css, /\.CodeMirror-foldmarker\s*\{[\s\S]{0,600}border:\s*1px solid var\(--accent-color\)[\s\S]{0,400}background:\s*var\(--accent-subtle\)/,
    '折叠占位应是主题色描边 + 淡主题底');
  assert.ok(css.includes('.tm-fold-chevron'), '折叠占位应带 chevron 图标');
  assert.match(css, /\.CodeMirror-code > div:has\(\.CodeMirror-foldmarker\)\s*\{[\s\S]{0,300}box-shadow:\s*inset 3px 0/,
    '折叠所在行必须有淡底与左侧竖条（且不用 border/padding 改行高）');
});
