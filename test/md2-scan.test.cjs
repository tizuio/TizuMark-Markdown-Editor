// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// 前置扫描器：认领范围、围栏感知、错误降级、普通表格放行。
const test = require('node:test');
const assert = require('node:assert');
const { convertMd2Tables } = require('../src/md2/scan.js');

// 最简替换渲染器：把 AST 转成可断言的形式，避免本测试依赖 html.js 细节
const fakeRender = (table) => {
  const cells = table.rows
    .map((row) => row.cells.map((c) => (c.covered ? '_' : `${c.content}(${c.colspan}x${c.rowspan})`)).join('|'))
    .join(' / ');
  return `<TABLE>${cells}</TABLE>`;
};

const run = (md, opts) =>
  convertMd2Tables(md, Object.assign({ renderTable: fakeRender }, opts));

test('认领网格表并替换为渲染结果', () => {
  const out = run('+---+---+\n| a | b |\n+---+---+');
  assert.match(out, /^<TABLE>/);
  assert.ok(!/\+---/.test(out), '原始边框行不应残留');
});

test('网格表前后的普通文本保持不变', () => {
  const out = run('before\n\n+---+\n| a |\n+---+\n\nafter');
  assert.match(out, /^before\n\n<TABLE>/);
  assert.match(out, /\n\nafter$/);
});

test('围栏代码块内的网格表不被认领', () => {
  const md = '```\n+---+\n| a |\n+---+\n```';
  const out = run(md);
  assert.strictEqual(out, md);
});

test('波浪号围栏同样受保护', () => {
  const md = '~~~\n+---+\n| a |\n~~~';
  assert.strictEqual(run(md), md);
});

test('围栏内的带 info 的行不构成闭合（CommonMark：闭合围栏不得带 info string）', () => {
  const md = '```\n+---+\n| a |\n```js\n+---+\n| b |\n+---+';
  const out = run(md);
  assert.ok(!/<TABLE>/.test(out), '整段仍在围栏内，不应认领任何表格');
  assert.match(out, /\| b \|/, '围栏内内容原样保留');
});

test('波浪号围栏同样：带 info 的行不闭合', () => {
  const md = '~~~\n+---+\n| a |\n~~~js\n+---+\n| b |\n+---+';
  assert.ok(!/<TABLE>/.test(run(md)));
});

test('CRLF 输入下围栏仍然生效（info 提取不得被 \\r 破坏）', () => {
  // fenceInfo 若用正则 (.*)$ 捕获 info，`. `不匹配 \r，CRLF 的 "```\r" 会整体匹配失败，
  // 围栏态失效 → 围栏内的表格被误认领。
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  const inside = crlf('```\n+---+\n| a |\n+---+\n```');
  assert.ok(!/<TABLE>/.test(run(inside)), 'CRLF 围栏内的表格不应被认领');
  const outside = crlf('```\nx\n```\n\n+---+\n| a |\n+---+');
  assert.match(run(outside), /<TABLE>/, 'CRLF 围栏外的表格仍应被认领');
});

test('无标记的普通 GFM 管道表原样放行（交给 remark-gfm）', () => {
  const md = '| a | b |\n| - | - |\n| 1 | 2 |';
  assert.strictEqual(run(md), md);
});

test('带 >> 标记的管道表被认领', () => {
  const md = '| H | H2 |\n| - | -- |\n| Blend | >> |';
  const out = run(md);
  assert.match(out, /^<TABLE>/);
  assert.match(out, /Blend\(2x1\)/);
});

test('带 ^^ 标记的管道表被认领', () => {
  const md = '| H | B |\n| - | - |\n| R | x |\n| ^^ | y |';
  const out = run(md);
  assert.match(out, /^<TABLE>/);
  assert.match(out, /R\(1x2\)/);
});

test('转义的 >> 不算标记，表格照常放行', () => {
  const md = '| C | D |\n| - | - |\n| \\>> | x |';
  assert.strictEqual(run(md), md);
});

test('分隔行位于连跑首行时不构成表（上游 Some(0) => false）', () => {
  const md = '| - | - |\n| x | >> |';
  const out = run(md);
  assert.ok(!/<TABLE>/.test(out), 'delim === 0 不应认表');
  assert.strictEqual(out, md, '应原样放行');
});

