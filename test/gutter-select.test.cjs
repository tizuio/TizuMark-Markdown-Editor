// 功能2 回归测试库：行号点击选行 + 拖动连选。
//
// 设计原则（与项目现有测试一致）：
//   用 jsdom 起最小 DOM，再 require 真实 codemirror，在「真实 CodeMirror 5 实例」
//   上运行从 src/app.js 抽取的真实 _selectLineRange / onGutterClick / onGutterMouseMove /
//   onGutterMouseUp 方法（balanced-brace 抽取 + eval），断言真实 API 行为。
//   jsdom 无真实几何，拖动测试 stub cm.coordsChar 返回受控行号（真机坐标转换在 Tauri 手测）。

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const APP = require('./helpers/app-bundle.cjs').readBundle();

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

const _selectLineRange = extractMethod('_selectLineRange(cm, fromLine, toLine) {');
const onGutterClick = extractMethod('onGutterClick(cm, line, gutter, ev) {');
const onGutterMouseMove = extractMethod('onGutterMouseMove(e) {');
const onGutterMouseUp = extractMethod('onGutterMouseUp() {');

const mk = (v) => CodeMirror(document.createElement('div'), { value: v });

function setup(value) {
  const cm = mk(value);
  const s = { _gutterAnchor: null, _gutterDrag: null, cm };
  s._selectLineRange = _selectLineRange;
  return { cm, s };
}
const ev = (button = 0, shiftKey = false) => ({ button, shiftKey, preventDefault() {} });

// ============================================================
// A. 行号点击选行 + 拖动连选（真实 CM 实例 + 状态机）
// ============================================================

test('A1 单击中间行选中整行（含换行）', async () => {
  const { cm, s } = setup('a\nb\nc');
  onGutterClick.call(s, cm, 1, 'gutter', ev(0, false));
  assert.strictEqual(cm.getSelection(), 'b\n');
});

test('A2 单击末行选中到行尾（无换行）', async () => {
  const { cm, s } = setup('a\nb\nc');
  onGutterClick.call(s, cm, 2, 'gutter', ev(0, false));
  assert.strictEqual(cm.getSelection(), 'c');
});

test('A3 单击首行选中整行（含换行）', async () => {
  const { cm, s } = setup('a\nb\nc');
  onGutterClick.call(s, cm, 0, 'gutter', ev(0, false));
  assert.strictEqual(cm.getSelection(), 'a\n');
});

test('A4 Shift+单击扩展选区', async () => {
  const { cm, s } = setup('a\nb\nc');
  s._gutterAnchor = null;
  onGutterClick.call(s, cm, 0, 'gutter', ev(0, false)); // 设 anchor=0
  onGutterClick.call(s, cm, 2, 'gutter', ev(0, true));  // shift 扩展到 line2
  assert.strictEqual(cm.getSelection(), 'a\nb\nc');
});

test('A5 按住拖动向下连选（anchor 固定）', async () => {
  const { cm, s } = setup('a\nb\nc');
  onGutterClick.call(s, cm, 0, 'gutter', ev(0, false)); // anchor=0
  s.cm.coordsChar = () => ({ line: 2 });
  onGutterMouseMove.call(s, { clientX: 0, clientY: 50 });
  assert.strictEqual(cm.getSelection(), 'a\nb\nc');
});

test('A6 按住拖动向上连选（anchor 固定）', async () => {
  const { cm, s } = setup('a\nb\nc');
  onGutterClick.call(s, cm, 2, 'gutter', ev(0, false)); // anchor=2
  s.cm.coordsChar = () => ({ line: 0 });
  onGutterMouseMove.call(s, { clientX: 0, clientY: 5 });
  assert.strictEqual(cm.getSelection(), 'a\nb\nc');
});

test('A7 拖动越界 clamp 到末行（不抛错）', async () => {
  const { cm, s } = setup('a\nb\nc');
  onGutterClick.call(s, cm, 0, 'gutter', ev(0, false));
  s.cm.coordsChar = () => ({ line: 99 });
  assert.doesNotThrow(() => onGutterMouseMove.call(s, { clientX: 0, clientY: 999 }));
  assert.strictEqual(cm.getSelection(), 'a\nb\nc');
});

test('A8 右键不触发选行', async () => {
  const { cm, s } = setup('a\nb\nc');
  s._gutterDrag = null;
  onGutterClick.call(s, cm, 1, 'gutter', ev(2, false));
  assert.strictEqual(s._gutterDrag, null);
  assert.strictEqual(cm.getSelection(), '');
});

test('A9 mouseup 清空 drag 并保留 anchor', async () => {
  const { cm, s } = setup('a\nb\nc');
  onGutterClick.call(s, cm, 0, 'gutter', ev(0, false)); // anchor=0, _gutterDrag 设
  assert.notStrictEqual(s._gutterDrag, null);
  onGutterMouseUp.call(s);
  assert.strictEqual(s._gutterDrag, null);
  assert.strictEqual(s._gutterAnchor, 0);
});

test('A10 src/app.js 通过 node --check 语法检查', async () => {
  let ok = true, msg = '';
  try {
    execSync('node --check ' + path.join(ROOT, 'src', 'app.js'));
  } catch (e) {
    ok = false; msg = e.message;
  }
  assert.ok(ok, 'app.js 语法检查失败: ' + msg);
});
