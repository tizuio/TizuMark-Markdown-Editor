// 文件树右键操作（合并自 PR #36）：剪切/复制/粘贴/重命名/删除/新建 —— node 级逻辑测试。
// 关键断言：
//   - 所有 IPC 走 TauriApi.xxx（ADR-1 唯一边界），不直接 window.__TAURI__.core.invoke
//   - 粘贴同名冲突自动加 (n) 后缀；禁止粘贴到自身/子目录
//   - 重命名成功后同步更新打开中的 tab
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

async function makeEditor() {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  return { w, ed: w.editor };
}

// 简化交互与渲染副作用：mock 对话框/渲染/toast，聚焦逻辑
function stubUi(ed, opts = {}) {
  ed.showPromptDialog = opts.prompt || (async () => null);
  ed.showConfirmDialog = opts.confirm || (async () => false);
  ed.showToast = () => {};
  ed.setStatus = () => {};
  ed.renderFolderTree = async () => {};
  ed.updateTabBar = () => {};
  ed.saveSession = () => {};
}

test('file-ops: fileTreeCut / fileTreeCopy 设置文件剪贴板状态', async () => {
  const { w, ed } = await makeEditor();
  try {
    stubUi(ed);
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false };
    ed.fileTreeCut();
    // 跨 realm（jsdom）对象不能 deepStrictEqual 直接比，逐字段断言
    assert.strictEqual(ed._fileClipboard.op, 'cut');
    assert.strictEqual(ed._fileClipboard.path, '/root/a.md');
    assert.strictEqual(ed._fileClipboard.isDir, false);
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false };
    ed.fileTreeCopy();
    assert.strictEqual(ed._fileClipboard.op, 'copy');
  } finally { cleanup(w); }
});

test('file-ops: fileTreePaste 剪贴板为空时提示且不调 IPC', async () => {
  const { w, ed } = await makeEditor();
  try {
    const toasts = [];
    stubUi(ed);
    ed.showToast = (msg) => toasts.push(msg);
    ed._fileTreeCtx = { path: '/root/docs', isDir: true };
    ed._fileClipboard = null;
    await ed.fileTreePaste();
    assert.ok(toasts.some(t => String(t).includes(ed.t('clipboardEmpty'))), '应提示剪贴板为空');
  } finally { cleanup(w); }
});

test('file-ops: 禁止把目录粘贴到自身或其子目录内', async () => {
  const { w, ed } = await makeEditor();
  try {
    const toasts = [];
    let moved = 0, copied = 0;
    stubUi(ed);
    ed.showToast = (msg) => toasts.push(msg);
    w.TauriApi.movePath = async () => { moved++; };
    w.TauriApi.copyPath = async () => { copied++; };
    // 粘贴目标 = 剪贴板源自身（防递归复制）
    ed._fileTreeCtx = { path: '/root/proj', isDir: true };
    ed._fileClipboard = { op: 'copy', path: '/root/proj', isDir: true };
    await ed.fileTreePaste();
    assert.ok(toasts.some(t => String(t).includes(ed.t('pasteIntoSelf'))), '应提示不能粘贴到自身');
    assert.strictEqual(copied, 0, '不应发起复制');
    assert.strictEqual(moved, 0, '不应发起移动');
    // 粘贴目标 = 源的子目录
    ed._fileTreeCtx = { path: '/root/proj/sub', isDir: true };
    await ed.fileTreePaste();
    assert.strictEqual(copied, 0, '子目录场景也不应复制');
  } finally { cleanup(w); }
});

test('file-ops: fileTreePaste 复制同名冲突自动加 (n) 后缀（走 TauriApi.copyPath）', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    stubUi(ed);
    w.TauriApi.copyPath = async (args) => { calls.push(args); };
    // listDir 用于 pathExists：/root/docs 下已存在 proj（触发冲突），proj (1) 不存在
    w.TauriApi.listDir = async ({ path }) => {
      if (path === '/root/docs') return [{ name: 'proj', path: '/root/docs/proj', is_dir: true }];
      return [];
    };
    ed._fileTreeCtx = { path: '/root/docs', isDir: true };
    ed._fileClipboard = { op: 'copy', path: '/root/proj', isDir: true };
    await ed.fileTreePaste();
    assert.strictEqual(calls.length, 1, 'copyPath 应被调用一次');
    // 跨 realm（jsdom）对象逐字段断言
    assert.strictEqual(calls[0].from, '/root/proj');
    assert.strictEqual(calls[0].to, '/root/docs/proj (1)');
  } finally { cleanup(w); }
});

