# PDF 导出目录（书签大纲 + 纸面目录页）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导出的 PDF 自带可跳转书签大纲（CDP `generateDocumentOutline`）+ 文档开头纸面目录页（h1–h6 深度可设置、页码准确、条目可点击跳转），CDP 不可用时整体回退现状。

**Architecture:** 全部改动围绕现有 `print_to_pdf` 命令（Rust）与 `exportPDF`（前端 export.js）。Rust 内先试 CDP `Page.printToPDF`（内存字节 → lopdf 解析大纲页码 → 落盘），失败自动回退现有 `ICoreWebView2_7::PrintToPdf`。前端两遍打印：第 1 遍 `outlineOnly` 拿页码数组填目录占位，第 2 遍落盘终稿。

**Tech Stack:** Rust（webview2-com 0.38 COM 直调、lopdf 新增、base64 0.22 已有）、前端 vanilla 模块（export.js / settings.js / i18n-data.js）、node:test + jsdom。

**Spec:** `docs/superpowers/specs/2026-11-17-pdf-outline-design.md`（本计划从 spec 出发，两者一起读）

## Global Constraints

- 仅改 Windows 分支的 `print_to_pdf`（`src-tauri/src/lib.rs:1550` 起）；非 Windows 分支维持 `Err` 回退不变
- 命令名 `print_to_pdf` 不可改（`src/modules/tauri-api.js:19` COMMANDS 唯一真源 + 契约测试反解析校验）
- `PdfPrintOptions` 新增 `outline_only: Option<bool>`（serde 默认缺省 false），旧调用方零破坏
- 不得新增 window 全局（`scripts/check-globals.cjs` KNOWN_GLOBALS 白名单护栏）；TOC 纯函数放 export.js 内
- 新增 Rust 依赖仅 `lopdf = "0.35"`（纯 Rust）；base64 0.22 / serde_json 1.0 已在依赖里
- 打印样式（printStyle.textContent）**追加在末尾**，不改动既有规则体（`test/export-codeblock-wrap` / `export-parity` 对规则体有字符窗口断言）
- 提交信息中文 conventional 风格：`feat(导出): …` / `test(导出): …`；工作分支 `feat/pdf-toc-bookmarks`（基于 master = upstream 4984cc9），PR 提 tizuio 上游
- 白纸语义 / 亮色强制 / DefaultBackgroundColor 置白等既有逻辑两条路径共用，不得回退

## Review Focus

最可能咬人的五类输入（每条已钉进对应任务的测试步骤）：

1. **CDP 不可用（老运行时）**：目录页已插入 DOM，必须移除后走原生单遍，文件照常落盘 → Task 7 jsdom 用例 `viaCdp:false 回退`。
2. **无标题文档（0 条目）**：不得插入空目录页，直接单遍打印 → Task 7 jsdom 用例 `无标题跳过目录`。
3. **outline_pages 与 DOM 标题数不一致**（Chromium 跳过个别标题）：缺页条目页码留空，其余正常，不得串页 → Task 6 jsdom 用例 `页数不足留空`。
4. **双遍流程中断**（导出中 activeTab 被清）：print-root / printStyle / overlay 必须由既有 finally 全部清理，不得残留 → Task 7 jsdom 用例 `导出中清标签`。
5. **书签文案含 KaTeX 杂乱文本**（数学标题）：纸面目录页标签必须干净（KaTeX 渲染），书签文案允许杂乱 → Task 6 断言 label 用 extractHeadings 干净文本 + 真机验收项。

---

### Task 1: Rust — CDP 打印参数纯函数

**Files:**
- Modify: `src-tauri/src/lib.rs`（`PdfPrintOptions` 结构体 + 新增纯函数，放 `print_to_pdf` 命令定义之前）
- Test: `src-tauri/src/lib.rs` 末尾 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `fn build_cdp_print_params(opts: &PdfPrintOptions) -> String`（CDP `Page.printToPDF` 的 JSON 参数，字段 camelCase）

- [ ] **Step 1: 写失败测试**（tests mod 内新增）

```rust
#[test]
fn test_build_cdp_print_params_outline_and_layout() {
    let opts = PdfPrintOptions {
        path: "C:/tmp/a.pdf".into(),
        page_width: 8.27, page_height: 11.69,
        margin_top: 0.59, margin_bottom: 0.59, margin_left: 0.59, margin_right: 0.59,
        outline_only: None,
    };
    let v: serde_json::Value = serde_json::from_str(&build_cdp_print_params(&opts)).unwrap();
    assert_eq!(v["generateDocumentOutline"], true);
    assert_eq!(v["printBackground"], true);
    assert_eq!(v["displayHeaderFooter"], false);
    assert_eq!(v["paperWidth"], 8.27);
    assert_eq!(v["paperHeight"], 11.69);
    assert_eq!(v["marginTop"], 0.59);
}
```

