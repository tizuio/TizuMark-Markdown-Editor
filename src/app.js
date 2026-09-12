
// 共享常量、基础类型与平台桥接：见 src/modules/constants.js（modules 中最先加载）
const {
  MAX_PREVIEW_LINES,
  MAX_PREVIEW_CHARS,
  HEAD_RENDER_CHAR_CAP,
  PREVIEW_WINDOW_LINES,
  PREVIEW_WINDOW_LEAD,
  SLASH_FONT_ACTIONS,
  SLASH_FRONT_ACTIONS,
  DEFAULT_SLASH_HIDDEN,
  SYSTEM_FONT_WHITELIST,
  SYSTEM_FONT_WHITELIST_SET,
  FONT_NAME_LOCALE,
  EXPORT_CJK_FONT_TAIL,
  EXPORT_FALLBACK_SANS,
  FONT_LOCALE_REV,
  Tab,
  dialogOpen,
  dialogSave,
} = TMConst;
// 文案字典已随 i18n 域拆到 modules/i18n-data.js，i18n.js 仍重导出 I18N，启动引导的 tInit 直接查表
const { I18N } = TMI18n;

class MarkdownEditor {
  constructor() {
    this.untitledCounter = 1;
    this.tabs = [];
    this.activeTabIndex = 0;
    // 外部变更队列：在此先初始化为 []，作为异步 initFileWatcher 之前的兜底，
    // 避免初始化未完成时调用 enqueueExternalChange 触发 _externalQueue.includes 崩溃。
    this._externalQueue = [];
    this._externalBannerVisible = false;
    this.cm = null;
    this.workspaceFolder = null;
    this.expandedFolders = new Set();
    // 文件树右键菜单状态（合并自 PR #36）：_fileTreeCtx 为当前右键/点击目标 {path, isDir, nodeEl}；
    // _fileClipboard 为剪切/复制状态 {op:'cut'|'copy', path, isDir}，粘贴时据此调用 move/copy
    this._fileTreeCtx = null;
    this._fileClipboard = null;
    this.debounceTimer = null;
    this._imageURLCache = new Map(); // dataUri → Blob URL（LRU，上限 _imageURLCacheMax，超限 revoke）
    this._imageURLCacheMax = 64;
    this._imageBase64Cache = new Map(); // key: 绝对路径 → value: base64 data URI，省去每次打字跨 IPC 读磁盘
    this._hljsCache = new Map();
    this._mermaidCache = new Map(); // key: themeKey+'::'+code → 渲染后的 SVG innerHTML，避免打字时全量重渲染 mermaid
    this._renderGeneration = 0;
    this._mermaidGeneration = 0;
    this.previewWindow = null;       // 大文档窗口模式：{start, end}（0-based 源码行），普通文档为 null
    this.previewController = new PreviewController(this); // P2-1 Strangler facade（ADR-3）
    this._previewVirtual = false;    // 纯预览模式 + 大文档：虚拟滚动（spacer 撑高，可拖到任意位置）
    this._avgLineHeight = null;      // 虚拟滚动平均行高（首次渲染后校准一次，之后恒定）
    this._virtualRenderTimer = null; // 虚拟滚动重渲染 debounce 计时器
    this._previewScrollDriven = false; // 虚拟滚动：滚动驱动的重渲染保留 scrollTop（不回弹贴顶）
    this._previewSliceOffset = 0;    // 窗口切片起点（0-based），用于把 data-source-line 还原为绝对行号
    this._previewFocusLine = 0;      // 窗口焦点（0-based 源码行），决定窗口中心
    this._windowLineTops = null;     // 窗口模式下 [data-source-line] 元素相对预览内容顶部的像素偏移，用于定位
    this._linePositions = [{ line: 0, fraction: 0 }];
    this._blocks = [];
    this._previewChildrenCount = 0;
    this._editorPercent = null;
    this.isDark = false;
    this.viewMode = 'preview';
    this._sessionMdViewMode = null;  // 会话级 md 展示模式记忆：仅内存，不落盘；null=未记录（用 settings.defaultView）
    // 会话级「不再提醒」标志：仅本次应用运行期间有效，关闭应用后新会话自然复位为 false。
    // 注意：不在 switchTab / openFile 等处重置，否则会丢失用户在本次会话内的选择。
    this._largeFileNoticeSessionSuppressed = false;

    this.settings = this.loadSettings();
    this.shortcuts = this.loadShortcuts();
    this.shortcutScheme = this.loadShortcutScheme();
    this._recentFiles = [];
    this._recentSubmenuVisible = false;
    this.loadRecentFiles();
    this._recentWorkspaces = [];
    this.loadRecentWorkspaces();
    this.recordingAction = null;
    this.tabs.push(new Tab(this.t('untitled') + this.untitledCounter++));

    this.preview = document.getElementById('preview');
    if (this.preview) this.preview.style.scrollBehavior = 'auto';
    this.statusText = document.getElementById('status-text');
    this.cursorPosition = document.getElementById('cursor-position');
    this.wordCountEl = document.getElementById('word-count');
    this.previewWordCountEl = document.getElementById('preview-word-count');
    this.lineCountEl = document.getElementById('line-count');

    this.initEditor();
    this.applyShortcuts();
    this.initEventListeners();
    this.initResizer();
    this.initFindReplace();
    this.applyPreviewPaneWidth();
    this.initFileSearchModule();
    this.initScrollTopBtn();
    this.initExternalLinks();
    this.initDragDrop();
    this.initSettings();
    this.applyWindowBehavior();
    this.initShortcutsDialog();
    this.bindCollapseToggle();
    this.initDialogsDragResize();
    this.initCrossSearch();
    this.initOutline();
    this.initOutlineResizer();
    this.initSplitter();
    this.initPanelHeaders();
    this.initBreadcrumb();
    this.updateOutlineCheck();
    this.initContextMenu();
    this.initFormatToolbar();
    this.applySidebarState();
    this.initInsertDialogs();
    this.initImagePaste();
    this.initTabScroll();
    this.loadTheme();
    this.applySplitterRatio();
    this.updatePreview();
    this.applyViewMode();
    this.updateMaximizeIcon();
    this.updateWordCount();
    setTimeout(() => this.checkUpdate(false), 5000);
    this.updateSideButtons();
    this.initBackendHealth();
    this.applyLanguage();
  }
  showLoading() {
    this._loadingStart = Date.now();
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('hidden');
    overlay.offsetHeight;
  }
  async hideLoading() {
    const elapsed = Date.now() - (this._loadingStart || 0);
    const minDuration = 200;
    if (elapsed < minDuration) {
      await new Promise(r => setTimeout(r, minDuration - elapsed));
    }
    document.getElementById('loading-overlay').classList.add('hidden');
  }
  showPaneLoading() {
    const el = document.getElementById('pane-loading');
    if (el && el.classList.contains('hidden')) {
      this._paneLoadingStart = Date.now();
      el.classList.remove('hidden');
    }
  }
  async hidePaneLoading() {
    const el = document.getElementById('pane-loading');
    if (!el) return;
    const elapsed = Date.now() - (this._paneLoadingStart || 0);
    const minDuration = 180;
    if (elapsed < minDuration) {
      await new Promise(r => setTimeout(r, minDuration - elapsed));
    }
    el.classList.add('hidden');
  }
  // 引用计数的加载层控制：多次嵌套的「开始/结束」只在实际最外层结束（count 归零）时才隐藏，
  // 从而让大文件重渲染（可能跨多次 updatePreview 调用）期间 loading 持续可见
  _beginPaneLoad() {
    this._paneLoadingCount = (this._paneLoadingCount || 0) + 1;
    this.showPaneLoading();
  }
  _endPaneLoad() {
    this._paneLoadingCount = Math.max(0, (this._paneLoadingCount || 0) - 1);
    if (this._paneLoadingCount === 0) this.hidePaneLoading();
  }
  showLargeFileNotice(key, totalLines, totalChars) {
    // 会话级「不再提醒」：本次应用运行期间一旦点过，整轮生命周期内都不再弹（不含跨会话）。
    if (this._largeFileNoticeSessionSuppressed) return;
    // 纯预览模式使用虚拟滚动，可拖到任意位置查看全文，无需提示横幅
    if (this.viewMode === 'preview') { this.hideLargeFileNotice(); return; }
    if (this._largeFileNoticeDismissed && this._largeFileNoticeKey === key) return;
    const banner = document.getElementById('large-file-banner');
    const textEl = document.getElementById('large-file-banner-text');
    if (!banner || !textEl) return;
    const sizeMB = (totalChars / 1048576).toFixed(1);
    textEl.textContent = this.t('largeFileNotice', { lines: totalLines, size: sizeMB });
    banner.classList.remove('hidden');
    this._largeFileNoticeKey = key;
  }
  hideLargeFileNotice() {
    const banner = document.getElementById('large-file-banner');
    if (banner) banner.classList.add('hidden');
    this._largeFileNoticeKey = null;
  }
  get activeTab() {
    return this.tabs[this.activeTabIndex];
  }
  // 事件绑定只做「DOM 事件 → 功能方法」的路由，具体交互实现分散在 modules/ 各功能模块。
  // 新增事件请就近放进对应模块，不要往这里堆。
  initEventListeners() {
    this.initToolbarMenus();        // misc-ui
    this.initTabDragEvents();       // tabs
    this.initMenuButtons();         // 本文件：菜单按钮路由表
    this.initOutlineFilter();       // layout
    this.initRecentMenus();         // tabs
    this.initFolderSortControls();  // files
    this.initViewControls();        // layout
    this.initDialogDismiss();       // misc-ui
    this.initWindowControls();      // updater
    this.initAppLifecycleEvents();  // 本文件
    // 全局键盘在捕获阶段统一派发，内部按优先级短路（见 _handleGlobalKeydown）
    document.addEventListener('keydown', (e) => this._handleGlobalKeydown(e), true);
  }

