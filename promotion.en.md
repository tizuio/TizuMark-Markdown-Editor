# The Under-10MB Free Markdown Editor: Math, Diagrams & Search Built In — Zero Plugins Needed

My way of writing documents is simple: open the editor, type, close it.

But before that little routine, there's a whole setup ritual to get through.

**With VS Code**, you install plugins one by one: a Markdown preview enhancer, math rendering, diagram rendering... Then RAM usage climbs to hundreds of MB and startup takes a few seconds. It's powerful, sure — but sometimes I just want to write two thousand words.

**With Typora**, the experience really is light. But it costs ¥88. It's just a writing tool; I've always felt that writing Markdown shouldn't cost money.

So I built my own: **TizuMark**.

**Under 10MB. Free.**

Double-click and it's open — no waiting through a startup animation. Math, flowcharts, code highlighting, three kinds of search — it's all in there. **Not a single plugin to install.**

---

## What Makes It Stand Out

Here's what it does. A 30-second scan will tell you if it fits:

- **Zero plugins** — KaTeX math, Mermaid diagrams, 100+ language syntax highlighting, three kinds of search — all built in. No plugins fighting each other, nothing breaking after an update, and nothing to reconfigure when you switch machines.
- **Opens in a double-click, under 10MB / under 50MB RAM** — Rust + Tauri v2, using your system's own WebView instead of bundling an entire Chromium.
- **Three kinds of search** — `Ctrl+F` find & replace in the current document, `Ctrl+H` cross-file search, `Ctrl+P` file quick-open.
- **Everything a writer needs** — split-pane live preview with synced scrolling, outline navigation, breadcrumbs, folder workspace, multi-tabs (drag to reorder), slash commands.
- **Long documents stay smooth** — chunked rendering + focus-windowed preview + virtual scrolling in pure-preview mode, so tens of thousands of lines still scroll fluidly.
- **Customize it your way** — 5 color schemes; separate fonts for editor / preview / code blocks with a full searchable list of installed system fonts plus the ability to import your own font files; **every single shortcut is remappable**, with four presets included.
- **Images, worry-free** — auto MD5 dedup on paste, optional storage to `assets/` or Base64 inline, relative-path support, click to zoom.
- **Export chores handled too** — Word / HTML / long PNG / PDF, no extra tools like Pandoc required.
- **Fully offline** — no account, no internet, open it and write.

![Main interface overview](screenshots/01-main.png)

---

## The Numbers First

Below are typical measured values; results vary by machine, for reference only.

| | VS Code | Typora | TizuMark |
|---|---|---|---|
| Installer | 80–150 MB | 30–50 MB | **~9 MB** |
| RAM usage | 300–800 MB | 200 MB+ | **< 50 MB** |
| Cold start | 3–8 s | 1–2 s | **< 1 s** |
| Price | Free | **¥88 paid** | **Free** |
| Math | **Plugin needed** | Built-in | Built-in (KaTeX) |
| Diagrams | **Plugin needed** | ✗ | Built-in (Mermaid) |
| Folder-wide search | **Needs setup** | ✗ | Built-in (cross-file) |
| File quick-open | Built-in | ✗ | Built-in (Ctrl+P) |
| Auto-update | Manual | Yes | **Built-in (check + one-click upgrade)** |
| Chinese UI | Needs localization | Built-in | **Native Chinese (and English)** |

Under 10 MB is roughly the size of a phone photo. RAM is usually under 50 MB — for reference, a single Chrome tab often exceeds that.

Small isn't squeezed out by late-stage optimization; it's decided by the architecture: **Rust + Tauri v2**, which uses the system's own WebView instead of packing a full Chromium into the installer like Electron does.

---

## Three Kinds of Search

What really eats time in document work isn't always the writing — it's the finding. So search comes in three flavors, each handling its own case.

### Ctrl+F — Find & Replace in Document

Search as you type, with a live match count on the right. **Both the editor and preview highlight simultaneously**, so in split view you can spot your target at a glance without flipping between source and rendered output.

Supports case-sensitive matching, regular expressions, and wrap-around. Replace and replace-all support regex back-references like `$1`, `$&` — handy for batch reformatting or unifying terminology.

Select some text and press Ctrl+F and the selection is auto-filled into the search box. In pure-preview mode a standalone preview search panel appears, carrying over whatever you've selected on the page.

![Find and replace](screenshots/02-find.png)

### Ctrl+H — Cross-File Search

This is the one I reach for most when writing project docs or organizing a note library. Many lightweight editors only manage "search within the current file"; going cross-file means reaching for an external tool.

Two scopes to choose from: **all currently open tabs**, or **a specified directory** searched recursively. Results are grouped by file, each file headed by its path and match count, with each match listing line number, column, and context snippet, and a grand total up top.

