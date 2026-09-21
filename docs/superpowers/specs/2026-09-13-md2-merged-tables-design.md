# md2 合并单元格表格支持 设计文档（子项目 1：解析与渲染内核）

- 日期：2026-09-13
- 状态：已实现（2026-09-13；实现期对第 5 节深度上限、门禁诚实边界与测试计划表做过同步修正）
- 作者：Yoong Hor Meng
- 许可：MIT（移植/衍生自 md2，Copyright (c) 2026 The md2 authors；见 `src/md2/LICENSE`）
- 目标：让 TizuMark 支持带合并单元格（colspan/rowspan）的表格——**本子项目只做「解析 + 预览渲染」**，导出与编辑器支持见「后续子项目」。

## 背景

### 现状

1. **无合并单元格语法。** 预览渲染走 `unified` + `remark-parse` + `remark-gfm`（`src/unified-renderer.js`，经 esbuild 打包为 `src/lib/unified-bundle.js`）。全仓库 `src/` 下 `colspan|rowspan` 零命中。GFM 管道表格语法本身不表达合并。
2. **但原始 HTML 的合并是通的。** `rehype-sanitize` 用的是 hast-util-sanitize 的 GitHub 默认 schema，`colSpan`/`rowSpan` 在 `*` 白名单内（`src/lib/unified-bundle.js:22747`、`:22782`），`<td colspan="2">` 能存活并被渲染。
3. **PDF 导出是打印式的。** `src/modules/export.js:1343` 的 `_exportViaSystemPrint()` 走隐藏 `iframe[srcdoc]` + `contentWindow.print()`，样式见 `src/styles.css:5777-5797`（`@media print` + `@page`）。**因此只要预览 DOM 里有 `colspan`/`rowspan`，PDF 自动带上——本子项目不需要任何 PDF 代码。**
4. **已有前置扫描先例。** `convertContainerTables()`（`src/unified-renderer.js:591`）在 unified 管线**之前**逐行扫描，把容器内/紧邻段落的 GFM 表格转成原始 HTML 再交给 remark。本方案沿用同一形态。
5. **单元格内容渲染器较弱。** `renderCellContent()`（`src/unified-renderer.js:740`）只处理 code/bold/italic/del/link 五种正则，不支持列表、代码块、多段落——不满足 md2 对单元格内容的要求。

### 参考项目

`C:\s\md2`（MIT）是 CommonMark 0.31.2 的严格超集，核心能力即表格合并：

- `crates/md2-core/src/parse/grid.rs`（689 行）——网格语法：边框形状解析、band 提取、**并查集**合并区域（`uf_find`/`uf_union`，`:545`/`:566`）
- `crates/md2-core/src/parse/pipe.rs`（511 行）——管道简写：`>>` / `^^` 标记
- `crates/md2-core/src/parse/mod.rs`——`split_top_level_paragraph()`：把表格语法从段落解析中「认领」出来
- `crates/md2-core/src/ast.rs`——全网格 AST（anchor + covered 表示法）
- `crates/md2-core/src/html.rs`——渲染真实 `colspan`/`rowspan`
- `test_data/golden/`——19 有效 + 19 无效文档，含手写 `.ast.json` 与 `.html` 快照

**关键结构对应**：md2 的 `split_top_level_paragraph` 与 TizuMark 的 `convertContainerTables` 是同一形态——都是「在主解析器之前逐行认领表格语法」。这使方案 A（移植）的落点非常自然。

## 需求（已澄清）

| # | 决策项 | 结论 |
|---|---|---|
| 1 | 语法范围 | **管道简写 + 网格语法**（md2 §3 与 §4 全部） |
| 2 | 严格度 | **网格严格、管道宽松**：网格表完整实施 md2 规则与类型化错误；管道表保留 GFM 宽松度（错列行照常补/截，不报错） |
| 3 | 导出范围 | 预览 + PDF + HTML/图片 + **DOCX**（后者属子项目 2） |
| 4 | 编辑器 | 高亮 + 编辑命令（子项目 3、4） |
| 5 | 一致性门禁 | **结构等价**（非字节精确）：经归一化后比较元素树、colspan/rowspan、covered 省略、单元格文本、对齐值 |
| 6 | 解析实现 | **方案 A**：把 md2 的表格解析移植为 JS，挂进现有前置扫描缝隙 |

## 方案

### 1. 模块布局

新增 `src/md2/` 子树，与 `src/unified-renderer.js` 平级：

