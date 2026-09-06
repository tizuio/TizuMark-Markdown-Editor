# DOCX 导出重写为真 OOXML 实现计划（计划 B）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 TizuMark 的 Word/DOCX 导出从「HTML altChunk（html-docx-js）」重写为「真 OOXML（docx 库）」，使标题映射 Word 真样式、表格/代码块/排版保真、兼容 WPS/Google Docs、支持每次导出时选择页面尺寸与边距。

**架构：** 主线程遍历预处理后的预览 DOM，转成一组**可序列化的中间节点结构**（纯 JSON，可 postMessage）；worker 内 `importScripts` 打包好的 `docx.min.js`（全局 `DocxLib`），把中间结构重建为 `DocxLib.Document` 并 `Packer.toBlob`，返回 ArrayBuffer。保留现有 `exportWord()` 的确认框、loading overlay、保存对话框、图片尺寸采集、`_prepareWordDOM`；新增 `_domToDocxNodes` 中间结构转换，替换最后的 `asBlob` 步骤；保留 html-docx altChunk 作为回退。

**技术栈：** `docx`（npm，ESM，esbuild 打成 IIFE 全局 `DocxLib`）、esbuild（vendor 打包）、现有 `ensure-vendor.mjs`/`build-renderer.mjs` 体系。

---

## 文件结构

- 修改：`scripts/ensure-vendor.mjs` — 新增 `buildDocxMin()`（esbuild 打包 docx → `src/lib/docx.min.js`，全局 `DocxLib`）
- 修改：`scripts/build-renderer.mjs` — 打包 renderer 后触发 `<script src="lib/docx.min.js">` 的引用（若 index.html 用 script 标签加载则在此；详见任务 1）
- 修改：`src/index.html` — 引入 `lib/docx.min.js` 的 `<script>` 标签（主线程可访问 `DocxLib` 用于回退或调试）
- 修改：`src/lib/word-export.worker.js` — 改为 `importScripts('./docx.min.js')`，接收中间结构调整 `DocxLib.Document` 并 `Packer.toBlob`
- 修改：`src/app.js` — 新增 `_domToDocxNodes()`、`_docxNodeToStructure()`、`_buildDocxFromStructure()`、`_showDocxPageDialog()`，重构 `exportWord()` 尾部
- 修改：`src/index.html` — 新增「导出页面设置」对话框（A4/Letter + 边距）
- 新增：`test/export-docx-nodes.test.cjs` — DOM→中间结构映射的纯函数测试
- 新增：`test/export-docx-page.test.cjs` — 页面设置对话框/尺寸计算测试

---

## 任务 1：vendor 打包 docx 库

**文件：**
- 修改：`scripts/ensure-vendor.mjs`（新增 `buildDocxMin`，并在文件末尾调用）
- 修改：`scripts/build-renderer.mjs`（改后无——用 index.html 的 `<script>` 标签引入，见任务 2；此处仅确认 ensure-vendor 产出 `src/lib/docx.min.js`）
- 测试：无独立测试（验证方式是确认产物存在 + 可 eval 出 `DocxLib` 全局）

### 步骤 1：确认 docx 依赖已安装

运行：`npm ls docx`
预期：`docx@^9.x` 已装（本项目已 `npm install docx --save`）。

### 步骤 2：在 `scripts/ensure-vendor.mjs` 新增 `buildDocxMin()`

在 `buildHighlightMin()` 函数之后、`await buildHighlightMin();` 调用附近，新增：

```js
// docx.min.js：esbuild 现打包一个全局 DocxLib（Word 导出真 OOXML 用）。
// 与 highlight.js 同理：node_modules 无浏览器 UMD，须用 esbuild 从 ESM 入口打包成 IIFE。
async function buildDocxMin() {
  const esbuild = await import('esbuild');
  const outfile = path.join(LIB, 'docx.min.js');
  await esbuild.build({
    entryPoints: [path.join(NM, 'docx', 'dist', 'index.mjs')],
    bundle: true,
    format: 'iife',
    globalName: 'DocxLib',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    outfile,
    logLevel: 'silent',
    // docx 库用到一些 Node 全局（Buffer 等）会被 esbuild 标记 external；需 shim。
    // 若无 shim 可用注入一个最小 Buffer polyfill（见下）。
  });
  console.log('[ensure-vendor] 打包 docx.min.js（全局 DocxLib）完成');
}
```

