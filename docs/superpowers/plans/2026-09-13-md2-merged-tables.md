# md2 合并单元格表格支持 实现计划（子项目 1：解析与渲染内核）

- 作者：Yoong Hor Meng
- 许可：MIT（移植/衍生自 md2，Copyright (c) 2026 The md2 authors；见 `src/md2/LICENSE`）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
>
> **⚠️ 提交红线（本仓库 CLAUDE.md 规则 5）：** 本计划每个任务末尾都有 commit 步骤（TDD 惯例）。但本仓库规定**提交/推送属红线操作，必须用户明确说「提交/commit」后才执行**。执行者应在每个任务结束时**暂停并请求确认**，或按用户指示批量提交。不要擅自 `git commit`。

**目标：** 让 TizuMark 的预览渲染支持 md2 语法的合并单元格表格（网格语法 `+---+` + 管道简写 `>>` / `^^`），产出带 `colspan`/`rowspan` 的 HTML。

**架构：** 把 md2 的表格解析（`grid.rs` / `pipe.rs`）移植为 JS 模块置于 `src/md2/`，由 `src/unified-renderer.js` 在 unified 管线**之前**以逐行扫描的方式调用（与既有 `convertContainerTables` 同形态），产出的 AST 经 `html.js` 渲染为原生 HTML 后拼回行流。AST 保留 md2 的「全网格」表示（anchor + covered），不使用字符串直出，以便子项目 2/4 复用。

**技术栈：** Node.js CommonJS、esbuild 打包、`node:test` + `node:assert` 测试、无新增 npm 依赖。

---

## 文件结构

| 文件 | 职责 | 行数（估） |
|---|---|---|
| `src/md2/errors.js` | 13 种 `ErrorKind` + `Md2ParseError`（含行/列号） | ~55 |
| `src/md2/ast.js` | `Cell` / `Row` / `Table` 构造器 + `validate()` 平铺不变量 + `Alignment` | ~110 |
| `src/md2/html.js` | AST → HTML（`colspan`/`rowspan`/`align`；covered 不产出元素） | ~90 |
| `src/md2/grid.js` | 网格表解析：边框形状、band 扫描、边界活跃度、角规则、点线 rowspan（并查集） | ~430 |
| `src/md2/pipe.js` | 管道表解析：分格、分隔行、对齐、`>>` / `^^` 标记（并查集） | ~260 |
| `src/md2/scan.js` | 前置扫描器：围栏感知、认领 md2 表格、错误降级为可见块 | ~150 |
| `src/unified-renderer.js` | **修改**：接入 `convertMd2Tables`，置于 `convertContainerTables` 之前 | +~20 |

**测试文件：**

| 文件 | 覆盖 |
|---|---|
| `test/md2-errors.test.cjs` | `ErrorKind` 枚举完整性、`Md2ParseError` 字段 |
| `test/md2-ast.test.cjs` | `validate()` 的重叠/空洞/越界 |
| `test/md2-html.test.cjs` | `colspan`/`rowspan` 输出、covered 省略、thead/tbody 切分、对齐 |
| `test/md2-grid-shape.test.cjs` | `looksLikeBorder`、`parseBorderShape`、转义管道 |
| `test/md2-grid-parse.test.cjs` | 端到端网格解析、角规则、点线 rowspan、错误 kind |
| `test/md2-pipe.test.cjs` | 分格、分隔行、对齐、标记、转义、错列宽松 |
| `test/md2-scan.test.cjs` | 围栏感知、认领范围、错误降级、普通表格放行 |
| `test/md2-render.test.cjs` | 端到端 `renderMarkdown()` DOM 断言 |
| `test/md2-conformance.test.cjs` | md2 golden 夹具结构等价（硬门禁） |
| `test/helpers/md2-normalize.cjs` | 一致性归一化器（被上面引用） |
| `test/fixtures/md2-golden/*.md2` `*.html` | 从 md2 复制的夹具副本 |

**关键约定：**

- `src/md2/*.js` 一律 CommonJS（`module.exports` / `require`），**不产生 `window` 全局** → `check-globals` 与 `entry-scripts` 两个守卫看不到它们，无需改动守卫配置
- 每个模块的导出保持最小面；`grid.js` / `pipe.js` 导出解析函数，`scan.js` 导出扫描器
- 单元格内容在 AST 中保留为**原始字符串**（不预解析为块），由 `html.js` 注入的渲染回调处理——这样 TizuMark 可以把内容回灌 unified 管线获得完整 CommonMark

---

## 任务 1：错误类型（`src/md2/errors.js`）

**文件：**
- 创建：`src/md2/errors.js`
- 测试：`test/md2-errors.test.cjs`

- [ ] **步骤 1：编写失败的测试**

创建 `test/md2-errors.test.cjs`：

```js
// md2 错误类型：13 种 ErrorKind 与 Md2ParseError 的字段契约。
// 这 13 种是 md2 规范 §7 的规范错误目录，golden 夹具的 .error.txt 逐一对应。
const test = require('node:test');
const assert = require('node:assert');
const { ErrorKind, Md2ParseError } = require('../src/md2/errors.js');

test('ErrorKind 恰好包含 md2 规范 §7 的 13 种', () => {
  const kinds = Object.keys(ErrorKind).sort();
  assert.strictEqual(kinds.length, 13, '应为 13 种');
  assert.deepStrictEqual(kinds, [
    'AlignmentMarkerMisplaced',
    'BorderCornerMismatch',
    'ColspanOnFirstColumn',
    'ColumnCountMismatch',
    'DuplicateHeaderSeparator',
    'MergeCellHasContent',
    'MergeCrossesHeaderBoundary',
    'MergeShapeMismatch',
    'MixedMergeMarkers',
    'MixedSegmentChars',
    'RowspanOnFirstRow',
    'TableStructure',
    'UnterminatedTable',
  ]);
});

test('ErrorKind 的值与键同名（便于日志与 .error.txt 对照）', () => {
  for (const [k, v] of Object.entries(ErrorKind)) {
    assert.strictEqual(v, k);
  }
});

test('Md2ParseError 携带 kind / line / message，column 可为空', () => {
  const e = new Md2ParseError(ErrorKind.MergeShapeMismatch, 7, 'span is wrong');
  assert.ok(e instanceof Error);
  assert.strictEqual(e.name, 'Md2ParseError');
  assert.strictEqual(e.kind, 'MergeShapeMismatch');
  assert.strictEqual(e.line, 7);
  assert.strictEqual(e.column, null);
  assert.strictEqual(e.message, 'span is wrong');
});

test('Md2ParseError 可选列号', () => {
  const e = new Md2ParseError(ErrorKind.TableStructure, 3, 'bad', 12);
  assert.strictEqual(e.column, 12);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/md2-errors.test.cjs`
预期：FAIL，报错 `Cannot find module '../src/md2/errors.js'`

- [ ] **步骤 3：编写实现**

创建 `src/md2/errors.js`：

```js
// md2 表格类型化解析错误（对应 md2 规范 §7 的规范错误目录）。
// 这 13 种与 md2 仓库 crates/md2-core/src/error.rs 的 ErrorKind 一一对应；
// golden 夹具的 .error.txt 逐条记录了期望的 kind 与行号。
'use strict';

const ErrorKind = Object.freeze({
  /** 通用几何违规：边框形状错误、缺/多边界管道、内容行畸形、闭合管道后有内容、制表符、空 band、全 `=` 顶边框、顶/底边框上的点线段 */
  TableStructure: 'TableStructure',
  /** 单个边框段混用边框字符，或一行混用 `=` 与 `-` */
  MixedSegmentChars: 'MixedSegmentChars',
  /** 角规则（§3.4）中 `+` 的存在/缺失不符 */
  BorderCornerMismatch: 'BorderCornerMismatch',
  /** 点线跨的列范围与实际单元格范围不符（网格）；`^^` 范围与上一行不符（管道） */
  MergeShapeMismatch: 'MergeShapeMismatch',
  /** 合并在表头/表体边界上跨越 */
  MergeCrossesHeaderBoundary: 'MergeCrossesHeaderBoundary',
  /** 多于一条全 `=` 边框行 */
  DuplicateHeaderSeparator: 'DuplicateHeaderSeparator',
  /** 管道表首行出现 `^^` */
  RowspanOnFirstRow: 'RowspanOnFirstRow',
  /** 管道表首列出现 `>>` */
  ColspanOnFirstColumn: 'ColspanOnFirstColumn',
  /** 合并延续格里包含标记以外的内容 */
  MergeCellHasContent: 'MergeCellHasContent',
  /** 管道行的格数与分隔行定义的列数不同 */
  ColumnCountMismatch: 'ColumnCountMismatch',
  /** 对齐标记 `:` 出现在非分隔边框行上 */
  AlignmentMarkerMisplaced: 'AlignmentMarkerMisplaced',
  /** 网格表不完整：输入在 band 内结束，或顶边框后没有 band */
  UnterminatedTable: 'UnterminatedTable',
  /** 单个管道格同时混用 `>>` 与 `^^` */
  MixedMergeMarkers: 'MixedMergeMarkers',
});

/**
 * md2 解析错误。line 为 1-based 绝对行号；column 仅在有意义时给出。
 * 与 md2 的 ParseError 不同，本实现不派生自任何框架错误类型，
 * 便于 scan.js 用 `instanceof` 精确区分「md2 语法错误」与「程序 bug」。
 */
class Md2ParseError extends Error {
  constructor(kind, line, message, column = null) {
    super(message);
    this.name = 'Md2ParseError';
    this.kind = kind;
    this.line = line;
    this.column = column;
  }
}

module.exports = { ErrorKind, Md2ParseError };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/md2-errors.test.cjs`
预期：PASS，4 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/md2/errors.js test/md2-errors.test.cjs
git commit -m "feat(md2): 新增 md2 表格解析错误类型（13 种 ErrorKind）"
```

> ⚠️ 执行前请向用户确认提交（本仓库提交为红线操作）。

---

## 任务 2：AST 与平铺不变量（`src/md2/ast.js`）

**文件：**
- 创建：`src/md2/ast.js`
- 测试：`test/md2-ast.test.cjs`

- [ ] **步骤 1：编写失败的测试**

创建 `test/md2-ast.test.cjs`：

```js
// md2 表格 AST 与平铺不变量。
// 采用 md2 的「全网格」表示：每行恰好 columnCount 个 cell，
// 合并区域 = 左上 anchor（带 colspan/rowspan）+ 其余位置 covered。
const test = require('node:test');
const assert = require('node:assert');
const { Alignment, cell, coveredCell, columnCount, validate } = require('../src/md2/ast.js');

// 构造 md2 golden 08 号夹具里的 2x2 合并表（无表头）：
//   +-------+-------+-------+
//   | A 2x2         | B     |
//   +...............+-------+
//   |               | C     |
//   +---------------+-------+
function merged2x2() {
  return {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default, Alignment.Default],
    rows: [
      { cells: [cell('A 2x2', 2, 2), coveredCell(), cell('B')] },
      { cells: [coveredCell(), coveredCell(), cell('C')] },
    ],
  };
}

test('cell / coveredCell 构造器字段正确', () => {
  assert.deepStrictEqual(cell('x'), { content: 'x', colspan: 1, rowspan: 1, covered: false });
  assert.deepStrictEqual(cell('x', 2, 3), { content: 'x', colspan: 2, rowspan: 3, covered: false });
  assert.deepStrictEqual(coveredCell(), { content: '', colspan: 1, rowspan: 1, covered: true });
});

test('columnCount 取首行格数', () => {
  assert.strictEqual(columnCount(merged2x2()), 3);
});

test('validate 接受合法的 2x2 合并', () => {
  assert.deepStrictEqual(validate(merged2x2()), { ok: true });
});

test('validate 拒绝行格数不一致', () => {
  const t = merged2x2();
  t.rows[1].cells.pop();
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /cells/);
});

test('validate 拒绝 anchor 相互重叠', () => {
  // (0,0) 的 rowspan = 2 已经占住了 (1,0)，而 (1,0) 位置上却还是一个 anchor
  // （不是 covered）→ 两个 anchor 争抢同一格。注意不能用「上下各一个 colspan=2
  // 的 anchor」构造，那种布局其实互不相交、是合法的。
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [
      { cells: [cell('a', 1, 2), cell('x')] },
      { cells: [cell('b'), cell('y')] },
    ],
  };
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /overlap/i);
});

test('validate 拒绝跨出网格的 anchor', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [{ cells: [cell('a', 3, 1), coveredCell()] }],
  };
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /past the grid/i);
});

test('validate 拒绝无主 covered 格', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [{ cells: [cell('a'), coveredCell()] }],
  };
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /belongs to no anchor/i);
});

test('validate 拒绝对齐数与列数不一致', () => {
  const t = merged2x2();
  t.alignments = [Alignment.Default]; // 应为 3 个
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /entries, expected/);
});

test('validate 拒绝非正跨度', () => {
  const zero = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [{ cells: [cell('a', 0, 1), coveredCell()] }],
  };
  const rz = validate(zero);
  assert.strictEqual(rz.ok, false, 'colspan = 0 必须被拒绝');
  assert.match(rz.message, /span/);

  const negative = {
    headerRowCount: 0,
    alignments: [Alignment.Default],
    rows: [{ cells: [cell('a', 1, -1)] }],
  };
  const rn = validate(negative);
  assert.strictEqual(rn.ok, false, '负 rowspan 必须被拒绝');
  assert.match(rn.message, /span/);
});

test('validate 拒绝缺失或非数组的 alignments', () => {
  const missing = {
    headerRowCount: 0,
    rows: [{ cells: [cell('a')] }],
  };
  const r = validate(missing);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /must be an array/);

  // 非数组（字符串 / 数字 / null）与「缺失」走同一守卫——用例名声称覆盖两者，
  // 这里把后半句也真正测掉。
  for (const bad of ['nope', 0, null]) {
    const rb = validate({ headerRowCount: 0, alignments: bad, rows: [{ cells: [cell('a')] }] });
    assert.strictEqual(rb.ok, false, `alignments = ${JSON.stringify(bad)} 应被拒绝`);
    assert.match(rb.message, /must be an array/);
  }
});

test('validate 拒绝携带内容或跨度的 covered 格', () => {
  const t = {
    headerRowCount: 0,
    alignments: [Alignment.Default, Alignment.Default],
    rows: [{ cells: [cell('a'), { content: 'JUNK', colspan: 5, rowspan: 9, covered: true }] }],
  };
  const r = validate(t);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /covered cell .* carries content or span/);
});

test('columnCount 无行时为 0，空表通过、非空 alignments 的空表被拒', () => {
  const empty = { headerRowCount: 0, alignments: [], rows: [] };
  assert.strictEqual(columnCount(empty), 0);
  assert.deepStrictEqual(validate(empty), { ok: true });

  const mismatch = { headerRowCount: 0, alignments: [Alignment.Default, Alignment.Default], rows: [] };
  assert.strictEqual(validate(mismatch).ok, false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/md2-ast.test.cjs`
预期：FAIL，报错 `Cannot find module '../src/md2/ast.js'`

- [ ] **步骤 3：编写实现**

创建 `src/md2/ast.js`：

```js
// md2 表格 AST（对应 md2 仓库 crates/md2-core/src/ast.rs 的表部分）。
//
// 全网格表示（md2 ast.rs:7-20 的设计）：每行恰好 columnCount 个 cell，
// 网格位置 O(1) 可寻址。合并区域由两部分表示：
//   - anchor：矩形左上角的 cell，携带内容与 colspan/rowspan > 1
//   - covered：矩形内其余位置，covered=true、内容为空、colspan=rowspan=1
//
// 与 Rust 版本的差异：content 保存**原始字符串**而非已解析的块。
// md2 用 pulldown-cmark 解析单元格内容；TizuMark 把这一步交给注入的
// 渲染回调（见 html.js），从而让单元格内容回灌 unified 管线获得完整
// CommonMark（含 KaTeX / Mermaid / 脚注等既有后处理）。
'use strict';

const Alignment = Object.freeze({
  Default: 'default',
  Left: 'left',
  Center: 'center',
  Right: 'right',
});

/** 内容单元（合并区域的 anchor）。 */
function cell(content, colspan = 1, rowspan = 1) {
  return { content, colspan, rowspan, covered: false };
}

/** 被合并覆盖的占位单元。 */
function coveredCell() {
  return { content: '', colspan: 1, rowspan: 1, covered: true };
}

/**
 * 列数 = 首行的格数（全网格表示下每行等长）。
 * 无行时为 0 —— 与上游 ast.rs 的 column_count 一致，刻意不回退到 alignments.length。
 */
function columnCount(table) {
  return table.rows.length ? table.rows[0].cells.length : 0;
}

/**
 * 复检平铺不变量（对应 md2 ast.rs:110-178 的 Table::validate）：
 * anchor 恰好铺满网格、不重叠、不留空，每个 covered 落在唯一 anchor 矩形内。
 *
 * 契约边界：本函数只校验**平铺不变量**，不是「全部字段合法性」。
 * 不检查 headerRowCount（与上游一致），也不检查 table.rows 是否为数组
 * ——调用方需保证传入形如 { headerRowCount, alignments, rows } 的良构表。
 * @returns {{ok: true} | {ok: false, message: string}}
 */
function validate(table) {
  // 前置检查对齐上游 ast.rs 的 Table::validate（:112-118 对齐数、:139-141 非正跨度）。
  if (!Array.isArray(table.alignments)) {
    return { ok: false, message: 'table.alignments must be an array' };
  }

  const nCols = columnCount(table);
  const nRows = table.rows.length;

  if (table.alignments.length !== nCols) {
    return { ok: false, message: `alignments has ${table.alignments.length} entries, expected ${nCols}` };
  }

  for (const row of table.rows) {
    if (row.cells.length !== nCols) {
      return { ok: false, message: `row has ${row.cells.length} cells, expected ${nCols}` };
    }
  }

  // owner[r][c] = 该位置是否已被某个 anchor 覆盖
  const owner = Array.from({ length: nRows }, () => new Array(nCols).fill(false));

  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const cl = table.rows[r].cells[c];
      if (cl.covered) {
        // 上游 ast.rs:131-136：covered 格不得携带内容或跨度。
        // 不查的话，html.js 会因跳过 covered 而静默丢弃这些内容。
        if (cl.content !== '' || cl.colspan !== 1 || cl.rowspan !== 1) {
          return { ok: false, message: `covered cell at ${r},${c} carries content or span` };
        }
        continue;
      }
      // 非正跨度必须拒绝：否则内层循环不执行，既不触发重叠也不触发无主 covered，
      // 畸形 anchor 会静默通过校验。
      if (cl.colspan < 1 || cl.rowspan < 1) {
        return { ok: false, message: `anchor at ${r},${c} has a non-positive span` };
      }
      const rEnd = r + cl.rowspan;
      const cEnd = c + cl.colspan;
      if (rEnd > nRows || cEnd > nCols) {
        return { ok: false, message: `cell at ${r},${c} spans past the grid` };
      }
      for (let rr = r; rr < rEnd; rr++) {
        for (let cc = c; cc < cEnd; cc++) {
          if (owner[rr][cc]) {
            return { ok: false, message: `overlap at ${rr},${cc}` };
          }
          owner[rr][cc] = true;
        }
      }
    }
  }

  // 每个 covered 必须落在某个 anchor 矩形内（= 已被 owner 标记）
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      if (table.rows[r].cells[c].covered && !owner[r][c]) {
        return { ok: false, message: `covered cell at ${r},${c} belongs to no anchor` };
      }
    }
  }

  return { ok: true };
}

