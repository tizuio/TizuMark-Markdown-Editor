// 外链图片 / 局部故障不应影响整份文档导出。
// 背景：从 http://localhost:1420 fetch https://picsum.photos/... 会被
// "No 'Access-Control-Allow-Origin'" 挡下（522 时图床本身也连不上）。用户明确要求：
// 「某个部分报错不要影响整个文档的导出，图片获取不到超时不要影响整个文档的导出」。
// 因此：跨域图只走 Rust 后端；任何可选步骤失败/超时只跳过自己；最后仍有兜底导出。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withEditor } = require('./helpers/app-env.cjs');

const ROOT = path.join(__dirname, '..');
const exportSrc = () => fs.readFileSync(path.join(ROOT, 'src', 'modules', 'export.js'), 'utf8');

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
// 只带合法图片头的假字节：mimeFromBase64 只读前 18 字节做 magic 判定
const PNG_B64 = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(0x41)]);
const JPEG_B64 = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, ...Array(24).fill(0x42)]);
const REMOTE = 'https://picsum.photos/800/400';
const DOCX_BYTES = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;

function makeClone(w, srcs) {
  const div = w.document.createElement('div');
  div.innerHTML = srcs.map((s) => `<img src="${s}">`).join('');
  return div;
}

test('外链图：Rust 后端下载成功即内联，完全不发浏览器 fetch（绕开 CORS）', async () => {
  let fetchCalls = 0;
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'fetch_image_as_base64') {
      assert.strictEqual(args.url, REMOTE, '应把原 URL 原样交给后端');
      return PNG_B64;
    }
    return null;
  } }, async (w, ed) => {
    w.fetch = async () => { fetchCalls++; throw new Error('不应触发浏览器 fetch'); };
    const clone = makeClone(w, [REMOTE]);
    await ed._inlineImagesForExport(clone, '/docs/note.md');
    const src = clone.querySelector('img').getAttribute('src');
    assert.ok(src.startsWith('data:image/png;base64,'), '应内联为 PNG data URI');
    assert.ok(!src.includes('picsum.photos'), '原 URL 不应残留');
    assert.strictEqual(fetchCalls, 0, 'CORS 请求一次都不该发生');
  });
});

test('外链图：后端 base64 按 magic bytes 判 mime，无扩展名 JPEG 不误标 PNG', async () => {
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'fetch_image_as_base64') return JPEG_B64;
    return null;
  } }, async (w, ed) => {
    const clone = makeClone(w, [REMOTE]);
    await ed._inlineImagesForExport(clone, '/docs/note.md');
    assert.ok(clone.querySelector('img').getAttribute('src').startsWith('data:image/jpeg;base64,'),
      'picsum 返回 JPEG，不能按默认 png 写入');
  });
});

test('外链图：后端返回非图片内容时保留原 URL，且不再发 CORS 请求', async () => {
  const fetched = [];
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'fetch_image_as_base64') return 'BASE64DATA'; // 非图片 / 错误页
    return null;
  } }, async (w, ed) => {
    w.fetch = async (url) => { fetched.push(String(url)); throw new Error('offline'); };
    const clone = makeClone(w, [REMOTE]);
    await ed._inlineImagesForExport(clone, '/docs/note.md');
    assert.strictEqual(clone.querySelector('img').getAttribute('src'), REMOTE,
      '后端结果无效时保留原 src，不把垃圾内联进文档');
    assert.strictEqual(fetched.length, 0, '不得再刷 No Access-Control-Allow-Origin 红字');
  });
});

test('外链图：后端不可用（离线/522）时保留原 URL，不阻断导出', async () => {
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'fetch_image_as_base64') throw new Error('backend offline');
    return null;
  } }, async (w, ed) => {
    w.fetch = async () => { throw new Error('net::ERR_FAILED 522'); };
    const clone = makeClone(w, [REMOTE]);
    await ed._inlineImagesForExport(clone, '/docs/note.md');
    assert.strictEqual(clone.querySelector('img').getAttribute('src'), REMOTE,
      '拿不到的图保留原 src，联网打开仍可见');
  });
});

test('外链图：后端 IPC 永久挂起时超时跳过该图，导出继续', async () => {
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'fetch_image_as_base64') return new Promise(() => {}); // 永不 settle
    return null;
  } }, async (w, ed) => {
    ed._exportFetchTimeoutMs = 30;
    ed._exportInlineTimeoutMs = 200;
    const clone = makeClone(w, [REMOTE]);
    const t0 = Date.now();
    await ed._inlineImagesForExport(clone, '/docs/note.md');
    assert.ok(Date.now() - t0 < 3000, '挂起的下载不能让导出一直等');
    assert.strictEqual(clone.querySelector('img').getAttribute('src'), REMOTE,
      '拿不到的图跳过即可，不影响其余内容');
  });
});

test('exportWord: rAF 永不回调时仍能写出 docx（不再卡在遮罩、无文件）', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    ed._exportFrameTimeoutMs = 20;
    w.requestAnimationFrame = () => 0; // 模拟窗口挂起：帧回调永不到达
    ed._buildDocxBuffer = async () => { throw new Error('force fallback'); };
    ed._convertHtmlToDocxBuffer = async () => DOCX_BYTES();
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '笔记';
    w.editor.preview.innerHTML = '<p>正文</p>';

    await ed.exportWord();
    assert.strictEqual(captured.path, '/tmp/out.docx', '超时兜底后应照常写出文件');
  });
});

