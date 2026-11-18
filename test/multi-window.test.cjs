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

test('tearOffPoint: 窗口边界外(留 margin 容差)判撕离', () => {
  // jsdom 内部坐标(窗内)不撕离
  assert.equal(MW.tearOffPoint(500, 300, 1000, 700), false);
  assert.equal(MW.tearOffPoint(0, 0, 1000, 700), false);
  // 越界(默认 margin 8)
  assert.equal(MW.tearOffPoint(-20, 300, 1000, 700), true, '左越界');
  assert.equal(MW.tearOffPoint(500, -20, 1000, 700), true, '上越界');
  assert.equal(MW.tearOffPoint(1020, 300, 1000, 700), true, '右越界');
  assert.equal(MW.tearOffPoint(500, 720, 1000, 700), true, '下越界');
  // 容差内(±8px)不撕离,防贴边误触
  assert.equal(MW.tearOffPoint(-5, 300, 1000, 700), false);
  assert.equal(MW.tearOffPoint(500, 705, 1000, 700), false);
});

test('tearOffGeometry: 落点即新窗左上角(窗口原点+窗口内落点),和为负才钳 0', () => {
  const g = MW.tearOffGeometry({ x: 100, y: 80 }, { dropClientX: 300, dropClientY: 250 }, 1200, 800);
  assert.deepEqual(g, { x: 400, y: 330, width: 1200, height: 800 });
  // 窗内负落点 = 拖到源窗口左侧/上方松手:和为正时跟手,不钳
  const g2 = MW.tearOffGeometry({ x: 100, y: 80 }, { dropClientX: -50, dropClientY: -30 }, 1200, 800);
  assert.deepEqual(g2, { x: 50, y: 50, width: 1200, height: 800 });
  // 和为负(源窗口本身在屏外)才钳 0
  const g3 = MW.tearOffGeometry({ x: -100, y: -80 }, { dropClientX: -50, dropClientY: -30 }, 1200, 800);
  assert.deepEqual(g3, { x: 0, y: 0, width: 1200, height: 800 });
});

test('clampGeometry: 超出显示器右/下边界时贴边钳制(评审 P2-6)', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(
    MW.clampGeometry({ x: 1503, y: 399, width: 1232, height: 818 }, bounds),
    { x: 688, y: 262, width: 1232, height: 818 },
  );
  // 无显示器信息(浏览器/jsdom 降级) → 仅负坐标钳 0
  assert.deepEqual(
    MW.clampGeometry({ x: -5, y: 30, width: 1200, height: 800 }, null),
    { x: 0, y: 30, width: 1200, height: 800 },
  );
  // 窗口大于工作区 → 贴工作区左上,不产生负坐标
  assert.deepEqual(
    MW.clampGeometry({ x: 500, y: 500, width: 1200, height: 800 }, { x: 0, y: 24, width: 1024, height: 700 }),
    { x: 0, y: 24, width: 1200, height: 800 },
  );
});

test('monitorUnionBounds: 返回所有显示器的物理并集,无有效显示器返回 null', () => {
  const mons = [
    { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
    { position: { x: 1920, y: 0 }, size: { width: 2560, height: 1440 } },
    { position: { x: -1280, y: 0 }, size: { width: 1280, height: 1024 } },
  ];
  assert.deepEqual(MW.monitorUnionBounds(mons), { x: -1280, y: 0, width: 5760, height: 1440 });
  assert.equal(MW.monitorUnionBounds(null), null);
  assert.equal(MW.monitorUnionBounds([{ position: { x: 0, y: 0 }, size: { width: 0, height: 0 } }]), null);
});