- [ ] **Step 2: 跑测试确认失败** — `cargo test test_build_cdp_print_params`（本机 cargo 需 `export PATH="$PATH:$HOME/.cargo/bin"`，见 dev-env 记录）→ 期望编译错误：函数/字段不存在
- [ ] **Step 3: 实现** — `PdfPrintOptions` 加 `#[serde(default)] outline_only: Option<bool>`；`build_cdp_print_params` 用 `serde_json::json!` 拼参数：paperWidth/paperHeight/marginTop/Bottom/Left/Right 取 opts 同名值，`printBackground: true`、`displayHeaderFooter: false`、`generateDocumentOutline: true`、`preferCSSPageSize: false`
- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令 → PASS
- [ ] **Step 5: Commit** — `feat(导出): PDF 打印参数纯函数支撑 CDP generateDocumentOutline`

### Task 2: Rust — CDP 主路径 + 原生自动回退 + 返回结构

**Files:**
- Modify: `src-tauri/src/lib.rs:1550` `print_to_pdf` 命令（Windows 分支整体重构）

**Interfaces:**
- Consumes: Task 1 `build_cdp_print_params`
- Produces: 命令返回 `Result<PdfPrintOutcome, String>`；`#[derive(serde::Serialize)] #[serde(rename_all="camelCase")] struct PdfPrintOutcome { via_cdp: bool, outline_pages: Option<Vec<u32>> }`
  - CDP 成功：`via_cdp=true`；`outline_only=true` 时**不写文件**，返回解析好的页码数组（Task 3 接入前先返回 `None`）；否则写文件后返回（页码数组可顺带返回）
  - CDP 失败且 `outline_only=true`：返回 `via_cdp=false`（不尝试原生——原生无法不落盘）
  - CDP 失败且正常打印：走现有 `ICoreWebView2_7::PrintToPdf` 代码路径（原逻辑原样保留搬移），返回 `via_cdp=false, outline_pages=None`