```
src/md2/
  ast.js        Table / Row / Cell + validate() + columnCount()      ~120
  errors.js     ParseError + ErrorKind（md2 的 13 种）                ~80
  grid.js       移植 parse/grid.rs                                   ~700
  pipe.js       移植 parse/pipe.rs                                   ~520
  scan.js       前置扫描器：从行流中认领 md2 表格                    ~200
  html.js       AST → HTML（colspan/rowspan）                        ~120
```

约 1700 行。`grid.js` 是主体，承载几何算法。

**为什么这个位置是干净的**：

- 这些文件用 CommonJS `module.exports` / `require()`，与 `src/unified-renderer.js` 现有风格一致（该文件虽被 esbuild 打包，但源码用的是 `require`，见其 `:1-12`）
- 由 esbuild 一并打进 `src/lib/unified-bundle.js`，**不产生 `window` 全局**
- 因此 `check-globals`（只管 `src/modules/*.js`）与 `entry-scripts`（只要求 `src/modules/*.js` 在 `index.html` 有 `<script>`）两个守卫都看不到它们，**无需改动任何守卫配置**
- 测试可直接 `require('../src/md2/grid.js')`，无需 jsdom

### 2. 集成缝隙

在 `src/unified-renderer.js` 的管线前置阶段新增 `convertMd2Tables(content)`，**在 `convertContainerTables()` 之前调用**（调用点现为 `:1482-1483`）。

扫描器形态与 `convertContainerTables` 一致：

1. 逐行扫描，跟踪 ``` / ~~~ 围栏状态（围栏内不认领）
2. 命中网格表候选行 → `md2/grid.js` 解析，消费 N 行，产出 HTML 拼回行流
3. 命中管道表 → 交给 `md2/pipe.js`（仅当存在 `>>` / `^^` 标记时才接管；无标记的普通 GFM 表**原样放行**，仍由 remark-gfm 处理，避免行为漂移）
4. 其余行原样透传

**上下文限制**：网格表**仅在顶层块上下文**识别（md2 §1.4：不在块引用、列表项内）。**管道表带 `>>` / `^^` 标记时同样仅限顶层**——容器内的管道表继续由 `convertContainerTables` 处理，其中的 `>>` / `^^` 按字面文本渲染，不视为标记。这与现有容器处理不冲突，两者职责分离、边界明确。

**候选行判定**（对应 md2 的 `looks_like_border`，`grid.rs:34-43`）：行首为 `+`、行尾为 `+`、且只含边框字符。注意 `+---+` 不是 CommonMark 列表项（列表标记要求 `+` 后跟空格），无冲突。

**已知行为变化（需接受）**：正文中原本作为字面文本出现的 `+---+` 现在会被认领为表格（或报错）。这是 md2 规范定义的行为，是「网格严格」的必然代价。缓解：仅当整行符合边框形状才认领，且报错时按第 6 节可见化，不静默吞掉。

### 3. AST 设计（移植 `ast.rs`）

采用 md2 的**全网格表示**（`ast.rs:7-20`）：每个 `Row` 恰好携带 `columnCount` 个 cell，网格位置 O(1) 可寻址。合并区域由两部分表示：

- **anchor**：矩形左上角的 cell，携带内容与 `colspan`/`rowspan` > 1
- **covered**：矩形内其余位置，`covered: true`、内容为空、`colspan == rowspan == 1`

```js
// src/md2/ast.js
{ type: 'table', headerRowCount, alignments: [...], rows: [ { cells: [ {content, colspan, rowspan, covered} ] } ] }
```

`validate()` 复检平铺不变量：anchor 恰好铺满网格、不重叠、不留空、每个 covered 落在唯一 anchor 矩形内（对应 `ast.rs:110-178`）。

**内部用 AST，不直接产字符串**——`html.js` 单独负责输出，这样一致性门禁、后续 DOCX 导出（子项目 2）、后续编辑器几何改写（子项目 4）都能复用同一份结构。

### 4. 解析

直接移植，保持行为一致优先于 JS 惯用法：

- `grid.js`：`parseBorderShape`（`grid.rs:60`，含 `unescaped_pipe_at` 转义处理 `:46`）、band 提取 `cell_text`（`grid.rs:533`，注意「行尾 padding 剥离、行首保留」——4 空格以上缩进会变成缩进代码块）、并查集合并区域、三类校验 `check_content_line` / `check_border_against_top` / `check_segment_mix`
- `pipe.js`：`split_cells`（`pipe.rs:27`）、`is_delimiter_row`（`:52`）、`delimiter_alignment`（`:82`）、`Marker` 解析（`:95`）、`is_repeat`（`:345`）、`parse_pipe_cell_content`（`:359`）
- 单元格内容解析为**基础 CommonMark 块**（md2 §3.10），交由第 5 节处理

**转义**：`\>>`、`\^^` 转义为字面量；网格表中 `>>`/`^^` **永远不是标记**，只是普通文本（md2 §4.5）。

### 5. 单元格内容渲染

md2 要求单元格可含完整 CommonMark 块（列表、围栏代码、块引用、多段落、标题）。现有 `renderCellContent()` 的五条正则不够用。

**方案**：单元格内容**递归回灌同一个 unified processor**，从而获得真实 CommonMark 渲染。要点：

- 以重入守卫（`_renderingMd2Cell`）杜绝递归：md2 禁止单元格内嵌表格（§1.4），嵌套深度恒为 1，无需层数上限；异常路径回退为 HTML 转义
- 单元格内标题降级处理（md2 未定义单元格内标题的层级语义，按 TizuMark 现有内联规则处理）
- **数学、Mermaid、脚注、高亮等无需额外处理**——`PreviewPost.*` 在 `innerHTML` 注入后对整个 `#preview` DOM 统一后处理（`src/controllers/preview-controller.js:186-215`），单元格内的内容自动享受同等处理

