// exportWord 回归测试：复用 exportHTML 的图片内联/预览克隆逻辑，
// 但将 HTML 经 html-docx-js 转成 .docx 二进制，通过 write_binary_file 落盘。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

// 模拟 htmlDocx.asBlob：返回一个带 arrayBuffer() 的 Blob 替身（PK.. = zip 魔数）。
function installHtmlDocxMock(w) {
  w.htmlDocx = {
    asBlob: (html) => {
      w.__lastWordHTML = html;
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x06, 0x07]);
      return { arrayBuffer: async () => bytes.buffer };
    },
  };
}

// exportWord 现在会先弹确认框，测试中直接确认通过。
function confirmExport(ed, result = true) {
  ed.showConfirmDialog = async () => result;
}

// 强制走回退路径（html-docx）：jsdom 中 docx 主路径的 Worker 不存在 / mock 抛错时，
// exportWord 才落到 _fallbackWordHtmlExport 并记录 __lastWordHTML。
// 同时 mock 页面设置对话框——真实 #docx-page-dialog 在 index.html 里存在，若不 mock 会一直等待点击而挂起。
function fallbackExport(ed) {
  ed._showDocxPageDialog = async () => ({ kind: 'A4', orientation: 'portrait', margin: 'normal' });
  ed._runWordExportWorker = async () => { throw new Error('force fallback to html-docx'); };
}

test('exportWord: 调用 dialogSave(.docx) 并经 write_binary_file 写入二进制', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { captured.path = args.path; captured.contents = args.contents; return undefined; }
    return null;
  } }, async (w, ed) => {
    installHtmlDocxMock(w);
    confirmExport(ed);
    fallbackExport(ed);
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文 <strong>加粗</strong></p>';

    await ed.exportWord();

    assert.strictEqual(captured.path, '/tmp/out.docx', '应写出 .docx 文件');
    // 注意：jsdom 自成一个 realm，其 Uint8Array 与 Node 全局不同，故用 w.Uint8Array 判定。
    assert.ok(captured.contents instanceof w.Uint8Array, 'contents 应为 Uint8Array 二进制');
    assert.strictEqual(captured.contents.length, 6, '应写入 mock 的二进制内容');
    assert.ok(w.__lastWordHTML.includes('标题'), '传给 htmlDocx 的 HTML 应含预览内容');
    assert.ok(w.__lastWordHTML.includes('<title>我的笔记</title>'), '应带文档标题');
    // 关键回归：Word 导出必须带上与预览一致的样式表，否则排版丢失。
    assert.ok(w.__lastWordHTML.includes('<style>'), 'Word HTML 应内联 <style> 样式表');
    assert.ok(w.__lastWordHTML.includes('border-bottom: 2px solid #d4d4d8'), '样式表应含标题分隔线（贴近预览）');
    assert.ok(w.__lastWordHTML.includes('.alert-caution { background: #fdecec;'), '应含 Word 提示框实色覆盖（替代 rgba）');
  });
});

test('exportWord: 用户取消保存对话框时不写文件', async () => {
  let wrote = false;
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return null; // 取消
    if (cmd === 'write_binary_file') { wrote = true; return undefined; }
    return null;
  } }, async (w, ed) => {
    installHtmlDocxMock(w);
    confirmExport(ed);
    fallbackExport(ed);
    w.editor.preview.innerHTML = '<p>hello</p>';
    await ed.exportWord();
    assert.strictEqual(wrote, false, '取消保存时不应调用 write_binary_file');
  });
});

test('exportWord: htmlDocx 未加载时上报错误且不写文件', async () => {
  let wrote = false;
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') { wrote = true; return undefined; }
    return null;
  } }, async (w, ed) => {
    w.htmlDocx = undefined; // 模拟组件缺失
    confirmExport(ed);
    fallbackExport(ed); // 主路径（docx worker）抛错并跳过页面设置对话框，回退到 html-docx 仍失败 → 不写文件
    w.editor.preview.innerHTML = '<p>hello</p>';
    await ed.exportWord();
    assert.strictEqual(wrote, false, 'htmlDocx 缺失时不应写文件');
  });
});

