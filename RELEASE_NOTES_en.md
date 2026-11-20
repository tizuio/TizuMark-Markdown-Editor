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
