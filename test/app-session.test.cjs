// 会话持久化盲点测试（整理测试库时补充）：
// saveSession 把有 filePath 的标签写入 localStorage，loadSession 解析回来。
// 不依赖 Tauri，jsdom 自带 localStorage。

const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

test('session: saveSession 写入 localStorage 且 loadSession 可解析', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  // 加一个带路径的标签（saveSession 只保留有 filePath 的）
  await ed.addTab('doc1.md', '# 标题一', 'C:/work/doc1.md');
  ed.workspaceFolder = 'C:/work';
  ed.expandedFolders = new Set(['C:/work/sub']);

  ed.saveSession();

  const raw = w.localStorage.getItem('tizumark-session');
  assert.ok(raw, 'saveSession 应写入 tizumark-session');
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.version, 2, '会话版本应为 2');
  assert.strictEqual(parsed.emptyTabs, false, '有文档时不应标记为空态');
  assert.strictEqual(parsed.activeFilePath, 'C:/work/doc1.md', '活动文件路径应正确');
  assert.ok(Array.isArray(parsed.tabs) && parsed.tabs.length === 1, '应保存 1 个标签');
  assert.strictEqual(parsed.tabs[0].filePath, 'C:/work/doc1.md', '标签 filePath 应正确');
  assert.strictEqual(parsed.workspaceFolder, 'C:/work', '工作区路径应正确');
  assert.deepStrictEqual(parsed.expandedFolders, ['C:/work/sub'], '展开目录应正确序列化');

  // loadSession 应能解析回来
  const loaded = ed.loadSession();
  assert.strictEqual(loaded.version, 2, 'loadSession 应解析出 version 2');
  assert.strictEqual(loaded.tabs[0].filePath, 'C:/work/doc1.md', 'loadSession 应解析出标签');
  cleanup(w);
});

test('session: 无 filePath 的标签不会被保存', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  // 默认只有一个无路径的 untitled 标签
  ed.saveSession();
  const parsed = JSON.parse(w.localStorage.getItem('tizumark-session'));
  assert.strictEqual(parsed.tabs.length, 0, '无 filePath 的标签不应写入会话');
  // 关键：tabs:[] 但仍有 1 个未保存的空白标签时，不能被误判成「关光了」
  assert.strictEqual(parsed.emptyTabs, false, '仍有标签时不应标记为空态');
  cleanup(w);
});

test('session: 损坏的会话数据 loadSession 返回 null 不抛错', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  w.localStorage.setItem('tizumark-session', '{ 这不是合法JSON');
  assert.strictEqual(ed.loadSession(), null, '坏数据应安全返回 null');
  cleanup(w);
});
