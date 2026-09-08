// exportWord 真 OOXML 流程：页面设置对话框 → DOM→结构 → 主线程构建 → write_binary_file；失败回退 html-docx。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('exportWord: docx 流程主线程构建并写出二进制', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    ed.showConfirmDialog = async () => true;
    const fakeBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    ed._buildDocxBuffer = async () => fakeBytes.buffer;
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文</p>';

    await ed.exportWord();

    assert.strictEqual(captured.path, '/tmp/out.docx', '应写出 docx');
    assert.ok(captured.contents instanceof w.Uint8Array, 'contents 应为二进制');
  });
});

test('exportWord: docx 构建失败时回退 html-docx', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    ed.showConfirmDialog = async () => true;
    ed._buildDocxBuffer = async () => { throw new Error('docx build failed'); };
    ed._convertHtmlToDocxBuffer = async (html) => { return new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer; };
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文</p>';

    await ed.exportWord();

    assert.strictEqual(captured.path, '/tmp/out.docx', '回退路径也应写出 docx');
  });
});

test('exportWord: 确认框取消时不写文件', async () => {
  let wrote = false;
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { wrote = true; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => false; // 取消
    ed.showConfirmDialog = async () => true;
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<p>hello</p>';
    await ed.exportWord();
    assert.strictEqual(wrote, false, '取消确认框时不写文件');
  });
});

test('exportWord: KaTeX 公式经 MathML→OMML 转可编辑公式传给构建器（非图片）', async () => {
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
    ed._confirmDocxExport = async () => true;
    ed.showConfirmDialog = async () => true;
    ed._buildDocxBuffer = async (structure) => {
      captured.structure = structure;
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
    };
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    // 预览含 KaTeX 公式（行内 + 独立块）
    w.editor.preview.innerHTML =
      '<p>行内 <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></semantics></math></span><span class="katex-html">E=mc2</span></span> 公式</p>' +
      '<span class="math-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow></semantics></math></span><span class="katex-html">x+y</span></span></span>';

    await ed.exportWord();

    assert.ok(captured.structure, '应捕获传给构建器的 structure');
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

// 回归：导出入口只弹一个弹框（页面设置 + 说明合并），不再额外弹二次确认框。
test('exportWord: 只弹一次合并弹框（不再单独调用 showConfirmDialog）', async () => {
  await withEditor({ invokeImpl: (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.docx' : null) }, async (w, ed) => {
    let pageDialogCalls = 0;
    let confirmCalls = 0;
    ed._confirmDocxExport = async () => { pageDialogCalls++; return true; };
    ed.showConfirmDialog = async () => { confirmCalls++; return true; };
    ed._buildDocxBuffer = async () => new Uint8Array([0x50, 0x4b]).buffer;
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<p>hello</p>';
    await ed.exportWord();
    assert.strictEqual(pageDialogCalls, 1, '合并弹框应只弹一次');
    assert.strictEqual(confirmCalls, 0, '不应再弹独立的确认框');
  });
});

// 回归：公式一律以「Word 可编辑公式（OMML）」导出，不再转图片。
// 主路径由 domToDocxStructure 提取 <math> → _structureMathmlToOmml → oMath；
// 只有 html-docx 回退路径才会把公式降级成 LaTeX 源码文本（仍不是图片）。
test('_katexElsToLatexText: 回退路径把公式降为 LaTeX 源码文本（不产生图片）', async () => {
  await withEditor({}, async (w, ed) => {
    const clone = w.document.createElement('div');
    clone.innerHTML =
      '<p>行内 <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>' +
      '<mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow>' +
      '<annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>' +
      '<span class="katex-html">E=mc2</span></span> 结束</p>';
    w.document.body.appendChild(clone);

    ed._katexElsToLatexText(clone);

    assert.strictEqual(clone.querySelectorAll('.katex').length, 0, '.katex 应被替换掉');
    assert.strictEqual(clone.querySelectorAll('img').length, 0, '公式不应变成图片');
    const src = clone.querySelector('.tizu-math-source');
    assert.ok(src, '应生成 LaTeX 源码节点');
    assert.strictEqual(src.textContent, 'E=mc^2', '应取 annotation 里的 LaTeX 源码');
  });
});

// 回归：公式必须是可编辑的 OMML，而不是图片 —— 主路径 structure 里出现 omml run。
test('exportWord: 公式导出为可编辑 OMML，不产生公式图片', async () => {
  const fs = require('fs');
  const path = require('path');
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mathml2omml.min.js'), 'utf8'));
    ed._confirmDocxExport = async () => true;
    ed._buildDocxBuffer = async (structure) => {
      captured.structure = structure;
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
    };
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML =
      '<span class="math-display"><span class="katex"><span class="katex-mathml">' +
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow>' +
      '<annotation encoding="application/x-tex">x+y</annotation></semantics></math></span>' +
      '<span class="katex-html">x+y</span></span></span>';
    await ed.exportWord();

    const runs = [];
    for (const n of captured.structure || []) if (n && n.runs) runs.push(...n.runs);
    assert.ok(runs.some(r => typeof r.omml === 'string' && r.omml.includes('oMath')), '应产出 OMML 公式 run');
    assert.ok(!runs.some(r => typeof r.mathml === 'string'), 'mathml run 应全部转成 omml');
    assert.strictEqual(captured.structure.filter(n => n.type === 'image').length, 0, '公式不应是图片节点');
  });
});

// 回归：缺库返回 false（走回退）；有公式时逐个容错，转换失败/非良构 OMML 降级为 LaTeX 文本，
// 不再因单个坏公式让整篇构建失败回退（曾导致所有公式变文字）。
test('_structureMathmlToOmml: 缺库返回 false；非良构 OMML 降级为 LaTeX 文本不拖垮整篇', async () => {
  await withEditor({}, async (w, ed) => {
    // harness 未加载 mathml2omml vendor → MathML2OMML 缺失 → 返回 false
    const withMath = [{ type: 'paragraph', runs: [{ mathml: '<math><mrow><mi>x</mi></mrow></math>' }] }];
    assert.strictEqual(ed._structureMathmlToOmml(withMath), false, '缺转换库应返回 false');

    // 模拟有库但某公式产出非良构 OMML：用桩让 mml2omml 返回非法 XML
    w.MathML2OMML = { mml2omml: () => '<m:oMath><m:r><m:t>x</m:t>' }; // 缺闭合 </m:r></m:oMath>
    const struct = [{
      type: 'paragraph',
      runs: [{ mathml: '<math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math>' }],
    }];
    const ok = ed._structureMathmlToOmml(struct);
    assert.strictEqual(ok, true, '有库时返回 true（走主路径），个别公式降级不影响整体');
    assert.strictEqual(typeof struct[0].runs[0].text, 'string', '非良构 OMML 应降级为 text run');
    assert.strictEqual(struct[0].runs[0].text, 'x', '降级文本应取 annotation 里的 LaTeX 源码');

    // 无公式返回 true
    const noMath = [{ type: 'paragraph', runs: [{ text: 'hi' }] }];
    assert.strictEqual(ed._structureMathmlToOmml(noMath), true, '无公式时返回 true');
  });
});

// 回归：builder 层兜底——_structureMathmlToOmml 预检漏过的非法 OMML，runToChild 也不能抛。
test('docx-builder: runToChild 对非法 OMML 降级为纯文本不抛错', async () => {
  const fs = require('fs');
  const path = require('path');
  await withEditor({}, async (w, ed) => {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'docx.min.js'), 'utf8'));
    // stub Packer.toBlob：jsdom 里真实 toBlob 不 settle，这里只验 runToChild 容错
    w.DocxLib.Packer.toBlob = async () => ({ arrayBuffer: async () => new w.Uint8Array([1, 2, 3]).buffer });
    const builder = require(path.join(__dirname, '..', 'src', 'modules', 'docx-builder.js')).buildDocxFromStructure;
    const structure = [
      { type: 'paragraph', runs: [
        { omml: '<m:oMath><m:r><m:t>坏' }, // 非法 XML
        { text: '正常文字' },
      ] },
    ];
    const page = { pageWidth: 11906, pageHeight: 16838, marginTop: 1440, marginBottom: 1440, marginLeft: 1800, marginRight: 1800 };
    const blob = await builder(structure, page);
    const ab = await blob.arrayBuffer();
    assert.ok(ab.byteLength > 0, '含非法 OMML 的文档也应成功构建（不拖垮整篇）');
  });
});