module.exports = { Alignment, cell, coveredCell, columnCount, validate };
```

> **已知小缺口（记录在案，暂不修）：** `validate()` 只拒 `colspan/rowspan < 1`，**不检查是否整数**。因此 `colspan: 2.5` / `Infinity` 能通过校验，进而在 `html.js` 里产出 `colspan="2.5"` 这类非法属性值。两个解析器都按 `c2 - c1 + 1` 计算，恒为正整数，故不可达；且该属性由数值门控（`> 1`）保护，含引号/换行的载荷会被 NaN 比较挡掉，**不存在注入**。若日后需要，在 `validate()` 的非正跨度检查旁加一条 `!Number.isInteger(cl.colspan) || !Number.isInteger(cl.rowspan)` 即可。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/md2-ast.test.cjs`
预期：PASS，12 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/md2/ast.js test/md2-ast.test.cjs
git commit -m "feat(md2): 新增表格 AST 与平铺不变量校验"
```

> ⚠️ 执行前请向用户确认提交。

---

## 任务 3：HTML 渲染（`src/md2/html.js`）

**文件：**
- 创建：`src/md2/html.js`
- 测试：`test/md2-html.test.cjs`

**设计要点：** 单元格内容渲染**注入**（`renderCellContent` 回调），`html.js` 本身不依赖 unified。这样 `html.js` 保持纯净可单测，TizuMark 则注入基于 unified 管线的渲染器。

- [ ] **步骤 1：编写失败的测试**

创建 `test/md2-html.test.cjs`：

```js
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

test('headerRowCount 为 NaN / 负数 / 小数时归一化（不抛异常也不静默空表）', () => {
  // NaN 尤其危险：不归一化会静默产出 <table></table>（整张表无声消失），
  // 是排障中最糟的失败模式。
  for (const bad of [NaN, -1, 1.5]) {
    const t = { headerRowCount: bad, alignments: [Alignment.Default], rows: [{ cells: [cell('x')] }] };
    const html = renderTable(t, renderCell);
    assert.strictEqual((html.match(/<td[ >]/g) || []).length, 1, `headerRowCount=${bad} 应产出 1 个 td`);
    assert.ok(!/<th[ >]/.test(html), `headerRowCount=${bad} 不应有表头`);
  }
});

test('未提供渲染回调时立刻抛错（不放行未转义内容）', () => {
  const t = { headerRowCount: 0, alignments: [Alignment.Default], rows: [{ cells: [cell('<b>x</b>')] }] };
  assert.throws(() => renderTable(t), /renderCellContent must be a function/);
  assert.throws(() => renderTable(t, null), /renderCellContent must be a function/);
});

