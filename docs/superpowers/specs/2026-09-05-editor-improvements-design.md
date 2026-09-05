# 编辑器四项改进 设计文档

- 日期：2026-09-05
- 状态：已批准
- 目标：四项独立改进——①会话级记住 Markdown 展示模式；②自定义页面底色（编辑+预览区，按亮度自动反色）；③退出时自动关闭所有标签（干净启动）；④DOCX 导出重写为真 OOXML。

## 背景

现有实现四处的现状与痛点：

1. `syncViewModeToTab()`（app.js:10706）每次切换标签都按 `settings.defaultView` 决定 Markdown 的视图模式，用户在会话内手动切换的模式不保留，再次切回 md 又回到默认。
2. 页面底色由 5 套配色方案 + 明暗主题驱动（styles.css 的 `--bg-primary` 等变量），用户无法自定义编辑/预览区的底色。
3. 关闭应用时 `handleAppClose()` 会 `saveSession()` 保存打开的标签，下次启动自动恢复；用户希望可选「每次打开都是干净的」。
4. DOCX 导出用 `html-docx-js` 把整段 HTML 作为 Word `altChunk` 嵌入（app.js:9332），依赖 Word 自带 HTML 导入器二次渲染：标题不是真 Word 样式（导航窗格/大纲不可用）、WPS/Google Docs 兼容差、页面尺寸/边距无法设置。

## 需求（已澄清）

### 需求 1：会话级记住 Markdown 展示模式

- **粒度**：全局一个会话级「md 展示模式」。用户在任一 md 文件切换模式后，后续打开/切换到的其他 md 都沿用该模式；图片强制预览、非 md 明文强制编辑保持不变；仅打开软件时 md 按 `settings.defaultView`。
- 不落盘，仅内存，会话结束即失效。

### 需求 2：自定义页面底色 RGB

- **范围**：编辑区 + 预览区。
- **生效**：自定义优先、独立开关。开启时编辑/预览区用用户 RGB，关闭恢复主题默认。
- **前景**：按用户 RGB 亮度自动反色（深底浅字/浅底深字），保证可读。

### 需求 3：退出时自动关闭所有标签

- 新增设置开关。开启后退出应用时不恢复标签会话，下次打开总是空白。
- **未保存处理**：退出时照常弹「有未保存改动」提示（保存/丢弃/取消），不因该开关而静默丢稿。
- 仅「真正退出」（quit）时清空会话；最小化到托盘不清（进程未退）。

### 需求 4：DOCX 导出重写为真 OOXML

- **四个方向全部纳入**：标题映射 Word 真样式、排版/表格/代码块保真、兼容性增强（WPS/Google Docs）、页面尺寸/页边距设置。
- **策略**：放弃 altChunk，引入 `docx` 库直接生成真 OOXML。
- **页面设置交互**：每次导出时（保存对话框前）选择 A4/Letter + 边距预设。

## 方案

### 需求 1：会话级 md 展示模式

- 新增内存字段 `this._sessionMdViewMode = null`（构造函数中 `viewMode` 初始化附近）。
- `setViewMode(mode)` 守卫通过后、真正设置 `this.viewMode = mode` 成功时，若当前 tab 为 markdown（按 `window.FileTypes.classifyFile` 判断），记录 `this._sessionMdViewMode = mode`。
- `syncViewModeToTab()` 的 md 分支改为：

```js
else target = this._sessionMdViewMode || this.settings.defaultView || 'preview';
```

- image → `preview`、text → `edit` 分支保持不变（特殊类型优先于会话记忆）。
- 边界确认：
  - 打开软件：`_sessionMdViewMode` 初始 `null` → md 用 `settings.defaultView` ✓
  - 会话内切到图片（强制预览）后 `setViewMode` 对图片不记录（非 md），再切回 md 时 `_sessionMdViewMode` 仍是之前记住的值 ✓
  - 新建未命名文档：无 `filePath`，`syncViewModeToTab()` 提前 return，不触碰记忆；`newFile` 仍显式 `setViewMode('edit')`，首次编辑态不污染记忆（setViewMode 内对无路径 tab 的 kind 兜底为 markdown，会记录编辑——需在 setViewMode 内同时要求 `_tab.filePath` 为真才记录，避免新建文档把会话模式写成 edit）。

> 修正：记录条件为「当前 tab 有 filePath 且 classifyFile 为 markdown」，无路径的新建文档不记录。

### 需求 2：自定义页面底色

- `defaultSettings()` 新增：
  - `customBgEnabled: false`
  - `customBgColor: '#f8f7f4'`