  // 点击后先收起所属下拉菜单，再执行动作（原来这段「加 hidden」的样板重复了 8 次）
  _bindMenuAction(id, fn, closeMenu = null) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      if (closeMenu) {
        const m = document.getElementById(closeMenu);
        if (m) m.classList.add('hidden');
      }
      fn();
    });
  }

  // 菜单 / 工具栏按钮 → 功能方法的路由表
  initMenuButtons() {
    const F = 'file-menu';
    const H = 'help-menu';
    this._bindMenuAction('btn-sidebar-toggle', () => this.toggleSidebar());
    this._bindMenuAction('btn-new', () => this.newFile(), F);
    this._bindMenuAction('btn-add-tab', () => this.newFile());
    this._bindMenuAction('btn-open', () => this.openFile(), F);
    this._bindMenuAction('btn-open-folder', () => this.openFolder(), F);
    this._bindMenuAction('btn-save', () => this.saveFile(), F);
    this._bindMenuAction('btn-save-as', () => this.saveAsFile(), F);
    this._bindMenuAction('btn-reload', () => this.reloadFile());
    this._bindMenuAction('btn-reload-menu', () => this.reloadFile(), F);
    this._bindMenuAction('btn-export-html', () => this.exportHTML(), F);
    this._bindMenuAction('btn-export-img', () => this.exportImage(), F);
    this._bindMenuAction('btn-export-pdf', () => this.exportPDF(), F);
    this._bindMenuAction('btn-export-word', () => this.exportWord(), F);
    this._bindMenuAction('btn-settings', () => this.showSettings(), F);
    this._bindMenuAction('btn-theme', () => this.toggleTheme());
    this._bindMenuAction('btn-user-guide', () => this.openUserGuide(), H);
    this._bindMenuAction('btn-about', () => this.showAbout(), H);
    this._bindMenuAction('btn-check-update', () => this.checkUpdate(true), H);
    this._bindMenuAction('btn-devtools', () => {
      try {
        TauriApi.toggleDevtools();
      } catch (e) {
        this.reportError('devtools');
      }
    }, H);
    const tabBar = document.querySelector('.tab-bar-wrapper');
    if (tabBar) {
      tabBar.addEventListener('dblclick', (e) => {
        if (!e.target.closest('.tab') && !e.target.closest('.tab-add')) this.newFile();
      });
    }
  }

  initAppLifecycleEvents() {
    window.addEventListener('resize', () => {
      this.updateMaximizeIcon();
      this.updateSideButtons();
    });

    // 应用退出时全量 revoke Blob URL，避免 WebView 存活期内泄漏（LRU 兜底外的一刀切）
    window.addEventListener('beforeunload', () => {
      if (this._imageURLCache && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        for (const url of this._imageURLCache.values()) URL.revokeObjectURL(url);
        this._imageURLCache.clear();
      }
    });
  }

  // 全局键盘派发：按优先级短路，子处理器返回 true 表示已消费事件。
  // 顺序与原单一 handler 内的 if/return 链完全一致，不可调换。
  _handleGlobalKeydown(e) {
    if (this.handleShortcutRecording(e)) return;
    if (this._handleSlashKeydown(e)) return;
    if (this._handleFileTreeKeydown(e)) return;
    if (this._handleKeydownBlocklist(e)) return;
    this._dispatchGlobalShortcut(e);
  }
  executeMenuAction(action) {
    switch (action) {
      case 'cut': { const s = this.cm.getSelection(); if (s) { navigator.clipboard.writeText(s); this.cm.replaceSelection(''); } this.cm.focus(); break; }
      case 'copy': { const s = this.cm.getSelection(); if (s) navigator.clipboard.writeText(s); this.cm.focus(); break; }
      case 'paste': { navigator.clipboard.readText().then(t => { if (t) this.cm.replaceSelection(t); }).catch(() => {}); this.cm.focus(); break; }
      case 'find-replace': this.toggleFindPanel(true); break;
      case 'select-all': this.cm.execCommand('selectAll'); break;

      case 'insert-bold': this.wrapSelection('**', '**'); break;
      case 'insert-italic': this.wrapSelection('*', '*'); break;
      case 'insert-strikethrough': this.wrapSelection('~~', '~~'); break;
      case 'insert-inline-code': this.wrapSelection('`', '`'); break;
      case 'insert-highlight': this.wrapSelection('==', '=='); break;
      case 'insert-superscript': this.wrapSelection('<sup>', '</sup>'); break;
      case 'insert-subscript': this.wrapSelection('<sub>', '</sub>'); break;

      case 'insert-h1': this.applyHeadingLevel(1); break;
      case 'insert-h2': this.applyHeadingLevel(2); break;
      case 'insert-h3': this.applyHeadingLevel(3); break;
      case 'insert-h4': this.applyHeadingLevel(4); break;
      case 'insert-h5': this.applyHeadingLevel(5); break;
      case 'insert-h6': this.applyHeadingLevel(6); break;

      case 'insert-code-block': this.insertBlock('```javascript\n// code here\n```', 14); break;
      case 'insert-table': this.insertBlock('| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |', 2); break;
      case 'insert-quote': this.insertLinePrefix('> '); break;
      case 'insert-math-block': this.insertBlock('$$\nE = mc^2\n$$', 3); break;
      case 'insert-mermaid': this.insertBlock('```mermaid\ngraph TD\n    A[开始] --> B[结束]\n```', 11); break;
      case 'insert-hr': this.insertBlock('---'); break;
      case 'insert-toc': this.insertBlock('[TOC]'); break;

      case 'insert-callout-note': this.insertBlock('> [!NOTE]\n> 提示内容', 12); break;
      case 'insert-callout-tip': this.insertBlock('> [!TIP]\n> 建议内容', 11); break;
      case 'insert-callout-warning': this.insertBlock('> [!WARNING]\n> 警告内容', 15); break;
      case 'insert-callout-caution': this.insertBlock('> [!CAUTION]\n> 注意内容', 15); break;
      case 'insert-callout-important': this.insertBlock('> [!IMPORTANT]\n> 重要内容', 17); break;

      case 'insert-ul': this.insertLinePrefix('- '); break;
      case 'insert-ol': this.insertLinePrefix('1. ', true); break;
      case 'insert-task': this.insertLinePrefix('- [ ] '); break;

      case 'insert-link': this.showInsertLinkDialog(); break;
      case 'insert-image': this.showInsertImageDialog(); break;

      case 'preview-copy': { const s = window.getSelection(); if (s && s.toString()) navigator.clipboard.writeText(s.toString()).catch(() => {}); break; }
      case 'preview-select-all': { const range = document.createRange(); range.selectNodeContents(this.preview); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); break; }
      case 'preview-copy-html': { const sel = window.getSelection(); if (sel.rangeCount > 0) { const range = sel.getRangeAt(0); const frag = range.cloneContents(); const div = document.createElement('div'); div.appendChild(frag); navigator.clipboard.writeText(div.innerHTML); } break; }
      case 'preview-find': this.toggleFindPanel(); break;

      case 'tab-close': this.closeTab(this._contextTabIndex); break;
      case 'tab-close-others': this.closeOtherTabs(this._contextTabIndex); break;
      case 'tab-close-all': this.closeAllTabs(); break;
      case 'tab-copy-path': this.copyTabPath(this._contextTabIndex); break;
      case 'tab-open-containing': this.openTabContainingFolder(this._contextTabIndex); break;

      case 'folder-open-containing': this.openContainingFolder(this._folderCtxPath, this._folderCtxIsDir); break;
      case 'folder-copy-path': this.copyPath(this._folderCtxPath); break;

      // 文件树右键菜单动作（合并自 PR #36）
      case 'file-new-file': this.fileTreeNewFile(); break;
      case 'file-new-folder': this.fileTreeNewFolder(); break;
      case 'file-cut': this.fileTreeCut(); break;
      case 'file-copy': this.fileTreeCopy(); break;
      case 'file-paste': this.fileTreePaste(); break;
      case 'file-rename': this.fileTreeRename(); break;
      case 'file-copy-path': this.fileTreeCopyPath(); break;
      case 'file-delete': this.fileTreeDelete(); break;
    }
  }
}

