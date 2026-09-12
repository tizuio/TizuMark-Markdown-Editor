// 快捷键全面失效修复的回归测试（P0 故障闭环）：
//   A. default 方案默认采用 Typora 风格键位（标题 Ctrl+1~6、图片 Ctrl+Shift+I 等）
//   B. loadShortcuts 归一化：兼容旧字符串格式 / 损坏对象 / 缺字段 → 自愈，加粗等不再丢失
//   C. applyShortcuts 确实把这些键注册进 CodeMirror extraKeys 与全局查找表
//
// 与项目现有测试一致：从 src/app.js 抽取真实方法（balanced-brace + eval），在桩实例上断言。
// 不依赖任何构建产物（unified-bundle），可直接 `node --test test/shortcut-default-registration.test.cjs`。

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

// localStorage 依赖（jsdom 提供）
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
const loadShortcuts = extractMethod('loadShortcuts() {');
const applyShortcuts = extractMethod('applyShortcuts() {');
const _normalizeShortcutEntry = extractMethod('_normalizeShortcutEntry(raw, def) {');
const _normalizeShortcuts = extractMethod('_normalizeShortcuts(saved, defaults) {');

// _validConfigObject 真实行为：非对象返回 {}，对象原样返回（与 app.js 一致的最小实现）
function validConfigObject(o) { return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }

function makeLoadStub() {
  return {
    getDefaultShortcuts,
    _validConfigObject: validConfigObject,
    _normalizeShortcuts,
    _normalizeShortcutEntry,
  };
}

// ============================================================
// A. default 方案默认键位（参考 Typora）
// ============================================================

test('A1 default 方案：标题 H1~H6 注册 Ctrl+1~6', () => {
  const def = getDefaultShortcuts();
  for (let i = 1; i <= 6; i++) {
    assert.strictEqual(def['insertH' + i].key, 'Ctrl+' + i, 'insertH' + i + ' 应为 Ctrl+' + i);
  }
});

test('A2 default 方案：图片/代码块/删除线/行内代码/公式 采用 Typora 键位', () => {
  const def = getDefaultShortcuts();
  assert.strictEqual(def.insertImage.key, 'Ctrl+Shift+I');
  assert.strictEqual(def.codeBlock.key, 'Ctrl+Shift+K');
  assert.strictEqual(def.strikethrough.key, 'Ctrl+Shift+5');
  assert.strictEqual(def.inlineCode.key, 'Ctrl+Shift+`');
  assert.strictEqual(def.insertMathBlock.key, 'Ctrl+Shift+M');
});

test('A3 default 与 typora 预设键位集合在 typora 覆盖项上完全一致', () => {
  const def = getDefaultShortcuts();
  const typora = getShortcutPresets().typora;
  // fileSearch 在 typora 中显式置空（''），避免继承 default 的 Ctrl+P 与 typora 自身的
  // exportPDF:'Ctrl+P' 冲突；exportPDF 在 default 中已迁到 Ctrl+Shift+P，typora 仍保留
  // 其 Ctrl+P 打印键位（typora 方案语义）。二者均为有意差异，跳过。
  for (const [aid, k] of Object.entries(typora)) {
    if (aid === 'fileSearch' || aid === 'exportPDF') continue;
    assert.strictEqual(def[aid].key, k, 'default 的 ' + aid + ' 应与 typora 一致（=' + k + '）');
  }
});

test('A4 typora 未覆盖的稀有项（上下标/表格/列表/高亮/Mermaid/目录/提示块）默认仍为空', () => {
  const def = getDefaultShortcuts();
  for (const aid of ['insertSuperscript', 'insertSubscript', 'insertTable', 'insertUl',
    'insertOl', 'insertTask', 'insertHr', 'highlight', 'insertMermaid', 'insertToc',
    'insertCalloutNote', 'insertCalloutTip', 'insertCalloutWarning',
    'insertCalloutCaution', 'insertCalloutImportant']) {
    assert.strictEqual(def[aid].key, '', aid + ' 默认应为空（typora 也未提供）');
  }
});

test('A5 vscode 预设（合并自 PR #36）：toggleSidebar 绑定 Ctrl+B，bold 留空避免冲突', () => {
  const vscode = getShortcutPresets().vscode;
  assert.strictEqual(vscode.toggleSidebar, 'Ctrl+B', 'VS Code 语义：Ctrl+B 应切侧边栏');
  assert.strictEqual(vscode.bold, '', 'bold 让位给 toggleSidebar（可在自定义中另行绑定）');
});