- [ ] **Step 1: 实现结构体** — `PdfPrintOutcome` 定义在 `PdfPrintOptions` 旁（含注释说明三态语义）
- [ ] **Step 2: 重构 Windows 命令体** — 保留 `with_webview` + mpsc channel + 180s recv_timeout 骨架；闭包内：先 `core.cast::<ICoreWebView2_3>()`，`CallDevToolsProtocolMethodCompletedHandler` 调 `Page.printToPDF`（方法名/参数 JSON 均转 UTF-16 PCWSTR），handler 收 `(hr, returnObjectAsJson)` → `hr.is_ok()` 且 JSON 解析出 `data`（base64 → `base64::engine::general_purpose::STANDARD` 解码得字节）→ CDP 成功；DefaultBackgroundColor 置白/恢复逻辑对 CDP 路径同样执行；CDP 任一环节失败（cast 失败 / 调用失败 / hr 错误 / JSON 无 data）按上方三态语义回退
- [ ] **Step 3: 编译 + 既有测试** — `cargo check` 零错误；`cargo test` 全过（Task 1 测试仍绿）；webview2-com 0.38 的 handler/接口签名以 crate 源码为准（`%USERPROFILE%\.cargo\registry\src\*\webview2-com-0.38.*\src\`），编译报错先对源码校准
- [ ] **Step 4: Commit** — `feat(导出): print_to_pdf 走 CDP generateDocumentOutline 主路径并自动回退原生 PrintToPdf`

### Task 3: Rust — lopdf 解析 PDF 大纲页码

**Files:**
- Modify: `src-tauri/Cargo.toml`（`[dependencies]` 加 `lopdf = "0.35"` 带注释）、`src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs` tests mod

**Interfaces:**
- Produces: `fn parse_pdf_outline_pages(bytes: &[u8]) -> Option<Vec<u32>>`（大纲条目目标页序号 0-based，按大纲顺序；任一环节失败 → None）

- [ ] **Step 1: 写失败测试（round-trip）** — 测试里用 lopdf 自建 3 页文档 + 3 条大纲（目标页 0 / 2 / 1，`/Dest [page_ref /XYZ 0 792 0]` 直接数组形式），`doc.save_to(&mut cursor)` 序列化后调 `parse_pdf_outline_pages` 断言 `== Some(vec![0, 2, 1])`；再断言 `parse_pdf_outline_pages(b"not a pdf") == None`
- [ ] **Step 2: 跑测试确认失败** — `cargo test parse_pdf_outline_pages` → 编译错误：函数不存在
- [ ] **Step 3: 实现** — `Document::load_mem` → trailer 取 Root → resolve `/Outlines` → 沿 `/First`→`/Next` 链遍历（上限 10000 条防环）；每项取 `/Dest` 数组（或 `/A`→`/D`）首元素 `Object::Reference((obj, gen))` → `doc.get_pages()` 建 `HashMap<ObjectId, u32>` 查页序号；任何 resolve/查找失败立即整体返回 `None`。标题解码不需要（只取页序号）
- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令 → PASS
- [ ] **Step 5: 接入 Task 2** — CDP 成功分支：字节先过 `parse_pdf_outline_pages`，`outline_pages` 从占位 `None` 换成解析结果
- [ ] **Step 6: Commit** — `feat(导出): lopdf 解析 CDP 产出 PDF 的书签大纲页码`

### Task 4: 前端 — 适配新返回结构（阶段 A 行为收口）

**Files:**
- Modify: `src/modules/export.js:1808` `exportPDF` 主路径（`await TauriApi.printToPdf(...)` 调用点）

**Interfaces:**
- Consumes: Task 2 `PdfPrintOutcome`（`{viaCdp, outlinePages}` camelCase）
- Produces: 阶段 A 收口——单遍打印、行为与现状一致（书签由 Rust 侧自动带上），后续 Task 7 在此基础上加 TOC 分支

- [ ] **Step 1: 调用点接住返回值** — `const printOutcome = await TauriApi.printToPdf({ options: {…原有参数…} });`（防御式 `printOutcome && printOutcome.viaCdp` 访问；jsdom 测试桩 resolve undefined 不得报错）；回退路径（`!capable`）不变
- [ ] **Step 2: 跑既有 PDF 测试** — `node scripts/run-tests.cjs export-pdf export-light-theme` → 全过（返回结构变化对旧断言透明）
- [ ] **Step 3: Commit** — `feat(导出): exportPDF 消费 print_to_pdf 新返回结构（阶段A书签收口）`

### Task 5: 设置项 — TOC 收录深度 pdfTocMaxLevel

**Files:**
- Modify: `src/modules/settings.js`（defaults 块 + `_syncSettingsToControls` + initSettings 的 `_selects` 区）、`src/index.html`（settings-row，配色方案行 `:1067-1070` 同款结构旁）、`src/modules/i18n-data.js`（settings 标签映射三语，`colorScheme` 键 `:191` 同区）
- Test: `test/settings.test.cjs`

**Interfaces:**
- Produces: `this.settings.pdfTocMaxLevel: number`（3|4|5|6，默认 6）；Select 实例 `this._selects.pdfTocDepth`；i18n 键 `pdfTocDepth`（设置面板标签）

- [ ] **Step 1: 写失败测试**（settings.test.cjs 追加，跟随文件内既有 withEditor 模式）— 断言：① 默认值 `pdfTocMaxLevel === 6`；② localStorage 预置 `{"pdfTocMaxLevel":4}` 加载后读到 4；③ 非法值（`"abc"`/`2`/`9`）回退默认 6（加载时 clamp：`[3,4,5,6].includes(v) ? v : 6`）
- [ ] **Step 2: 跑测试确认失败** — `node scripts/run-tests.cjs settings` → FAIL
- [ ] **Step 3: 实现** — defaults 加 `pdfTocMaxLevel: 6`（带中文注释：TOC 收录深度，默认到 h6）；加载处 clamp；`_syncSettingsToControls` 加 `this._selects.pdfTocDepth?.setValue(String(s.pdfTocMaxLevel), true)`（`:134` tabSize 同款）；initSettings 加 Select 初始化（optionsProvider 返回 `[{value:'3',label:'h1–h3'},{value:'4',label:'h1–h4'},{value:'5',label:'h1–h5'},{value:'6',label:'h1–h6'}]`，onChange `this.settings.pdfTocMaxLevel = Number(v)`）；index.html 加 settings-row（label 文案走三语映射，结构复制 `:1067` 配色方案行）；i18n-data.js 三语 `settings` 段加 `pdfTocDepth`（zh：`PDF 目录收录深度`；en：`PDF table-of-contents depth`；es：`Profundidad del índice del PDF`）
- [ ] **Step 4: 跑测试确认通过** — `node scripts/run-tests.cjs settings i18n` → PASS
- [ ] **Step 5: Commit** — `feat(设置): PDF 目录收录深度设置项（默认 h1–h6）`

### Task 6: 前端 — TOC 纯函数（条目提取 / HTML 构建 / 页码填充）

**Files:**
- Modify: `src/modules/export.js`（`exportPDF` 定义之前加三个方法；不新增全局）
- Test: Create `test/export-pdf-toc.test.cjs`（eval 法式测试：读 export.js 源码、`eval` 抽取目标方法体——`test/export-pdf-font.test.cjs` 同款模式）

**Interfaces:**
- Consumes: `Outline.extractHeadings(content, {headingToId})`（outline.js 末尾导出，纯函数）+ `this.headingToId`（layout.js:782）
- Produces:
  - `this._pdfTocEntries(maxLevel) -> [{level, text, id}]`：`Outline.extractHeadings(this.activeTab.content, {headingToId: (t)=>this.headingToId(t)})` 过滤 `level<=maxLevel` 且 `id` 非空（纯符号标题 headingToId 产空串，layout.js:668 已知坑）
  - `this._buildPdfTocHtml(entries) -> html 字符串`：外层 `.pdf-toc-page`，标题 `.pdf-toc-title`（`this.t('pdfTocTitle')`），每条 `.pdf-toc-item.pdf-toc-level-N` 内 `<a class="pdf-toc-link" href="#<id>">` 含 `.pdf-toc-label`（escapeHtml(text)）+ `.pdf-toc-leader`（点线占位 span）+ `.pdf-toc-num[data-toc-num="<id>"]`（占位 `000`），末尾 `.pdf-toc-end`
  - `this._fillPdfTocPageNumbers(tocEl, printRoot, pages) -> void`：`printRoot.querySelectorAll('h1,h2,h3,h4,h5,h6')` 文档序 zip `pages[i]`（`i<pages.length` 守卫）建 `id→页码(i+1)`；对 tocEl 内每个 `[data-toc-num]` 写 `textContent`，无页码的写 `''`

- [ ] **Step 1: 写失败测试**（export-pdf-toc.test.cjs）
  - `无标题文档`：entries `[]`
  - `深度过滤`：maxLevel=3 时 level 4-6 被滤掉
  - `占位与链接`：html 含 `href="#<id>"`、`data-toc-num="<id>"`、占位 `000`
  - `页码填充`：pages `[0, 4, 9]` + printRoot 三个对应 id 的 h1/h2/h1 → nums `1,5,10`
  - `页数不足留空`：pages `[0]` → 第二三条 num `''`，第一条 `1`
  - `label 干净`：含 `$E=mc^2$` 的标题 label 含原文（供 processMath 渲染），不含残留 `**`
- [ ] **Step 2: 跑测试确认失败** — `node scripts/run-tests.cjs export-pdf-toc` → FAIL
- [ ] **Step 3: 实现三个方法** — 按上方 Interfaces 签名；escapeHtml 用 export.js 内既有同名工具（无则内联 `replace(/&/g,'&amp;')…` 四连，与 `:1862` escapedTitle 同款）
- [ ] **Step 4: 跑测试确认通过** — `node scripts/run-tests.cjs export-pdf-toc` → PASS
- [ ] **Step 5: Commit** — `feat(导出): PDF 纸面目录页纯函数（条目/HTML/页码填充）`

### Task 7: 前端 — 两遍打印接线 + 打印样式 + 既有测试更新

**Files:**
- Modify: `src/modules/export.js`（exportPDF 主路径 + printStyle.textContent 末尾追加 TOC 样式）、`src/modules/i18n-data.js`（键 `pdfTocTitle` 三语：zh `目录` / en `Table of Contents` / es `Tabla de contenido`）
- Test: `test/export-pdf-cleanup.test.cjs`、`test/export-pdf-save-wait.test.cjs`（桩更新）、`test/export-pdf-toc.test.cjs`（接线用例追加）

**Interfaces:**
- Consumes: Task 4 outcome、Task 6 三方法、Task 5 `pdfTocMaxLevel`

- [ ] **Step 1: 写失败测试（接线）**（export-pdf-toc.test.cjs 追加，jsdom withEditor + __TAURI__ invoke 桩）
  - `两遍打印`：invoke 桩对 `print_to_pdf` 返回 `{viaCdp:true, outlinePages:[0,4,9]}` → 断言调用 2 次、第 1 次 `options.outlineOnly===true` 且第 2 次无该字段；文件路径两次相同；目录 nums 被填充
  - `viaCdp false 回退`：桩返回 `{viaCdp:false}` → 调用 2 次（第 1 次 outlineOnly、第 2 次普通），第 2 次打印前 `.pdf-toc-page` 已从 DOM 移除，`pdfExported` 成功路径走通
  - `无标题跳过目录`：content 无 `#` 标题 → 仅 1 次调用且无 `outlineOnly`
  - `导出中清标签`：invoke 桩第 2 次调用前执行清空 tabs → 流程不抛未捕获异常，finally 清理后 `#pdf-print-root` / printStyle / overlay 无残留（沿用 cleanup 测试断言风格）