test('解析失败时降级为错误块，且消费整个表格区域', () => {
  const md = '+---+---+\n| a | b | c |\n+---+---+\nafter';
  const out = run(md, { renderError: (e, raw) => `<ERR kind="${e.kind}">${raw.length}</ERR>` });
  assert.match(out, /<ERR kind="[A-Za-z]+">/);
  assert.match(out, /\nafter$/);
  assert.ok(!/\| a \| b \| c \|/.test(out), '出错的表格行不应作为正文残留');
});

test('错误块消费的行数覆盖整个坏表格', () => {
  const md = '+---+---+\n| a | b | c |\n+---+---+\nafter';
  const out = run(md, { renderError: (e, raw) => `<ERR n=${raw.length}>` });
  assert.match(out, /<ERR n=3>/);
});

test('多个表格按顺序各自认领', () => {
  const md = '+---+\n| a |\n+---+\n\nmid\n\n+---+\n| b |\n+---+';
  const out = run(md);
  const n = (out.match(/<TABLE>/g) || []).length;
  assert.strictEqual(n, 2);
  assert.match(out, /mid/);
});

test('围栏内外的表格互不影响', () => {
  // 边框宽度必须容得下内容行：内容行是 7 字符（'| out |'），闭合竖线在第 6 列，
  // 故顶边框也要 7 字符（corner 落在 0 与 6）。
  const md = '```\n+-----+\n| in  |\n+-----+\n```\n\n+-----+\n| out |\n+-----+';
  const out = run(md);
  // 注意：边框的收尾 `+` 必须转义——不转义会被当成「一个或多个前导字符」的量词，
  // 于是模式实际要求「5 个以上的 `-` 后紧跟换行」，永远匹配不到真实的 `+-----+`。
  assert.match(out, /```\n\+-----+\+\n\| in  \|\n\+-----+\+\n```/, '围栏内原样');
  assert.match(out, /<TABLE>\s*out\(1x1\)<\/TABLE>/, '围栏外被认领');
});

test('单元格内容原样传给渲染器（不预解析）', () => {
  const md = '+-----------+\n| **bold**  |\n+-----------+';
  const out = run(md);
  assert.match(out, /\*\*bold\*\*\(1x1\)/);
});

test('无标记大表不触发 O(m²) 重推导（短路回归）', () => {
  // 普通 GFM 表没有标记 ⇒ 必然走「未认领」分支；未加短路时每行都重推导整条
  // 剩余连跑（实测 4000 行 ~1.9s、20000 行 ~40s）。上界取得很宽松（500ms，约为
  // 短路后实测 4ms 的百倍），只为在 CI 上稳定捕获 O(m²) 退化，不追求精确计时。
  const md = Array.from({ length: 4000 }, (_, n) => `| a${n} | b${n} |`).join('\n');
  const t = Date.now();
  const out = run(md);
  const ms = Date.now() - t;
  assert.strictEqual(out, md, '无标记连跑应原样放行');
  assert.ok(ms < 500, `4000 行无标记表耗时 ${ms}ms，疑似退化为 O(m²)`);
});

test('短路不得吞掉连跑中带围栏标记的行（围栏态必须照常切换）', () => {
  // 短路把整条无标记连跑一次推完时，若其中某行既是围栏标记又含未转义 `|`，
  // 该行就再也不会进入围栏分支 → 围栏态错位 → 随后围栏内的表格被误认领。
  // （字面 `i = j` 写法在此输入上会认领 `<TABLE>`，与修复前行为不一致。）
  const md = '| a | b |\n```| x |\n+---+\n| z |\n+---+';
  const out = run(md);
  assert.strictEqual(out, md, '应原样放行（该行须触发开围栏，围栏内的网格表不得被认领）');
});

// ---------------------------------------------------------------------------
// 多行表头管道表（md2 §4.3：分隔行之前的每一行都是表头行）
//
// 这些断言全部来自真实 md2.exe 的对照输出（md2 v0.1，`md2 render`），不是推测。
// 规则：连跑中第一个分隔行**不得是首行**；且它只有在**不中断段落**时才算表格——
// 中断仅允许分隔行位于第 2 行（GFM 行为），两行以上表头必须位于块边界之后。
// ---------------------------------------------------------------------------