> 注意：docx 可能引用 Node 的 `Buffer`/`stream` 等。esbuild `platform:'browser'` 会把这些标为 external 或报错。实现在 worker 里 `Buffer` 全局缺失。为此，docx.min.js 需要在构建时 `define` 或注入 shim。**若 `buildDocxMin()` 里 esbuild 报 missing Buffer，则先在 esbuild 配置里加一个虚拟 shim（`src/lib/docx-shim.js` 提供 `Buffer`（Uint8Array 包装）与必要的 `stream`/`util` 最小实现），并在 buildDocxMin 里 `inject: [path.join(LIB, 'docx-shim.js')]`。** 以实际构建结果为准：能打出且能加载出 `DocxLib` 即为成功。

### 步骤 3：运行构建并验证产物

运行：`node scripts/ensure-vendor.mjs`（或 `npm run prepare`）
预期：`src/lib/docx.min.js` 生成，无报错。

验证产物可加载：
```bash
node -e "const fs=require('fs');const vm=require('vm');const code=fs.readFileSync('src/lib/docx.min.js','utf8');const s={console,setTimeout,clearTimeout,TextEncoder,TextDecoder,Blob,URL,navigator:{},location:{href:'http://localhost/'}};s.globalThis=s;s.window=s;s.self=s;vm.createContext(s);try{vm.runInContext(code,s);const D=s.DocxLib;console.log('DocxLib:',!!D&&typeof D.Document==='function', 'Packer:',!!D&&typeof D.Packer==='function');}catch(e){console.log('ERR',e.message)}"
```
预期：`DocxLib: true Packer: true`

### 步骤 4：Commit

```bash
git add scripts/ensure-vendor.mjs src/lib/docx.min.js
git commit -m "build: vendor 打包 docx 库为全局 DocxLib（src/lib/docx.min.js）"
```

> 若需新增 `src/lib/docx-shim.js` 一并提交。

---

## 任务 2：worker 改用 docx 生成 OOXML

**文件：**
- 修改：`src/lib/word-export.worker.js`
- 测试：`test/export-docx-worker.test.cjs`（新增，验证 worker 逻辑）——因 jsdom harness 不跑真 worker，改为单测「中间结构调整函数」（见任务 3）；本任务聚焦 worker 的协议解析正确性

### 步骤 1：理解现有 worker 接口

现有 `src/lib/word-export.worker.js`：
```js
importScripts('./html-docx.min.js');
self.onmessage = function (e) {
  const { id, html } = e.data;
  try {
    const blob = self.htmlDocx.asBlob(html);
    const reader = new FileReaderSync();
    const arrayBuffer = reader.readAsArrayBuffer(blob);
    self.postMessage({ id, success: true, arrayBuffer }, [arrayBuffer]);
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message || String(err) });
  }
};
```

### 步骤 3：改写 worker 接收统一 payload（按 type 分派 docx / html 两条路径）

```js
// Word 导出打包 Worker：在独立线程中运行 docx 库，避免阻塞主线程。
// 主线程传入统一 payload：{ id, type:'docx', structure, page }（真 OOXML）或
//                   { id, type:'html', html }（回退 altChunk，走 html-docx-js）。
// worker 按 type 选择 DocxLib（真 OOXML）或 htmlDocx（回退）。
importScripts('./docx.min.js');
importScripts('./html-docx.min.js');

// 重建 docx 的中介函数：把主线程的中间结构转成 DocxLib 对象树。
function buildDocx(structure, page) {
  const D = self.DocxLib;
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = D;
  const children = [];
  for (const node of structure || []) {
    if (node.type === 'heading') {
      children.push(new Paragraph({ heading: HeadingLevel['HEADING_' + (node.level || 1)], children: node.runs.map(r => new TextRun({ text: r.text, bold: r.bold, italics: r.italics, strike: r.strike, color: r.color })) }));
    } else if (node.type === 'paragraph') {
      children.push(new Paragraph({ children: node.runs.map(r => new TextRun({ text: r.text, bold: r.bold, italics: r.italics, strike: r.strike, color: r.color })), alignment: node.align ? AlignmentType[node.align] : undefined }));
    } else if (node.type === 'bullet') {
      children.push(new Paragraph({ text: (node.runs && node.runs[0] && node.runs[0].text) || '', bullet: { level: node.level || 0 } }));
    } else if (node.type === 'table') {
      children.push(buildTable(D, node));
    } else if (node.type === 'code') {
      children.push(new Paragraph({ children: node.lines.map(l => ({ text: l })), shading: { type: D.ShadingType.CLEAR, fill: 'F6F5F4' }, spacing: { before: 120, after: 120 } }));
    } else if (node.type === 'image') {
      children.push(new Paragraph({ children: [ new D.ImageRun({ data: Uint8Array.from(node.data), transformation: { width: node.width, height: node.height } }) ] }));
    }
  }
  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: page.pageWidth, height: page.pageHeight }, margin: { top: page.marginTop, bottom: page.marginBottom, left: page.marginLeft, right: page.marginRight } } },
      children,
    }]
  });
  return Packer.toBlob(doc);
}

// 表格构建（独立，便于测试）
function buildTable(D, node) {
  const rows = (node.rows || []).map(row => new D.TableRow({
    children: row.cells.map(cell => new D.TableCell({
      children: (cell.paragraphs || []).map(p => new D.Paragraph(p.text || '')),
      width: { size: cell.width || 0, type: D.WidthType.PERCENTAGE },
    }))
  }));
  return new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } });
}

function toArrayBuffer(blob) {
  const reader = new FileReaderSync();
  return reader.readAsArrayBuffer(blob);
}

self.onmessage = function (e) {
  const { id, type } = e.data;
  try {
    if (type === 'docx') {
      const blob = buildDocx(e.data.structure, e.data.page);
      const arrayBuffer = toArrayBuffer(blob);
      self.postMessage({ id, success: true, arrayBuffer }, [arrayBuffer]);
    } else {
      // 回退 altChunk
      const blob = self.htmlDocx.asBlob(e.data.html);
      const arrayBuffer = toArrayBuffer(blob);
      self.postMessage({ id, success: true, arrayBuffer }, [arrayBuffer]);
    }
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message || String(err) });
  }
};
```

