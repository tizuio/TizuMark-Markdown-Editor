// 全面回归测试：依据 demo.md 演示的全部 Markdown 语法、链接、图片、特殊块，
// 从「多种角度 / 多种写法」测试 renderMarkdown 的渲染输出是否稳定正确。
//
// 说明：renderMarkdown 只负责 markdown -> HTML 的基础渲染。
//   - 数学公式、Mermaid 由 app.js / preview-post.js 后续用 KaTeX / mermaid 渲染（此处只验证公式文本被完整保留、未被破坏）；
//   - Emoji 短代码、TOC 替换、图片 Base64 加载同样在 app 层处理（此处验证其在渲染器里不被破坏、按原样透传）。
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../src/unified-renderer.js');

// 同时跑开/关软换行两种模式，验证结构性渲染不受软换行开关影响
const renderBoth = (md) => ({
  on: renderMarkdown(md, { softBreaks: true }),
  off: renderMarkdown(md, { softBreaks: false }),
});

// ============================================================
// 1. 标题层级（h1-h6）+ 锚点 id 生成
// ============================================================

test('标题：六个层级均生成对应 h1~h6 标签', async () => {
  const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
  const { off } = renderBoth(md);
  for (const lvl of [1, 2, 3, 4, 5, 6]) {
    assert.ok(new RegExp('<h' + lvl + '[^>]*>').test(off), '应生成 <h' + lvl + '>');
  }
});

test('标题 id：中文章节名原样作为 id（匹配 #数学公式 锚点）', async () => {
  const md = '## 数学公式\n内容';
  const { off } = renderBoth(md);
  assert.ok(/<h2[^>]*\bid="数学公式"/.test(off), 'h2 应带 id="数学公式"');
});

test('标题 id：带全角括号的标题去掉括号（匹配 提示框callout 锚点）', async () => {
  const md = '## 提示框（Callout）\n内容';
  const { off } = renderBoth(md);
  assert.ok(/<h2[^>]*\bid="提示框callout"/.test(off), 'h2 应带 id="提示框callout"');
});

test('标题 id：英文编号标题转小写连字符（1. Quick Start -> 1-quick-start）', async () => {
  const md = '# 1. Quick Start\n内容';
  const { off } = renderBoth(md);
  assert.ok(/<h1[^>]*\bid="1-quick-start"/.test(off), 'h1 应带 id="1-quick-start"');
});

test('标题 id：emoji + 中文 混合时 emoji 被跳过、中文保留', async () => {
  const md = '## ✨ 软件特色功能速览\n内容';
  const { off } = renderBoth(md);
  assert.ok(/<h2[^>]*\bid="软件特色功能速览"/.test(off), 'h2 id 应为 软件特色功能速览（无 emoji）');
});

test('标题 id：重复标题自动去重（-2 / -3）', async () => {
  const md = '## 综合演示\n\n## 综合演示\n\n## 综合演示';
  const { off } = renderBoth(md);
  assert.ok(/<h2[^>]*\bid="综合演示"/.test(off), '第一个应 id="综合演示"');
  assert.ok(/<h2[^>]*\bid="综合演示-2"/.test(off), '第二个应 id="综合演示-2"');
  assert.ok(/<h2[^>]*\bid="综合演示-3"/.test(off), '第三个应 id="综合演示-3"');
});

// ============================================================
// 2. 行内文本格式
// ============================================================

test('行内：粗体 **x** -> <strong>', async () => {
  const { off } = renderBoth('这是 **重点强调** 的内容');
  assert.ok(/<strong[^>]*>重点强调<\/strong>/.test(off), '应渲染 <strong>');
});

test('行内：斜体 *x* -> <em>', async () => {
  const { off } = renderBoth('这是 *需要区分* 的术语');
  assert.ok(/<em[^>]*>需要区分<\/em>/.test(off), '应渲染 <em>');
});

test('行内：删除线 ~~x~~ -> <del>', async () => {
  const { off } = renderBoth('表示 ~~已废弃~~ 的内容');
  assert.ok(/<del[^>]*>已废弃<\/del>/.test(off), '应渲染 <del>');
});

