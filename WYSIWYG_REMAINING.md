# TizuMark 所见即所得（WYSIWYG）模式 — 剩余开发任务

> 用途：本文件记录「所见即所得」模式的**剩余未开发项**，供换设备后继续开发时对照。
> 状态时间：2026-10-08。已完成的根因修复见 `git log` 与本仓库 `.workbuddy/memory/`。

## 1. 这是什么

TizuMark 是 Tauri v2 桌面 Markdown 编辑器，有三种视图：**阅读（preview）/ 源码（source+CM5）/ 所见即所得（wysiwyg）**。
所见即所得 = 在 CM5 编辑区里，把每个 Markdown **块**用渲染后的 HTML 盖住（markText + replacedWith），光标所在块恢复成可编辑的源码态。用户看到的是渲染效果，点哪一行就在哪一行编辑源码。

## 2. 关键文件（改这里）

| 文件 | 职责 |
|---|---|
| `src/modules/wysiwyg.js` | 核心遮罩模块：块划分、maskWysiwygBlock、点击锚定、滚动锚定、后处理 |
| `src/modules/empty-hint.js` | 空行占位提示（"输入 / 可插入内容…"） |
| `src/unified-renderer.js` | `renderMarkdownBlocks` 逐块渲染（与阅读模式同源，remark 切块） |
| `src/controllers/preview-controller.js:206-222` | 阅读模式的后处理链：processEmoji/Math/Abbre/Headings/Mermaid/Images + CodeBlock |
| `src/modules/preview-post.js` | Process* 系列预览后处理函数（被 wysiwyg 复用的就是这些） |
| `src/modules/code-block.js` | 代码高亮 + 行号 + 复制按钮 |
| `scripts/wysiwyg-browser-check.mjs` + `_wysiwyg_compare.html` | 无头浏览器对比测试（真 Chromium，7 场景 45 项） |
| `test/wysiwyg-blocks.test.cjs` / `test/view-mode-wysiwyg.test.cjs` | jsdom 回归 |

## 3. 已完成的里程碑

- 渲染与阅读模式一致：remark 切块、white-space:normal、空列表项消除
- 遮罩后处理已接 **KaTeX 公式 + 代码高亮 + 复选框解禁**（见 `_postProcessWysiwygNode`）
- 点击锚定根治：偏差 1637px → 0.5px（scroll:false + operation 后执行 + scrollIntoView）
- 虚拟模式滚动锚定：漂移 395px → 0.38px
- 表格单元格点击定位、任务复选框渲染态切换、IME 防吞字

### 2026-10-08 —「与阅读模式完全一致」专项（R1/R2/R3/R4 全部完成）

- **R1 图片**：`_wysiwygPostProcessAsync` 调 `ImageProcessor.processImages`（与阅读模式同一纯函数 + 同一 `_imageBase64Cache`），`getRenderGeneration` 用 `_wysiwygMaskGen` 防止遮罩重建后旧请求写脏 DOM。
- **R2 Mermaid**：`_wysiwygPostProcessAsync` 调 `PreviewPost.processMermaid`（同一 `_mermaidCache`，命中缓存近乎同步）；就绪后经 `_wysiwygRefreshAfterMaskChange` 刷新 CM 并做滚动补偿，SVG 撑高不冲走视口。
- **R3 后处理链**：`_postProcessWysiwygNode` 与阅读模式 `render()` 同序补跑 复选框解禁 → details 展开 → emoji → KaTeX → 缩写 → 标题锚点 id → 复制按钮 → 代码高亮（行号开关读 `#preview` 的 `code-line-numbers` 类）。`[TOC]` 由 `_wysiwygReplaceToc` 调 Rust `generate_toc`（内容键控缓存）。
- **R4 复制按钮**：遮罩 mousedown 对 `button.copy-btn` 放行（不 preventDefault），点击走原生复制。
- **行号**：`applyWysiwygEditorChrome` 进入所见即所得强制 `lineNumbers:false`，离开按设置恢复；`settings.js` 的 applySettings 也走该入口，设置变更不会把行号改回来。
- **排版一致**：`_wysiwygMaskTypography` 把 `#preview` 的**计算值**（font-size/line-height/font-family/`--font-code-preview`）逐项内联到遮罩，并同步 `code-line-numbers/code-wrap/code-no-scroll` 类——阅读模式的字号行高是内联样式（16px/1.7），遮罩若只靠 CSS 会继承 CM 的 14px。
- **CSS 一致**：遮罩去掉灰底（`color-mix` → `transparent`）；wysiwyg 模式下 CM 每行加 32px 左右留白，与阅读模式 `#preview` 的 32px padding 对齐；`maxWidth` 设置生效时对 `.CodeMirror-lines` 做同款居中。
- **交互一致**：`misc-ui.js` 抽出 `handlePreviewLinkClick(link)`（预览点击监听器与遮罩共用）；wysiwyg 下 `#锚点` 走 `_wysiwygScrollToAnchor`（块偏移 + data-source-line 还原绝对行号，虚拟模式回退按 headingToId 扫源码），目标行滚到视口中部 + 闪显；遮罩内图片/mermaid 点击分别走 `showImageLightbox`/`showLightbox(svg)`。
- 已知差异（保留）：脚注/缩写**定义行跨块**时逐块渲染拿不到别块定义（unified-renderer `renderMarkdownBlocks` 注释记录的边界）；缩写定义单独成块时整块被遮罩为不可见（与阅读模式一致），定义与使用同块时缩写正常还原。