test('A6 default 方案 toggleSidebar 无默认键（不占用 Ctrl+B，加粗保持可用）', () => {
  const def = getDefaultShortcuts();
  assert.strictEqual(def.toggleSidebar.key, '', 'default 下 toggleSidebar 应无默认键');
  assert.strictEqual(def.bold.key, 'Ctrl+B', 'default 下加粗保持 Ctrl+B');
});

test('A7 applyShortcutScheme(vscode) 后 toggleSidebar 生效、bold 清空、label 保留', () => {
  const applyShortcutScheme = extractMethod('applyShortcutScheme(name) {');
  const saved = [];
  const s = {
    getDefaultShortcuts,
    getShortcutPresets,
    shortcutScheme: '',
    shortcuts: null,
    saveShortcuts() { saved.push(this.shortcuts); },
    saveShortcutScheme() {},
    renderShortcutsList() {},
    applyShortcuts() {},
  };
  applyShortcutScheme.call(s, 'vscode');
  assert.strictEqual(s.shortcuts.toggleSidebar.key, 'Ctrl+B');
  assert.strictEqual(s.shortcuts.bold.key, '');
  assert.strictEqual(s.shortcuts.bold.label, '加粗', 'label 应保留默认值');
  assert.strictEqual(saved.length, 1, '应落盘一次');
});

test('A8 default 方案（合并自 PR #36）：fileSearch 绑定 Ctrl+P（VS Code Quick Open），原 exportPDF 迁到 Ctrl+Shift+P 不再冲突', () => {
  const def = getDefaultShortcuts();
  assert.strictEqual(def.fileSearch.key, 'Ctrl+P', '文件搜索应为 VS Code 风格 Ctrl+P');
  assert.strictEqual(def.exportPDF.key, 'Ctrl+Shift+P', '导出 PDF 让出 Ctrl+P，迁到 Ctrl+Shift+P');
  assert.notStrictEqual(def.fileSearch.key, def.exportPDF.key, '二者键位不得冲突');
});

test('A9 default 方案（合并自 PR #36）：moveLineUp/moveLineDown 默认 Alt+Up/Alt+Down，previewPaneWidth 默认 360', () => {
  const def = getDefaultShortcuts();
  assert.ok(def.moveLineUp && def.moveLineUp.key === 'Alt+Up', 'moveLineUp 默认应为 Alt+Up');
  assert.ok(def.moveLineDown && def.moveLineDown.key === 'Alt+Down', 'moveLineDown 默认应为 Alt+Down');
  const ds = extractMethod('defaultSettings() {');
  const d = ds.call({});
  assert.strictEqual(d.previewPaneWidth, 360, '预览区宽度默认 360');
});

test('A11 default 方案与 vscode/typora/sublime 预设：insertLineBelow=Ctrl+Enter、insertLineAbove=Ctrl+Shift+Enter', () => {
  const def = getDefaultShortcuts();
  assert.strictEqual(def.insertLineBelow.key, 'Ctrl+Enter', 'insertLineBelow 默认应为 Ctrl+Enter');
  assert.strictEqual(def.insertLineAbove.key, 'Ctrl+Shift+Enter', 'insertLineAbove 默认应为 Ctrl+Shift+Enter');
  const presets = getShortcutPresets();
  for (const name of ['vscode', 'typora', 'sublime']) {
    assert.strictEqual(presets[name].insertLineBelow, 'Ctrl+Enter', name + ' 预设 insertLineBelow 应为 Ctrl+Enter');
    assert.strictEqual(presets[name].insertLineAbove, 'Ctrl+Shift+Enter', name + ' 预设 insertLineAbove 应为 Ctrl+Shift+Enter');
  }
});

test('A10 预设键位无冲突：vscode fileSearch=Ctrl+P；typora/sublime 显式 fileSearch:"" 避免继承 Ctrl+P 与自身 exportPDF 冲突', () => {
  const presets = getShortcutPresets();
  assert.strictEqual(presets.vscode.fileSearch, 'Ctrl+P', 'vscode 文件搜索=Ctrl+P');
  assert.strictEqual(presets.typora.fileSearch, '', 'typora 显式置空 fileSearch，避免与 exportPDF:Ctrl+P 冲突');
  assert.strictEqual(presets.sublime.fileSearch, '', 'sublime 显式置空 fileSearch，避免与 exportPDF:Ctrl+P 冲突');
  // 各预设内部不得出现两个 action 共用同一非空键
  for (const [name, preset] of Object.entries(presets)) {
    const seen = {};
    for (const [aid, k] of Object.entries(preset)) {
      if (!k) continue;
      assert.strictEqual(seen[k], undefined, `${name} 预设键位冲突：${k} 被 ${aid} 与 ${seen[k]} 共用`);
      seen[k] = aid;
    }
  }
});