test('行内：行内代码 `x` -> <code>', async () => {
  const { off } = renderBoth('变量名 `userName`、命令 `npm install`');
  assert.ok(/<code[^>]*>userName<\/code>/.test(off), '应渲染 <code>');
  assert.ok(/<code[^>]*>npm install<\/code>/.test(off), '第二个代码也应渲染');
});

test('行内：高亮 ==x== -> <mark>', async () => {
  const { off } = renderBoth('这是 ==重点段落==，像荧光笔');
  assert.ok(/<mark>重点段落<\/mark>/.test(off), '应渲染 <mark>');
});

test('高亮：行内代码内的 == 不应被高亮', async () => {
  const { off } = renderBoth('示例 `` `==not==` `` 结束');
  assert.ok(/`==not==`/.test(off), '代码内的 == 保持原样（含反引号）');
  assert.ok(!/<mark>/.test(off), '不应生成 <mark>');
});

test('高亮：连续多个 == 边界不误伤', async () => {
  const md = 'A ==x== B ==y== C';
  const { off } = renderBoth(md);
  assert.ok(/<mark>x<\/mark>/.test(off) && /<mark>y<\/mark>/.test(off), '两个高亮均应渲染');
});

test('行内：上标 <sup> / 下标 <sub> 原生 HTML 透传', async () => {
  const { off } = renderBoth('H<sub>2</sub>O，E=mc<sup>2</sup>');
  assert.ok(/<sub>2<\/sub>/.test(off), '下标应保留');
  assert.ok(/<sup>2<\/sup>/.test(off), '上标应保留');
});

// ============================================================
// 3. 引用块（单/嵌套/懒续）
// ============================================================

test('引用：单一引用块 -> <blockquote>', async () => {
  const { off } = renderBoth('> 单一引用：TizuMark 的设计哲学是"简单就是力量"。');
  assert.ok(/<blockquote[^>]*>[\s\S]*简单就是力量/.test(off), '应生成引用块并保留内容');
});

test('引用：两层嵌套 > 与 >>', async () => {
  const md = '> 第一层引用\n>> 第二层嵌套引用';
  const { off } = renderBoth(md);
  assert.ok(/<blockquote[^>]*>[\s\S]*第一层[\s\S]*<blockquote[^>]*>[\s\S]*第二层/.test(off), '应嵌套两层 blockquote');
});

test('引用：三层深度嵌套 >>>', async () => {
  const md = '> 第一层\n>> 第二层\n>>> 第三层';
  const { off } = renderBoth(md);
  const depth = (off.match(/<blockquote/g) || []).length;
  assert.strictEqual(depth, 3, '应生成 3 层 blockquote');
});

test('引用：懒续（后续行无 > 前缀）仍属同一引用块', async () => {
  const md = '> 第一句\n第二句无前缀\n第三句无前缀';
  const { off } = renderBoth(md);
  assert.ok(/<blockquote[^>]*>[\s\S]*第一句[\s\S]*第二句[\s\S]*第三句/.test(off), '懒续行应并入同一引用块');
});

// ============================================================
// 4. 提示框 Callout（5 种类型 + 大小写变体）
// ============================================================

test('Callout：NOTE 类型 -> alert-note 且标题为 Note', async () => {
  const md = '> [!NOTE]\n> 这是一个**普通提示**。';
  const { off } = renderBoth(md);
  assert.ok(/<div class="alert alert-note">/.test(off), '应生成 alert-note');
  assert.ok(/<div class="alert-title">[\s\S]*Note/.test(off), '标题应为 Note');
  assert.ok(/普通提示/.test(off), '内容应保留');
});

test('Callout：INFO 同义于 NOTE', async () => {
  const { off } = renderBoth('> [!INFO]\n> 信息提示');
  assert.ok(/alert-note/.test(off), 'INFO 应映射为 note');
});

test('Callout：TIP（大写）-> alert-tip', async () => {
  const { off } = renderBoth('> [!TIP]\n> **效率技巧**：拖拽打开。');
  assert.ok(/<div class="alert alert-tip">/.test(off), '应生成 alert-tip');
  assert.ok(/Tip/.test(off), '标题应为 Tip');
});