- [ ] **Step 2: 跑测试确认失败** — `node scripts/run-tests.cjs export-pdf-toc export-pdf-cleanup` → 接线用例 FAIL
- [ ] **Step 3: 实现 exportPDF 接线** — print-state 建好、`_waitImagesReady` 之后：`const tocEntries = this._pdfTocEntries(this.settings.pdfTocMaxLevel || 6)`；非空则 `const tocEl = document.createElement('div'); tocEl.innerHTML = this._buildPdfTocHtml(tocEntries); printRoot.insertBefore(tocEl, printRoot.firstChild);` 随后 `RenderPost.processMath` 守卫调用（layout.js:618 同款）渲染标签公式；打印分支：
  ```js
  const dims = { pageWidth: 8.27, pageHeight: 11.69, marginTop: 0.59, marginBottom: 0.59, marginLeft: 0.59, marginRight: 0.59 };
  if (tocEl) {
    const r1 = await TauriApi.printToPdf({ options: { path: targetPath, outlineOnly: true, ...dims } });
    if (r1 && r1.viaCdp && Array.isArray(r1.outlinePages)) {
      this._fillPdfTocPageNumbers(tocEl, printRoot, r1.outlinePages);
      await TauriApi.printToPdf({ options: { path: targetPath, ...dims } });
    } else {
      tocEl.remove();          // CDP 不可用：移除目录页，回退原生单遍
      await TauriApi.printToPdf({ options: { path: targetPath, ...dims } });
    }
  } else {
    await TauriApi.printToPdf({ options: { path: targetPath, ...dims } });
  }
  ```
  finally / 报错 / toast 逻辑零改动