// ====== 功能模块组装（Strangler：方法体已搬到 modules，此处只做挂载）======
Object.assign(MarkdownEditor.prototype, TMI18n.mixin);
Object.assign(MarkdownEditor.prototype, TMSettings.mixin);
Object.assign(MarkdownEditor.prototype, TMLayout.mixin);
Object.assign(MarkdownEditor.prototype, TMTheme.mixin);
Object.assign(MarkdownEditor.prototype, TMFont.mixin);
Object.assign(MarkdownEditor.prototype, TMShortcuts.mixin);
Object.assign(MarkdownEditor.prototype, TMEditorCore.mixin);
Object.assign(MarkdownEditor.prototype, TMTabs.mixin);
Object.assign(MarkdownEditor.prototype, TMFind.mixin);
Object.assign(MarkdownEditor.prototype, TMMiscUI.mixin);
Object.assign(MarkdownEditor.prototype, TMFiles.mixin);
Object.assign(MarkdownEditor.prototype, TMExport.mixin);
Object.assign(MarkdownEditor.prototype, TMPreviewSync.mixin);
Object.assign(MarkdownEditor.prototype, TMNotify.mixin);
Object.assign(MarkdownEditor.prototype, TMUpdater.mixin);
Object.assign(MarkdownEditor.prototype, TMFormat.mixin);
Object.assign(MarkdownEditor.prototype, TMCtxMenu.mixin);
Object.assign(MarkdownEditor.prototype, TMSlash.mixin);
Object.assign(MarkdownEditor.prototype, TMLifecycle.mixin);
Object.assign(MarkdownEditor.prototype, TMToolbar.mixin);
Object.assign(MarkdownEditor, TMExport.statics);