### 2026-10-09 — 快速滚动闪源码 / 落点漂移（全量预渲染 + 全量视图驻留）

- **根因**：CM5 只对视口内行实测高度，视口外行按源文估计（`estimateHeight`）——WYSIWYG 遮罩行远高于源文，远跳首落点偏（实测 -425px）；且 lineWrapping 编辑器的 `cm.refresh()` 会调 `estimateLineHeights` 把所有实测高度重置回估计值。
- **设计（≤10000 行，全量模式）**：
  - 入口 = **后台全量预渲染**：`setViewMode('wysiwyg')` 被 theme.js 拦截，当前视图保持、模式按钮显示「渲染中」spinner（`_setWysiwygButtonRendering`，i18n key `viewModeWysiwygRendering`）；让出主线程的 setTimeout 跑 `precomputeWysiwygBlocksFull()`（`maxBlocks:Infinity` 全块渲染 html），完成且期间源文/标签/模式未变才切 viewMode + applyViewMode；预渲染结果在 applyViewMode **之后**写入（其内部 clearWysiwygMasks 会清掉未消费结果），由 50ms 遮罩计时器 `renderWysiwygMasks` 消费。
  - **全量视图驻留**：进入后直接写 `cm.options.viewportMargin = lineCount + 100`（**绕过 setOption**——viewportMargin 选项处理器自带 `cm.refresh()`，会多一次全量重渲染），整篇恒渲染、行高恒实测：任意位置远跳精确落位（≤0.5px），任何 `refresh()`（切模式/输入）在同一次全量视图重渲中重测回正——几何自愈。离开所见即所得用 `setOption('viewportMargin', 10)` 恢复默认。
  - **输入停顿** = `_refreshWysiwygFullIncremental`（250ms 防抖）：仅解析模式重切块边界（渲染器新增 `skipHtml` 选项），源文未变的块**复用旧 markText 标记**（CM 标记编辑后自动跟随文本，省去重跑昂贵后处理），变化/新增/分裂/合并块单 operation 重挂；块索引位移同步遮罩节点 `data-block-index`。
  - 批量 DOM（全量挂/撤遮罩、空行挂类、离开清理）一律单 `cm.operation`——万行文档进出不卡数秒。
  - 取消路径：切别的模式 / 切标签（`syncViewModeToTab`）/ 打开文件（clearWysiwygMasks）都调 `_cancelWysiwygPreRender`（代数递增 + 清定时器 + 按钮还原 + 作废已存的切换锚点）。
- **设计（>10000 行，虚拟模式）**：方向感知增强预取（`WYSIWYG_PREFETCH_MARGIN=200`，向下滚动下方 ×2 / 向上滚动上方 ×2，尾随侧保持 60），用户到达前遮罩已就绪。
- **验收实测**（无头 Chromium，8 场景 48 项全绿，2026-10-09 同日三个修复后）：3000 行全量重建 ~0.7–2.4s（机器负载相关）、任意位置首跳误差 ≤0.3px、`cm.refresh()` 后 0.41px 自愈；10400 行虚拟模式窗口遮罩 24–27 个；点击锚定 0.41px；滚动锚定漂移 0px；点击落点（场景 8）中部点击落中部带、底边点击落块末两行。
- **回归守卫**：`test/view-mode-wysiwyg.test.cjs` 新增第 14 节 9 用例（上限常量 / cm.options 直写 / setViewMode 拦截与取消 / 预渲染消费时序 / 增量刷新与源文本键 / 方向预取 / 单 operation 批量 / spinner + 三语言 i18n）；`test/view-mode.test.cjs` 三模式循环测试更新为异步预渲染契约（toggle 后预渲染在飞 → 完成后才切模式）。

