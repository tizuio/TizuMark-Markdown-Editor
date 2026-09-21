// 代码块按需滚动：CSS 默认 overflow-y:hidden（避免 Windows WebView2 always-show
// 滚动条轨道在短代码块上也出现），render 后处理 + MutationObserver 检测内容是否溢出，
// 只有真溢出才改回 auto。锁住 CSS 契约 + 后处理源码契约 + Observer 注册契约
//（jsdom layout 不可靠，不做行为断言）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const pcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers/preview-controller.js'), 'utf8');
// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const appSrc = require('./helpers/app-bundle.cjs').readBundle();

test('styles.css: .code-scroll 默认 overflow-y: hidden（防短代码显示滚动条轨道）', () => {
  const block = css.match(/\.code-scroll\s*\{[^}]*\}/);
  assert.ok(block, '应存在 .code-scroll 规则');
  assert.match(block[0], /overflow-y:\s*hidden/, '默认应 hidden，Windows always-show 滚动条不会再现');
  assert.ok(/max-height:\s*300px/.test(block[0]), 'max-height: 300px 让较长的代码块（>10 行）就触发滚条，避免临界判断');
});

test('preview-controller.js: render 后处理 .code-scroll 按 scrollHeight/clientHeight 判溢出', () => {
  assert.match(pcSrc, /querySelectorAll\(['"]\.code-scroll['"]\)/, '应遍历 .code-scroll');
  assert.match(
    pcSrc,
    /scrollHeight\s*>\s*el\.clientHeight\s*\+\s*1\s*\?\s*'auto'\s*:\s*'hidden'/,
    '按 scrollHeight/clientHeight+1 判溢出，溢出显式 auto（覆盖 CSS hidden）否则 hidden；注意不能清空 inline 让 CSS 接管（CSS 已是 hidden）',
  );
});

test('app.js: 注册 MutationObserver 监听 preview 子树，自动跑 .code-scroll 后处理（rAF debounce）', () => {
  // LiveReload 推新 JS 后已渲染的代码块不会重新触发 render，单靠 render 末尾调用会漏；
  // 必须有 observer 兜底任何时机出现的 .code-scroll。
  assert.match(appSrc, /new\s+MutationObserver\(/, 'DOMContentLoaded 里应 new MutationObserver');
  assert.match(appSrc, /pruneCodeScrolls/, '应有 pruneCodeScrolls 函数');
  assert.match(
    appSrc,
    /requestAnimationFrame\(pruneCodeScrolls\)/,
    'observer 回调应 rAF 内调用 pruneCodeScrolls（去抖）',
  );
  assert.match(
    appSrc,
    /\.observe\([^)]*\.preview[^)]*subtree:\s*true/,
    'observer 应监听 preview 的 childList + subtree（捕获任意位置新增的 .code-scroll）',
  );
});

test('styles.css: 关闭「代码块滚动条」时 .preview-content.code-no-scroll .code-scroll 撑开高度不滚动', () => {
  const block = css.match(/\.preview-content\.code-no-scroll\s+\.code-scroll\s*\{[^}]*\}/);
  assert.ok(block, '应存在 .preview-content.code-no-scroll .code-scroll 规则');
  assert.ok(/max-height:\s*none\s*!important/.test(block[0]), '应 max-height: none 撑开高度随内容');
  assert.ok(/overflow:\s*visible\s*!important/.test(block[0]), '应 overflow: visible 不出现滚动条');
});

test('preview-controller.js: 设置 codeScroll=false 时跳过 .code-scroll 溢出后处理（改由 CSS 撑开）', () => {
  assert.match(pcSrc, /codeScroll\s*===\s*false/, '后处理循环应在 settings.codeScroll === false 时跳过，不写 inline overflowY');
});