function updateLoadingProgress(percent, text) {
  document.getElementById('loading-progress-fill').style.width = Math.min(100, Math.max(0, percent)) + '%';
  const textEl = document.getElementById('loading-text');
  if (textEl && text) textEl.textContent = text;
}

// 初始化阶段（window.editor 未创建）读取当前语言：settings 尚未加载，直接从持久化读
function tInit(key) {
  let lang = 'zh';
  try {
    const saved = JSON.parse(localStorage.getItem('tizumark-settings') || '{}');
    if (saved && saved.language === 'en') lang = 'en';
  } catch (_) {}
  return I18N[lang][key] !== undefined ? I18N[lang][key] : I18N.zh[key] || key;
}

function initEula() {
  const eulaAccepted = localStorage.getItem('tizumark-eula-accepted');
  if (eulaAccepted === 'true') {
    document.getElementById('eula-dialog').classList.add('hidden');
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const overlay = document.getElementById('eula-dialog');
    const acceptBtn = document.getElementById('eula-accept');

    overlay.classList.remove('hidden');

    const autoAccept = () => {
      localStorage.setItem('tizumark-eula-accepted', 'true');
      overlay.classList.add('hidden');
      console.warn('EULA auto-accepted after timeout');
      resolve(true);
    };

    const autoTimer = setTimeout(autoAccept, 20000);

    const gplLink = overlay.querySelector('.gpl-link');
    if (gplLink) {
      gplLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.open('https://www.gnu.org/licenses/gpl-3.0.html', '_blank');
      });
    }

    acceptBtn.addEventListener('click', () => {
      clearTimeout(autoTimer);
      localStorage.setItem('tizumark-eula-accepted', 'true');
      overlay.classList.add('hidden');
      resolve(true);
    });
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  // 防重入：DOMContentLoaded 只允许初始化一次（jsdom 测试环境会自然触发 + 手动派发各一次，
  // 双重初始化会重复注册 file-open/drag-drop 等监听，导致确认框弹两次等问题）
  if (window.__tizumarkInited) return;
  window.__tizumarkInited = true;
  // 安全兜底：20 秒后强制隐藏加载遮罩，防止任何异常导致卡死
  const loadingSafetyTimer = setTimeout(() => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      overlay.classList.add('hidden');
      console.warn('Loading overlay force-hidden by safety timeout (20s)');
    }
  }, 20000);

  try {
    updateLoadingProgress(5, tInit('progressCheckingEula'));
    const isFirstLaunch = await initEula();

    updateLoadingProgress(15, tInit('progressInitEditor'));
    window.editor = new MarkdownEditor();
    window.editor._loadingStart = Date.now();

    updateLoadingProgress(60, tInit('progressRegisterEvents'));
    // 代码块按需滚动：preview 出现/替换 .code-scroll 时自动跑后处理（rAF 去抖）。
    // LiveReload 推新 JS 后已渲染的代码块不会重新触发 render，单靠 render 末尾调用
    // 会漏掉；MutationObserver 兜底所有时机（含初次加载、async 替换、LiveReload 后）。
    const pruneCodeScrolls = () => {
      if (!window.editor || !window.editor.preview) return;
      window.editor.preview.querySelectorAll('.code-scroll').forEach((el) => {
        // 必须显式 'auto'：CSS 默认是 hidden（防 Windows always-show 滚动条轨道），
        // 清空 inline 会让 CSS 接管 → 仍 hidden → 永远没滚动条
        el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : 'hidden';
      });
    };
    new MutationObserver(() => requestAnimationFrame(pruneCodeScrolls))
      .observe(window.editor.preview, { childList: true, subtree: true });
    await TauriApi.onEvent('close-requested', async () => {
      await window.editor.handleAppClose();
    });

    // 工作区目录树随外部文件增删自动刷新（由 Rust watch_folder 广播 folder-changed 事件）
    await TauriApi.onEvent('folder-changed', () => {
      if (window.editor) window.editor._scheduleTreeRefresh();
    });

    // 文件夹监听异常（Rust watch_folder 回调 panic，已由 catch_unwind 兜住监听不中断）：
    // 弹窗提示用户手动「重新监听 / 继续使用」——不做自动重挂，避免失败风暴
    await TauriApi.onEvent('folder-watch-error', (event) => {
      if (window.editor) window.editor._handleFolderWatchError(event);
    });

    await TauriApi.onEvent('file-open', async (event) => {
      const args = event.payload;
      if (!args || args.length === 0) return;

      try {
        const w = TauriApi.currentWindow();
        await w.unminimize();
        await w.show();
        await w.setFocus();
      } catch (_) {}

      // 二次实例传参：目录进工作区（已有不同工作区时弹确认），文件开 tab。
      // 注意：不要在此先 showLoading——加载遮罩 z-index(10000) 会盖住确认框，
      // 导致切换工作区确认框点不到而卡在加载页；加载由 openFolderPath 内部负责。
      await window.editor.openPathsSmart(args);
    });

    updateLoadingProgress(85, tInit('progressLoadingFile'));
    try {
      const args = await TauriApi.getCliArgs();
      const hadSession = await window.editor.restoreSession();
      let currentVersion = '';
      if (args && args.length > 0) {
        // 启动 CLI 参数：命令行显式指定目录，直接作为工作区打开（不弹确认）
        await window.editor.openPathsSmart(args, { confirmWorkspaceSwitch: false });
      } else {
        // 首次安装 / 升级后首次打开：自动展示使用说明和 demo.md
        const lastVersion = localStorage.getItem('tizumark-app-version');
        try {
          currentVersion = await TauriApi.getVersion();
        } catch (_) { /* fallback 到静默跳过 */ }
        if (isFirstLaunch || (currentVersion && lastVersion !== currentVersion)) {
          window.editor.openUserGuide();
          // 同步打开 demo.md（使用说明内嵌的 demo.md 链接已可手动点开，
          // 此处自动打开省去用户多一步点击）
          try {
            const result = await TauriApi.readBundledFile({ filename: 'demo.md' });
            const demoContent = result && typeof result === 'object' ? result.content : result;
            const demoPath = result && typeof result === 'object' ? result.path : 'demo.md';
            if (demoContent && !demoContent.trim().startsWith('<!DOCTYPE') && !demoContent.trim().startsWith('<html')) {
              await window.editor._openBundledFile('demo.md', demoContent, demoPath);
            }
          } catch (_) {
            // demo.md 读取失败不影响主功能
          }
        }
      }
      // 持久化当前应用版本，供下次启动比对
      if (currentVersion) {
        localStorage.setItem('tizumark-app-version', currentVersion);
      }
    } catch (e) {
      console.warn('Failed to load session / cli args:', e);
    }

    updateLoadingProgress(100, tInit('progressReady'));
    await window.editor.initFileWatcher();
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    console.error('Initialization error:', e);
    // 初始化异常对用户可见（否则整页空白无提示）；toast:false 避免依赖尚未就绪的 UI，改用页面顶部错误条
    try {
      if (window.editor && window.editor.reportError) {
        window.editor.reportError('E_INIT', { error: e, toast: false });
      }
      const bar = document.createElement('div');
      bar.className = 'fatal-error-bar';
      bar.textContent = '编辑器初始化失败，请重启应用。如反复出现，请将此界面截图反馈给开发者。';
      // 固定底部条，不遮挡 Tauri 标题栏/窗口控制按钮/工具栏菜单
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:100000;' +
        'background:#b00020;color:#fff;font:12px/1.5 system-ui,-apple-system,sans-serif;' +
        'padding:8px 14px;box-shadow:0 -2px 6px rgba(0,0,0,.25);';
      document.body.appendChild(bar);
    } catch (_) {}
  } finally {
    clearTimeout(loadingSafetyTimer);
    window.editor?.hideLoading();
  }
});
