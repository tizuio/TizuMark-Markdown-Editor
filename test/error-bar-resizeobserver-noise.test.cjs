// ResizeObserver 循环噪声过滤测试（issue #102：底部红色错误条「ResizeObserver loop
// completed with undelivered notifications.」且点 × 后逐帧重现、看似叉不掉）。
// 该报错是浏览器已知良性通知（WICG resize-observer#38）：观察回调改布局导致本帧
// 无法投递的下一次通知时，Chromium 以非致命 error 事件上报，不中断执行、无行列
// 信息（真实 WebView 里 filename 为 http://tauri.localhost/ 且无行号）。全局兜底
// 不应把它弹成红色错误条。
// 注：app-env 用 runScripts: 'outside-only' 不执行 index.html 内联 IIFE，
// 这里用最小 JSDOM 手动 eval IIFE 文本（仅依赖 document/window，无需加载 app.js）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
// 同 error-bar-position.test.cjs：index.html 注释里也有 "<script>" 字面，按内容匹配
const errorScript = indexHtml.split('<script>').find((p) => p.includes('showErrorBar')).split('</script>')[0];
if (!errorScript) throw new Error('index.html 未找到含 showErrorBar 的 <script> 块');

function buildWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://tauri.localhost/',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  new w.Function(errorScript).call(w);
  return w;
}

// 模拟 Chromium 投递 RO 循环通知的方式：window 上无 target 元素、message 携带文本、
// filename 为文档地址且 lineno/colno 缺省（0 → 兜底显示 '?'）
function dispatchRuntimeError(w, message) {
  w.dispatchEvent(new w.ErrorEvent('error', {
    message,
    filename: 'http://tauri.localhost/',
    lineno: 0,
    colno: 0,
  }));
}

test('新 Chromium/WebView2 变体：completed with undelivered notifications 不弹错误条', () => {
  const w = buildWindow();
  dispatchRuntimeError(w, 'ResizeObserver loop completed with undelivered notifications.');
  assert.strictEqual(
    w.document.getElementById('fatal-error-bar'),
    null,
    '良性 RO 循环通知不得创建红色错误条',
  );
});

test('旧 Chromium 变体：ResizeObserver loop limit exceeded 不弹错误条', () => {
  const w = buildWindow();
  dispatchRuntimeError(w, 'ResizeObserver loop limit exceeded');
  assert.strictEqual(
    w.document.getElementById('fatal-error-bar'),
    null,
    '旧版消息变体同样必须被过滤',
  );
});

test('「叉不掉」回归：真实错误已被 × 关闭后，RO 噪声不得让错误条重现', () => {
  const w = buildWindow();
  dispatchRuntimeError(w, 'TypeError: cannot read property of undefined');
  let bar = w.document.getElementById('fatal-error-bar');
  assert.ok(bar, '前置：真实错误应弹出错误条');
  // × 按钮的实际效果是 display:none（inline onclick 在 outside-only 模式不接线，
  // 直接模拟其落点——与用户点击后的 DOM 状态等价）
  bar.style.display = 'none';
  dispatchRuntimeError(w, 'ResizeObserver loop completed with undelivered notifications.');
  bar = w.document.getElementById('fatal-error-bar');
  assert.strictEqual(bar.style.display, 'none', 'RO 噪声不得重新展开已关闭的错误条');
});

test('防过度过滤：真实运行时错误仍须弹错误条', () => {
  const w = buildWindow();
  dispatchRuntimeError(w, 'TypeError: null is not an object');
  const bar = w.document.getElementById('fatal-error-bar');
  assert.ok(bar, '普通运行时错误必须照常弹出错误条');
  assert.ok(/TypeError/.test(bar.textContent), '错误条应包含真实错误信息');
});
