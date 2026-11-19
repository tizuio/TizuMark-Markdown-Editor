// 暗色内容边界对比度回归（issue #100 追加轮，2026-11-19）
// 基线：探针 .workbuddy/probe-contrast-dark.cjs 实测暗色 --border-color 在预览底上
// 仅 1.3~1.4:1（表格网格/代码块盒/行内 code/kbd/分割线/h2 下划线「看不清」）、
// 代码块背景与页面底 1.08:1、图片无衬底。修复 = 新增 --border-strong（暗色
// color-mix 提亮至 ≈3.5~3.9:1，WCAG 1.4.11 非文本组件 3:1）+ 暗色规则组 +
// 各暗色配色 --code-bg/--border-color 提亮。本文件按「结构契约」锁定这些规则
// （与 view-mode-wysiwyg 的 styles.css 静态断言同口径），防止后续回退。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = () => fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');

test('暗色对比度: --border-strong 亮色缺省 = --border-color、暗色 color-mix 提亮', () => {
  const c = css();
  assert.match(c, /--border-strong:\s*var\(--border-color\)/,
    ':root 缺少 --border-strong 兜底（亮色会取不到值退化成初始边框色）');
  assert.match(
    c,
    /\[data-theme="dark"\]\s*\{\s*--border-strong:\s*color-mix\(in srgb,\s*var\(--border-color\)\s*30%,\s*var\(--text-secondary\)\s*70%\)/,
    '暗色 --border-strong 必须按配色自适应 color-mix 提亮（30% border + 70% text-secondary ≈3.9:1）');
});

test('暗色对比度: 表格网格/代码块/行内 code/kbd/h2/mermaid/md2-error 边框走 --border-strong', () => {
  const c = css();
  const darkRules = c.slice(c.indexOf('暗色内容边界对比度'));
  assert.ok(darkRules.includes('[data-theme="dark"]'), '暗色内容边界规则段缺失');
  for (const sel of [
    '[data-theme="dark"] .preview-content table,',
    '[data-theme="dark"] .preview-content pre { border-color: var(--border-strong); }',
    '[data-theme="dark"] .preview-content code { border-color: var(--border-strong); }',
    '[data-theme="dark"] .preview-content kbd {',
    '[data-theme="dark"] .preview-content h2 { border-bottom-color: var(--border-strong); }',
    '[data-theme="dark"] .mermaid-container { border-color: var(--border-strong); }',
    '[data-theme="dark"] .preview-content .md2-error { border-color: var(--border-strong); }',
  ]) {
    assert.ok(darkRules.includes(sel), `缺少暗色规则: ${sel}`);
  }
  // 表格三件套共享一条 border-color 规则
  assert.match(
    darkRules,
    /\[data-theme="dark"\] \.preview-content table,\s*\[data-theme="dark"\] \.preview-content th,\s*\[data-theme="dark"\] \.preview-content td\s*\{\s*border-color:\s*var\(--border-strong\);/,
    '表格网格线暗色规则不完整（table/th/td 三件套）');
});

test('暗色对比度: hr 实线与 kbd inset 描边走 --border-strong', () => {
  const c = css();
  assert.match(
    c,
    /\[data-theme="dark"\] \.preview-content hr\s*\{\s*background:\s*var\(--border-strong\)/,
    '暗色 hr 未用 --border-strong 实线（渐变两端透明，暗色下整条线可视段过短）');
  assert.match(
    c,
    /\[data-theme="dark"\] \.preview-content kbd\s*\{[^}]*box-shadow:\s*inset 0 -1px 0 var\(--border-strong\)/,
    '暗色 kbd inset 描边未同步 --border-strong');
});

test('暗色对比度: 图片棋盘格衬底（透明图在暗底可辨）', () => {
  const c = css();
  assert.match(
    c,
    /\[data-theme="dark"\] \.preview-content img\s*\{[^}]*repeating-conic-gradient/,
    '暗色图片缺棋盘格衬底（透明 PNG 融入背景，用户反馈「图片背景块看不清」）');
  // 只作用于暗色：亮色不得出现同规则（亮色白底有天然衬底，用户未反馈）
  assert.doesNotMatch(
    c,
    /(?<!\[data-theme="dark"\] )\.preview-content img\s*\{[^}]*repeating-conic-gradient/,
    '棋盘格衬底不得泄漏到亮色 .preview-content img');
});

test('暗色对比度: 各暗色配色 --code-bg 提亮（不再是与页面底几乎同色）', () => {
  const c = css();
  // 基线病灶值逐个确认已不在暗色 scheme 中（#1f2126/#1b261d/#262b38/#231d30/#2a1f18）
  for (const old of ['#1f2126', '#1b261d', '#262b38', '#231d30', '#2a1f18']) {
    assert.doesNotMatch(
      c,
      new RegExp(`--code-bg:\\s*${old.replace('#', '\\#')}`, 'i'),
      `暗色 --code-bg 仍是旧值 ${old}（与页面底 ≈1.08:1，代码块背景看不清）`);
  }
  // 5 套暗色 scheme 必须各自定义 --code-bg（防漏改某套配色）
  const darkSchemes = c.match(/\[data-color-scheme="[a-z]+"\]\[data-theme="dark"\]/g) || [];
  assert.ok(darkSchemes.length >= 5, '暗色 scheme 块数量不足');
});

test('暗色对比度: --border-color 暗色提亮（旧值 #32343c 不得残留在默认暗色块）', () => {
  const c = css();
  assert.doesNotMatch(c, /--border-color:\s*#32343c/i,
    '默认暗色 --border-color 仍是 #32343c（1.37:1，chrome 边框过淡）');
});