// ============================================================
// B. _normalizeShortcutEntry 自愈（单条）
// ============================================================

test('B1 旧字符串格式 "Ctrl+B" 归一化为 {key:"Ctrl+B",label:"加粗"}', () => {
  const def = getDefaultShortcuts();
  const out = _normalizeShortcutEntry.call({}, 'Ctrl+B', def.bold);
  assert.strictEqual(out.key, 'Ctrl+B');
  assert.strictEqual(out.label, '加粗');
});

test('B2 损坏对象 {foo:1}（缺 key）→ 回落默认键 Ctrl+B（自愈，加粗不再丢失）', () => {
  const def = getDefaultShortcuts();
  const out = _normalizeShortcutEntry.call({}, { foo: 1 }, def.bold);
  assert.strictEqual(out.key, 'Ctrl+B');
});

test('B3 旧数据缺 label → 用默认 label', () => {
  const def = getDefaultShortcuts();
  const out = _normalizeShortcutEntry.call({}, { key: 'Ctrl+I' }, def.italic);
  assert.strictEqual(out.key, 'Ctrl+I');
  assert.strictEqual(out.label, '斜体');
});

test('B4 异常类型 / null → 回落默认键', () => {
  const def = getDefaultShortcuts();
  assert.strictEqual(_normalizeShortcutEntry.call({}, 123, def.bold).key, 'Ctrl+B');
  assert.strictEqual(_normalizeShortcutEntry.call({}, null, def.bold).key, 'Ctrl+B');
  assert.strictEqual(_normalizeShortcutEntry.call({}, undefined, def.bold).key, 'Ctrl+B');
});

test('B5 空 key 字符串 → 回落默认键', () => {
  const def = getDefaultShortcuts();
  const out = _normalizeShortcutEntry.call({}, { key: '' }, def.bold);
  assert.strictEqual(out.key, 'Ctrl+B');
});

// ============================================================
// C. _normalizeShortcuts 遍历 / 丢弃未知项
// ============================================================

test('C1 遍历所有 defaults，旧字符串 bold 被归一化且项数一致', () => {
  const def = getDefaultShortcuts();
  const out = _normalizeShortcuts.call(makeLoadStub(), { bold: 'Ctrl+B' }, def);
  assert.strictEqual(out.bold.key, 'Ctrl+B');
  assert.strictEqual(Object.keys(out).length, Object.keys(def).length);
});

test('C2 saved 中 defaults 不存在的未知项被丢弃', () => {
  const def = getDefaultShortcuts();
  const out = _normalizeShortcuts.call(makeLoadStub(), { bold: 'Ctrl+B', ghostAction: 'Ctrl+Z' }, def);
  assert.ok(!('ghostAction' in out), '未知项应被丢弃');
});

// ============================================================
// D. loadShortcuts 端到端（核心修复验证）
// ============================================================

test('D1 localStorage 旧字符串格式 → 加粗/斜体恢复正常（不再整体丢失）', () => {
  localStorage.setItem('tizumark-shortcuts', JSON.stringify({ bold: 'Ctrl+B', italic: 'Ctrl+I' }));
  const loaded = loadShortcuts.call(makeLoadStub());
  assert.strictEqual(loaded.bold.key, 'Ctrl+B');
  assert.strictEqual(loaded.bold.label, '加粗');
  assert.strictEqual(loaded.italic.key, 'Ctrl+I');
});

test('D2 损坏对象 {bold:{foo:1}} → 加粗回落默认 Ctrl+B（自愈）', () => {
  localStorage.setItem('tizumark-shortcuts', JSON.stringify({ bold: { foo: 1 } }));
  const loaded = loadShortcuts.call(makeLoadStub());
  assert.strictEqual(loaded.bold.key, 'Ctrl+B', '损坏数据应自愈为默认 Ctrl+B');
});

test('D3 空 localStorage → 返回完整默认键位（含标题 Ctrl+1~6 / 加粗 Ctrl+B）', () => {
  localStorage.removeItem('tizumark-shortcuts');
  const loaded = loadShortcuts.call(makeLoadStub());
  assert.strictEqual(loaded.insertH1.key, 'Ctrl+1');
  assert.strictEqual(loaded.insertH3.key, 'Ctrl+3');
  assert.strictEqual(loaded.bold.key, 'Ctrl+B');
});

test('D4 脏/非法 JSON → 不抛错，回落默认', () => {
  localStorage.setItem('tizumark-shortcuts', '{这不是合法JSON');
  const loaded = loadShortcuts.call(makeLoadStub());
  assert.strictEqual(loaded.bold.key, 'Ctrl+B');
  assert.strictEqual(loaded.insertH1.key, 'Ctrl+1');
});

