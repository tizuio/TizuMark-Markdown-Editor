// 删除线误触发 + 编辑器行内格式 token 中和 回归测试库（2026-11-15）。
//
// 两个修复、三层断言：
//   A. vendor 补丁①「恰好 2 波浪才触发删除线」：markdown 模式 strike 分支曾用
//      eatWhile 吞掉整串波浪，标题「## 8. 波浪线围栏 ~~~（xxx）」的 3 连波浪后跟
//      非空白 → 误开删除线，把到行尾全部文字划掉。补丁在 scripts/ensure-vendor.mjs
//      applyTizuMarkMarkdownModePatch（vendor 副本 src/lib/codemirror 不进 git，
//      再生后自动重打）。
//   B. vendor 补丁②「行内代码独立 token」：getType 行内分支读
//      tokenTypeOverrides.codeInline（缺省仍 tokenTypes.code），使 editor-core.js
//      可单独把行内代码中和为纯文本，缩进代码块 / 无高亮围栏体的 code(comment)
//      不受影响。
//   C. editor-core.js tokenTypeOverrides { em/strong/strikethrough/codeInline →
//      'plain' }：编辑器只显示源码，不显示粗体/斜体/删除线/行内代码的格式化外观
//      （用户 2026-11-15 明确要求；标题/引用/链接等结构性 token 保留）。
//
// 行为断言在「真实 CodeMirror 5 实例」上运行：jsdom 起最小 DOM + Module._resolveFilename
// 钩子把 gfm/markdown/overlay 的 '../../lib/codemirror' 相对 require 重定向到
// src/lib/codemirror（应用实际加载、含补丁的 vendor 副本），require 真实模式驱动
// getTokenAt。静态断言守卫 ensure-vendor 补丁重打步骤与 editor-core 配置。

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const CM = path.join(ROOT, 'src', 'lib', 'codemirror');
const VENDOR_MD = path.join(CM, 'mode', 'markdown', 'markdown.js');
const ECORE = path.join(ROOT, 'src', 'modules', 'editor-core.js');
const ENSURE = path.join(ROOT, 'scripts', 'ensure-vendor.mjs');

// 补丁 marker（与 ensure-vendor.mjs 中的 marker 严格一致）
const MARKER_STRIKE = '// TizuMark 补丁（2026-11-15 删除线误触发修复）';
const MARKER_CODEINLINE = 'modeCfg.tokenTypeOverrides && modeCfg.tokenTypeOverrides.codeInline';

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

// vendor 模式文件保留 npm 相对 require（'../../lib/codemirror'）→ 挂解析钩子重定向
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  // vendor 模式/addon 里的 npm 相对 require（核心在 src/lib/codemirror/codemirror.js，
  // 无 lib/ 子目录）→ 全部重定向；xml→meta 的 '../lib/codemirror' 同理
  if (request === '../../lib/codemirror' || request === '../lib/codemirror') return path.join(CM, 'codemirror.js');
  return origResolve.call(this, request, ...args);
};

const CodeMirror = require(path.join(CM, 'codemirror.js'));
// 显式加载应用实际使用的模式链（markdown 直驱 + gfm 走 editor-core 同款配置）：
// vendor 文件保留 npm 相对 require，'../../lib/codemirror' 由上方钩子重定向；
// gfm 内部再 require ../markdown/markdown 与 ../../addon/mode/overlay（均在 src/lib 内可解析）
require(path.join(CM, 'addon', 'mode', 'overlay.js'));
require(path.join(CM, 'mode', 'markdown', 'markdown.js'));
require(path.join(CM, 'mode', 'gfm', 'gfm.js'));

// 逐 token 收集一行的全部 token type（去重）
function lineTokenTypes(cm, n) {
  const line = cm.getLine(n);
  const types = new Set();
  let pos = 0, guard = 0;
  while (pos <= line.length && guard++ < 500) {
    const t = cm.getTokenAt({ line: n, ch: pos });
    if (t.type) t.type.split(/\s+/).forEach((s) => types.add(s));
    pos = Math.max(pos + 1, t.end);
  }
  return types;
}

function makeCm(value, modeCfg) {
  return CodeMirror(document.createElement('div'), { value, mode: modeCfg });
}

// ============================================================
// A. vendor 补丁①：恰好 2 波浪才触发删除线（markdown 模式直驱，strikethrough: true）
// ============================================================

test('A1 标题行 ~~~（ 三连波浪不再误开删除线（用户截图场景）', () => {
  const cm = makeCm('## 8. 波浪线围栏 ~~~（callout/数学/缩写字面量）\n正文', { name: 'markdown', strikethrough: true });
  const types = lineTokenTypes(cm, 0);
  assert.ok(!types.has('strikethrough'), '标题行 3 连波浪后跟非空白曾误开删除线（eatWhile 吞串），不应出现 strikethrough token');
});

