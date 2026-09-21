// 功能1 回归测试库：快捷键方案（默认 / VSCode / Typora / Sublime / 自定义）。
//
// 设计原则（与项目现有测试一致）：
//   从 src/app.js 抽取真实方法（balanced-brace 抽取 + eval），在桩实例上断言
//   预置键位表、整体覆盖、方案持久化、手动录制标记 custom、旧数据兼容等行为。

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const APP = require('./helpers/app-bundle.cjs').readBundle();

// localStorage 依赖
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
global.localStorage = dom.window.localStorage;

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

const getDefaultShortcuts = extractMethod('getDefaultShortcuts() {');
const getShortcutPresets = extractMethod('getShortcutPresets() {');
const applyShortcutScheme = extractMethod('applyShortcutScheme(name) {');
const previewShortcutScheme = extractMethod('previewShortcutScheme(name) {');
const loadShortcutScheme = extractMethod('loadShortcutScheme() {');
const resetShortcuts = extractMethod('resetShortcuts() {');
const handleShortcutRecording = extractMethod('handleShortcutRecording(e) {');
const findDuplicateShortcut = extractMethod('findDuplicateShortcut(key, excludeAction) {');
const _markShortcutCustom = extractMethod('_markShortcutCustom() {');

function makeSchemeStub() {
  return {
    shortcuts: null,
    shortcutScheme: null,
    getDefaultShortcuts,
    getShortcutPresets,
    saveShortcuts() {},
    saveShortcutScheme(name) { try { localStorage.setItem('tizumark-shortcut-scheme', name); } catch {} },
    renderShortcutsList() {},
    applyShortcuts() {},
  };
}

// ============================================================
// B. 预置方案数据完整性
// ============================================================

test('B1 预置表含 3 个方案（vscode/typora/sublime）', async () => {
  const presets = getShortcutPresets();
  assert.strictEqual(Object.keys(presets).length, 3);
  assert.ok(['vscode', 'typora', 'sublime'].every(k => k in presets));
});

test('B2 每方案内部键位互不重复', async () => {
  for (const [name, map] of Object.entries(getShortcutPresets())) {
    const keys = Object.values(map).filter(Boolean);
    assert.strictEqual(new Set(keys).size, keys.length, name + ' 内部键位应互不重复');
  }
});

test('B3 预置方案仅引用合法 actionId', async () => {
  const ids = new Set(Object.keys(getDefaultShortcuts()));
  for (const map of Object.values(getShortcutPresets())) {
    for (const aid of Object.keys(map)) {
      assert.ok(ids.has(aid), '预置方案引用了非法 actionId: ' + aid);
    }
  }
});

// ============================================================
// C. applyShortcutScheme 整体覆盖
// ============================================================

// 默认设置项总数以 getDefaultShortcuts 为准（历史上曾为 44：含 findReplace/previewFind，
// 二者与 find 同一功能已合并移除，现为 42）
const DEFAULT_COUNT = Object.keys(getDefaultShortcuts()).length;

test('C1 applyShortcutScheme("typora") 覆盖全部默认项且不重复', async () => {
  const s = makeSchemeStub();
  applyShortcutScheme.call(s, 'typora');
  assert.strictEqual(Object.keys(s.shortcuts).length, DEFAULT_COUNT);
  assert.strictEqual(s.shortcuts.insertH1.key, 'Ctrl+1');
  assert.strictEqual(s.shortcuts.strikethrough.key, 'Ctrl+Shift+5');
  assert.strictEqual(s.shortcuts.saveAs.key, '');
  assert.strictEqual(s.shortcutScheme, 'typora');
});

test('C2 applyShortcutScheme("vscode") 与默认不撞（saveAs=Ctrl+Shift+S，strikethrough 回落空）', async () => {
  const s = makeSchemeStub();
  applyShortcutScheme.call(s, 'vscode');
  assert.strictEqual(Object.keys(s.shortcuts).length, DEFAULT_COUNT);
  assert.strictEqual(s.shortcuts.saveAs.key, 'Ctrl+Shift+S');
  assert.strictEqual(s.shortcuts.strikethrough.key, '');
  assert.strictEqual(s.shortcutScheme, 'vscode');
});

test('C3 applyShortcutScheme("default") 整体恢复默认键位', async () => {
  const s = makeSchemeStub();
  applyShortcutScheme.call(s, 'default');
  const def = getDefaultShortcuts();
  assert.strictEqual(Object.keys(s.shortcuts).length, DEFAULT_COUNT);
  assert.strictEqual(s.shortcuts.bold.key, def.bold.key);
  assert.strictEqual(s.shortcuts.saveAs.key, def.saveAs.key);
  assert.strictEqual(s.shortcutScheme, 'default');
});

test('C4 方案持久化到 localStorage', async () => {
  const s = makeSchemeStub();
  applyShortcutScheme.call(s, 'vscode');
  assert.strictEqual(s.shortcutScheme, 'vscode');
  assert.strictEqual(localStorage.getItem('tizumark-shortcut-scheme'), 'vscode');
});

// ============================================================
// D. 手动录制/清除 → 标记 custom；reset → 默认
// ============================================================

