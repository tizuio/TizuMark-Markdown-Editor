// 回归：全局快捷键派发放宽到「Ctrl/Meta/Alt 任一修饰键」后（合并自 PR #67），
// 是否会误拦截 Alt 系组合 / 改变默认快捷键行为。
//
// 关注点（用户提问）：
//  1. Alt+未注册键：必须放行（不 preventDefault / 不 stopPropagation），否则会吞掉系统/浏览器组合。
//  2. Alt+已注册键：应派发一次，且 preventDefault + stopPropagation（由本处接管，
//     不再让浏览器/系统对同一组合叠加动作）。
//  3. 默认的 Alt 键位是 `Alt+Up/Down`（moveLineUp/Down），但事件侧 keyStr 用 e.key='ArrowUp/Down'
//     拼成 `Alt+ArrowUp`，与注册表 `Alt+Up` 不匹配 → 全局通道不接管，事件照旧落到 CM extraKeys。
//     即：默认行为零变化（本文件 L3/L4 + I1 锁死这一点）。
//  4. Ctrl 系行为必须与放宽前完全一致（pd/sp/派发）。
//
// 采用与 shortcut-default-registration.test.cjs 相同的方式：从打包源码抽取真实方法，
// 在纯对象 ctx 上用伪事件断言，不依赖构建产物。

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const APP = require('./helpers/app-bundle.cjs').readBundle();

