## ⬇️ Download

> **🏆 Recommended for most users:** [⬇ TizuMark_1.2.3_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.3/TizuMark_1.2.3_x64-setup.exe)
>
> **🛠 Enterprise / bulk deploy:** [⬇ TizuMark_1.2.3_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.3/TizuMark_1.2.3_x64_en-US.msi)
>
> **📦 Portable (no install):** [⬇ TizuMark_1.2.3_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.3/TizuMark_1.2.3_x64.exe)

### Package types

| Package | For | Notes |
|--------|-----|-------|
| ⭐ **NSIS installer (.exe)** — **Recommended** | Most Windows users | Classic setup wizard; custom install path, desktop shortcut, file association. |
| **MSI installer (.msi)** | IT admins / bulk deploy | Windows Installer; group policy push, silent install (msiexec /i TizuMark_1.2.3_x64_en-US.msi /qn). |
| **Portable (.exe)** | Portable use | Single file, no install, no registry writes. |

---

## ✨ v1.2.3 Changelog

### Added
- Settings panel font group now combines size/weight sliders; DOCX export code-block and formula fixes
- DOCX export fixed to A4 / portrait / standard margins; right-click "New" on file-tree blank area and on files
- Editable formulas (OMML) + main-thread direct build + typography refinements
- DOCX formulas converted to Word-editable OMML (MathML→OMML + inject oMath); raw/preview word counts unified to character-count basis
- Status bar adds preview word count (original/preview dual metric); export HTML embeds network diagrams inline for offline use
- ExportWord now uses real OOXML (page setup → DOM → worker → write); falls back to html-docx on failure
- Export page-setup dialog + DOCX page size/margin calculation
- Settings: add "close all tabs on exit" (clean start, still prompts for unsaved)
- Settings: add custom page background color (editor + preview, auto-inverts by luminance)
- Session-level memory of Markdown view mode (image/txt special types prioritized; default view at launch)
- Open recent workspace
- File tree: "show all files" toggle; image storage setting radio changed to dropdown

### Improved
- (None)

### Fixed
- PDF export font chain now preserves user preview font; fixed two stale tests causing CI red
- Global line spacing + table spacing + mermaid re-render before export
- CSP connect-src adds blob: + export image cache fallback, fixing broken images in released HTML/DOCX export (v1.2.2 bug)
- Export-docx preserves nested styles / full blockquote paragraphs / converts rgb to hex
- Export-docx dual export changed to mutually exclusive (aligns with repo module convention)
- OpenFilePath opening new md reuses session memory (converged view logic); custom background only applies to preview, avoiding leakage into update dialog
- Fixed exit-clear logic comment wording (non-quit does not clear session)
- Only true exit (quit) clears session per the toggle; non-exit paths (cancel/minimize-to-tray) do not; added boundary tests
- Custom background setting wired to Chinese/English i18n
- New documents no longer pollute session-level md view-mode memory, reusing classifyFile result
- Recent files / recent workspace submenus mutually exclusive, avoiding overlap while sliding
- At launch, self-heal .md/markdown open-with association (OpenWithProgids) + updated copyright and promo copy to under 10MB
- Add cross-platform window dragging and start_dragging ACL permission (#61)
- Fixed GitHub CI build failure and cleaned up leftover shortcut-dialog title

> Questions? Join QQ group: 1035294939