test('D1 手动录制成功后标记 custom', async () => {
  const s = {
    shortcuts: getDefaultShortcuts(),
    recordingAction: 'bold',
    shortcutScheme: 'vscode',
    getDefaultShortcuts,
    findDuplicateShortcut,
    getBuiltinFixedShortcuts() { return []; },
    findBuiltinShortcut() { return null; },
    _normalizeShortcutKey(k) { return k; },
    showToast() {},
    saveShortcuts() {},
    saveShortcutScheme(name) { try { localStorage.setItem('tizumark-shortcut-scheme', name); } catch {} },
    renderShortcutsList() {},
    applyShortcuts() {},
    _markShortcutCustom,
  };
  const handled = handleShortcutRecording.call(s, { key: 'B', ctrlKey: true, preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(handled, true);
  assert.strictEqual(s.shortcutScheme, 'custom');
});

test('D2 resetShortcuts 联动方案回默认（仅面板预览，不持久化 scheme）', async () => {
  localStorage.removeItem('tizumark-shortcut-scheme');
  const s = {
    shortcuts: null,
    shortcutScheme: 'vscode',
    getDefaultShortcuts,
    saveShortcuts() {},
    saveShortcutScheme(name) { try { localStorage.setItem('tizumark-shortcut-scheme', name); } catch {} },
    renderShortcutsList() {},
    applyShortcuts() {},
    setStatus() {},
    t: (k) => k,
  };
  resetShortcuts.call(s);
  assert.strictEqual(Object.keys(s.shortcuts).length, DEFAULT_COUNT);
  assert.strictEqual(s.shortcutScheme, 'default');
  // reset 仅面板内预览重置，不持久化方案名（需点确认按钮才正式生效）
  assert.strictEqual(localStorage.getItem('tizumark-shortcut-scheme'), null);
});

// ============================================================
// E. 旧数据兼容（无 scheme 键）
// ============================================================

test('E1 旧数据无 scheme 键且有差异 → loadShortcutScheme 返回 custom', async () => {
  localStorage.removeItem('tizumark-shortcut-scheme');
  localStorage.setItem('tizumark-shortcuts', JSON.stringify({ bold: { key: 'Ctrl+Z' } }));
  const s = { shortcuts: { bold: { key: 'Ctrl+Z' } }, getDefaultShortcuts };
  assert.strictEqual(loadShortcutScheme.call(s), 'custom');
});

test('E2 旧数据无 scheme 键且无差异 → 返回 default', async () => {
  localStorage.removeItem('tizumark-shortcut-scheme');
  const def = getDefaultShortcuts();
  localStorage.setItem('tizumark-shortcuts', JSON.stringify(def));
  const s = { shortcuts: def, getDefaultShortcuts };
  assert.strictEqual(loadShortcutScheme.call(s), 'default');
});

test('E3 脏 scheme 值被白名单过滤（回退差异探测）', async () => {
  localStorage.setItem('tizumark-shortcut-scheme', 'hacked');
  const def = getDefaultShortcuts();
  localStorage.setItem('tizumark-shortcuts', JSON.stringify(def));
  const s = { shortcuts: def, getDefaultShortcuts };
  assert.strictEqual(loadShortcutScheme.call(s), 'default');
});

// ============================================================
// G. previewShortcutScheme：切换预览，不生效不持久化（22:39 需求）
// ============================================================

function makePreviewStub() {
  const calls = { render: 0, saveShortcuts: 0, saveScheme: 0, apply: 0, loadShortcuts: 0 };
  const s = {
    shortcuts: null,
    shortcutScheme: null,
    getDefaultShortcuts,
    getShortcutPresets,
    loadShortcuts() { calls.loadShortcuts++; return { bold: { key: 'Ctrl+Z', label: '加粗' } }; },
    saveShortcuts() { calls.saveShortcuts++; },
    saveShortcutScheme() { calls.saveScheme++; },
    renderShortcutsList() { calls.render++; },
    applyShortcuts() { calls.apply++; },
  };
  return { s, calls };
}

test('G1 previewShortcutScheme("typora") 加载键位+渲染列表，但不持久化、不应用 CM', async () => {
  const { s, calls } = makePreviewStub();
  previewShortcutScheme.call(s, 'typora');
  assert.strictEqual(Object.keys(s.shortcuts).length, DEFAULT_COUNT, '应加载方案键位');
  assert.strictEqual(s.shortcuts.insertH1.key, 'Ctrl+1');
  assert.strictEqual(s.shortcutScheme, 'typora');
  assert.strictEqual(calls.render, 1, '应渲染列表供预览');
  assert.strictEqual(calls.saveShortcuts, 0, '预览不得持久化键位');
  assert.strictEqual(calls.saveScheme, 0, '预览不得持久化方案名');
  assert.strictEqual(calls.apply, 0, '预览不得应用 CM（切换不生效）');
});

test('G2 previewShortcutScheme("custom") 加载自定义键位预览，同样不生效', async () => {
  const { s, calls } = makePreviewStub();
  previewShortcutScheme.call(s, 'custom');
  assert.strictEqual(calls.loadShortcuts, 1, 'custom 应加载已保存键位');
  assert.strictEqual(s.shortcuts.bold.key, 'Ctrl+Z', '应展示自定义键位');
  assert.strictEqual(s.shortcutScheme, 'custom');
  assert.strictEqual(calls.saveShortcuts, 0);
  assert.strictEqual(calls.apply, 0);
});

test('G3 切换只预览：预览后 shortcutScheme 已变但未持久化（确认按钮才落盘）', async () => {
  localStorage.removeItem('tizumark-shortcut-scheme');
  const { s } = makePreviewStub();
  previewShortcutScheme.call(s, 'vscode');
  assert.strictEqual(s.shortcutScheme, 'vscode');
  assert.strictEqual(localStorage.getItem('tizumark-shortcut-scheme'), null,
    '预览不得写入 localStorage（确认后才持久化）');
});

// ============================================================
// F. 源码语法
// ============================================================

test('F1 src/app.js 通过 node --check 语法检查', async () => {
  let ok = true, msg = '';
  try {
    execSync('node --check ' + path.join(ROOT, 'src', 'app.js'));
  } catch (e) {
    ok = false; msg = e.message;
  }
  assert.ok(ok, 'app.js 语法检查失败: ' + msg);
});
