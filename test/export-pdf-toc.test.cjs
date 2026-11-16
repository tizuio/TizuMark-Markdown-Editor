// PDF 纸面目录页纯函数测试（Task 6）
//
// 覆盖 export.js mixin 的三个 TOC 方法：
//   _pdfTocEntries(maxLevel)      —— 从 activeTab.content 提取并按深度过滤
//   _buildPdfTocHtml(entries)     —— 目录页 HTML（占位页码 000 / 锚点链接 / 点线）
//   _fillPdfTocPageNumbers(...)   —— 按大纲页码数组填充真实页码（缺页留空）
//
// 方法经 app-env harness 加载进 jsdom（w.TMExport.mixin 直接可调），纯函数语义用
// 假 this 注入（activeTab / headingToId / t），不依赖编辑器实例的真实状态。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

async function makeEnv() {
  const { w, getInitErr } = await buildEnv({ captureInitErr: true });
  await delay(300); // 等模块装配与编辑器初始化
  return { w, ed: w.editor, getInitErr };
}

// 与 layout.js:782 同语义的简化 headingToId（纯函数测试只需确定性，不必逐字一致）
const FAKE_HEADING_TO_ID = (t) => t.trim().toLowerCase().replace(/\s+/g, '-');

test('toc: 无标题文档条目为空（不插空目录页）', async () => {
  const { w, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const entries = w.TMExport.mixin._pdfTocEntries.call({
      activeTab: { content: '普通段落，没有标题' },
      headingToId: FAKE_HEADING_TO_ID,
    }, 6);
    // 注：不用 deepStrictEqual([])——entries 产自 jsdom realm 的 Array，原型不同会被误判
    assert.strictEqual(entries.length, 0);
  } finally { cleanup(w); }
});

test('toc: 深度过滤 maxLevel（默认 6 全量，3 时滤掉 h4-h6）', async () => {
  const { w, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    const mixin = w.TMExport.mixin;
    const fake = {
      activeTab: { content: '# A\n## B\n### C\n#### D\n##### E\n###### F\n' },
      headingToId: FAKE_HEADING_TO_ID,
    };
    assert.strictEqual(mixin._pdfTocEntries.call(fake, 6).length, 6, 'h1-h6 全量');
    const l3 = mixin._pdfTocEntries.call(fake, 3);
    assert.strictEqual(l3.length, 3);
    assert.ok(l3.every((e) => e.level <= 3), '过滤后仅剩 level<=3');
  } finally { cleanup(w); }
});

test('toc: html 含锚点链接 / 占位页码 / 层级类名；label 干净且保留 $..$', async () => {
  const { w, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    const html = w.TMExport.mixin._buildPdfTocHtml.call(
      { t: (k) => (k === 'pdfTocTitle' ? '目录' : k) },
      [
        { level: 1, text: '第 1 章 加粗$E=mc^2$', id: 'id-1' },
        { level: 3, text: '小节', id: 'id-2' },
      ],
    );
    assert.match(html, /href="#id-1"/, '锚点链接（Chromium 打印转 PDF 跳转链接）');
    assert.match(html, /href="#id-2"/);
    assert.match(html, /data-toc-num="id-1"/, '页码占位槽按 id 标记');
    assert.match(html, /000/, '固定宽占位页码（两遍打印几何一致）');
    assert.match(html, /pdf-toc-level-1/);
    assert.match(html, /pdf-toc-level-3/);
    assert.match(html, /目录/, 'TOC 标题');
    assert.match(html, /\$E=mc\^2\$/, 'label 保留 $...$ 原文（打印 DOM 内由 processMath 渲染）');
    // 端到端口径：_pdfTocEntries 产出（含 ** 的 markdown 标题）→ label 无 ** 残留
    const entries = w.TMExport.mixin._pdfTocEntries.call({
      activeTab: { content: '# 第 1 章 **加粗**$E=mc^2$\n' },
      headingToId: FAKE_HEADING_TO_ID,
    }, 6);
    const html2 = w.TMExport.mixin._buildPdfTocHtml.call(
      { t: (k) => (k === 'pdfTocTitle' ? '目录' : k) }, entries,
    );
    assert.ok(!/\*\*/.test(html2), 'label 不残留 markdown 标记（extractHeadings 已剥离）');
    assert.match(html2, /\$E=mc\^2\$/, '端到端仍保留 $...$ 供 processMath 渲染');
  } finally { cleanup(w); }
});

test('toc: 页码填充按 DOM 标题序 zip 大纲序；页数不足留空不串页', async () => {
  const { w, getInitErr } = await makeEnv();
  try {
    assert.strictEqual(getInitErr(), null);
    const doc = w.document;
    const printRoot = doc.createElement('div');
    const mk = (tag, id) => { const el = doc.createElement(tag); el.id = id; return el; };
    printRoot.appendChild(mk('h1', 'p-a'));
    printRoot.appendChild(mk('h2', 'p-b'));
    printRoot.appendChild(mk('h1', 'p-c'));
    const toc = doc.createElement('div');
    toc.innerHTML = ['p-a', 'p-b', 'p-c']
      .map((id) => `<span data-toc-num="${id}">000</span>`).join('');
    const mixin = w.TMExport.mixin;
    mixin._fillPdfTocPageNumbers.call({}, toc, printRoot, [0, 4, 9]);
    assert.strictEqual(toc.querySelector('[data-toc-num="p-a"]').textContent, '1');
    assert.strictEqual(toc.querySelector('[data-toc-num="p-b"]').textContent, '5');
    assert.strictEqual(toc.querySelector('[data-toc-num="p-c"]').textContent, '10');
    // 页数不足（Chromium 跳过个别标题等）：缺页条目留空，其余不串页
    mixin._fillPdfTocPageNumbers.call({}, toc, printRoot, [0]);
    assert.strictEqual(toc.querySelector('[data-toc-num="p-a"]').textContent, '1');
    assert.strictEqual(toc.querySelector('[data-toc-num="p-b"]').textContent, '');
    assert.strictEqual(toc.querySelector('[data-toc-num="p-c"]').textContent, '');
  } finally { cleanup(w); }
});