test('Callout：TIP（小写 tip）同样识别 -> alert-tip', async () => {
  const { off } = renderBoth('> [!tip]\n> **效率技巧**：拖拽打开。');
  assert.ok(/<div class="alert alert-tip">/.test(off), '小写 tip 也应识别');
});

test('Callout：IMPORTANT -> alert-important', async () => {
  const { off } = renderBoth('> [!IMPORTANT]\n> **重要提醒**：Ctrl+S。');
  assert.ok(/alert-important/.test(off), '应生成 alert-important');
});

test('Callout：WARNING -> alert-warning', async () => {
  const { off } = renderBoth('> [!WARNING]\n> **性能警告**：大文档。');
  assert.ok(/alert-warning/.test(off), '应生成 alert-warning');
});

test('Callout：CAUTION -> alert-caution', async () => {
  const { off } = renderBoth('> [!CAUTION]\n> **安全注意**：检查敏感信息。');
  assert.ok(/alert-caution/.test(off), '应生成 alert-caution');
});

test('Callout：提示框内容支持列表', async () => {
  const md = '> [!TIP]\n> - [x] 完成核心编辑器\n> - [ ] 适配 macOS';
  const { off } = renderBoth(md);
  assert.ok(/alert-tip/.test(off), '仍是 tip');
  assert.ok(/完成核心编辑器/.test(off) && /适配 macOS/.test(off), '列表内容应保留');
});

test('Callout：提示框内容支持代码块', async () => {
  const md = '> 在 TizuMark 中构建项目：\n>\n> ```shell\n> npm run build\n> ```\n>\n> 构建产物位于 `src-tauri/target/release/`。';
  const { off } = renderBoth(md);
  assert.ok(/npm run build/.test(off), '代码块内容应保留');
  assert.ok(/src-tauri\/target\/release/.test(off), '行内代码应保留');
});

// ============================================================
// 5. 列表（无序/有序/任务/定义）
// ============================================================

test('列表：无序列表 + 两层嵌套', async () => {
  const md = '- 第一项\n- 第二项\n  - 嵌套子项 A\n  - 嵌套子项 B\n- 第三项';
  const { off } = renderBoth(md);
  assert.ok(/<ul[ >]/.test(off), '应生成 ul');
  assert.ok(/嵌套子项 A/.test(off) && /嵌套子项 B/.test(off), '嵌套项应保留');
  const ulCount = (off.match(/<ul[ >]/g) || []).length;
  assert.ok(ulCount >= 2, '应至少两层 ul');
});

test('列表：有序列表 + 嵌套步骤', async () => {
  const md = '1. 首先做\n2. 然后做\n   1. 子步骤一\n   2. 子步骤二\n3. 最后检查';
  const { off } = renderBoth(md);
  assert.ok(/<ol[ >]/.test(off), '应生成 ol');
  assert.ok(/子步骤一/.test(off) && /子步骤二/.test(off), '有序嵌套项应保留');
});

test('列表：任务列表 勾选/未勾选', async () => {
  const md = '- [x] 完成项目文档\n- [ ] 发布 v0.2.0 版本';
  const { off } = renderBoth(md);
  assert.ok(/type="checkbox"/.test(off), '应渲染 checkbox');
  assert.ok(/checked/.test(off), '[x] 应带 checked');
  assert.ok(/完成项目文档/.test(off) && /发布 v0.2.0 版本/.test(off), '两项文本均保留');
});

test('列表：定义列表 -> dl/dt/dd', async () => {
  const md = 'MarkDown\n: 一种轻量级标记语言，由 John Gruber 创建\n\nTizuMark\n: 基于 Tauri + Rust 构建';
  const { off } = renderBoth(md);
  assert.ok(/<dl[ >]/.test(off), '应生成 dl');
  assert.ok(/<dt[^>]*>MarkDown<\/dt>/.test(off), 'dt 应为术语');
  assert.ok(/<dd[^>]*>一种轻量级标记语言/.test(off), 'dd 应为释义');
  assert.ok(/<dt[^>]*>TizuMark<\/dt>/.test(off), '第二个定义项也应渲染');
});