> 注：`buildDocx`/`buildTable` 依赖 `self.DocxLib` 的 `ShadingType`/`WidthType`（均为命名导出，经 `self.DocxLib.ShadingType`/`self.DocxLib.WidthType` 访问）。此 worker 在 Node/jsdom 测试里不会真实执行（无 importScripts），故协议正确性靠任务 3 的纯函数单测覆盖，worker 本身由「手动冒烟」验证。

### 步骤 5：Commit

```bash
git add src/lib/word-export.worker.js
git commit -m "refactor: Word 导出 worker 改用 docx 库生成真 OOXML"
```

---

## 任务 3：主线程 DOM → 中间结构转换（核心纯函数）

**文件：**
- 新增：`src/modules/export-docx.js`（将 DOM 遍历逻辑抽成独立模块，便于单测）
- 修改：`src/app.js`（`exportWord` 调用该模块，去掉旧 `wordHTML` 组装）
- 测试：`test/export-docx-nodes.test.cjs`

> 把 `_domToDocxNodes` 抽到独立模块 `src/modules/export-docx.js`，暴露纯函数 `domToDocxStructure(rootEl)`，返回中间 JSON 结构（heading/paragraph/bullet/table/code/image 等节点数组）。app.js 与 worker 共享该结构协议。

### 步骤 1：编写失败测试

创建 `test/export-docx-nodes.test.cjs`：

```js
// 纯函数测试：把预览 DOM 的 clone 转成 docx 用的中间结构（可 postMessage 的纯 JSON）。
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

// 从模块加载 domToDocxStructure（该模块为 UMD，浏览器挂 window，node 挂 module.exports）
function loadDomModule(w) {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'export-docx.js'), 'utf8');
  w.eval(src);
  return w.domToDocxStructure;
}

test('domToDocxStructure: 标题/段落/加粗映射', () => {
  const dom = new JSDOM('<div id="root"><h1>一级标题</h1><p>正文 <strong>加粗</strong></p></div>');
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.ok(Array.isArray(structure), '应返回数组');
  assert.strictEqual(structure[0].type, 'heading');
  assert.strictEqual(structure[0].level, 1);
  assert.strictEqual(structure[0].runs[0].text, '一级标题');
  assert.strictEqual(structure[1].type, 'paragraph');
  assert.ok(structure[1].runs.some(r => r.bold && r.text === '加粗'), '加粗 run 应有 bold 标记');
});

test('domToDocxStructure: 任务列表 checkbox 转成可读 run（不产出 input 节点）', () => {
  const dom = new JSDOM('<div id="root"><ul><li><input type="checkbox" checked> 已完成</li></ul></div>');
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure[0].type, 'bullet');
  assert.ok(structure[0].runs && structure[0].runs.some(r => r.text.includes('☑')), '已勾选应转成 ☑ 文本');
  assert.ok(!JSON.stringify(structure).includes('checkbox'), '不应包含 input 节点');
});

test('domToDocxStructure: 表格映射为 table 节点', () => {
  const dom = new JSDOM('<div id="root"><table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table></div>');
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure[0].type, 'table');
  assert.strictEqual(structure[0].rows.length, 2);
  assert.strictEqual(structure[0].rows[0].cells[0].paragraphs[0].text, '列A');
});

test('domToDocxStructure: code 块映射为 code 节点（多行 lines）', () => {
  const dom = new JSDOM('<div id="root"><pre><code>const a = 1;\nconst b = 2;</code></pre></div>');
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure[0].type, 'code');
  assert.deepStrictEqual(structure[0].lines, ['const a = 1;', 'const b = 2;']);
});

test('domToDocxStructure: 图片映射为 image 节点（带 data 与宽高）', () => {
  const dom = new JSDOM('<div id="root"><p><img src="data:image/png;base64,iVBORw0KGgo=" data-natW="100" data-natH="50" data-dispW="100" data-dispH="50"></p></div>');
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const img = structure.find(n => n.type === 'image');
  assert.ok(img, '含 image 节点');
  assert.strictEqual(img.width, 100);
  assert.strictEqual(img.height, 50);
  assert.ok(img.data && img.data.length > 0, 'data 应有字节');
});
```

