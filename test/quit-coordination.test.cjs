// 退出协调回归测试(tab-tearoff-window Task 8):
// - coordinateQuit:无分离窗口直接聚合退出 / 全 ready 聚合会话清键再退出 / 任一 aborted 不退 / 超时不退
// - detached handleAppClose:保存询问 → saveSession(label 键) → 只关自己,不触 quit;取消 → aborted 上报
// - mergeDetachedSessions 烟测(委托 multi-window)
// TauriApi.onEvent 用捕获 mock:handler 由测试手动驱动,不依赖真实 Tauri 事件总线。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');
const MW = require('../src/modules/multi-window.js');

async function makeEditor() {
  const { w, getInitErr } = await buildEnv({ captureInitErr: true });
  await delay(300);
  // 事件捕获:onEvent 注册的 handler 存表,由测试驱动
  const handlers = {};
  w.TauriApi.onEvent = async (name, cb) => { handlers[name] = cb; return () => {}; };
  const emits = [];
  w.TauriApi.emitTo = async (label, event, payload) => { emits.push({ label, event, payload }); };
  let quitCalls = 0;
  w.TauriApi.quitApp = async () => { quitCalls++; };
  return { w, ed: w.editor, getInitErr, handlers, emits, quitCount: () => quitCalls };
}

test('quit: 无分离窗口 → 直接聚合完成(不 emit,quitApp 由 handleAppClose 调用方负责)', async () => {
  const { w, ed, emits } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => [];
    const ok = await ed.coordinateQuit({ timeoutMs: 300 });
    assert.equal(ok, true);
    assert.equal(emits.length, 0, '无窗口可协调,不应 emit');
  } finally { cleanup(w); }
});

test('quit: 全 ready → 聚合分离会话进主键并清 editor 键/交接键 → 退出', async () => {
  const { w, ed, handlers, emits, quitCount } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => ['editor-1'];
    // 预置分离窗口会话与残留交接键
    w.localStorage.setItem('tizumark-session-editor-1', JSON.stringify({
      version: 2, tabs: [{ filePath: 'D:/d.md', name: 'd.md' }], emptyTabs: false,
    }));
    w.localStorage.setItem(MW.HANDOFF_PREFIX + 'editor-2', '{"junk":1}');

    const p = ed.coordinateQuit({ timeoutMs: 2000 });
    await delay(30); // 让 onEvent 注册与 emit 落地
    assert.deepEqual(emits.map(e => [e.label, e.event]), [['editor-1', 'app-quit-request']],
      '应向分离窗口发 app-quit-request');
    // 分离窗口收口完成 → ready
    await handlers['app-quit-ready']({ payload: { label: 'editor-1' } });
    const ok = await p;
    assert.equal(ok, true, '全 ready 应回 true(quitApp 由 handleAppClose 调用方负责)');

    const main = JSON.parse(w.localStorage.getItem('tizumark-session'));
    assert.ok(main.tabs.some(t => t.filePath === 'D:/d.md'), '分离窗口文件应并入主会话');
    assert.equal(w.localStorage.getItem('tizumark-session-editor-1'), null, 'editor 会话键应清除');
    assert.equal(w.localStorage.getItem(MW.HANDOFF_PREFIX + 'editor-2'), null, '残留交接键应清除');
  } finally { cleanup(w); }
});

test('quit: 任一 aborted → 不退出、不清键', async () => {
  const { w, ed, handlers, quitCount } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => ['editor-1', 'editor-2'];
    w.localStorage.setItem('tizumark-session-editor-1', JSON.stringify({ version: 2, tabs: [{ filePath: 'D:/x.md' }] }));
    const p = ed.coordinateQuit({ timeoutMs: 2000 });
    await delay(30);
    await handlers['app-quit-ready']({ payload: { label: 'editor-1' } });
    await handlers['app-quit-aborted']({ payload: { label: 'editor-2' } });
    const ok = await p;
    assert.equal(ok, false, 'aborted 应使整体不退出');
    assert.equal(quitCount(), 0, '不应调用 quitApp');
    assert.ok(w.localStorage.getItem('tizumark-session-editor-1'), 'editor 会话键保留');
  } finally { cleanup(w); }
});

test('quit: 超时 → 不退出', async () => {
  const { w, ed, quitCount } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => ['editor-1'];
    const p = ed.coordinateQuit({ timeoutMs: 120 });
    const ok = await p;
    assert.equal(ok, false, '窗口无响应应超时放弃');
    assert.equal(quitCount(), 0);
  } finally { cleanup(w); }
});