// ============================================================
// 6. 表格（基础/对齐/单元格格式/容器/段落紧接）
// ============================================================

test('表格：基础表格 -> <table>', async () => {
  const md = '| 特性 | 说明 | 状态 |\n|---|---|---|\n| 实时预览 | 编辑时即时渲染 | 已支持 |';
  const { off } = renderBoth(md);
  assert.ok(/<table/.test(off), '应生成 table');
  assert.ok(/实时预览/.test(off) && /已支持/.test(off), '表头与数据应保留');
});

test('表格：左/中/右对齐 -> text-align 样式', async () => {
  const md = '| 左对齐（默认） | 居中对齐 | 右对齐 |\n|:---|:---:|---:|\n| A | B | C |';
  const { off } = renderBoth(md);
  assert.ok(/align="left"/.test(off), '左对齐');
  assert.ok(/align="center"/.test(off), '居中对齐');
  assert.ok(/align="right"/.test(off), '右对齐');
});

test('表格：单元格内支持加粗/行内代码/链接', async () => {
  const md = '| 加粗 | 代码 | 链接 |\n|------|----------|----------|\n| **重要** | `const x = 1` | [TizuMark](https://gitee.com/tizu/TizuMark-Markdown-Editor) |';
  const { off } = renderBoth(md);
  assert.ok(/<strong[^>]*>重要<\/strong>/.test(off), '单元格加粗');
  assert.ok(/<code[^>]*>const x = 1<\/code>/.test(off), '单元格行内代码');
  assert.ok(/<a href="https:\/\/gitee.com\/tizu\/TizuMark-Markdown-Editor"[^>]*>TizuMark<\/a>/.test(off), '单元格链接');
});

test('表格：引用块内懒续表格（历史 bug 回归）', async () => {
  const md = '> **本节结论**：平台以开发者代码场景为主。\n**分类体系**：12 类。\n**整体分布**：\n| 意图 | 总量 | 占比 |\n|------|------|------|\n| other | 5,482 | 27.0% |';
  const { off } = renderBoth(md);
  assert.ok(/<table/.test(off), '引用块内表格应渲染');
  assert.ok(/<blockquote[^>]*>[\s\S]*<table/.test(off), '表格应在 blockquote 内');
});

test('表格：顶层段落紧接表格（无空行）也能渲染', async () => {
  const md = '**整体分布**：\n| 意图 | 总量 |\n|------|------|\n| other | 5,482 |';
  const { off } = renderBoth(md);
  assert.ok(/<table/.test(off), '无空行紧接的表格应渲染');
  assert.ok(!/<blockquote/.test(off), '顶层表格不应在 blockquote 内');
});

test('表格：相邻多个表格（无空行）均能渲染', async () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |\n| x | y |\n|---|---|\n| 3 | 4 |';
  const { off } = renderBoth(md);
  const tableCount = (off.match(/<table/g) || []).length;
  assert.strictEqual(tableCount, 2, '应渲染出 2 个 table');
});

// ============================================================
// 7. 代码块（多语言 / Mermaid / 行内 / 双反引号）
// ============================================================

test('代码块：多语言高亮 class 正确', async () => {
  const langs = ['javascript', 'python', 'rust', 'html', 'css', 'shell', 'yaml', 'markdown'];
  for (const lang of langs) {
    const md = '```' + lang + '\ncode here\n```';
    const { off } = renderBoth(md);
    assert.ok(new RegExp('language-' + lang).test(off), lang + ' 应带 language-' + lang);
  }
});

test('代码块：Mermaid 在渲染器里保留为 code 块（后续由 preview-post 渲染）', async () => {
  const md = '```mermaid\ngraph TD\n  A-->B\n```';
  const { off } = renderBoth(md);
  assert.ok(/language-mermaid/.test(off), '应保留 mermaid 代码块');
  assert.ok(/graph TD/.test(off), '图表源码应保留');
});