### 步骤 2：运行测试验证失败

运行：`node scripts/run-tests.cjs export-docx-nodes`
预期：FAIL（模块 `export-docx.js` 不存在）

### 步骤 3：创建 `src/modules/export-docx.js`

```js
// DOM → docx 中间结构（纯 JSON，可 postMessage 给 worker）的转换模块。
// 浏览器：挂 window.domToDocxStructure；node：module.exports（互斥式，与现有模块一致）。
(function () {
  // 内联图片 data URL → Uint8Array 字节
  function dataUrlToBytes(dataUrl) {
    const m = /^data:[^;]+;base64,(.+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    try { return Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)); } catch (e) { return null; }
  }

  // 收集一个元素内的“文本 run”，提取加粗/斜体/删除线/颜色。返回 runs 数组。
  function collectRuns(el, runs = []) {
    if (!el) return runs;
    for (const child of el.childNodes) {
      if (child.nodeType === 3) { // text
        const text = child.textContent || '';
        if (text) runs.push({ text });
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        const style = child.style || {};
        let runBase = {};
        if (tag === 'strong' || tag === 'b') runBase.bold = true;
        else if (tag === 'em' || tag === 'i') runBase.italics = true;
        else if (tag === 'del' || tag === 's') runBase.strike = true;
        else if (tag === 'code') runBase.codeStyle = true;
        else if (tag === 'mark') { runBase.highlight = true; }
        else if (tag === 'br') { runs.push({ break: true }); continue; }
        const color = style.color;
        if (color) runBase.color = color.replace('#', '').toUpperCase();
        const before = runs.length;
        collectRuns(child, runs);
        // 给该元素产生的 runs 打上 runBase（深度遍历第一层）
        for (let i = before; i < runs.length; i++) {
          if (!runs[i].bold && !runs[i].italics && !runs[i].strike && !runs[i].color) {
            runs[i] = { ...runs[i], ...runBase };
          }
        }
      }
    }
    return runs;
  }

  // 把单个 DOM 元素转成一个中间结构节点（或 null 跳过）。
  function elementToNode(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
      const level = parseInt(tag[1], 10);
      return { type: 'heading', level, runs: collectRuns(el) };
    }
    if (tag === 'p') {
      return { type: 'paragraph', runs: collectRuns(el), align: el.style.textAlign || undefined };
    }
    if (tag === 'blockquote') {
      const inner = el.querySelector('p');
      return { type: 'paragraph', runs: collectRuns(inner || el), quote: true };
    }
    if (tag === 'pre') {
      const code = el.querySelector('code');
      const text = (code ? code.textContent : el.textContent) || '';
      const lines = text.split('\n').map(l => l.trimEnd()).filter((l, i, a) => !(i === a.length - 1 && l === ''));
      return { type: 'code', lines };
    }
    if (tag === 'ul' || tag === 'ol') {
      const nodes = [];
      for (const li of el.querySelectorAll(':scope > li')) {
        const isTask = /task-list-item/.test(li.className || '');
        let text = '';
        // 提取 li 文本，checkbox 转 ☑/☐
        const cb = li.querySelector('input[type="checkbox"]');
        let prefix = '';
        if (cb) prefix = cb.checked ? '☑ ' : '☐ ';
        const inner = li.cloneNode(true);
        inner.removeChild(inner.querySelector('input[type="checkbox"]')); // 移除 checkbox 避免进文本
        text = prefix + (inner.textContent || '').replace(/\s+/g, ' ').trim();
        nodes.push({ type: 'bullet', level: 0, runs: [{ text }] });
        // 嵌套列表：简化处理，仅一层（嵌套在后续任务扩展）
        const nestedUl = li.querySelector(':scope > ul, :scope > ol');
        if (nestedUl) {
          for (const nli of nestedUl.querySelectorAll(':scope > li')) {
            nodes.push({ type: 'bullet', level: 1, runs: [{ text: (nli.textContent || '').replace(/\s+/g, ' ').trim() }] });
          }
        }
      }
      return { type: 'list', children: nodes };
    }
    if (tag === 'table') {
      const rows = [];
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [];
        for (const td of tr.querySelectorAll('th, td')) {
          cells.push({ paragraphs: [{ text: (td.textContent || '').replace(/\s+/g, ' ').trim() }], width: 0 });
        }
        rows.push({ cells });
      }
      return { type: 'table', rows };
    }
    if (tag === 'img') {
      const dataUrl = el.getAttribute('src') || '';
      const data = dataUrlToBytes(dataUrl);
      if (!data) return null;
      const w = parseInt(el.dataset.dispW || el.getAttribute('width') || el.naturalWidth || 100, 10) || 100;
      const h = parseInt(el.dataset.dispH || el.getAttribute('height') || el.naturalHeight || 100, 10) || 100;
      return { type: 'image', data: Array.from(data), width: w, height: h };
    }
    if (tag === 'hr') return { type: 'hr' };
    if (tag === 'div' && /mermaid-container/.test(el.className || '')) {
      const svg = el.querySelector('svg');
      // Mermaid 已在 _prepareWordDOM 转成 img（若未转，这里跳过，保留原 SVG 场景由回退处理）
      const img = el.querySelector('img');
      if (img) return elementToNode(img);
      return null; // 未内联时跳过
    }
    if (tag === 'div' && /alert/.test(el.className || '')) {
      const title = el.querySelector('.alert-title');
      const content = el.querySelector('.alert-content');
      const runs = [];
      if (title) runs.push({ text: (title.textContent || '').trim() + '\n', bold: true });
      if (content) runs.push(...(collectRuns(content)));
      return { type: 'paragraph', runs, quote: true };
    }
    return null;
  }

  // 主入口：遍历根元素直接子节点（跳过空文本，递归处理容器）
  function domToDocxStructure(root) {
    const out = [];
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (child.nodeType === 3) { // text node（顶层裸文本，忽略或作为段落）
          const t = (child.textContent || '').trim();
          if (t) out.push({ type: 'paragraph', runs: [{ text: t }] });
          continue;
        }
        if (child.nodeType !== 1) continue;
        const node = elementToNode(child);
        if (node && node.type === 'list') {
          out.push(...node.children);
        } else if (node) {
          out.push(node);
        }
      }
    };
    walk(root);
    return out;
  }

  const api = { domToDocxStructure };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.domToDocxStructure = domToDocxStructure;
})();
```