test('exportWord: DOM 预处理适配 Word HTML 导入器', async () => {
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') return undefined;
    return null;
  } }, async (w, ed) => {
    installHtmlDocxMock(w);
    confirmExport(ed);
    fallbackExport(ed);
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = `
      <p><del>删除线</del> 与 <ins>下划线</ins></p>
      <ul class="contains-task-list">
        <li class="task-list-item"><p><input type="checkbox" checked disabled> 已完成</p></li>
        <li class="task-list-item"><p><input type="checkbox" disabled> 未完成</p></li>
      </ul>
      <ul><li><p>普通列表项</p></li></ul>
      <ul><li><p>父项</p><ul><li><p>子项 A</p></li><li><p>子项 B</p></li></ul></li></ul>
      <pre><code class="language-js"><div class="code-scroll">
        <span class="code-line"><span class="code-line-num">1</span><span class="code-line-text">const a = 1;</span></span>
        <span class="code-line"><span class="code-line-num">2</span><span class="code-line-text">const b = 2;</span></span>
      </div></code></pre>
      <blockquote><p>引用第一行
引用第二行</p></blockquote>
      <div class="alert alert-warning">
        <div class="alert-title">警告</div>
        <div class="alert-content"><p>注意内容</p></div>
      </div>
      <p><mark>高亮文本</mark></p>
      <p><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></span><span class="katex-html">x</span></span></p>
      <p><img src="diagram.png" alt="示意图"></p>
    `;

    await ed.exportWord();
    const html = w.__lastWordHTML;

    // del/ins 不应再出现，避免 Word 识别为修订追踪
    assert.ok(!html.includes('<del>'), 'Word HTML 不应包含 <del>');
    assert.ok(!html.includes('<ins>'), 'Word HTML 不应包含 <ins>');
    assert.ok(html.includes('text-decoration: line-through'), '删除线应以内联样式保留');
    assert.ok(html.includes('text-decoration: underline'), '下划线应以内联样式保留');

    // 任务列表 checkbox 应转为 Unicode（注意 <style> 里也有 input[type="checkbox"] 规则，所以只看 <input 标签）
    assert.ok(!html.includes('<input'), 'Word HTML 不应保留 input 标签');
    assert.ok(html.includes('☑ '), '已勾选任务应转为 ☑');
    assert.ok(html.includes('☐ '), '未勾选任务应转为 ☐');

    // 普通列表项应 unwrap <p>，嵌套列表也要正确保留
    assert.ok(html.includes('<ul><li>普通列表项</li></ul>') || html.includes('<ul>\n<li>普通列表项</li>\n</ul>') || html.includes('<ul><li>普通列表项'), '普通列表项应 unwrap 段落');
    assert.ok(
      html.includes('<li>父项<ul><li>子项 A</li><li>子项 B</li></ul></li>') ||
      html.includes('<li>父项\n<ul><li>子项 A</li><li>子项 B</li></ul>\n</li>') ||
      html.includes('<li>父项<ul>') && html.includes('子项 A</li>'),
      '含嵌套列表的父项也应 unwrap 段落且保留子列表'
    );
    // 不应出现空 bullet（空 <li></li>）
    assert.ok(!html.includes('<li></li>'), '不应产生空列表项');

    // 代码块：应转为 <div class="tizu-code-block"> 包 <pre>，内部用 <br> 换行（Word 对 <pre> 预格式化最稳）
    assert.ok(!html.includes('class="code-line"'), 'Word HTML 不应保留 code-line 结构');
    assert.ok(!html.includes('class="code-line-num"'), 'Word HTML 不应保留行号结构');
    assert.ok(!html.includes('hljs-keyword'), 'Word HTML 代码块应去除语法高亮 span');
    assert.ok(html.includes('class="tizu-code-block"'), '代码块应转为 tizu-code-block 容器');
    assert.ok(html.includes('<pre'), '代码块应包含 <pre> 预格式化元素');
    assert.ok(html.includes('const a = 1;'), '代码内容应保留');
    assert.ok(html.includes('const b = 2;'), '代码多行内容应保留');
    assert.ok(html.includes('white-space: pre'), '代码块应禁止自动硬折行');
    assert.ok(html.includes('background: rgb(246, 245, 244)'), '代码块应内联灰底样式');

    // 引用块内联样式 + 换行转 <br>
    assert.ok(html.includes('border-left: 4px solid rgb(37, 99, 235)'), '引用块应内联左边框样式');
    assert.ok(html.includes('引用第一行<br>引用第二行'), '引用块内换行应转为 <br>');

    // 提示框内联样式
    assert.ok(html.includes('background: rgb(254, 246, 231)'), 'warning 提示框应内联浅黄背景');
    assert.ok(html.includes('border-left: 4px solid rgb(245, 158, 11)'), 'warning 提示框应内联橙边框');

    // 高亮内联
    assert.ok(html.includes('background: rgb(251, 191, 36)'), 'mark 应内联高亮背景');

    // KaTeX 应替换为 <math>
    assert.ok(!html.includes('class="katex-html"'), 'katex-html 不应出现在 Word HTML');
    assert.ok(html.includes('<math'), '公式应转为 MathML');

    // 图片应固定宽度 500px 并带 HTML width 属性：Word 对属性支持稳定，避免按原始大像素渲染被裁
    assert.ok(html.includes('width: 500px'), '图片应强制 CSS 宽度 500px');
    assert.ok(html.includes('width="500"'), '图片应设 HTML width 属性 500（Word 按属性渲染）');
  });
});

