// 任务列表勾选框点击：编辑器不应跳动 —— 回归测试
// 验证 handleTaskCheckboxToggle 在回写源码时：
//  1. 捕获并在变更后还原编辑器滚动位置（消除 CodeMirror 内部滚动导致的「点完跳到别处」）
//  2. 取消在途的滚动同步调度（throttle 尾随 _syncPreviewToEditor / debounce _resumeScroll）
//     避免用户滚到勾选框后立即点击（<100ms）时残留调度越权移动编辑器
//  3. 120ms 后恢复 _canScroll 双标志
// 注：jsdom 无真实布局，编辑器滚动用 stub cm 的 getScrollInfo/scrollTo 跟踪，足以锁定行为。
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const appjs = require('./helpers/app-bundle.cjs').readBundle();
const tauriApiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'tauri-api.js'), 'utf8');
const previewControllerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'preview-controller.js'), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
  <div class="editor-container">
    <div class="editor-pane"></div>
    <div class="preview-pane"><div class="preview-content"></div></div>
  </div>
  <div id="editor-pane"></div>
  <div id="preview-pane"></div>
  <button id="btn-view-preview"></button>
  <button id="btn-view-edit"></button>
  <button id="btn-side-left"></button>
  <button id="btn-side-right"></button>
</body></html>`;

const dom = new JSDOM(HTML, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
dom.window.__TAURI__ = { core: { invoke: () => Promise.resolve(null) }, path: {}, app: {}, event: {}, shell: {} };

const harnessFn = function () {
  const results = [];
  if (typeof MarkdownEditor !== 'function') { results.push(['加载', false]); return results; }

  const ed = Object.create(MarkdownEditor.prototype);
  const cmScroll = { top: 250, left: 0, clientHeight: 800, height: 5000 };
  let scrollToCalls = [];
  ed.cm = {
    getScrollInfo: () => ({ ...cmScroll }),
    scrollTo: (left, top) => { scrollToCalls.push({ left, top }); if (typeof top === 'number') cmScroll.top = top; if (typeof left === 'number') cmScroll.left = left; },
    getCursor: () => ({ line: 1, ch: 0 }),
    setCursor: () => {},
    getLine: () => '- [ ] 待办事项',
    lineCount: () => 100,
    replaceRange: () => {},
    refresh: () => {},
  };

  // 预览 DOM：含一个带 data-source-line 的 li，内含 checkbox
  const preview = document.createElement('div');
  preview.innerHTML = '<ul><li data-source-line="5"><input type="checkbox"></li></ul>';
  document.body.appendChild(preview);
  ed.preview = preview;

  // 模拟「用户刚滚动到勾选框、立即点击」：在途同步调度处于挂起状态
  ed._canScroll = { editor: true, preview: true };
  ed._scrollThrottleTimer = 1;
  ed._scrollThrottlePending = () => {};
  ed._scrollDebounceTimer = 1;
  ed._suppressNextPreviewRerender = false;
  ed.debounceTimer = null;
  ed.updateWordCount = () => {};
  ed.updateOutline = () => {};

  const checkbox = preview.querySelector('input[type="checkbox"]');
  ed.handleTaskCheckboxToggle(checkbox);

  // 同步断言
  results.push(['S1: 捕获并还原编辑器滚动 scrollTo(0,250)', scrollToCalls.some(c => c.left === 0 && c.top === 250)]);
  results.push(['S2: 取消 throttle 定时器', ed._scrollThrottleTimer === null]);
  results.push(['S3: 清空 throttle 尾随回调', ed._scrollThrottlePending === null]);
  results.push(['S4: 取消 debounce 定时器', ed._scrollDebounceTimer === null]);
  results.push(['S5: 同步期间 _canScroll 双标志关闭', ed._canScroll.editor === false && ed._canScroll.preview === false]);
  results.push(['S6: 回写抑制标志已置位', ed._suppressNextPreviewRerender === true]);

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  return (async () => {
    await wait(160); // 等 120ms 恢复定时器
    results.push(['S7: 120ms 后 _canScroll 恢复', ed._canScroll.editor === true && ed._canScroll.preview === true]);
    results.push(['S8: 恢复后编辑器滚动仍为捕获值 250（未被越权同步改动）', ed.cm.getScrollInfo().top === 250]);
    return results;
  })();
};

const combined = tauriApiSrc + '\n;\n' + previewControllerSrc + '\n;\n' + appjs + '\n;window.__harnessPromise = (' + harnessFn.toString() + ')();';
const s = dom.window.document.createElement('script');
s.textContent = combined;
dom.window.document.body.appendChild(s);

for (const name of ['S1: 捕获并还原编辑器滚动 scrollTo(0,250)','S2: 取消 throttle 定时器','S3: 清空 throttle 尾随回调','S4: 取消 debounce 定时器','S5: 同步期间 _canScroll 双标志关闭','S6: 回写抑制标志已置位','S7: 120ms 后 _canScroll 恢复','S8: 恢复后编辑器滚动仍为捕获值 250（未被越权同步改动）']) {
  test(name, async () => {
    const results = await dom.window.__harnessPromise;
    const item = results.find(r => r[0] === name);
    assert.ok(item && item[1] === true, name + (item ? '' : ' (结果缺失)'));
  });
}
