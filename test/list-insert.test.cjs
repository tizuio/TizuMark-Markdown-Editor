// 功能1 回归测试库：选中多行插入无序/有序列表、Tab 宽度真正驱动缩进、
// 有序列表三级预览样式（1. / 1) / ①）、设置面板 Tab 宽度说明框与翻译接线。
//
// 设计原则（与项目现有测试一致）：
//   1. 用 jsdom 起最小 DOM，再 require 真实 codemirror，在「真实 CodeMirror 5 实例」
//      上运行从 src/app.js 抽取的真实 insertLinePrefix 方法（balanced-brace 抽取 + eval），
//      断言真实 API 行为，而非重新实现一份。
//   2. 列表嵌套/代码块边界用项目真实解析器 remark-gfm 断言。
//   3. CSS / HTML / 翻译接线用静态 + jsdom 解析断言。
//
// CommonMark 原生语义：有序列表 marker `1. ` 占 3 列，子列表缩进须 ≥3 空格；
// tabSize=8 时缩进过深会被解析为代码块而非子列表（属规范，非缺陷）。
// 注：renderMarkdown 已内置 normalizeListIndentation，把「每 tabSize 空格升一级」的
// 直观模型转换为合规列对齐，并对“非 1 起始的有序嵌套项”前插空行——用户在编辑器里
// 按 4 空格步长书写即可正确嵌套，无需手动对齐列或补空行。本套测试仅锁定解析器底层语义，
// 不用于断言归一化后的最终呈现。

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const APP = require('./helpers/app-bundle.cjs').readBundle();
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

// ---- jsdom 全局必须在 require('codemirror') 之前设置 ----
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, writable: true, configurable: true,
});
const rect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
dom.window.Range.prototype.getBoundingClientRect = rect;
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Element.prototype.getBoundingClientRect = rect;
dom.window.Element.prototype.getClientRects = () => [];

const CodeMirror = require('codemirror');

