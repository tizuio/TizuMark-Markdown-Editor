// exportPDF 字体链回归测试
//
// 背景：打印帧只取 preview 的 innerHTML，容器上的行内 font-family 不会带过去，
// 打印 CSS 里若不显式指定字体，中文会由系统回退到 Noto Sans SC 等 CFF 轮廓字体，
// Skia 转 PDF 时退化成 Type3（位图化）字体 —— 体积暴涨且文字不可选中/搜索。
//
// 约定（本测试守护的行为）：
//   1. 打印帧 .preview-content 的字体链 = 用户预览字体 + TrueType 中文字体尾链 + sans-serif；
//   2. 用户设置/自定义字体必须排在链首，不能被硬编码整链顶掉；
//   3. 尾链只含 TrueType 中文字体，禁止 Noto / Source Han / PingFang SC；
//   4. 正文字体不得污染代码字体（pre/code 仍走 --font-code-preview）。

const { withEditor } = require('./helpers/app-env.cjs');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 捕获 exportPDF 创建的打印 iframe（打印 HTML 通过 srcdoc 承载）
function capturePdfIframe(w) {
  const captured = [];
  const origCreateElement = w.document.createElement.bind(w.document);
  w.document.createElement = function (tag) {
    const el = origCreateElement(tag);
    if (String(tag).toLowerCase() === 'iframe') captured.push(el);
    return el;
  };
  return {
    captured,
    restore() { w.document.createElement = origCreateElement; },
  };
}

// 取出打印 HTML 中命中某选择器的所有规则体（同名规则可能有多条，appCSS 与 printCSS 各一条）
function ruleBodies(doc, selectorRe) {
  const bodies = [];
  const re = new RegExp(selectorRe.source + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(doc)) !== null) bodies.push(m[1]);
  return bodies;
}

// 取规则体里 font-family 的声明值（去掉 !important）
function fontFamilyValue(body) {
  const m = /font-family:\s*([^;]+?)\s*!important/.exec(body) || /font-family:\s*([^;]+)/.exec(body);
  return m ? m[1].trim() : '';
}

// 2026-10-25：exportPDF 主路径改为 WebView2 PrintToPdf（直接落盘）。字体链是本文件守护的
// **回退打印帧**（`_buildPdfPrintFrameHtml`）契约，故把导出逼上回退：printToPdf 抛错。
function forceFallbackPath(w, ed) {
  ed.showConfirmDialog = async () => true;
  w.TauriApi.printToPdf = async () => { throw new Error('模拟旧版 WebView2：无 ICoreWebView2_7::PrintToPdf'); };
}

async function runExportPdf(w, ed) {
  forceFallbackPath(w, ed);
  ed.activeTab.name = 'NOTE.md';
  await ed.exportPDF().catch(() => {});
}

test('exportPDF: 未设置预览字体时字体链钉 TrueType 中文尾链（无 Noto/SourceHan/PingFang）', async () => {
  await withEditor({}, async (w, ed) => {
    const stack = ed._exportPdfFontStack();
    const yaheiIdx = stack.indexOf('"Microsoft YaHei"');
    const sansIdx = stack.indexOf('sans-serif');
    assert.ok(yaheiIdx !== -1, '字体链应含 "Microsoft YaHei"');
    assert.ok(sansIdx !== -1 && yaheiIdx < sansIdx, '"Microsoft YaHei" 必须排在 sans-serif 之前');
    assert.ok(!/Noto|Source Han|PingFang SC/.test(stack), '字体链不应含 Noto / Source Han / PingFang SC');
  });
});

test('exportPDF: 用户设置的预览字体排在字体链首位（不被硬编码整链顶掉）', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.previewFont = 'IBM Plex Serif';
    const stack = ed._exportPdfFontStack();
    assert.ok(
      stack.startsWith('"IBM Plex Serif", '),
      `字体链应以用户预览字体开头，实际：${stack}`,
    );
    assert.ok(/"Microsoft YaHei"/.test(stack), '用户字体之后仍应保留中文尾链兜底');
  });
});

