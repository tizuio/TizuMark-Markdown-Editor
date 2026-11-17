// multi-window.js 纯函数单测,不加载 app.js(范式同 preview-window.test.cjs)。
// 覆盖:label 分配(空/最大N+1/跳号)/几何级联(偏移/负钳0/最小尺寸)/boot 参数解析/
//       交接键写入读取清除/清扫只清 editor-*/会话聚合去重/detached label 边界。
// 交接键读写用注入 mock storage(标准 length+key+getItem+setItem+removeItem 接口)。

const test = require('node:test');
const assert = require('node:assert/strict');
const MW = require('../src/modules/multi-window.js');

// 标准 localStorage 接口的内存 mock(sweep 遍历走 length+key,不用 Object.keys)
function makeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

test('nextEditorLabel: 无 editor 窗口 → editor-1', () => {
  assert.equal(MW.nextEditorLabel([]), 'editor-1');
  assert.equal(MW.nextEditorLabel(['main']), 'editor-1');
});

test('nextEditorLabel: 最小空位(1,3 存在 → 2;连号 1 存在 → 2)', () => {
  assert.equal(MW.nextEditorLabel(['editor-1']), 'editor-2');
  assert.equal(MW.nextEditorLabel(['editor-3', 'editor-1', 'main']), 'editor-2');
});

test('nextEditorLabel: 复用空位(1,3 存在 → 2)', () => {
  assert.equal(MW.nextEditorLabel(['editor-1', 'editor-3']), 'editor-2');
});

test('cascadeGeometry: 按 slot 级联偏移 28px', () => {
  const base = { x: 100, y: 80, width: 1200, height: 800 };
  assert.deepEqual(MW.cascadeGeometry(base, 0), { x: 100, y: 80, width: 1200, height: 800 });
  const g3 = MW.cascadeGeometry(base, 3);
  assert.equal(g3.x, 100 + 3 * 28);
  assert.equal(g3.y, 80 + 3 * 28);
});

test('cascadeGeometry: 偏移后负坐标钳 0,尺寸不小于 800×600', () => {
  // -10 + 28 = 18:偏移先于钳 0(浅负坐标在屏内,不重置);深负坐标才落到 0
  const g = MW.cascadeGeometry({ x: -10, y: -5, width: 400, height: 300 }, 1);
  assert.equal(g.x, 18);
  assert.equal(g.y, 23);
  assert.equal(g.width, 800);
  assert.equal(g.height, 600);
  const deep = MW.cascadeGeometry({ x: -500, y: -300, width: 1200, height: 800 }, 1);
  assert.equal(deep.x, 0);
  assert.equal(deep.y, 0);
});

test('parseBootParams: ?label=editor-2 → detached', () => {
  assert.deepEqual(MW.parseBootParams('?label=editor-2'), { detached: true, label: 'editor-2' });
});

test('parseBootParams: 非 editor 前缀与无参数 → 非 detached', () => {
  assert.equal(MW.parseBootParams('?label=main').detached, false);
  assert.equal(MW.parseBootParams('').detached, false);
  assert.equal(MW.parseBootParams('?other=1').detached, false);
});

test('isDetachedLabel: editor-<数字> 真,editor- 无编号假', () => {
  assert.equal(MW.isDetachedLabel('editor-1'), true);
  assert.equal(MW.isDetachedLabel('editor-12'), true);
  assert.equal(MW.isDetachedLabel('editor-'), false);
  assert.equal(MW.isDetachedLabel('main'), false);
  assert.equal(MW.isDetachedLabel(''), false);
});

test('buildHandoffPayload: 含 savedContent/pendingExternalChange(未保存未命名 tab 可迁)', () => {
  const tab = {
    name: '未命名1', content: '## 草稿', savedContent: '', filePath: null,
    kind: 'markdown', cursorPos: { line: 2, ch: 3 },
    scrollPos: { top: 40, left: 0 }, previewScrollTop: 15,
    fileMeta: null, pendingExternalChange: false, _loaded: true,
  };
  const payload = MW.buildHandoffPayload(tab);
  assert.equal(payload.version, 1);
  assert.equal(payload.tab.savedContent, '');
  assert.equal(payload.tab.content, '## 草稿');
  assert.equal(payload.tab.filePath, null);
  assert.deepEqual(payload.tab.cursorPos, { line: 2, ch: 3 });
  assert.deepEqual(payload.tab.scrollPos, { top: 40, left: 0 });
  assert.equal(payload.tab.previewScrollTop, 15);
});

test('writeHandoff → readHandoff 往返,clearHandoff 删键', () => {
  const storage = makeStorage();
  const tab = { name: 'a.md', content: 'x', savedContent: 'x', filePath: 'D:/a.md', kind: 'markdown' };
  MW.writeHandoff('editor-1', tab, storage);
  const key = MW.HANDOFF_PREFIX + 'editor-1';
  assert.equal(storage.getItem(key) !== null, true, '键应存在');
  const read = MW.readHandoff('editor-1', storage);
  assert.equal(read.tab.filePath, 'D:/a.md');
  MW.clearHandoff('editor-1', storage);
  assert.equal(storage.getItem(key), null);
  assert.equal(MW.readHandoff('editor-1', storage), null);
});

test('readHandoff: 键缺失/损坏 JSON → null(不抛)', () => {
  const storage = makeStorage();
  assert.equal(MW.readHandoff('editor-9', storage), null);
  storage.setItem(MW.HANDOFF_PREFIX + 'editor-9', '{not-json');
  assert.equal(MW.readHandoff('editor-9', storage), null);
});

test('sweepStaleHandoffs: 只清 editor-* 交接键,返回被删键,其余键不动', () => {
  const storage = makeStorage();
  MW.writeHandoff('editor-1', { name: 'a' }, storage);
  MW.writeHandoff('editor-2', { name: 'b' }, storage);
  storage.setItem('tizumark-session', '{}');
  storage.setItem(MW.HANDOFF_PREFIX + 'main', 'junk'); // 非 editor 编号,不清
  const removed = MW.sweepStaleHandoffs(storage);
  assert.deepEqual(removed.sort(), [
    MW.HANDOFF_PREFIX + 'editor-1',
    MW.HANDOFF_PREFIX + 'editor-2',
  ]);
  assert.equal(storage.getItem('tizumark-session'), '{}');
  assert.equal(storage.getItem(MW.HANDOFF_PREFIX + 'main'), 'junk');
});

test('mergeDetachedSessions: 追加 filePath 去重,main 字段不变', () => {
  const main = {
    version: 2, emptyTabs: false, activeFilePath: 'D:/a.md',
    tabs: [{ filePath: 'D:/a.md', name: 'a.md' }],
    workspaceFolder: 'D:/work', expandedFolders: ['x'],
  };
  const d1 = { tabs: [{ filePath: 'D:/b.md', name: 'b.md' }, { filePath: 'D:/a.md', name: 'a.md' }] };
  const d2 = { tabs: [{ filePath: 'D:/b.md', name: 'b.md' }, { filePath: 'D:/c.md', name: 'c.md' }] };
  const merged = MW.mergeDetachedSessions(main, [d1, d2]);
  assert.deepEqual(merged.tabs.map(t => t.filePath), ['D:/a.md', 'D:/b.md', 'D:/c.md']);
  assert.equal(merged.activeFilePath, 'D:/a.md');
  assert.equal(merged.workspaceFolder, 'D:/work');
  assert.equal(merged.version, 2);
});
