/**
 * 系统挂起（笔记本合盖睡眠）→ 唤醒后编辑器无响应 的回归测试
 *
 * 背景：睡眠会掐断 WebView2 的定时器、requestAnimationFrame 与 IME 的
 * compositionend，项目里多处「等异步链落地才复位」的一次性标志因此永久卡住：
 *  - CM5 ContentEditableInput.composing 残留 → 'input' 处理器直接 return，
 *    打字进不了文档模型（codemirror.js:8893）；
 *  - readFromDOMSoon 的 80ms 定时器丢失 → readDOMTimeout 恒非 null，
 *    后续所有输入被 readFromDOMSoon 早退挡住（codemirror.js:9195）；
 *  - 预览渲染链 await rAF 永不 resolve → finally 不执行，pane-loading 遮罩与
 *    _canScroll 双锁永久残留（preview-controller.js）。
 *
 * 真机无法复现，故用 jsdom 模拟「长挂起 + 事件丢失」验证复位与超时兜底。
 * 本文件不依赖 test/helpers/app-env.cjs，独立起 jsdom，避免共享定时器跟踪干扰。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const dom = new JSDOM(
  '<!DOCTYPE html><html><body><div id="pane-loading" class="hidden"></div></body></html>',
  { pretendToBeVisual: true }
);
global.window = dom.window;
global.document = dom.window.document;
global.TMConst = { Tab: function Tab() {} };

const { mixin } = require('../src/modules/lifecycle.js');
const { nextFrame, onFrameOrTimeout } = require('../src/controllers/preview-controller.js');

// 构造一个「挂在唤醒前那一刻」的 app：所有一次性标志都处于卡死态
function makeApp() {
  const input = {
    composing: { done: false },
    readDOMTimeout: 8123,
    polling: { id: 0, time: 0, set() {} },
    forceCompositionEnd() {
      this.composing = null;
      this.forceEndCalled = (this.forceEndCalled || 0) + 1;
    },
    readFromDOMSoon() { this.readSoonCalled = (this.readSoonCalled || 0) + 1; },
    receivedFocus() { this.receivedFocusCalled = (this.receivedFocusCalled || 0) + 1; },
  };
  const app = {
    cm: { display: { input }, options: { pollInterval: 100 }, state: { focused: true } },
    _canScroll: { editor: false, preview: false },
    _wysiwygComposing: true,
    _wysiwygPreRendering: true,
    _wysiwygPreRenderLoadOpen: true,
    _paneLoadingCount: 3,
    _watching: true,
    _resumeScroll() { this._canScroll.editor = true; this._canScroll.preview = true; },
    _cancelWysiwygPreRender() { this.cancelCalled = true; },
  };
  Object.assign(app, mixin);
  return app;
}

// 唤醒恢复刻意不新增常驻定时器（见 T8 契约），保留兼容清理入口以便日后调整
const stop = (app) => { if (app._wakeHeartbeatTimer) clearInterval(app._wakeHeartbeatTimer); };

test('T1 长挂起后 visibilitychange 触发全量复位', () => {
  const app = makeApp();
  const loading = document.getElementById('pane-loading');
  loading.classList.remove('hidden');
  try {
    app.initWakeRecovery();
    app._wakeLastSeen = Date.now() - 3600000; // 合盖 1 小时
    document.dispatchEvent(new dom.window.Event('visibilitychange'));

    const input = app.cm.display.input;
    assert.equal(input.composing, null, 'CM5 composing 必须清掉');
    assert.equal(input.forceEndCalled, 1, '应走 CM5 官方 forceCompositionEnd');
    assert.equal(input.readDOMTimeout, null, '挂起的 readDOMTimeout 必须清掉');
    assert.equal(input.readSoonCalled, 1, '必须重新排一次 DOM 读取');
    assert.equal(app._wysiwygComposing, false, '项目层组合标志必须复位');
    assert.equal(app._canScroll.editor, true, '编辑器滚动锁必须解开');
    assert.equal(app._canScroll.preview, true, '预览滚动锁必须解开');
    assert.equal(app.cancelCalled, true, '在飞的所见即所得预渲染必须取消');
    assert.equal(app._wysiwygPreRendering, false);
    assert.equal(app._wysiwygPreRenderLoadOpen, false);
    assert.equal(app._paneLoadingCount, 0, 'loading 引用计数必须归零');
    assert.ok(loading.classList.contains('hidden'), 'pane-loading 遮罩必须撤掉');
    assert.equal(app._watching, false, '外部变更轮询标志必须复位');
    assert.ok(app._wakeRecoveredAt > 0, '冷却窗口必须设置');
    assert.equal(app._wakeLog.length, 1);
    assert.ok(app._wakeLog[0].cleared.includes('cm-composing'));
    assert.ok(app._wakeLog[0].cleared.includes('cm-read-dom-timer'));
  } finally { stop(app); }
});

test('T2 普通切窗口（<30s）不触发复位，正常路径零副作用', () => {
  const app = makeApp();
  try {
    app.initWakeRecovery();
    window.dispatchEvent(new dom.window.Event('focus'));
    assert.equal(app._wakeLog.length, 0);
    assert.equal(app._wysiwygComposing, true, '正常组字中的标志不得被误清');
    assert.equal(app._canScroll.editor, false);
  } finally { stop(app); }
});

test('T3 墙钟大幅回拨时重建 CM5 Delayed 轮询', () => {
  const app = makeApp();
  try {
    app.initWakeRecovery();
    app.cm.display.input.polling.id = 999;
    app._wakeLastSeen = Date.now() + 60000; // 唤醒后系统时间被往回拨
    window.dispatchEvent(new dom.window.Event('focus'));
    assert.equal(app.cm.display.input.polling.id, 0);
    assert.equal(app.cm.display.input.receivedFocusCalled, 1);
    assert.equal(app._wakeLog.length, 1);
    assert.ok(app._wakeLog[0].cleared.includes('cm-polling'));
  } finally { stop(app); }
});

test('T4 无任何窗口事件时心跳兜底，且重复触发只复位一次', () => {
  const app = makeApp();
  try {
    app.initWakeRecovery();
    app._wakeLastSeen = Date.now() - 3600000;
    app._wakeProbe('heartbeat');
    assert.equal(app._wakeLog.length, 1);
    app._wakeProbe('focus'); // gap 已被刷新，天然去重
    assert.equal(app._wakeLog.length, 1);
    assert.equal(app._wakeLog[0].reason, 'heartbeat');
  } finally { stop(app); }
});

test('T5 rAF 永久停摆时 nextFrame 仍由超时兜底落地', async () => {
  const orig = global.requestAnimationFrame;
  global.requestAnimationFrame = () => { /* 模拟挂起：永不回调 */ };
  try {
    const t0 = Date.now();
    await nextFrame();
    assert.ok(Date.now() - t0 < 1000, '不得无限挂起');
  } finally { global.requestAnimationFrame = orig; }
});