这是本子项目**技术风险最高**的一处（递归重入 + 与现有后处理的交互），需重点测试。

### 6. 错误处理

「网格严格」意味着用户会写出坏表格。若直接抛异常会导致预览空白，因此：

- `errors.js` 提供 md2 的 13 种 `ErrorKind`（`error.rs:12-45`）：`TableStructure`、`MixedSegmentChars`、`BorderCornerMismatch`、`MergeShapeMismatch`、`MergeCrossesHeaderBoundary`、`DuplicateHeaderSeparator`、`RowspanOnFirstRow`、`ColspanOnFirstColumn`、`MergeCellHasContent`、`ColumnCountMismatch`、`AlignmentMarkerMisplaced`、`UnterminatedTable`、`MixedMergeMarkers`
- `ParseError` 携带 1-based 行号、（有意义的）列号、kind、message（对应 `error.rs:78-84`）
- **渲染降级**：解析失败时，把该区域渲染为可见的错误块（显示 kind + 行号 + 消息），**文档其余部分继续正常渲染**——不整篇失败
- 管道表**不产生**这些错误（宽松）：错列行照常补齐/截断

### 7. HTML 输出

`html.js` 产出真实属性（对应 `html.rs:191-196`）：

- `colspan` / `rowspan` 仅在 > 1 时输出
- **covered cell 完全不产出元素**（`html.rs:185-187`）——该行 `td` 数少于列数，这是合并的正确表达
- `headerRowCount > 0` → `<thead>` 内全部为 `<th>`；其余进 `<tbody>` 用 `<td>`（`html.rs:162-180`）

**对齐编码差异（有意保留）**：md2 用内联 `style="text-align: left"`；TizuMark 既有约定与 CSS 选择器（`src/styles.css:2138`）用 `align="left"` 属性。本方案**采用 TizuMark 的 `align` 属性**，以保持与现有表格 CSS 一致；差异由一致性门禁的归一化吸收（见下节）。

## 一致性门禁

md2 的 `test_data/golden/` 作为一致性套件。因对齐编码差异，比较**不逐字节**，而是两侧各自 `normalize(html)` 后比对：

**归一化规则**（需有独立单元测试）：

1. 解析为元素树
2. 元素名、层级、顺序
3. 每个 cell 的 `colspan` / `rowspan`（缺省视为 1）
4. covered cell 应被省略——即两侧该行的 cell 数应一致
5. 单元格文本（拼接后比较，空白折叠）
6. 对齐：`style="text-align:X"` 与 `align="X"` 归一为同一个 `X`

**门禁的诚实边界：** 本门禁比较表格骨架、合并结构、单元格文本与对齐，**不比较单元格内部的标记细节**。md2 把单段落单元格输出为裸行内内容，TizuMark 回灌 unified 会产生 `<p>` 包裹——文本与结构一致，标记不同，此为有意接受的差异。

**门禁范围**：网格夹具（`06_grid_colspan`、`07_grid_rowspan`、`08_grid_rowcol_span`、`12_grid_two_headers_colspan`、`13_grid_two_headers_rowspan`、`grid_alignment`，以及 `04_grid_multiline_cells`）**作为硬门禁**；管道夹具（`09`、`10`）按「管道宽松」原则作为参考/回归，不作为硬门禁。

