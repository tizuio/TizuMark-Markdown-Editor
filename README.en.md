# TizuMark

**TizuMark** is a lightweight, open-source **Markdown editor** for Windows with WYSIWYG live preview, outline navigation, KaTeX & Mermaid support — a free **Typora alternative** built with Tauri + Rust.

🌐 [简体中文](README.md) | **English**

<div align="center">

![TizuMark](icon.png)

</div>

<p align="center">
  <b>⚡Lightweight &nbsp;·&nbsp; 🚀Blazing Fast &nbsp;·&nbsp; ✨Minimal &nbsp;·&nbsp; 🆓<font color="#16a34a">Free & Open Source</font></b>
  <br>
  <b>A clean, fast Markdown editor</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-1.2.3-blue" alt="Version">
  <img src="https://img.shields.io/badge/Windows-7%2B-brightgreen" alt="Windows">
  <img src="https://img.shields.io/badge/macOS-Planned-lightgrey" alt="macOS">
  <img src="https://img.shields.io/badge/Linux-Planned-lightgrey" alt="Linux">
  <img src="https://img.shields.io/badge/Tauri-2.x-orange" alt="Tauri">
  <img src="https://img.shields.io/badge/Rust-1.77%2B-black" alt="Rust">
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue" alt="License">
</p>

<p align="center" style="font-size:1.15em"><b>~7MB installer · &lt;50MB RAM · Double-click to launch</b></p>

<p align="center">
  <img src="demo.gif" alt="TizuMark Feature Demo" width="880">
</p>

---

## Why TizuMark?

<p align="center"><b>Open. Read. Edit. Export. That's it.</b></p>

The world isn't short of Markdown editors. But most fall into one of two camps: heavyweight monsters that hog hundreds of MB, or toys too barebones for real work. TizuMark lands right in the sweet spot.

| Pain Point | The Usual Way | ✨ TizuMark |
|---|---|---|
| 🐢 **Too heavy** | Hundreds of MB RAM, multi-GB install, slow boot | **Rust engine. ~7MB installer, <50MB RAM, up in a second** |
| 👯 **Split views** | Source on one side, render on the other — scroll and squint | **Live preview, WYSIWYG, editor/preview scroll auto-synced** |
| 🌀 **Long docs** | Endless scrolling, can't find that one section | **Auto-generated outline from headings, one click to any chapter** |
| 🧩 **Math & diagrams** | Install LaTeX, switch tools, export, paste, repeat | **Built-in KaTeX & Mermaid — math and diagrams render from code** |

---

## Key Features

> TizuMark lands right in the sweet spot between heavyweight IDEs and barebones notepads — nailing the things writers care about most.

- ⚡ **Blazing fast & lightweight**: Built on **Rust + Tauri v2** (native WebView), ~**7MB** installer, **<50MB** RAM, launches in under a second — 4/5 less memory than Electron apps.
- 👁️ **Live WYSIWYG preview**: Write on the left, see it render on the right. Editor and preview scroll auto-synced — no window switching.
- 🧠 **Smart view per file type**: Markdown auto splits preview/edit; plain text & code open in a pure editor (no preview pane); images open read-only — each file gets the right view.
- 🧭 **Smart outline navigation**: Auto-parses heading hierarchy, one click to any chapter. Never get lost in long docs.
- 📐 **Built-in KaTeX math**: Inline formulas, display blocks, matrices, equation systems — papers, notes, formulas all handled.
- 📊 **Built-in Mermaid diagrams**: Flowcharts, sequence diagrams, Gantt charts, class diagrams, state diagrams… **draw with code, auto-adapts to light/dark theme**.
- 🖼️ **Paste-to-insert images**: Screenshots or drag-drop, auto-dedup via MD5. Store in `assets/` or inline as Base64. Relative paths resolve identically in preview and export.
- 📤 **Multi-format export**: Standalone HTML (full styling, fully offline), high-res PNG long screenshot, PDF (system print dialog), and **Word DOCX** (math & diagrams rasterized, images auto-scaled to fit the page) — all preserve dark/light theme.
- ⌨️ **Fully customizable shortcuts**: Every single shortcut can be rebound in `File → Keyboard Shortcuts` to match your muscle memory.
- 📂 **Multi-tab + workspace**: Edit multiple files at once, drag-drop batch open, folder workspace with sidebar file tree, `.md` file association.
- 🚀 **Huge-doc smooth preview**: Sliding-window + virtual rendering for documents with tens of thousands of lines — never lags. External file changes auto-detected with reload prompt.
- 🎨 **Deep personalization**: Light / Dark / Follow System; 5 color schemes (Default / Sunset / Forest / Nord / Dusk); editor / preview / code-block fonts can use any system-installed font (fully enumerated, searchable), or import local `.ttf` / `.otf` / `.woff` / `.woff2` fonts.
- 🌐 **Bilingual UI**: Chinese / English interface toggle at any time.
- 💾 **Session restore**: Reopens tabs, folder workspace, and expanded directories from last session.