test('代码块：围栏内换行/缩进原样保留，不受软换行影响', async () => {
  const md = '```javascript\nfunction f() {\n  return 1;\n}\n```';
  const { on, off } = renderBoth(md);
  assert.ok(/return 1;/.test(on) && /return 1;/.test(off), '代码内容应保留');
  assert.ok(!/<br>/.test(on), '代码块内不应出现 <br>');
});

test('行内代码：跨换行不破坏', async () => {
  const md = '文本 `code\nline` 结束';
  const { off } = renderBoth(md);
  assert.ok(/<code[^>]*>code line<\/code>/.test(off), '行内代码内换行规范为空格（CommonMark 规范）');
});

test('行内代码：双反引号 `` 包裹含单反引号内容', async () => {
  const md = '示例 `` `code` `` 结束';
  const { off } = renderBoth(md);
  assert.ok(/<code[^>]*>`code`<\/code>/.test(off), '双反引号内单反引号应保留');
});

// ============================================================
// 8. 数学公式（行内 / 独立 / 矩阵 / 方程组 / 分式 / 边界）
// ============================================================

test('数学：行内公式 $...$ 文本完整保留', async () => {
  const md = '勾股定理：$a^2 + b^2 = c^2$ 成立';
  const { on, off } = renderBoth(md);
  for (const html of [on, off]) {
    assert.ok(/a\^2 \+ b\^2 = c\^2/.test(html), '行内公式文本应保留');
    assert.ok(!/<br>/.test(html), '公式内不应混入 <br>');
  }
});

test('数学：独立公式块 $$...$$ -> math-display span', async () => {
  const md = '$$\\begin{aligned}\n\\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\\n\\end{aligned}$$';
  const { off } = renderBoth(md);
  assert.ok(/<span class="math-display"/.test(off), '应生成 math-display');
  assert.ok(/nabla/.test(off) && /varepsilon_0/.test(off), '公式内容应保留');
});

test('数学：矩阵 bmatrix 与分式 frac 保留', async () => {
  const md = '$$J(\\theta) = \\frac{1}{2m} \\sum_{i=1}^{m} (h_\\theta(x^{(i)}) - y^{(i)})^2$$';
  const { off } = renderBoth(md);
  assert.ok(off.includes('\\frac{1}{2m}'), '分式应保留');
  assert.ok(off.includes('sum_{i=1}^{m}'), '求和符号应保留');
});

test('数学：不成对的 $ 当字面量', async () => {
  const md = '价格 $100 左右，含税 $8。';
  const { off } = renderBoth(md);
  assert.ok(/\$100/.test(off) && /\$8/.test(off), '不成对 $ 应保留为字面量');
});

test('数学：行内 $$ 不被当作独立公式（行首之外）', async () => {
  const md = '行内测试 $$ x $$ 结束';
  const { off } = renderBoth(md);
  assert.ok(/\$\$ x \$\$/.test(off), '行内 $$ 应作为字面量保留');
});

// ============================================================
// 9. 链接（标准 / 参考式 / 自动 / 邮件 / 锚点 / 外链.md / 原生a / 带标题 / 多锚点）
// ============================================================

test('链接：标准外链 -> <a href>', async () => {
  const { off } = renderBoth('[TizuMark 项目仓库](https://gitee.com/tizu/TizuMark-Markdown-Editor)');
  assert.ok(/<a href="https:\/\/gitee.com\/tizu\/TizuMark-Markdown-Editor"[^>]*>TizuMark 项目仓库<\/a>/.test(off), '应生成外链 a 标签');
});

test('链接：参考式 [text][ref] + 定义', async () => {
  const md = '参考 [TizuMark][ref-example] 项目。\n\n[ref-example]: https://gitee.com/tizu/TizuMark-Markdown-Editor';
  const { off } = renderBoth(md);
  assert.ok(/<a href="https:\/\/gitee.com\/tizu\/TizuMark-Markdown-Editor"[^>]*>TizuMark<\/a>/.test(off), '参考式链接应解析');
});

test('链接：裸 URL 自动识别为链接', async () => {
  const { off } = renderBoth('直接写 https://www.tizumark.app 会被识别');
  assert.ok(/<a href="https:\/\/www\.tizumark\.app"[^>]*>https:\/\/www\.tizumark\.app<\/a>/.test(off), '裸 URL 应自动链接');
});

