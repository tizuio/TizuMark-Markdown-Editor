'use strict';
// 回归测试：Ctrl+F 搜索框输入时焦点不该被预览高亮清理逻辑抢走
// 复现：旧 clearPreviewHighlights 在每次（防抖后）输入经 highlightPreviewMatches 调用时
// 无条件 window.getSelection().removeAllRanges()，WebView2/Chromium 下会让聚焦的 <input> 失焦。
// 修复：_safeClearSelection 仅当文档选区锚点落在 #preview 内才清空，焦点在输入框时不再调用。

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const src = require('./helpers/app-bundle.cjs').readBundle();

// 从源文件提取某个方法的函数体（按花括号平衡），返回可 eval 的函数字符串
function extractMethod(source, name) {
  const start = source.indexOf(`  ${name}() {`);
  if (start === -1) throw new Error(`method not found: ${name}`);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        const body = source.slice(start, i + 1);
        return body;
      }
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const methodSrc = extractMethod(src, 'clearPreviewHighlights') + ',\n' + extractMethod(src, '_safeClearSelection');

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <input type="text" id="find-input" value="abc">
  <div id="preview"><p>hello <mark class="preview-search-hl">world</mark> foo</p></div>
</body></html>`, { pretendToBeVisual: true });

const { window } = dom;
const { document } = window;

// 把方法挂到一个带 preview 的 mock 实例上
const inst = { preview: document.getElementById('preview') };
const factory = new Function('window', 'document', `return ({ ${methodSrc} });`);
const methods = factory(window, document);
Object.assign(inst, methods);

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok - ' + msg); }
  else { fail++; console.log('not ok - ' + msg); }
}

// ---- 测试 A：搜索输入框聚焦时，不应调用 removeAllRanges（不再抢焦点） ----
(function () {
  const input = document.getElementById('find-input');
  input.focus();
  input.setSelectionRange(0, 2);
  const sel = window.getSelection();
  let removeAllCalled = 0;
  const origRemove = sel.removeAllRanges.bind(sel);
  sel.removeAllRanges = function () { removeAllCalled++; return origRemove(); };

  inst.clearPreviewHighlights();

  ok(document.activeElement === input, 'A: 调用后搜索输入框仍保持焦点 (未失焦)');
  ok(removeAllCalled === 0, 'A: 焦点在输入框时未调用 window.getSelection().removeAllRanges()');
  ok(input.value === 'abc' && input.selectionStart === 0 && input.selectionEnd === 2, 'A: 输入框文本与选区未被破坏');
})();

// ---- 测试 B：焦点不在输入框、选区落在预览内时，仍应清空预览选区 ----
(function () {
  const input = document.getElementById('find-input');
  input.blur();
  document.body.focus();
  // 重新挂一个预览高亮 mark（测试 A 已解包旧的）
  const preview = document.getElementById('preview');
  const mark = document.createElement('mark');
  mark.className = 'preview-search-hl';
  mark.textContent = 'world';
  preview.querySelector('p').appendChild(mark);
  const sel = window.getSelection();
  sel.removeAllRanges();
  const r = document.createRange();
  r.selectNodeContents(mark);
  sel.addRange(r);
  ok(sel.rangeCount > 0 && document.getElementById('preview').contains(sel.anchorNode), 'B: 预览内存在选区（前置）');

  let removeAllCalled = 0;
  const origRemove = sel.removeAllRanges.bind(sel);
  sel.removeAllRanges = function () { removeAllCalled++; return origRemove(); };

  inst.clearPreviewHighlights();

  ok(removeAllCalled === 1, 'B: 预览内选区被正常清空（旧行为保留）');
  ok(sel.rangeCount === 0, 'B: 选区已移除');
})();

console.log(`\n# tests ${pass + fail}`);
console.log(`# pass ${pass}`);
console.log(`# fail ${fail}`);
process.exit(fail ? 1 : 0);
