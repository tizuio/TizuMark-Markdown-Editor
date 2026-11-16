# PDF 导出目录（书签大纲 + 纸面目录页）设计 — 2026-11-17

## 意图

用户导出的 PDF 没有任何目录导航：阅读器侧边栏大纲面板是空的，标题印出来就是普通文字，
纸面上也没有目录页。本次目标（方案 A+B 合并实施）：

1. 导出的 PDF 自带**书签大纲**（从 h1–h6 自动生成，阅读器侧边栏可点击跳转）
2. 文档开头带**纸面目录页**（标题 + 点线 + 页码 + 可点击跳转，公式按 KaTeX 渲染）

## 方案取舍

| 方案 | 做法 | 取舍 | 结论 |
|---|---|---|---|
| A. CDP 管线生成书签 | `CallDevToolsProtocolMethod("Page.printToPDF", …)` + `generateDocumentOutline: true` | 原生 Chromium 能力，书签零维护；依赖运行时版本 | **选用（第一阶段）** |
| B. 两遍打印生成纸面目录页 | 占位打印 → 取页码 → 填充 → 再打印 | 有纸面目录页；导出时间翻倍 | **选用（第二阶段）** |
| B'. pdfjs 文本匹配定位标题页码 | 提取每页文本做匹配 | 行内公式标题下文本匹配脆弱（KaTeX 双层 DOM 污染） | 排除，改用 A 的大纲树取页码 |
| C'. 原生 PrintSettings 加 outline | 等 WebView2 官方接口 | [WebView2Feedback#4466](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4466) 至今 open + priority-low，`ICoreWebView2PrintSettings2` 实测无此属性 | 不可行，排除 |

**A+B 的关键协同**：第一遍打印开启 outline 后，产出的 PDF 自带大纲树，每个书签带目标页码
——解析自己产出的大纲即得「标题→页码」映射，B 不再需要文本匹配（B' 的全部风险消失）。

## 设计

管线全部改动集中在前端 `export.js` + Rust `print_to_pdf`，复用现有打印态准备逻辑。

### 第一阶段：CDP 书签（A）

1. Rust `print_to_pdf` 先走 CDP：参数与现有 PrintSettings 完全同值（8.27×11.69 英寸、
   四边 0.59、printBackground: true、displayHeaderFooter: false），另加
   `generateDocumentOutline: true` → 返回 JSON `{"data": "<base64>"}`。
2. CDP 返回值**不再直接落盘**：base64 交回前端（Tauri command 返回 String），供第二阶段
   解析大纲树。保留一个「只落盘不回传」的快路径参数（第一阶段先用快路径，第二阶段启用回传）。
3. 自动回退：CDP 任意环节失败（运行时过旧不支持 headed printToPDF、调用报错、超时 180s）
   → 原样走现有 `ICoreWebView2_7::PrintToPdf` 路径。老运行时行为 = 现状，不新增失败面。
4. 白底逻辑保留：DefaultBackgroundColor 置白/恢复对两条路径都执行。
5. 可测性：CDP 参数 JSON 拼装抽成纯函数（`build_cdp_print_params`），`#[test]` 断言
   `generateDocumentOutline: true` 与尺寸/边距同值（仓库「静态回归断言」风格）。

### 第二阶段：纸面目录页（B）

1. **两遍打印**：第 1 遍打印时 TOC 页已插入（页码用固定宽占位符 `000`，几何与终稿一致，
   保证两遍分页相同）；第 1 遍 `outlineOnly: true`（CDP 打印**不落盘**，内存字节直接解析）
   → Rust 解析其 Outlines 树得「标题→页码」数组 → 前端填真实页码（点线引导，行不回排）
   → 第 2 遍打印落盘。
2. **大纲树解析**：Rust 侧用 lopdf（纯 Rust，无系统依赖）解析内存字节：
   trailer → Root → /Outlines 链，每项 /Dest 数组首元素为页对象引用 → 页序号。
   任一环节失败返回 None（前端降级为无页码目录，条目仍可点击），绝不导出失败。
3. **TOC 页内容**：复用 `outline.js` 的标题树数据；**收录深度做成设置项**
   （设置面板下拉，可选 h1–h3 / h1–h4 / h1–h5 / h1–h6，**默认 h1–h6**——用户明确要求
   深目录，Word/Typora 同款 h1–h3 作为可选项保留）；行内公式直接 KaTeX 渲染（与大纲
   面板同款，`5ed6273`）；条目可点击（预览标题锚点已存在，Chromium 打印会把内部锚点转成
   PDF 跳转链接——真机验证，不成立则目录页仅视觉展示）。TOC 标题「目录」用 div 样式
   实现，不进书签。
4. **回退降级**：CDP 不可用（老运行时）→ 整体回退现有原生路径 = 现状（无书签、无目录页、
   无页码），不出半成品。
5. 导出时间约翻倍（长文档两遍全量打印），接受；导出遮罩文案区分两阶段进度。

## 已知限制（接受）

- 老运行时（不支持 headed CDP printToPDF）无书签无目录页，自动回退现状。
- **书签文字**里含行内公式的标题是 KaTeX 双层 DOM 提取出的杂乱文本（PDF 书签天生纯文本，
  任何工具都装不下渲染公式）；**纸面目录页不受影响**（我们自己渲染 KaTeX）——这正是 A+B
  合并的价值。
- Chromium 有已知的书签文案错乱 bug（issues.chromium.org/383706655），出现时为个别文案
  问题，不影响跳转。

## 目标 / 非目标

- 目标：2026 年主流 WebView2 运行时（Chromium 120+）导出的 PDF 带可跳转书签 + 纸面目录页。
- 非目标：页脚页码（displayHeaderFooter，后续可加）；非 Windows 平台（现 `print_to_pdf`
  非 Windows 分支本就报错回退，不变）。
- 需求修订（2026-11-17 用户确认）：TOC 收录深度不固定 h1–h3，做成设置项且默认 h1–h6。

## 实施与验收

- 同分支 `feat/pdf-toc-bookmarks` 两段提交：A 先落地真机验证（CDP 可用性 + 顺便确认公式
  书签文字实际观感），B 跟上；提 PR 前按惯例先 `npm run dev` 由用户验收。
- 真机验收：导出 D:\UGit\MOT 笔记（多级标题 + 大量行内公式），Edge 侧边栏出现层级书签且
  点击跳转正确；纸面目录页页码与实际页面一致、公式渲染正常、点击目录条目跳转正确；
  另验证回退路径（可用旧版运行时或人为让 CDP 失败）导出与现状一致。
