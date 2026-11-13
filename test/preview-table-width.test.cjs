// 阅读模式表格宽度回归（2026-11-13 用户截图：两列表格右侧出现一整片带边框的空白）。
//
// 根因：.preview-content table 是 `display:block; width:100%`。块级 table 的 thead/tbody
// 由浏览器生成「匿名表格盒」，该盒按内容 shrink-to-fit；而 table 元素自身仍是 100% 宽的
// 块级盒并带 1px 外框 → 可见网格只占左侧一小截，右侧留下大片空白（真机 Chrome 实测：
// 外框 1092px / 网格 593px / 空白 498px）。
// 修复：width:max-content 让外层盒贴合网格；max-width:100% + overflow-x:auto 保留宽表滚动。
// 真实像素几何由 test/browser/preview-table-layout.test.cjs 验证（jsdom 无布局引擎）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');

function tableDeclarations() {
  const m = CSS.match(/\.preview-content table \{([\s\S]*?)\n\}/);
  assert.ok(m, 'styles.css 找不到 .preview-content table 规则');
  // 注释里会复述历史值 width:100%，断言前必须剥掉注释，否则误报
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

test('阅读模式表格：外层盒按 max-content 贴合网格，不再留右侧空白', () => {
  const decls = tableDeclarations();
  assert.match(decls, /\bwidth:\s*max-content\s*;/,
    '.preview-content table 必须是 width:max-content（窄表外框贴合可见网格）');
  assert.match(decls, /\bmax-width:\s*100%\s*;/,
    '必须保留 max-width:100%（宽表不能撑破预览区）');
  assert.match(decls, /\bdisplay:\s*block\s*;/,
    '必须保留 display:block（宽表滚动容器的前提）');
  assert.match(decls, /overflow-x:\s*auto\s*;/,
    '必须保留 overflow-x:auto（宽表横向滚动）');
});

test('阅读模式表格：防回退——不得再出现 width:100% 声明', () => {
  const decls = tableDeclarations();
  // 注意不能写 \bwidth —— `\b` 会命中 max-width 里的 width（连字符也是词边界）
  assert.doesNotMatch(decls, /(?:^|[;\n])\s*width:\s*100%\s*;/m,
    'width:100% 会让 display:block 的表格外框比可见网格宽，重新制造右侧大片空白');
  assert.doesNotMatch(decls, /(?:^|[;\n])\s*width:\s*fit-content\s*;/m,
    'fit-content 会按可用宽度收缩列宽，与阅读态实际网格宽度不一致');
});

test('阅读模式表格：WYSIWYG wrap 仍按 fit-content 收口，未放宽改动范围', () => {
  assert.match(CSS, /\.wysiwyg-table-wrap \{[^}]*width: fit-content;[^}]*max-width: 100%;/,
    '.wysiwyg-table-wrap 必须保持 fit-content（所见即所得表格工具依赖表盒=网格宽）');
});