test('exportWord: 普通图片固定宽度 500px 并设 HTML width/height 属性', async () => {
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') return undefined;
    return null;
  } }, async (w, ed) => {
    installHtmlDocxMock(w);
    confirmExport(ed);
    fallbackExport(ed);
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<p><img src="diagram.png" width="1200" height="800" alt="示意图"></p>';

    await ed.exportWord();
    const html = w.__lastWordHTML;

    // 普通图片应强制宽度 500px、设 HTML width 属性，并移除原始 width="1200"
    assert.ok(html.includes('width: 500px'), '普通图片应设 CSS width:500px');
    assert.ok(html.includes('width="500"'), '普通图片应设 HTML width 属性 500');
    assert.ok(html.includes('display: inline-block'), '普通图片应设为 display:inline-block');
    assert.ok(!html.includes('width="1200"'), '应移除原生 width="1200" 属性');
    assert.ok(!html.includes('height="800"'), '应移除原生 height 属性');
  });
});

test('exportWord: _computeTrimBounds 裁剪透明/背景色边距', async () => {
  await withEditor({}, async (w, ed) => {
    const MarkdownEditor = ed.constructor;
    assert.ok(MarkdownEditor && typeof MarkdownEditor._computeTrimBounds === 'function', 'MarkdownEditor._computeTrimBounds 应存在');

    // 100x100 画布，中间 40x30 黑色实心块（x:20-60, y:30-60），四周透明。
    const width = 100, height = 100;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 30; y < 60; y++) {
      for (let x = 20; x < 60; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255;
      }
    }
    const bounds = MarkdownEditor._computeTrimBounds(data, width, height, { padding: 2 });
    assert.ok(bounds, '应找到非透明内容边界');
    assert.strictEqual(bounds.x, 18, '左边界应包含 2px padding');
    assert.strictEqual(bounds.y, 28, '上边界应包含 2px padding');
    assert.strictEqual(bounds.w, 44, '宽度应为内容宽+2*padding');
    assert.strictEqual(bounds.h, 34, '高度应为内容高+2*padding');

    // 背景色裁剪：画布背景 #f0efee，中间 30x20 红色块（x:35-65, y:40-60）。
    const bgWidth = 100, bgHeight = 100;
    const bgData = new Uint8ClampedArray(bgWidth * bgHeight * 4);
    for (let i = 0; i < bgData.length; i += 4) {
      bgData[i] = 240; bgData[i + 1] = 239; bgData[i + 2] = 238; bgData[i + 3] = 255;
    }
    for (let y = 40; y < 60; y++) {
      for (let x = 35; x < 65; x++) {
        const idx = (y * bgWidth + x) * 4;
        bgData[idx] = 255; bgData[idx + 1] = 0; bgData[idx + 2] = 0; bgData[idx + 3] = 255;
      }
    }
    const bgBounds = MarkdownEditor._computeTrimBounds(bgData, bgWidth, bgHeight, {
      backgroundColor: { r: 240, g: 239, b: 238 }, padding: 3, tolerance: 20
    });
    assert.ok(bgBounds, '应找到与背景色不同的内容边界');
    assert.strictEqual(bgBounds.x, 32, '左边界应包含 padding');
    assert.strictEqual(bgBounds.y, 37, '上边界应包含 padding');
    assert.strictEqual(bgBounds.w, 36, '宽度应为内容宽+2*padding');
    assert.strictEqual(bgBounds.h, 26, '高度应为内容高+2*padding');
  });
});

test('exportWord: 导出成功后弹出成功提示 toast', async () => {
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') return undefined;
    return null;
  } }, async (w, ed) => {
    installHtmlDocxMock(w);
    confirmExport(ed);
    fallbackExport(ed);
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文</p>';

    await ed.exportWord();

    // 写入成功后应弹出绿色成功提示，文案为「导出成功」
    const toast = w.document.querySelector('#toast-container .toast.success');
    assert.ok(toast, '导出成功应弹出 success 类型 toast');
    const toastText = (toast.querySelector('.toast-body') || toast).textContent;
    assert.ok(
      toastText === '导出成功' || toastText === 'Export successful',
      '成功 toast 文案应为「导出成功」'
    );
  });
});