test('quit: detached handleAppClose 保存 → 落 label 键 → 只关自己不触 quit', async () => {
  const { w, ed, handlers, emits, quitCount } = await makeEditor();
  try {
    let destroyed = 0;
    w.TauriApi.currentWindow = () => ({ label: 'editor-1', destroy: async () => { destroyed++; }, close: async () => {} });
    w.TauriApi.listEditorWindows = async () => ['editor-1'];
    w.TauriApi.writeFile = async () => {}; // batchSaveTabs 落盘
    ed._detachedLabel = 'editor-1';
    ed._quitRequested = true; // 模拟收到主窗口 app-quit-request
    ed.showSaveDialog = async () => 'save';
    ed.tabs = [Object.assign(new w.TMConst.Tab('d.md', 'old', 'D:/d.md'), { content: 'new' })];

    await ed.handleAppClose();
    assert.equal(destroyed, 1, '应销毁自身窗口');
    assert.equal(quitCount(), 0, '分离窗口绝不调 quitApp');
    assert.ok(w.localStorage.getItem('tizumark-session-editor-1'), '会话应落 label 键');
    assert.deepEqual(emits.filter(e => e.event === 'app-quit-ready').map(e => e.label), ['main'],
      '收口完成应向主窗口上报 ready');
  } finally { cleanup(w); }
});

test('quit: detached handleAppClose 取消 → 上报 aborted、窗口保留', async () => {
  const { w, ed, handlers, emits, quitCount } = await makeEditor();
  try {
    let destroyed = 0;
    w.TauriApi.currentWindow = () => ({ label: 'editor-1', destroy: async () => { destroyed++; }, close: async () => {} });
    ed._detachedLabel = 'editor-1';
    ed._quitRequested = true;
    ed.showSaveDialog = async () => 'cancel';
    ed.tabs = [Object.assign(new w.TMConst.Tab('d.md', 'old', 'D:/d.md'), { content: 'new' })];

    await ed.handleAppClose();
    assert.equal(destroyed, 0, '取消后窗口保留');
    assert.equal(quitCount(), 0);
    assert.deepEqual(emits.filter(e => e.event === 'app-quit-aborted').map(e => e.label), ['main'],
      '取消应向主窗口上报 aborted');
  } finally { cleanup(w); }
});

test('quit: mergeDetachedSessions 烟测(委托 multi-window 纯函数)', () => {
  const merged = MW.mergeDetachedSessions(
    { version: 2, tabs: [{ filePath: 'D:/a.md' }] },
    [{ tabs: [{ filePath: 'D:/b.md' }] }],
  );
  assert.deepEqual(merged.tabs.map(t => t.filePath), ['D:/a.md', 'D:/b.md']);
});

test('quit: ready/aborted 监听先于请求发出(不与注册竞速)', async () => {
  const { w, ed, handlers, emits } = await makeEditor();
  try {
    w.TauriApi.listEditorWindows = async () => ['editor-1'];
    w.TauriApi.emitTo = async (label, event, payload) => {
      if (event === 'app-quit-request') {
        assert.ok(handlers['app-quit-ready'], 'app-quit-ready 监听必须先于请求发出');
        assert.ok(handlers['app-quit-aborted'], 'app-quit-aborted 监听必须先于请求发出');
      }
      emits.push({ label, event, payload });
    };
    const p = ed.coordinateQuit({ timeoutMs: 1500 });
    await delay(30);
    await handlers['app-quit-ready']({ payload: { label: 'editor-1' } });
    const ok = await p;
    assert.equal(ok, true);
  } finally { cleanup(w); }
});

test('quit: detached 关闭流程异常不砖窗(_closingWindow 复位)', async () => {
  const { w, ed } = await makeEditor();
  try {
    let destroyed = 0;
    w.TauriApi.currentWindow = () => ({ label: 'editor-1', destroy: async () => { destroyed++; }, close: async () => {} });
    ed._detachedLabel = 'editor-1';
    ed.tabs = [Object.assign(new w.TMConst.Tab('d.md', 'old', 'D:/d.md'), { content: 'new' })];
    ed.showSaveDialog = async () => { throw new Error('dialog crash'); };
    await ed.handleAppClose();
    assert.equal(destroyed, 0, '异常时窗口保留');
    ed.showSaveDialog = async () => 'discard';
    await ed.handleAppClose();
    assert.equal(destroyed, 1, '标志复位后关闭流程可达');
  } finally { cleanup(w); }
});

test('quit: forceQuit 协调被拒 → 主会话键不被清,失败可见', async () => {
  const { w, ed, handlers, quitCount } = await makeEditor();
  try {
    const statuses = [];
    ed.setStatus = (m) => statuses.push(m);
    w.TauriApi.listEditorWindows = async () => ['editor-1'];
    w.localStorage.setItem('tizumark-session', JSON.stringify({
      version: 2, tabs: [{ filePath: 'D:/a.md', name: 'a.md' }], emptyTabs: false,
    }));
    ed.settings.clearTabsOnQuit = true;
    ed.tabs = []; // 主窗口无未保存,跳过自身保存询问
    const p = ed.handleAppClose({ forceQuit: true });
    await delay(30);
    await handlers['app-quit-aborted']({ payload: { label: 'editor-1' } });
    await p;
    assert.equal(quitCount(), 0, '协调被拒不得退出');
    assert.ok(w.localStorage.getItem('tizumark-session'), '被拒退出不得清主会话键(clearTabsOnQuit 先于协调是终审 Important 6)');
    assert.ok(statuses.length > 0, '协调失败应对用户可见');
  } finally { cleanup(w); }
});
