// 回归测试：行内公式在预览里必须真正渲染成 KaTeX（而非残留 <!--MATHBLOCK_N--> 或转义成 &lt; 的纯文本）。
// 覆盖两类历史 bug：
//  1) 普通行内公式 $E = mc^2$ / $a^2 + b^2 = c^2$ 在 Word 里变成 <!--MATHBLOCK_7--> 字面量；
//  2) 含 < 的行内公式 $O(1) < O(\log n) < ...$ 在 Word 里变成 O(1) &lt; ... 纯文本、未渲染。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { installGlobals } = require('./helpers/dom.js');
const { renderMarkdown } = require('../src/unified-renderer.js');
const PP = require('../src/modules/preview-post.js');

function makePreviewDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div class="preview-content"></div></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const preview = dom.window.document.querySelector('.preview-content');
  return { dom, window: dom.window, document: dom.window.document, preview };
}

// 用真实 KaTeX 加载 renderMathInElement 到全局，模拟浏览器侧 processMath 的渲染环境。
function loadKatex(window) {
  const katexJs = path.resolve(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.js');
  const arJs = path.resolve(__dirname, '..', 'node_modules', 'katex', 'dist', 'contrib', 'auto-render.js');
  if (!fs.existsSync(katexJs) || !fs.existsSync(arJs)) return false;
  window.eval(fs.readFileSync(katexJs, 'utf8'));
  window.eval(fs.readFileSync(arJs, 'utf8'));
  global.katex = window.katex;
  global.renderMathInElement = window.renderMathInElement;
  return true;
}

function setupAndRender(md) {
  const env = makePreviewDom();
  installGlobals(env.window);
  const ok = loadKatex(env.window);
  if (!ok) return { env, ok: false };
  const html = renderMarkdown(md, { softBreaks: false, extendedSyntax: true });
  env.preview.innerHTML = html;
  PP.processMath(env.preview);
  return { env, ok: true };
}

test('行内公式 $E = mc^2$ / $a^2 + b^2 = c^2$ 渲染为 KaTeX（不再残留 MATHBLOCK）', async () => {
  const { env, ok } = setupAndRender('质能方程 $E = mc^2$，勾股定理 $a^2 + b^2 = c^2$。');
  if (!ok) return; // 缺 katex 依赖则跳过，不阻断套件
  const preview = env.preview;
  assert.strictEqual(preview.querySelectorAll('.katex').length, 2, '两个行内公式都应渲染出 .katex');
  assert.strictEqual(preview.querySelectorAll('.katex-mathml').length, 2, '应提取出 <math> 供 docx 转 OMML');
  assert.ok(!preview.textContent.includes('MATHBLOCK'), '不应残留 MATHBLOCK 占位符');
  assert.strictEqual((preview.textContent.match(/\$/g) || []).length, 0, '渲染后不应残留 $ 字面量');
});

test('GitHub 官方写法 `$x^2$` 亦渲染为行内公式', async () => {
  const { env, ok } = setupAndRender('也支持 GitHub 官方写法 `$x^2$`。');
  if (!ok) return;
  const preview = env.preview;
  assert.ok(preview.querySelector('.katex'), '反引号包裹的 $...$ 应渲染为公式');
  assert.ok(!preview.textContent.includes('MATHBLOCK'), '不应残留占位符');
});

test('含 < 的行内公式 $O(1) < O(\\log n) < ...$ 必须渲染（不退化成 &lt; 纯文本）', async () => {
  const { env, ok } = setupAndRender('复杂度：$O(1) < O(\\log n) < O(n) < O(n \\log n) < O(n^2) < O(2^n)$。');
  if (!ok) return;
  const preview = env.preview;
  assert.strictEqual(preview.querySelectorAll('.katex').length, 1, '含 < 的公式应渲染出 .katex');
  assert.ok(preview.querySelector('.katex-mathml'), '应提取出 <math> 供 docx 转 OMML');
  assert.ok(!preview.textContent.includes('&lt;'), '不应残留转义的 &lt;');
  assert.ok(!preview.textContent.includes('MATHBLOCK'), '不应残留占位符');
});

test('行内公式经 domToDocxStructure 提取为 mathml run（docx 可转 OMML）', async () => {
  const { env, ok } = setupAndRender('质能方程 $E = mc^2$。');
  if (!ok) return;
  // 与预览同文档内挂载 export-docx 模块，确保 domToDocxStructure 与预览节点在同一 realm
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'export-docx.js'), 'utf8');
  env.window.eval(src);
  // 真实导出流程中 domToDocxStructure 接收的容器，其直接子节点即为 markdown 元素（<p>/<h1>…），
  // 故直接对预览容器（.preview-content）取结构，不要额外再包一层 div（否则孙子节点不会被遍历）。
  const structure = env.window.domToDocxStructure(env.preview);
  const para = structure.find(n => n.type === 'paragraph');
  assert.ok(para, '应有段落节点');
  const mathRun = para.runs.find(r => r.mathml);
  assert.ok(mathRun, '应提取 mathml run（供 docx 主路径转 OMML 可编辑公式）');
  assert.ok(mathRun.mathml.includes('<math'), 'mathml 应含 <math> 元素');
});