- 设置面板「预览」分区新增一行：开关（toggle）+ 颜色输入（`<input type="color">` 或 16 进制文本框，取 `<input type="color">` 最直观）。
- 生效处：新增 `applyCustomBg()`，在 `applySettings()` 与 `applyThemeMode()`（切主题后重算）中调用。
  - 开启：在 `document.documentElement` 或 body 上设 CSS 变量覆盖——编辑区/预览区背景 var 设为 `customBgColor`；按亮度计算前景色（`Y = 0.299R+0.587G+0.114B`，`Y ≥ 128` 用深字 `#1a1a1a`，否则浅字 `#e8e8e8`），覆盖编辑/预览文字颜色变量。
  - 关闭：移除覆盖，恢复主题默认。
- 实现要点：用独立的 CSS 变量名（如 `--custom-bg`、`--custom-fg`）在样式表已有选择器里优先于主题变量，避免侵入 5 套配色。

### 需求 3：退出时自动关闭所有标签

- `defaultSettings()` 新增 `clearTabsOnQuit: false`。
- 设置面板「行为」分区新增行：`退出时关闭所有标签` toggle，id `set-clear-tabs-on-quit`。
- `syncSettingsControls()` 同步该勾选。
- `handleAppClose()`：在处理未保存文档（保存/丢弃/取消）之后、`saveSession()` 之前：

```js
if (this.settings.clearTabsOnQuit) {
  localStorage.removeItem('tizumark-session');
} else {
  this.saveSession();
}
```

- 未保存提示逻辑不变（原样保留在最前）。
- `hideToTray()` 不动（托盘最小化不代表退出，继续 saveSession 保留会话）。

### 需求 4：DOCX 重写为真 OOXML

- 引入 `docx` npm 包（devDependencies 需在 renderer 打包，参考现有 `html-docx.min.js` 的 vendor 方式，需在 `scripts/build-renderer.mjs` / `scripts/ensure-vendor.mjs` 里处理）。
- 保留现有 `exportWord()` 的：确认框、loading overlay、保存对话框、图片尺寸采集、`_prepareWordDOM`（公式/图表转图片、任务列表、代码块换行等 DOM 预处理）。
- 新增核心转换 `_domToDocxNodes(rootElement)`：遍历预处理后的 clone（挂离屏 DOM 后），把 DOM 元素映射为 docx 对象：
  - H1–H6 → `HeadingLevel`
  - p → `Paragraph`
  - table/thead/tbody/th/td → `Table`/`TableRow`/`TableCell`
  - pre/code → 等宽字体 `TextRun` + 底纹段落
  - blockquote → 缩进 + 边框/底纹段落
  - ul/ol/li → `bullet`/`numbering` 层级（支持嵌套）
  - img → `ImageRun`（用已内联的 data URL）
  - strong/em/del/code/mark/kbd/a → 对应 `TextRun` 样式
  - 标题页设置：`Document` 的 `numbering` 配置、`styles` 默认样式
- 页面设置：`exportWord()` 内、`dialogSave` 之前弹「导出页面设置」对话框（复用现有 `Dialogs` 体系或新增轻量对话框）：纸张 A4/Letter（`PageSize`）+ 边距预设（标准/窄/宽）。
- 输出：`docx.Packer.toBlob(doc)` → ArrayBuffer → `writeBinaryFile`。
- Worker：`docx` 为纯 JS，可在现有 `word-export.worker.js` 内运行；主线程传「预处理后 DOM 的序列化结构 + 页面设置」，worker 生成 docx 并回传 ArrayBuffer（保持现有「不阻塞主线程」诉求）。若序列化 DOM 成本过高，改为主线程完成转换（`_domToDocxNodes` 在主线程，仅 `Packer.toBlob` 放 worker）。
- 回退：`docx` 生成失败时保留原 `html-docx` altChunk 路径作为兜底。

## 改动清单

1. `src/app.js`：需求 1（`_sessionMdViewMode`、`setViewMode`、`syncViewModeToTab`）、需求 2（defaultSettings、设置控件、`applyCustomBg`、applySettings 接线）、需求 3（defaultSettings、`handleAppClose`）、需求 4（`exportWord` 重构 + `_domToDocxNodes` + 页面设置对话框）。
2. `src/index.html`：需求 2、3 的设置面板行；需求 4 的页面设置对话框。
3. `src/styles.css`：需求 2 的自定义底色变量优先规则。
4. `src/lib/`：需求 4 引入 `docx` vendor 或 bundle；`word-export.worker.js` 改用 docx 生成。
5. `scripts/build-renderer.mjs` / `scripts/ensure-vendor.mjs`：需求 4 的 vendor 打包。
6. 测试：`test/` 下新增对应用例（需求 1 模式记忆、需求 2 亮度计算、需求 3 退出清会话、需求 4 DOM→docx 节点映射）。

## 验证

- `npm run check`（已有全局检查 + 测试入口）
- `npm test`（或按过滤跑改动相关用例）
- 手动冒烟：切 tab 模式记忆、底色反色、退出干净启动、导出 docx 用 Word/WPS 打开验证。
