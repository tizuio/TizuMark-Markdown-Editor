## ⬇️ Download

> **🏆 Recommended for most users:** [⬇ TizuMark_1.2.5_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.5/TizuMark_1.2.5_x64-setup.exe)
>
> **🛠 Enterprise / bulk deploy:** [⬇ TizuMark_1.2.5_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.5/TizuMark_1.2.5_x64_en-US.msi)
>
> **📦 Portable (no install):** [⬇ TizuMark_1.2.5_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.5/TizuMark_1.2.5_x64.exe)

### Package types

| Package | For | Notes |
|--------|-----|-------|
| ⭐ **NSIS installer (.exe)** — **Recommended** | Most Windows users | Classic setup wizard; custom install path, desktop shortcut, file association. |
| **MSI installer (.msi)** | IT admins / bulk deploy | Windows Installer; group policy push, silent install (msiexec /i TizuMark_1.2.5_x64_en-US.msi /qn). |
| **Portable (.exe)** | Portable use | Single file, no install, no registry writes. |

---

## ✨ v1.2.5 Changelog

### Added
- Live WYSIWYG preview mode: the text keeps its formatted look while only the block under the cursor shows Markdown source — write directly on the rendered page, Typora-style. Table cells edit in place with row/column drag-and-drop, task checkboxes are clickable, code blocks keep syntax highlighting; the editing state matches the rendered state pixel for pixel
- Vertical split in edit mode: flip between side-by-side and top-bottom with one click (double-click the divider or press the button); split direction and ratio are persisted
- Tab rename via right-click (renaming a saved file also renames it on disk)
- File tree: "Up One Level" button on the workspace title; click the "Files" title to switch workspace via a folder picker, click the path to reveal the folder in the file manager; drag-and-drop to move files and folders
- Updater: installer disk cache (already-downloaded setups are not downloaded twice) and "skip this version"

### Improved
- Live preview performance: warm startup 449→374 ms, per-block pre-render 131→34 ms; structural edits now refresh incrementally
- Export PDF: direct export (only very old WebView2 runtimes fall back to the system print dialog); the confirmation dialog matches the DOCX style; dark-theme gray background fixed
- Editor and preview content now align at the top in both horizontal and vertical split
- Inline math delimiter \(...\) now renders as math by default instead of degrading to literal brackets
- Chinese IME input fixes in lists and headings
- Split collapse controls moved into the divider; collapsed panes show an edge-docked semicircle handle

### Fixed
- Scroll-sync offset: systematic anchor measurement drift (2–10 lines horizontally, 24–30 lines vertically) made the preview follow inaccurately
- Split panes disappeared after maximizing/restoring the window
- Export PDF gray ring root cause (WebView2 background color)
- Numerous live-preview editing-state fixes (nested blockquotes, block spacing mismatching reading mode, Enter at end of document, and more)

> Questions? Join QQ group: 1035294939