test('file-ops: fileTreeRename 走 TauriApi.renamePath 并同步更新打开的 tab', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    stubUi(ed, { prompt: async () => 'b.md' });
    w.TauriApi.renamePath = async (args) => { calls.push(args); };
    w.TauriApi.listDir = async () => []; // pathExists：新名不存在
    ed.tabs = [{ filePath: '/root/a.md', name: 'a.md' }];
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false };
    await ed.fileTreeRename();
    assert.strictEqual(calls.length, 1, '应经 TauriApi.renamePath 调用');
    assert.strictEqual(calls[0].from, '/root/a.md');
    assert.strictEqual(calls[0].to, '/root/b.md');
    assert.strictEqual(ed.tabs[0].filePath, '/root/b.md', '打开的 tab 应同步改名');
    assert.strictEqual(ed.tabs[0].name, 'b.md');
  } finally { cleanup(w); }
});

test('file-ops: fileTreeDelete 确认后走 TauriApi.removePath 并关闭对应 tab', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    let closed = -1;
    stubUi(ed, { confirm: async () => true });
    w.TauriApi.removePath = async (args) => { calls.push(args); };
    ed.tabs = [{ filePath: '/root/a.md', name: 'a.md' }];
    ed.closeTab = async (idx) => { closed = idx; };
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false };
    await ed.fileTreeDelete();
    assert.strictEqual(calls.length, 1, '应经 TauriApi.removePath 调用');
    assert.strictEqual(calls[0].path, '/root/a.md');
    assert.strictEqual(closed, 0, '应关闭被删除文件的 tab');
  } finally { cleanup(w); }
});

test('file-ops: fileTreeNewFile / fileTreeNewFolder 走 TauriApi 写盘', async () => {
  const { w, ed } = await makeEditor();
  try {
    const writes = [], mkdirs = [];
    stubUi(ed, { prompt: async () => 'note.md' });
    w.TauriApi.writeFile = async (args) => { writes.push(args); };
    w.TauriApi.ensureDir = async (args) => { mkdirs.push(args); };
    w.TauriApi.listDir = async () => [];
    ed._fileTreeCtx = { path: '/root/docs', isDir: true };
    await ed.fileTreeNewFile();
    assert.strictEqual(writes.length, 1, 'writeFile 应被调用一次');
    assert.strictEqual(writes[0].path, '/root/docs/note.md');
    assert.strictEqual(writes[0].content, '');
    // 新建文件夹：同一上下文再次弹窗
    ed.showPromptDialog = async () => 'sub';
    await ed.fileTreeNewFolder();
    assert.strictEqual(mkdirs.length, 1, 'ensureDir 应被调用一次');
    assert.strictEqual(mkdirs[0].path, '/root/docs/sub');
  } finally { cleanup(w); }
});

test('file-ops: 新建文件缺省扩展名自动补全 .md', async () => {
  const { w, ed } = await makeEditor();
  try {
    const writes = [];
    stubUi(ed, { prompt: async () => 'note' });
    w.TauriApi.writeFile = async (args) => { writes.push(args); };
    w.TauriApi.listDir = async () => [];
    ed._fileTreeCtx = { path: '/root/docs', isDir: true };
    await ed.fileTreeNewFile();
    assert.strictEqual(writes.length, 1, '应写入一个文件');
    assert.strictEqual(writes[0].path, '/root/docs/note.md', '缺扩展名应自动补 .md');
  } finally { cleanup(w); }
});

