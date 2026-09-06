// exportWord 真 OOXML 流程：页面设置对话框 → DOM→结构 → worker → write_binary_file；失败回退 html-docx。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('exportWord: docx 流程走 worker 并写出二进制', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._showDocxPageDialog = async () => ({ kind: 'A4', orientation: 'portrait', margin: 'normal' });
    ed.showConfirmDialog = async () => true;
    const fakeBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    ed._runWordExportWorker = async () => fakeBytes.buffer;
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文</p>';

    await ed.exportWord();

    assert.strictEqual(captured.path, '/tmp/out.docx', '应写出 docx');
    assert.ok(captured.contents instanceof w.Uint8Array, 'contents 应为二进制');
  });
});

test('exportWord: docx worker 失败时回退 html-docx', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._showDocxPageDialog = async () => ({ kind: 'A4', orientation: 'portrait', margin: 'normal' });
    ed.showConfirmDialog = async () => true;
    ed._runWordExportWorker = async () => { throw new Error('docx worker failed'); };
    ed._convertHtmlToDocxBuffer = async (html) => { return new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer; };
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文</p>';

    await ed.exportWord();

    assert.strictEqual(captured.path, '/tmp/out.docx', '回退路径也应写出 docx');
  });
});

test('exportWord: 页面设置对话框取消时不写文件', async () => {
  let wrote = false;
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { wrote = true; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._showDocxPageDialog = async () => null; // 取消
    ed.showConfirmDialog = async () => true;
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<p>hello</p>';
    await ed.exportWord();
    assert.strictEqual(wrote, false, '取消页面设置时不写文件');
  });
});
