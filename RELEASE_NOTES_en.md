## ⬇️ Download

> **🏆 Recommended for most users:** [⬇ TizuMark_1.2.4_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.4/TizuMark_1.2.4_x64-setup.exe)
>
> **🛠 Enterprise / bulk deploy:** [⬇ TizuMark_1.2.4_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.4/TizuMark_1.2.4_x64_en-US.msi)
>
> **📦 Portable (no install):** [⬇ TizuMark_1.2.4_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.4/TizuMark_1.2.4_x64.exe)

### Package types

| Package | For | Notes |
|--------|-----|-------|
| ⭐ **NSIS installer (.exe)** — **Recommended** | Most Windows users | Classic setup wizard; custom install path, desktop shortcut, file association. |
| **MSI installer (.msi)** | IT admins / bulk deploy | Windows Installer; group policy push, silent install (msiexec /i TizuMark_1.2.4_x64_en-US.msi /qn). |
| **Portable (.exe)** | Portable use | Single file, no install, no registry writes. |

---

## ✨ v1.2.4 Changelog

### Added
- Restored LaTeX delimiter support \(...\) and \[...\] with conservative detection (LaTeX commands or superscripts render as math; plain brackets like citations stay literal)
- Mermaid ELK layout engine (frontmatter `config: layout: elk`); one-click sidebar toggle handle on the left edge; `<br>` line breaks inside table cells
- Obsidian-style image embeds `![[image path]]` with optional size suffix (`|600`, `|600x400`)
- Comprehensive Spanish language support
- md2 merged-cell tables (grid syntax plus `>>` / `^^` pipe shorthand)
- OS-level global hotkey for close-to-tray (restores the window even when hidden)

### Improved
- app.js split into 20 focused modules with i18n data/logic separation
- Alt-based shortcuts now dispatch globally; matched shortcuts uniformly preventDefault
- Windows build workflow (CI) compiling installers and portable binaries

### Fixed
- Tray icon no longer remains after exit (ghost icons that only vanished on hover, accumulating across sessions)
- Table insert-row/insert-column shortcuts now work (previously threw an error) and insert below the cursor row / after the cursor column
- File-tree context menu: disabled items no longer trigger actions; shortcut hints no longer disappear on hover

> Questions? Join QQ group: 1035294939