test('file-ops: 重命名缺省扩展名（原 md）自动补全 .md', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => 'mynote' });
    w.TauriApi.renamePath = async (args) => { renames.push(args); };
    w.TauriApi.listDir = async () => [];
    ed._fileTreeCtx = { path: '/root/docs/note.md', isDir: false };
    await ed.fileTreeRename();
    assert.strictEqual(renames.length, 1, 'renamePath 应被调用一次');
    assert.strictEqual(renames[0].to, '/root/docs/mynote.md', '重命名 md 文件缺扩展名应补 .md');
  } finally { cleanup(w); }
});

test('file-ops: 重命名非 md 文件不强行补 .md', async () => {
  const { w, ed } = await makeEditor();
  try {
    const renames = [];
    stubUi(ed, { prompt: async () => 'config2' });
    w.TauriApi.renamePath = async (args) => { renames.push(args); };
    w.TauriApi.listDir = async () => [];
    ed._fileTreeCtx = { path: '/root/docs/config.json', isDir: false };
    await ed.fileTreeRename();
    assert.strictEqual(renames.length, 1, 'renamePath 应被调用一次');
    assert.strictEqual(renames[0].to, '/root/docs/config2', '非 md 文件重命名不强行补 .md');
  } finally { cleanup(w); }
});

test('keydown: 树选中文件后 Ctrl+C 复制文件（即便编辑器聚焦、无文本选区）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false, nodeEl: null };
    let copied = false;
    ed.fileTreeCopy = () => { copied = true; };
    assert.strictEqual(ed.cm.somethingSelected(), false, '前置：编辑器无文本选区');
    w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    assert.ok(copied, 'Ctrl+C 应触发 fileTreeCopy（复制文件），修复「点文件后 Ctrl+C 不起作用」');
  } finally { cleanup(w); }
});

test('keydown: 编辑器有文本选区时 Ctrl+C 交给编辑器（不复制文件）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false, nodeEl: null };
    let copied = false;
    ed.fileTreeCopy = () => { copied = true; };
    ed.cm.setValue('abcdefghij'); // 测试环境文档为空，先填入内容才能产生选区
    const doc = ed.cm.getDoc();
    doc.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 3 });
    assert.strictEqual(ed.cm.somethingSelected(), true, '前置：编辑器有选区');
    w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    assert.ok(!copied, '编辑器有选区时 Ctrl+C 不应复制文件（交给编辑器文本复制）');
  } finally { cleanup(w); }
});

test('keydown: 树选中目录后 Ctrl+V 粘贴文件（无文本选区时）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._fileTreeCtx = { path: '/root/docs', isDir: true, nodeEl: null };
    ed._fileClipboard = { op: 'copy', path: '/root/src.md', isDir: false };
    let pasted = false;
    ed.fileTreePaste = async () => { pasted = true; };
    w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
    assert.ok(pasted, '选中目录时 Ctrl+V 应触发 fileTreePaste（粘贴文件）');
  } finally { cleanup(w); }
});

test('keydown: 树选中文件（非目录）时 Ctrl+V 粘贴到同级目录（不交给编辑器）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false, nodeEl: null };
    ed._fileClipboard = { op: 'copy', path: '/root/src.md', isDir: false };
    let pasted = false;
    ed.fileTreePaste = async () => { pasted = true; };
    w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
    assert.ok(pasted, '选中文件（非目录）时 Ctrl+V 应触发 fileTreePaste（粘贴到该文件所在目录）');
  } finally { cleanup(w); }
});

test('fileTreePaste: 选中文件时目标目录为父目录（同级），选中目录时为目录本身', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    stubUi(ed, { prompt: async () => 'x', confirm: async () => true });
    w.TauriApi.copyPath = async (a) => { calls.push(a); };
    w.TauriApi.movePath = async (a) => { calls.push(a); };
    w.TauriApi.listDir = async () => [];
    // 选中文件 → 目标应为其所在目录 /root
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false, nodeEl: null };
    ed._fileClipboard = { op: 'copy', path: '/src.md', isDir: false };
    await ed.fileTreePaste();
    assert.strictEqual(calls.length, 1, '应调用一次 copyPath');
    assert.strictEqual(calls[0].to, '/root/a.md'.replace('a.md', 'src.md'), '目标应为父目录 /root 下的 src.md');
    assert.strictEqual(calls[0].to, '/root/src.md', `实际目标: ${calls[0].to}`);
    // 选中目录 → 目标应为目录本身 /root/docs
    calls.length = 0;
    ed._fileTreeCtx = { path: '/root/docs', isDir: true, nodeEl: null };
    ed._fileClipboard = { op: 'copy', path: '/src.md', isDir: false };
    await ed.fileTreePaste();
    assert.strictEqual(calls[0].to, '/root/docs/src.md', `目录选中时目标应为目录本身: ${calls[0].to}`);
  } finally { cleanup(w); }
});

