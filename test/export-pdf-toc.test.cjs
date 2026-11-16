// PDF 纸面目录页测试（Task 6 纯函数 + Task 7 接线 + 审查修复轮）
//
// 覆盖 export.js mixin 的三个 TOC 方法：
//   _pdfTocEntries(printRoot, maxLevel)  —— 从打印根 DOM 收集标题（层级/真实id/label HTML）
//   _buildPdfTocHtml(entries)            —— 目录页 HTML（占位页码 000 / 锚点链接 / 点线）
//   _fillPdfTocPageNumbers(...)          —— 按大纲页码数组填充真实页码
//
// 数据源 = 打印根 DOM 标题（审查修复轮的关键决定）：PDF 书签大纲（generateDocumentOutline）
// 同样派生自 DOM h1–h6，两者文档序天然一一对应——页码 zip 不需要文本/id 匹配，
// 数学标题（KaTeX 双层 DOM）不产生 id 失配。label 取标题 innerHTML（公式/加粗已渲染）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

// 与既有 export 测试同款：应用内保存对话框返回固定路径，否则 exportPDF 选路径后提前 return
const pdfSaveInvoke = (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.pdf' : null);

async function makeEnv() {
  const { w, getInitErr } = await buildEnv({ invokeImpl: pdfSaveInvoke, captureInitErr: true });
  await delay(300); // 等模块装配与编辑器初始化
  return { w, ed: w.editor, getInitErr };
}

// 在指定根下建 DOM 标题；labelHtml 为标题内容（innerHTML）
function addHeading(root, tag, id, labelHtml) {
  const h = root.ownerDocument.createElement(tag);
  if (id) h.id = id;
  if (labelHtml != null) h.innerHTML = labelHtml;
  root.appendChild(h);
  return h;
}

test('toc: 无标题文档条目为空（不插空目录页）', async () => {
  const { w, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const root = w.document.createElement('div');
    root.innerHTML = '<p>普通段落，没有标题</p>';
    const entries = w.TMExport.mixin._pdfTocEntries.call({}, root, 6);
    assert.strictEqual(entries.length, 0);
  } finally { cleanup(w); }
});

test('toc: 深度过滤 maxLevel（默认 6 全量，3 时滤掉 h4-h6）', async () => {
  const { w, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    const root = w.document.createElement('div');
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach((tag, i) => addHeading(root, tag, 'id-' + i, '标题'));
    const mixin = w.TMExport.mixin;
    assert.strictEqual(mixin._pdfTocEntries.call({}, root, 6).length, 6, 'h1-h6 全量');
    const l3 = mixin._pdfTocEntries.call({}, root, 3);
    assert.strictEqual(l3.length, 3);
    assert.ok(l3.every((e) => e.level <= 3), '过滤后仅剩 level<=3');
    assert.ok(l3.every((e) => e.id), '无 id 的标题被剔除（锚点不存在则跳转落空）');
  } finally { cleanup(w); }
});

test('toc: label 复用标题渲染 HTML（公式/加粗保留），层级类名与链接正确', async () => {
  const { w, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    const root = w.document.createElement('div');
    // 模拟打印根：KaTeX 渲染后的 katex-html span（视觉层）+ 内部链接（unwrap 断言）
    addHeading(root, 'h1', 'math-1',
      '第 1 章 <span class="katex"><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord mathnormal">E</span>=<span class="mord">m</span><span class="mord mathnormal">c</span><sup>2</sup></span></span></span>');
    const h2 = addHeading(root, 'h2', 'link-2', '');
    h2.innerHTML = '带 <a href="#x">链接</a> 的标题';
    const entries = w.TMExport.mixin._pdfTocEntries.call({}, root, 6);
    assert.strictEqual(entries.length, 2);
    // unwrap 断言打在数据层（entries），html 正则易误伤外层 <a class="pdf-toc-link">
    assert.ok(!/<a /.test(entries[1].html), 'label 内部链接被 unwrap（嵌套 a 非法）');
    assert.match(entries[1].html, /链接/, 'unwrap 后链接文字保留');
    const html = w.TMExport.mixin._buildPdfTocHtml.call(
      { t: (k) => (k === 'pdfTocTitle' ? '目录' : k) }, entries,
    );
    assert.match(html, /href="#math-1"/, '锚点用 DOM 真实 id（数学标题 id 不会失配）');
    assert.match(html, /katex-html/, 'label 保留渲染好的公式（纸面目录公式与正文同观感）');
    assert.match(html, /data-toc-num="math-1"/, '页码占位槽按 DOM id 标记');
    assert.match(html, /000/, '固定宽占位页码（两遍打印几何一致）');
    assert.match(html, /pdf-toc-level-1/);
    assert.match(html, /pdf-toc-level-2/);
    assert.match(html, /目录/, 'TOC 标题');
  } finally { cleanup(w); }
});

test('toc: 页码填充按 DOM 标题序 zip 大纲序；数量不等全空（宁缺勿串页）', async () => {
  const { w, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    const doc = w.document;
    const printRoot = doc.createElement('div');
    addHeading(printRoot, 'h1', 'p-a', 'A');
    addHeading(printRoot, 'h2', 'p-b', 'B');
    addHeading(printRoot, 'h1', 'p-c', 'C');
    const toc = doc.createElement('div');
    toc.innerHTML = ['p-a', 'p-b', 'p-c']
      .map((id) => `<span data-toc-num="${id}">000</span>`).join('');
    const mixin = w.TMExport.mixin;
    mixin._fillPdfTocPageNumbers.call({}, toc, printRoot, [0, 4, 9]);
    assert.strictEqual(toc.querySelector('[data-toc-num="p-a"]').textContent, '1');
    assert.strictEqual(toc.querySelector('[data-toc-num="p-b"]').textContent, '5');
    assert.strictEqual(toc.querySelector('[data-toc-num="p-c"]').textContent, '10');
    // 数量不等（Chromium 跳过个别标题等结构异常）：全部留空——部分错位比缺失更危险
    mixin._fillPdfTocPageNumbers.call({}, toc, printRoot, [0, 4]);
    assert.strictEqual(toc.querySelector('[data-toc-num="p-a"]').textContent, '');
    assert.strictEqual(toc.querySelector('[data-toc-num="p-b"]').textContent, '');
    assert.strictEqual(toc.querySelector('[data-toc-num="p-c"]').textContent, '');
    // outlinePages 缺失（Rust 解析失败）也走全空
    mixin._fillPdfTocPageNumbers.call({}, toc, printRoot, null);
    assert.strictEqual(toc.querySelector('[data-toc-num="p-a"]').textContent, '');
  } finally { cleanup(w); }
});

test('toc-css: 打印样式含目录分页与点线规则（追加于末尾，不动既有规则体）', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/modules/export.js'), 'utf8');
  const a = src.indexOf('.pdf-toc-page { margin: 0; }');
  assert.ok(a > 0, 'printStyle 末尾应有 TOC 样式块');
  const block = src.slice(a, src.indexOf('`;', a));
  assert.match(block, /\.pdf-toc-end\s*\{\s*page-break-after:\s*always/, '目录后强制分页（正文从新页开始）');
  assert.match(block, /\.pdf-toc-leader\s*\{[^}]*border-bottom:\s*1px dotted/, '点线引导');
  assert.match(block, /\.pdf-toc-num\s*\{[^}]*tabular-nums/, '页码等宽数字');
});

// ===== exportPDF 两遍打印接线 =====

// 带标题的文档环境：preview DOM 三个标题（id a/b/c）——数据源即打印根 DOM，无需打桩
async function makeTocEditor(w, ed) {
  ed.showConfirmDialog = async () => true;
  ed.activeTab.name = 'NOTE.md';
  ed.preview.innerHTML = '<h1 id="a">A</h1><p>x</p><h2 id="b">B</h2><p>y</p><h1 id="c">C</h1>';
}

test('toc-wiring: CDP 可用 → 两遍打印（第一遍 outlineOnly，第二遍页码已填充）', async () => {
  const { w, ed, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    await makeTocEditor(w, ed);
    const calls = [];
    w.TauriApi.printToPdf = async ({ options }) => {
      const root = w.document.getElementById('pdf-print-root');
      const toc = root ? root.querySelector('.pdf-toc-page') : null;
      calls.push({
        options,
        hasToc: !!toc,
        tocNums: toc ? [...toc.querySelectorAll('.pdf-toc-num')].map((e) => e.textContent) : null,
      });
      return { viaCdp: true, outlinePages: [0, 4, 9] };
    };
    await ed.exportPDF();
    assert.strictEqual(calls.length, 2, '两遍打印');
    assert.strictEqual(calls[0].options.outlineOnly, true, '第一遍只要大纲');
    assert.strictEqual(calls[0].options.path, calls[1].options.path, '两遍同一目标路径');
    assert.strictEqual(calls[1].options.outlineOnly, undefined, '第二遍正式落盘');
    assert.strictEqual(calls[0].tocNums.join(','), '000,000,000', '第一遍仍是占位页码');
    assert.strictEqual(calls[1].tocNums.join(','), '1,5,10', '第二遍前已填充真实页码（0/4/9 → 1/5/10）');
    assert.ok(calls[0].hasToc && calls[1].hasToc, '两遍都带目录页');
  } finally { cleanup(w); }
});

test('toc-wiring: CDP 不可用（viaCdp:false）→ 目录页移除后回退单遍落盘', async () => {
  const { w, ed, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    await makeTocEditor(w, ed);
    const calls = [];
    w.TauriApi.printToPdf = async ({ options }) => {
      const root = w.document.getElementById('pdf-print-root');
      calls.push({ options, hasToc: !!(root && root.querySelector('.pdf-toc-page')) });
      return { viaCdp: false };
    };
    const toasts = [];
    ed.showToast = (msg, type) => toasts.push({ msg, type });
    await ed.exportPDF();
    assert.strictEqual(calls.length, 2, '第一遍 outlineOnly 探测 + 第二遍回退落盘');
    assert.strictEqual(calls[0].options.outlineOnly, true);
    assert.strictEqual(calls[0].hasToc, true, '第一遍打印态里有目录页');
    assert.strictEqual(calls[1].hasToc, false, '回退前目录页已移除（老运行时不出半成品）');
    assert.strictEqual(calls[1].options.outlineOnly, undefined);
    assert.ok(toasts.some((t) => t.type === 'success'), '回退路径导出仍算成功');
  } finally { cleanup(w); }
});

test('toc-wiring: CDP 成功但大纲解析失败（outlinePages 缺失）→ 目录保留、页码全空', async () => {
  // 设计规格 §B.2：解析失败降级为「无页码目录，条目仍可点击」，不是移除目录页
  const { w, ed, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    await makeTocEditor(w, ed);
    const calls = [];
    w.TauriApi.printToPdf = async ({ options }) => {
      const root = w.document.getElementById('pdf-print-root');
      const toc = root ? root.querySelector('.pdf-toc-page') : null;
      calls.push({
        options,
        hasToc: !!toc,
        tocNums: toc ? [...toc.querySelectorAll('.pdf-toc-num')].map((e) => e.textContent) : null,
      });
      return { viaCdp: true, outlinePages: null };
    };
    await ed.exportPDF();
    assert.strictEqual(calls.length, 2, '仍两遍（书签在，页码解析失败而已）');
    assert.ok(calls[0].hasToc && calls[1].hasToc, '目录页保留');
    assert.strictEqual(calls[1].tocNums.join(','), ',,', '页码全空不串页');
  } finally { cleanup(w); }
});

test('toc-wiring: 无标题文档 → 单遍打印、无 outlineOnly、无目录页', async () => {
  const { w, ed, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    ed.showConfirmDialog = async () => true;
    ed.activeTab.name = 'NOTE.md';
    ed.preview.innerHTML = '<p>正文</p>';
    const calls = [];
    w.TauriApi.printToPdf = async ({ options }) => {
      const root = w.document.getElementById('pdf-print-root');
      calls.push({ options, hasToc: !!(root && root.querySelector('.pdf-toc-page')) });
      return { viaCdp: true, outlinePages: [] };
    };
    await ed.exportPDF();
    assert.strictEqual(calls.length, 1, '无目录需求 → 单遍（书签由 Rust 侧顺带生成）');
    assert.strictEqual(calls[0].options.outlineOnly, undefined);
    assert.strictEqual(calls[0].hasToc, false, '无标题不插空目录页');
  } finally { cleanup(w); }
});

test('toc-wiring: 两遍之间清空标签 → 不抛未捕获异常，finally 清理无残留', async () => {
  const { w, ed, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    await makeTocEditor(w, ed);
    const calls = [];
    w.TauriApi.printToPdf = async ({ options }) => {
      calls.push(options);
      if (options.outlineOnly) {
        // 第一遍返回前清空标签（模拟用户中途关文档）
        ed.activeTab = null;
      }
      return { viaCdp: true, outlinePages: [0, 4, 9] };
    };
    await ed.exportPDF();
    assert.strictEqual(calls.length, 2, '填充页码不依赖 activeTab，流程走完');
    assert.strictEqual(w.document.getElementById('pdf-print-root'), null, 'print-root 已清理');
    assert.strictEqual(w.document.getElementById('tm-pdf-print-style'), null, '打印样式已清理');
    assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '导出遮罩已收尾');
    assert.ok(!w.document.documentElement.classList.contains('pdf-printing'), '打印态类已摘除');
  } finally { cleanup(w); }
});
