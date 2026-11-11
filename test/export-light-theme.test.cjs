// 亮色导出统一口径（2026-11-09 用户反馈：暗黑模式导出 PDF 一圈黑边）
//
// 用户口径：无论明亮还是暗黑模式，导出的内容（HTML / DOCX / PDF / 长图）一律是明亮模式。
// 四条链路的实现收口为：
//   · 公共「亮色导出上下文」_enterLightExport / _leaveLightExport（引用计数）：
//     快照 data-theme + html 内联 color-scheme + hljs href → 切 light → 禁全局 transition；
//     最后一层退出时按快照精确还原，并还原 mermaid 预览配置（theme 按 DOM / strict）。
//   · HTML / 长图 / DOCX 在选完路径后进入、各自 finally 尾部退出（不新增 try/finally，
//     export-parity / export-expand-all 的字符窗口断言会炸）。
//   · PDF 独立补丁（export-parity 钉死其 setAttribute 字面量）：内联 color-scheme 同切
//     同还原（theme.js 写的内联 color-scheme:dark 优先级高于 CSS，是 #121212 黑边根因）。
//   · mermaid 图表亮色重绘公共化（_rerenderMermaidLightInClone），HTML/长图/PDF 同口径。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withEditor } = require('./helpers/app-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXPORT_SRC = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'export.js'), 'utf8');

const sliceFn = (startMarker, endMarker) => {
  const a = EXPORT_SRC.indexOf(startMarker);
  const b = endMarker ? EXPORT_SRC.indexOf(endMarker) : EXPORT_SRC.length;
  assert.ok(a > 0 && b > a, `无法定位方法体：${startMarker} … ${endMarker}`);
  return EXPORT_SRC.slice(a, b);
};

// 进暗色主题的方式与 theme.js 落 DOM 一致：data-theme 属性 + html 内联 color-scheme。
const goDark = (w) => {
  w.document.documentElement.setAttribute('data-theme', 'dark');
  w.document.documentElement.style.colorScheme = 'dark';
};

// ---------------------------------------------------------------- 行为：HTML

test('暗色主题导出 HTML：产物亮色、导出后主题/内联 color-scheme/临时样式精确还原', async () => {
  await withEditor({ invokeImpl: (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.html' : null) }, async (w, ed) => {
    goDark(w);
    let written = null;
    w.TauriApi.writeFile = async (args) => { written = args.content; };
    ed.preview.innerHTML = '<p>正文</p>';

    await ed.exportHTML();

    assert.ok(written, 'HTML 未写盘');
    assert.match(written, /data-theme="light"/, '产物未带 data-theme=light（暗黑模式导出了暗色 HTML）');
    assert.ok(!written.includes('data-theme="dark"'), '产物残留暗色主题标记');
    assert.ok(written.includes('color-scheme: light'), '产物缺 color-scheme:light 规则（暗色 UA 画布语义会渗进导出文档）');

    const root = w.document.documentElement;
    assert.strictEqual(root.getAttribute('data-theme'), 'dark', '导出后 data-theme 未还原为 dark');
    assert.strictEqual(root.style.colorScheme, 'dark', '导出后内联 color-scheme 未还原');
    assert.strictEqual(w.document.getElementById('tm-export-light-transition-off'), null, '临时禁过渡样式未移除');
    assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '遮罩未移除');
  });
});

// ---------------------------------------------------------------- 行为：引用计数

test('亮色导出上下文引用计数：并发嵌套进/出，最后一层才还原（并发导出状态撕裂回归）', async () => {
  await withEditor({}, async (w, ed) => {
    const root = w.document.documentElement;
    goDark(w);

    await ed._enterLightExport();
    await ed._enterLightExport();
    assert.strictEqual(root.getAttribute('data-theme'), 'light', '进入亮色上下文失败');

    ed._leaveLightExport();
    assert.strictEqual(root.getAttribute('data-theme'), 'light',
      '第一层退出就还原了主题 —— 并发导出 A 恢复后 B 的 finally 会把用户主题写坏');

    ed._leaveLightExport();
    assert.strictEqual(root.getAttribute('data-theme'), 'dark', '全部退出后未还原为 dark');
    assert.strictEqual(root.style.colorScheme, 'dark', '全部退出后内联 color-scheme 未还原');
    assert.strictEqual(w.document.getElementById('tm-export-light-transition-off'), null, '临时禁过渡样式未移除');
  });
});

// ---------------------------------------------------------------- 行为：PDF