test('editorWrapper mousedown：点进编辑器清除树选中态，恢复文本复制/粘贴', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false, nodeEl: null };
    const wrapper = w.document.getElementById('editor-wrapper');
    wrapper.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    assert.strictEqual(ed._fileTreeCtx, null, '点进编辑器后 _fileTreeCtx 应被清掉');
  } finally { cleanup(w); }
});

test('fileTreeCopyPath 执行后清除 _fileTreeCtx，避免后续 Ctrl+C 被劫持为文件路径', async () => {
  const { w, ed } = await makeEditor();
  try {
    // stub navigator.clipboard.writeText（jsdom 无实现）
    let written = null;
    w.navigator.clipboard = { writeText: async (t) => { written = t; } };
    ed.setStatus = () => {};
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false, nodeEl: null };
    await ed.fileTreeCopyPath();
    // ① 路径已写入剪贴板
    assert.strictEqual(written, '/root/a.md', '复制路径应把文件路径写入剪贴板');
    // ② 关键：瞬时动作后必须清掉文件树上下文，否则后续 Ctrl+C 会被 fileTreeCopy 劫持
    assert.strictEqual(ed._fileTreeCtx, null, '复制路径后 _fileTreeCtx 应被清掉');
    // ③ 清除后 Ctrl+C 不再走文件树复制（不再复制该路径）
    let fileCopied = false;
    ed.fileTreeCopy = () => { fileCopied = true; };
    assert.strictEqual(ed.cm.somethingSelected(), false, '前置：编辑器无文本选区');
    w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    assert.ok(!fileCopied, '复制路径清除上下文后，Ctrl+C 不应再被 fileTreeCopy 劫持');
  } finally { cleanup(w); }
});

test('file-ops: 文件树操作不直接 window.__TAURI__.core.invoke（ADR-1 唯一 IPC 边界）', async () => {
  const { w, ed } = await makeEditor();
  try {
    const rawInvokes = [];
    const origInvoke = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = async (cmd, args) => { rawInvokes.push(cmd); return undefined; };
    const calls = [];
    stubUi(ed, { prompt: async () => 'b.md', confirm: async () => true });
    w.TauriApi.renamePath = async (a) => { calls.push(a); };
    w.TauriApi.removePath = async (a) => { calls.push(a); };
    w.TauriApi.listDir = async () => [];
    ed.tabs = [];
    ed.closeTab = async () => {};
    ed._fileTreeCtx = { path: '/root/a.md', isDir: false };
    await ed.fileTreeRename();
    await ed.fileTreeDelete();
    const cmds = rawInvokes.filter(c => ['rename_path', 'remove_path', 'copy_path', 'move_path', 'ensure_dir', 'write_file'].includes(c));
    assert.deepStrictEqual(cmds, [], `文件树操作不得绕过 TauriApi 直接 invoke：${cmds.join(',')}`);
    assert.strictEqual(calls.length, 2, '应全部经 TauriApi 方法调用');
    w.__TAURI__.core.invoke = origInvoke;
  } finally { cleanup(w); }
});

// ====== 右键「新建」的目标目录：文件夹→自身 / 文件→同级目录 / 空白→根目录 ======

test('file-ops: _fileTreeTargetDir 文件夹取自身、文件取父目录、空白取工作区根', async () => {
  const { w, ed } = await makeEditor();
  try {
    stubUi(ed);
    ed.workspaceFolder = '/ws';

    ed._fileTreeCtx = { path: '/ws/sub', isDir: true };
    assert.strictEqual(ed._fileTreeTargetDir(), '/ws/sub', '文件夹 → 自身');

    ed._fileTreeCtx = { path: '/ws/sub/a.md', isDir: false };
    assert.strictEqual(ed._fileTreeTargetDir(), '/ws/sub', '文件 → 所在目录（同级）');

    ed._fileTreeCtx = { path: '/ws', isDir: true, isBlank: true };
    assert.strictEqual(ed._fileTreeTargetDir(), '/ws', '空白处 → 工作区根目录');

    ed._fileTreeCtx = null;
    assert.strictEqual(ed._fileTreeTargetDir(), '/ws', '无上下文 → 工作区根目录');
  } finally { cleanup(w); }
});

