// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 AST → HTML。对应 md2 crates/md2-core/src/html.rs。
// 关键行为：
//   - colspan/rowspan 仅在 > 1 时输出
//   - covered cell **完全不产出元素**（该行 td 数少于列数）
//   - headerRowCount > 0 → <thead> 全 th；其余进 <tbody> 用 td
//   - 对齐用 TizuMark 约定的 align 属性（非 md2 的内联 style）
const test = require('node:test');
const assert = require('node:assert');
const { Alignment, cell, coveredCell } = require('../src/md2/ast.js');
const { renderTable } = require('../src/md2/html.js');

// 测试用的最简内容渲染：把原始字符串完整转义后包成 <p>。
// 注意三个字符都要转义：html.js 按设计**原样插入**回调返回值
// （在 html.js 里转义会造成双重转义并破坏注入渲染器的结构），
// 所以转义是回调的职责——helper 少转义 `>` 会让下面的断言在任何实现下恒假。
const renderCell = (s) =>
  s === ''
    ? ''
    : `<p>${String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;

test('普通表：thead/tbody 切分与 align 属性', () => {
  const t = {
    headerRowCount: 1,
    alignments: [Alignment.Left, Alignment.Center, Alignment.Right],
    rows: [
      { cells: [cell('H1'), cell('H2'), cell('H3')] },
      { cells: [cell('a'), cell('b'), cell('c')] },
    ],
  };
  const html = renderTable(t, renderCell);
  assert.match(html, /<thead>/);
  assert.match(html, /<tbody>/);
  assert.match(html, /<th align="left">/);
  assert.match(html, /<th align="center">/);
  assert.match(html, /<th align="right">/);
  assert.match(html, /<td align="left">/);
});

test('默认对齐不输出 align 属性', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default],
    rows: [{ cells: [cell('x')] }],
  };
  const html = renderTable(t, renderCell);
  assert.ok(!/align=/.test(html), '不应出现 align 属性');
});

test('colspan + rowspan：anchor 输出属性，covered 不产出元素', () => {
  // md2 golden 08 号夹具的 2x2 合并表
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default, Alignment.Default],
    rows: [
      { cells: [cell('A 2x2', 2, 2), coveredCell(), cell('B')] },
      { cells: [coveredCell(), coveredCell(), cell('C')] },
    ],
  };
  const html = renderTable(t, renderCell);
  assert.match(html, /<td colspan="2" rowspan="2">/);
  // 第一行 2 个 td（anchor + B），第二行 1 个 td（C）
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual((rows[0].match(/<td/g) || []).length, 2);
  assert.strictEqual((rows[1].match(/<td/g) || []).length, 1);
});

test('rowspan 单独出现时第二行 td 数减少', () => {
  const t = {
    headerRowCount: 1,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [
      { cells: [cell('H1'), cell('H2')] },
      { cells: [cell('R', 1, 2), cell('B')] },
      { cells: [coveredCell(), cell('C')] },
    ],
  };
  const html = renderTable(t, renderCell);
  assert.match(html, /<td rowspan="2">/);
  const body = html.slice(html.indexOf('<tbody>'));
  const rows = body.match(/<tr>[\s\S]*?<\/tr>/g);
  assert.strictEqual((rows[0].match(/<td/g) || []).length, 2);
  assert.strictEqual((rows[1].match(/<td/g) || []).length, 1);
});

test('headerRowCount = 0 时不产出 thead', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default],
    rows: [{ cells: [cell('x')] }],
  };
  const html = renderTable(t, renderCell);
  assert.ok(!/<thead>/.test(html));
  assert.match(html, /<tbody>/);
});

test('多行表头全部进 thead 且为 th', () => {
  const t = {
    headerRowCount: 2,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [
      { cells: [cell('H1'), cell('H2')] },
      { cells: [cell('H3'), cell('H4')] },
      { cells: [cell('a'), cell('b')] },
    ],
  };
  const html = renderTable(t, renderCell);
  const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
  // 必须用 /<th[ >]/ 而非裸 /<th/：切片段以 `<thead>` 开头，
  // 裸 /<th/ 会把容器标签本身也计入（得 5 而非 4）。
  assert.strictEqual((thead.match(/<th[ >]/g) || []).length, 4);
  const tbody = html.slice(html.indexOf('<tbody>'));
  assert.strictEqual((tbody.match(/<th[ >]/g) || []).length, 0);
});

test('单元格内容经注入的渲染回调处理', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default],
    rows: [{ cells: [cell('<script>x</script>')] }],
  };
  const html = renderTable(t, renderCell);
  assert.ok(!/<script>/.test(html), '内容应被转义');
  assert.match(html, /&lt;script&gt;/);
});

test('headerRowCount 超出实际行数时被钳制（不抛异常）', () => {
  // 畸形 AST：只有 1 行却声明 3 行表头。上游 html.rs 用 h.min(rows.len()) 钳制。
  // 不钳制会在 for 循环里读 rows[r].cells 抛 TypeError；任务 8 接入后该异常
  // 不是 Md2ParseError，会被 scan.js 重新抛出 → renderMarkdown 崩溃 → 预览空白。
  const t = {
    headerRowCount: 3,
    alignments: [Alignment.Default],
    rows: [{ cells: [cell('only')] }],
  };
  const html = renderTable(t, renderCell);
  assert.strictEqual((html.match(/<th[ >]/g) || []).length, 1, '只有 1 行，应全部渲染为 th');
  assert.ok(!/<tbody>/.test(html), '被钳制后不应再有 tbody（没有剩余行）');
});

test('对齐按网格列下标取，而非按非 covered 计数（全网格不变量）', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Left, Alignment.Center, Alignment.Right],
    rows: [{ cells: [cell('A', 2, 1), coveredCell(), cell('C')] }],
  };
  const html = renderTable(t, renderCell);
  assert.match(html, /<td colspan="2" align="left">/, 'anchor 取第 0 列的对齐');
  assert.match(html, /<td align="right">/, 'C 在第 2 列，应取 right 而非 center');
});

test('covered 位置不触发单元格渲染回调（回调会重入整条管线）', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default, Alignment.Default],
    rows: [
      { cells: [cell('A', 2, 2), coveredCell(), cell('B')] },
      { cells: [coveredCell(), coveredCell(), cell('C')] },
    ],
  };
  let calls = 0;
  renderTable(t, (s) => {
    calls += 1;
    return renderCell(s);
  });
  assert.strictEqual(calls, 3, '只有 3 个 anchor 应触发回调，covered 不触发');
});

test('未提供渲染回调时立刻抛错（不放行未转义内容）', () => {
  const t = { headerRowCount: 0, alignments: [Alignment.Default], rows: [{ cells: [cell('<b>x</b>')] }] };
  assert.throws(() => renderTable(t), /renderCellContent must be a function/);
  assert.throws(() => renderTable(t, null), /renderCellContent must be a function/);
});

test('headerRowCount 为 NaN / 负数 / 小数时归一化（不抛异常也不静默空表）', () => {
  for (const bad of [NaN, -1, 1.5]) {
    const t = { headerRowCount: bad, alignments: [Alignment.Default], rows: [{ cells: [cell('x')] }] };
    const html = renderTable(t, renderCell);
    assert.strictEqual((html.match(/<td[ >]/g) || []).length, 1, `headerRowCount=${bad} 应产出 1 个 td`);
    assert.ok(!/<th[ >]/.test(html), `headerRowCount=${bad} 不应有表头`);
  }
});

test('非法 align 值不被写入属性（属性侧加固）', () => {
  const t = {
    headerRowCount: 0,
    alignments: ['left" onmouseover="alert(1)'],
    rows: [{ cells: [cell('x')] }],
  };
  const html = renderTable(t, renderCell);
  assert.ok(!/onmouseover/.test(html), '非法对齐值不得注入属性');
  assert.match(html, /<td><p>x<\/p><\/td>/, '应退化为无 align 的裸 td');
});