夹具以**副本**形式纳入 `test/fixtures/md2-golden/`，并在文件中标注来源与版本（md2 v0.1，MIT），避免跨仓库路径依赖。

## 测试计划

| 层 | 位置 | 内容 |
|---|---|---|
| 单元 | `test/md2-errors.test.cjs` | 13 种 kind 的枚举与 `Md2ParseError` 字段契约 |
| 单元 | `test/md2-ast.test.cjs` | `validate()` 平铺不变量：重叠、留空、越界、非正跨度、covered 形状 |
| 单元 | `test/md2-html.test.cjs` | AST → HTML：colspan/rowspan、covered 省略、thead/tbody 切分、对齐、钳制 |
| 单元 | `test/md2-grid-shape.test.cjs` | 网格几何原语：边框形状、转义管道、角位置、行号传递 |
| 单元 | `test/md2-grid-parse.test.cjs` | 网格表端到端：band 扫描、角规则、点线 rowspan、各错误 kind 与行号 |
| 单元 | `test/md2-pipe.test.cjs` | `>>` / `^^` 标记、转义、错列宽松、派发边界（`delim==0`） |
| 单元 | `test/md2-scan.test.cjs` | 前置扫描器：认领范围、围栏感知（含 CRLF）、错误降级、普通表格放行 |
| 集成 | `test/md2-render.test.cjs` | 端到端 `renderMarkdown()` → DOM 断言 colspan/rowspan；单元格内列表与行内标记；重入守卫 |
| 样式 | `test/md2-error-style.test.cjs` | 错误块与单元格段落样式存在性 |
| 单元 | `test/md2-normalize.test.cjs` | 一致性归一化器自身 |
| 一致性 | `test/md2-conformance.test.cjs` | 网格夹具结构等价（硬门禁，7 个夹具，含 `grid_alignment`） |
| 回归 | 现有全部表格测试 | `unified-renderer.test.cjs`、`table-enter.test.cjs`、`container-table-lazy.test.cjs` 等**必须原样通过** |

**回归底线**：现有 GFM 表格渲染输出不得改变。无 `>>` / `^^` 标记的管道表必须走原路径。

**jsdom 提醒**：本子项目全部可在 jsdom 中测（不依赖布局几何）。真正需要真实浏览器的是子项目 3、4 的编辑器部分。

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 单元格内容递归回灌 | 最高——递归深度、与后处理交互 | 重入守卫（`_renderingMd2Cell`）杜绝递归 + 异常路径 HTML 转义降级；专项测试 |
| 认领字面 `+---+` 文本 | 现有文档行为变化 | 严格限定边框形状；错误可见化不静默 |
| 与 `convertContainerTables` 顺序耦合 | 表格被重复或漏处理 | 明确调用顺序 + 两侧覆盖的测试用例 |
| 移植偏差（Rust → JS） | 与 md2 语义不一致 | 结构等价门禁 + 保留 Rust 侧算法结构不「优化」 |
| 1700 行新代码进入渲染热路径 | 预览卡顿 | 扫描器为 O(行数) 且仅在命中候选行时进入解析；大文档性能测试 |

## 明确排除（后续子项目）

- **子项目 2 — 导出对齐**：`src/modules/export-docx.js:156-166` 与 `src/modules/docx-builder.js:20` 增加 `columnSpan` / `rowSpan`，含 covered cell 跳过与网格宽度推导。验证 PDF/HTML/图片三条路径（预期自动生效，需测试确认）。
- **子项目 3 — 编辑器高亮**：CodeMirror 模式/overlay 识别网格几何与 `>>` / `^^` 标记。注意 `scripts/ensure-vendor.mjs:49` 是整目录复制 `codemirror/mode`，自定义模式需另置路径。
- **子项目 4 — 编辑命令**：合并/拆分单元格、span 感知的行列操作（`src/modules/format.js` 的 `_handleTableEnter` / `_addTableRow` / `_addTableColumn` / `_normalizeTableBlock`）、斜杠菜单插入网格表、Tab 导航跳过 covered cell。**风险最高，最后做。**

## 参考

- md2 仓库：`C:\s\md2`（MIT，v0.1，`spec/md2-spec.md`）
- md2 规范：`spec/md2-spec.md`（网格 §3、管道 §4、错误 §7）
- TizuMark 渲染器：`src/unified-renderer.js`
- 集成调用点：`src/unified-renderer.js:1482-1483`
- 现有前置扫描先例：`src/unified-renderer.js:591-670`
- 表格 CSS：`src/styles.css:2107-2139`
- 打印路径：`src/modules/export.js:1343-1391`、`src/styles.css:5777-5797`