test('file-ops: 在文件上右键新建文件 → 建到同级目录（此前因非文件夹被禁用）', async () => {
  const { w, ed } = await makeEditor();
  try {
    const written = [];
    stubUi(ed, { prompt: async () => 'new.md' });
    ed.workspaceFolder = '/ws';
    ed.pathExists = async () => false;
    ed._fileTreeCtx = { path: '/ws/sub/a.md', isDir: false };
    // 捕获 writeFile
    const origWrite = w.TauriApi.writeFile;
    w.TauriApi.writeFile = async (args) => { written.push(args.path); return undefined; };
    try {
      await ed.fileTreeNewFile();
    } finally { w.TauriApi.writeFile = origWrite; }
    assert.deepStrictEqual(written, ['/ws/sub/new.md'], '应建到文件的同级目录');
  } finally { cleanup(w); }
});

test('file-ops: 空白处右键新建文件夹 → 建到工作区根目录', async () => {
  const { w, ed } = await makeEditor();
  try {
    const dirs = [];
    stubUi(ed, { prompt: async () => 'newdir' });
    ed.workspaceFolder = '/ws';
    ed.pathExists = async () => false;
    ed._fileTreeCtx = { path: '/ws', isDir: true, isBlank: true };
    const origEnsure = w.TauriApi.ensureDir;
    w.TauriApi.ensureDir = async (args) => { dirs.push(args.path); return undefined; };
    try {
      await ed.fileTreeNewFolder();
    } finally { w.TauriApi.ensureDir = origEnsure; }
    assert.deepStrictEqual(dirs, ['/ws/newdir'], '应建到工作区根目录');
  } finally { cleanup(w); }
});

test('file-ops: 空白处右键菜单禁用需要具体节点的操作，保留新建', async () => {
  const { w, ed } = await makeEditor();
  try {
    stubUi(ed);
    ed.workspaceFolder = '/ws';
    ed._fileTreeCtx = { path: '/ws', isDir: true, isBlank: true };
    ed.updateFileTreeMenuState();
    const menu = w.document.getElementById('context-menu-file-tree');
    const isDisabled = (a) => {
      const el = menu.querySelector(`[data-action="${a}"]`);
      return el ? el.classList.contains('disabled') : null;
    };
    assert.strictEqual(isDisabled('file-new-file'), false, '空白处应可新建文件');
    assert.strictEqual(isDisabled('file-new-folder'), false, '空白处应可新建文件夹');
    for (const a of ['file-cut', 'file-copy', 'file-rename', 'file-copy-path', 'file-delete']) {
      assert.strictEqual(isDisabled(a), true, `空白处应禁用 ${a}（无选中项）`);
    }
  } finally { cleanup(w); }
});

test('file-ops: 文件上右键菜单应启用新建（此前 !isDir 被禁用）', async () => {
  const { w, ed } = await makeEditor();
  try {
    stubUi(ed);
    ed.workspaceFolder = '/ws';
    ed._fileTreeCtx = { path: '/ws/sub/a.md', isDir: false };
    ed.updateFileTreeMenuState();
    const menu = w.document.getElementById('context-menu-file-tree');
    const isDisabled = (a) => {
      const el = menu.querySelector(`[data-action="${a}"]`);
      return el ? el.classList.contains('disabled') : null;
    };
    assert.strictEqual(isDisabled('file-new-file'), false, '文件上右键应可新建文件');
    assert.strictEqual(isDisabled('file-new-folder'), false, '文件上右键应可新建文件夹');
    assert.strictEqual(isDisabled('file-rename'), false, '文件上右键应可重命名');
  } finally { cleanup(w); }
});