test('exportWord: _applyWordImgSize 尺寸规则（小图原尺寸/大图限宽/超高一页等比缩小）', async () => {
  await withEditor({}, async (w, ed) => {
    assert.ok(typeof ed._applyWordImgSize === 'function', '_applyWordImgSize 应存在');

    // 1) 小图（显示宽 < 500）：保持原显示尺寸，不放大
    const small = w.document.createElement('img');
    ed._applyWordImgSize(small, 300, 200, 500, 300);
    assert.strictEqual(small.getAttribute('width'), '300', '小图应保持原显示宽度 300');
    assert.strictEqual(small.getAttribute('height'), '200', '小图高度应等比例 200');
    assert.strictEqual(small.style.width, '300px');

    // 2) 大图（显示宽 > 500）：宽度限制到 500，高度等比
    const big = w.document.createElement('img');
    ed._applyWordImgSize(big, 1400, 200, 500, 700);
    assert.strictEqual(big.getAttribute('width'), '500', '大图宽度应限制到 500');
    assert.strictEqual(big.getAttribute('height'), '71', '大图高度应等比 71（500*200/1400 四舍五入）');

    // 3) 高度超限（等比后超过一页高度 850）：按高度反推宽度，强制等比缩小
    const tall = w.document.createElement('img');
    ed._applyWordImgSize(tall, 500, 2000, 500, 500);
    assert.strictEqual(tall.getAttribute('height'), '850', '超高图高度应限制到 850');
    assert.strictEqual(tall.getAttribute('width'), '213', '超高图宽度应等比 213（850*500/2000=212.5 四舍五入）');

    // 4) 普通图片路径（不传 cssW）：以 natW(naturalWidth) 为显示宽，小图保持原尺寸
    const plainSmall = w.document.createElement('img');
    ed._applyWordImgSize(plainSmall, 240, 180, 500);
    assert.strictEqual(plainSmall.getAttribute('width'), '240', '普通小图应保持原宽 240');
  });
});

test('exportWord: 普通小图(<500)保持原显示尺寸、不放大到 500', async () => {
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') return undefined;
    return null;
  } }, async (w, ed) => {
    installHtmlDocxMock(w);
    confirmExport(ed);
    fallbackExport(ed);
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<p><img src="small.png" alt="小图"></p>';
    // 模拟该图片在预览中已渲染为 240x180（SVG / 未成功内联等场景 naturalWidth 可能为 0，
    // 但真实预览里 getBoundingClientRect 能拿到可靠显示尺寸，exportWord 会写入 dataset）。
    const im = w.editor.preview.querySelector('img');
    im.dataset.natW = '240'; im.dataset.natH = '180';
    im.dataset.dispW = '240'; im.dataset.dispH = '180';

    await ed.exportWord();
    const html = w.__lastWordHTML;

    assert.ok(html.includes('width="240"'), '小图应保持原显示宽度 240，而非被放大到 500');
    assert.ok(html.includes('width: 240px'), '小图应设 CSS width:240px');
    assert.ok(!html.includes('width="500"'), '不应出现被放大后的 width="500" 属性');
    assert.ok(html.includes('height="180"'), '小图高度应等比例 180');
  });
});

test('exportWord: 超高普通图(显示宽500,高2000)高度限制到850并等比缩窄', async () => {
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.docx';
    if (cmd === 'write_binary_file') return undefined;
    return null;
  } }, async (w, ed) => {
    installHtmlDocxMock(w);
    confirmExport(ed);
    fallbackExport(ed);
    ed.activeTab.filePath = '/docs/note.md';
    ed.activeTab.name = '我的笔记';
    w.editor.preview.innerHTML = '<p><img src="tall.png" alt="长图"></p>';
    const im = w.editor.preview.querySelector('img');
    im.dataset.natW = '500'; im.dataset.natH = '2000';
    im.dataset.dispW = '500'; im.dataset.dispH = '2000';

    await ed.exportWord();
    const html = w.__lastWordHTML;

    assert.ok(html.includes('height="850"'), '超高图高度应限制到 850（不跨页被裁）');
    assert.ok(html.includes('width="213"'), '超高图宽度应等比缩到 213');
  });
});
