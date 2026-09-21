# md2 golden 夹具（副本）

来源：md2 仓库 `test_data/golden/`，v0.1，MIT 许可。
上游路径：`C:\s\md2\test_data\golden\`
版权：Copyright (c) 2026 The md2 authors（本目录文件为逐字节副本，版权归上游）
许可全文见同目录 `LICENSE`（与上游 md2 LICENSE 逐字节一致）。

> **这些夹具文件不得添加任何头部注释。** 它们是 `test/md2-conformance.test.cjs`
> 的输入与期望输出，改动一个字节就会改变解析结果或使比对失败。

这些是**副本**，不是跨仓库路径依赖——md2 演进不会静默改变本仓库的测试结果。
若需同步上游变更，请显式重新复制并在此处记录同步日期。

用途：`test/md2-conformance.test.cjs` 的一致性门禁。归一化后比较
表格骨架、colspan/rowspan、covered 省略、单元格文本与对齐。
**不**比较单元格内部的标记细节（md2 输出裸行内内容，TizuMark 回灌 unified 会加 `<p>` 包裹）。

同步日期：2026-09-13（含后续补入的 `grid_alignment`）

当前夹具清单（7 个）：

| 夹具 | 覆盖维度 |
|------|---------|
| `04_grid_multiline_cells` | 单元格内多行内容 |
| `06_grid_colspan` | 列合并（`>`） |
| `07_grid_rowspan` | 行合并（`^`） |
| `08_grid_rowcol_span` | 行列合并组合 |
| `12_grid_two_headers_colspan` | 双表头 + 列合并 |
| `13_grid_two_headers_rowspan` | 双表头 + 行合并 |
| `grid_alignment` | **对齐标记（表头分隔行上 `:` 的位置决定左/中/右）** |
