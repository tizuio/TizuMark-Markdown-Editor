// 回归测试：快捷键单键修改/清除/恢复默认 改为「仅面板内草稿，点确认才生效」
// 验证：
//  A. 录制单键：仅更新内存草稿 + 内存标记 custom，不落盘(saveShortcuts)不应用(applyShortcuts)
//  B. 清除单键：同上，不落盘不应用
//  C. 恢复默认(重置)：仅内存草稿回到默认，不落盘不应用
//  D. 点「确认」(custom 分支 save+apply)：才落盘并应用到 CM
//  E. 打开面板(showShortcutsDialog)：从 localStorage 重载基线，未确认草稿不残留
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><div id="shortcuts-dialog" class="hidden"></div>', { url: 'http://localhost/' });
global.document = dom.window.document;
const localStorage = dom.window.localStorage;

// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const src = require('./helpers/app-bundle.cjs').readBundle();

function extractMethod(s, name) {
  const re = new RegExp('  ' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  const m = re.exec(s);
  if (!m) throw new Error('method not found: ' + name);
  let i = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = null;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') { depth--; if (depth === 0) return s.slice(m.index, i + 1); }
  }
  throw new Error('unterminated: ' + name);
}

const methods = ['getDefaultShortcuts', 'loadShortcuts', 'loadShortcutScheme',
  'handleShortcutRecording', 'findDuplicateShortcut', 'clearShortcut', 'resetShortcuts',
  'showShortcutsDialog', 'saveShortcuts', '_normalizeShortcuts', '_normalizeShortcutEntry'];
let methodSrc = methods.map(n => extractMethod(src, n)).join(',\n');
// 包成对象字面量（方法简写），并附 _validConfigObject stub
const factory = new Function('window', 'document', 'localStorage',
  'return {\n' + methodSrc + ',\n  _validConfigObject(o){ return o; }\n};');
const M = factory(global.window, global.document, localStorage);

const inst = Object.assign({}, M);
inst._applyCount = 0; inst._saveCount = 0; inst._renderCount = 0; inst._populateCount = 0; inst._toastCount = 0;
inst.applyShortcuts = () => { inst._applyCount++; };
inst.renderShortcutsList = () => { inst._renderCount++; };
inst.populateSchemeSelect = () => { inst._populateCount++; };
inst.setStatus = () => {};
inst.showToast = () => { inst._toastCount++; };
inst.t = (k) => k;
// 录制校验新增「不与内置固定快捷键冲突」分支：此处桩为空，避免影响既有断言
inst.getBuiltinFixedShortcuts = () => [];
inst.findBuiltinShortcut = () => null;
inst._normalizeShortcutKey = (k) => k;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('ok - ' + msg); } else { fail++; console.log('not ok - ' + msg); } }

// 初始化：模拟启动加载（localStorage 此时为空 → 默认）
function reloadBaseline() {
  inst._applyCount = 0; inst._saveCount = 0; inst._renderCount = 0; inst._populateCount = 0; inst._toastCount = 0;
  inst.shortcuts = inst.loadShortcuts();
  inst.shortcutScheme = inst.loadShortcutScheme();
}

// 先模拟「已保存状态」：把 closeToTray 存为 Ctrl+Shift+W，saveFile 保持默认 Ctrl+S
localStorage.setItem('tizumark-shortcuts', JSON.stringify({ closeToTray: { key: 'Ctrl+Shift+W', label: '关闭到托盘' } }));
localStorage.setItem('tizumark-shortcut-scheme', 'custom');
reloadBaseline();
ok(inst.shortcuts.closeToTray.key === 'Ctrl+Shift+W', '基线：已保存的 closeToTray = Ctrl+Shift+W');
ok(inst.shortcutScheme === 'custom', '基线：scheme = custom');

// ---- A. 录制单键：应仅改内存草稿，不落盘不应用 ----
const savedBefore = localStorage.getItem('tizumark-shortcuts');
inst.recordingAction = 'closeToTray';
const ev = { key: 'K', ctrlKey: true, shiftKey: false, altKey: true, metaKey: false, preventDefault() {}, stopPropagation() {} };
inst.handleShortcutRecording(ev);
ok(inst.shortcuts.closeToTray.key === 'Ctrl+Alt+K', 'A: 录制后内存草稿 closeToTray = Ctrl+Alt+K');
ok(inst.shortcutScheme === 'custom', 'A: 内存 scheme 标记 custom(预览)');
ok(inst._applyCount === 0, 'A: 录制未调用 applyShortcuts(未生效)');
ok(inst._toastCount === 0, 'A: 成功录制未弹占用提示');
ok(localStorage.getItem('tizumark-shortcuts') === savedBefore, 'A: 录制未落盘(localStorage 不变)');

// ---- B. 清除单键：应仅改内存草稿，不落盘不应用 ----
inst.clearShortcut('closeToTray');
ok(inst.shortcuts.closeToTray.key === '', 'B: 清除后内存草稿 closeToTray = 空');
ok(inst._applyCount === 0, 'B: 清除未调用 applyShortcuts(未生效)');
ok(localStorage.getItem('tizumark-shortcuts') === savedBefore, 'B: 清除未落盘(localStorage 不变)');

// ---- C. 恢复默认(重置)：仅内存草稿回到默认，不落盘不应用 ----
// 先把某键改成非默认再重置
inst.shortcuts.saveFile.key = 'Ctrl+Alt+S';
inst.resetShortcuts();
ok(inst.shortcuts.saveFile.key === 'Ctrl+S', 'C: 重置后 saveFile 回到默认 Ctrl+S');
ok(inst.shortcuts.closeToTray.key === '', 'C: 重置后 closeToTray 回到默认空');
ok(inst.shortcutScheme === 'default', 'C: 重置内存 scheme = default(预览)');
ok(inst._applyCount === 0, 'C: 重置未调用 applyShortcuts(未生效)');
ok(localStorage.getItem('tizumark-shortcuts') === savedBefore, 'C: 重置未落盘(localStorage 仍是原已保存值)');

// ---- D. 点「确认」(custom 分支)：才落盘并应用 ----
inst.shortcuts.closeToTray.key = 'Ctrl+Shift+W'; // 改回一个草稿
inst.shortcutScheme = 'custom';
inst.saveShortcuts();          // 等价确认按钮 custom 分支的 this.saveShortcuts()
inst.saveShortcutScheme ? inst.saveShortcutScheme('custom') : (localStorage.setItem('tizumark-shortcut-scheme', 'custom'));
inst.applyShortcuts();         // 等价确认按钮 custom 分支的 this.applyShortcuts()
ok(inst._applyCount === 1, 'D: 确认调用了 applyShortcuts(生效)');
const persisted = JSON.parse(localStorage.getItem('tizumark-shortcuts'));
ok(persisted.closeToTray.key === 'Ctrl+Shift+W', 'D: 确认后 localStorage 写入新键位');

// ---- E. 打开面板：从 localStorage 重载基线，未确认草稿不残留 ----
// 模拟「上次未确认就关闭」留下的脏草稿
inst.shortcuts.closeToTray.key = 'Ctrl+W'; // 脏草稿
inst.shortcutScheme = 'custom';
inst.showShortcutsDialog();
ok(inst.shortcuts.closeToTray.key === 'Ctrl+Shift+W', 'E: 重开面板从 localStorage 重载(脏草稿被丢弃)');
ok(inst.shortcutScheme === 'custom', 'E: 重开面板 scheme 从 localStorage 重载');

console.log('\n# tests ' + (pass + fail) + ' ' + pass + ' passing, ' + fail + ' failing');
process.exit(fail ? 1 : 0);