// 回归：docx 主路径 = 主线程直构建（window.buildDocxFromStructure，docx 库常驻加载）。
// 曾走 Web Worker，真机上 Worker 不可用时整条链静默降级成 altChunk（公式变纯文本）。
test('_buildDocxBuffer: 主线程直构建，把页面设置与结构传给 builder', async () => {
  await withEditor({}, async (w, ed) => {
    let mainCalled = false;
    w.DocxLib = {}; // 让 _ensureDocxLibLoaded 秒回，不触发动态加载
    w.buildDocxFromStructure = async (structure, page) => {
      mainCalled = true;
      assert.ok(Array.isArray(structure), '应把 structure 传给 builder');
      assert.strictEqual(page.pageWidth, 11906, '应把页面设置传给 builder');
      return { arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer };
    };

    const ab = await ed._buildDocxBuffer([{ type: 'paragraph', runs: [{ text: 'hi' }] }], {
      pageWidth: 11906, pageHeight: 16838, marginTop: 1440, marginBottom: 1440, marginLeft: 1800, marginRight: 1800,
    });

    assert.strictEqual(mainCalled, true, '应调用主线程 builder');
    assert.strictEqual(new Uint8Array(ab).length, 4, '应返回构建出的字节');
  });
});

// 回归：页面没刷新导致 window.DocxLib 缺失时，_ensureDocxLibLoaded 按需补加载，
// 不再因缺库整条降级成 altChunk（公式变文字）。
test('_buildDocxBuffer: DocxLib 缺失时按需加载后再构建', async () => {
  await withEditor({}, async (w, ed) => {
    // 模拟旧页面：DocxLib 未定义；_ensureDocxLibLoaded 用桩模拟加载完成
    ed._ensureDocxLibLoaded = async () => { w.DocxLib = {}; return true; };
    let mainCalled = false;
    w.buildDocxFromStructure = async () => { mainCalled = true; return { arrayBuffer: async () => new Uint8Array([0x50]).buffer }; };

    const ab = await ed._buildDocxBuffer([{ type: 'paragraph', runs: [{ text: 'hi' }] }], {
      pageWidth: 1, pageHeight: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    });

    assert.strictEqual(mainCalled, true, 'DocxLib 补加载后应继续构建');
    assert.strictEqual(new Uint8Array(ab).length, 1, '应返回构建字节');
  });
});