### 步骤 4：运行测试验证通过

运行：`node scripts/run-tests.cjs export-docx-nodes`
预期：全部 PASS

### 步骤 5：Commit

```bash
git add src/modules/export-docx.js test/export-docx-nodes.test.cjs
git commit -m "feat: DOM→docx 中间结构纯函数转换模块（含标题/表格/代码/图片/任务列表）"
```

---

## 任务 4：页面设置对话框（A4/Letter + 边距）

**文件：**
- 修改：`src/index.html`（新增对话框）
- 修改：`src/app.js`（新增 `_showDocxPageDialog()` 与页面尺寸计算）
- 测试：`test/export-docx-page.test.cjs`

### 步骤 1：编写失败测试

创建 `test/export-docx-page.test.cjs`：

```js
// 页面尺寸计算：A4 / Letter + 三种边距预设 → docx 用的 page size/margin（单位 twips，1/20 pt）。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('docx 页面尺寸：A4 纵向 / Letter 纵向', async () => {
  await withEditor({}, async (w, ed) => {
    assert.ok(typeof ed._docxPageSize === 'function', '_docxPageSize 应存在');
    const a4 = ed._docxPageSize('A4');
    assert.strictEqual(a4.width, 11906, 'A4 宽 11906 twips');
    assert.strictEqual(a4.height, 16838, 'A4 高 16838 twips');
    const letter = ed._docxPageSize('Letter');
    assert.strictEqual(letter.width, 12240, 'Letter 宽 12240');
    assert.strictEqual(letter.height, 15840, 'Letter 高 15840');
  });
});

test('docx 页面尺寸：A4 横向应交换宽高', async () => {
  await withEditor({}, async (w, ed) => {
    const landscape = ed._docxPageSize('A4', 'landscape');
    assert.strictEqual(landscape.width, 16838, '横向时宽=原高');
    assert.strictEqual(landscape.height, 11906, '横向时高=原宽');
  });
});

test('docx 边距：标准/窄/宽预览', async () => {
  await withEditor({}, async (w, ed) => {
    assert.ok(typeof ed._docxMargins === 'function', '_docxMargins 应存在');
    const normal = ed._docxMargins('normal');
    assert.strictEqual(normal.top, 1440, '标准上边距 1440');
    const narrow = ed._docxMargins('narrow');
    assert.ok(narrow.top < normal.top, '窄边距应小于标准');
    const wide = ed._docxMargins('wide');
    assert.ok(wide.top > normal.top, '宽边距应大于标准');
  });
});
```