---

## Feature Matrix

| 📝 Editing | 👁️ Preview | 📤 Export |
|---|---|---|
| Full GFM syntax highlighting | Live scroll-synced preview | Standalone HTML (with full styling) |
| 100+ language code highlighting | KaTeX math rendering | High-res long screenshot PNG |
| Find & replace with regex | Mermaid flowcharts, sequences, Gantt, state | Export PDF (system print dialog) |
| Cross-file search (`Ctrl+H`) | Emoji shortcodes (`:rocket:` → 🚀) | Dark / light theme preserved |
| Collapsible format toolbar | Image viewer (drag-pan + scroll-zoom) | 100% offline |
| Auto bracket & quote pairing | Adaptive image sizing | CJK Emoji support |
| Image paste, auto-dedup (MD5) | Clickable task-list checkboxes | Custom image asset path |
| Insert menu + "/" quick-insert (tables, callouts, TOC) | Auto width/height on image insert | Export Word DOCX (math & diagrams rasterized, images auto-scaled) |

| ⚡ Productivity | 🎨 Style | 🔧 Power |
|---|---|---|
| Outline sidebar — jump anywhere | Light / Dark / Follow System | CLI file opening |
| Folder workspace (sidebar file tree) | Font size, line height, max width | File association: .md, .markdown |
| Cross-file search (Ctrl+H) / file search (Ctrl+P by name or path) | Tab width, word wrap toggle | Recently opened files list |
| Tab drag-to-reorder | Code block line numbers / auto-wrap | Unsaved-state markers + close prompt |
| Drag & drop, batch file open | Fully rebindable shortcuts | System tray (hideable) + close behavior |
| Free-drag split pane ratio | Import custom fonts (editor & preview separately) | Status bar word & char count |
| Find in preview (regex) + copy as HTML | 5 color schemes + font picker (all system fonts, searchable / import local) | External-change detection & reload prompt |
| Soft line break toggle | Chinese / English UI toggle | |
| Session restore (tabs & workspace) | Frameless custom window controls | |
| | Silent update check on startup | |

---

## Screenshots

<p align="center">
  <img src="screenshots/01-main.png" alt="Main Interface" width="45%">
  <img src="screenshots/02-find.png" alt="Find & Replace" width="45%">
  <br>
  <img src="screenshots/03-findcrossfile.png" alt="Cross-file Search" width="45%">
  <img src="screenshots/04-findfile.png" alt="File Quick Open" width="45%">
  <br>
  <img src="screenshots/05-tabs.png" alt="Tabs & Scrollable Tab Bar" width="45%">
  <img src="screenshots/06-math.png" alt="KaTeX Math Rendering" width="45%">
  <br>
  <img src="screenshots/07-mermaid.png" alt="Mermaid Diagram Rendering" width="45%">
  <img src="screenshots/08-code.png" alt="Code Syntax Highlighting" width="45%">
  <br>
  <img src="screenshots/09-callout.png" alt="Callout Rendering" width="45%">
  <img src="screenshots/10-theme.png" alt="Dark Theme" width="45%">
  <br>
  <img src="screenshots/11-font.png" alt="Font Settings" width="45%">
  <img src="screenshots/12-export.png" alt="Export Menu" width="45%">
  <br>
  <img src="screenshots/13-shortcuts.png" alt="Customizable Shortcuts" width="45%">
  <img src="screenshots/14-image.png" alt="Image Insert & Settings" width="45%">
  <br>
  <img src="screenshots/15-workspace.png" alt="Folder Workspace" width="45%">
  <img src="screenshots/16-large.png" alt="Smooth Large-Document Preview" width="45%">
