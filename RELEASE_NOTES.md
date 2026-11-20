## ⬇️ 下载

> **🏆 推荐大多数用户选择：** [⬇ TizuMark_1.2.6_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.6/TizuMark_1.2.6_x64-setup.exe)
>
> **🛠 企业/批量部署：** [⬇ TizuMark_1.2.6_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.6/TizuMark_1.2.6_x64_en-US.msi)
>
> **📦 绿色版（免安装）：** [⬇ TizuMark_1.2.6_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.6/TizuMark_1.2.6_x64.exe)

### 三种安装包说明

| 安装包 | 适用人群 | 特点 |
|--------|---------|------|
| ⭐ **NSIS 安装包 (.exe)** — **推荐** | 绝大多数 Windows 用户 | 传统的 setup 向导安装，支持自定义安装路径、创建桌面快捷方式、自动注册文件关联。双击即装，即装即用。 |
| **MSI 安装包 (.msi)** | 企业 IT 管理员、需要批量部署的用户 | 标准的 Windows Installer 格式，支持组策略推送、静默安装（msiexec /i TizuMark_1.2.6_x64_en-US.msi /qn）、适合企业环境集中管理。 |
| **绿色版 (.exe)** | 追求便携的用户 | 单文件免安装，解压即用，适合 U 盘携带、临时使用，不写注册表。 |

---

## ✨ v1.2.6 更新内容

### 新增

- 多窗口：标签页可拖拽撕离为独立编辑器窗口，右键「在新窗口打开 / 移动到新窗口」双入口，Ctrl+拖拽即移动；多窗口关闭协调、退出握手与会话恢复
- 全局对齐方式：设置面板新增「对齐方式」（默认 / 两端 / 居中 / 右对齐），阅读、实时预览与 DOCX 导出统一生效
- PDF 导出：新增书签大纲与纸面目录页
- 文件树自动定位当前文档并高亮，支持路径归一化匹配
- 大纲面板：标签内的公式支持 KaTeX 渲染

### 改进

- 暗色模式对比度全面优化：表格边框、代码块、行内代码、分割线、标题下划线等内容边界提亮，暗色下清晰可辨（issue #100）
- 暗色模式下图片增加棋盘格衬底，透明图片不再融入背景
- 界面多处元素（复选框、标签页、提示条、视图切换等）对比度提升，亮暗两套主题同步

### 修复

- 阅读模式长代码块不再永久失去滚动条（滚动测量坏写入自愈兜底，issue #89）
- 多标签切换不再闪现「加载中」提示（loading 层按需挂载，issue #74）
- 容器内表格单元格行内公式不再残留占位符字面文本
- 行内公式 HTML 标签判定收紧，避免把普通内容误判为公式
- 阅读模式图片缓存修复：被引用的图片不再被误回收（LRU 上限处理）

> 使用中遇到问题欢迎加 QQ 群：1035294939

---

## ⬇️ Download

> **🏆 Recommended for most users:** [⬇ TizuMark_1.2.6_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.6/TizuMark_1.2.6_x64-setup.exe)
>
> **🛠 Enterprise / bulk deploy:** [⬇ TizuMark_1.2.6_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.6/TizuMark_1.2.6_x64_en-US.msi)
>
> **📦 Portable (no install):** [⬇ TizuMark_1.2.6_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.6/TizuMark_1.2.6_x64.exe)

### Package types

| Package | For | Notes |
|--------|-----|-------|
| ⭐ **NSIS installer (.exe)** — **Recommended** | Most Windows users | Classic setup wizard; custom install path, desktop shortcut, file association. |
| **MSI installer (.msi)** | IT admins / bulk deploy | Windows Installer; group policy push, silent install (msiexec /i TizuMark_1.2.6_x64_en-US.msi /qn). |
| **Portable (.exe)** | Portable use | Single file, no install, no registry writes. |

---

## ✨ v1.2.6 Changelog

### Added
- Multi-window: drag a tab out of the window to tear it off into a standalone editor window; right-click "Open in New Window / Move to New Window" entries, Ctrl+drag to move; coordinated close, exit handshake and session restore across windows
- Global text alignment: new "Alignment" setting in preferences (default / justify / center / right), applied consistently in reading mode, live preview and DOCX export
- PDF export: bookmarks outline and an in-document table of contents page
- File tree automatically locates and highlights the current document, with path-normalized matching
- Outline panel: math inside heading labels now renders via KaTeX

### Improved
- Dark mode contrast overhaul: table borders, code blocks, inline code, dividers and heading underlines are brighter and clearly visible in the dark theme (issue #100)
- Images in dark mode get a checkerboard backdrop so transparent images no longer blend into the background
- Contrast improved across many UI elements (checkboxes, tabs, toasts, view switcher), in both light and dark themes

### Fixed
- Long code blocks in reading mode no longer permanently lose their scrollbar (self-healing fallback for broken scroll measurements, issue #89)
- Switching tabs no longer flashes a "Loading" hint (loading overlay is mounted on demand, issue #74)
- Inline math in table cells inside containers no longer leaves literal placeholder text behind
- Inline math HTML-tag detection tightened, so ordinary content is no longer mistaken for math
- Reading-mode image cache fix: referenced images are no longer evicted incorrectly (LRU cap handling)

> Questions? Join QQ group: 1035294939