### 步骤 2：运行测试验证失败

运行：`node scripts/run-tests.cjs export-docx-page`
预期：FAIL（`_docxPageSize`/`_docxMargins` 不存在）

### 步骤 3：实现 `_docxPageSize` / `_docxMargins` 与 `_showDocxPageDialog`

在 `src/app.js` 中添加以下方法（放在 `exportWord` 之前）：

```js
  // docx 页面尺寸（twips，1/20 pt）：A4 / Letter，支持纵向/横向。
  _docxPageSize(kind, orientation = 'portrait') {
    const sizes = {
      A4: { width: 11906, height: 16838 },
      Letter: { width: 12240, height: 15840 },
    };
    const s = sizes[kind] || sizes.A4;
    return orientation === 'landscape'
      ? { width: s.height, height: s.width }
      : { width: s.width, height: s.height };
  }

  // docx 边距（twips）：标准 / 窄 / 宽。
  _docxMargins(preset) {
    const map = {
      normal: { top: 1440, bottom: 1440, left: 1800, right: 1800 },
      narrow: { top: 720, bottom: 720, left: 720, right: 720 },
      wide: { top: 2880, bottom: 2880, left: 2880, right: 2880 },
    };
    return map[preset] || map.normal;
  }

  // 弹「导出页面设置」对话框（A4/Letter + 纸向 + 边距），返回 { kind, orientation, margin }；用户取消返回 null。
  _showDocxPageDialog() {
    // 复用现有 Dialogs 或新增轻量对话框。此处返回一个 Promise，resolve 配置对象或 null。
    return new Promise((resolve) => {
      const dlg = document.getElementById('docx-page-dialog');
      if (!dlg) { resolve({ kind: 'A4', orientation: 'portrait', margin: 'normal' }); return; }
      dlg.classList.remove('hidden');
      const done = (val) => {
        dlg.classList.add('hidden');
        resolve(val);
      };
      const cancelBtn = dlg.querySelector('.docx-page-cancel');
      const okBtn = dlg.querySelector('.docx-page-ok');
      const kindSel = dlg.querySelector('.docx-page-kind');
      const orientSel = dlg.querySelector('.docx-page-orient');
      const marginSel = dlg.querySelector('.docx-page-margin');
      if (cancelBtn) cancelBtn.onclick = () => done(null);
      if (okBtn) okBtn.onclick = () => done({
        kind: (kindSel && kindSel.value) || 'A4',
        orientation: (orientSel && orientSel.value) || 'portrait',
        margin: (marginSel && marginSel.value) || 'normal',
      });
    });
  }
```

### 步骤 4：在 `src/index.html` 添加对话框

在 `<body>` 内、现有对话框附近新增：

```html
<div class="dialog hidden" id="docx-page-dialog">
  <div class="dialog-titlebar">
    <h2>导出页面设置</h2>
    <button class="dialog-close docx-page-cancel" aria-label="取消">&times;</button>
  </div>
  <div class="dialog-content">
    <div class="settings-row">
      <label>纸张</label>
      <select class="docx-page-kind">
        <option value="A4">A4</option>
        <option value="Letter">Letter</option>
      </select>
    </div>
    <div class="settings-row">
      <label>方向</label>
      <select class="docx-page-orient">
        <option value="portrait">纵向</option>
        <option value="landscape">横向</option>
      </select>
    </div>
    <div class="settings-row">
      <label>页边距</label>
      <select class="docx-page-margin">
        <option value="normal">标准</option>
        <option value="narrow">窄</option>
        <option value="wide">宽</option>
      </select>
    </div>
  </div>
  <div class="dialog-footer">
    <button class="btn docx-page-cancel">取消</button>
    <button class="btn btn-primary docx-page-ok">导出</button>
  </div>
</div>
```

### 步骤 5：运行测试验证通过

运行：`node scripts/run-tests.cjs export-docx-page`
预期：全部 PASS

### 步骤 6：Commit

```bash
git add src/app.js src/index.html test/export-docx-page.test.cjs
git commit -m "feat: 导出页面设置对话框 + docx 页面尺寸/边距计算"
```

---

## 任务 5：重构 exportWord 接入真 OOXML（含回退）

**文件：**
- 修改：`src/app.js`（`exportWord` 末端：调用 `_showDocxPageDialog` → `domToDocxStructure` → worker → 写盘；失败回退 html-docx）
- 测试：`test/export-word.test.cjs`（现有，需适配断言）+ `test/export-docx-flow.test.cjs`（新增端到端 mock 流程）