- [ ] **Step 4: printStyle 末尾追加 TOC 样式**（不改动既有规则体；追加在 `orphans: 3` 规则之后）：`.pdf-toc-page`（含 `#pdf-print-root` 前缀限定）、标题字号/间距、`.pdf-toc-item` 按 level 缩进（`padding-left: calc((N-1)*14px)` 直接写出 6 条）、`.pdf-toc-link{display:flex;align-items:baseline;text-decoration:none;color:inherit}`、`.pdf-toc-leader{flex:1;border-bottom:1px dotted #999;margin:0 4px;min-width:12px}`、`.pdf-toc-num{font-variant-numeric:tabular-nums}`、`.pdf-toc-end{page-break-after:always}`
- [ ] **Step 5: 跑测试确认通过** — `node scripts/run-tests.cjs export-pdf-toc export-pdf-cleanup export-pdf-save-wait export-pdf-font export-codeblock-wrap export-parity export-light-theme export-expand-all` → 全过（cleanup/save-wait 桩需按两遍调用更新：invoke 桩返回 outcome 对象、成功路径断言调用次数 2）
- [ ] **Step 6: Commit** — `feat(导出): PDF 两遍打印生成可点击纸面目录页（CDP 回退保持现状）`

### Task 8: 全量门禁 + 真机验证

**Files:** 无新改动（纯验证）；发现回归回对应任务修

- [ ] **Step 1: 前端全量** — `npm test`（173+ 文件全过，零回归）
- [ ] **Step 2: 静态护栏** — `npm run check`（check-globals / coupling-report / version / entry-scripts / tauri-api 契约全过）
- [ ] **Step 3: Rust 全量** — `export PATH="$PATH:$HOME/.cargo/bin" && cd src-tauri && cargo test && cargo check`（全过）
- [ ] **Step 4: 真机验证清单**（按记忆 verify-before-pr：先让用户本机验收）— `npm run dev` 后逐项：
  1. 导出 MOT 笔记（D:\UGit\MOT，多级标题 + 大量行内公式）→ Edge 打开 PDF：侧边栏大纲面板出现层级书签、点击跳转正确
  2. 首页为目录页：页码与实际页面一致、公式渲染正常、点击条目跳转到对应页
  3. 设置面板改深度为 h1–h3 重导 → 目录条目变浅
  4. 无标题文档导出 → 无目录页、不报错
  5. 观察书签文案中公式标题的观感（已知限制，记录给用户）
  6. 确认导出耗时（两遍打印）在可接受范围
- [ ] **Step 5: PR** — push 分支到 fork，`gh pr create` 提 tizuio upstream（docs/spec + plan 文档一并入 PR）