test('exportPDF: 自定义字体链首生效且 printRoot 内联样式不引入 font-family（防污染代码字体）', async () => {
  await withEditor({ invokeImpl: (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.pdf' : null) }, async (w, ed) => {
    ed.settings.customFonts = [{ id: 'abc', name: 'MyFont', fileName: 'my.ttf', hash: 'h' }];
    ed.settings.previewFont = 'abc';
    // 复用已存在的 #custom-fonts-style（registerCustomFonts 初始化时可能已建同 id 元素，
    // getElementById 只返回第一个，新建的会被"遮挡"导致读到空内容）
    let style = w.document.getElementById('custom-fonts-style');
    if (!style) {
      style = w.document.createElement('style');
      style.id = 'custom-fonts-style';
      w.document.head.appendChild(style);
    }
    style.textContent = "@font-face{font-family:'tizumark-custom-abc';src:url(data:font/ttf;base64,AAA) format('truetype');font-display:swap;}";
    assert.ok(style.textContent.length > 0, '@font-face 样式应写入 #custom-fonts-style');
    ed.activeTab.name = 'NOTE.md';
    assert.ok(
      ed._exportPdfFontStack().startsWith("'tizumark-custom-abc'"),
      '自定义字体应作为链首',
    );
    // 主路径在同一文档打印（#custom-fonts-style 天然生效），但打印容器不得带内联
    // font-family——否则用户正文字体会盖过 pre/code 的 --font-code-preview。
    let printed = false, rootCssText = null;
    w.TauriApi.printToPdf = async () => {
      printed = true;
      const root = w.document.getElementById('pdf-print-root');
      rootCssText = root ? root.style.cssText : null;
    };
    ed.showConfirmDialog = async () => true;
    ed.activeTab.filePath = '/docs/note.md';
    ed.preview.innerHTML = '<p>正文</p>';
    try {
      await ed.exportPDF();
      assert.ok(printed, 'PrintToPdf 未被调用');
      assert.ok(rootCssText !== null, '打印态容器缺失');
      assert.ok(!/font-family/i.test(rootCssText || ''), '打印容器内联样式不得含 font-family（会污染代码字体）');
    } finally {
      style.remove();
    }
  });
});

test('exportPDF: mermaid 重渲染字体链 = 用户字体 + 中文尾链', async () => {
  await withEditor({ invokeImpl: (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.pdf' : null) }, async (w, ed) => {
    ed.settings.previewFont = 'IBM Plex Serif';
    let capturedFontFamily = null;
    // 取第一次 initialize（导出路径的重绘初始化）：导出结束 finally 会把 mermaid 预览
    // 配置还原一次（strict/预览字体），若取最后一次会被还原调用覆盖、断言失真。
    w.mermaid = {
      initialize: (opts) => { capturedFontFamily = capturedFontFamily || opts.fontFamily; },
      render: async () => ({ svg: '<svg viewBox="0 0 10 10"></svg>' }),
    };
    try {
      w.editor.preview.innerHTML = '<div class="mermaid-container" data-code="graph TD; A-->B"></div>';
      ed.activeTab.name = 'NOTE.md';
      await runExportPdf(w, ed);
      assert.ok(capturedFontFamily, 'exportPDF 重渲染 mermaid 时应调用 mermaid.initialize');
      assert.ok(capturedFontFamily.startsWith('"IBM Plex Serif"'), 'mermaid 字体链应以用户预览字体开头');
      assert.ok(capturedFontFamily.includes('"Microsoft YaHei"'), 'mermaid 字体链应含中文尾链');
      assert.ok(!/Noto|Source Han/.test(capturedFontFamily), 'mermaid 字体链不应含 Noto / Source Han');
    } finally {
      delete w.mermaid;
    }
  });
});

test('exportPDF: 正文字体不污染代码字体（pre/code 仍走 --font-code-preview）', async () => {
  // 代码字体护栏：直接对 styles.css 源文件断言这两条规则仍在（主路径正文渲染在当前
  // 文档里，styles.css 就是唯一真源）
  const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
  assert.ok(
    /\.preview-content code\s*\{[^}]*var\(--font-code-preview\)/.test(css),
    'styles.css 应仍含 .preview-content code { ... var(--font-code-preview) ... }',
  );
  assert.ok(
    /\.preview-content pre code[\s\S]*?var\(--font-code-preview\)[^;]*!important/.test(css),
    'styles.css 应仍含 .preview-content pre code { ... var(--font-code-preview) ... !important ... }',
  );
});
