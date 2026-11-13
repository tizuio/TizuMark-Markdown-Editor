// 文件树并发重建回归：重复打开文件夹 / folder-changed 刷新 / 文件操作叠加时，
// 同一层目录不得被 append 两遍（用户截图实锤：01/03/04/06 等文件夹整组重复）。
// 根因：renderFolderTree 先清空 treeEl 再 await listDir，多个并发渲染各 append 一份。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

const ROOT = path.join(__dirname, '..');
const DIR = 'C:/work';

const mkEntries = (names, dir = DIR) => names.map((name, i) => ({
  name, path: dir + '/' + name, is_dir: true, mtime: i + 1, created: i + 1, size: 0,
}));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const labels = (w) => Array.from(w.document.querySelectorAll('#folder-tree > .tree-node > .tree-row .tree-label'))
  .map((el) => el.textContent);

async function setup() {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  ed.workspaceFolder = DIR;
  ed.expandedFolders = new Set();
  ed.showSidebar = () => {};
  ed.saveSession = () => {};
  ed.setStatus = () => {};
  return { w, ed };
}

test('文件树: 并发两次重建（重复打开文件夹）只渲染一份目录', async () => {
  const { w, ed } = await setup();
  try {
    const names = ['01.资源缓存', '03.两性文案', '04.文章摘录', '06.项目研究'];
    const gate = deferred();
    let calls = 0;
    w.TauriApi.listDir = async () => {
      calls++;
      await gate.promise;
      return { entries: mkEntries(names), truncated: false };
    };
    const p1 = ed.renderFolderTree();
    const p2 = ed.renderFolderTree();
    gate.resolve();
    await Promise.all([p1, p2]);
    assert.strictEqual(calls, 2, '应确实发生两次并发重建');
    assert.deepStrictEqual(labels(w), names, '目录不得整组重复');
  } finally { cleanup(w); }
});

test('文件树: 旧一轮渲染后恢复时必须作废，不能污染新一轮结果', async () => {
  const { w, ed } = await setup();
  try {
    const pending = [];
    w.TauriApi.listDir = async () => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    };
    const p1 = ed.renderFolderTree(); // seq 1，旧数据
    const p2 = ed.renderFolderTree(); // seq 2，新数据
    assert.strictEqual(pending.length, 2);
    pending[1].resolve({ entries: mkEntries(['NEW.md']), truncated: false });
    await delay(30);
    assert.deepStrictEqual(labels(w), ['NEW.md'], '新一轮应先落地');
    pending[0].resolve({ entries: mkEntries(['OLD-A', 'OLD-B']), truncated: false });
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(labels(w), ['NEW.md'], '后恢复的旧渲染必须被代次拦下');
  } finally { cleanup(w); }
});

test('文件树: 顺序重建仍正常，展开子目录在并发下也不重复', async () => {
  const { w, ed } = await setup();
  try {
    const names = ['a', 'b', 'c'];
    w.TauriApi.listDir = async () => ({ entries: mkEntries(names), truncated: false });
    await ed.renderFolderTree();
    await ed.renderFolderTree();
    assert.deepStrictEqual(labels(w), names, '顺序调用不得少渲染');

    const subPath = DIR + '/sub';
    ed.expandedFolders = new Set([subPath]);
    const gate = deferred();
    let calls = 0;
    w.TauriApi.listDir = async ({ path: p }) => {
      if (p === DIR) { calls++; await gate.promise; }
      return {
        entries: p === DIR
          ? mkEntries(['sub'])
          : [{ name: 'a.md', path: subPath + '/a.md', is_dir: false, mtime: 1, created: 1, size: 10 }],
        truncated: false,
      };
    };
    const q1 = ed.renderFolderTree();
    const q2 = ed.renderFolderTree();
    gate.resolve();
    await Promise.all([q1, q2]);
    assert.strictEqual(calls, 2);
    assert.strictEqual(w.document.querySelectorAll('#folder-tree > .tree-node').length, 1, '根层只保留一份');
    assert.strictEqual(w.document.querySelectorAll('#folder-tree .tree-children > .tree-node').length, 1,
      '展开的子层也不得重复（递归需传递代次）');
  } finally { cleanup(w); }
});

test('静态契约：重建代次 + 本层幂等清空（防重复回退）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/modules/files.js'), 'utf8');
  assert.ok(src.includes('this._treeRenderSeq = (this._treeRenderSeq || 0) + 1'), '必须有单调递增代次');
  assert.ok(src.includes('renderFolderLevel(this.workspaceFolder, treeEl, 0, seq)'), '根层渲染须带代次');
  assert.ok(src.includes('renderFolderLevel(entry.path, childContainer, depth + 1, seq)'), '展开子目录递归须带代次');
  assert.ok((src.match(/if \(seq != null && seq !== this\._treeRenderSeq\) return;/g) || []).length >= 3,
    'await 之后 / 每轮 append 之前 / 循环结束都须校验代次');
  assert.ok(src.includes('containerEl.replaceChildren();'), '本层填充必须幂等');
});
