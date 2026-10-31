// 标签页右键「重命名」逻辑测试（2026-10-31 新增）：
//   - 未保存标签：仅改显示名 tab.name，不碰磁盘（不调 renamePath）
//   - 已保存文件：走 TauriApi.renamePath 重命名磁盘，并同步 tab.filePath/name + 持久化
//   - 取消 / 同名冲突 / 非法文件名 均不修改、不重命名
//   - 已保存文件漏输扩展名时自动补回原扩展名
//   - executeMenuAction('tab-rename') 经 _contextTabIndex 正确分发
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

async function makeEditor() {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  return { w, ed: w.editor };
}

// 屏蔽 UI/渲染副作用，聚焦逻辑；toasts 与关键调用可被断言
function stubUi(ed, { prompt } = {}) {
  ed.showPromptDialog = prompt || (async () => null);
  ed.showToast = (msg) => ed.__toasts.push(msg);
  ed.setStatus = () => {};
  ed.renderFolderTree = async () => { ed.__renderTree++; };
  ed.updateTabBar = () => { ed.__updateTabBar++; };
  ed.saveSession = () => { ed.__saveSession++; };
  ed.refreshFileMeta = async () => {};
}

test('tab-rename: 未保存标签仅改显示名，不调 renamePath', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => '我的笔记' });
    w.TauriApi.renamePath = async (a) => { renames.push(a); };
    ed.__toasts = []; ed.__updateTabBar = 0; ed.__saveSession = 0;
    ed.tabs = [{ filePath: null, name: '未命名1' }];
    await ed.renameTabByIndex(0);
    assert.strictEqual(renames.length, 0, '未保存标签不应调用 renamePath（不动磁盘）');
    assert.strictEqual(ed.tabs[0].name, '我的笔记', '未保存标签应更新显示名');
    assert.strictEqual(ed.tabs[0].filePath, null, '未保存标签 filePath 仍为 null');
    assert.strictEqual(ed.__updateTabBar, 1, '应刷新标签栏');
  } finally { cleanup(w); }
});

test('tab-rename: 已保存文件走 TauriApi.renamePath 并同步 tab + 持久化', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => 'b.md' });
    w.TauriApi.renamePath = async (a) => { renames.push(a); };
    w.TauriApi.listDir = async () => []; // pathExists：新名不存在
    ed.__toasts = []; ed.__saveSession = 0; ed.__updateTabBar = 0; ed.__renderTree = 0;
    ed.tabs = [{ filePath: '/root/a.md', name: 'a.md' }];
    await ed.renameTabByIndex(0);
    assert.strictEqual(renames.length, 1, '应经 TauriApi.renamePath 调用一次');
    assert.strictEqual(renames[0].from, '/root/a.md');
    assert.strictEqual(renames[0].to, '/root/b.md');
    assert.strictEqual(ed.tabs[0].filePath, '/root/b.md', 'tab 路径应同步');
    assert.strictEqual(ed.tabs[0].name, 'b.md', 'tab 显示名应同步');
    assert.strictEqual(ed.__saveSession, 1, '应持久化会话');
    assert.strictEqual(ed.__updateTabBar, 1, '应刷新标签栏');
    assert.strictEqual(ed.__renderTree, 1, 'workspace 内应刷新文件树');
  } finally { cleanup(w); }
});

test('tab-rename: 取消（prompt 返回 null）时不改名、不重命名', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => null });
    w.TauriApi.renamePath = async (a) => { renames.push(a); };
    ed.__toasts = [];
    ed.tabs = [{ filePath: '/root/a.md', name: 'a.md' }];
    await ed.renameTabByIndex(0);
    assert.strictEqual(renames.length, 0, '取消不应调用 renamePath');
    assert.strictEqual(ed.tabs[0].name, 'a.md', '取消后名字不变');
  } finally { cleanup(w); }
});

test('tab-rename: 同名冲突时提示且不重命名', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => 'b.md' });
    w.TauriApi.renamePath = async (a) => { renames.push(a); };
    // listDir：父目录已存在 b.md → pathExists 命中冲突
    w.TauriApi.listDir = async () => [{ name: 'b.md' }];
    ed.__toasts = [];
    ed.tabs = [{ filePath: '/root/a.md', name: 'a.md' }];
    await ed.renameTabByIndex(0);
    assert.strictEqual(renames.length, 0, '冲突时不应调用 renamePath');
    assert.ok(ed.__toasts.some(t => String(t).includes(ed.t('nameExists'))), '应提示名称已存在');
  } finally { cleanup(w); }
});

test('tab-rename: 非法文件名（含路径分隔符）提示且不重命名', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => 'a/b' });
    w.TauriApi.renamePath = async (a) => { renames.push(a); };
    w.TauriApi.listDir = async () => [];
    ed.__toasts = [];
    ed.tabs = [{ filePath: '/root/a.md', name: 'a.md' }];
    await ed.renameTabByIndex(0);
    assert.strictEqual(renames.length, 0, '非法名不应调用 renamePath');
    assert.ok(ed.__toasts.some(t => String(t).includes(ed.t('nameInvalid'))), '应提示非法文件名');
  } finally { cleanup(w); }
});

test('tab-rename: 已保存文件漏输扩展名时自动补回原扩展名', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => 'mynote' }); // 不带 .md
    w.TauriApi.renamePath = async (a) => { renames.push(a); };
    w.TauriApi.listDir = async () => [];
    ed.__toasts = [];
    ed.tabs = [{ filePath: '/root/note.md', name: 'note.md' }];
    await ed.renameTabByIndex(0);
    assert.strictEqual(renames.length, 1, '应调用 renamePath 一次');
    assert.strictEqual(renames[0].to, '/root/mynote.md', '漏输扩展名应自动补回 .md');
    assert.strictEqual(ed.tabs[0].name, 'mynote.md');
  } finally { cleanup(w); }
});

test('tab-rename: 越界 index 直接返回不报错', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => 'x' });
    w.TauriApi.renamePath = async (a) => { renames.push(a); };
    ed.tabs = [{ filePath: '/root/a.md', name: 'a.md' }];
    await ed.renameTabByIndex(5);
    await ed.renameTabByIndex(-1);
    assert.strictEqual(renames.length, 0, '越界 index 不应触发任何重命名');
  } finally { cleanup(w); }
});

test('executeMenuAction: tab-rename 经 _contextTabIndex 正确分发', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => 'b.md' });
    w.TauriApi.renamePath = async (a) => { renames.push(a); };
    w.TauriApi.listDir = async () => [];
    ed.__toasts = [];
    ed.tabs = [{ filePath: '/root/a.md', name: 'a.md' }, { filePath: '/root/c.md', name: 'c.md' }];
    ed._contextTabIndex = 1;
    ed.executeMenuAction('tab-rename');
    // executeMenuAction 是同步分发，但 renameTabByIndex 是 async，需等微任务
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(renames.length, 1, '应通过分发调用 renamePath');
    assert.strictEqual(renames[0].from, '/root/c.md', '应作用于 _contextTabIndex 指向的 tab');
  } finally { cleanup(w); }
});