test('D5 部分损坏（部分字符串、部分对象）整体自愈', () => {
  localStorage.setItem('tizumark-shortcuts', JSON.stringify({
    bold: 'Ctrl+B',                 // 旧字符串格式
    italic: { key: 'Ctrl+I' },      // 正常对象
    codeBlock: { foo: 1 },          // 损坏对象（缺 key）→ 回落默认
  }));
  const loaded = loadShortcuts.call(makeLoadStub());
  assert.strictEqual(loaded.bold.key, 'Ctrl+B');
  assert.strictEqual(loaded.italic.key, 'Ctrl+I');
  assert.strictEqual(loaded.codeBlock.key, 'Ctrl+Shift+K', '损坏对象应回落 default 的 Ctrl+Shift+K');
});

// ============================================================
// E. applyShortcuts 确实把键注册进 CodeMirror extraKeys（标题可用性的直接证据）
// ============================================================

function makeCmStub() {
  return {
    _ek: {},
    setOption(name, val) { if (name === 'extraKeys') this._ek = val; },
    getOption(name) { return name === 'extraKeys' ? this._ek : undefined; },
  };
}

test('E1 applyShortcuts 把标题 H1~H6 注册进 CM extraKeys（Ctrl-1 ~ Ctrl-6）', () => {
  const cm = makeCmStub();
  const s = { cm, shortcuts: getDefaultShortcuts(), updateShortcutHints() {}, _syncGlobalCloseToTrayShortcut() {} };
  applyShortcuts.call(s);
  for (let i = 1; i <= 6; i++) {
    assert.strictEqual(typeof cm._ek['Ctrl-' + i], 'function',
      'insertH' + i + ' 应注册为 CM extraKeys["Ctrl-' + i + '"]');
  }
});

test('E2 applyShortcuts 把加粗/图片/公式等注册进 CM，并把全局键与编辑器键都填入 globalShortcutLookup', () => {
  const cm = makeCmStub();
  const s = { cm, shortcuts: getDefaultShortcuts(), updateShortcutHints() {}, _syncGlobalCloseToTrayShortcut() {} };
  applyShortcuts.call(s);
  assert.strictEqual(typeof cm._ek['Ctrl-B'], 'function', '加粗应注册');
  // 注意：applyShortcuts 内 toCmKey 按修饰键排序（Shift 在前），故 Ctrl+Shift+I → Shift-Ctrl-I
  assert.strictEqual(typeof cm._ek['Shift-Ctrl-I'], 'function', '图片应注册');
  assert.strictEqual(typeof cm._ek['Shift-Ctrl-M'], 'function', '公式应注册');
  // 全局键（保存/查找/跨文件搜索）进入 document 级查找表
  assert.strictEqual(typeof s.globalShortcutLookup['Ctrl+S'], 'function', '保存应进入全局查找表');
  assert.strictEqual(typeof s.globalShortcutLookup['Ctrl+H'], 'function', '跨文件搜索应进入全局查找表');
  // 编辑器动作（加粗/标题）也进入全局查找表（经全局捕获通道派发，避免 CM extraKeys 通道失效时整体失灵）
  assert.strictEqual(typeof s.globalShortcutLookup['Ctrl+B'], 'function', '加粗应进入全局查找表');
  assert.strictEqual(typeof s.globalShortcutLookup['Ctrl+1'], 'function', '标题应进入全局查找表');
});

test('E3 编辑器动作的全局项带「聚焦才执行」守卫：未聚焦不误触、聚焦才执行', () => {
  const cm = makeCmStub();
  const spy = [];
  const s = { cm, shortcuts: getDefaultShortcuts(), updateShortcutHints() {}, _syncGlobalCloseToTrayShortcut() {}, wrapSelection: () => spy.push('wrap') };
  applyShortcuts.call(s);
  cm.hasFocus = () => false;
  s.globalShortcutLookup['Ctrl+B']();
  assert.strictEqual(spy.length, 0, '编辑器未聚焦时，全局快捷键不应误触加粗');
  cm.hasFocus = () => true;
  s.globalShortcutLookup['Ctrl+B']();
  assert.strictEqual(spy.length, 1, '编辑器聚焦时，全局快捷键应执行加粗');
});

// ============================================================
// F. 源码语法
// ============================================================

test('F1 src/app.js 通过 node --check 语法检查', () => {
  let ok = true, msg = '';
  try {
    execSync('node --check ' + path.join(ROOT, 'src', 'app.js'));
  } catch (e) {
    ok = false; msg = e.message;
  }
  assert.ok(ok, 'app.js 语法检查失败: ' + msg);
});