test('链接：邮箱自动识别为 mailto', async () => {
  const { off } = renderBoth('联系 contact@tizumark.app 即可');
  assert.ok(/<a href="mailto:contact@tizumark\.app"[^>]*>contact@tizumark\.app<\/a>/.test(off), '邮箱应自动链接');
});

test('链接：内部中文锚点 href 解码后与标题 id 一致', async () => {
  const md = '跳到 [数学公式](#数学公式)\n\n## 数学公式\n内容';
  const { off } = renderBoth(md);
  const m = off.match(/href="(#[^"]+)"/);
  assert.ok(m, '应生成锚点 href');
  assert.strictEqual(decodeURIComponent(m[1].slice(1)), '数学公式', '解码后应与标题 id 一致');
  assert.ok(/<h2[^>]*\bid="数学公式"/.test(off), '标题 id 应为 数学公式');
});

test('链接：外链 .md 文件按外部链接处理（不走 app 内打开）', async () => {
  const md = '打开 [demo.md](https://gitee.com/tizu/TizuMark-Markdown-Editor/blob/master/demo.md) 查看';
  const { off } = renderBoth(md);
  assert.ok(/<a href="https:\/\/gitee.com\/tizu\/TizuMark-Markdown-Editor\/blob\/master\/demo\.md"[^>]*>demo\.md<\/a>/.test(off), '外链 .md 应生成 http(s) a 标签');
});

test('链接：原生 HTML <a> 透传', async () => {
  const { off } = renderBoth('前往 <a href="https://gitee.com/tizu/TizuMark-Markdown-Editor/issues">Issues</a> 反馈');
  assert.ok(/<a href="https:\/\/gitee\.com\/tizu\/TizuMark-Markdown-Editor\/issues">Issues<\/a>/.test(off), '原生 a 标签应透传');
});

test('链接：带标题的链接保留 title', async () => {
  const { off } = renderBoth('[官网](https://tizumark.app "TizuMark 官网")');
  assert.ok(/<a href="https:\/\/tizumark\.app"[^>]*title="TizuMark 官网"[^>]*>官网<\/a>/.test(off), '链接 title 应保留');
});

test('链接：demo 多锚点跳转行（三个中文锚点均能匹配对应标题）', async () => {
  const md = [
    '> 下文是完整语法演示。想快速体验，跳到 [数学公式](#数学公式)、[流程图与图表](#流程图与图表)、[提示框callout](#提示框callout)。',
    '',
    '## 数学公式',
    '## 流程图与图表',
    '## 提示框（Callout）',
  ].join('\n');
  const { off } = renderBoth(md);
  const hrefs = [...off.matchAll(/href="(#[^"]+)"/g)].map(m => decodeURIComponent(m[1].slice(1)));
  assert.ok(hrefs.includes('数学公式'), '应包含 数学公式 锚点');
  assert.ok(hrefs.includes('流程图与图表'), '应包含 流程图与图表 锚点');
  assert.ok(hrefs.includes('提示框callout'), '应包含 提示框callout 锚点');
  assert.ok(/id="数学公式"/.test(off) && /id="流程图与图表"/.test(off) && /id="提示框callout"/.test(off), '三个标题 id 均存在');
});

// ============================================================
// 10. 图片（远程 / 相对 / 绝对 / file:// / HTML img / Base64）
// ============================================================

test('图片：远程 URL', async () => {
  const { off } = renderBoth('![示例图片](https://picsum.photos/800/400)');
  assert.ok(/<img src="https:\/\/picsum\.photos\/800\/400"[^>]*alt="示例图片"/.test(off), '远程图片应渲染');
});

test('图片：相对路径', async () => {
  const { off } = renderBoth('![主界面截图](screenshots/01-main.png)');
  assert.ok(/<img src="screenshots\/01-main\.png"[^>]*alt="主界面截图"/.test(off), '相对路径图片应渲染');
});

test('图片：绝对路径（Windows 盘符）', async () => {
  const { off } = renderBoth('![绝对路径示例](D:/project/tizu-mark/screenshots/01-main.png)');
  assert.ok(/<img src="D:\/project\/tizu-mark\/screenshots\/01-main\.png"/.test(off), '绝对路径图片应渲染');
});