**2026-10-09 真机反馈三个修复（同日）**：

1. **增量刷新重复源文本崩溃**：`_refreshWysiwygFullIncremental` 以块源文本做同一性匹配，两个块源文本相同（重复段落/列表行）且其一被删/改写时，同源队列提前取空 → `shift()` 得 `undefined` 当新索引 → `Cannot set properties of undefined (setting 'html')`（用户编辑重复行密集的 RELEASE_NOTES.md 即崩）。修复：取空前判队列空 + `!nb` 双守卫，取不到的旧遮罩降级为撤掉重挂。回归用例：`view-mode.test.cjs`「同一源文本的重复块被删时 srcQueue 取空降级不崩」。
2. **每次点击往下滚一段**：点击锚定 `_applyWysiwygClickAnchor` 旧实现 `scrollIntoView(pos, margin=click.y)`——`click.y` 是**窗口坐标**而 `scrollIntoView` 的 margin 相对**编辑器视口顶**，真机编辑器上方有工具栏+标签栏（约 100px+），基准错位使目标行恒落在点击点下方「一个工具栏高」处；且 margin 带内的行完全不补偿。harness 里编辑器贴窗口顶、基准巧合重合，所以历次 0.41px 校准都测不出。修复：改「事后测量 + 差值补偿」（与 `_restoreWysiwygAnchor` 光标锚点同机制）——点击位置先减 `wrapper.getBoundingClientRect().top` 换算为视口内坐标，行顶用 `charCoords(pos,'window').top - wrapTop` 测（⚠️ 不能用 'local'——CM5 的 'local' 是文档内容空间 `heightAtLine+padding`，不是视口相对坐标），`cm.scrollTo(info.left, info.top + delta)` 精确放回点击处（结构级变化守卫：|delta| > vh 放弃）。场景 3 现下移编辑器 140px 模拟真机工具栏（旧实现此条件下量出 ≈140px 偏差，修复后 0.91px），回归可测。
3. **点击成块内容光标落错行（「经常出现新增一行」）**：用户截图所见即所得下列表遮罩 + 下方空行出现「输入 / 可插入内容…」提示。排查结论（无头 Chromium 真实鼠标审计，`_wysiwyg_compare.html` `__clickLandingSetup` + 驱动场景 8）：
   - **根因（主）**：CM5 会把落在 `replacedWith` 标记区间**内部**的 `setSelection` 位置**钳制到标记首/末端**（实测：9 行列表块 [4,12]，setSelection(7) 光标到 12、setSelection(11) 也到 12、setSelection(6,ch0) 到 4）。原实现先 `setSelection(点击比例行)` 再靠 setSelection 操作内的 cursorActivity 撤遮罩——位置被钳制时标记还在，光标恒落到块首/块尾行；用户点不准反复点，点进块与块之间 12px 压缩空行，光标落空行 → 空行提示（纯 CSS 显示，不插入内容）显现，观感即「新增一行」。
   - **修复**：mousedown 两个分支（表格/普通比例映射）落光标前先 `setWysiwygActiveBlock(wysiwygBlockIndexAt(目标行))` 撤掉目标块标记——目标行先成为真实源码行再落光标，CM5 无从钳制。活动块索引按**目标行**查（增量刷新后闭包 idx 可能已位移）。实测：块中部点击 line 7/8（中部带内，修复前恒 12/4）、底边点击 line 11（块末两行内）。
   - **空行提示本身**：点空行光标落空行 + 显示提示是编辑器标准行为（提示纯显示、不插行），不修改；主修复后点击落准、误点空行概率大降。
   - **回归**：驱动新增**场景 8 点击落点**（真实 `page.mouse.click` 命中测试，每次点击前全新编辑器防污染）：块中部点击落中部带 [start+⌊n/3⌋, end-1-⌊n/3⌋]、点击块已撤遮罩成活动块、底边点击落块末两行。守护：`view-mode-wysiwyg.test.cjs`「点击遮罩块须先撤遮罩再落光标」。

## 4. 剩余任务清单（按优先级）

### P0 — 核心渲染缺口

（R1–R4 已于 2026-10-08 完成，见 §3。）

### P1 — 交互完善

**R5. 表格单元格渲染态内联编辑**
- 现状：点击表格某格只把光标定位到对应**源码行**（`maskWysiwygBlock` 内 `td,th` 分支），用户仍在源码态改。
- 目标：在渲染表格里直接编辑单元格，失焦回写源码行。
- 文件：`src/modules/wysiwyg.js` 表格分支（约 307-325 行）。
- 方案：给表格块内 `td/th` 设 `contenteditable=true`，维护单元格↔源码行的映射，失焦/blur 时把单元格文本写回对应源码行（保留 `|` 分隔与对齐）；单元格增删需重排整行/整列的源码。
- 坑：表格边框对齐（`:---:` 等）在编辑时要保留；跨单元格 Tab 导航。