/** 带 headerRowCount 的替换渲染器（普通 fakeRender 不暴露表头行数）。 */
const hdrRender = (table) =>
  `<TABLE h=${table.headerRowCount}>` +
  table.rows.map((r) => r.cells.map((c) => (c.covered ? '_' : c.content)).join('|')).join(' / ') +
  '</TABLE>';

test('两行表头的管道表被认领（用户场景，分隔行在第 3 行）', () => {
  const md = [
    '| Region | North | South |',
    '| Metric | Units | Count |',
    '| ------ | ----- | ----- |',
    '| East   | 10    | 20    |',
  ].join('\n');
  const out = run(md, { renderTable: hdrRender });
  assert.match(out, /^<TABLE h=2>/, '应识别为 2 个表头行');
  assert.match(out, /Region\|North\|South \/ Metric\|Units\|Count/, '两行都进表头');
});

test('空行之后的多行表头表同样认领', () => {
  const md = 'para\n\n| a | b |\n| c | d |\n| - | - |\n| x | 1 |';
  assert.match(run(md, { renderTable: hdrRender }), /^para\n\n<TABLE h=2>/);
});

test('分隔行在第 3 行但紧跟段落时不认表，且分隔行被中性化（md2：不能中断段落）', () => {
  // md2 render 对照：整段是一个 <p>，不存在表格。
  // 仅「不认领」不够——remark-gfm 会把段落尾部再拼成一张表，故分隔行须被转义。
  const md = 'Some paragraph.\n| a | b |\n| c | d |\n| - | - |\n| x | 1 |';
  const out = run(md, { renderTable: hdrRender });
  assert.ok(!/<TABLE>/.test(out), '不得认领为表格');
  assert.ok(out.includes('| \\- | - |'), '分隔行须被转义，否则 remark-gfm 会自行建表');
  assert.ok(out.includes('| x | 1 |'), '其余行原样保留');
});

test('多行表头即便带标记，紧跟段落时仍不认表（md2 只看分隔行位置）', () => {
  // 关键对照：md2 对同样输入输出 <p>…| x | &gt;&gt; |</p>——
  // 标记不能把一张「本该是段落」的东西变成表格。
  const md = 'Some paragraph.\n| a | b |\n| c | d |\n| - | - |\n| x | >> |';
  const out = run(md, { renderTable: hdrRender });
  assert.ok(!/<TABLE>/.test(out), '不得认领为表格');
  assert.ok(out.includes('| \\- | - |'), '分隔行须被转义');
});

test('ATX 标题之后的多行表头表被认领（标题是块边界）', () => {
  const md = '# H\n| a | b |\n| c | d |\n| - | - |\n| x | 1 |';
  assert.match(run(md, { renderTable: hdrRender }), /<TABLE h=2>/);
});

test('围栏闭合之后的多行表头表被认领（围栏是块边界）', () => {
  const md = '```\ncode\n```\n| a | b |\n| c | d |\n| - | - |\n| x | 1 |';
  assert.match(run(md, { renderTable: hdrRender }), /<TABLE h=2>/);
});

test('主题分隔线之后的多行表头表被认领（分隔线是块边界）', () => {
  const md = '***\n| a | b |\n| c | d |\n| - | - |\n| x | 1 |';
  assert.match(run(md, { renderTable: hdrRender }), /<TABLE h=2>/);
});

test('列表项内的多行表头表不认领（无空行 ⇒ 段落延续）', () => {
  // md2 把整块当作列表项内的段落；`- item` 不是块边界，故不认领。
  const md = '- item\n| a | b |\n| c | d |\n| - | - |\n| x | 1 |';
  const out = run(md, { renderTable: hdrRender });
  assert.ok(!/<TABLE>/.test(out), '不得认领为表格');
  assert.ok(out.includes('| \\- | - |'), '分隔行须被转义');
});

test('列表项后有空行则认领（空行结束列表块）', () => {
  const md = '- item\n\n| a | b |\n| c | d |\n| - | - |\n| x | 1 |';
  assert.match(run(md, { renderTable: hdrRender }), /<TABLE h=2>/);
});

test('单行表头 + 标记紧跟段落仍认领（分隔行在第 2 行，GFM 允许中断）', () => {
  // 回归护栏：delim === 1 的既有行为不得被本次改动收紧。
  const md = 'Some paragraph.\n| a | b |\n| - | - |\n| x | >> |';
  assert.match(run(md, { renderTable: hdrRender }), /<TABLE h=1>/);
});
