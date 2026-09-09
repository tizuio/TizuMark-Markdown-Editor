const { withEditor } = require('./helpers/app-env.cjs');
const test = require('node:test');
const assert = require('node:assert');

test('exportPDF: print body pins TrueType CJK font chain (no Noto/SourceHan/PingFang fallback)', async () => {
  await withEditor({}, async (w, ed) => {
    ed.showConfirmDialog = async () => true;
    // 捕获 exportPDF 创建的 iframe 及其 srcdoc（打印 HTML 含 printCSS）
    const capturedIframes = [];
    const origCreateElement = w.document.createElement.bind(w.document);
    w.document.createElement = function (tag) {
      const el = origCreateElement(tag);
      if (String(tag).toLowerCase() === 'iframe') capturedIframes.push(el);
      return el;
    };
    try {
      ed.activeTab.name = 'NOTE.md';
      await ed.exportPDF().catch(() => {});
      assert.ok(capturedIframes.length >= 1, 'exportPDF 应创建 iframe');
      const iframe = capturedIframes[0];
      assert.ok(iframe.srcdoc, 'iframe 应通过 srcdoc 承载打印 HTML');

      const doc = iframe.srcdoc;
      // 在 ALL .preview-content { ... } 规则体中存在性搜索（不能只取首个：
      // appCSS（styles.css:1769）先嵌入了 `.preview-content { font-family: var(--font-preview) }`，
      // 没有中文字体；printCSS 的同名规则后嵌入才应含有 CJK 字体链）。
      const bodies = [];
      const re = /\.preview-content\s*\{([^}]*)\}/g;
      let m;
      while ((m = re.exec(doc)) !== null) bodies.push(m[1]);
      assert.ok(bodies.length >= 1, '打印 HTML 应含 .preview-content 规则');
      const ok = bodies.some((body) => {
        if (!/font-family/i.test(body)) return false;
        const yaheiIdx = body.indexOf('"Microsoft YaHei"');
        const sansIdx = body.indexOf('sans-serif');
        if (yaheiIdx === -1 || sansIdx === -1) return false;
        if (!(yaheiIdx < sansIdx)) return false;
        if (/Noto|Source Han|PingFang SC/.test(body)) return false;
        return true;
      });
      assert.ok(
        ok,
        '某条 .preview-content 规则的 font-family 应含 "Microsoft YaHei" 且在 sans-serif 之前，且不含 Noto/Source Han/PingFang SC',
      );
      // 代码字体护栏：正文字体不得污染代码。测试环境下 _loadStylesheetText 取不到
      // styles.css（无 fetch 服务端、link.sheet 为空，appCSS 为 ''——见既有 codeblock
      // 测试只断言 printCSS 内联内容），故直接对 styles.css 源文件断言这两条规则未被触碰，
      // 另断言 srcdoc 里没有任何命中 pre/code 选择器的规则带上正文字体。
      const fs = require('fs');
      const path = require('path');
      const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
      assert.ok(
        /\.preview-content code\s*\{[^}]*var\(--font-code-preview\)/.test(css),
        'styles.css 应仍含 .preview-content code { ... var(--font-code-preview) ... }',
      );
      assert.ok(
        /\.preview-content pre code[\s\S]*?var\(--font-code-preview\)[^;]*!important/.test(css),
        'styles.css 应仍含 .preview-content pre code { ... var(--font-code-preview) ... !important ... }',
      );
      const codeFontLeak = [];
      const ruleRe = /([^{}]+)\{([^}]*)\}/g;
      let rm;
      while ((rm = ruleRe.exec(doc)) !== null) {
        const sel = rm[1];
        const body = rm[2];
        if (!/Microsoft YaHei/.test(body)) continue;
        if (/(^|[,\s])(pre|code|\*|code-line-text)/i.test(sel)) codeFontLeak.push(sel.trim());
      }
      assert.deepStrictEqual(codeFontLeak, [], '正文 CJK 字体不得出现在 pre/code/*/code-line-text 选择器上');
    } finally {
      w.document.createElement = origCreateElement;
    }
  });
});

test('exportPDF: mermaid re-render fontFamily appends TrueType CJK tail (no Noto/SourceHan fallback)', async () => {
  await withEditor({}, async (w, ed) => {
    ed.showConfirmDialog = async () => true;
    // jsdom harness 未加载真实 mermaid 库（typeof mermaid 为 undefined），此处桩化。
    let capturedFontFamily = null;
    w.mermaid = {
      initialize: (opts) => { capturedFontFamily = opts.fontFamily; },
      render: async (id, code) => ({ svg: '<svg viewBox="0 0 10 10"></svg>' }),
    };
    try {
      w.editor.preview.innerHTML = '<div class="mermaid-container" data-code="graph TD; A-->B"></div>';
      ed.activeTab.name = 'NOTE.md';
      await ed.exportPDF().catch(() => {});
      assert.ok(capturedFontFamily, 'exportPDF 重渲染 mermaid 时应调用 mermaid.initialize');
      assert.ok(
        capturedFontFamily.includes('"Microsoft YaHei"'),
        'mermaid fontFamily 应含 "Microsoft YaHei"',
      );
      assert.ok(
        !/Noto|Source Han/.test(capturedFontFamily),
        'mermaid fontFamily 不应含 Noto/Source Han',
      );
    } finally {
      delete w.mermaid;
    }
  });
});