test('非法 align 值不被写入属性（属性侧加固）', () => {
  // 属性是本模块亲手拼装的，做白名单收口既安全又不与「内容不转义」契约冲突。
  const t = {
    headerRowCount: 0,
    alignments: ['left" onmouseover="alert(1)'],
    rows: [{ cells: [cell('x')] }],
  };
  const html = renderTable(t, renderCell);
  assert.ok(!/onmouseover/.test(html), '非法对齐值不得注入属性');
  assert.match(html, /<td><p>x<\/p><\/td>/, '应退化为无 align 的裸 td');
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/md2-html.test.cjs`
预期：FAIL，报错 `Cannot find module '../src/md2/html.js'`

- [ ] **步骤 3：编写实现**

创建 `src/md2/html.js`：

```js
// md2 表格 AST → HTML（对应 md2 crates/md2-core/src/html.rs 的表部分）。
//
// 与 md2 的**有意差异共两处**：
//   (1) 对齐用 TizuMark 既有的 align 属性（配合 src/styles.css:2138 的
//       th[align="center"] 选择器），而非 md2 的内联 style="text-align:"。
//       该差异由一致性门禁的归一化吸收。
//   (2) 结尾 `</table>` 不带尾随换行（上游 html.rs:179 带 \n）。这对消费方无害
//       ——scan.js 用 out.join('\n') 拼接，自带换行，不产生多余空行。
//
// 单元格内容渲染通过回调注入，本模块不依赖 unified —— 保持纯净可单测。
//
// **转义契约（重要）：** 本模块把 renderCellContent 的返回值**按原始 HTML 原样插入**
// <th>/<td>，绝不做任何转义——转义/渲染是回调的职责，本模块二次转义会造成双重转义
// 并破坏回调产出的结构（如 <p> 包裹）。
// ⚠️ 注意这与本仓库另一处表格渲染器 src/unified-renderer.js:740 的 renderCellContent
// **约定相反**（那个是内部先 escapeHTML）。两者互不复用，切勿混淆。
'use strict';

const { Alignment } = require('./ast.js');

/** 允许写入 align 属性的取值白名单（属性由本模块亲手拼装，做收口不影响内容侧契约）。 */
const ALIGN_VALUES = new Set([Alignment.Left, Alignment.Center, Alignment.Right]);

/**
 * 渲染一个 cell 的开始标签属性。
 * covered cell 由调用方跳过，不会走到这里。
 */
function cellAttrs(cell, align) {
  let attrs = '';
  if (cell.colspan > 1) attrs += ` colspan="${cell.colspan}"`;
  if (cell.rowspan > 1) attrs += ` rowspan="${cell.rowspan}"`;
  if (ALIGN_VALUES.has(align)) attrs += ` align="${align}"`;
  return attrs;
}

function renderRow(row, tag, alignments, renderCellContent) {
  let out = '<tr>';
  for (let c = 0; c < row.cells.length; c++) {
    const cl = row.cells[c];
    if (cl.covered) continue; // §3.4：covered 位置不产出元素（也不触发回调）
    out += `<${tag}${cellAttrs(cl, alignments[c])}>`;
    out += renderCellContent(cl.content);
    out += `</${tag}>`;
  }
  out += '</tr>\n';
  return out;
}

/**
 * 渲染整张表。
 *
 * 契约边界：假定 `table` 是**已过 `validate()` 的全网格 AST**（每行恰 columnCount 格、
 * `alignments.length === columnCount`）。下面的 `alignments[c]` 按**网格列下标**取值，
 * 依赖该不变量；本函数不自行校验。
 *
 * @param {object} table  md2 表格 AST
 * @param {(content: string) => string} renderCellContent 单元格内容渲染回调。
 *   **必须提供**；其返回值按原始 HTML 原样插入，回调须自行完成转义。
 * @returns {string} HTML
 */
function renderTable(table, renderCellContent) {
  if (typeof renderCellContent !== 'function') {
    throw new TypeError('renderTable: renderCellContent must be a function');
  }
  const { alignments, rows } = table;
  // 上游 html.rs 同款钳制，并归一化非整数：畸形 AST 里 headerRowCount 可能越界，
  // 不处理会读 rows[r].cells 抛 TypeError → 整个预览崩掉；NaN 更糟——会静默产出一张空表。
  const rawHeaderRows = table.headerRowCount;
  const headerRowCount = Math.max(0, Math.min(Number.isInteger(rawHeaderRows) ? rawHeaderRows : 0, rows.length));

  let out = '<table>\n';

  if (headerRowCount > 0) {
    out += '<thead>\n';
    for (let r = 0; r < headerRowCount; r++) {
      out += renderRow(rows[r], 'th', alignments, renderCellContent);
    }
    out += '</thead>\n';
  }

  if (rows.length > headerRowCount) {
    out += '<tbody>\n';
    for (let r = headerRowCount; r < rows.length; r++) {
      out += renderRow(rows[r], 'td', alignments, renderCellContent);
    }
    out += '</tbody>\n';
  }

  out += '</table>';
  return out;
}

module.exports = { renderTable };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/md2-html.test.cjs`
预期：PASS，13 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/md2/html.js test/md2-html.test.cjs
git commit -m "feat(md2): 新增表格 AST → HTML 渲染（colspan/rowspan）"
```

> ⚠️ 执行前请向用户确认提交。

---

## 任务 4：网格表几何层（`src/md2/grid.js` 上半）

**文件：**
- 创建：`src/md2/grid.js`
- 测试：`test/md2-grid-shape.test.cjs`

本任务先落地**不依赖上下文**的几何原语：候选行判定、转义感知、边框形状解析、位置查找。这些都是纯函数，可独立测试。

- [ ] **步骤 1：编写失败的测试**

创建 `test/md2-grid-shape.test.cjs`：

```js
// 网格表几何原语。测试用例逐条对应 md2 crates/md2-core/src/parse/grid.rs
// 的 #[cfg(test)] mod tests（border_shape_recognition 等）。
const test = require('node:test');
const assert = require('node:assert');
const { looksLikeBorder, unescapedPipeAt, parseBorderShape } = require('../src/md2/grid.js');
const { ErrorKind, Md2ParseError } = require('../src/md2/errors.js');

test('looksLikeBorder：识别合法的边框行', () => {
  assert.strictEqual(looksLikeBorder('+---+---+'), true);
  assert.strictEqual(looksLikeBorder('+===+===+'), true);
  assert.strictEqual(looksLikeBorder('+...+---+'), true);
  // 上游 grid.rs:659：「commits; parse_grid rejects it」——形状检查刻意宽松，
  // 真正的拒绝在 parseGrid。这条语义边界若不钉住，日后收紧 looksLikeBorder 不会被发现。
  assert.strictEqual(looksLikeBorder('+:+'), true);
  assert.strictEqual(looksLikeBorder('+: +'), false); // 含空格：字符集不通过
  // 上游 grid.rs:660 的「list marker territory」：末字符非 '+'，与上一条走的是**不同分支**
  assert.strictEqual(looksLikeBorder('+ ---'), false);
  assert.strictEqual(looksLikeBorder('+---+---+ trailing'), false); // 尾部有文字
  assert.strictEqual(looksLikeBorder('\\+---+---+'), false); // 以反斜杠开头
  assert.strictEqual(looksLikeBorder(''), false);
  assert.strictEqual(looksLikeBorder('++'), false); // 长度 < 3
});

test('looksLikeBorder：忽略行尾空白', () => {
  assert.strictEqual(looksLikeBorder('+---+   '), true);
});

test('unescapedPipeAt：偶数个反斜杠才是真管道', () => {
  const c1 = Array.from('a|b');
  assert.strictEqual(unescapedPipeAt(c1, 1), true);

  const c2 = Array.from('a\\|b'); // 转义管道
  assert.strictEqual(unescapedPipeAt(c2, 2), false);

  const c3 = Array.from('a\\\\|b'); // 转义反斜杠 + 真管道
  assert.strictEqual(unescapedPipeAt(c3, 3), true);

  const c4 = Array.from('ab');
  assert.strictEqual(unescapedPipeAt(c4, 0), false); // 非管道
});

test('parseBorderShape：角与段', () => {
  const b = parseBorderShape(1, '+---+---+');
  assert.deepStrictEqual(b.corners, [0, 4, 8]);
  assert.strictEqual(b.segs.length, 2);
  assert.strictEqual(b.segs[0].kind, 'dash');
  assert.strictEqual(b.length, 9);
});

test('parseBorderShape：段类型 dash / eq / dot', () => {
  assert.strictEqual(parseBorderShape(1, '+---+').segs[0].kind, 'dash');
  assert.strictEqual(parseBorderShape(1, '+===+').segs[0].kind, 'eq');
  assert.strictEqual(parseBorderShape(1, '+...+').segs[0].kind, 'dot');
});

test('parseBorderShape：对齐冒号被剥离为 lead/trail', () => {
  const b = parseBorderShape(1, '+:---+---:+');
  assert.strictEqual(b.segs[0].leadColon, true);
  assert.strictEqual(b.segs[0].trailColon, false);
  assert.strictEqual(b.segs[1].leadColon, false);
  assert.strictEqual(b.segs[1].trailColon, true);
});

test('parseBorderShape：段内混用边框字符 → MixedSegmentChars', () => {
  assert.throws(
    () => parseBorderShape(1, '+-=+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedSegmentChars && e.line === 1
  );
});

test('parseBorderShape：冒号不紧邻角 → AlignmentMarkerMisplaced', () => {
  assert.throws(
    () => parseBorderShape(1, '+--:--+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.AlignmentMarkerMisplaced
  );
});

test('parseBorderShape：空段 → TableStructure', () => {
  // 断言 message 是必须的：仅凭 kind + line 无法与下面的 `lo >= hi` 分支区分，
  // 删掉 empty-border-segment 分支后本文件所有用例仍会全绿（变异副本实测）。
  assert.throws(
    () => parseBorderShape(1, '++'),
    (e) =>
      e instanceof Md2ParseError &&
      e.kind === ErrorKind.TableStructure &&
      /empty border segment/.test(e.message)
  );
});

test('parseBorderShape：段内只有冒号 → TableStructure', () => {
  // '+::+' 的段是 '::'：两个冒号都被当作对角冒号剥离后，段内无边框字符
  assert.throws(
    () => parseBorderShape(1, '+::+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('parseBorderShape：非法字符 → TableStructure', () => {
  assert.throws(
    () => parseBorderShape(1, '+--x--+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('parseBorderShape：非 ASCII 在形状校验阶段即报错', () => {
  // 边框行必须是纯 ASCII；校验在分段之前，故走 TableStructure
  assert.throws(
    () => parseBorderShape(1, '+--ä--+'),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('parseBorderShape：行号原样传递给错误对象', () => {
  // 契约级保护：其余用例一律传 lineNo = 1，若实现把行号写成字面量将无人察觉。
  // golden 夹具的 .error.txt 比对 kind + 行号，故这一条必须有。
  assert.throws(
    () => parseBorderShape(7, '+--x--+'),
    (e) => e instanceof Md2ParseError && e.line === 7
  );
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/md2-grid-shape.test.cjs`
预期：FAIL，报错 `Cannot find module '../src/md2/grid.js'`

- [ ] **步骤 3：编写实现**

创建 `src/md2/grid.js`（本任务只写上半部分，下半部分在任务 5 补齐 —— **注意：文件此时无法通过任务 5 的测试，这是预期的**）：

```js
// 网格表解析（对应 md2 规范 §3 与 md2 仓库 crates/md2-core/src/parse/grid.rs）。
//
// 几何用字符偏移（md2 规范 §2）。边框行是纯 ASCII，字节位置与字符位置一致；
// 内容行按「字符」（码点）索引，因为单元格文本可能非 ASCII —— 因此内容行
// 一律先 Array.from() 得到码点数组再按位取字符（对应 Rust 的 Vec<char>）。
'use strict';

const { ErrorKind, Md2ParseError } = require('./errors.js');

/**
 * 提交形状检查（md2 规范 §3.2、§6）：这一行是否开启一个网格表？
 * 行尾空白被忽略（§2）；边框样式行以第 0 列的 `+` 开头、以 `+` 结尾、
 * 且只含边框字符。
 */
function looksLikeBorder(line) {
  const t = line.replace(/\s+$/, '');
  if (t.length < 3) return false;
  if (t[0] !== '+' || t[t.length - 1] !== '+') return false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '+' && c !== '-' && c !== '=' && c !== '.' && c !== ':') return false;
  }
  return true;
}

/**
 * 字符数组 chars 的位置 pos 上是否有**未被转义**的 `|`。
 * 连续反斜杠数为偶数即为真管道（对应 Rust grid.rs:46）。
 */
function unescapedPipeAt(chars, pos) {
  if (chars[pos] !== '|') return false;
  let backslashes = 0;
  let i = pos;
  while (i > 0 && chars[i - 1] === '\\') {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 0;
}

/**
 * 解析一行边框为角位置与段序列（对应 Rust grid.rs:60 parse_border_shape）。
 *
 * 前置条件：`trimmed` 必须**已剥离行尾空白**（§2，调用方负责，通常是 `trimEnd()`），
 * 且已通过本函数自身的字符集校验（或 `looksLikeBorder`）。违反前件会 fail-loud
 * （抛 TableStructure），但 message 会指向「首尾非 +」，掩盖真实原因。
 *
 * 返回对象的不变量（任务 5 依赖，调用方需知）：
 *   - `corners[0] === 0`，且 `corners` 严格升序
 *   - `segs.length === corners.length - 1`
 *   - `segs[i]` 描述 `corners[i]..corners[i + 1]` 之间的段
 *   - `length` 是字符数（非字节数）
 */
function parseBorderShape(lineNo, trimmed) {
  if (trimmed.length === 0 || trimmed[0] !== '+' || trimmed[trimmed.length - 1] !== '+') {
    throw new Md2ParseError(ErrorKind.TableStructure, lineNo, "border line must start and end with '+'");
  }
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c !== '+' && c !== '-' && c !== '=' && c !== '.' && c !== ':') {
      throw new Md2ParseError(
        ErrorKind.TableStructure,
        lineNo,
        "border line contains a character that is not '+', '-', '=', '.' or ':'"
      );
    }
  }

  const corners = [0];
  const segs = [];
  let i = 1;
  while (i < trimmed.length) {
    const start = i;
    while (i < trimmed.length && trimmed[i] !== '+') i++;
    const end = i; // 行尾必为 '+'，故 i 一定落在角上
    if (end === start) {
      throw new Md2ParseError(ErrorKind.TableStructure, lineNo, 'empty border segment');
    }

    // 最多剥离一个紧邻角的对齐冒号
    let lead = false;
    let trail = false;
    let lo = start;
    let hi = end;
    if (trimmed[lo] === ':') {
      lead = true;
      lo += 1;
    }
    if (hi > lo && trimmed[hi - 1] === ':') {
      trail = true;
      hi -= 1;
    }
    if (lo >= hi) {
      throw new Md2ParseError(ErrorKind.TableStructure, lineNo, 'border segment has no border characters');
    }
    if (trimmed.slice(lo, hi).includes(':')) {
      throw new Md2ParseError(
        ErrorKind.AlignmentMarkerMisplaced,
        lineNo,
        "alignment marker ':' is not adjacent to a corner"
      );
    }
    const first = trimmed[lo];
    for (let k = lo; k < hi; k++) {
      if (trimmed[k] !== first) {
        throw new Md2ParseError(ErrorKind.MixedSegmentChars, lineNo, 'border segment mixes border characters');
      }
    }

    const kind = first === '-' ? 'dash' : first === '=' ? 'eq' : 'dot';
    corners.push(end);
    segs.push({ kind, leadColon: lead, trailColon: trail });
    i += 1; // 跳过角上的 '+'
  }

  return { lineNo, corners, segs, length: trimmed.length };
}

/** 角位置在边界数组 P 中的下标（对应 Rust grid.rs:520 p_index_of）。 */
function pIndexOf(p, pos) {
  const i = p.indexOf(pos);
  if (i === -1) throw new Error(`corner position ${pos} is not in P`);
  return i;
}

module.exports = { looksLikeBorder, unescapedPipeAt, parseBorderShape, pIndexOf };
```

> **已知差异（记录在案，暂不修）：** `looksLikeBorder` 用 `line.replace(/\s+$/, '')` 对应上游的 `trim_end()`，两者 Unicode 空白集不同。实测仅在两个码点上分歧：行尾 `U+0085`（NEL）上游为 true、JS 为 false；行尾 `U+FEFF`（BOM）上游为 false、JS 为 true。后果是极边缘的表判定不一致（一个少认领、一个多认领）。两者都无法从正常的 Markdown 创作产生，golden 夹具不含，无注入/安全影响。若要完全对齐需用显式 Unicode 空白类替换 `\s`，成本与风险都不划算。
>
> **⚠️ 本差异是系统性的（任务 6 审查补充，2026-09-13）：** 同一根因出现在**所有**用 `.trim()` / `/\s+$/` 对应 Rust `trim()` / `trim_end()` 的位置——`grid.js` 的 `looksLikeBorder`、`cellText`、`parseGrid` 的 `trimmed`，以及 `pipe.js` 的 `splitCells`、`isDelimiterRow`、`delimiterAlignment`。**在 `pipe.js` 里它有结构性后果**（已用真实 `md2.exe` 实证）：
> - `| A | ﻿>> |` → JS 判为 colspan 合并（`[[A,false,2],["",true,1]]`），md2 判为两个普通格 —— **合并结构分歧**
> - 行首 `﻿| A | B |` → JS 丢弃前导空段得 2 格成表；md2 得 3 格 → `ColumnCountMismatch`
> - `| ﻿---﻿ | --- |` → JS 判 `isDelimiterRow = true`；md2 判非表
> - `U+0085` 方向的差异与上述相反
>
> **实际可达性极低**：TizuMark 的文件读取路径 `decode_bytes`（`src-tauri/src/lib.rs:210`，调用点 `:150/:165/:175/:586`）会剥离行首 UTF-8 BOM，故「BOM 开头的文件」到不了解析层；仅当这两个码点出现在文档**中部**（粘贴/输入）时才会触发。golden 夹具不含，一致性门禁（任务 10）不受影响。
>
> **若日后要完全对齐**：引入一个共享的 `rustTrim(s)` 助手（显式 Unicode White_Space 类，**不含** `U+FEFF`、**含** `U+0085`），替换上述全部站点，并两处同步加测试。属独立的清理任务，不在本计划的完成标准内。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/md2-grid-shape.test.cjs`
预期：PASS，13 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/md2/grid.js test/md2-grid-shape.test.cjs
git commit -m "feat(md2): 新增网格表几何原语（边框形状/转义/角位置）"
```

> ⚠️ 执行前请向用户确认提交。

---

## 任务 5：网格表完整解析（`src/md2/grid.js` 下半）

**文件：**
- 修改：`src/md2/grid.js`（追加 band 扫描、边界活跃度、角规则、点线 rowspan、组装）
- 测试：`test/md2-grid-parse.test.cjs`

**这是子项目 1 最核心的任务。** 逐段对应 `grid.rs:156-517` 的 `parse_grid`。

- [ ] **步骤 1：编写失败的测试**

创建 `test/md2-grid-parse.test.cjs`：

```js
// 网格表端到端解析。核心用例对应 md2 golden 夹具 06/07/08/12/13 与 grid.rs 自带测试。
const test = require('node:test');
const assert = require('node:assert');
const { parseGrid } = require('../src/md2/grid.js');
const { ErrorKind, Md2ParseError } = require('../src/md2/errors.js');
const { validate, columnCount } = require('../src/md2/ast.js');

const L = (s) => s.split('\n');

// 网格单元格文本**保留行首空格**（§3.4：4 空格以上缩进会变成缩进代码块），
// 只剥离行尾 padding。断言时按行折叠便于阅读；该行为本身由
// 「单元格文本保留前导空格」一例单独固定，避免这里的折叠把它掩盖掉。
const flat = (s) => s.split('\n').map((l) => l.trim()).join('\n');

test('最简单列表', () => {
  const { table, consumed } = parseGrid(L('+---+\n| x |\n+---+'), 0);
  assert.strictEqual(consumed, 3);
  assert.strictEqual(columnCount(table), 1);
  assert.strictEqual(table.rows.length, 1);
  assert.strictEqual(table.rows[0].cells[0].content.trim(), 'x');
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('表头分隔（=）产生 headerRowCount', () => {
  const { table } = parseGrid(L('+---+---+\n| H | I |\n+===+===+\n| a | b |\n+---+---+'), 0);
  assert.strictEqual(table.headerRowCount, 1);
  assert.strictEqual(table.rows.length, 2);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('仅表头表：分隔符即底边框', () => {
  const { table, consumed } = parseGrid(L('+---+---+\n| H | I |\n+===+===+'), 0);
  assert.strictEqual(consumed, 3);
  assert.strictEqual(table.headerRowCount, 1);
  assert.strictEqual(table.rows.length, 1);
});

test('colspan：省略内部竖线（golden 06 原文）', () => {
  // 逐字取自 C:\s\md2\test_data\golden\06_grid_colspan.md2。
  // 注意第三行 band（C/D/E）不可省略：正是它让最后一条边框在第 8 列
  // 有角（below 活跃），否则会违反角规则。
  const { table } = parseGrid(
    L(
      '+-------+-------+-------+\n' +
        '| H1    | H2    | H3    |\n' +
        '+=======+=======+=======+\n' +
        '| A spans       | B     |\n' +
        '+-------+-------+-------+\n' +
        '| C     | D     | E     |\n' +
        '+-------+-------+-------+'
    ),
    0
  );
  assert.strictEqual(table.headerRowCount, 1);
  assert.strictEqual(table.rows.length, 3);
  const anchor = table.rows[1].cells[0];
  assert.strictEqual(anchor.colspan, 2);
  assert.strictEqual(anchor.rowspan, 1);
  assert.ok(table.rows[1].cells[1].covered);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('rowspan：点线边框（golden 07）', () => {
  const { table } = parseGrid(
    L('+-------+-------+\n| H1    | H2    |\n+=======+=======+\n| R     | B     |\n+.......+-------+\n|       | C     |\n+-------+-------+'),
    0
  );
  const anchor = table.rows[1].cells[0];
  assert.strictEqual(anchor.colspan, 1);
  assert.strictEqual(anchor.rowspan, 2);
  assert.ok(table.rows[2].cells[0].covered);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('2x2 合并：点线 + 省略竖线（golden 08 第一张表原文）', () => {
  // 逐字取自 C:\s\md2\test_data\golden\08_grid_rowcol_span.md2。
  // 底边框是 +---------------+-------+：第 8 列**没有**角，因为该列边界在
  // 上下两个 band 中都不活跃（合并单元格横跨了它）。写成 +---+---+---+ 会
  // 触发 BorderCornerMismatch——这正是角规则要防的错误。
  const { table } = parseGrid(
    L(
      '+-------+-------+-------+\n' +
        '| A 2x2         | B     |\n' +
        '+...............+-------+\n' +
        '|               | C     |\n' +
        '+---------------+-------+'
    ),
    0
  );
  const anchor = table.rows[0].cells[0];
  assert.strictEqual(anchor.colspan, 2);
  assert.strictEqual(anchor.rowspan, 2);
  assert.strictEqual(anchor.content.trim(), 'A 2x2');
  assert.ok(table.rows[0].cells[1].covered);
  assert.ok(table.rows[1].cells[0].covered);
  assert.ok(table.rows[1].cells[1].covered);
  assert.strictEqual(table.rows[1].cells[2].content.trim(), 'C');
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('多段落单元格内容保留换行', () => {
  const { table } = parseGrid(
    L('+-------+-------+\n| First | Second|\n| para. | para. |\n+-------+-------+'),
    0
  );
  assert.strictEqual(flat(table.rows[0].cells[0].content), 'First\npara.');
  assert.strictEqual(flat(table.rows[0].cells[1].content), 'Second\npara.');
});

test('多行表头 + 表头内列合并（golden 12 原文）', () => {
  // 逐字取自 C:\s\md2\test_data\golden\12_grid_two_headers_colspan.md2。
  // "Sales" 横跨两个子列，且整个合并位于**表头块内部**（合法）；
  // 分隔行在第 3 条边框，故 headerRowCount = 2。
  const { table } = parseGrid(
    L(
      '+--------+-------+-------+\n' +
        '| Region |   Sales       |\n' +
        '+--------+-------+-------+\n' +
        '|        | North | South |\n' +
        '+========+=======+=======+\n' +
        '| East   | 10    | 20    |\n' +
        '+--------+-------+-------+'
    ),
    0
  );
  assert.strictEqual(table.headerRowCount, 2);
  assert.strictEqual(table.rows.length, 3);
  assert.strictEqual(table.rows[0].cells[0].content.trim(), 'Region');
  assert.strictEqual(table.rows[0].cells[1].colspan, 2, '"Sales" 应横跨两列');
  assert.ok(table.rows[0].cells[2].covered);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('对齐标记取自表头分隔行（§3.6）', () => {
  // 冒号必须在**分隔行**（全 = 那行）上，不能放在顶边框
  const { table } = parseGrid(
    L('+---+---+\n| H | I |\n+:==+==:+\n| a | b |\n+---+---+'),
    0
  );
  assert.deepStrictEqual(table.alignments, ['left', 'right']);
});

test('错误：顶边框上的对齐标记 → AlignmentMarkerMisplaced', () => {
  assert.throws(
    () => parseGrid(L('+:---+---:+\n| H | I |\n+===+===+\n| a | b |\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.AlignmentMarkerMisplaced
  );
});

test('非 ASCII 单元格按字符列取值', () => {
  const { table } = parseGrid(L('+----+\n| ä  |\n+----+'), 0);
  assert.strictEqual(table.rows[0].cells[0].content.trim(), 'ä');
});

test('单元格文本保留前导空格、剥离行尾 padding（§3.4）', () => {
  // 前导空格必须保留：4 空格以上会被 CommonMark 读成缩进代码块
  const { table } = parseGrid(L('+-------+\n|   x   |\n+-------+'), 0);
  assert.strictEqual(table.rows[0].cells[0].content, '   x');
});

test('错误：无 band 的顶边框 → UnterminatedTable', () => {
  assert.throws(
    () => parseGrid(L('+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.UnterminatedTable && e.line === 1
  );
});

test('错误：相邻边框形成空 band → TableStructure', () => {
  assert.throws(
    () => parseGrid(L('+---+---+\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 2
  );
});

test('错误：缺少角（违反角规则）→ BorderCornerMismatch', () => {
  // 上下两个 band 在第 2 列边界上都有竖线（即该边界活跃），
  // 但中间那条边框却没有对应的 '+' 角。
  assert.throws(
    () =>
      parseGrid(
        L('+-------+-------+\n| a     | b     |\n+---------------+\n| c     | d     |\n+-------+-------+'),
        0
      ),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.BorderCornerMismatch && e.line === 3
  );
});

test('错误：band 内竖线时有时无 → TableStructure', () => {
  assert.throws(
    () => parseGrid(L('+-------+-------+\n| a     | b     |\n| c             |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 2
  );
});

test('错误：点线跨与上下单元格范围不符 → MergeShapeMismatch', () => {
  // 上方 band 的单元格跨第 1..2 列，点线却只覆盖第 1 列 → 形状不符
  assert.throws(
    () =>
      parseGrid(
        L('+-------+-------+-------+\n| A             | B     |\n+.......+-------+-------+\n| x     | y     | z     |\n+-------+-------+-------+'),
        0
      ),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeShapeMismatch && e.line === 3
  );
});

test('错误：顶边框上的点线 → TableStructure', () => {
  assert.throws(
    () => parseGrid(L('+...+---+\n| a     |\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('错误：多于一个表头分隔符 → DuplicateHeaderSeparator', () => {
  assert.throws(
    () =>
      parseGrid(L('+---+---+\n| a | b |\n+===+===+\n| c | d |\n+===+===+\n| e | f |\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.DuplicateHeaderSeparator && e.line === 5
  );
});

test('错误：制表符 → TableStructure（须断言 message，否则会绿在几何分支上）', () => {
  // 下面的 '|\tx|' 里的 \t 是真实的制表符（JS 字符串转义），不是字面反斜杠+t。
  // 删掉 tab 检查后，该输入会落到「无闭合管道」分支，kind 仍是 TableStructure——
  // 只有 message 能把这条规则钉住。
  const lines = ['+---+', '|\tx|', '+---+'];
  assert.throws(
    () => parseGrid(lines, 0),
    (e) =>
      e instanceof Md2ParseError &&
      e.kind === ErrorKind.TableStructure &&
      /tab character/.test(e.message)
  );
});

test('错误：边框长度与顶边框不符 → TableStructure', () => {
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\n+--+--+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure
  );
});

test('consumed 只覆盖表格自身，不含后续行', () => {
  const lines = L('+---+---+\n| a | b |\n+---+---+');
  lines.push('after');
  const { consumed } = parseGrid(lines, 0);
  assert.strictEqual(consumed, 3);
  assert.strictEqual(lines[consumed], 'after');
});

test('表头块内的 rowspan（golden 13 原文）', () => {
  // 逐字取自 C:\s\md2\test_data\golden\13_grid_two_headers_rowspan.md2。
  // "ID" 跨越两行表头，整个合并位于表头块内部（合法）。
  const { table } = parseGrid(
    L(
      '+--------+-------+-------+\n' +
        '| ID     | North | South |\n' +
        '+........+-------+-------+\n' +
        '|        | Units | Count |\n' +
        '+========+=======+=======+\n' +
        '| 1      | a     | b     |\n' +
        '+--------+-------+-------+'
    ),
    0
  );
  assert.strictEqual(table.headerRowCount, 2);
  assert.strictEqual(table.rows.length, 3);
  const anchor = table.rows[0].cells[0];
  assert.strictEqual(anchor.colspan, 1);
  assert.strictEqual(anchor.rowspan, 2);
  assert.ok(table.rows[1].cells[0].covered);
  assert.deepStrictEqual(validate(table), { ok: true });
});

test('错误：全 = 顶边框 → TableStructure@1（上游 invalid_grid_separator_at_top）', () => {
  assert.throws(
    () => parseGrid(L('+=======+=======+\n| A     | B     |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 1
  );
});

test('错误：点线出现在顶边框 → TableStructure@1（上游 invalid_grid_dots_on_outer_border）', () => {
  assert.throws(
    () => parseGrid(L('+.......+-------+\n| A     | B     |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 1
  );
});

test('错误：段内混用 - 与 = → MixedSegmentChars@3（上游 invalid_grid_mixed_segment）', () => {
  assert.throws(
    () => parseGrid(L('+-------+-------+\n| A     | B     |\n+--=----+-------+\n| C     | D     |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedSegmentChars && e.line === 3
  );
});

test('错误：内容行缺闭合管道 → TableStructure@4（上游 invalid_grid_bad_content_line）', () => {
  assert.throws(
    () => parseGrid(L('+-------+-------+\n| A     | B     |\n+-------+-------+\n| broken'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 4
  );
});

test('错误：点线与 = 分隔段混用 → MergeCrossesHeaderBoundary@3（上游 invalid_grid_rowspan_header_body）', () => {
  // 这是 §3.8「合并不许跨表头/表体边界」在网格路径上的**唯一实现**
  // （checkSegmentMix 的 hasEq && hasDot 半边）。删掉整个 checkSegmentMix 后
  // 原有 22 个用例零反应——本条是该函数的唯一回归网。
  assert.throws(
    () => parseGrid(L('+-------+-------+\n| H1    | H2    |\n+.......+=======+\n| cont  | C     |\n+-------+-------+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeCrossesHeaderBoundary && e.line === 3
  );
});

test('错误：band 未闭合（下一行既非内容行也非边框）→ UnterminatedTable@2', () => {
  // 该分支传的是**裸 idx**（见实现里那条「不要改成 idx + 1」的注释）：
  // idx 已被推进到 band 之后，而 band 最后一条内容行的 1-based 行号恰好等于 idx。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\nafter'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.UnterminatedTable && e.line === 2
  );
});

test('start 非 0：consumed 与行号都以表格起点为基准', () => {
  const lines = ['preamble', '', '+---+---+', '| a | b |', '+---+---+', 'tail'];
  const { table, consumed } = parseGrid(lines, 2);
  assert.strictEqual(consumed, 3, 'consumed 只算表格自身行数');
  assert.strictEqual(columnCount(table), 2);
  // 行号绝对化：顶边框改坏后行号应为 3（= start + 1），而非 1
  assert.throws(
    () => parseGrid(['preamble', '', '+=======+=======+', '| A | B |', '+---+---+'], 2),
    (e) => e instanceof Md2ParseError && e.line === 3
  );
});

test('错误：顶边框混用 = 与 - → MixedSegmentChars@1', () => {
  // 各段独立均匀，故 parseBorderShape 放行；由 B0 规则的 hasEq 拦下。
  assert.throws(
    () => parseGrid(L('+===+---+\n| A | B |\n+---+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedSegmentChars && e.line === 1
  );
});

test('错误：非顶边框混用 = 与 - → MixedSegmentChars@5（checkSegmentMix 的 hasEq && hasDash 半边）', () => {
  // 已覆盖的是 hasEq && hasDot 半边；这条钉住另一半。
  // 去掉它会让 +===+---+ 形态的边框被静默接受。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\n+===+===+\n| c | d |\n+===+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedSegmentChars && e.line === 5
  );
});

test('错误：底边框上的点线 → TableStructure@3', () => {
  // 去掉 k >= m 守卫后此处会抛裸 TypeError（findIndex of undefined），
  // 而非 Md2ParseError——这条是该守卫的唯一回归网。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\n+...+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 3
  );
});

test('错误：闭合管道后有非空白字符 → TableStructure@2', () => {
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b | x\n+---+---+'), 0),
    (e) =>
      e instanceof Md2ParseError &&
      e.kind === ErrorKind.TableStructure &&
      e.line === 2 &&
      /after the closing boundary pipe/.test(e.message)
  );
});

test('错误：输入在 band 内结束 → UnterminatedTable@2', () => {
  // 两个上游夹具 invalid_grid_unterminated*.md2 走的正是这条分支，但本套件从未喂过它。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.UnterminatedTable && e.line === 2
  );
});

test('错误：边框长度与顶边框不符（角仍在 P 内）→ TableStructure@3', () => {
  // 与已有的「边框长度与顶边框不符」用例不同：那条的 '+--+--+' 会先撞上**角位置**
  // 检查，因而掩盖了长度检查。这里 '+---+' 的角 0 与 4 都在顶边框角集内，
  // 只有长度检查能拦下它——去掉长度检查后该输入会被**成功解析**。
  assert.throws(
    () => parseGrid(L('+---+---+\n| a | b |\n+---+'), 0),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.TableStructure && e.line === 3
  );
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/md2-grid-parse.test.cjs`
预期：FAIL，报错 `parseGrid is not a function`

- [ ] **步骤 3：编写实现**

在 `src/md2/grid.js` 中，把 `module.exports` 一行替换为下述全部内容（即追加下半部分）：

```js
/** 校验内容行（对应 Rust grid.rs:578 check_content_line）。 */
function checkContentLine(trimmedLine, chars, lineNo, p) {
  if (trimmedLine.includes('\t')) {
    throw new Md2ParseError(ErrorKind.TableStructure, lineNo, 'tab character in grid table line');
  }
  const pn = p[p.length - 1];
  if (chars.length < pn + 1 || chars[pn] !== '|') {
    throw new Md2ParseError(
      ErrorKind.TableStructure,
      lineNo,
      'content line has no closing boundary pipe at the last column boundary'
    );
  }
  if (chars.length > pn + 1) {
    throw new Md2ParseError(ErrorKind.TableStructure, lineNo, 'non-space characters after the closing boundary pipe');
  }
}

/** 校验边框与顶边框一致（对应 Rust grid.rs:609 check_border_against_top）。 */
function checkBorderAgainstTop(border, top) {
  if (border.length !== top.length) {
    throw new Md2ParseError(ErrorKind.TableStructure, border.lineNo, 'border line length differs from the top border');
  }
  for (const c of border.corners) {
    if (!top.corners.includes(c)) {
      throw new Md2ParseError(ErrorKind.TableStructure, border.lineNo, `corner at column ${c} is not a top-border position`);
    }
  }
}

/** 校验一行内的段类型组合（对应 Rust grid.rs:629 check_segment_mix）。 */
function checkSegmentMix(border) {
  const hasEq = border.segs.some((s) => s.kind === 'eq');
  const hasDash = border.segs.some((s) => s.kind === 'dash');
  const hasDot = border.segs.some((s) => s.kind === 'dot');
  if (hasEq && hasDot) {
    throw new Md2ParseError(
      ErrorKind.MergeCrossesHeaderBoundary,
      border.lineNo,
      "border line mixes '=' separator segments with dotted rowspan segments"
    );
  }
  if (hasEq && hasDash) {
    throw new Md2ParseError(ErrorKind.MixedSegmentChars, border.lineNo, "border line mixes '=' with '-' segments");
  }
}

// ---- 并查集：键为 "row,col" 字符串（对应 Rust 的 HashMap<(usize,usize),(usize,usize)>） ----

function ufKey(a, b) {
  return `${a},${b}`;
}

function ufFind(parent, x) {
  let root = x;
  for (;;) {
    const px = parent.get(root);
    if (px === undefined || px === root) break;
    root = px;
  }
  let cur = x;
  while (cur !== root) {
    const next = parent.get(cur) === undefined ? cur : parent.get(cur);
    parent.set(cur, root);
    cur = next;
  }
  return root;
}

function ufUnion(parent, a, b) {
  const ra = ufFind(parent, a);
  const rb = ufFind(parent, b);
  if (ra !== rb) parent.set(ra, rb);
}

/**
 * 提取 band 内某单元格的文本（对应 Rust grid.rs:533 cell_text）。
 * 取该单元格边界列之间、band 各行的字符，按行拼接。
 * 行尾 padding 被剥离（装饰性，不可变成 CommonMark 的两空格硬换行）；
 * 行首空格保留（4 空格以上缩进 → 缩进代码块）。
 */
function cellText(trimmed, band, p, c1, c2) {
  const lo = p[c1 - 1] + 1;
  const hi = p[c2];
  const parts = [];
  for (const lineIdx of band) {
    const chars = Array.from(trimmed[lineIdx]);
    parts.push(chars.slice(lo, hi).join('').replace(/\s+$/, ''));
  }
  return parts.join('\n');
}

/**
 * 网格表入口（对应 Rust grid.rs:156 parse_grid）。
 * lines[start] 是顶边框（调用方已用 looksLikeBorder 确认）。
 * @returns {{table: object, consumed: number}} consumed 为消费的行数（B0 到 Bm 含）
 */
function parseGrid(lines, start) {
  const nTotal = lines.length;
  const trimmed = lines.map((l) => l.replace(/\s+$/, ''));

  // ---- B0（顶边框） ----
  const topLine = trimmed[start];
  if (topLine.includes('\t')) {
    throw new Md2ParseError(ErrorKind.TableStructure, start + 1, 'tab character in grid table line');
  }
  const top = parseBorderShape(start + 1, topLine);
  const p = top.corners.slice();
  const nCols = p.length - 1;
  for (let w = 0; w < nCols; w++) {
    if (p[w + 1] - p[w] < 2) {
      throw new Md2ParseError(ErrorKind.TableStructure, start + 1, 'column width must be at least 1');
    }
  }
  const hasEq = top.segs.some((s) => s.kind === 'eq');
  const hasDot = top.segs.some((s) => s.kind === 'dot');
  const allEq = top.segs.every((s) => s.kind === 'eq');
  if (hasDot) {
    throw new Md2ParseError(ErrorKind.TableStructure, start + 1, 'dotted segment on the top border has no band above to join');
  }
  if (allEq) {
    throw new Md2ParseError(ErrorKind.TableStructure, start + 1, 'the header separator cannot be the top border');
  }
  if (hasEq) {
    throw new Md2ParseError(ErrorKind.MixedSegmentChars, start + 1, "top border mixes '=' with '-' segments");
  }
  if (top.segs.some((s) => s.leadColon || s.trailColon)) {
    throw new Md2ParseError(ErrorKind.AlignmentMarkerMisplaced, start + 1, 'alignment markers are allowed only on the header separator');
  }

  // ---- 扫描 band 与边框 ----
  const borders = [top];
  const bands = [];
  let separator = null; // 边框下标（0 = B0）
  let idx = start + 1;
  for (;;) {
    const bandStart = idx;
    while (idx < nTotal) {
      const chars = Array.from(trimmed[idx]);
      if (!unescapedPipeAt(chars, 0)) break;
      checkContentLine(trimmed[idx], chars, idx + 1, p);
      idx += 1;
    }

    if (idx === bandStart) {
      if (borders.length === 1) {
        // B0 之后完全没有 band（§3.11）——紧邻的边框是空 band（§3.3）
        if (idx < nTotal && looksLikeBorder(trimmed[idx])) {
          throw new Md2ParseError(ErrorKind.TableStructure, idx + 1, 'empty band between adjacent border lines');
        }
        throw new Md2ParseError(ErrorKind.UnterminatedTable, start + 1, 'grid table has no band after its top border');
      }
      break; // 表在最后一条边框处结束（§3.11）
    }

    const band = [];
    for (let t = bandStart; t < idx; t++) band.push(t);
    bands.push(band);

    if (idx >= nTotal) {
      throw new Md2ParseError(ErrorKind.UnterminatedTable, idx, 'input ends inside an open band');
    }

    const line = trimmed[idx];
    if (looksLikeBorder(line)) {
      if (line.includes('\t')) {
        throw new Md2ParseError(ErrorKind.TableStructure, idx + 1, 'tab character in grid table line');
      }
      const border = parseBorderShape(idx + 1, line);
      checkBorderAgainstTop(border, borders[0]);
      checkSegmentMix(border);

      if (border.segs.every((s) => s.kind === 'eq')) {
        if (separator !== null) {
          throw new Md2ParseError(ErrorKind.DuplicateHeaderSeparator, idx + 1, 'more than one header separator');
        }
        separator = borders.length;
      } else if (border.segs.some((s) => s.leadColon || s.trailColon)) {
        throw new Md2ParseError(ErrorKind.AlignmentMarkerMisplaced, idx + 1, 'alignment markers are allowed only on the header separator');
      }

      borders.push(border);
      idx += 1;
    } else {
      // 注意：此处传的是裸 idx，**不要**改成 idx + 1。
      // idx 已被推进到 band 之后的那一行，而 band 最后一条内容行的 0-based
      // 下标是 idx - 1，其 1-based 行号恰好等于 idx。上游 grid.rs:299 同样
      // 传裸 idx 并注明 "last content line (1-based)"——这是有意为之，
      // 与同函数内其它抛出点（idx + 1）语义不同。
      throw new Md2ParseError(ErrorKind.UnterminatedTable, idx, 'grid table band is not closed by a border line');
    }
  }

  const m = bands.length;

  // ---- 边界活跃度（§3.4）----
  // active[k][i] = 边界 p_{i+1} 在 band k 中是否活跃（i 索引 0..nCols-1，最后一个未使用）
  const active = [];
  for (let k = 0; k < m; k++) {
    const band = bands[k];
    const acts = [];
    for (let ii = 1; ii < p.length; ii++) {
      const pos = p[ii];
      let withPipe = 0;
      for (const lineIdx of band) {
        const chars = Array.from(trimmed[lineIdx]);
        if (unescapedPipeAt(chars, pos)) withPipe += 1;
      }
      if (withPipe === 0) acts.push(false);
      else if (withPipe === band.length) acts.push(true);
      else {
        throw new Md2ParseError(
          ErrorKind.TableStructure,
          bands[k][0] + 1,
          'boundary pipe present on some band lines but not all (§3.4 uniformity)'
        );
      }
    }
    active.push(acts);
  }

  // ---- 角规则（§3.4）for B1..Bm ----
  for (let k = 1; k < borders.length; k++) {
    const border = borders[k];
    for (let i = 1; i < nCols; i++) {
      const pos = p[i];
      const hasCorner = border.corners.includes(pos);
      const above = active[k - 1][i - 1];
      const below = k < m && active[k][i - 1];
      if (hasCorner !== (above || below)) {
        throw new Md2ParseError(
          ErrorKind.BorderCornerMismatch,
          border.lineNo,
          `corner at column ${pos} violates the corner rule (§3.4)`
        );
      }
    }
  }

  // ---- 每个 band 的单元格（§3.4）----
  // bandCells[k] = [[c1, c2], ...]，1-based 闭区间列号
  const bandCells = [];
  for (const acts of active) {
    const cells = [];
    let c1 = 1;
    for (let i = 1; i < nCols; i++) {
      if (acts[i - 1]) {
        cells.push([c1, i]);
        c1 = i + 1;
      }
    }
    cells.push([c1, nCols]);
    bandCells.push(cells);
  }

  // ---- Rowspan：点线段（§3.7）----
  // 点线跨是两条角之间最大的 '.' 段连跑；当且仅当其正上、正下的 band 单元格
  // 恰好跨同一列范围时有效。有效跨把两个单元格并起来（并查集）；链式给出 rowspan >= 3。
  const parent = new Map();
  for (let k = 1; k < borders.length; k++) {
    const border = borders[k];
    let si = 0;
    while (si < border.segs.length) {
      if (border.segs[si].kind !== 'dot') {
        si += 1;
        continue;
      }
      const runStart = si;
      while (si < border.segs.length && border.segs[si].kind === 'dot') si += 1;

      if (k >= m) {
        throw new Md2ParseError(ErrorKind.TableStructure, border.lineNo, 'dotted segment on the bottom border has no band below to join');
      }

      const c1 = pIndexOf(p, border.corners[runStart]) + 1;
      const c2 = pIndexOf(p, border.corners[si]);
      // c1 ∈ [1, nCols] 必然落在 bandCells[k-1] 的某一格内（该数组是 1..nCols 的
      // 连续划分），故 findIndex 恒命中、不会返回 -1；与上游此处的 .unwrap() 同义。
      // 不要改成「取不到就跳过」——那会吞掉真实的几何错乱。
      const above = bandCells[k - 1].findIndex(([a, b]) => a <= c1 && c1 <= b);
      const below = bandCells[k].findIndex(([a, b]) => a <= c1 && c1 <= b);
      const ab = bandCells[k - 1][above];
      const bl = bandCells[k][below];
      if (ab[0] !== c1 || ab[1] !== c2 || bl[0] !== c1 || bl[1] !== c2) {
        throw new Md2ParseError(
          ErrorKind.MergeShapeMismatch,
          border.lineNo,
          `dotted span covers columns ${c1}..${c2}, but the cell above spans ${ab[0]}..${ab[1]} and the cell below spans ${bl[0]}..${bl[1]}`
        );
      }
      ufUnion(parent, ufKey(k - 1, above), ufKey(k, below));
    }
  }

  // ---- 分组元数据 ----
  const members = new Map();
  for (let k = 0; k < bandCells.length; k++) {
    for (let ci = 0; ci < bandCells[k].length; ci++) {
      const root = ufFind(parent, ufKey(k, ci));
      if (!members.has(root)) members.set(root, []);
      members.get(root).push([k, ci]);
    }
  }
  const info = new Map();
  for (const [root, list] of members) {
    list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const [topK, topCi] = list[0];
    const [c1, c2] = bandCells[topK][topCi];
    // §3.7：合并后的内容 = 各成员 band 单元格文本，最上 band 在前
    const texts = list.map(([k]) => cellText(trimmed, bands[k], p, c1, c2));
    info.set(root, { top: topK, height: list.length, content: texts.join('\n') });
  }

  // ---- 对齐（§3.6）与 header_row_count（§3.5）----
  const { Alignment, cell, coveredCell } = require('./ast.js');
  let alignments;
  if (separator === null) {
    alignments = new Array(nCols).fill(Alignment.Default);
  } else {
    alignments = new Array(nCols).fill(Alignment.Default);
    const border = borders[separator];
    for (let si2 = 0; si2 < border.segs.length; si2++) {
      const seg = border.segs[si2];
      const colLo = pIndexOf(p, border.corners[si2]) + 1;
      const colHi = pIndexOf(p, border.corners[si2 + 1]);
      let a = Alignment.Default;
      if (seg.leadColon && seg.trailColon) a = Alignment.Center;
      else if (seg.leadColon) a = Alignment.Left;
      else if (seg.trailColon) a = Alignment.Right;
      for (let c = colLo; c <= colHi; c++) alignments[c - 1] = a;
    }
  }
  // 分隔行在边框下标 s ⇒ band 1..s 都是表头行（§3.5）；因此「边框下标」与
  // 「表头行数」是同一个数的两种读法，不是巧合。不要拆成两个变量——那会把
  // 一个恒等式变成需要同步维护的约束。
  const headerRowCount = separator === null ? 0 : separator;

  // ---- 组装行（全网格合并表示）----
  const rows = [];
  for (let k = 0; k < bandCells.length; k++) {
    const cells = [];
    for (let ci = 0; ci < bandCells[k].length; ci++) {
      const [c1, c2] = bandCells[k][ci];
      const root = ufFind(parent, ufKey(k, ci));
      const g = info.get(root);
      if (k === g.top) {
        cells.push(cell(g.content, c2 - c1 + 1, g.height));
        for (let x = c1; x < c2; x++) cells.push(coveredCell());
      } else {
        for (let x = c1; x <= c2; x++) cells.push(coveredCell());
      }
    }
    rows.push({ cells });
  }

  return { table: { headerRowCount, alignments, rows }, consumed: idx - start };
}

module.exports = { looksLikeBorder, unescapedPipeAt, parseBorderShape, pIndexOf, parseGrid };
```

> **实现说明：** 上面把 `require('./ast.js')` 放在函数内部是为了避免本任务步骤 3 的替换操作遗漏顶部 import。执行时请把它提升到文件顶部的 require 区（与 `./errors.js` 并列）：
>
> ```js
> const { ErrorKind, Md2ParseError } = require('./errors.js');
> const { Alignment, cell, coveredCell } = require('./ast.js');
> ```
>
> `cell(content, colspan, rowspan)` / `coveredCell()` 的字段、键序与默认值与原内联字面量完全一致，行为等价；复用它们可避免 `Cell` 形状出现两处定义（未来加字段会静默漏改）。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/md2-grid-parse.test.cjs`
预期：PASS，36 个用例全绿

- [ ] **步骤 5：运行几何层测试确认未回归**

运行：`node --test test/md2-grid-shape.test.cjs`
预期：PASS，13 个用例仍全绿

- [ ] **步骤 6：Commit**

```bash
git add src/md2/grid.js test/md2-grid-parse.test.cjs
git commit -m "feat(md2): 网格表完整解析（边框扫描/角规则/点线 rowspan）"
```

> ⚠️ 执行前请向用户确认提交。

---

## 任务 6：管道表解析（`src/md2/pipe.js`）

**文件：**
- 创建：`src/md2/pipe.js`
- 测试：`test/md2-pipe.test.cjs`

**与 Rust 版本的有意差异：** `pipe.rs:359` 的 `parse_pipe_cell_content` 会用 pulldown-cmark 把格内容解析成内联节点，并处理行尾反斜杠硬换行（§4.8）。TizuMark 保留**原始字符串**交由注入的渲染回调处理，故这部分不需要移植 —— 行尾反斜杠在渲染阶段由 CommonMark 规则自然处理，且 md2 自己也就该场景声明「无可见效果」（见 `pipe.rs:354-358` 注释）。

- [ ] **步骤 1：编写失败的测试**

创建 `test/md2-pipe.test.cjs`：

```js
// 管道表解析（md2 规范 §4）。
// 正向用例对应上游 crates/md2-core/src/parse/pipe.rs 的 #[cfg(test)] mod tests
// 与 golden 夹具 09/10；**7 个错误用例是为本移植新写的**——上游 pipe.rs 的
// tests 模块一个错误 kind 都没断言，golden 09/10 也均为纯正向夹具。
// 注意：上游的 trailing_backslash_hard_break 用例在本移植中刻意缺席，
// 因为 parse_pipe_cell_content 不移植（见 src/md2/pipe.js 文件头说明）。
const test = require('node:test');
const assert = require('node:assert');
const {
  hasUnescapedPipe,
  splitCells,
  isDelimiterRow,
  findDelimiter,
  parsePipe,
} = require('../src/md2/pipe.js');
const { ErrorKind, Md2ParseError } = require('../src/md2/errors.js');
const { validate, columnCount } = require('../src/md2/ast.js');

test('管道行检测（含转义）', () => {
  assert.strictEqual(hasUnescapedPipe('a | b'), true);
  assert.strictEqual(hasUnescapedPipe('|'), true);
  assert.strictEqual(hasUnescapedPipe('a \\| b'), false); // 仅转义管道
  assert.strictEqual(hasUnescapedPipe('no pipes'), false);
  assert.strictEqual(hasUnescapedPipe('\\\\| x'), true); // 转义反斜杠 + 真管道
});

test('分格：可选外管道被丢弃，转义保留原样', () => {
  assert.deepStrictEqual(splitCells('| A | B |'), [' A ', ' B ']);
  assert.deepStrictEqual(splitCells('A | B'), ['A ', ' B']);
  assert.deepStrictEqual(splitCells('| A | B'), [' A ', ' B']);
  assert.deepStrictEqual(splitCells('| a \\| b |'), [' a \\| b ']);
  assert.strictEqual(splitCells('| A |  | B |').length, 3); // 中间空格
});

test('分隔行检测', () => {
  assert.strictEqual(isDelimiterRow('| --- | --- |'), true);
  assert.strictEqual(isDelimiterRow('| :--- | :---: | ---: | ---- |'), true);
  assert.strictEqual(isDelimiterRow('--- | ---'), true);
  assert.strictEqual(isDelimiterRow('| a | b |'), false);
  assert.strictEqual(isDelimiterRow('| --x | --- |'), false);
  assert.strictEqual(isDelimiterRow('no pipes'), false);
  assert.strictEqual(isDelimiterRow('| \\--- |'), false); // 转义短横 = 文本
});

test('findDelimiter 返回首个分隔行下标', () => {
  assert.strictEqual(findDelimiter(['| a | b |', '| - | - |']), 1);
  assert.strictEqual(findDelimiter(['| a | b |']), null);
});

test('规范 2x2 合并工作示例（§4.6）', () => {
  const run = ['| H1 | H2 |', '| -- | -- |', '| A  | >> |', '| ^^ | >> |'];
  const t = parsePipe(run, 1, 2);
  assert.strictEqual(t.headerRowCount, 1);
  assert.strictEqual(t.rows.length, 3);
  const a = t.rows[1].cells[0];
  assert.strictEqual(a.colspan, 2);
  assert.strictEqual(a.rowspan, 2);
  assert.strictEqual(a.content, 'A');
  assert.ok(t.rows[1].cells[1].covered);
  assert.ok(t.rows[2].cells[0].covered);
  assert.ok(t.rows[2].cells[1].covered);
  assert.deepStrictEqual(validate(t), { ok: true });
});

test('colspan 锚点的内容取自左侧格', () => {
  const t = parsePipe(['| H | H2 |', '| - | -- |', '| Blend | >> |'], 1, 1);
  const anchor = t.rows[1].cells[0];
  assert.strictEqual(anchor.colspan, 2);
  assert.strictEqual(anchor.content, 'Blend');
});

test('rowspan 连链得到 rowspan = 3', () => {
  const run = ['| H | B |', '| - | - |', '| R | x |', '| ^^ | y |', '| ^^ | z |'];
  const t = parsePipe(run, 1, 1);
  assert.strictEqual(t.rows[1].cells[0].rowspan, 3);
  assert.deepStrictEqual(validate(t), { ok: true });
});

test('转义标记视为字面文本', () => {
  const t = parsePipe(['| C | D |', '| - | - |', '| \\>> | x |'], 1, 1);
  assert.strictEqual(t.rows[1].cells[0].colspan, 1);
  assert.strictEqual(t.rows[1].cells[0].content, '\\>>');
});

test('多行表头：分隔行之上的每一行都是表头（§4.3）', () => {
  const t = parsePipe(['| A | B |', '| C | D |', '| - | - |', '| 1 | 2 |'], 2, 1);
  assert.strictEqual(t.headerRowCount, 2);
  assert.deepStrictEqual(validate(t), { ok: true });
});

test('对齐从分隔行提取（§4.9）', () => {
  const t = parsePipe(['| A | B | C |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |'], 1, 1);
  assert.deepStrictEqual(t.alignments, ['left', 'center', 'right']);
});

test('错误：格数与分隔行不符 → ColumnCountMismatch', () => {
  assert.throws(
    () => parsePipe(['| a | b |', '| - | - |', '| 1 | 2 | 3 |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.ColumnCountMismatch && e.line === 3
  );
});

test('错误：首列 >> → ColspanOnFirstColumn', () => {
  assert.throws(
    () => parsePipe(['| a | b |', '| - | - |', '| >> | x |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.ColspanOnFirstColumn && e.line === 3
  );
});

test('错误：首行 ^^ → RowspanOnFirstRow', () => {
  // 注意：`r` 是**剔除分隔行后**的行序，r = 0 指分隔行上方那一行。
  // 把 ^^ 放在分隔行**下方**（如 ['| a | b |','| - | - |','| ^^ | x |']）时
  // r = 1，不会走这个分支，而是撞上 MergeCrossesHeaderBoundary。
  assert.throws(
    () => parsePipe(['| ^^ | x |', '| - | - |', '| a | b |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.RowspanOnFirstRow && e.line === 1
  );
});

test('错误：延续格含内容 → MergeCellHasContent', () => {
  assert.throws(
    () => parsePipe(['| a | b |', '| - | - |', '| x | >> junk |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeCellHasContent && e.line === 3
  );
});

test('错误：混用标记 → MixedMergeMarkers', () => {
  assert.throws(
    () => parsePipe(['| a | b |', '| - | - |', '| x | >>^^ |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MixedMergeMarkers && e.line === 3
  );
});

test('错误：^^ 跨表头/表体边界 → MergeCrossesHeaderBoundary', () => {
  // 表头两行 + 表体首行的 ^^ 指向表头行
  assert.throws(
    () => parsePipe(['| a | b |', '| c | d |', '| - | - |', '| ^^ | x |'], 2, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeCrossesHeaderBoundary && e.line === 4
  );
});

test('错误：^^ 上方无同范围组 → MergeShapeMismatch', () => {
  assert.throws(
    () => parsePipe(['| a | b | c |', '| - | - | - |', '| x | y | z |', '| ^^ | >> | >> |'], 1, 1),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.MergeShapeMismatch && e.line === 4
  );
});

test('错误行号按物理行计算（分隔行占一行）', () => {
  try {
    parsePipe(['| a | b |', '| - | - |', '| 1 | 2 | 3 |'], 1, 10);
    assert.fail('应抛错');
  } catch (e) {
    assert.strictEqual(e.line, 12); // 第 3 行 → 10 + 2
  }
});

test('行号移位：表头行不多算一行（§4.3 多行表头）', () => {
  // r < delim 的表头行不加那 1；把一个错误放在**第二行表头**上，
  // 就能把「条件移位」与「无条件 +1」区分开。
  // （唯一那条 `e.line === 12` 的断言用的是 r = 1 / delim = 1，两者恰好同值，测不出移位。）
  assert.throws(
    () => parsePipe(['| a | b |', '| >> | x |', '| - | - |', '| z | w |'], 2, 7),
    (e) => e instanceof Md2ParseError && e.kind === ErrorKind.ColspanOnFirstColumn && e.line === 8
  );
});

test('表头块内部的 ^^ 是合法的 rowspan（§4.3 允许 N 行表头；§4.7 只禁止跨边界）', () => {
  // 若 crosses 退化为只留前一个合取项，这条合法输入会被误判为跨边界。
  const t = parsePipe(['| a | b |', '| ^^ | y |', '| - | - |', '| 1 | 2 |'], 2, 1);
  assert.strictEqual(t.headerRowCount, 2);
  assert.strictEqual(t.rows[0].cells[0].rowspan, 2);
  assert.ok(t.rows[1].cells[0].covered);
  assert.deepStrictEqual(validate(t), { ok: true });
});

test('findDelimiter 取**首个**分隔行（§4.2）', () => {
  // §4.2 用粗体强调：The first delimiter row delimits the table;
  // any later delimiter-shaped row is an ordinary body row.
  assert.strictEqual(findDelimiter(['| x | y |', '| - | - |', '| - | - |', '| p | q |']), 1);
});

test('splitCells / isDelimiterRow：外管道前后的空白不影响分格（§4.1）', () => {
  // 上游把段落行**原样**交给分格，行首缩进与行尾空格都不会被预先剥离，
  // 故必须靠 trim 判定「空段」。去掉 trim 会让缩进的管道表静默退化成普通段落。
  assert.deepStrictEqual(splitCells('  | a | b |'), [' a ', ' b ']);
  assert.deepStrictEqual(splitCells('| a | b |   '), [' a ', ' b ']);
  assert.strictEqual(isDelimiterRow('  | - | - |  '), true);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/md2-pipe.test.cjs`
预期：FAIL，报错 `Cannot find module '../src/md2/pipe.js'`

- [ ] **步骤 3：编写实现**

创建 `src/md2/pipe.js`：

```js
// 管道表解析（md2 规范 §4，对应 md2 仓库 crates/md2-core/src/parse/pipe.rs）。
//
// 与 Rust 版本的差异：parse_pipe_cell_content（pipe.rs:359）不移植 ——
// 单元格内容保留原始字符串，由 html.js 注入的回调渲染（见 ast.js 顶部说明）。
'use strict';

const { ErrorKind, Md2ParseError } = require('./errors.js');
const { Alignment, cell, coveredCell } = require('./ast.js');

/** §4.1：管道行至少含一个未被转义的 `|`。 */
function hasUnescapedPipe(line) {
  let escaped = false;
  for (const c of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') escaped = true;
    else if (c === '|') return true;
  }
  return false;
}

/**
 * 把一个管道行切成原始格文本（§4.1）。转义序列原样保留（交给渲染阶段处理）；
 * 最多丢弃一个前导、一个尾随的空段（可选外管道）。
 */
function splitCells(line) {
  const segs = [''];
  const chars = Array.from(line);
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\\') {
      segs[segs.length - 1] += c;
      i += 1;
      if (i < chars.length) {
        segs[segs.length - 1] += chars[i];
        i += 1;
      }
    } else if (c === '|') {
      segs.push('');
      i += 1;
    } else {
      segs[segs.length - 1] += c;
      i += 1;
    }
  }
  if (segs.length >= 2 && segs[0].trim() === '') segs.shift();
  if (segs.length >= 2 && segs[segs.length - 1].trim() === '') segs.pop();
  return segs;
}

/** §4.1：每个格匹配 `:?-+:?`，至少一格。 */
function isDelimiterRow(line) {
  const cells = splitCells(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => {
    const t = cell.trim();
    if (t.length === 0) return false;
    let i = t[0] === ':' ? 1 : 0;
    const dashStart = i;
    while (i < t.length && t[i] === '-') i += 1;
    if (i === dashStart) return false;
    if (i < t.length && t[i] === ':') i += 1;
    return i === t.length;
  });
}

/** 连跑中首个分隔行的下标，无则 null（§4.2）。 */
function findDelimiter(run) {
  const i = run.findIndex((line) => isDelimiterRow(line));
  return i === -1 ? null : i;
}

/** §4.9：从单个分隔格取对齐。 */
function delimiterAlignment(cell) {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right && t.length > 1) return Alignment.Center;
  if (left && !right) return Alignment.Left;
  if (!left && right) return Alignment.Right;
  return Alignment.Default;
}

/** 表格行 r（已剔除分隔行的 0-based 序）的 1-based 绝对行号。
 *  连跑中下标 >= delim 的行在物理上被分隔行推移了一行，故要 +1；表头行不加。
 *  （上游 pipe.rs:340 有同样的说明；丢掉它会让「条件移位」变成无从判断的魔法。） */
function rowLineNo(r, delim, firstLineNo) {
  return firstLineNo + r + (r >= delim ? 1 : 0);
}

/** `true` 当且仅当 t 是 unit 的非空重复。 */
function isRepeat(t, unit) {
  if (t.length === 0) return false;
  if (t.length % unit.length !== 0) return false;
  for (let i = 0; i < t.length; i += unit.length) {
    if (t.slice(i, i + unit.length) !== unit) return false;
  }
  return true;
}

// ---- 并查集：键为 "行,组下标" 字符串 ----
// ⚠️ 注意键域与 grid.js 的并查集**不同**：grid 用 (band, 单元格下标)，
// 这里用 (剔除分隔行后的行序, Pass 1 的组下标)。对应上游 pipe.rs:382-413。
// （不抽共享助手是有意的：这 25 行算法封闭，两处各对应一个上游 Rust 文件，
//  抽取会让「文件 ↔ 上游文件」的一一对应断开，而那是逐段等价核验的唯一手段。）
function ufKey(a, b) {
  return `${a},${b}`;
}

function ufFind(parent, x) {
  let root = x;
  for (;;) {
    const px = parent.get(root);
    if (px === undefined || px === root) break;
    root = px;
  }
  let cur = x;
  while (cur !== root) {
    const next = parent.get(cur) === undefined ? cur : parent.get(cur);
    parent.set(cur, root);
    cur = next;
  }
  return root;
}

function ufUnion(parent, a, b) {
  const ra = ufFind(parent, a);
  const rb = ufFind(parent, b);
  if (ra !== rb) parent.set(ra, rb);
}

/**
 * 解析一张管道表。
 *
 * 前置条件（调用方保证，本函数不校验）：
 *   - `run.length >= 1`，且 `0 < delim < run.length`（§4.2：分隔行不得是连跑首行）
 *   - `run` 中每行都满足 `hasUnescapedPipe`（否则会漏行）
 * 违反时 `run[delim]` 为 undefined，会在 splitCells 的 Array.from 处抛 TypeError，
 * 而非 Md2ParseError；`delim === 0` 不报错，但会静默产出 headerRowCount = 0 的表。
 *
 * @param {string[]} run 管道行的最大连跑
 * @param {number} delim 分隔行在 run 中的下标
 * @param {number} firstLineNo run[0] 的 1-based 绝对行号
 */
function parsePipe(run, delim, firstLineNo) {
  const headerRowCount = delim; // §4.3：分隔行之上的每一行
  const delimCells = splitCells(run[delim]);
  const nCols = delimCells.length;
  const alignments = delimCells.map(delimiterAlignment);

  // 物理顺序的全部表格行（表头在前，表体在后）
  const rowLines = run.filter((_, i) => i !== delim);
  const nRows = rowLines.length;

  // ---- 分格、列数校验、标记识别 ----
  // markers[r][c] / texts[r][c]：r 为**剔除分隔行后**的 0-based 行序，c 为 0-based 列号。
  // （注意与 headerRowCount 的域不同：那个是 run 的下标域。）
  const markers = [];
  const texts = [];
  for (let r = 0; r < nRows; r++) {
    const cells = splitCells(rowLines[r]);
    if (cells.length !== nCols) {
      throw new Md2ParseError(
        ErrorKind.ColumnCountMismatch,
        rowLineNo(r, delim, firstLineNo),
        `row has ${cells.length} cells but the delimiter row defines ${nCols} columns`
      );
    }
    const rowMarkers = [];
    const rowTexts = [];
    for (let c = 0; c < nCols; c++) {
      const t = cells[c].trim();
      let marker = 'none';
      if (t.startsWith('\\')) {
        marker = 'none'; // 转义：`\>>` / `\^^` 是字面文本（§4.5）
      } else if (t.startsWith('>>')) {
        if (c === 0) {
          throw new Md2ParseError(ErrorKind.ColspanOnFirstColumn, rowLineNo(r, delim, firstLineNo), '`>>` in the first column has no cell to merge with');
        }
        if (t.includes('^^')) {
          throw new Md2ParseError(ErrorKind.MixedMergeMarkers, rowLineNo(r, delim, firstLineNo), 'cell mixes `>>` and `^^` markers');
        }
        if (!isRepeat(t, '>>')) {
          throw new Md2ParseError(ErrorKind.MergeCellHasContent, rowLineNo(r, delim, firstLineNo), 'colspan continuation cell contains more than the marker');
        }
        marker = 'colspan';
      } else if (t.startsWith('^^')) {
        if (r === 0) {
          throw new Md2ParseError(ErrorKind.RowspanOnFirstRow, rowLineNo(r, delim, firstLineNo), '`^^` in the first row has no row above to merge with');
        }
        if (t.includes('>>')) {
          throw new Md2ParseError(ErrorKind.MixedMergeMarkers, rowLineNo(r, delim, firstLineNo), 'cell mixes `>>` and `^^` markers');
        }
        if (!isRepeat(t, '^^')) {
          throw new Md2ParseError(ErrorKind.MergeCellHasContent, rowLineNo(r, delim, firstLineNo), 'rowspan continuation cell contains more than the marker');
        }
        marker = 'rowspan';
      }
      rowMarkers.push(marker);
      rowTexts.push(t);
    }
    markers.push(rowMarkers);
    texts.push(rowTexts);
  }

  // ---- Pass 1：水平分组（§4.6）----
  const rowGroups = [];
  for (let r = 0; r < nRows; r++) {
    const groups = [];
    for (let c = 0; c < nCols; c++) {
      if (markers[r][c] === 'colspan') {
        // 并入左侧组（必然存在：列号 > 0）
        groups[groups.length - 1].c2 = c + 1;
      } else {
        groups.push({ c1: c + 1, c2: c + 1, anchorText: texts[r][c], caret: markers[r][c] === 'rowspan' });
      }
    }
    rowGroups.push(groups);
  }

  // ---- Pass 2：垂直合并（§4.6）----
  const parent = new Map();
  for (let r = 1; r < nRows; r++) {
    for (let gi = 0; gi < rowGroups[r].length; gi++) {
      const g = rowGroups[r][gi];
      if (!g.caret) continue;
      const ai = rowGroups[r - 1].findIndex((pg) => pg.c1 === g.c1 && pg.c2 === g.c2);
      if (ai === -1) {
        throw new Md2ParseError(
          ErrorKind.MergeShapeMismatch,
          rowLineNo(r, delim, firstLineNo),
          `\`^^\` group covers columns ${g.c1}..${g.c2}, but no single group above spans exactly that range`
        );
      }
      // §4.7：合并不得跨越表头/表体边界
      const crosses = r - 1 < headerRowCount && r >= headerRowCount;
      if (crosses) {
        throw new Md2ParseError(
          ErrorKind.MergeCrossesHeaderBoundary,
          rowLineNo(r, delim, firstLineNo),
          '`^^` would merge a body cell with a header cell'
        );
      }
      ufUnion(parent, ufKey(r - 1, ai), ufKey(r, gi));
    }
  }

  // ---- 分组元数据 ----
  const members = new Map();
  for (let r = 0; r < rowGroups.length; r++) {
    for (let gi = 0; gi < rowGroups[r].length; gi++) {
      const root = ufFind(parent, ufKey(r, gi));
      if (!members.has(root)) members.set(root, []);
      members.get(root).push([r, gi]);
    }
  }
  const regions = new Map();
  for (const [root, list] of members) {
    list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const [top, gi] = list[0];
    regions.set(root, { topRow: top, height: list.length, anchorText: rowGroups[top][gi].anchorText });
  }

  // ---- 组装行（全网格合并表示）----
  const rows = [];
  for (let r = 0; r < nRows; r++) {
    const cells = [];
    for (let gi = 0; gi < rowGroups[r].length; gi++) {
      const g = rowGroups[r][gi];
      const root = ufFind(parent, ufKey(r, gi));
      const region = regions.get(root);
      if (r === region.topRow) {
        cells.push(cell(region.anchorText, g.c2 - g.c1 + 1, region.height));
        for (let x = g.c1; x < g.c2; x++) cells.push(coveredCell());
      } else {
        for (let x = g.c1; x <= g.c2; x++) cells.push(coveredCell());
      }
    }
    rows.push({ cells });
  }

  return { headerRowCount, alignments, rows };
}

module.exports = {
  hasUnescapedPipe,
  splitCells,
  isDelimiterRow,
  findDelimiter,
  delimiterAlignment,
  parsePipe,
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/md2-pipe.test.cjs`
预期：PASS，22 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/md2/pipe.js test/md2-pipe.test.cjs
git commit -m "feat(md2): 管道表解析（>> / ^^ 合并标记）"
```

> ⚠️ 执行前请向用户确认提交。

---

## 任务 7：前置扫描器（`src/md2/scan.js`）

**文件：**
- 创建：`src/md2/scan.js`
- 测试：`test/md2-scan.test.cjs`

**职责：** 在 unified 管线之前逐行扫描，认领 md2 表格并替换为 HTML。关键约束（来自设计规格）：

> **⚠️ 任务 5 审查中发现的文档级分歧（本任务必须复核）：** 审查者用真实 md2 二进制（`cargo build -p md2-cli`）做差分，发现 **206 例「JS 解析成功、md2 整文档管线报错」**。其中 204/206 在「只把 JS 认定的区域喂给 Rust」时完全一致——即分歧**不在表格解析本身，而在「哪些区域被认定为表格」**：md2 的表格语法只在**顶层段落**中被认领（`parse/mod.rs` 的 `split_top_level_paragraph`），而本计划的 `scan.js` 是**逐行独立判断**。
>
> 落地后请对这四类文档级场景做差分复核（md2 不认领时我们也不应认领）：
> 1. **缩进代码块**（行首 ≥ 4 空格）内的边框行
> 2. **列表项**内的边框行
> 3. **HTML 块**内的边框行
> 4. 段落中**未用空行分隔**的边框行（md2 从段落里认领，多数与我们一致，但边界需实测）
>
> 差分方式：`cd C:\s\md2 && cargo run -q -p md2-cli -- lint -`（或 `render --ast -`）对同批文档跑上游，与本任务的 `convertMd2Tables` 输出比对。注意 1–3 因 `looksLikeBorder` 要求首字符为 `+` 而**大概率自然放行**，重点是确认「懒续」与「HTML 块」两类不会误认领。

> **⚠️ 管道表的「是否构成表」派发规则（任务 6 实现者实测得出，本任务必须精确移植）：** 连跑里**不存在有效分隔行**、或**分隔行位于连跑首行**时，都**不构成管道表**。上游此规则在 `parse/mod.rs:72-92`（属扫描层，不在 `pipe.rs`）：**必须存在分隔行、不能是首行、且（连跑位于段落起始 ‖ 分隔行是连跑的第 2 行）**。
>
> 不移植这条会有实质后果：`parsePipe` 的 `headerRowCount = delim` 语义（§4.3 多行表头）会被误用——例如把「无分隔行」的普通 `| a | b |` 文本当成 `headerRowCount = 0` 的表，或把「分隔行在首行」当成表头 0 行。
>
> 验证：任务 6 的差分测试中被跳过的输入**恰好只有这一类**，可直接作为本任务的用例来源。

- 围栏代码块内**不认领**
- 网格表**仅顶层**（md2 §1.4）
- 管道表**仅当含 `>>` / `^^` 标记时**才接管；无标记的普通 GFM 表**原样放行**（交给 remark-gfm）
- 解析失败时降级为**可见错误块**，消费掉该表格区域，文档其余部分继续渲染

- [ ] **步骤 1：编写失败的测试**

创建 `test/md2-scan.test.cjs`：

```js
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
  // 用 includes 而非正则：`+` 在正则里是量词，`\+-----+` 的收尾 `+` 会被当成
  // 「一个或多个短横」的重复，模式变成「5 个以上短横后紧跟换行」，永远匹配不上。
  // 写成 `\+-----+\+` 可以修，但 includes 更不容易再踩坑。
  assert.ok(out.includes('```\n+-----+\n| in  |\n+-----+\n```'), '围栏内原样');
  assert.match(out, /<TABLE>\s*out\(1x1\)<\/TABLE>/, '围栏外被认领');
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

test('分隔行位于连跑首行时不构成表（上游 Some(0) => false）', () => {
  const md = '| - | - |\n| x | >> |';
  const out = run(md);
  assert.ok(!/<TABLE>/.test(out), 'delim === 0 不应认表');
  assert.strictEqual(out, md, '应原样放行');
});

test('CRLF 输入下围栏仍然生效（info 提取不得被 \\r 破坏）', () => {
  // 若 fenceInfo 改用 `(.*)$` 捕获 info，`"```\r"` 会整体匹配失败 → 围栏态失效。
  // run() 按 '\n' 切分，故 CRLF 文档的行尾会保留 '\r'。
  const md = '```\r\n+---+\r\n| a |\r\n+---+\r\n```\r\n';
  assert.ok(!/<TABLE>/.test(run(md)), 'CRLF 围栏内的网格表不应被认领');
});

test('无标记大表不触发 O(m²) 重推导（短路回归）', () => {
  // 普通 GFM 表没有标记，第一次必不被认领 → 若不短路，会逐行回退并重新推导
  // 整条剩余连跑（O(m²)）。断言宽松上界（短路后实测 ~4ms，此处留百倍余量）
  // 以免在繁忙 CI 上闪；同时断言输出原样放行——只断言耗时会被「输出错但很快」骗过。
  const rows = [];
  for (let n = 0; n < 4000; n += 1) rows.push(`| a${n} | b${n} |`);
  const md = rows.join('\n');
  const t0 = Date.now();
  const out = run(md);
  const ms = Date.now() - t0;
  assert.strictEqual(out, md, '无标记连跑应原样放行');
  assert.ok(ms < 500, `4000 行耗时 ${ms}ms，超过 500ms 说明 O(m²) 短路失效`);
});

test('短路不得吞掉连跑中带围栏标记的行（围栏态必须照常切换）', () => {
  // '```| x |' 既以围栏标记开头、又含未转义 '|'，会被并入管道连跑。
  // 若短路直接跳到连跑末尾（字面 i = j），该行的围栏状态切换被跳过
  // → 游标继续时围栏未开 → 围栏内的网格表被误认领。
  const md = '| a | b |\n```| x |\n+---+\n| z |\n+---+';
  assert.strictEqual(run(md), md, '应原样放行，不得认领围栏内的网格表');
});

test('单元格内容原样传给渲染器（不预解析）', () => {
  const md = '+-----------+\n| **bold**  |\n+-----------+';
  const out = run(md);
  assert.match(out, /\*\*bold\*\*\(1x1\)/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/md2-scan.test.cjs`
预期：FAIL，报错 `Cannot find module '../src/md2/scan.js'`

- [ ] **步骤 3：编写实现**

创建 `src/md2/scan.js`：

```js
// md2 表格前置扫描器。
//
// 形态与 src/unified-renderer.js 既有的 convertContainerTables 一致：
// 在 unified 管线【之前】逐行扫描，把认领到的表格转成原始 HTML 再交给 remark。
// 两者职责分离——本模块只认领 md2 语法（网格表 + 带合并标记的管道表），
// 容器内的普通 GFM 表格仍由 convertContainerTables 处理。
//
// 上下文限制（md2 §1.4）：网格表与带标记的管道表都**只在顶层块上下文**识别。
'use strict';

const { Md2ParseError } = require('./errors.js');
const { looksLikeBorder, parseGrid } = require('./grid.js');
const { hasUnescapedPipe, splitCells, findDelimiter, parsePipe } = require('./pipe.js');

/** 该行是否属于网格表区域（用于解析失败时确定消费范围）。 */
function isGridish(line) {
  const t = line.replace(/\s+$/, '');
  return looksLikeBorder(t) || t.startsWith('|');
}

/** 整条连跑是否**任何行**含未转义的 `>>` / `^^`（用于未认领时的安全短路）。
 *  注意与 runHasMarker 的区别：这个**不跳过**分隔行。分隔行按定义
 *  （`isDelimiterRow` 要求每格匹配 `:?-+:?`）不可能含标记，故两者对
 *  「是否存在标记」判断等价；但只有覆盖全部行才能支撑下面的子集论证。 */
function runHasAnyMarker(run) {
  for (const line of run) {
    for (const cell of splitCells(line)) {
      const t = cell.trim();
      if (t.startsWith('\\')) continue;
      if (t.startsWith('>>') || t.startsWith('^^')) return true;
    }
  }
  return false;
}

/** 连跑中是否存在未转义的 `>>` / `^^` 标记（决定是否接管这张管道表）。 */
function runHasMarker(run, delim) {
  for (let r = 0; r < run.length; r++) {
    if (r === delim) continue;
    for (const cell of splitCells(run[r])) {
      const t = cell.trim();
      if (t.startsWith('\\')) continue; // 转义：字面文本
      if (t.startsWith('>>') || t.startsWith('^^')) return true;
    }
  }
  return false;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 默认错误块。只使用 class（rehype-sanitize 的 schema 允许 `*` 上的 class），
 * 不使用 data-* 属性，避免被 sanitize 剥离导致样式失效。
 */
function defaultRenderError(err, rawLines) {
  return (
    `<div class="md2-error">` +
    `<strong>md2 ${escapeHtml(err.kind)}</strong> (line ${err.line}): ${escapeHtml(err.message)}` +
    `<pre>${escapeHtml(rawLines.join('\n'))}</pre>` +
    `</div>`
  );
}

/** 围栏标记：返回 { char, len, info } 或 null。
 *  ⚠️ info 用 `line.slice(m[0].length)` 取，**不要**改用正则捕获 `(.*)$`：
 *  JS 的 `.` 不匹配 `\r`、且非 m 模式的 `$` 不在尾部 `\r` 前匹配，于是
 *  CRLF 输入的开围栏行 `"```\r"` 会整体匹配失败 → 围栏态彻底失效（相对旧正则的回归）。
 *  本模块不声明「调用方须先归一化换行」，故必须对 CRLF 安全。 */
function fenceInfo(line) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  return { char: m[1][0], len: m[1].length, info: line.slice(m[0].length) };
}

/**
 * 扫描并把 md2 表格替换为 HTML。
 * @param {string} content 整篇 markdown
 * @param {object} opts
 * @param {(table: object, renderCellContent: Function) => string} opts.renderTable 表格渲染器（来自 html.js）
 * @param {(content: string) => string} opts.renderCellContent 单元格内容渲染回调
 * @param {(err: Md2ParseError, rawLines: string[]) => string} [opts.renderError]
 * @returns {string}
 */
function convertMd2Tables(content, opts) {
  const renderTable = opts.renderTable;
  const renderCellContent = opts.renderCellContent;
  const renderError = opts.renderError || defaultRenderError;

  const lines = content.split('\n');
  const out = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const f = fenceInfo(line);
    if (f) {
      if (!inFence) {
        inFence = true;
        fenceChar = f.char;
        fenceLen = f.len;
      } else if (f.char === fenceChar && f.len >= fenceLen && f.info.trim() === '') {
        // CommonMark：**闭合**围栏不得带 info string。开围栏允许（上面那支不校验）。
        // 不加这条 `info` 判断，围栏内的 ```js 会被当成闭合行 → 提前退出围栏态 →
        // 认领仍处于围栏内的表格。
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      out.push(line);
      i += 1;
      continue;
    }
    if (inFence) {
      out.push(line);
      i += 1;
      continue;
    }

    // ---- 网格表（仅顶层）----
    if (looksLikeBorder(line)) {
      try {
        const { table, consumed } = parseGrid(lines, i);
        out.push(renderTable(table, renderCellContent));
        i += consumed;
        continue;
      } catch (e) {
        if (!(e instanceof Md2ParseError)) throw e;
        let j = i;
        while (j < lines.length && isGridish(lines[j])) j += 1;
        out.push(renderError(e, lines.slice(i, j)));
        i = j;
        continue;
      }
    }

    // ---- 管道表（仅当含合并标记时接管）----
    if (hasUnescapedPipe(line)) {
      let j = i;
      while (j < lines.length && hasUnescapedPipe(lines[j])) j += 1;
      const run = lines.slice(i, j);
      const delim = findDelimiter(run);
      // delim === 0 不构成表（上游 parse/mod.rs：Some(0) => false）——
      // 分隔行位于连跑首行时，那条 run 是普通段落文本。
      if (delim !== null && delim !== 0 && runHasMarker(run, delim)) {
        try {
          const table = parsePipe(run, delim, i + 1);
          out.push(renderTable(table, renderCellContent));
          i = j;
          continue;
        } catch (e) {
          if (!(e instanceof Md2ParseError)) throw e;
          out.push(renderError(e, run));
          i = j;
          continue;
        }
      }
      // 未认领：若整条连跑不含任何标记，任何子连跑也不可能含——子连跑的行集合
      // ⊆ 原连跑；且分隔行按定义不含 `>>`/`^^`，故即使某行在原连跑里是分隔行、
      // 在子连跑里变成普通行，它依然不带标记。可直接跳过整条，避免大 GFM 表
      // 触发 O(m²) 重推导（实测 4000 行 1853ms → 4ms）。
      //
      // ⚠️ 但终点**不能**直接取 j：主循环每轮开头都会做围栏检查（fenceInfo 在
      // 管道分支之前），整条推完会让被跳过的行**再也不会切换围栏状态**。故终点
      // 收紧到「i 之后第一个围栏标记行」（无则仍为 j）。两件事正交：子集关系管
      // 「会不会被认领」，围栏检查管「有没有副作用」。
      // 字面 i = j 的实测反例（2/4013 例输出不同）：
      //   '| a | b |\n```| x |\n+---+\n| z |\n+---+' —— 字面短路会认领围栏内的网格表。
      if (!runHasAnyMarker(run)) {
        let k = i + 1;
        while (k < j && !fenceInfo(lines[k])) k += 1;
        for (let x = i; x < k; x += 1) out.push(lines[x]);
        i = k;
        continue;
      }
    }

    out.push(line);
    i += 1;
  }

  return out.join('\n');
}

module.exports = { convertMd2Tables };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/md2-scan.test.cjs`
预期：PASS，19 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/md2/scan.js test/md2-scan.test.cjs
git commit -m "feat(md2): 前置扫描器（围栏感知/标记识别/错误降级）"
```

> ⚠️ 执行前请向用户确认提交。

---

## 任务 8：接入渲染管线（`src/unified-renderer.js`）

**文件：**
- 修改：`src/unified-renderer.js`（顶部 require 区 + `renderMarkdown` 内的前置转换调用点，约 `:1482`）
- 测试：`test/md2-render.test.cjs`

**⚠️ 与设计规格的一处偏离（更简单且更强）：** 规格第 5 节写「单元格内容递归深度上限 4 层」。实际实现**不需要深度上限**——md2 本身禁止表格嵌套（单元格内不再识别表格，§1.4），配合重入守卫 `_renderingMd2Cell`，嵌套深度恒为 1。守卫同时杜绝了无限递归。规格该行应同步更新为「重入守卫使嵌套深度恒为 1」。

> 保持 `renderMarkdown` 的 `softBreaks` 等既有选项行为不变；本次只新增一步前置转换。

- [ ] **步骤 1：编写失败的测试**

创建 `test/md2-render.test.cjs`：

```js
// 端到端：renderMarkdown 产出带 colspan/rowspan 的表格。
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../src/unified-renderer.js');

test('网格表 2x2 合并端到端渲染', () => {
  const md = [
    '+-------+-------+-------+',
    '| A 2x2         | B     |',
    '+...............+-------+',
    '|               | C     |',
    '+---------------+-------+',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<table>/);
  assert.match(html, /<td colspan="2" rowspan="2">/);
  assert.match(html, /A 2x2/);
  assert.match(html, /C/);
});

test('管道表 >> 标记端到端渲染', () => {
  const md = ['| H1 | H2 | H3 |', '| -- | -- | -- |', '| A spans | >> | B |'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<td colspan="2">/);
  assert.match(html, /A spans/);
});

test('管道表 ^^ 标记端到端渲染', () => {
  const md = ['| H1 | H2 |', '| -- | -- |', '| R | B |', '| ^^ | C |'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<td rowspan="2">/);
});

test('无标记的普通 GFM 表格输出不变（回归）', () => {
  const md = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<table/);
  assert.match(html, /<th[^>]*>a<\/th>/);
  assert.ok(!/colspan|rowspan/.test(html), '普通表格不应出现合并属性');
});

test('表格内的行内标记照常渲染', () => {
  // 边框宽度必须容得下最宽的单元格内容，故取 21 个短横（闭合竖线落在第 22 列）。
  // ⚠️ 断言必须容忍元素属性：单元格内容回灌完整管线后，remarkSourceLine 会给每个
  // 元素注入 data-source-line，实际产出是 `<strong data-source-line="1">bold</strong>`，
  // 写死 `<strong>bold</strong>` 永远不可能匹配。
  const md = ['+---------------------+', '| **bold** and `code` |', '+---------------------+'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<strong[^>]*>bold<\/strong>/);
  assert.match(html, /<code[^>]*>code<\/code>/);
});

test('单元格内列表渲染为真实列表', () => {
  const md = [
    '+----------------+',
    '| - item one     |',
    '| - item two     |',
    '+----------------+',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<ul[^>]*>/);
  assert.match(html, /<li[^>]*>item one<\/li>/);
});

test('块引用内的网格表不被认领（md2 §1.4：仅顶层）', () => {
  const md = ['> +---+', '> | a |', '> +---+'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(!/<table/.test(html), '容器内不应生成 md2 表格');
  assert.ok(!/md2-error/.test(html), '也不应报 md2 错误');
});

test('单元格内容中的表格语法不产生嵌套表（重入守卫）', () => {
  // 单元格文本是 " +---+"，若不设重入守卫，递归渲染时它会被 md2 扫描
  // 再次认领成一张表。守卫使嵌套深度恒为 1（md2 §1.4 本身也禁止单元格内嵌表格）。
  const md = [
    '+-----------+',
    '| +---+     |',
    '+-----------+',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  const tables = html.match(/<table/g) || [];
  assert.strictEqual(tables.length, 1, '只应有一张表，不应嵌套');
});

test('错误块可见且文档其余部分仍渲染', () => {
  const md = ['# Title', '', '| a |', '| - |', '| 1 | 2 |', '', 'tail'].join('\n');
  // 该表无 >> / ^^ 标记 → 放行给 remark-gfm，不产生 md2 错误
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /tail/);
});

test('网格表语法错误时产出 .md2-error 块且后续内容继续渲染', () => {
  const md = [
    '+---+---+',
    '| a | b | c |',
    '+---+---+',
    '',
    'after',
  ].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.match(html, /class="md2-error"/);
  assert.match(html, /after/);
});

test('围栏代码块内的网格表保持原样', () => {
  const md = ['```', '+---+', '| a |', '+---+', '```'].join('\n');
  const html = renderMarkdown(md, { softBreaks: false });
  assert.ok(!/<table/.test(html), '围栏内不应生成表格');
  assert.match(html, /\+---\+/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/md2-render.test.cjs`
预期：FAIL —— 前 3 个合并用例失败（`colspan`/`rowspan` 不出现），错误块用例失败（无 `md2-error`）。其余用例此时应已通过（它们断言的是既有行为）。

- [ ] **步骤 3：编写实现**

在 `src/unified-renderer.js` 顶部 require 区（`const { visit } = require('unist-util-visit');` 之后）加入：

```js
const { convertMd2Tables } = require('./md2/scan.js');
const { renderTable: renderMd2Table } = require('./md2/html.js');
```

在 `unist-util-visit` 之后、文件其余函数之前，加入单元格内容渲染器与重入守卫：

```js
// ---- md2 表格支持 ----
// 单元格内容重入守卫：md2 禁止表格嵌套（§1.4），因此单元格内容渲染期间
// 不再执行 md2 表格转换。这同时杜绝无限递归——嵌套深度恒为 1，
// 无需设计规格中的「深度上限」。
let _renderingMd2Cell = false;

/**
 * md2 单元格内容渲染器：把单元格内的 Markdown 回灌同一条 unified 管线，
 * 从而获得完整 CommonMark（含行内标记、列表、代码块等）。
 * 产物作为原始 HTML 拼进表格标记，随后由 rehype-raw 重新解析并 sanitize。
 */
function renderMd2CellContent(text) {
  const src = String(text == null ? '' : text);
  if (src.trim() === '') return '';
  if (_renderingMd2Cell) return escapeHTML(src); // 防御：结构上不可达
  _renderingMd2Cell = true;
  try {
    return renderMarkdown(src, { softBreaks: false });
  } catch (_) {
    return escapeHTML(src);
  } finally {
    _renderingMd2Cell = false;
  }
}
```

> **单元格内的 `<p>` 包裹（已知且有意的差异）：** 上游 `html.rs:215-216` 把**单段落**单元格渲染为**裸行内内容**（golden 里 `A 2x2` 就是裸文本，没有 `<p>`），而这里回灌 unified 会产出 `<p>…</p>`。一致性门禁按**空白折叠后的文本**比较，故门禁不受影响——这一点已记录在设计规格的「门禁的诚实边界」。保留 `<p>` 的理由：单元格内可能有列表、代码块等多块内容，统一走管线比按段落数分支更简单可靠。**样式注意：** `.preview-content td` 里的 `<p>` 会带来默认上下边距，接入后需目视检查表格外观，必要时在 `src/styles.css` 的表格区加一条 `.preview-content td > p:only-child { margin: 0; }`。

在 `renderMarkdown` 内，找到 `processed = convertContainerTables(processed);`（约 `:1482`），在**其前**插入：

```js
    // md2 表格（网格语法 + 带 >> / ^^ 标记的管道表）：仅顶层、且不在单元格重入时执行。
    // 必须在 convertContainerTables 之前——两者职责分离：本步只认领 md2 语法，
    // 容器内的普通 GFM 表格仍由下一步处理。
    if (!_renderingMd2Cell) {
      processed = convertMd2Tables(processed, {
        renderTable: renderMd2Table,
        renderCellContent: renderMd2CellContent,
      });
    }

    processed = convertContainerTables(processed);
```

> **注意：** `escapeHTML` 已存在于 `src/unified-renderer.js`（搜索定位；计划早前写的 `:788` 行号可能已漂移），直接复用；不要新增重复实现。

> **⚠️ 已知行为点（任务 8 实测发现，待任务 11 处理）：** 单元格内容里的 `data-source-line` 是**片段相对行号**而非文档绝对行号。实测：表格位于源码第 8 行时，单元格内产出 `data-source-line="1"`。后果是**点击预览中 md2 表格单元格内的文字会跳到错误的源行**（`preview-sync.js` 走 `closest('[data-source-line]')`）。
>
> 这不构成既有行为回归（md2 表格是全新语法），一致性门禁也不受影响（归一化器只比对 `textContent`）。但「跳到错误行」比「不跳」更差，建议在**任务 11** 里剥掉单元格内容里的 `data-source-line`（在 `renderMd2CellContent` 返回前 `.replace(/\sdata-source-line="[^"]*"/g, '')`），使行为统一为「不跳」而非「跳错」。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/md2-render.test.cjs`
预期：PASS，10 个用例全绿

- [ ] **步骤 5：回归 —— 既有渲染测试必须原样通过**

运行：`node scripts/run-tests.cjs unified-renderer container-table-lazy render`
预期：全部 ok

- [ ] **步骤 6：Commit**

```bash
git add src/unified-renderer.js test/md2-render.test.cjs
git commit -m "feat(md2): 渲染管线接入 md2 表格（前置扫描 + 单元格内容回灌）"
```

> ⚠️ 执行前请向用户确认提交。

---

## 任务 9：错误块样式（`src/styles.css`）

**文件：**
- 修改：`src/styles.css`（表格样式区之后，约 `:2139`）
- 测试：`test/md2-error-style.test.cjs`

- [ ] **步骤 1：编写失败的测试**

创建 `test/md2-error-style.test.cjs`：

```js
// md2 错误块样式存在性。样式缺失会让错误块退化成裸文本，用户看不出这是
// 「表格语法错误」而不是普通正文。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

test('存在 .md2-error 规则', () => {
  assert.match(CSS, /\.preview-content\s+\.md2-error\s*\{/);
});

test('存在 .md2-error pre 规则', () => {
  assert.match(CSS, /\.preview-content\s+\.md2-error\s+pre\s*\{/);
});

test('错误块有视觉区分（左侧强调边）', () => {
  const m = /\.preview-content\s+\.md2-error\s*\{([\s\S]*?)\}/.exec(CSS);
  assert.ok(m, '应能取到规则体');
  assert.match(m[1], /border-left/);
});

test('存在表格单元格内单段落重置规则（md2 单元格经管线会产出 <p>）', () => {
  // 任务 8 审查提出：md2 单元格内容回灌 unified 会产出 <p>，其在 td/th 里的
  // 默认上下边距会把表格撑开。GFM 表格单元格不含 <p>，故该规则对它们无影响。
  assert.match(CSS, /\.preview-content\s+td\s*>\s*p:only-child/);
  assert.match(CSS, /\.preview-content\s+th\s*>\s*p:only-child/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/md2-error-style.test.cjs`
预期：FAIL，3 个用例均失败（规则不存在）

- [ ] **步骤 3：编写实现**

在 `src/styles.css` 的表格样式区之后（**用内容搜索**定位 `/* Table alignment */`，不要凭行号）追加：

```css
/* md2 表格解析错误块：语法错误时替代表格显示，文档其余部分照常渲染 */
.preview-content .md2-error {
  border: 1px solid var(--border-color);
  border-left: 3px solid #d9534f;
  border-radius: 4px;
  padding: 8px 12px;
  margin: 12px 0;
  font-size: calc(var(--ui-font-size) * 0.9231);
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.preview-content .md2-error strong {
  color: #d9534f;
}

.preview-content .md2-error pre {
  margin: 8px 0 0;
  padding: 8px;
  white-space: pre-wrap;
  overflow-x: auto;
  font-size: 0.9em;
  opacity: 0.75;
  background: var(--bg-primary);
  border-radius: 3px;
}

/* md2 单元格内容回灌 unified 管线会产出 <p>，其在单元格内的默认上下边距会把
   表格撑开。只重置**唯一子元素**的情形——单元格含多块内容（列表/代码块等）时
   仍保留正常段落间距。GFM 表格单元格不含 <p>，不受影响。 */
.preview-content td > p:only-child,
.preview-content th > p:only-child {
  margin: 0;
}
```

> **注意：** 上述 CSS 变量（`--border-color`、`--bg-secondary`、`--text-primary`、`--bg-primary`、`--ui-font-size`）均已定义于 `src/styles.css`，直接使用；不要新造变量。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/md2-error-style.test.cjs`
预期：PASS，4 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/styles.css test/md2-error-style.test.cjs
git commit -m "feat(md2): 表格解析错误块样式"
```

> ⚠️ 执行前请向用户确认提交。

---

## 任务 10：一致性门禁（归一化器 + golden 夹具）

**文件：**
- 创建：`test/helpers/md2-normalize.cjs`
- 创建：`test/fixtures/md2-golden/`（从 md2 复制的夹具副本 + 来源说明）
- 测试：`test/md2-normalize.test.cjs`、`test/md2-conformance.test.cjs`

**归一化规则**（设计规格「一致性门禁」节）：
1. 解析为元素树 → 2. 元素名/层级/顺序 → 3. cell 的 colspan/rowspan（缺省 1）→ 4. covered 应省略（该行 cell 数一致）→ 5. 单元格文本（空白折叠）→ 6. 对齐值归一（`style="text-align:X"` 与 `align="X"` 视为同一个 X）

**⚠️ 门禁的诚实边界：** 本门禁比较的是**表格骨架 + 合并结构 + 单元格文本 + 对齐**，**不比较单元格内部的标记细节**。md2 的 `html.rs` 把单段落单元格渲染为裸行内内容（`<td>A 2x2</td>`），而 TizuMark 回灌 unified 会产生 `<p>` 包裹。两者文本相同、结构相同，但内部标记不同——这是**有意接受**的差异，门禁不覆盖它。

- [ ] **步骤 1：复制夹具**

```bash
mkdir -p test/fixtures/md2-golden
cp C:/s/md2/test_data/golden/04_grid_multiline_cells.md2 test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/06_grid_colspan.md2 test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/07_grid_rowspan.md2 test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/08_grid_rowcol_span.md2 test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/12_grid_two_headers_colspan.md2 test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/13_grid_two_headers_rowspan.md2 test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/04_grid_multiline_cells.html test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/06_grid_colspan.html test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/07_grid_rowspan.html test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/08_grid_rowcol_span.html test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/12_grid_two_headers_colspan.html test/fixtures/md2-golden/
cp C:/s/md2/test_data/golden/13_grid_two_headers_rowspan.html test/fixtures/md2-golden/
```

- [ ] **步骤 2：编写夹具来源说明**

创建 `test/fixtures/md2-golden/README.md`：

```markdown
# md2 golden 夹具（副本）

来源：md2 仓库 `test_data/golden/`，v0.1，MIT 许可。
上游路径：`C:\s\md2\test_data\golden\`

这些是**副本**，不是跨仓库路径依赖——md2 演进不会静默改变本仓库的测试结果。
若需同步上游变更，请显式重新复制并在此处记录同步日期。

用途：`test/md2-conformance.test.cjs` 的一致性门禁。归一化后比较
表格骨架、colspan/rowspan、covered 省略、单元格文本与对齐。
**不**比较单元格内部的标记细节（md2 输出裸行内内容，TizuMark 回灌 unified 会加 `<p>` 包裹）。

同步日期：2026-09-13
```

- [ ] **步骤 3：编写失败的测试（归一化器自身）**

创建 `test/md2-normalize.test.cjs`：

```js
// 一致性归一化器自身的测试。归一化器是门禁的度量工具，它错了门禁就失去意义。
const test = require('node:test');
const assert = require('node:assert');
const { extractTables } = require('./helpers/md2-normalize.cjs');

test('提取表格骨架与合并跨度', () => {
  const html =
    '<table><tbody>' +
    '<tr><td colspan="2" rowspan="2">A</td><td>B</td></tr>' +
    '<tr><td>C</td></tr>' +
    '</tbody></table>';
  const [t] = extractTables(html);
  assert.strictEqual(t.rows.length, 2);
  assert.strictEqual(t.rows[0].length, 2);
  assert.strictEqual(t.rows[0][0].colspan, 2);
  assert.strictEqual(t.rows[0][0].rowspan, 2);
  assert.strictEqual(t.rows[1].length, 1);
});

test('covered 省略即体现为行内 cell 数差异', () => {
  const html =
    '<table><tbody>' +
    '<tr><td rowspan="2">R</td><td>B</td></tr>' +
    '<tr><td>C</td></tr>' +
    '</tbody></table>';
  const [t] = extractTables(html);
  assert.strictEqual(t.rows[0].length, 2);
  assert.strictEqual(t.rows[1].length, 1);
});

test('对齐：align 属性与内联 style 归一到同一值', () => {
  const a = extractTables('<table><tr><td align="center">x</td></tr></table>');
  const b = extractTables('<table><tr><td style="text-align: center">x</td></tr></table>');
  assert.strictEqual(a[0].rows[0][0].align, 'center');
  assert.strictEqual(b[0].rows[0][0].align, 'center');
  assert.deepStrictEqual(a, b);
});

test('缺省对齐归一为 default', () => {
  const [t] = extractTables('<table><tr><td>x</td></tr></table>');
  assert.strictEqual(t.rows[0][0].align, 'default');
});

test('单元格文本空白折叠', () => {
  const [t] = extractTables('<table><tr><td>  a   b  </td></tr></table>');
  assert.strictEqual(t.rows[0][0].text, 'a b');
});

test('headerRowCount 取自 thead 的行数', () => {
  const html = '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
  const [t] = extractTables(html);
  assert.strictEqual(t.headerRowCount, 1);
});

test('无 thead 时 headerRowCount 为 0', () => {
  const [t] = extractTables('<table><tbody><tr><td>a</td></tr></tbody></table>');
  assert.strictEqual(t.headerRowCount, 0);
});

test('th 与 td 都计为 cell', () => {
  const [t] = extractTables('<table><tr><th>a</th><td>b</td></tr></table>');
  assert.strictEqual(t.rows[0].length, 2);
});
```

- [ ] **步骤 4：运行测试验证失败**

运行：`node --test test/md2-normalize.test.cjs`
预期：FAIL，报错 `Cannot find module './helpers/md2-normalize.cjs'`

- [ ] **步骤 5：编写归一化器实现**

创建 `test/helpers/md2-normalize.cjs`：

```js
// md2 一致性门禁的归一化器。
//
// 目的：把 TizuMark 与 md2 的输出归一到可比较的规范形式，吸收两者的
// **有意差异**（对齐编码：md2 用内联 style，TizuMark 用 align 属性）。
//
// 比较范围（设计规格「一致性门禁」节）：
//   1. 元素树     2. 元素名/层级/顺序   3. colspan / rowspan（缺省 1）
//   4. covered 省略（体现为该行 cell 数） 5. 单元格文本（空白折叠）
//   6. 对齐值归一
//
// **不比较**单元格内部的标记细节：md2 把单段落单元格输出为裸行内内容，
// TizuMark 回灌 unified 会产生 <p> 包裹。文本与结构相同，标记不同。
'use strict';

const { JSDOM } = require('jsdom');

/** 从一段 HTML 中提取所有 <table> 的规范形式。 */
function extractTables(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  return Array.from(doc.querySelectorAll('table')).map(normalizeTable);
}

function alignOf(el) {
  const attr = el.getAttribute('align');
  if (attr) return String(attr).toLowerCase();
  const style = el.getAttribute('style') || '';
  const m = /text-align\s*:\s*(left|center|right)/i.exec(style);
  return m ? m[1].toLowerCase() : 'default';
}

function normalizeTable(table) {
  const rows = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = [];
    for (const el of Array.from(tr.children)) {
      const tag = el.tagName.toLowerCase();
      if (tag !== 'td' && tag !== 'th') continue;
      cells.push({
        tag,
        colspan: Number(el.getAttribute('colspan') || 1),
        rowspan: Number(el.getAttribute('rowspan') || 1),
        align: alignOf(el),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      });
    }
    rows.push(cells);
  }
  const thead = table.querySelector('thead');
  const headerRowCount = thead ? thead.querySelectorAll('tr').length : 0;
  return { headerRowCount, rows };
}

module.exports = { extractTables, normalizeTable };
```

- [ ] **步骤 6：运行测试验证通过**

运行：`node --test test/md2-normalize.test.cjs`
预期：PASS，8 个用例全绿

- [ ] **步骤 7：编写一致性门禁测试**

创建 `test/md2-conformance.test.cjs`：

```js
// md2 一致性门禁（硬门禁）：网格夹具必须与 md2 的 .html 快照结构等价。
//
// 「结构等价」= 归一化后的表格骨架、colspan/rowspan、covered 省略、
// 单元格文本、对齐值全部相同。不含单元格内部标记细节（见归一化器注释）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderMarkdown } = require('../src/unified-renderer.js');
const { extractTables } = require('./helpers/md2-normalize.cjs');

const FIX = path.join(__dirname, 'fixtures', 'md2-golden');

// 网格夹具：硬门禁（「网格严格」原则）
const GRID_FIXTURES = [
  '04_grid_multiline_cells',
  '06_grid_colspan',
  '07_grid_rowspan',
  '08_grid_rowcol_span',
  '12_grid_two_headers_colspan',
  '13_grid_two_headers_rowspan',
];

for (const name of GRID_FIXTURES) {
  test(`一致性（硬门禁）：${name}`, () => {
    const src = fs.readFileSync(path.join(FIX, `${name}.md2`), 'utf8');
    const expected = fs.readFileSync(path.join(FIX, `${name}.html`), 'utf8');
    const actual = renderMarkdown(src, { softBreaks: false });

    const ours = extractTables(actual);
    const theirs = extractTables(expected);

    assert.ok(theirs.length > 0, 'md2 夹具应至少含一张表');
    assert.strictEqual(
      ours.length,
      theirs.length,
      `表格数量不一致：TizuMark ${ours.length}，md2 ${theirs.length}`
    );
    assert.deepStrictEqual(ours, theirs);
  });
}

test('夹具文件齐全', () => {
  for (const name of GRID_FIXTURES) {
    assert.ok(fs.existsSync(path.join(FIX, `${name}.md2`)), `缺少 ${name}.md2`);
    assert.ok(fs.existsSync(path.join(FIX, `${name}.html`)), `缺少 ${name}.html`);
  }
  assert.ok(fs.existsSync(path.join(FIX, 'README.md')), '缺少来源说明 README.md');
});
```

- [ ] **步骤 8：运行门禁**

运行：`node --test test/md2-conformance.test.cjs`
预期：PASS，7 个用例全绿

> **若失败：** 逐条对比 `assert.deepStrictEqual` 的 diff 输出定位差异。常见原因：①`headerRowCount` 与 `thead` 行数不符（检查分隔行识别）；②某行 cell 数不符（检查 covered 省略）；③对齐值不符。**不要**为了让测试变绿而放宽归一化器——归一化器只允许吸收「对齐编码」这一项已知差异。

- [ ] **步骤 9：Commit**

```bash
git add test/helpers/md2-normalize.cjs test/md2-normalize.test.cjs test/md2-conformance.test.cjs test/fixtures/md2-golden/
git commit -m "test(md2): 一致性门禁（结构等价归一化 + md2 golden 夹具）"
```

> ⚠️ 执行前请向用户确认提交。

---

## 任务 11：全量回归与收尾

**文件：**
- 修改：`docs/superpowers/specs/2026-09-13-md2-merged-tables-design.md`（同步两处规划期修正）
- 无新增源码

- [ ] **步骤 1：同步设计规格的两处修正**

在 `docs/superpowers/specs/2026-09-13-md2-merged-tables-design.md` 中：

① 把第 5 节的深度上限句：

```markdown
- 设置深度上限 **4 层**防止病态嵌套；超限时按纯文本转义输出（不做二次递归）
```

改为：

```markdown
- 以重入守卫（`_renderingMd2Cell`）杜绝递归：md2 禁止单元格内嵌表格（§1.4），嵌套深度恒为 1，无需层数上限；异常路径回退为 HTML 转义
```

② 在「一致性门禁」节的归一化规则列表之后追加：

```markdown
**门禁的诚实边界：** 本门禁比较表格骨架、合并结构、单元格文本与对齐，**不比较单元格内部的标记细节**。md2 把单段落单元格输出为裸行内内容，TizuMark 回灌 unified 会产生 `<p>` 包裹——文本与结构一致，标记不同，此为有意接受的差异。
```

- [ ] **步骤 2：运行全部 md2 相关测试**

运行：`npm test -- md2`
预期：全部 ok（errors / ast / html / grid-shape / grid-parse / pipe / scan / render / normalize / conformance / error-style 共 11 个文件）

- [ ] **步骤 3：运行渲染相关既有测试（回归）**

运行：`node scripts/run-tests.cjs unified-renderer container-table-lazy render preview table-enter`
预期：全部 ok，**无新增失败**

- [ ] **步骤 4：运行守卫**

运行：`npm run check`
预期：**5 个命令的链条**全部通过（`check-globals` → `coupling-report` → `check-version` → `entry-scripts` → `tauri-api`，见 `package.json` 的 `check` 脚本；后两条是测试文件，各自含 3 / 7 个断言）。**特别确认 `check-globals` 与 `entry-scripts` 仍然通过**——`src/md2/*.js` 是 CommonJS 子模块，不产生 `window` 全局，不应触发这两个守卫。若它们报错，说明 `src/md2/` 被误当作 `src/modules/` 扫描，需检查守卫脚本的扫描范围而非改动守卫配置。

- [ ] **步骤 5：运行全量测试**

运行：`npm test`
预期：全部通过。**若出现与本次改动无关的既有失败，如实记录，不要声称全绿。**

- [ ] **步骤 6：构建产物确认**

运行：`npm run build:renderer`
预期：成功输出 `✓ src/lib/unified-bundle.js 已从 src/unified-renderer.js 自动重建`

用 grep 确认 md2 代码已进入 bundle：

```bash
grep -c "md2-error" src/lib/unified-bundle.js
```

预期：输出 ≥ 1

- [ ] **步骤 7：Commit**

```bash
git add docs/superpowers/specs/2026-09-13-md2-merged-tables-design.md
git commit -m "docs(md2): 同步实现期对设计规格的两处修正（重入守卫/门禁边界）"
```

> ⚠️ 执行前请向用户确认提交。**注意：步骤 6 的 `npm run build:renderer` 只是重新生成 gitignored 的构建产物，不是 `npm run build`（打包发布）**——后者是红线操作，本计划全程不涉及。

---

## 完成标准

- [ ] 11 个 md2 测试文件全绿
- [ ] `npm run check` 5 个命令全部通过
- [ ] `npm test` 无新增失败
- [ ] 既有 GFM 表格渲染输出零变化
- [ ] `src/lib/unified-bundle.js` 含 md2 代码
- [ ] 设计规格的两处修正已同步

## 明确不在本计划范围

- **子项目 2**：DOCX 导出的 `columnSpan` / `rowSpan`（`src/modules/export-docx.js:156-166`、`src/modules/docx-builder.js:20`）
- **子项目 3**：CodeMirror 高亮（网格几何 + `>>` / `^^`）
- **子项目 4**：编辑命令（合并/拆分、span 感知行列操作、斜杠菜单、Tab 导航）
- 错误文案的 i18n（当前为英文内联文本）
- **`scan.js` 的顶层块上下文收敛（任务 7 实测确认的结构级缺口，建议单独立任务）** —— 见下节。

---

## 已知缺口：`scan.js` 未实现 md2 的文档级认领规则（任务 7 实测）

任务 7 用真实 `md2.exe` 做过系统差分（65 例手工语料 + 600/400 例随机差分），结论如下。**这是本计划交付后最值得优先补的一块。**

### 量化结果

| 组 | 例数 | 认领一致 | 我们多认 | 我们少认 | 上游报错-我们降级 | 上游报错-**我们没察觉** |
|---|---|---|---|---|---|---|
| 全带标记 | 600 | 369（**其中 27 例内容不同**） | **131（21.8%）** | 0 | 100 | 0 |
| 全无标记 | 400 | 195 | 32 | 101（设计意图） | 66 | 6 |

**带标记时我们从不漏认（under = 0），且上游报错的表我们 100% 都注意到了**——错误降级路径可靠。问题全在**过度认领**。

### 根因分类（均已最小复现）

| 编号 | 情形 | 上游 | 我们 | 根因 |
|---|---|---|---|---|
| D1 | 紧邻正文行 + `delim >= 2` | 不认表 | 认表 | 缺 `parse/mod.rs:72-92` 的 `i == 0 \|\| d == 1` |
| D2 | `delim == 0` | 不认表 | 认表（`headerRowCount = 0`） | 缺 `Some(0) => false` — **已修** |
| D3/D4 | 缩进（≥4 空格 / TAB）内容 | 不认表 | 认表 | `hasUnescapedPipe` 无列约束；`fenceInfo` 只认 ≤3 空格缩进的围栏 |
| D5/D6 | 列表 / 块引用**懒续** | 不认表 | 认表 | 无容器概念 |
| D7/D10 | HTML 块内 | 不认表 | 认表 | 无 HTML 块感知 |
| D8/D9 | 网格表的列表 / 块引用懒续 | 不认表 | 认表 | 网格分支同样无顶层判定 |
| D11 | **认领数一致但内容错位** | 1 张，`hrc=1` | 1 张，`hrc=2` | 最大连跑把上游视为缩进代码块的行并了进来 |
| D15 | 未认领时的 `i += 1` 回退**认领了子连跑** | 0 张 | 1 张 | 整条连跑因某种原因未被认领后逐行回退，子连跑的分隔行落到下标 1 而被单独认领。复现：`\| - \| - \|` ↵ `\| a \| b \|` ↵ `\| c \| d \|` ↵ `\| - \| - \|` ↵ `\| e \| >> \|`。**根因与 D1/D2 都不同**。 |
| D16 | `- \| - \|` 被 CommonMark 当作**列表项** | `Paragraph` + `List` | 1 张表 | 无块结构感知；触发机制与 D5–D10 不同（这里是**行首 `- `** 成了列表标记，而非容器懒续）。复现：`A \| B \|` ↵ `- \| - \|` ↵ `x \| >> \|`。 |

> **D11 是最隐蔽的一类**：随机 600 例中「认领数一致」的 369 例里，**27 例内容不同**，且 27/27 全部由「行首 ≥4 空格 / TAB 的管道行」解释（0 例未归因）。**不要用「认领张数」作为正确性指标**——它掩盖静默内容错位。

### 关键实测（坐实警告 B）

`i == 0` 是「连跑是该**段落**的第一行」，不是「文档第一行」：

| 文档 | 上游 |
|---|---|
| `text` ↵ `\| a \| b \|` ↵ `\| c \| d \|` ↵ `\| e \| f \|` ↵ `\| - \| - \|` ↵ `\| x \| >> \|` | **不认表** |
| `# H` ↵ 同上 | **`headerRows = 2`** |

两者都是 `delim == 2`，差别只在连跑前是「同段落的正文行」（`i = 1`）还是「ATX 标题」（标题终结段落 → 连跑成为新段落首行 → `i = 0`）。

### 性能（任务 7 审查实测，**已修**）

未认领的管道连跑原本只 `i += 1`，下一轮从 `i+1` 重新推导整条剩余连跑 → **O(m²)**：

| 输入 | 修复前 |
|---|---|
| 无标记 GFM 表 1000 行 | 115 ms |
| 无标记 GFM 表 4000 行 | 1874 ms |
| 纯管道行 20000 行 | **39.9 s** |

**这不是罕见路径**：普通 GFM 表**没有标记**，第一次必不被认领，必然走这条路径。任务 8 接入渲染热路径后，粘贴大表会卡 UI。

修法：整条连跑**完全不含标记**时直接 `i = j` 跳过。子集性论证保证安全——子连跑的行集合 ⊆ 原连跑，且 `isDelimiterRow` 要求每格匹配 `:?-+:?`，**分隔行不可能含 `>>`/`^^`**，故即使某行在原连跑中是分隔行、在子连跑中变成普通行，它依然不带标记。

### 收敛路径（建议的优先级顺序）

1. **围栏 info 缺陷**（独立、低成本）—— **已修**
2. **`delim == 0`**（一行）—— **已修**
3. **D1 派发规则**——需要「连跑是否位于段落起始」。可用「上一行是空行**或**是终结段落的块（标题/围栏/表格等）」近似，但**必须先量再改**：该近似可能同时引入漏认。
4. **缩进代码块跟踪**（D3/D4/D11）——行首 ≥4 空格或 TAB 起缩进代码块。这条同时消除「把代码块渲染成表格」与 D11 的静默内容错位。
5. **HTML 块与容器跟踪**（D5–D10）——需要等价于上游 `split_top_level_paragraph` + `container_depth` 的顶层段落切分。这是**结构级改动**，`scan.js` 局部修不了。注意 `src/unified-renderer.js` 的 `convertContainerTables` 已有容器懒续跟踪的先例可参考。

### 复现工具

65 例手工语料 + 随机差分脚本位于 `C:\Users\Yoong\AppData\Local\Temp\md2diff\`（`corpus.js` / `run.js` / `fuzz.js` / `verify-astdiff.js`）。**临时目录，会被清理**——若要作为长期回归夹具，需另立任务决定放置位置（建议 `test/fixtures/md2-scan-corpus/`）。

---

## 参考

- 设计规格：`docs/superpowers/specs/2026-09-13-md2-merged-tables-design.md`
- md2 仓库：`C:\s\md2`（MIT，v0.1）
- md2 解析源：`crates/md2-core/src/parse/{grid,pipe,mod}.rs`
- md2 AST/渲染：`crates/md2-core/src/{ast,html,error}.rs`
- TizuMark 渲染器：`src/unified-renderer.js`（前置扫描先例 `:591-670`，调用点 `:1482-1483`）
- 表格样式：`src/styles.css:2107-2139`
- 打印路径（子项目 2 相关）：`src/modules/export.js:1343-1391`、`src/styles.css:5777-5797`