</p>

---

## Quick Start

### Download

| Platform | Status |
|----------|--------|
| Windows | ✅ Supported |
| macOS | 🔜 Planned |
| Linux | 🔜 Planned |

<b>Visit the release page to download:</b>

<a href="https://github.com/tizuio/TizuMark-Markdown-Editor/releases"><img src="https://img.shields.io/badge/⬇_Download_from_GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="Download from GitHub"></a>
&nbsp;&nbsp;
<a href="https://gitee.com/tizu/TizuMark-Markdown-Editor/releases"><img src="https://img.shields.io/badge/⬇_Download_from_Gitee-C71D23?style=for-the-badge&logo=gitee&logoColor=white" alt="Download from Gitee"></a>

> On first launch, the user guide opens automatically. You can also find it in `Help → User Guide` anytime.

> 🔔 **On first install or after a version upgrade, TizuMark automatically opens the User Guide and the full syntax demo (demo.md) to help you get started with new features.**

📖 Want to see every syntax in action? Open [demo.md](demo.md) for a full syntax showcase.

### Shortcuts

| Shortcut | Action | Shortcut | Action |
|---|---|---|---|
| `Ctrl+N` | New File | `Ctrl+W` | Close Tab |
| `Ctrl+O` | Open File | `Ctrl+F` | Find |
| `Ctrl+S` | Save File | `Ctrl+H` | Find & Replace |
| `Ctrl+B` | Bold | `Ctrl+I` | Italic |

> All shortcuts are customizable via `File → Keyboard Shortcuts`

### Build from Source

```bash
git clone https://github.com/tizuio/TizuMark-Markdown-Editor.git
# Or via Gitee (China mirror):
git clone https://gitee.com/tizu/TizuMark-Markdown-Editor.git
cd tizu-mark
npm install
npm run dev      # dev mode
npm run build    # production build
```

---

## 🛠 Architecture

```
┌──────────────────────────────────────────────────┐
│                 Frontend (WebView)                 │
│   CodeMirror 5  │  highlight.js  │    KaTeX       │
│     Mermaid     │  html2canvas   │     ...        │
└──────────────┬───────────────────────────────────┘
               │ IPC (ipc: / tauri:)
┌──────────────┴───────────────────────────────────┐
│                  Backend (Rust)                    │
│     Tauri 2.5    │    pulldown-cmark               │
│     File I/O     │    Native Dialogs               │
└──────────────┬───────────────────────────────────┘
               │
        ┌──────┴──────┐
        │  OS Native   │
        │ Win / Mac /  │
        │   Linux      │
        └─────────────┘
```

> Tauri v2 uses the OS native WebView — ~7MB installer, ~1/5 the footprint of Electron-based alternatives. **Windows is released today; macOS & Linux are planned.**

---

## FAQ

<details open>
<summary><b>Is TizuMark really free?</b></summary>

Yes. Free forever, open source, no feature paywalls.
</details>

<details open>
<summary><b>How do I restore default settings?</b></summary>

Click "Restore Default" in `File → Settings` or `File → Keyboard Shortcuts`.
</details>

<details open>
<summary><b>What file formats are supported?</b></summary>

Markdown (`.md`, `.markdown`, `.mdown`, `.mkd`, … — 7 extensions, auto split-preview), images (20 formats, read-only preview), and plain-text / code files (`.txt`, `.json`, `.js`, …) all open. Markdown syntax highlighting & export apply to Markdown files.
</details>

<details open>
<summary><b>How do I report a bug or request a feature?</b></summary>