Click any result to jump: the file opens, the matching text is selected, the view scrolls to it, **both editor and preview highlight the location**, and your current view mode is left untouched.

Directory traversal is implemented natively in Rust (one recursive scan, not per-directory back-and-forth calls), automatically skipping `node_modules`, `target`, `.git` and dot-directories, and by default searching only md / markdown / txt. The search has upper-bound protection (max 2000 files in scope, 5000 total matches), so huge directories won't freeze the UI.

![Cross-file search](screenshots/03-findcrossfile.png)

> A small note about a shortcut change along the way. Cross-file search was originally planned for `Ctrl+Shift+F`, but in practice that combo gets intercepted at the OS level by Sogou and Microsoft Pinyin's "simplified/traditional toggle" — the keypress never reaches the app. So it became `Ctrl+H`. Choosing keybindings that dodge IME hotkeys for Chinese users is a trade-off most non-Chinese editors never think to make.

### Ctrl+P — Quick File Open

Like VS Code's Quick Open: type to filter file names and paths, `↑` `↓` to select, Enter to open, Esc or click-outside to dismiss.

The file list comes from a single native traversal of the workspace on the Rust side (falling back to the current file's directory when no workspace is open), with a 50,000-file cap. The list re-scans when the window regains focus, so a file you just created is searchable immediately. With empty input it lists the first 50 files in the workspace (sorted by name) — handy as a quick switcher.

![Quick file open](screenshots/04-findfile.png)

> All three search shortcuts can be remapped in the Shortcuts settings.

---

## An Interface Arranged Around How You Write

**Live preview + synced scrolling** — type on the left, watch on the right; the preview follows your cursor without switching modes. When you want to focus, press `Ctrl+\` to toggle between editor and preview.

**Multiple tabs** — a dozen files open without feeling cramped; tabs scroll horizontally when there are too many and can be reordered by dragging.

**Outline navigation** — headings are parsed into a tree automatically; one click in the sidebar jumps anywhere. Supports subtree collapsing, draggable width, and full hide.

**Breadcrumbs** — the top of the editor shows your current heading path, so you always know which level of the document you're in; click to jump back.

**Slash commands** — type `/` to bring up a command list for inserting tables, math, diagrams, and callouts without touching the mouse. Commands can be sorted and hidden, keeping only the ones you use.

![Tabs and tab-bar scrolling](screenshots/05-tabs.png)

---

## Math, Diagrams, Code

These are the things you can't avoid when writing technical documents. In VS Code you'd stitch them together with plugins; in TizuMark they're built in — nothing to install:

**KaTeX math** — `$E=mc^2$` inline, `$$\sum_{i=1}^n i^2$$` as a standalone block; matrices and equation systems supported. No LaTeX installation required.

![KaTeX math rendering](screenshots/06-math.png)

**Mermaid** — flowcharts, sequence diagrams, Gantt charts, state diagrams, class diagrams, pie charts — write the code and it renders automatically.

![Mermaid diagram rendering](screenshots/07-mermaid.png)

**Code highlighting** — 100+ languages auto-detected and colored, with a copy button on hover. Line numbers and word wrap are off by default and can be enabled in settings.

![Syntax highlighting](screenshots/08-code.png)

**GFM syntax, plus a few extras:**

| Feature | Description |
|---|---|
| Task lists | `- [ ]` `- [x]`, clickable in preview with source sync |
| Callouts | Note / Tip / Warning / Caution / Important |
| Highlight | `==text==` |
| Superscript / subscript | `<sup>x²</sup>` `<sub>x₂</sub>` |
| Footnotes | With back-links ↩ |
| Definition lists | term -> definition |
| Emoji shortcodes | `:rocket:` → 🚀 |
| Table of contents | `[TOC]` auto-generated |
| Abbreviations | `*[HTML]: HyperText...` |
| Smart punctuation | Auto-tunes Chinese & English punctuation |
| Tables, quotes, links, images | All supported |

![Five callout styles (Note / Tip / Important / Warning / Caution)](screenshots/09-callout.png)

---

## Themes and Fonts, Configured Your Way

Light, dark, or follow-system. When you switch, editor and preview change together — not a simple color inversion.

![Dark theme](screenshots/10-theme.png)

Five color schemes: Baseline, Warm Orange, Emerald, Midnight, Twilight Purple.

Fonts for editor, preview, and code blocks are set independently. Installed system fonts are listed in full with search (DengXian, Microsoft YaHei, PingFang, Source Han Sans... if it's installed, it's selectable), and you can import your own font files (ttf / otf / woff / woff2) with a live preview.

Hold `Ctrl` and scroll to scale editor and preview font sizes continuously — the value is remembered a few seconds after you release, so you never have to dive into settings for an off font size.

![Font settings](screenshots/11-font.png)

---

## Export Chores, Handled Too

- **DOCX** — the easy path for homework and submissions. Math and Mermaid diagrams are rasterized to images, task lists become ☑/☐, and code blocks and callouts are converted to inline styles Word understands. Images auto-scale proportionally: anything wider than 500px is capped at 500px, anything taller than a page shrinks to fit, and small images keep their original size rather than being upscaled — no blown-out pages, no smeared pixels. The whole conversion runs on a background thread, so large documents never freeze the UI.
- **HTML** — a single self-contained file with images inlined as base64 and KaTeX/highlight.js styles embedded. No external dependencies — send it to anyone and it opens.
- **Long PNG** — 800px wide, auto-height, at 2x sharpness. Ready to drop straight into blog posts or social feeds.
- **PDF** — via the system print dialog; headers/footers and background graphics are configurable, WYSIWYG layout.

None of the four require extra conversion tools like Pandoc.

![Export menu](screenshots/12-export.png)

---

## Toolbar and Shortcuts

Bold, italic, strikethrough, links, images, horizontal rules, highlight, superscript, subscript — the everyday ones are on the toolbar. The "Insert Structure" dropdown holds templates for tables, code blocks, blockquotes, math, Mermaid, and tables of contents. Lists, all six heading levels, and the five callout types are one click away too.

The toolbar folds away with one click. Whether Enter inserts a `<br>` or keeps paragraph spacing is configurable. The status bar shows live word counts.

Shortcuts like Ctrl+B for bold, Ctrl+S to save, and Ctrl+\ to toggle views can all be changed in the panel when they don't match your habits: click "Modify", press the new combination, done instantly. Tired of remapping one by one? Four presets are built in — **Default / VSCode / Typora / Sublime Text** — switch wholesale with one click. Coming from another editor, your muscle memory carries straight over.

![Custom shortcut settings](screenshots/13-shortcuts.png)

---

## Images

- Auto-dedup on paste (by MD5) — the same image pasted twice never gets stored twice
- Both local and network images supported
- Storage as "copy to assets/" or "embed as Base64": the former suits version control, the latter lets a single file be shared
- Relative (survives moving the folder) and absolute path modes
- Click an image in the preview to open a viewer with drag-pan, **cursor-anchored** scroll zoom, and double-click to reset

![Image insertion and settings](screenshots/14-image.png)

---

## Folder Workspace

Beyond single files, you can open a whole folder via `File → Open Folder` and browse it in the sidebar file tree, opening files on click. Changes made by external programs refresh automatically; if the file watcher ever drops, reconnect with one click.

The file tree's right-click menu covers full file operations: new, cut, copy, paste, rename, delete — and reveal-in-file-manager in one click. Tab context menus offer close-others/all, copy path, and reveal in folder.

![Folder workspace + sidebar file tree](screenshots/15-workspace.png)

---

## Long Documents Stay Smooth

Novels, notes, research archives — documents only get longer. Rendering is chunked with focus-windowed preview around the caret, and pure-preview mode uses virtual scrolling — only content near the current reading area is rendered, so the UI never chokes on a full-document render.

![Smooth large-document preview](screenshots/16-large.png)

---

## And the Details

Views: editor and preview fold independently — read source only, or read the finished render, whichever you prefer.

File handling: `.md` / `.markdown` file association opens on double-click; drag a file or folder into the window to open (batches welcome); recently opened files are tracked; if a file is changed by another program you're prompted to reload rather than silently overwritten; and after a restart your previous tabs and workspace are all still there.

System-level: a system tray is supported — closing the window can quit, minimize to tray, or ask each time; updates are checked silently on launch with a prompt and download progress when a new version exists; single-instance running — a second launch just focuses the existing window, and files handed to the new instance are opened by the running one.

Others: editor, preview, and tabs each have their own context menus (copy as HTML, copy path, close other tabs, and more); the UI switches between Chinese and English; a built-in rehype-sanitize pipeline filters HTML/CSS on rendered content to guard against XSS.

No account, no internet, fully usable offline.

---

## Download

- Gitee (fast in China): https://gitee.com/tizu/TizuMark-Markdown-Editor/releases
- GitHub: https://github.com/tizuio/TizuMark-Markdown-Editor/releases

**Windows** is available now; macOS and Linux are in progress.

Download the installer → double-click → open → start writing.

> On first install or after an upgrade, the app auto-opens a getting-started guide and a full syntax demo (`demo.md`) so you can get up to speed quickly without digging through docs. You can also reach it anytime under `Help → Guide`.

Completely free, every feature included after install. If you, too, think writing Markdown shouldn't start with half an hour of setup — give it a try.