test('PDF 导出：打印态切内联 color-scheme=light，结束后还原 + mermaid 预览配置还原为 strict/dark', async () => {
  await withEditor({ invokeImpl: (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.pdf' : null) }, async (w, ed) => {
    goDark(w);
    w.mermaid = {
      initialize(opts) { this.lastInit = opts; },
      render: async () => ({ svg: '<svg viewBox="0 0 10 10"></svg>' }),
    };
    let printed = false;
    w.TauriApi.printToPdf = async () => { printed = true; };
    ed.showConfirmDialog = async () => true;
    ed.activeTab.filePath = '/docs/note.md';
    ed.preview.innerHTML = '<div class="mermaid-container" data-code="graph TD; A-->B"></div>';

    await ed.exportPDF();

    assert.ok(printed, 'PrintToPdf 未被调用');
    const root = w.document.documentElement;
    assert.strictEqual(root.getAttribute('data-theme'), 'dark', '导出后 data-theme 未还原');
    assert.strictEqual(root.style.colorScheme, 'dark',
      '导出后内联 color-scheme 未还原（不还原则 Chromium 一直按暗色 UA 语义渲染）');
    assert.ok(w.mermaid.lastInit, 'mermaid 未被重初始化（图表亮色重绘缺失）');
    assert.strictEqual(w.mermaid.lastInit.securityLevel, 'strict',
      '导出后 mermaid 预览配置未还原为 strict（导出用 loose 是例外，预览必须 strict）');
    assert.strictEqual(w.mermaid.lastInit.theme, 'dark',
      '导出后 mermaid 预览主题未按实际 DOM 主题还原（否则暗色模式下导出完 PDF 预览里新图表变亮色）');
    assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '遮罩未移除');
    delete w.mermaid;
  });
});

// ---------------------------------------------------------------- 行为：长图（失败路径）

test('长图导出失败路径：亮色上下文仍必须精确还原（finally 兜底）', async () => {
  await withEditor({ invokeImpl: (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.png' : null) }, async (w, ed) => {
    goDark(w);
    ed.preview.innerHTML = '<p>hi</p>';
    // jsdom 无真实布局：exportImage 在「内容高度为 0」处抛错并被内部 catch（复用
    // export-expand-all 同款前提），正好覆盖失败分支的 finally 还原。
    await ed.exportImage();

    const root = w.document.documentElement;
    assert.strictEqual(root.getAttribute('data-theme'), 'dark', '失败路径 data-theme 未还原');
    assert.strictEqual(root.style.colorScheme, 'dark', '失败路径内联 color-scheme 未还原');
    assert.strictEqual(w.document.getElementById('tm-export-light-transition-off'), null, '临时禁过渡样式未移除');
    assert.strictEqual(w.document.getElementById('tm-png-export-root'), null, '离屏宿主未移除');
    assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '遮罩未移除');
  });
});

// ---------------------------------------------------------------- 静态接线（防回退）

test('静态接线：四条导出路径全部接亮色上下文，DOCX 回退不再按 isDark 设门禁', () => {
  const html = sliceFn('async exportHTML() {', 'async exportWord');
  assert.ok(html.includes('await this._enterLightExport()'), 'exportHTML 未进入亮色上下文');
  assert.ok(html.includes('this._leaveLightExport()'), 'exportHTML finally 未退出亮色上下文');
  assert.ok(html.includes(':root { color-scheme: light !important; }'), '导出 HTML 缺 color-scheme:light 规则');
  assert.ok(html.includes('_rerenderMermaidLightInClone'), '导出 HTML 未做图表亮色重绘');

  const img = sliceFn('async exportImage() {', 'async exportPDF()');
  assert.ok(img.includes('await this._enterLightExport()'), '长图未进入亮色上下文');
  assert.ok(img.includes('this._leaveLightExport()'), '长图 finally 未退出亮色上下文');
  assert.ok(img.includes(':root { color-scheme: light !important; }'), '长图 SVG 缺 color-scheme:light 规则');
  assert.ok(img.includes('_rerenderMermaidLightInClone'), '长图未做图表亮色重绘');

  const word = sliceFn('async exportWord() {', 'async _fallbackWordHtmlExport');
  assert.ok(word.includes('await this._enterLightExport()'), 'exportWord 未进入亮色上下文');
  assert.ok(word.includes('this._leaveLightExport()'), 'exportWord finally 未退出亮色上下文');
  const fallback = sliceFn('async _fallbackWordHtmlExport', 'async exportImage() {');
  assert.ok(!/if \(!this\.isDark\)/.test(fallback),
    'DOCX 回退仍按 isDark 设门禁 —— 暗黑模式导出 Word 代码块无高亮');
  assert.ok(fallback.includes('_exportStyleFromLink'), 'DOCX 回退 hljs 未走 CSSOM 采集（裸 fetch 失败静默为空）');

  const pdf = sliceFn('async exportPDF() {', 'async _preparePdfClone');
  assert.match(pdf, /rootEl\.style\.colorScheme = 'light';/, 'PDF 打印态未切内联 color-scheme=light');
  assert.ok(pdf.includes('html.pdf-printing { color-scheme: light !important; }'), 'PDF 打印态屏幕规则缺 color-scheme');
  assert.ok(pdf.includes('this._restoreMermaidPreviewConfig()'), 'PDF finally 未还原 mermaid 预览配置');

  const prep = sliceFn('async _preparePdfClone', 'async _buildPdfPrintFrameHtml');
  assert.ok(prep.includes("_rerenderMermaidLightInClone(clone, 'pdf-mermaid-', this._exportPdfFontStack())"),
    'PDF 图表重绘未走公共亮色重绘（HTML/长图/PDF 口径分叉）');
  assert.ok(!prep.includes("theme: this.isDark"), '导出路径不得按 this.isDark 取 mermaid 主题（导出物一律亮色）');
});