test('T6 rAF 停摆时滚动锁恢复回调仍会执行', async () => {
  const orig = global.requestAnimationFrame;
  global.requestAnimationFrame = () => { /* 永不回调 */ };
  try {
    let called = false;
    onFrameOrTimeout(() => { called = true; });
    await new Promise(r => setTimeout(r, 260));
    assert.equal(called, true);
  } finally { global.requestAnimationFrame = orig; }
});

test('T7 rAF 正常时 nextFrame 立即落地，不改变渲染时序', async () => {
  const orig = global.requestAnimationFrame;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  try {
    const t0 = Date.now();
    await nextFrame();
    assert.ok(Date.now() - t0 < 100, '正常环境不得等满 200ms 兜底');
  } finally { global.requestAnimationFrame = orig; }
});

test('T8 接线与兜底防回退（静态契约）', () => {
  const appSrc = read('src/app.js');
  const lifeSrc = read('src/modules/lifecycle.js');
  const notifySrc = read('src/modules/notify.js');
  const pcSrc = read('src/controllers/preview-controller.js');

  assert.ok(
    /initAppLifecycleEvents\(\)\s*\{[\s\S]{0,400}this\.initWakeRecovery\(\)/.test(appSrc),
    '构造期必须接入唤醒恢复'
  );
  assert.ok(lifeSrc.includes("document.addEventListener('visibilitychange'"));
  assert.ok(lifeSrc.includes("window.addEventListener('focus'"));
  assert.ok(!lifeSrc.includes('setInterval('), '唤醒恢复不得新增常驻定时器');
  const probeIdx = notifySrc.indexOf("this._wakeProbe('heartbeat')");
  const cooldownIdx = notifySrc.indexOf('_wakeRecoveredAt');
  assert.ok(probeIdx > -1 && cooldownIdx > probeIdx,
    '心跳必须搭在既有 1.5s 轮询上，且位于冷却检查之前');
  assert.ok(/resizeTimer\s*=\s*setTimeout/.test(appSrc), 'resize 必须防抖');
  assert.ok(notifySrc.includes('guardedPass') && notifySrc.includes('_wakeRecoveredAt'),
    '外部变更轮询必须尊重唤醒冷却窗口');
  assert.ok(notifySrc.includes("window.addEventListener('focus', guardedPass)"));
  assert.ok(!pcSrc.includes('new Promise(r => requestAnimationFrame'),
    '预览渲染链不得再出现裸 await rAF');
  assert.ok(pcSrc.includes('onFrameOrTimeout') && pcSrc.includes('nextFrame'));
  assert.ok(pcSrc.includes('module.exports = { PreviewController, nextFrame, onFrameOrTimeout }'));
});