- QQ Group: **1035294939** (Chinese community)
- [GitHub Issues](https://github.com/tizuio/TizuMark-Markdown-Editor/issues)
- [Gitee Issues](https://gitee.com/tizu/TizuMark-Markdown-Editor/issues)
</details>

---

## Donate

<p align="center"><b>One person. No salary. Your support keeps this alive.</b></p>

I built TizuMark because I was tired of Markdown tools that were either bloated or broken. So I made my own.

If TizuMark has made your life even a little easier — docs look cleaner, writing flows better, that export earned you a compliment — please consider chipping in. **Your encouragement genuinely makes my day and extends this project's runway.**

Can't donate? No worries. A GitHub star, a shout-out to a friend, a "nice tool" in the group chat — that's already huge.

<table align="center">
  <tr>
    <td align="center">
      <img src="donate-wechat.png" alt="WeChat Pay" width="220"><br>
      <span style="display:inline-flex;align-items:center;gap:4px;margin-top:6px;font-size:14px;font-weight:500">
        <svg role="img" viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle;fill:#07C160">
          <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/>
        </svg>
        WeChat
      </span>
    </td>
    <td width="40"></td>
    <td align="center">
      <img src="donate-alipay.png" alt="Alipay" width="220"><br>
      <span style="display:inline-flex;align-items:center;gap:4px;margin-top:6px;font-size:14px;font-weight:500">
        <svg role="img" viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle;fill:#1677FF">
          <path d="M19.695 15.07c3.426 1.158 4.203 1.22 4.203 1.22V3.846c0-2.124-1.705-3.845-3.81-3.845H3.914C1.808.001.102 1.722.102 3.846v16.31c0 2.123 1.706 3.845 3.813 3.845h16.173c2.105 0 3.81-1.722 3.81-3.845v-.157s-6.19-2.602-9.315-4.119c-2.096 2.602-4.8 4.181-7.607 4.181-4.75 0-6.361-4.19-4.112-6.949.49-.602 1.324-1.175 2.617-1.497 2.025-.502 5.247.313 8.266 1.317a16.796 16.796 0 0 0 1.341-3.302H5.781v-.952h4.799V6.975H4.77v-.953h5.81V3.591s0-.409.411-.409h2.347v2.84h5.744v.951h-5.744v1.704h4.69a19.453 19.453 0 0 1-1.986 5.06c1.424.52 2.702 1.011 3.654 1.333m-13.81-2.032c-.596.06-1.71.325-2.321.869-1.83 1.608-.735 4.55 2.968 4.55 2.151 0 4.301-1.388 5.99-3.61-2.403-1.182-4.438-2.028-6.637-1.809"/>
        </svg>
        Alipay
      </span>
    </td>
  </tr>
</table>

<p align="center"><sub>I read every donation notification. Thank you.</sub></p>

---

## Contact

| Channel | Link |
|---|---|
| QQ Group | **1035294939** [@Join the group【Tizu交流群】](http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=G0xAh9l042apAmjy9MAKOI6pSMWhV5jI&authKey=hWwxCXRZkWorgQZtiBNeRE6L12Ow6CLSo9K9dWzSjDFNuIEfmnmLAWH1T3qooH40&noverify=0&group_code=1035294939)|
| GitHub | [@tizuio](https://github.com/tizuio) |
| Gitee | [@tizu](https://gitee.com/tizu) |

Questions, feedback, collaboration — open an issue or join the QQ group.

---

## License

Copyright (c) 2024-2026 TizuMark

This software is released under the [GNU General Public License v3.0](LICENSE). You are free to use, modify, and distribute it, but derivative works must remain under GPL v3.

Bundled open-source components are licensed under their respective terms. See `Help → About` in the app for details.

---

<p align="center">
  <b>✨ TizuMark — Stupidly light. Exactly fast enough.</b><br><br>
  <a href="https://github.com/tizuio/TizuMark-Markdown-Editor/releases"><img src="https://img.shields.io/badge/⬇_GitHub_Download-black?style=for-the-badge&logo=github" alt="GitHub Download"></a>
  &nbsp;
  <a href="https://gitee.com/tizu/TizuMark-Markdown-Editor/releases"><img src="https://img.shields.io/badge/⬇_Gitee_Download-C71D23?style=for-the-badge&logo=gitee" alt="Gitee Download"></a>
  <br><br>
  <a href="https://github.com/tizuio/TizuMark-Markdown-Editor">⭐ GitHub Star</a>
  &nbsp;·&nbsp;
  <a href="https://gitee.com/tizu/TizuMark-Markdown-Editor">⭐ Gitee Star</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/tizuio/TizuMark-Markdown-Editor/issues">🐛 Report Bug</a>
</p>