**R6. 格式/插入工具栏按钮在 wysiwyg 下的源码式对接**
- 现状：工具栏加粗/斜体/标题/列表/插入链接等按钮，在源码态（活动块）应天然可用（CM 文本即源码）；但光标落在**遮罩态块**时文本不可直接编辑，按钮需先定位目标块再对源码操作。
- 目标：按钮在 wysiwyg 下行为正确——要么先让光标进入对应块（撤遮罩），要么直接对块切片文本做 markdown 包裹。
- 文件：对应工具栏按钮处理（见 `src/modules/toolbar*.js` / `src/index.html` 的按钮 id）。
- 验证：目前多数按钮在源码模式已实现，重点测 wysiwyg 下光标在遮罩块时的表现（可能报错或无效）。

**R7. 空行提示 i18n 翻译补全**
- 现状：`emptyLineHint` 文案 key 已用，需确认各语言（en/zh）翻译齐全且切语言时刷新 CSS 变量。
- 文件：`src/modules/i18n.js` 的 `emptyLineHint` key；`empty-hint.js:42` 读 `this.t(HINT_KEY)`。

### P2 — 健壮性 / 边界

**R8. 超大文档（~18k 行）虚拟遮罩边界**
- 现状：行数 > `WYSIWYG_FULL_RENDER_MAX_LINES`（10000）进入虚拟模式（块 html 被 skipped，滚动时按视口渲染）；2026-10-09 起虚拟模式已有方向感知增强预取（快速滚动零闪现）。
- 验证：极端行数下滚动锚定补偿是否仍 0.38px 量级、滚动不卡。
- 入口：`src/modules/wysiwyg.js` 顶部常量 + `updateWysiwygViewportMasks` + `_ensureWysiwygScrollHook`（120ms debounce）。

**R9. 多标签/文件切换时的状态清理**
- 现状：`_wysiwygMarks` / `_wysiwygVirtual` / `_wysiwygActiveIdx` 等挂在实例上。
- 目标：切 tab / 打开新文件时这些状态正确重置，`clearWysiwygMasks` 已清理 marks，但虚拟标志/缓存需确认。
- 入口：`renderWysiwygMasks` 开头 `clearWysiwygMasks`；tab 切换处调用时机。

**R10. 进入/退出 wysiwyg 保持滚动位置**
- 现状：渲染态块与原源码块高度不同，切换模式滚动位置会跳。
- 目标：切换前后用滚动锚定（同 §3 已有方案）保持视口内容不动。
- 入口：`setViewMode` / `applyViewMode`（src/modules/theme.js）。

**R11. undo 栈在遮罩重建下不打断**
- 现状：输入防抖是 250ms 后 `refreshWysiwygBlocks`（全量重算块表 + 重挂遮罩），可能打断 CM 原生 undo 栈。
- 验证：wysiwyg 下连续编辑 + Ctrl+Z 是否逐字符回退；若被打断需让重算仅动 marks 不动 doc。

## 5. 改 wysiwyg 前必读的关键约束（踩过的坑）

1. **遮罩用 markText + replacedWith，不能用 addLineWidget**——后者不隐藏源码行，渲染与源码重复显示。
2. 遮罩节点**必须带 `preview-content` 类**，否则标题/表格/列表无样式（排版 CSS 作用域是 `.preview-content xxx`）。
3. 遮罩节点**不能设 pointer-events:none**——点击穿透到空白，CM 坐标映射拿不到有效位置，块点不进去。改为遮罩自己 mousedown 接管。
4. **CM5 滚动三坑**（锚定/补偿都用过，详见 `.workbuddy/memory/MEMORY.md`「编辑器行为」）：
   - `setSelection` 默认 `ensureCursorVisible` 会抢先滚动 → 必须 `{scroll:false}`；
   - cursorActivity 在 setSelection 的 operation 内触发，此时滚动被 CM 记 pending 冲掉 → 精确锚定必须在 setSelection 返回后做；
   - `scrollTo` 在 refresh 后 DOM 高度未落定时被 clamp → 用 `scrollIntoView`（margin 语义=行精确落在距视口顶 margin 处）。