test('A2 正文行 ~~~ 字面量不触发删除线', () => {
  const cm = makeCm('a ~~~ b\n下一行', { name: 'markdown', strikethrough: true });
  assert.ok(!lineTokenTypes(cm, 0).has('strikethrough'));
});

test('A3 恰好 2 波浪仍正常开删除线（补丁不得过度禁用）', () => {
  const cm = makeCm('~~删除~~文字', { name: 'markdown', strikethrough: true });
  const types = lineTokenTypes(cm, 0);
  assert.ok(types.has('strikethrough'), '~~x~~ 合法删除线语法被补丁误伤');
});

test('A4 ~~ 后跟空白不开删除线（flanking 语义保留）', () => {
  const cm = makeCm('~~ 删除', { name: 'markdown', strikethrough: true });
  assert.ok(!lineTokenTypes(cm, 0).has('strikethrough'));
});

test('A5 2 波浪开关成对、状态不跨行泄漏（空行复位后普通行无删除线）', () => {
  const cm = makeCm('~~a~~\n\n普通行', { name: 'markdown', strikethrough: true });
  assert.ok(lineTokenTypes(cm, 0).has('strikethrough'));
  assert.ok(!lineTokenTypes(cm, 2).has('strikethrough'), '空行复位后普通行不应带 strikethrough');
});

// ============================================================
// B. vendor 补丁②：行内代码独立 token，块级代码不受影响
// ============================================================

test('B1 tokenTypeOverrides.codeInline 只改行内代码 token', () => {
  const cm = makeCm('前 `code` 后', { name: 'markdown', strikethrough: true, tokenTypeOverrides: { codeInline: 'plain' } });
  const types = lineTokenTypes(cm, 0);
  assert.ok(types.has('plain'), '行内代码应改发 codeInline（plain）');
  assert.ok(!types.has('comment'), '行内代码不应再发 comment token');
});

test('B2 缩进代码块仍走 code(comment)，不被 codeInline 波及', () => {
  const cm = makeCm('正文\n\n    indented code', { name: 'markdown', tokenTypeOverrides: { codeInline: 'plain' } });
  const types = lineTokenTypes(cm, 2);
  assert.ok(types.has('comment'), '缩进代码块必须保留 comment token（块级路径不得受行内改写影响）');
});

// ============================================================
// C. editor-core tokenTypeOverrides：编辑器只显示源码
// ============================================================

// 与 editor-core.js 的 mode 配置一致（静态断言守卫两者同步，见 T 组）
const EDITOR_MODE_CFG = {
  name: 'gfm',
  gitHubSpice: false,
  tokenTypeOverrides: { em: 'plain', strong: 'plain', strikethrough: 'plain', codeInline: 'plain' },
};

test('C1 粗体/斜体/删除线/行内代码 全部发 plain、不再发格式化 token', () => {
  const doc = '**粗体**\n*斜体*\n~~删除~~\n`行内代码`';
  const cm = makeCm(doc, EDITOR_MODE_CFG);
  const forbidden = ['strong', 'em', 'strikethrough', 'comment'];
  for (let i = 0; i < 4; i++) {
    const types = lineTokenTypes(cm, i);
    assert.ok(types.has('plain'), `第 ${i + 1} 行应发 plain token：${doc.split('\n')[i]}`);
    for (const f of forbidden) {
      assert.ok(!types.has(f), `第 ${i + 1} 行不应出现 ${f} token：${doc.split('\n')[i]}`);
    }
  }
});

test('C2 结构性 token 保留：标题/引用/链接不受影响', () => {
  const cm = makeCm('# 标题\n> 引用\n[文字](http://example.com)', EDITOR_MODE_CFG);
  assert.ok(lineTokenTypes(cm, 0).has('header'), '标题 header token 必须保留');
  assert.ok(lineTokenTypes(cm, 1).has('quote'), '引用 quote token 必须保留');
  assert.ok(lineTokenTypes(cm, 2).has('link'), '链接 link token 必须保留');
});

test('C3 高亮 ==..== 编辑态恒为源码（模式本就不发 token）', () => {
  const cm = makeCm('==高亮==', EDITOR_MODE_CFG);
  const types = lineTokenTypes(cm, 0);
  for (const f of ['highlight', 'mark', 'strong', 'em']) assert.ok(!types.has(f), '==..== 不应发格式化 token');
});

// ============================================================
// D. vendor 补丁重打守卫（补丁源 + 再生产物双层断言）
// ============================================================