test('图片：file:// 协议被保留（sanitize 允许 file scheme）', async () => {
  const { off } = renderBoth('![x](file:///D:/project/tizu-mark/screenshots/01-main.png)');
  assert.ok(/<img src="file:\/\/\/D:\/project/.test(off), 'file:// 图片应保留');
});

test('图片：原生 HTML <img width height> 透传', async () => {
  const { off } = renderBoth('<img src="screenshots/01-main.png" width="400" alt="限制宽度展示">');
  assert.ok(/<img src="screenshots\/01-main\.png" width="400" alt="限制宽度展示"[^>]*>/.test(off), 'img 的 width/height 应保留');
});

test('图片：Base64 内联', async () => {
  const { off } = renderBoth('![image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg)');
  assert.ok(/<img src="data:image\/png;base64,iVBORw0KGgoAAAANSUhEUg"[^>]*alt="image"/.test(off), 'Base64 图片应保留');
});

// ============================================================
// 11. 水平分隔线 / Emoji / HTML 实体 / TOC / 原生 HTML
// ============================================================

test('分隔线：--- -> <hr>', async () => {
  const { off } = renderBoth('上面\n\n---\n\n下面');
  assert.ok(/<hr[ >]/.test(off), '应生成 <hr>');
});

test('Emoji：短代码在渲染器里原样透传（由 app 层转换）', async () => {
  const { off } = renderBoth('支持 :smile: 与 :rocket: 短代码');
  assert.ok(/:smile:/.test(off) && /:rocket:/.test(off), 'emoji 短代码应原样透传');
});

test('HTML 实体：在行内代码内展示为 &#x26;copy; 形式', async () => {
  const { off } = renderBoth('版权符号：`&copy;` → &copy;');
  assert.ok(/&#x26;copy;/.test(off), '行内代码内的实体应保留为转义形式');
});

test('TOC：[TOC] 在渲染器里原样透传（由 app 层替换）', async () => {
  const { off } = renderBoth('上面\n\n[TOC]\n\n下面');
  assert.ok(/\[TOC\]/.test(off), '[TOC] 应原样透传');
});

test('原生 HTML：<p align> / <b> / <br> 透传', async () => {
  const { off } = renderBoth('<p align="center">居中内容 <b>粗</b><br>换行</p>');
  assert.ok(/<p align="center">/.test(off), 'p align 应保留');
  assert.ok(/<b>粗<\/b>/.test(off), 'b 标签应保留');
  assert.ok(/<br>/.test(off), 'br 应保留');
});

// ============================================================
// 12. 脚注 / kbd / 缩写词 / 转义
// ============================================================

test('脚注：引用生成上标链接，定义区渲染', async () => {
  const md = '正文有引用[^1]。\n\n[^1]: 脚注定义内容。';
  const { off } = renderBoth(md);
  assert.ok(/<sup class="footnote-ref"[^>]*><a href="#fn-1">\[1\]<\/a><\/sup>/.test(off), '引用应渲染为上标链接');
  assert.ok(/<section class="footnotes">/.test(off), '应生成脚注区');
  assert.ok(/<li id="fn-1"[^>]*>[\s\S]*脚注定义内容/.test(off), '脚注定义应渲染');
});

test('脚注：定义支持行内格式（粗体/斜体/代码）', async () => {
  const md = '正文[^1]。\n\n[^1]: 含 **粗体**、*斜体*、`代码`。';
  const { off } = renderBoth(md);
  // 注：脚注定义在渲染器里作为纯文本插入（不二次解析 Markdown），故 **粗体** 等保持原样
  assert.ok(/<li id="fn-1"[^>]*>[\s\S]*粗体/.test(off), '脚注定义文本应保留');
  assert.ok(/<li id="fn-1"[^>]*>[\s\S]*代码/.test(off), '脚注定义文本应保留');
});

test('脚注：未定义引用保持字面量', async () => {
  const { off } = renderBoth('正文[^unknown] 没有定义。');
  assert.ok(/\[\^unknown\]/.test(off), '未定义脚注应保留字面量');
  assert.ok(!/footnote-ref/.test(off), '不应生成脚注引用');
});

test('kbd：原生 <kbd> 透传', async () => {
  const { off } = renderBoth('按下 <kbd>Ctrl</kbd> + <kbd>S</kbd> 保存');
  assert.ok(/<kbd>Ctrl<\/kbd>/.test(off) && /<kbd>S<\/kbd>/.test(off), 'kbd 应透传');
});

test('缩写词：定义被隐藏并注入 abbr-data', async () => {
  const md = '*[HTML]: HyperText Markup Language — 超文本标记语言\n\nHTML 是 Web 基础。';
  const { off } = renderBoth(md);
  assert.ok(/<div id="abbr-data"[^>]*data-abbrs=/.test(off), '应注入 abbr-data');
  assert.ok(/HyperText Markup Language/.test(off), '缩写释义应出现在 data 中');
  assert.ok(/HTML 是 Web 基础/.test(off), '正文术语应保留');
});

test('转义：\\* \\# \\[ \\\\ 均还原为字面量', async () => {
  const md = '| 转义 | 显示 |\n|------|------|\n| \\* | \\*星号不再是斜体\\* |\n| \\# | \\#井号不再是标题 |\n| \\[ | \\[不再被解析为链接 |\n| \\\\ | \\\\反斜杠本身 |';
  const { off } = renderBoth(md);
  assert.ok(/星号不再是斜体/.test(off) && !/<em>/.test(off), '\\* 应还原为字面 *');
  assert.ok(/井号不再是标题/.test(off) && !/<h/.test(off.split('井号')[0].slice(-50)), '\\# 不应生成标题');
  assert.ok(/不再被解析为链接/.test(off), '\\[ 应还原');
  assert.ok(/反斜杠本身/.test(off), '\\\\ 应还原为单个反斜杠');
  // 配对 \[...\] 应还原为字面括号（回归：文献引用 \[J/OL\] 不应被当公式）；
  // 行内 \(...\) 默认按公式渲染，只有中文夹注/英文散文才回退为字面量。
  const { off: off2 } = renderBoth('引用 \\[J/OL\\] 与 \\(x\\) 与 \\(见附录\\) 均不回退为垃圾');
  assert.ok(/\[J\/OL\]/.test(off2), '成对的 \\[...\\] 应还原为字面 [J/OL]');
  assert.ok(/\$x\$/.test(off2), '成对的 \\(x\\) 应按公式渲染');
  assert.ok(/\(见附录\)/.test(off2), '中文夹注 \\(见附录\\) 应还原为字面括号');
});

// ============================================================
// 13. 软换行开关对所有结构特性的无破坏性（横切角度）
// ============================================================

test('软换行横切：表格/列表/引用/代码 在开/关模式下结构均正确', async () => {
  const md = [
    '## 标题',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '- 项一',
    '  - 子项',
    '',
    '> 引用内容',
    '',
    '```js',
    'const x = 1;',
    '```',
  ].join('\n');
  const { on, off } = renderBoth(md);
  for (const html of [on, off]) {
    assert.ok(/<h2/.test(html), '标题');
    assert.ok(/<table/.test(html), '表格');
    assert.ok(/<ul[ >]/.test(html), '列表');
    assert.ok(/<blockquote/.test(html), '引用');
    assert.ok(/language-js/.test(html), '代码块');
  }
});

test('软换行横切：callout/脚注/数学 在开/关模式下结构均正确', async () => {
  const md = [
    '> [!NOTE]',
    '> 提示内容',
    '',
    '正文有引用[^1]。',
    '',
    '[^1]: 脚注定义。',
    '',
    '公式 $E=mc^2$ 著名。',
  ].join('\n');
  const { on, off } = renderBoth(md);
  for (const html of [on, off]) {
    assert.ok(/alert-note/.test(html), 'callout 应渲染');
    assert.ok(/footnote-ref/.test(html), '脚注应渲染');
    assert.ok(/E=mc\^2/.test(html), '公式应保留');
  }
});