5. **`renderMarkdown` 只产结构 HTML**：KaTeX/highlight/图片/mermaid/emoji/缩写等都是预览端独立 pass，遮罩里不补跑就露源码。现已全接：同步 pass 在 `_postProcessWysiwygNode`（与阅读模式 `render()` 同序），异步 pass（图片/Mermaid/TOC/代码滚动条）在 `_wysiwygPostProcessAsync`，用 `_wysiwygMaskGen` 代数防旧请求写脏重建后的 DOM。
6. **`data-source-line` 是块切片内相对行号**，不是整篇行号——回写源码须加 `block.start`（复选框回写已处理，其他回写逻辑要照做）。
7. 遮罩后处理 `b.html` 缓存的是未后处理结构 HTML，每次挂遮罩都要重跑后处理（两个 pass 幂等，可重复）。
8. **`cm.setOption('viewportMargin', n)` 的选项处理器自带 `cm.refresh()`**（codemirror.js 同步触发）——扩视口必须直接写 `cm.options.viewportMargin`，否则多一次全量重渲染（万行文档 ~1.8s）。
9. **headless fullPage 截图伪影**：Playwright fullPage（captureBeyondViewport）不绘制原视口（默认 720px）以下 overflow 容器的内容，截图会「下半片空白」但 DOM 正常——整页截图先 `setViewportSize` 到整页高度再普通截图（驱动场景 5 已处理）。
10. **全量模式增量刷新靠块源文本同一性**：`b.src`（块切片源码 join）是 diff 键——凡是从新源码重渲染了块 html 的地方（`setWysiwygActiveBlock` 旧块回遮罩、任务复选框切换）必须同步 `b.src = this._wysiwygBlockSource(b)`，否则下次增量刷新误判「源未变」保留过期遮罩。

## 6. 本地验证命令

```bash
# 无头浏览器对比（真实 CM5 + 真实渲染管线；playwright 按 PLAYWRIGHT_MODULE 环境变量
# → 本地依赖 → 用户全局 npm 目录 依次解析，浏览器可执行文件自动扫 %LOCALAPPDATA%\ms-playwright 缓存）
node scripts/wysiwyg-browser-check.mjs
# 结果：7 场景 45 项全绿（渲染同构、空行提示、点击锚定 0.4px、表格定位、复选框、
#       KaTeX/高亮/emoji/缩写/标题锚点/复制按钮/details 对齐、行号隐藏、
#       字号/行高/字体族/边距/底色与阅读模式一致、>10000 行虚拟遮罩、IME 守卫、
#       滚动锚定 0px、场景 6 全量模式 3000 行快速滚动首跳 ≤0.3px + refresh 自愈、
#       场景 7 按钮点击后台预渲染时序、场景 5 输出 demo.md 整篇双栏截图）

# jsdom 单测
node --test test/wysiwyg-blocks.test.cjs test/view-mode-wysiwyg.test.cjs
```

## 7. 真机验收清单（每改一项逐项看）

- [ ] 所见即所得左侧**无行号**（切回源码模式行号按设置恢复）
- [ ] 遮罩正文**字号/行高/字体与阅读模式一致**（无「一大一小」跳变）
- [ ] 遮罩**无灰色块底**，左右留白与阅读模式一致
- [ ] 打开含数学公式的 md，遮罩块内公式已渲染（非 `$$...$$` 源码）
- [ ] 代码块已语法高亮，复制按钮可点
- [ ] 图片正常显示（本地相对路径）
- [ ] Mermaid 图表渲染为 SVG，点击可放大
- [ ] 点击渲染块内链接/锚点，跳到对应源码行（无大跳动）
- [ ] 点击渲染块，光标行停在点击位置附近（无大跳动）
- [ ] 滚动长文档，视口内容不漂移
- [ ] 任务复选框可点击切换
- [ ] 中英文输入不吞字

## 8. 推送与远程同步约定（2026-10-07 起）

- **只推 gitee（origin）**：`git push origin master`。本机 `origin` 已切到 SSH（`git@gitee.com:tizu/TizuMark-Markdown-Editor.git`），因本机无 gitee HTTPS 凭据。
- gitee 已配置到 github 的**镜像自动同步**：推 gitee 后由 gitee 自动同步到 `git@github.com:tizuio/TizuMark-Markdown-Editor.git`，**不再手动推 github**。
- 切换电脑后：任选 gitee / github 一端 clone 即可，两者内容一致。
- 分叉根因备忘：本地曾因「重建 git 基线」产生孤儿根提交 `20bec86` 并误带 `.git-broken-20261006` junk；已用 commit-tree 在 github master(64964fd) 上重建 C1/C2/C3 干净线性历史并快进推送，junk 已剔除。
