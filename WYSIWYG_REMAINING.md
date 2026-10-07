# TizuMark 所见即所得（WYSIWYG）模式 — 剩余开发任务

> 用途：本文件记录「所见即所得」模式的**剩余未开发项**，供换设备后继续开发时对照。
> 状态时间：2026-10-07。已完成的根因修复见 `git log` 与本仓库 `.workbuddy/memory/2026-10-07.md`。

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
| `scripts/wysiwyg-browser-check.mjs` + `_wysiwyg_compare.html` | 无头浏览器对比测试（真 Chromium，4 场景 22 项） |
| `test/wysiwyg-blocks.test.cjs` / `test/view-mode-wysiwyg.test.cjs` | jsdom 回归 |

## 3. 已完成的里程碑（本轮已提交，非本文件范围）

- 渲染与阅读模式一致：remark 切块、white-space:normal、空列表项消除
- 遮罩后处理已接 **KaTeX 公式 + 代码高亮 + 复选框解禁**（见 `_postProcessWysiwygNode`）
- 点击锚定根治：偏差 1637px → 0.5px（scroll:false + operation 后执行 + scrollIntoView）
- 虚拟模式滚动锚定：漂移 395px → 0.38px
- 表格单元格点击定位、任务复选框渲染态切换、IME 防吞字

## 4. 剩余任务清单（按优先级）

### P0 — 核心渲染缺口（用户能直接感知"不一样"）

**R1. 图片在遮罩里不显示**
- 现状：`renderMarkdown` 产 `<img src="相对路径">`，但本地图片需 `processImages()` 解析资源/转 base64 才显示。wysiwyg 的 `_postProcessWysiwygNode` 没调它。
- 目标：遮罩块内图片与阅读模式一致显示。
- 入口：`src/controllers/preview-controller.js:196` `await this.app.processImages()`；在 `_postProcessWysiwygNode` 里对 `node` 补跑（注意它是异步 + 依赖 `this.app` 的资源解析，需注入 app 或把图片解析抽成纯函数）。
- 风险：图片是异步加载，遮罩树频繁重建下要避免重复加载/闪烁。

**R2. Mermaid 图表在遮罩里显示源码**
- 现状：`processMermaid` 是异步 pass，遮罩没接（见 §2 已完成项只接了 math/code）。
- 入口：`src/modules/preview-post.js:295` `processMermaid(preview, opts)`，`opts.mermaidCache` 来自 `app._mermaidCache`。
- 方案：`maskWysiwygBlock` 渲染后 `await PreviewPost.processMermaid(node, postOpts)`；但 maskWysiwygBlock 当前同步，需改成允许异步（挂遮罩时先放源码块、mermaid 就绪后替换内部 SVG），或用消息队列。
- 坑：mermaid 实例需在浏览器初始化；遮罩重建时复用 `mermaidCache` 避免重算。

**R3. 其他预览后处理 pass 在遮罩里缺失**
- 现状：`_postProcessWysiwygNode` 只调了 `processMath` + `processCodeBlocks` + 解禁复选框。
- 缺失：`processEmojiShortcodes`、`processAbbreviations`、`processHeadings`（标题锚点跳转）、`processFootnotes`、任务复选框外的 `input` 交互。
- 目标：遮罩块与阅读模式在 emoji/缩写/脚注/标题锚点上表现一致。
- 入口：全在 `preview-controller.js:206-222`，逐个补进 `_postProcessWysiwygNode` 即可（除 processMermaid 异步外都是同步）。

### P1 — 交互完善

**R4. 代码块复制按钮在遮罩内失效**
- 现状：`addCopyButtons` 在 `preview-controller.js:213` 调用，遮罩没跑。
- 入口：`PreviewPost.addCopyButtons(node, postOpts)` 加到 `_postProcessWysiwygNode`（在 processCodeBlocks 之后）。
- 注意：复制按钮依赖 `navigator.clipboard`，桌面 WebView2 可用；按钮的 mousedown 不要被遮罩接管逻辑吞掉（见 §5 的 pointer-events 说明）。

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
- 现状：`WYSIWYG_MAX_BLOCKS = 80`，超阈值进入虚拟模式（块 html 被 skipped，滚动时按视口渲染）。
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
5. **`renderMarkdown` 只产结构 HTML**：KaTeX/highlight/图片/mermaid 都是预览端独立 pass，遮罩里不补跑就露源码。已接 math/code，R1/R2/R3 补齐其余。
6. **`data-source-line` 是块切片内相对行号**，不是整篇行号——回写源码须加 `block.start`（复选框回写已处理，其他回写逻辑要照做）。
7. 遮罩后处理 `b.html` 缓存的是未后处理结构 HTML，每次挂遮罩都要重跑后处理（两个 pass 幂等，可重复）。

## 6. 本地验证命令

```bash
# 无头浏览器对比（需装全局 playwright + chromium；真实 CM5 + 真实渲染管线）
node scripts/wysiwyg-browser-check.mjs
# 结果：4 场景 22 项全绿（渲染同构、空行提示、点击锚定 0.5px、表格定位、复选框、
#       KaTeX/高亮对齐、虚拟遮罩、IME 守卫、滚动锚定 0.38px）

# jsdom 单测
node --test test/wysiwyg-blocks.test.cjs test/view-mode-wysiwyg.test.cjs
```

## 7. 真机验收清单（每改一项逐项看）

- [ ] 打开含数学公式的 md，遮罩块内公式已渲染（非 `$$...$$` 源码）
- [ ] 代码块已语法高亮，有复制按钮
- [ ] 图片正常显示
- [ ] 点击渲染块，光标行停在点击位置附近（无大跳动）
- [ ] 滚动长文档，视口内容不漂移
- [ ] 任务复选框可点击切换
- [ ] 中英文输入不吞字

## 8. 推送与远程同步约定（2026-10-07 起）

- **只推 gitee（origin）**：`git push origin master`。本机 `origin` 已切到 SSH（`git@gitee.com:tizu/TizuMark-Markdown-Editor.git`），因本机无 gitee HTTPS 凭据。
- gitee 已配置到 github 的**镜像自动同步**：推 gitee 后由 gitee 自动同步到 `git@github.com:tizuio/TizuMark-Markdown-Editor.git`，**不再手动推 github**。
- 切换电脑后：任选 gitee / github 一端 clone 即可，两者内容一致。
- 分叉根因备忘：本地曾因「重建 git 基线」产生孤儿根提交 `20bec86` 并误带 `.git-broken-20261006` junk；已用 commit-tree 在 github master(64964fd) 上重建 C1/C2/C3 干净线性历史并快进推送，junk 已剔除。