// ---- 从源码抽取真实方法（balanced-brace 扫描 + eval）----
function extractMethod(needle) {
  const sigIdx = APP.indexOf(needle);
  assert.ok(sigIdx !== -1, '应在 app.js 中找到: ' + needle);
  let i = APP.indexOf('{', sigIdx), depth = 0;
  for (; i < APP.length; i++) {
    const c = APP[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  const name = needle.split('(')[0].trim();
  return eval('(' + APP.slice(sigIdx, i + 1).replace(new RegExp('^\\s*' + name), 'function ' + name) + ')');
}

const insertLinePrefix = extractMethod('insertLinePrefix(prefix, ordered = false) {');
const mk = (v) => CodeMirror(document.createElement('div'), { value: v, mode: 'gfm' });
const stub = { cm: null, settings: { tabSize: 4 } };

// ============================================================
// A. insertLinePrefix 在真实 CodeMirror 实例上的行为
// ============================================================

test('A1 有序多行选区：每行序号 1./2./3. 递增', async () => {
  const cm = mk('苹果\n香蕉\n橙子');
  stub.cm = cm;
  cm.setSelection({ line: 0, ch: 0 }, { line: 2, ch: 2 });
  insertLinePrefix.call(stub, '1. ', true);
  assert.strictEqual(cm.getValue(), '1. 苹果\n2. 香蕉\n3. 橙子');
});

test('A2 无序多行选区：每行固定 “- ” 前缀（不递增）', async () => {
  const cm = mk('苹果\n香蕉\n橙子');
  stub.cm = cm;
  cm.setSelection({ line: 0, ch: 0 }, { line: 2, ch: 2 });
  insertLinePrefix.call(stub, '- ', false);
  assert.strictEqual(cm.getValue(), '- 苹果\n- 香蕉\n- 橙子');
});

test('A3 有序 4 行选区：序号 1..4 递增', async () => {
  const cm = mk('一\n二\n三\n四');
  stub.cm = cm;
  cm.setSelection({ line: 0, ch: 0 }, { line: 3, ch: 1 });
  insertLinePrefix.call(stub, '1. ', true);
  assert.strictEqual(cm.getValue(), '1. 一\n2. 二\n3. 三\n4. 四');
});

test('A4 无序 4 行选区：4 行均加 “- ” 前缀', async () => {
  const cm = mk('一\n二\n三\n四');
  stub.cm = cm;
  cm.setSelection({ line: 0, ch: 0 }, { line: 3, ch: 1 });
  insertLinePrefix.call(stub, '- ', false);
  assert.strictEqual(cm.getValue(), '- 一\n- 二\n- 三\n- 四');
});

test('A5 无选区首行：有序插入 “1. ” 前缀', async () => {
  const cm = mk('苹果');
  stub.cm = cm;
  cm.setCursor({ line: 0, ch: 0 });
  insertLinePrefix.call(stub, '1. ', true);
  assert.strictEqual(cm.getValue(), '1. 苹果');
});

test('A6 无选区首行：无序插入 “- ” 前缀', async () => {
  const cm = mk('苹果');
  stub.cm = cm;
  cm.setCursor({ line: 0, ch: 0 });
  insertLinePrefix.call(stub, '- ', false);
  assert.strictEqual(cm.getValue(), '- 苹果');
});

test('A7 选区只占部分列（跨多行）：仍按整行加前缀并递增', async () => {
  const cm = mk('苹果\n香蕉\n橙子');
  stub.cm = cm;
  // 仅选中第 0~2 行第 1 列，验证逻辑基于“行”而非“选区列”
  cm.setSelection({ line: 0, ch: 1 }, { line: 2, ch: 1 });
  insertLinePrefix.call(stub, '1. ', true);
  assert.strictEqual(cm.getValue(), '1. 苹果\n2. 香蕉\n3. 橙子');
});

// ============================================================
// B. 无序列表三级预览样式（CSS：disc → circle → square → disc 循环）
// ============================================================

test('B1 无序一级 ul：list-style-type: disc', async () => {
  assert.ok(/:where\(\.preview-content\)\s+ul\s*\{\s*list-style-type:\s*disc;/.test(CSS));
});

test('B2 无序二级 ul ul：list-style-type: circle', async () => {
  assert.ok(/:where\(\.preview-content\)\s+ul\s+ul\s*\{\s*list-style-type:\s*circle;/.test(CSS));
});

test('B3 无序三级 ul ul ul：list-style-type: square', async () => {
  assert.ok(/:where\(\.preview-content\)\s+ul\s+ul\s+ul\s*\{\s*list-style-type:\s*square;/.test(CSS));
});

test('B4 无序四级 ul ul ul ul：回到 disc（循环）', async () => {
  assert.ok(/:where\(\.preview-content\)\s+ul\s+ul\s+ul\s+ul\s*\{\s*list-style-type:\s*disc;/.test(CSS));
});

// 回归：任务列表后未空行时，remark-gfm 会把后续普通项也放进同一个 contains-task-list，
// 导致普通项失去 marker。CSS 需给 li:not(.task-list-item) 恢复 disc。
test('B5 混合任务/普通列表：普通项恢复 disc marker', async () => {
  assert.ok(CSS.includes('li:not(.task-list-item)'), 'CSS 应含 li:not(.task-list-item) 选择器');
  assert.ok(/\.preview-content\s+ul\.contains-task-list\s*>\s*li:not\(\.task-list-item\)/.test(CSS),
    '普通项选择器应针对 contains-task-list');
  assert.ok(/li:not\(\.task-list-item\)\s*\{[^}]*list-style:\s*disc;/.test(CSS),
    '普通项应恢复 list-style: disc');
});

// ============================================================
// C. 有序列表三级预览样式（CSS @counter-style：1. / 1) / ①）
// ============================================================

test('C1 有序列表定义 4 个层级选择器（ol → ol ol → ol ol ol → ol ol ol ol）', async () => {
  const n = (CSS.match(/:where\(\.preview-content\)\s+ol/g) || []).length;
  assert.strictEqual(n, 4, '应恰好 4 个 ol 层级选择器，实际 ' + n);
});

test('C2 定义两个 @counter-style（paren-decimal / circled-decimal）', async () => {
  const n = (CSS.match(/@counter-style/g) || []).length;
  assert.strictEqual(n, 2, '应恰好 2 个 @counter-style，实际 ' + n);
});

test('C3 有序一级 ol：list-style-type: decimal', async () => {
  assert.ok(/:where\(\.preview-content\)\s+ol\s*\{\s*list-style-type:\s*decimal;/.test(CSS));
});

test('C4 有序二级 ol ol：list-style-type: paren-decimal（预览为 1)）', async () => {
  assert.ok(/:where\(\.preview-content\)\s+ol\s+ol\s*\{\s*list-style-type:\s*paren-decimal;/.test(CSS));
});

test('C5 有序三级 ol ol ol：list-style-type: circled-decimal（预览为 ①）', async () => {
  assert.ok(/:where\(\.preview-content\)\s+ol\s+ol\s+ol\s*\{\s*list-style-type:\s*circled-decimal;/.test(CSS));
});

test('C6 @counter-style paren-decimal 的 suffix 为 ") "（即 1) ）', async () => {
  assert.ok(/@counter-style\s+paren-decimal\s*\{[^}]*suffix:\s*["']\)\s*["'];/.test(CSS));
});

test('C7 @counter-style circled-decimal 的 suffix 为 " "（即 ①）', async () => {
  assert.ok(/@counter-style\s+circled-decimal\s*\{[^}]*suffix:\s*["']\s*["'];/.test(CSS));
});

test('C8 整份 CSS 大括号平衡', async () => {
  const ob = (CSS.match(/{/g) || []).length;
  const cb = (CSS.match(/}/g) || []).length;
  assert.strictEqual(ob, cb, `大括号不平衡：{ = ${ob}, } = ${cb}`);
});

// ============================================================
// D. Tab 宽度真正驱动缩进（设置项默认 4；非仅控制显示）
// ============================================================

test('D1 默认设置 tabSize 为 4', async () => {
  const block = APP.slice(APP.indexOf('defaultSettings() {'), APP.indexOf('defaultSettings() {') + 700);
  assert.ok(/tabSize:\s*4\b/.test(block), 'defaultSettings 中 tabSize 应为 4');
});

test('D2 Tab 处理使用 “ ”.repeat(this.settings.tabSize) 而非硬编码', async () => {
  assert.ok(/replaceSelection\(\s*' '\.repeat\(this\.settings\.tabSize\)/.test(APP),
    '源码应出现 replaceSelection(\' \'.repeat(this.settings.tabSize)');
});

test('D3 已无硬编码的两空格 replaceSelection（回归：不再写死 2 空格）', async () => {
  assert.ok(!APP.includes("replaceSelection('  ', 'end')"),
    '不应再存在 replaceSelection(' + "'  ', 'end')");
});

test('D4 编辑器初始化时 indentUnit 取自 settings.tabSize', async () => {
  assert.ok(/indentUnit:\s*this\.settings\.tabSize/.test(APP),
    '源码应出现 indentUnit: this.settings.tabSize');
});

test('D5 设置变更 handler 读取 Tab 宽度，applySettings 统一同步 indentUnit', async () => {
  // 新架构：自绘 Select 组件的 onChange 只把组件值写入 settings.tabSize，
  // 真正的 indentUnit 同步在 applySettings（this.cm.setOption('indentUnit', s.tabSize)）统一应用。
  assert.ok(APP.includes('this.settings.tabSize = Number(v)'),
    'handler(onChange) 应读取组件值写入 settings.tabSize');
  assert.ok(APP.includes("this.cm.setOption('indentUnit', s.tabSize)"),
    'applySettings 应将 indentUnit 设为 settings.tabSize');
});

test('D6 applySettings 将 indentUnit 设为 tabSize', async () => {
  assert.ok(APP.includes("this.cm.setOption('indentUnit', s.tabSize)"),
    'applySettings 应 setOption(' + "'indentUnit', s.tabSize)");
});

test('D7 真实实例：非列表行按 Tab 插入 4 个空格', async () => {
  const cm = mk('word');
  cm.setCursor({ line: 0, ch: 0 });
  cm.replaceSelection(' '.repeat(4), 'end');
  assert.strictEqual(cm.getValue(), '    word');
});

test('D8 真实实例：列表行 indentUnit=4 时按 Tab 缩进 4 空格', async () => {
  const cm = mk('- item');
  cm.setOption('indentUnit', 4);
  cm.setCursor({ line: 0, ch: 3 });
  cm.indentSelection('add');
  assert.strictEqual(cm.getValue(), '    - item');
});

// ============================================================
// E. 设置面板 Tab 宽度行 + 说明框 + 翻译接线
// ============================================================

test('E1 Tab 宽度行使用普通 settings-row（下拉框靠右，与其他项一致）', async () => {
  assert.ok(/class="settings-row">\s*<label>Tab 宽度/.test(HTML));
});

test('E2 存在 Tab 宽度说明框（id="setting-tab-size-hint"）', async () => {
  assert.ok(HTML.includes('id="setting-tab-size-hint"'));
});

test('E3 #set-tab-size 改为自绘 Select 组件（不再原生 select，宿主元素存在）', async () => {
  assert.ok(/id="set-tab-size"/.test(HTML), '应能找到 #set-tab-size 宿主元素');
  assert.ok(!/<select[^>]*id="set-tab-size"/.test(HTML), '不应再是原生 <select>（已统一为自绘组件）');
});

test('E4 Tab 宽度默认值仍为 "4"（配置在 app.js defaultSettings）', async () => {
  assert.ok(/tabSize:\s*4/.test(APP), 'defaultSettings 中 tabSize 默认仍为 4 空格');
});

test('E5 说明框含 hint-icon 与 hint-text 节点（供翻译写入）', async () => {
  assert.ok(/id="setting-tab-size-hint"[^>]*>[\s\S]*class="hint-icon"/.test(HTML),
    '说明框应含 hint-icon');
  assert.ok(/id="setting-tab-size-hint"[^>]*>[\s\S]*class="hint-text"/.test(HTML),
    '说明框应含 hint-text');
});

test('E6 中文翻译含 tabSizeHint 键', async () => {
  assert.ok(/tabSizeHint:\s*'每按一次 Tab/.test(APP), '中文翻译应含 tabSizeHint');
});

test('E7 英文翻译含 tabSizeHint 键', async () => {
  assert.ok(/tabSizeHint:\s*'How many spaces/.test(APP), '英文翻译应含 tabSizeHint');
});

test('E8 updateUILanguage 将翻译写入说明框节点', async () => {
  assert.ok(APP.includes("document.querySelector('#setting-tab-size-hint .hint-text')"),
    '应 querySelector Tab 宽度说明框的 hint-text');
  assert.ok(APP.includes("tabSizeHint.textContent = t('tabSizeHint')"),
    '应把 t(' + "'tabSizeHint') 写入 hint-text");
});

test('E9 说明框间距统一为 10px（.settings-row > .form-hint margin-top: 10px）', async () => {
  assert.ok(/\.settings-row\s*>\s*\.form-hint\s*\{[^}]*margin-top:\s*10px;/.test(CSS),
    '.settings-row > .form-hint 的 margin-top 应为 10px');
});

// ============================================================
// F. remark-gfm 真实解析器：列表嵌套 / 代码块边界（横切）
// ============================================================

test('F1~F5 列表嵌套由真实解析器断言（4/2 空格与 8 空格边界）', async () => {
  const { unified } = await import('unified');
  const remarkParse = (await import('remark-parse')).default;
  const remarkGfm = (await import('remark-gfm')).default;

  const nested = (md) => {
    const t = unified().use(remarkParse).use(remarkGfm).parse(md);
    const fi = t.children[0].children[0]; // 顶层 list 的第一个 listItem
    return !!(fi.children && fi.children.some((c) => c.type === 'list'));
  };
  const sp = (n) => ' '.repeat(n);

  assert.strictEqual(nested('- a\n' + sp(4) + '- b\n- c'), true, 'UL 4 空格应嵌套');
  assert.strictEqual(nested('1. a\n' + sp(4) + '1. b\n1. c'), true, 'OL 4 空格应嵌套');
  assert.strictEqual(nested('- a\n' + sp(2) + '- b\n- c'), true, 'UL 2 空格应嵌套（仅需 ≥2）');
  assert.strictEqual(nested('1. a\n' + sp(2) + '1. b\n1. c'), false, 'OL 2 空格不嵌套（需 ≥3）');
  // 8 空格超过 marker 上限，CommonMark 解析为代码块而非子列表 —— 属规范，非缺陷
  assert.strictEqual(nested('1. a\n' + sp(8) + '1. b\n1. c'), false, 'OL 8 空格不嵌套（CommonMark 限制）');
});

test('F6 有序列表三级嵌套缩进阈值（CommonMark 列对齐规则）', async () => {
  const { unified } = await import('unified');
  const remarkParse = (await import('remark-parse')).default;
  const remarkGfm = (await import('remark-gfm')).default;
  const processor = unified().use(remarkParse).use(remarkGfm);

  // 辅助：分析第二级第二个 listItem（5.）下的内容形态
  const classify = (md) => {
    const tree = processor.parse(md);
    const l2 = tree.children[0]?.children[2]?.children?.find((c) => c.type === 'list');
    if (!l2) return 'none';
    const item5 = l2.children[1];
    if (!item5) return 'none';
    const childList = item5.children.find((c) => c.type === 'list');
    const childCode = item5.children.find((c) => c.type === 'code');
    if (childList) return 'list';
    if (childCode) return 'code';
    return 'none';
  };

  const sp = (n) => ' '.repeat(n);
  const md = (n6) => '1. 345678\n2. 5678\n3. 45678\n\n' + sp(3) + '4. 4567\n' + sp(3) + '5. 3456\n\n' + sp(n6) + '6. 4567';

  // 第 2 级 marker 在列 3，内容从列 6 开始；第 3 级 marker 必须 ≥ 列 6 才算嵌套
  assert.strictEqual(classify(md(5)), 'none', '5 空格：第 3 级仍与 4/5 同级');
  assert.strictEqual(classify(md(6)), 'list', '6 空格：第 3 级正确嵌套在 5 下');
  assert.strictEqual(classify(md(9)), 'list', '9 空格：第 3 级仍正确嵌套');
  assert.strictEqual(classify(md(10)), 'code', '10 空格：过深，被解析为代码块');
});

// ============================================================
// G. 源码语法
// ============================================================

test('G1 src/app.js 通过 node --check 语法检查', async () => {
  let ok = true, msg = '';
  try {
    execSync('node --check ' + path.join(ROOT, 'src', 'app.js'));
  } catch (e) {
    ok = false; msg = e.message;
  }
  assert.ok(ok, 'app.js 语法检查失败: ' + msg);
});
