// 导出 loading 遮罩：按软件当前明暗主题显示「不透明」的对应底色。
//
// 背景：原实现两套遮罩都写死 background:rgba(0,0,0,0.3x)（半透明黑）+ 白色文字/转圈，
// 亮色主题下是一层突兀的黑纱，暗色主题下也不是主题色。
// 难点：_enterLightExport() 会把 html 的 data-theme 临时切到 light（导出物一律亮色），
// 遮罩若只继承 html 变量，暗色主题导出时会中途闪成亮色、退出时再闪回去。
// 解法是把「软件当前主题」固化到遮罩自身的 data-theme / data-color-scheme 上。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withEditor } = require('./helpers/app-env.cjs');

const ROOT = path.join(__dirname, '..');
const EXPORT_SRC = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'export.js'), 'utf8');

const sliceFn = (startMarker, endMarker) => {
  const a = EXPORT_SRC.indexOf(startMarker);
  const b = EXPORT_SRC.indexOf(endMarker, a + 1);
  assert.ok(a > 0 && b > a, `无法定位方法体：${startMarker} … ${endMarker}`);
  return EXPORT_SRC.slice(a, b);
};

const opts = () => ({ invokeImpl: () => null });
const styleAttr = (ov) => ov.getAttribute('style') || '';

// ---------------------------------------------------------------- 行为：长图 / HTML / PDF 共用遮罩

test('亮色主题：遮罩为不透明主题底色，文字/转圈改用主题变量', async () => {
  await withEditor(opts(), async (w, ed) => {
    const root = w.document.documentElement;
    root.setAttribute('data-theme', 'light');
    root.setAttribute('data-color-scheme', 'forest');

    const ov = ed._showExportOverlay('导出中');

    assert.strictEqual(ov.getAttribute('data-theme'), 'light', '亮色主题应固化 light');
    assert.strictEqual(ov.getAttribute('data-color-scheme'), 'forest', '配色方案应一并固化');
    assert.match(styleAttr(ov), /background:\s*var\(--bg-primary\)/, '底色应取主题变量（实色）');
    assert.ok(!/rgba\(0,\s*0,\s*0/.test(styleAttr(ov)), '不得再残留半透明黑底');

    const css = w.document.getElementById('tm-export-overlay-style').textContent;
    assert.match(css, /\.tm-export-text\{color:var\(--text-primary\)/, '文字应取主题前景色');
    assert.match(css, /border-top-color:var\(--accent-color\)/, '转圈高亮应取主题强调色');
    assert.match(css, /border:3px solid var\(--border-color\)/, '转圈轨道应取主题边框色');
    assert.ok(!css.includes('#fff'), '前景不得写死白色，否则亮色底上看不见');

    ed._hideExportOverlay();
  });
});

test('暗色主题：遮罩固化 dark，导出上下文把 html 切亮后不跟着变', async () => {
  await withEditor(opts(), async (w, ed) => {
    const root = w.document.documentElement;
    root.setAttribute('data-theme', 'dark');
    root.setAttribute('data-color-scheme', 'nord');
    root.style.colorScheme = 'dark';

    const ov = ed._showExportOverlay('导出中');
    assert.strictEqual(ov.getAttribute('data-theme'), 'dark');
    assert.strictEqual(ov.getAttribute('data-color-scheme'), 'nord');
    assert.match(styleAttr(ov), /background:\s*var\(--bg-primary\)/);

    // 模拟 _enterLightExport()：导出物要亮色，html 被临时切成 light。
    // 遮罩属于 UI，必须保持用户当前的暗色，不能中途闪白。
    root.setAttribute('data-theme', 'light');
    assert.strictEqual(root.getAttribute('data-theme'), 'light', 'html 应已被切亮');
    assert.strictEqual(ov.getAttribute('data-theme'), 'dark', '遮罩主题必须固化，不随 html 漂移');

    ed._hideExportOverlay();
  });
});

test('并发导出：已有亮色上下文快照时，新遮罩仍按用户真实主题着色', async () => {
  await withEditor(opts(), async (w, ed) => {
    // A 导出已把 html 切亮并留下快照；B 此刻才建遮罩，不能读 html 的 light。
    w.document.documentElement.setAttribute('data-theme', 'light');
    ed._lightExportSnapshot = { theme: 'dark', colorScheme: 'dark', hljsHref: null };

    const ov = ed._showExportOverlay('导出中');
    assert.strictEqual(ov.getAttribute('data-theme'), 'dark', '应优先取快照里的真实主题');

    ed._hideExportOverlay();
    ed._lightExportSnapshot = null;
  });
});

test('未写 data-theme 时按 isDark 兜底，配色方案缺省 default', async () => {
  await withEditor(opts(), async (w, ed) => {
    const root = w.document.documentElement;
    root.removeAttribute('data-theme');
    root.removeAttribute('data-color-scheme');
    ed.isDark = true;

    const ov = ed._showExportOverlay('导出中');
    assert.strictEqual(ov.getAttribute('data-theme'), 'dark');
    assert.strictEqual(ov.getAttribute('data-color-scheme'), 'default');

    ed._hideExportOverlay();
  });
});

// ---------------------------------------------------------------- DOCX 遮罩（静态接线）

test('DOCX 遮罩同口径：不透明主题底色 + 主题化文字/转圈', () => {
  const word = sliceFn('async exportWord() {', 'async _fallbackWordHtmlExport');
  assert.ok(word.includes('this._applyExportOverlayTheme(overlay)'), 'DOCX 遮罩必须固化主题');
  assert.match(word, /background:var\(--bg-primary\)/, 'DOCX 遮罩应取主题底色');
  assert.ok(!word.includes('background:rgba(0,0,0,0.35)'), 'DOCX 遮罩不得残留半透明黑底');
  assert.match(word, /\.pdf-loading-text\{color:var\(--text-primary\)/, 'DOCX 文字应取主题前景色');
  assert.match(word, /border-top-color:var\(--accent-color\)/, 'DOCX 转圈应取主题强调色');
  assert.ok(!word.includes('color:#fff'), 'DOCX 前景不得写死白色');
});

// ---------------------------------------------------------------- 静态防回退

test('静态契约：两套遮罩都不得回退到半透明黑底或写死白色前景', () => {
  assert.ok(!/background:rgba\(0,0,0,0\.3\d\)/.test(EXPORT_SRC), '不得再有半透明黑底');
  assert.ok(!EXPORT_SRC.includes('border-top-color:#fff'), '转圈不得写死白色');
  assert.ok(!EXPORT_SRC.includes('.pdf-loading-text{color:#fff'), 'DOCX 文字不得写死白色');
  assert.ok(!EXPORT_SRC.includes('.tm-export-text{color:#fff'), '共用遮罩文字不得写死白色');
  assert.ok(EXPORT_SRC.includes('_applyExportOverlayTheme(overlay)'), '主题固化入口必须存在');
  const helper = sliceFn('_applyExportOverlayTheme(overlay) {', '_showExportOverlay(text) {');
  assert.ok(helper.includes('_lightExportSnapshot') && helper.includes('data-color-scheme'),
    '主题固化必须覆盖并发快照与配色方案');
});