test('D1 ensure-vendor 含 markdown 模式补丁重打步骤且被调用', () => {
  const vendor = fs.readFileSync(ENSURE, 'utf8');
  assert.ok(vendor.includes('applyTizuMarkMarkdownModePatch'), 'ensure-vendor 缺 markdown 模式补丁函数（vendor 再生会抹掉删除线/行内代码修复）');
  assert.ok(/applyTizuMarkMarkdownModePatch\(\);/.test(vendor), 'ensure-vendor 的 markdown 模式补丁函数未被调用');
});

test('D2 两个补丁项均有幂等 marker + 锚点丢失 exit 1', () => {
  const vendor = fs.readFileSync(ENSURE, 'utf8');
  for (const m of [MARKER_STRIKE, MARKER_CODEINLINE]) {
    assert.ok(vendor.includes(m), 'ensure-vendor markdown 补丁项缺幂等 marker：' + m);
  }
  // 补丁函数体内必须有锚点丢失显式失败（拒绝静默跳过）
  const fnStart = vendor.indexOf('function applyTizuMarkMarkdownModePatch');
  assert.ok(fnStart !== -1);
  const fnEnd = vendor.indexOf('\napplyTizuMarkMarkdownModePatch();', fnStart);
  const fnBody = vendor.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('process.exit(1)'), 'markdown 模式补丁锚点丢失时未 exit 1（静默跳过 = 修复悄悄消失）');
});

test('D3 工作区 vendor 副本当前已含两处补丁', () => {
  const code = fs.readFileSync(VENDOR_MD, 'utf8');
  assert.ok(code.includes(MARKER_STRIKE), 'src/lib markdown.js 缺删除线补丁 marker（先跑 node scripts/ensure-vendor.mjs）');
  assert.ok(code.includes(MARKER_CODEINLINE), 'src/lib markdown.js 缺行内代码独立 token 补丁 marker');
  assert.ok(code.includes("if (stream.current().length !== 2) { return getType(state); }"), '恰好 2 波浪守卫代码缺失');
});

// ============================================================
// E. editor-core 配置静态守卫（配置与 C 组行为测试保持同步）
// ============================================================

test('E1 editor-core mode 配置含 tokenTypeOverrides 且四类 token 指向 plain', () => {
  const src = fs.readFileSync(ECORE, 'utf8');
  assert.match(src, /tokenTypeOverrides:\s*\{\s*em:\s*'plain',\s*strong:\s*'plain',\s*strikethrough:\s*'plain',\s*codeInline:\s*'plain'\s*\}/,
    'editor-core.js 缺行内格式 token 中和配置（或与 C 组行为测试的 EDITOR_MODE_CFG 不同步）');
  assert.match(src, /gitHubSpice:\s*false/, 'gitHubSpice: false 不得丢失');
  // 配置必须提为共享常量 MD_MODE_CFG 并挂 window（files.js 打开文件时复用），构造处用 mode: MD_MODE_CFG
  assert.match(src, /window\.TizuMdModeCfg\s*=\s*MD_MODE_CFG/, 'editor-core 未挂 window.TizuMdModeCfg（files.js 无处复用）');
  assert.match(src, /mode:\s*MD_MODE_CFG,/, 'editor-core 构造实例未使用 MD_MODE_CFG 常量');
});

test('E2 files.js _applyCodeMode 打开文件不得用裸 gfm 覆盖 markdown 配置', () => {
  // 2026-11-15 真机实锤：openFile → _applyCodeMode('md') → setOption('mode', 'gfm')（裸字符串）
  // 把 tokenTypeOverrides 整体覆盖丢失，**粗体** 等重新变回格式化外观。md/markdown 映射与
  // 未知扩展名兜底必须复用 window.TizuMdModeCfg。
  const fsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'files.js'), 'utf8');
  const fnStart = fsrc.indexOf('_applyCodeMode(ext)');
  assert.ok(fnStart !== -1, 'files.js 缺 _applyCodeMode');
  const fnBody = fsrc.slice(fnStart, fsrc.indexOf('async openFolder()', fnStart));
  assert.match(fnBody, /window\.TizuMdModeCfg/, '_applyCodeMode 未复用 window.TizuMdModeCfg');
  assert.doesNotMatch(fnBody, /md:\s*'gfm'/, "_applyCodeMode 的 md 映射不得是裸 'gfm'（覆盖 tokenTypeOverrides）");
  assert.doesNotMatch(fnBody, /\|\|\s*'gfm'/, "_applyCodeMode 未知扩展名兜底不得是裸 'gfm'");
  assert.doesNotMatch(fnBody, /setOption\('mode',\s*'gfm'\)/, "_applyCodeMode catch 兜底不得是裸 'gfm'");
});