### 步骤 1：编写失败/适配测试

新增 `test/export-docx-flow.test.cjs`：

```js
// exportWord 真 OOXML 流程：页面设置对话框 → DOM→结构 → worker → write_binary_file。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('exportWord: docx 库可用时走真 OOXML 流程', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    // 页面设置：直接 stub 返回 A4 标准
    ed._showDocxPageDialog = async () => ({ kind: 'A4', orientation: 'portrait', margin: 'normal' });
    // 确认框：直接通过
    ed.showConfirmDialog = async () => true;
    // 保护：document.getElementById('docx-page-dialog') 可能缺失，但 stub 已接管 _showDocxPageDialog
    // worker：stub _runWordExportWorker 返回假 docx 二进制（接收统一 payload）
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

test('exportWord: docx worker 失败时回退 html-docx altChunk', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed._showDocxPageDialog = async () => ({ kind: 'A4', orientation: 'portrait', margin: 'normal' });
    ed.showConfirmDialog = async () => true;
    // 模拟 docx worker 抛错 => exportWord 走回退
    ed._runWordExportWorker = async () => { throw new Error('docx worker failed'); };
    // 回退路径 _fallbackWordHtmlExport 复用 _convertHtmlToDocxBuffer：stub 返回假 docx 二进制
    ed._convertHtmlToDocxBuffer = async (html) => {
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
    };
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文</p>';

    await ed.exportWord();

    assert.strictEqual(captured.path, '/tmp/out.docx', '回退路径也应写出 docx');
  });
});
```

> 注：现有 `test/export-word.test.cjs` 断言 `w.__lastWordHTML` 的存在——重构后主路径不再产出 wordHTML。需同步调整：新增用例走「docx 主路径 + 回退」，并修订 export-word.test.cjs 里依赖 `__lastWordHTML` 的断言为「走回退路径时才记录」或改为断言 docx 二进制。以实际测试为准，保证旧测试不误报。

### 步骤 2：运行测试验证失败

运行：`node scripts/run-tests.cjs export-docx-flow`
预期：FAIL（`exportWord` 仍走 html-docx，未调用 `_showDocxPageDialog`）

### 步骤 3：重构 `exportWord` 末端

替换 `exportWord()` 中从 `// html-docx-js 把整段 HTML 作为 altChunk 嵌入...` 到 `const arrayBuffer = await this._convertHtmlToDocxBuffer(wordHTML);` 这段（约 9321-9356 行）。改为：

```js
      // 取页面设置（A4/Letter + 边距）；用户取消则中止
      const pageCfg = await this._showDocxPageDialog();
      if (!pageCfg) { hideOverlay(); return; }

      // 用 docx 库生成真 OOXML：DOM → 中间结构 → worker 构建 Document → toBlob。
      // 主线程不判断 DocxLib（仅在 worker importScripts），只要有 structure 就始终先试 docx 主路径，
      // 由 worker 内部失败（type 分派）后由 catch 触发回退 altChunk。
      const structure = (typeof window.domToDocxStructure === 'function')
        ? window.domToDocxStructure(clone)
        : null;
      if (structure && Array.isArray(structure) && structure.length > 0) {
        const pageSize = this._docxPageSize(pageCfg.kind, pageCfg.orientation);
        const margins = this._docxMargins(pageCfg.margin);
        try {
          const arrayBufferDocx = await this._runWordExportWorker({
            type: 'docx',
            structure,
            page: {
              pageWidth: pageSize.width, pageHeight: pageSize.height,
              marginTop: margins.top, marginBottom: margins.bottom,
              marginLeft: margins.left, marginRight: margins.right,
            },
          });
          clearTimeout(watchdog);
          const bufDocx = new Uint8Array(arrayBufferDocx);
          await TauriApi.writeBinaryFile({ path, contents: bufDocx });
          this.setStatus(`${this.t('exportedWord')}: ${path}`);
          exported = true;
        } catch (docxErr) {
          console.warn('docx OOXML export failed, falling back to html-docx:', docxErr);
          await this._fallbackWordHtmlExport(clone, path, watchdog, (ok) => { exported = ok; });
        }
      } else {
        // structure 为空（如纯图片文档无文本节点）时也回退，保证有产出
        await this._fallbackWordHtmlExport(clone, path, watchdog, (ok) => { exported = ok; });
      }
```

> 说明：`_runWordExportWorker(payload)` 现接收统一 payload 对象 `{ id, type, ... }`；`exportWord` 传 `{ type:'docx', structure, page }`，`_fallbackWordHtmlExport` 通过 `{ type:'html', html }`。`_runWordExportWorker` 内部为消息补 `id` 并 postMessage，消息体与任务 2 的 worker 协议对齐。