function extractMethod(needle) {
  const sigIdx = APP.indexOf(needle);
  assert.ok(sigIdx !== -1, '应在源码中找到: ' + needle);
  let i = APP.indexOf('{', sigIdx), depth = 0;
  for (; i < APP.length; i++) {
    const c = APP[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  const name = needle.split('(')[0].trim();
  return eval('(' + APP.slice(sigIdx, i + 1).replace(new RegExp('^\\s*' + name), 'function ' + name) + ')');
}

const _dispatchGlobalShortcut = extractMethod('_dispatchGlobalShortcut(e) {');

// 伪 KeydownEvent：记录 preventDefault / stopPropagation 是否被调用
function mkEvent(over = {}) {
  return Object.assign({
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    key: '', code: '', _pd: false, _sp: false,
    preventDefault() { this._pd = true; },
    stopPropagation() { this._sp = true; },
  }, over);
}

// 伪 this：globalShortcutLookup 由用例注入
function mkCtx(lookup = {}) {
  return { globalShortcutLookup: lookup };
}

// ---------- Alt 系 ----------

test('L1 Alt+未注册字母（Alt+G）：放行——不 preventDefault、不 stopPropagation、不派发', () => {
  const calls = [];
  const ctx = mkCtx({ 'Alt+M': () => calls.push('m') }); // 只注册了 Alt+M
  const e = mkEvent({ altKey: true, key: 'g', code: 'KeyG' });
  _dispatchGlobalShortcut.call(ctx, e);
  assert.strictEqual(e._pd, false, '未注册的 Alt 组合不得 preventDefault（否则吞掉浏览器/系统默认）');
  assert.strictEqual(e._sp, false, '未注册的 Alt 组合不得 stopPropagation（事件须继续传播）');
  assert.strictEqual(calls.length, 0, '不得误触发其它 Alt 快捷键');
});

test('L2 Alt+已注册字母（Alt+M）：派发一次 + preventDefault + stopPropagation（与 Ctrl 一致）', () => {
  let n = 0;
  const ctx = mkCtx({ 'Alt+M': () => n++ });
  const e = mkEvent({ altKey: true, key: 'm', code: 'KeyM' });
  _dispatchGlobalShortcut.call(ctx, e);
  assert.strictEqual(n, 1, '命中的 Alt 快捷键应派发一次');
  assert.strictEqual(e._pd, true, '命中即 preventDefault：既然由本处接管，不该再让浏览器/系统叠加默认动作');
  assert.strictEqual(e._sp, true, '命中后应 stopPropagation，阻断 CM/WebView 二次处理');
});

test('L3 Alt+ArrowUp 不命中注册表 Alt+Up（keyStr 用 e.key 拼成 Alt+ArrowUp）→ 放行给 CM', () => {
  let n = 0;
  const ctx = mkCtx({ 'Alt+Up': () => n++ }); // 设置里存的是 Alt+Up
  const e = mkEvent({ altKey: true, key: 'ArrowUp', code: 'ArrowUp' });
  _dispatchGlobalShortcut.call(ctx, e);
  assert.strictEqual(n, 0, '全局通道不应接管 Alt+Up（键名与事件侧不一致），交由 CM extraKeys 处理');
  assert.strictEqual(e._pd, false);
  assert.strictEqual(e._sp, false, '未接管即不得拦截，保证事件到达 CodeMirror');
});

test('L4 Alt+ArrowDown 同上：不接管、不拦截', () => {
  let n = 0;
  const ctx = mkCtx({ 'Alt+Down': () => n++ });
  const e = mkEvent({ altKey: true, key: 'ArrowDown', code: 'ArrowDown' });
  _dispatchGlobalShortcut.call(ctx, e);
  assert.strictEqual(n, 0);
  assert.strictEqual(e._pd, false);
  assert.strictEqual(e._sp, false);
});

// ---------- Ctrl 系（放宽前后必须一致）----------

test('L5 Ctrl+B 命中：preventDefault + stopPropagation + 派发（与放宽前一致）', () => {
  let n = 0;
  const ctx = mkCtx({ 'Ctrl+B': () => n++ });
  const e = mkEvent({ ctrlKey: true, key: 'b', code: 'KeyB' });
  _dispatchGlobalShortcut.call(ctx, e);
  assert.strictEqual(n, 1);
  assert.strictEqual(e._pd, true);
  assert.strictEqual(e._sp, true);
});

test('L6 Ctrl+G 未命中：preventDefault（阻止浏览器默认）但不派发', () => {
  const ctx = mkCtx({});
  const e = mkEvent({ ctrlKey: true, key: 'g', code: 'KeyG' });
  _dispatchGlobalShortcut.call(ctx, e);
  assert.strictEqual(e._pd, true, 'Ctrl 系未命中仍应阻止浏览器默认行为');
  assert.strictEqual(e._sp, false);
});

test('L7 Ctrl+Home/End/←/→：放行给 CM（不 preventDefault、不 stopPropagation）', () => {
  for (const [key, code] of [['Home', 'Home'], ['End', 'End'], ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight']]) {
    const e = mkEvent({ ctrlKey: true, key, code });
    _dispatchGlobalShortcut.call(mkCtx({}), e);
    assert.strictEqual(e._pd, false, 'Ctrl+' + key + ' 应放行');
    assert.strictEqual(e._sp, false, 'Ctrl+' + key + ' 应放行');
  }
});

test('L8 Ctrl+A/C/V/X（无 Shift）：放行（不拦截浏览器编辑键）', () => {
  for (const key of ['a', 'c', 'v', 'x', 'z', 'y']) {
    const e = mkEvent({ ctrlKey: true, key, code: 'Key' + key.toUpperCase() });
    _dispatchGlobalShortcut.call(mkCtx({}), e);
    assert.strictEqual(e._pd, false, 'Ctrl+' + key + ' 应放行');
    assert.strictEqual(e._sp, false, 'Ctrl+' + key + ' 应放行');
  }
});

test('L9 Ctrl+Shift+C：preventDefault（阻止 DevTools 等）', () => {
  const e = mkEvent({ ctrlKey: true, shiftKey: true, key: 'C', code: 'KeyC' });
  _dispatchGlobalShortcut.call(mkCtx({}), e);
  assert.strictEqual(e._pd, true);
});

test('L10 裸字母 / L11 Shift+字母（无 Ctrl/Meta/Alt）：不参与，放行', () => {
  const e1 = mkEvent({ key: 'a', code: 'KeyA' });
  _dispatchGlobalShortcut.call(mkCtx({ 'A': () => { throw new Error('不该派发'); } }), e1);
  assert.strictEqual(e1._pd, false);
  assert.strictEqual(e1._sp, false);

  const e2 = mkEvent({ shiftKey: true, key: 'A', code: 'KeyA' });
  _dispatchGlobalShortcut.call(mkCtx({}), e2);
  assert.strictEqual(e2._pd, false);
  assert.strictEqual(e2._sp, false);
});

test('L12 Ctrl+Alt+Z（AltGr 或 Ctrl+Alt）：走 Ctrl 分支、命中编辑键白名单 → 放行', () => {
  const e = mkEvent({ ctrlKey: true, altKey: true, key: 'z', code: 'KeyZ' });
  _dispatchGlobalShortcut.call(mkCtx({}), e);
  assert.strictEqual(e._pd, false, 'Ctrl+Alt+Z 属编辑键白名单（z），应放行');
  assert.strictEqual(e._sp, false);
});

// ---------- 真实环境端到端：默认 Alt+Up 仍由 CM 处理且只触发一次 ----------

const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

function withEditorReady(w, ms, body) {
  return waitForEditor(w).then(() => new Promise((resolve, reject) => {
    setTimeout(() => { try { body(); resolve(); } catch (e) { reject(e); } }, ms);
  }));
}

test('I1 端到端：Alt+Up 在编辑器聚焦时上移一行且只移动一次（默认键位不受本次改动影响）', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  return withEditorReady(w, 400, () => {
    const ed = w.editor;
    const cm = ed.cm;
    cm.focus();
    cm.setValue('AAA\nBBB\nCCC');
    cm.setCursor({ line: 2, ch: 0 }); // 光标在第 3 行
    let moved = 0;
    const orig = ed._moveLine.bind(ed);
    ed._moveLine = (d) => { moved++; return orig(d); };

    let bubbled = 0;
    const onBubble = () => { bubbled++; };
    w.document.addEventListener('keydown', onBubble, false);

    const inner = cm.getWrapperElement().querySelector('.CodeMirror-code') || cm.getWrapperElement();
    const evt = new w.KeyboardEvent('keydown', {
      key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38,
      altKey: true, bubbles: true, cancelable: true,
    });
    inner.dispatchEvent(evt);

    w.document.removeEventListener('keydown', onBubble, false);

    assert.strictEqual(moved, 1, 'Alt+Up 应只上移一行（不得由全局通道与 CM 各触发一次）');
    assert.strictEqual(cm.getValue(), 'AAA\nCCC\nBBB', '第 3 行应上移到第 2 行');
    // 默认 Alt+Up 未被全局通道拦截，事件应能到达 CM 并冒泡
    assert.strictEqual(bubbled, 1, 'Alt+Up 未命中全局通道，事件应正常冒泡到 CM');
    cleanup(w);
  });
});
