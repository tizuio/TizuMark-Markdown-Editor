// 分离窗口 boot 分叉回归测试(tab-tearoff-window Task 7):
// - sessionKey 按窗口拆键(主窗口默认键 / detached label 键)
// - saveSession 落对应键
// - restoreDetachedTab 从交接负载重建 Tab(_loaded=true 不读盘、savedContent/光标/滚动随迁、
//   kind 归一、_loadError 报错)
// - app.js boot 分叉源码护栏(parseBootParams / readHandoff / sweepStaleHandoffs / file-open 门)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');
const MW = require('../src/modules/multi-window.js');
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

async function makeEditor() {
  const { w, getInitErr } = await buildEnv({ captureInitErr: true });
  await delay(300);
  return { w, ed: w.editor, getInitErr };
}

test('boot: parseBootParams 烟测(委托 multi-window 纯函数)', () => {
  assert.equal(MW.parseBootParams('?label=editor-2').detached, true);
  assert.equal(MW.parseBootParams('').detached, false);
});

test('boot: sessionKey 主窗口默认键', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null);
    assert.equal(ed.sessionKey(), 'tizumark-session');
  } finally { cleanup(w); }
});

test('boot: sessionKey detached 按 label 拆键 + saveSession 落对应键', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._detachedLabel = 'editor-1';
    assert.equal(ed.sessionKey(), 'tizumark-session-editor-1');
    await ed.addTab('a.md', '# A', 'D:/a.md');
    ed.saveSession();
    assert.ok(w.localStorage.getItem('tizumark-session-editor-1'), '分离窗口会话应落 label 键');
  } finally { cleanup(w); }
});

test('boot: restoreDetachedTab 完整重建不读盘(内容/savedContent/光标/滚动随迁)', async () => {
  const { w, ed } = await makeEditor();
  try {
    let readCalls = 0;
    const orig = ed.readFileNormalized.bind(ed);
    ed.readFileNormalized = async (...a) => { readCalls++; return orig(...a); };
    const tab = ed.restoreDetachedTab({
      name: 'draft.md', content: '## 未保存', savedContent: '', filePath: null,
      kind: 'markdown', cursorPos: { line: 3, ch: 2 }, scrollPos: { top: 44, left: 0 },
      previewScrollTop: 12, fileMeta: null, pendingExternalChange: false, _loaded: true,
    });
    assert.equal(tab.content, '## 未保存');
    assert.equal(tab.savedContent, '', 'savedContent 随迁(isModified 语义成立)');
    assert.equal(tab.filePath, null);
    assert.equal(tab._loaded, true, '内容已随迁,不读盘');
    assert.equal(readCalls, 0);
    assert.deepEqual(tab.cursorPos, { line: 3, ch: 2 });
    assert.deepEqual(tab.scrollPos, { top: 44, left: 0 });
    assert.equal(tab.previewScrollTop, 12);
    assert.equal(tab.isModified, true);
  } finally { cleanup(w); }
});

test('boot: restoreDetachedTab kind 归一(图片路径不当 markdown)', async () => {
  const { w, ed } = await makeEditor();
  try {
    const tab = ed.restoreDetachedTab({
      name: 'pic.png', content: '', savedContent: '', filePath: 'D:/pic.png',
      kind: 'markdown', _loaded: true,
    });
    assert.equal(tab.kind, 'image', 'classifyFile 应归一为 image');
  } finally { cleanup(w); }
});

test('boot: restoreDetachedTab _loadError 透传并报错', async () => {
  const { w, ed } = await makeEditor();
  try {
    let reported = null;
    ed.reportError = (code, opts) => { reported = code; };
    const tab = ed.restoreDetachedTab({
      name: 'gone.md', content: '', savedContent: '', filePath: 'D:/gone.md',
      kind: 'markdown', _loaded: true, _loadError: true,
    });
    assert.equal(tab._loadError, true);
    assert.equal(reported, 'E_NOT_FOUND', '源窗口加载失败态应在分离窗口可见化');
  } finally { cleanup(w); }
});

test('boot: app.js 分叉护栏(parseBootParams/交接消费/清扫/file-open 门)', () => {
  assert.ok(APP.includes('TMMultiWindow.parseBootParams'), 'boot 应解析窗口参数');
  assert.ok(APP.includes('TMMultiWindow.readHandoff'), 'detached 分支应消费交接键');
  assert.ok(APP.includes('TMMultiWindow.clearHandoff'), '消费后应清交接键');
  assert.ok(APP.includes('TMMultiWindow.sweepStaleHandoffs'), '主窗口 boot 应清扫残留交接键');
  assert.ok(/if\s*\(!boot\.detached\)[\s\S]{0,80}onEvent\('file-open'/.test(APP),
    'file-open 监听必须包在 !boot.detached 内(否则分离窗口重复开文件)');
  assert.ok(APP.includes('restoreDetachedTab'), 'detached 分支应经 restoreDetachedTab 重建');
});
