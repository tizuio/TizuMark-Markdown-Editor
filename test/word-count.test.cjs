// 字数统计单元测试：锁定 countStats / countPreviewText 的纯计算行为（与 app.js 旧实现一致）。
const test = require('node:test');
const assert = require('node:assert');
const { countStats, countPreviewText } = require('../src/modules/word-count.js');

test('空内容统计为 0', async () => {
  assert.deepStrictEqual(countStats(''), { words: 0, chars: 0, lines: 0 });
  assert.deepStrictEqual(countStats(null), { words: 0, chars: 0, lines: 0 });
  assert.deepStrictEqual(countStats(undefined), { words: 0, chars: 0, lines: 0 });
});

test('纯文本词数按空白分词', async () => {
  const r = countStats('hello world foo');
  assert.strictEqual(r.words, 3);
  assert.strictEqual(r.chars, 15); // 含两个空格
  assert.strictEqual(r.lines, 1);
});

test('多行按 \\n 计行数', async () => {
  const r = countStats('line one\nline two\nline three');
  assert.strictEqual(r.lines, 3);
  assert.strictEqual(r.words, 6);
});

test('markdown 标记符号不计入词数', async () => {
  // # * ` ~ [ ] ( ) > _ | \ - 均被去除后再分词
  const r = countStats('# 标题 **加粗** `代码` [链接](url)');
  // 去除标记后：标题 加粗 代码 链接url（[ ] ( ) 被去，链接url 连成一词）-> 4 词
  assert.strictEqual(r.words, 4);
  // chars 仍是原始字符数
  assert.strictEqual(r.chars, '# 标题 **加粗** `代码` [链接](url)'.length);
});

test('首尾/连续空白被规整', async () => {
  const r = countStats('   word1   word2   ');
  assert.strictEqual(r.words, 2);
});

test('与旧实现逐字符一致（回归）', async () => {
  const samples = [
    '',
    'abc',
    'a b c',
    '# 标题\n\n正文内容在这里。\n\n- 列表项一\n- 列表项二',
    '```js\nconst x = [1,2];\n```',
  ];
  for (const s of samples) {
    const text = s.replace(/[#*`~\[\]()>_|\\-]/g, '').replace(/\s+/g, ' ').trim();
    const words = text ? text.split(/\s+/).length : 0;
    const chars = s.length;
    const lines = s ? s.split('\n').length : 0;
    assert.deepStrictEqual(countStats(s), { words, chars, lines }, 'sample=' + JSON.stringify(s));
  }
});

// ---- 预览可见文本统计（渲染后口径）----
const { JSDOM } = require('jsdom');

function countIn(html) {
  const dom = new JSDOM('<div id="p">' + html + '</div>');
  return countPreviewText(dom.window.document.getElementById('p'));
}

test('countPreviewText: 统计渲染后可见文本字符数', async () => {
  const n = countIn('<p>abc</p><p>你好世界</p>');
  assert.strictEqual(n, 3 + 4, '段落文本全计入');
});

test('countPreviewText: 跳过 mermaid svg / KaTeX MathML / script / style', async () => {
  const n = countIn(
    '<p>正文</p>' +
    '<div class="mermaid-container"><svg><text>图内文字</text></svg></div>' +
    '<p><span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html">渲染公式</span></span></p>' +
    '<script>var x=1;</script><style>p{}</style>'
  );
  assert.strictEqual(n, 2 + 4, 'svg 内文字与 katex-mathml 不计入，正文与 katex-html 计入');
});

test('countPreviewText: 代码块文字计入（读者可见），行号不计', async () => {
  const n = countIn(
    '<pre><code class="hljs"><span class="code-line"><span class="code-line-num">1</span><span class="code-line-text">const a = 1;</span></span></code></pre>'
  );
  assert.strictEqual(n, 'const a = 1;'.length, '代码可见文本计入，行号排除');
});

test('updateWordCount: 状态栏同时更新原始字数与预览字数', async () => {
  const { withEditor } = require('./helpers/app-env.cjs');
  await withEditor({}, async (w, ed) => {
    // 编辑器源码含 markdown 标记；预览为渲染后的可见文本
    ed.cm.setValue('# 标题\n\n正文 hello');
    w.editor.preview.innerHTML = '<h1>标题</h1><p>正文 hello</p>';
    ed.updateWordCount();
    const rawEl = w.document.getElementById('word-count');
    const previewEl = w.document.getElementById('preview-word-count');
    assert.ok(rawEl && previewEl, '两个状态栏元素都应存在');
    assert.ok(rawEl.textContent.includes('原始字数'), '原始字数文案应带「原始」前缀标识');
    assert.ok(previewEl.textContent.includes('预览字数'), '预览字数文案应带「预览」前缀');
    // 原文口径：去标记后「标题 正文 hello」→ 3 词
    assert.ok(rawEl.textContent.endsWith(': 3'), '原始词数应为 3（去 markdown 标记分词）');
    // 预览口径：可见文本 = 标题(2) + 正文(2) + 空格(1) + hello(5) = 10 字符（元素间无额外空白）
    assert.ok(previewEl.textContent.endsWith(': 10'), '预览可见字符数应为 10');
  });
});
