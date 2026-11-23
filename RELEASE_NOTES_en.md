> [!IMPORTANT]
> **⚠️ v1.2.5 / v1.2.6 users: these two versions CANNOT update in-app (updater defect). Please download and reinstall this version manually.**
>
> After installing v1.2.7, in-app updates work normally again — no more manual downloads needed for future releases.
>
> - Gitee release page: https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/tag/v1.2.7
> - GitHub release page: https://github.com/tizuio/TizuMark-Markdown-Editor/releases/tag/v1.2.7
>
> **Note**: Install over your existing setup — settings, sessions and documents are all preserved.

## ⬇️ Download

> **🏆 Recommended for most users:** [⬇ TizuMark_1.2.7_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.7/TizuMark_1.2.7_x64-setup.exe)
>
> **🛠 Enterprise/bulk deployment:** [⬇ TizuMark_1.2.7_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.7/TizuMark_1.2.7_x64_en-US.msi)
>
> **📦 Portable (no install):** [⬇ TizuMark_1.2.7_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.7/TizuMark_1.2.7_x64.exe)

### Package Comparison

| Package | Audience | Notes |
|---------|---------|------|
| ⭐ **NSIS installer (.exe)** — **Recommended** | Most Windows users | Traditional setup wizard: custom install path, desktop shortcut, file association. |
| **MSI installer (.msi)** | Enterprise IT admins | Standard Windows Installer: group policy deployment, silent install (`msiexec /i TizuMark_1.2.7_x64_en-US.msi /qn`). |
| **Portable (.exe)** | Portable-use lovers | Single file, no installation, no registry writes. |

---

## ✨ v1.2.7 Changelog

### New

- (none)

### Improved

- (none)

### Fixed

- Fixed in-app "Download update" completely broken: the update check found new versions but clicking download failed instantly (the updater disk-cache feature introduced in v1.2.5 read the wrong metadata field name `rawJson`; v1.2.5 and v1.2.6 are both affected).

> If you run into any issues, feel free to join our QQ group: 1035294939
