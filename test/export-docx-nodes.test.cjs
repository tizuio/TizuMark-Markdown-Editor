// 纯函数测试：把预览 DOM 的 clone 转成 docx 用的中间结构（可 postMessage 的纯 JSON）。
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

function loadDomModule(w) {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'export-docx.js'), 'utf8');
  w.eval(src);
  return w.domToDocxStructure;
}

test('domToDocxStructure: 标题/段落/加粗映射', () => {
  const dom = new JSDOM('<div id="root"><h1>一级标题</h1><p>正文 <strong>加粗</strong></p></div>', { runScripts: 'dangerously' });
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
  const dom = new JSDOM('<div id="root"><ul><li><input type="checkbox" checked> 已完成</li></ul></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure[0].type, 'bullet');
  assert.ok(structure[0].runs && structure[0].runs.some(r => r.text.includes('☑')), '已勾选应转成 ☑ 文本');
  assert.ok(!JSON.stringify(structure).includes('checkbox'), '不应包含 input 节点');
});

test('domToDocxStructure: 表格映射为 table 节点', () => {
  const dom = new JSDOM('<div id="root"><table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure[0].type, 'table');
  assert.strictEqual(structure[0].rows.length, 2);
  assert.strictEqual(structure[0].rows[0].cells[0].paragraphs[0].text, '列A');
});

test('domToDocxStructure: code 块映射为 code 节点（多行 lines）', () => {
  const dom = new JSDOM('<div id="root"><pre><code>const a = 1;\nconst b = 2;</code></pre></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  assert.strictEqual(structure[0].type, 'code');
  // 中间结构是可 postMessage 的纯 JSON；经 w.eval 产出的数组属于 jsdom realm，
  // 与 node realm 的数组原型不同，deepStrictEqual 会因原型不等而拒绝，故先 JSON 规约再严格比较。
  assert.deepStrictEqual(JSON.parse(JSON.stringify(structure[0].lines)), ['const a = 1;', 'const b = 2;']);
});

test('domToDocxStructure: 图片映射为 image 节点（带 data 与宽高）', () => {
  const dom = new JSDOM('<div id="root"><p><img src="data:image/png;base64,iVBORw0KGgo=" data-natW="100" data-natH="50" data-dispW="100" data-dispH="50"></p></div>', { runScripts: 'dangerously' });
  const w = dom.window;
  const fn = loadDomModule(w);
  const structure = fn(w.document.getElementById('root'));
  const img = structure.find(n => n.type === 'image');
  assert.ok(img, '含 image 节点');
  assert.strictEqual(img.width, 100);
  assert.strictEqual(img.height, 50);
  assert.ok(img.data && img.data.length > 0, 'data 应有字节');
});