### 步骤 4：抽 `_fallbackWordHtmlExport` 与适配 `_runWordExportWorker`

在 `src/app.js` 添加：

```js
  // 回退路径：用 html-docx 把 HTML altChunk 写入 docx（compat with WPS/GDocs 较差，仅 docx 失败时兜底）。
  async _fallbackWordHtmlExport(clone, path, watchdog, onDone) {
    const escapedTitle = this.activeTab.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let katexCSS = '';
    try { const resp = await fetch('lib/katex/katex.min.css'); if (resp.ok) katexCSS = await resp.text(); } catch (e) {}
    let hljsCSS = '';
    if (!this.isDark) {
      try { const themeLink = document.getElementById('highlight-theme'); if (themeLink) { const resp = await fetch(themeLink.getAttribute('href')); if (resp.ok) hljsCSS = await resp.text(); } } catch (e) {}
    }
    const wordOverride = `
    .alert { background: #f6f5f4; border-left-color: #d4d4d8; }
    .alert-note { background: #eef4ff; border-left-color: #3884ff; }
    .alert-tip { background: #e9f9f1; border-left-color: #10b981; }
    .alert-important { background: #f3edfd; border-left-color: #8b5cf6; }
    .alert-warning { background: #fef6e7; border-left-color: #f59e0b; }
    .alert-caution { background: #fdecec; border-left-color: #ef4444; }
    .mermaid-container { width: 100%; max-width: 100%; box-sizing: border-box; }`;
    const wordStyle = `${this._documentExportCSS()}\n${wordOverride}\n${katexCSS ? katexCSS + '\n' : ''}${hljsCSS ? hljsCSS : ''}`;
    const wordHTML = `<!DOCTYPE html>\n<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">\n<head><meta charset="UTF-8"><title>${escapedTitle}</title>\n<style>\n${wordStyle}\n</style></head>\n<body>\n${clone.innerHTML}\n</body>\n</html>`;
    try {
      const arrayBuffer = await this._convertHtmlToDocxBuffer(wordHTML);
      const buf = new Uint8Array(arrayBuffer);
      await TauriApi.writeBinaryFile({ path, contents: buf });
      this.setStatus(`${this.t('exportedWord')}: ${path}`);
      onDone(true);
    } catch (error) {
      clearTimeout(watchdog);
      console.error('fallback Word export error:', error);
      this.setStatus(`${this.t('exportFailed')}: ${error}`);
      onDone(false);
    }
  }
```

并修改 `_runWordExportWorker(payload)` 为接收统一 payload 对象：`exportWord` 传 `{ type:'docx', structure, page }`，`_fallbackWordHtmlExport` 传 `{ type:'html', html }`。`_runWordExportWorker` 内部为消息补 `id`。

> 说明：`_fallbackWordHtmlExport` 在主线程组好 wordHTML 后调用 `_convertHtmlToDocxBuffer(wordHTML)`（该函数已有 worker/主线程自理逻辑），不需要额外通过 `_runWordExportWorker` 的 html 类型——两种都可以，但为减少改动，让 `_fallbackWordHtmlExport` 复用现有 `_convertHtmlToDocxBuffer`。若 worker 已按任务 2 改成统一 payload 协议，则 `_convertHtmlToDocxBuffer` 内部改用 `{ type:'html', html }` 调 `_runWordExportWorker` 即可，保持单一 worker 通信入口。

### 步骤 5：运行测试验证通过

运行：`node scripts/run-tests.cjs export-docx-flow export-word export-docx-nodes export-docx-page`
预期：全 PASS（并按需修订 export-word.test.cjs 的 `__lastWordHTML` 断言）

### 步骤 6：Commit

```bash
git add src/app.js src/lib/word-export.worker.js test/export-docx-flow.test.cjs test/export-word.test.cjs
git commit -m "feat: exportWord 接入真 OOXML（页面设置→DOM→worker→写盘），失败回退 html-docx"
```

---

## 收尾验证

```bash
npm run check
node scripts/run-tests.cjs
node scripts/ensure-vendor.mjs   # 确认 docx.min.js 再生成无报错
```

预期：全部通过；`docx.min.js` 由 `ensure-vendor` 确定性再生；导出 docx 手动用 Word/WPS 打开验证标题为真 Heading 样式。

> 手动冒烟（非自动化）：打开一个含标题/表格/代码/公式/Mermaid 的 md → 导出 DOCX → 用 Word 与 WPS 各打开一次，确认标题在导航窗格出现（真 Heading）、表格完整、图片清晰、页面 A4 居中。