test('exportWord: 局部步骤（DOM 预处理）抛错只跳过自己，整份文档照常导出', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    ed._prepareWordDOM = async () => { throw new Error('模拟预处理崩溃'); };
    ed._buildDocxBuffer = async () => { throw new Error('force fallback'); };
    ed._convertHtmlToDocxBuffer = async () => DOCX_BYTES();
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '笔记';
    w.editor.preview.innerHTML = `<img src="${REMOTE}"><p>正文</p>`;

    await ed.exportWord();
    assert.strictEqual(captured.path, '/tmp/out.docx', '单个增强步骤报错不应让整份文档导不出来');
  });
});

test('exportWord: 所有外链图都拿不到且超时，仍写出完整 docx', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'fetch_image_as_base64') return new Promise(() => {}); // 图床 522，IPC 挂起
    if (cmd === 'write_binary_file') { captured.wrote = true; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    ed._exportFetchTimeoutMs = 20;
    ed._exportInlineTimeoutMs = 200;
    ed._buildDocxBuffer = async () => { throw new Error('force fallback'); };
    ed._convertHtmlToDocxBuffer = async () => DOCX_BYTES();
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '笔记';
    w.editor.preview.innerHTML =
      `<img src="${REMOTE}"><img src="https://picsum.photos/600/300"><p>正文必须保留</p>`;

    const t0 = Date.now();
    await ed.exportWord();
    assert.ok(Date.now() - t0 < 5000, '图片全部挂起也不能拖住导出');
    assert.ok(captured.wrote, '图片全失败也必须产出文件');
  });
});

test('exportWord: 主链路整体崩溃时写诊断，且最终兜底仍产出文件', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_file') { captured.diagPath = args.path; captured.diag = args.content; return undefined; }
    if (cmd === 'write_binary_file') { captured.path = args.path; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    // cloneNode 不属于可选步骤，抛错会直达外层 catch —— 用来验证诊断 + 最终兜底
    w.editor.preview.cloneNode = () => { throw new Error('模拟主链路崩溃'); };
    ed._convertHtmlToDocxBuffer = async () => DOCX_BYTES();
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '笔记';
    w.editor.preview.innerHTML = `<img src="${REMOTE}"><p>正文</p>`;

    await ed.exportWord();
    assert.ok(captured.diagPath && captured.diagPath.endsWith('_diagnostic.txt'), '外层 catch 要落诊断文件');
    assert.ok(captured.diag.includes('模拟主链路崩溃'), '诊断文件应含错误');
    assert.ok(captured.diag.includes(REMOTE), '诊断文件应含预览图片 src');
    assert.strictEqual(captured.path, '/tmp/out.docx', '最终兜底必须产出文件');
  });
});

test('无 Tauri 运行时：dialogSave 抛错不再判死，仍走到写盘（浏览器下载）', async () => {
  const captured = {};
  await withEditor({ invokeImpl: () => null }, async (w, ed) => {
    ed._confirmDocxExport = async () => true;
    delete w.__TAURI__;
    ed._writeExportBinary = async (p, bytes) => {
      captured.path = p;
      captured.bytes = bytes;
    };
    ed._buildDocxBuffer = async () => { throw new Error('force fallback'); };
    ed._convertHtmlToDocxBuffer = async () => DOCX_BYTES();
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '笔记';
    w.editor.preview.innerHTML = '<p>正文</p>';

    await ed.exportWord();
    assert.ok(String(captured.path).endsWith('.docx'), '浏览器调试页也应走到写盘');
    assert.ok(captured.bytes && captured.bytes.length > 0, '应有实际内容');
  });
});

test('无 Tauri 运行时：_writeExportBinary 降级为浏览器 Blob 下载', async () => {
  await withEditor({}, async (w, ed) => {
    delete w.__TAURI__;
    let clicked = null;
    w.URL.createObjectURL = () => 'blob:mock';
    w.URL.revokeObjectURL = () => {};
    const origClick = w.HTMLAnchorElement.prototype.click;
    w.HTMLAnchorElement.prototype.click = function () {
      clicked = { href: this.href, download: this.download };
    };
    try {
      await ed._writeExportBinary('/tmp/笔记.docx', new Uint8Array([1, 2, 3]));
    } finally {
      w.HTMLAnchorElement.prototype.click = origClick;
    }
    assert.ok(clicked, '应触发 a[download] 点击，而不是直接抛「Tauri 运行时不可用」');
    assert.strictEqual(clicked.download, '笔记.docx', '应使用默认文件名');
    assert.strictEqual(clicked.href, 'blob:mock');
  });
});

test('静态契约：局部失败隔离、跨域图不发 CORS 请求、最终兜底（防回退）', () => {
  const s = exportSrc();
  assert.ok(s.includes('TauriApi.fetchImageAsBase64({ url: src })'), '网络图必须走 Rust 下载绕 CORS');
  assert.ok(!s.includes('withTimeout(fetch(src)'), '不得再对跨域图发浏览器 fetch');
  assert.ok(s.includes('safeStep(') && s.includes("'图片内联'"), '图片内联必须被隔离为可选步骤');
  assert.ok(s.includes('OPTIONAL_STEP_TIMEOUT_MS'), '可选步骤必须有独立超时');
  assert.ok(s.includes('最终兜底') && s.includes('_convertHtmlToDocxBuffer(html)'), '必须有最终兜底导出');
  assert.ok(s.includes('_writeExportBinary'), '写盘必须统一走可降级入口');
  assert.ok(s.includes('mimeFromBase64') && s.includes('image/jpeg'), '必须按 magic bytes 判 mime');
  assert.ok(/withTimeout\(new Promise\(r => requestAnimationFrame/.test(s), '裸 rAF 必须带超时');
  assert.ok(s.includes('_diagnostic.txt'), '外层 catch 必须有诊断文件');
});
