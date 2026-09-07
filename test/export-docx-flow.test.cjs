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

test('exportWord: KaTeX 公式经 MathML→OMML 转可编辑公式传给 worker（非图片）', async () => {
  const fs = require('fs');
  const path = require('path');
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    // 加载 mathml2omml vendor（真实 index.html 由 <script> 引入，harness 手动加载）
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));
    ed._showDocxPageDialog = async () => ({ kind: 'A4', orientation: 'portrait', margin: 'normal' });
    ed.showConfirmDialog = async () => true;
    ed._runWordExportWorker = async (payload) => {
      captured.structure = payload && payload.structure;
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
    };
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    // 预览含 KaTeX 公式（行内 + 独立块）
    w.editor.preview.innerHTML =
      '<p>行内 <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></semantics></math></span><span class="katex-html">E=mc2</span></span> 公式</p>' +
      '<span class="math-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow></semantics></math></span><span class="katex-html">x+y</span></span></span>';

    await ed.exportWord();

    assert.ok(captured.structure, '应捕获传给 worker 的 structure');
    const allRuns = [];
    for (const n of captured.structure) if (n && n.runs) allRuns.push(...n.runs);
    const ommlRuns = allRuns.filter(r => typeof r.omml === 'string');
    assert.ok(ommlRuns.length >= 2, '行内与独立公式都应转成 omml run，实际: ' + ommlRuns.length);
    assert.ok(ommlRuns.every(r => r.omml.includes('oMath')), 'omml run 应含 <m:oMath>');
    // 公式不应以图片形式出现（skipMathImage 保留 .katex 后转 OMML，而非 html2canvas 转图）
    const mathImgs = captured.structure.filter(n => n.type === 'image');
    assert.strictEqual(mathImgs.length, 0, '公式不应转成 image 节点');
  });
});
