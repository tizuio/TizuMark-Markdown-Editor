// 国际化：界面文案填充逻辑（从 src/app.js 拆分而来，方法体原样搬运，经 mixin 挂到
// MarkdownEditor.prototype，因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调）。
// 字典数据已拆到 i18n-data.js，本文件只负责 t() 取值/插值与 applyLanguage() 界面填充。
(function () {
  'use strict';
  const { Tab } = TMConst;
  const { I18N, ERROR_MESSAGES } = TMI18nData;

  const mixin = {
      t(key, params = {}) {
        const lang = this.settings.language === 'en' ? 'en' : 'zh';
        let text = I18N[lang][key];
        if (text === undefined) {
          text = I18N.zh[key] || key;
        }
        if (text && params) {
          for (const [k, v] of Object.entries(params)) {
            text = text.replace('{' + k + '}', v);
          }
        }
        return text;
      },
      applyLanguage() {
        const t = (k, p) => this.t(k, p);
        const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        const setPlaceholder = (id, text) => { const el = document.getElementById(id); if (el) el.placeholder = text; };
        const setTitle = (id, text) => { const el = document.getElementById(id); if (el) el.title = text; };
  
        // Toolbar buttons — skip the dropdown-arrow span, target the label span
        const updateToolbarBtn = (btnId, text) => {
          const btn = document.getElementById(btnId);
          if (!btn) return;
          const span = btn.querySelector('span:not(.dropdown-arrow)');
          if (span) span.textContent = text;
        };
        updateToolbarBtn('btn-file', t('file'));
        updateToolbarBtn('btn-view', t('view'));
        updateToolbarBtn('btn-help', t('help'));
  
        // File menu items
        // Use direct approach for menu items
        const updateMenuText = (id, text) => {
          const el = document.getElementById(id);
          if (!el) return;
          const span = el.querySelector('span:not(.shortcut):not(.icon)');
          if (span) span.textContent = text;
        };
  
        updateMenuText('btn-new', t('new'));
        updateMenuText('btn-open', t('open'));
        updateMenuText('btn-recent', t('recentFiles'));
        updateMenuText('btn-recent-workspaces', t('recentWorkspaces'));
        updateMenuText('btn-save', t('save'));
        updateMenuText('btn-save-as', t('saveAs'));
        updateMenuText('btn-export-html', t('exportHTML'));
        updateMenuText('btn-export-img', t('exportImg'));
        updateMenuText('btn-export-pdf', t('exportPDF'));
        updateMenuText('btn-export-word', t('exportWord'));
        updateMenuText('btn-shortcuts', t('shortcuts'));
        updateMenuText('btn-settings', t('settings'));
        updateMenuText('btn-user-guide', t('userGuide'));
        updateMenuText('btn-about', t('about'));
        updateMenuText('btn-open-folder', t('openFolder'));
        updateMenuText('btn-reload-menu', t('reloadFile'));
        updateMenuText('btn-check-update', t('checkUpdate'));
        updateMenuText('btn-devtools', t('devtools'));
  
        // View mode tabs
        updateMenuText('btn-view-preview', t('preview'));
        updateMenuText('btn-view-edit', t('edit'));
  
        // Theme button
        setText('theme-text', this.isDark ? t('themeDark') : t('themeLight'));
  
        // Window controls
        setTitle('btn-minimize', t('minimize'));
        setTitle('btn-maximize', t('maximize'));
        setTitle('btn-close', t('close'));
  
        // Status bar
        setText('status-text', t('ready'));
        document.getElementById('word-count').textContent = t('words') + ': 0';
        document.getElementById('preview-word-count').textContent = t('previewWords') + ': 0';
        document.getElementById('line-count').textContent = t('lines') + ': 0';
        if (this.cm) {
          const cur = this.cm.getCursor();
          document.getElementById('cursor-position').textContent = this.t('cursorPos', { line: cur.line + 1, col: cur.ch + 1 });
        }
  
        // Drag overlay
        setText('drag-overlay', t('dropFileHere'));
  
        // ARIA labels
        const tabBar = document.getElementById('tab-bar');
        if (tabBar) tabBar.setAttribute('aria-label', t('tablistLabel'));
        document.querySelectorAll('.dialog-close').forEach(btn => {
          btn.setAttribute('aria-label', t('closeAria'));
        });
  
        // Settings dialog — use form element IDs as stable anchors
        document.querySelector('#settings-dialog .dialog-header h2').textContent = t('settings');
        const setSectionTitle = (anchorId, text) => {
          const el = document.getElementById(anchorId);
          if (el) { const name = el.closest('.settings-section').querySelector('.settings-section-name'); if (name) name.textContent = text; }
        };
        const setRowLabel = (formId, text) => {
          const el = document.getElementById(formId);
          if (el) { const label = el.closest('.settings-row').querySelector(':scope > label:not(.toggle)'); if (label) label.textContent = text; }
        };
        setSectionTitle('set-language', t('basic'));
        setRowLabel('set-language', t('language'));
        setRowLabel('set-theme-mode', t('themeMode'));
        setRowLabel('set-color-scheme', t('colorScheme'));
        setRowLabel('set-font-size', t('fontSize'));
        setRowLabel('set-tab-size', t('tabSize'));
        setRowLabel('set-line-wrap', t('lineWrap'));
        setRowLabel('set-line-numbers', t('lineNumbers'));
        setRowLabel('set-preview-font-size', t('previewFontSize'));
        setRowLabel('set-line-height', t('lineHeight'));
        // 编辑器 / 预览 分组的标题条用各自分组内稳定控件锚定（字号滑块已移入「自定义字体」分组，
        // 不能再以 set-font-size / set-preview-font-size 为锚点，否则会把「自定义字体」分组标题误改名）
        setSectionTitle('set-tab-size', t('editor'));
        setSectionTitle('set-line-height', t('previewSection'));
        setRowLabel('set-max-width', t('maxWidth'));
        setSectionTitle('set-default-view', t('behavior'));
        setRowLabel('set-default-view', t('defaultView'));
        setRowLabel('set-scroll-sync', t('scrollSync'));
        setRowLabel('set-soft-breaks', t('softBreaks'));
        setRowLabel('set-extended-syntax', t('extendedSyntax'));
        setRowLabel('set-code-line-numbers', t('codeLineNumbers'));
        setRowLabel('set-code-wrap', t('codeBlockWrap'));
        setRowLabel('set-code-scroll', t('codeScroll'));
        setRowLabel('set-custom-bg', t('customBg'));
        setRowLabel('set-close-action', t('closeAction'));
        setRowLabel('set-clear-tabs-on-quit', t('clearTabsOnQuit'));
        setRowLabel('set-show-tray-icon', t('showTrayIcon'));
        setRowLabel('set-show-all-files-label', t('showAllFiles'));
        setRowLabel('set-image-store-mode-label', t('imageSettingLabel'));
        setRowLabel('set-image-asset-path-mode-label', t('imageAssetPathLabel'));
        setSectionTitle('btn-add-font', t('customFonts'));
        setSectionTitle('btn-manage-slash', t('quickInsert'));
        setText('btn-manage-slash', t('manageQuickInsert'));
        const qiSection = document.getElementById('btn-manage-slash');
        if (qiSection) { const qiHint = qiSection.closest('.settings-section').querySelector('.form-hint .hint-text'); if (qiHint) qiHint.textContent = t('quickInsertHint'); }
        setText('slash-order-title', t('quickInsertOrder'));
        const soHint = document.querySelector('#slash-order-dialog .form-hint .hint-text');
        if (soHint) soHint.textContent = t('quickInsertOrderHint');
        setText('slash-order-reset', t('resetDefault'));
        setText('slash-order-done', t('quickInsertOrderDone'));
        setRowLabel('set-editor-font', t('editorFont'));
        setRowLabel('set-preview-font', t('previewFont'));
        setRowLabel('set-code-font', t('codeFont'));
        setRowLabel('set-ui-font-size', t('uiFontSize'));
        setRowLabel('set-preview-font-weight', t('previewFontWeight'));
        setRowLabel('set-editor-font-weight', t('editorFontWeight'));
        const softBreaksHint = document.querySelector('#setting-soft-breaks-hint .hint-text');
        if (softBreaksHint) softBreaksHint.textContent = t('softBreaksHint');
        const ctoqHint = document.querySelector('#setting-clear-tabs-on-quit-hint .hint-text');
        if (ctoqHint) ctoqHint.textContent = t('clearTabsOnQuitHint');
        const extendedSyntaxHint = document.querySelector('#setting-extended-syntax-hint .hint-text');
        if (extendedSyntaxHint) extendedSyntaxHint.textContent = t('extendedSyntaxHint');
        const tabSizeHint = document.querySelector('#setting-tab-size-hint .hint-text');
        if (tabSizeHint) tabSizeHint.textContent = t('tabSizeHint');
        const codeScrollHint = document.querySelector('#setting-code-scroll-hint .hint-text');
        if (codeScrollHint) codeScrollHint.textContent = t('codeScrollHint');
        const trayHint = document.querySelector('#setting-show-tray-icon-hint .hint-text');
        if (trayHint) trayHint.textContent = t('showTrayIconHint');
        const allFilesHint = document.querySelector('#setting-show-all-files-hint .hint-text');
        if (allFilesHint) allFilesHint.textContent = t('showAllFilesHint');
        document.querySelector('#setting-image-store-hint .hint-text').textContent = t('imageSettingHint');
        const assetPathHint = document.querySelector('#setting-image-asset-path-hint-text');
        if (assetPathHint) assetPathHint.innerHTML = t('imageAssetPathRelativeHint');
        document.getElementById('settings-reset').textContent = t('resetDefault');
        // 语言/界面文本刷新时跳过处于 loading 态的按钮：否则 applyPendingSettings 内部的
        // applyLanguage() 会在保存/应用进行中把按钮文案重置回「保存/应用」，让 spinner +
        // 「保存中…」只显示不到一帧（本地同步落盘极快），视觉上等于没有 loading。
        const applyBtn = document.getElementById('settings-apply-btn');
        if (applyBtn && !applyBtn.classList.contains('is-loading')) applyBtn.textContent = t('apply');
        const saveBtn = document.getElementById('settings-save-btn');
        if (saveBtn && !saveBtn.classList.contains('is-loading')) saveBtn.textContent = t('save');
        document.getElementById('settings-close-x').setAttribute('aria-label', t('cancel'));
        document.getElementById('confirm-dialog-confirm').textContent = t('confirm');
        document.getElementById('confirm-dialog-cancel').textContent = t('cancel');
        // 配色方案自绘下拉：随语言刷新选项文案（optionsProvider 依赖注入 t）
        if (this._selects && this._selects.colorScheme) this._selects.colorScheme.applyI18n(t);
        // 三个字体 FontPicker 的 i18n（占位符/默认项/无匹配文案）；须 bind(this) 否则 t 的 this 指向 FontPicker
        for (const k of ['editor', 'preview', 'code']) {
          const p = this._fontPickers && this._fontPickers[k];
          if (p) p.applyI18n(this.t.bind(this));
        }
        // 语言切换后刷新系统字体显示名（中文 UI 显示「微软雅黑」，英文 UI 显示 Microsoft YaHei）
        this.refreshFontSelectors();
        // 系统字体加载失败重试按钮文案
        const retryBtn = document.getElementById('btn-retry-system-fonts');
        if (retryBtn) retryBtn.textContent = t('systemFontsRetry');
        this.populateSchemeSelect();
  
        // 跨文件搜索弹框文案
        const csText = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
        csText('cs-title', 'crossSearchTitle');
        csText('cs-label-open', 'scopeOpenFiles');
        csText('cs-label-dir', 'scopeDir');
        csText('cs-label-case', 'caseSensitive');
        csText('cs-label-regex', 'regex');
        csText('cs-label-loop', 'loopSearch');
        csText('cs-browse', 'csBrowse');
        csText('cs-run', 'csRun');
        const csQuery = document.getElementById('cs-query');
        if (csQuery) csQuery.placeholder = t('csQueryPlaceholder');
  
        // Update tab bar
        this.updateTabBar();
        this.updateWordCount();
        this.updateOutline();
  
        // Toolbar / panel title attributes（2026-08-04 i18n 补漏）
        setTitle('btn-reload', t('reloadFile'));
        setTitle('btn-theme', t('toggleTheme'));
        setTitle('fmt-collapse', t('collapseExpandToolbar'));
        setTitle('outline-close', t('close'));
        setTitle('folder-close', t('closeFolder'));
        // 文件目录排序下拉文案随语言刷新由 _folderSortSelect.applyI18n 统一处理（见下方 SETTINGS DROPDOWN OPTIONS）
        this.updateFolderSortOrderButton();
        this.updateFolderMenuLabel();
        setTitle('large-file-banner-close', t('closeNotice'));
        setTitle('large-file-banner-dont-remind', t('dontRemind'));
        // fmt-icon-btn 系列（加粗/斜体/删除线/链接/图片/水平线/高亮/上标/下标）
        const fmtActionTitleKeys = {
          'insert-bold': 'bold',
          'insert-italic': 'italic',
          'insert-strikethrough': 'strikethrough',
          'insert-link': 'link',
          'insert-image': 'image',
          'insert-hr': 'hr',
          'insert-highlight': 'highlight',
          'insert-superscript': 'superscript',
          'insert-subscript': 'subscript',
        };
        document.querySelectorAll('#format-toolbar .fmt-icon-btn[data-action]').forEach(el => {
          const key = fmtActionTitleKeys[el.dataset.action];
          if (key) el.title = t(key);
        });
  
        // Insert-link dialog
        setText('insert-link-title', t('insertLink'));
        setText('insert-link-text-label', t('linkText'));
        setText('insert-link-url-label', t('linkUrl'));
        setText('insert-link-cancel', t('cancel'));
        setText('insert-link-ok', t('ok'));
  
        // Insert-image dialog
        setText('insert-image-title', t('insertImage'));
        setText('insert-image-source-label', t('imageSource'));
        if (this._imageSourceSelect) this._imageSourceSelect.applyI18n(t);
        setText('insert-image-file-label', t('file'));
        setText('insert-image-browse', t('browse'));
        setText('insert-image-url-label', t('imageUrlLabel'));
        setText('insert-image-alt-label', t('imageAltLabel'));
        setText('insert-image-cancel', t('cancel'));
        setText('insert-image-ok', t('ok'));
        // 自定义字体导入按钮（省略号后缀）
        setText('btn-add-font', t('addFont') + '…');
  
        // Close-confirm dialog
        setText('close-dialog-title', t('closeAppTitle'));
        setText('close-dialog-msg', t('closeAppMsg'));
        setText('close-dialog-remember-label-text', t('rememberChoice'));
        setText('close-dialog-minimize', t('minimizeToTray'));
        setText('close-dialog-quit', t('quitApp'));
  
        // Update dialog 静态文本（标题随状态由 showUpdateState 动态设置）
        setText('update-state-checking-text', t('updateChecking'));
        setText('update-available-suffix', t('updateAvailableSuffix'));
        setText('update-current-version-label', t('updateCurrentVersionLabel'));
        setText('update-notes-title', t('updateNotes'));
        setText('update-latest-title', t('updateLatest'));
        setText('update-latest-prefix', t('updateLatestPrefix'));
        setText('update-latest-suffix', t('updateLatestSuffix'));
        setText('update-skip', t('updateSkip'));
        setText('update-action', t('updateChecking'));
  
        // 跨文件搜索：目录路径 placeholder 补漏
        setPlaceholder('cs-dir', t('csDirPlaceholder'));
  
        // Side buttons
        this.applyViewMode();
  
        // About dialog（4 个折叠块：版本信息/联系我们/许可协议/第三方组件）
        document.querySelector('#about-dialog .dialog-header h2').textContent = t('aboutTitle');
        const aboutSections = document.querySelectorAll('#about-dialog .dependency-details');
        if (aboutSections.length >= 1) {
          const title = aboutSections[0].querySelector('.dependency-title .dependency-name');
          if (title) title.textContent = t('version');
          const sec = aboutSections[0];
          const appNameEl = sec.querySelector('.about-app-name');
          if (appNameEl) appNameEl.textContent = t('appName');
          const verEl = sec.querySelector('#about-version');
          if (verEl) verEl.textContent = 'v' + t('appVersion');
          const descEl = sec.querySelector('#about-version-desc');
          if (descEl) descEl.textContent = t('versionDesc');
          const buildEl = sec.querySelector('#about-build');
          if (buildEl) buildEl.textContent = t('buildInfo');
        }
        if (aboutSections.length >= 2) {
          const title = aboutSections[1].querySelector('.dependency-title .dependency-name');
          if (title) title.textContent = t('contact');
          const contactDesc = aboutSections[1].querySelector('.contact-desc');
          const qqLabel = aboutSections[1].querySelector('.qq-label');
          const qqJoinText = aboutSections[1].querySelector('.qq-join-text');
          const qqBadge = document.getElementById('qq-group-badge');
          if (contactDesc) contactDesc.textContent = t('contactDesc');
          if (qqLabel) qqLabel.textContent = t('qqGroupName');
          if (qqJoinText) qqJoinText.textContent = t('joinGroup');
          if (qqBadge) qqBadge.title = t('qqTitle');
          const giteeAction = aboutSections[1].querySelector('.gitee-action');
          const giteeBadge = document.getElementById('gitee-badge');
          if (giteeAction) giteeAction.textContent = t('giteeAction');
          if (giteeBadge) giteeBadge.title = t('giteeTitle');
          const githubAction = aboutSections[1].querySelector('.github-action');
          const githubBadge = document.getElementById('github-badge');
          if (githubAction) githubAction.textContent = t('githubAction');
          if (githubBadge) githubBadge.title = t('githubTitle');
        }
        if (aboutSections.length >= 3) {
          const title = aboutSections[2].querySelector('.dependency-title .dependency-name');
          if (title) title.textContent = t('license');
          const lps = aboutSections[2].querySelectorAll('.dependency-body p');
          if (lps[0]) lps[0].textContent = t('copyrightLine');
          if (lps[1]) lps[1].textContent = t('proprietary');
          if (lps[2]) lps[2].textContent = t('noUnauthorized');
        }
        if (aboutSections.length >= 4) {
          const title = aboutSections[3].querySelector('.dependency-title .dependency-name');
          if (title) title.textContent = t('thirdParty');
          const depDescs = aboutSections[3].querySelectorAll('.dependency-item p');
          const depKeys = ['depCodeMirror', 'depHighlight', 'depCmark', 'depKatex', 'depMermaid', 'depHtml2canvas', 'depTauri'];
          depDescs.forEach((p, i) => {
            if (i < depKeys.length) p.textContent = t(depKeys[i]);
          });
        }
  
        // Save dialog
        document.getElementById('save-dialog-title').textContent = t('saveChanges');
        document.getElementById('save-dialog-save').textContent = t('save');
        document.getElementById('save-dialog-discard').textContent = t('dontSave');
        document.getElementById('save-dialog-cancel').textContent = t('cancel');
  
        // Find panels
        setPlaceholder('find-input', t('find') + '...');
        setPlaceholder('replace-input', t('replace') + '...');
        document.querySelector('#find-panel .find-option:nth-child(2)') && (document.querySelector('#find-panel .find-option:nth-child(2)').childNodes[1] && (document.querySelector('#find-panel .find-option:nth-child(2)').childNodes[1].textContent = ' ' + t('caseSensitive')));
        document.querySelector('#find-panel .find-option:nth-child(3)') && (document.querySelector('#find-panel .find-option:nth-child(3)').childNodes[1] && (document.querySelector('#find-panel .find-option:nth-child(3)').childNodes[1].textContent = ' ' + t('regex')));
        document.querySelector('#find-panel .find-option:nth-child(4)') && (document.querySelector('#find-panel .find-option:nth-child(4)').childNodes[1] && (document.querySelector('#find-panel .find-option:nth-child(4)').childNodes[1].textContent = ' ' + t('loop')));
        document.getElementById('find-next').textContent = t('findNext');
        document.getElementById('find-prev').textContent = t('findPrev');
        document.getElementById('replace-one').textContent = t('replace');
        document.getElementById('replace-all').textContent = t('replaceAll');
        setPlaceholder('preview-find-input', t('findInPreview') + '...');
        document.querySelector('#preview-find-panel .find-option:nth-child(2)') && (document.querySelector('#preview-find-panel .find-option:nth-child(2)').childNodes[1] && (document.querySelector('#preview-find-panel .find-option:nth-child(2)').childNodes[1].textContent = ' ' + t('caseSensitive')));
        document.querySelector('#preview-find-panel .find-option:nth-child(3)') && (document.querySelector('#preview-find-panel .find-option:nth-child(3)').childNodes[1] && (document.querySelector('#preview-find-panel .find-option:nth-child(3)').childNodes[1].textContent = ' ' + t('regex')));
        document.querySelector('#preview-find-panel .find-option:nth-child(4)') && (document.querySelector('#preview-find-panel .find-option:nth-child(4)').childNodes[1] && (document.querySelector('#preview-find-panel .find-option:nth-child(4)').childNodes[1].textContent = ' ' + t('loop')));
        document.getElementById('preview-find-next').textContent = t('findNext');
        document.getElementById('preview-find-prev').textContent = t('findPrev');
  
        // Save dialog message
        setText('save-dialog-message', t('saveDialogMessage'));
  
        // Confirm dialog title & message
        setText('confirm-dialog-title', t('confirm'));
        setText('confirm-dialog-message', t('confirmMessage'));
  
        // Shortcuts dialog
        setText('shortcuts-title', t('shortcuts'));
        document.getElementById('shortcuts-reset').textContent = t('resetDefault');
        // 快捷键框「保存」按钮文案：与设置框「保存」一致；loading 中跳过（保 spinner）
        const scSaveBtn = document.getElementById('shortcuts-save-btn');
        if (scSaveBtn && !scSaveBtn.classList.contains('is-loading')) scSaveBtn.textContent = t('save');
  
        // Loading overlay
        setText('loading-text', t('loading'));
  
        // Scroll-top button
        setText('scroll-top-label', t('scrollTop'));
        setTitle('scroll-top-btn', t('backToTop'));
  
        // Tab bar tooltips
        setTitle('btn-add-tab', t('newTab'));
        setTitle('tab-scroll-left', t('scrollLeft'));
        setTitle('tab-scroll-right', t('scrollRight'));
  
        // Toolbar button titles
        setTitle('btn-file', t('file'));
        setTitle('btn-view', t('view'));
        setTitle('btn-help', t('help'));
        setTitle('btn-view-preview', t('previewMode'));
        setTitle('btn-view-edit', t('editMode'));
  
        // View menu sidebar toggle
        const sidebarToggle = document.getElementById('btn-sidebar-toggle');
        if (sidebarToggle) {
          const labelSpan = sidebarToggle.querySelector('span:last-of-type');
          if (labelSpan) labelSpan.textContent = t('sidebar');
        }
  
        // Items with data-action (format toolbar + context menus)
        const insActionKeys = {
          'insert-code-block': 'codeBlock',
          'insert-table': 'table',
          'insert-quote': 'quoteBlock',
          'insert-math-block': 'mathBlock',
          'insert-mermaid': 'mermaidChart',
          'insert-hr': 'hr',
          'insert-toc': 'toc',
          'insert-h1': 'heading1',
          'insert-h2': 'heading2',
          'insert-h3': 'heading3',
          'insert-h4': 'heading4',
          'insert-h5': 'heading5',
          'insert-h6': 'heading6',
          'insert-bold': 'bold',
          'insert-italic': 'italic',
          'insert-strikethrough': 'strikethrough',
          'insert-inline-code': 'inlineCode',
          'insert-highlight': 'highlight',
          'insert-superscript': 'superscript',
          'insert-subscript': 'subscript',
          'insert-ul': 'ul',
          'insert-ol': 'ol',
          'insert-task': 'taskList',
          'insert-link': 'link',
          'insert-image': 'image',
          'insert-callout-note': 'noteHint',
          'insert-callout-tip': 'tipHint',
          'insert-callout-warning': 'warningHint',
          'insert-callout-caution': 'cautionHint',
          'insert-callout-important': 'importantHint',
        };
        document.querySelectorAll(
          '#format-toolbar .dropdown-item[data-action],' +
          // Also cover context menu submenus
          '#ctx-structure .context-menu-item[data-action],' +
          '#ctx-heading .context-menu-item[data-action],' +
          '#ctx-callout .context-menu-item[data-action],' +
          '#ctx-text-format .context-menu-item[data-action],' +
          '#ctx-list .context-menu-item[data-action],' +
          '#ctx-link-media .context-menu-item[data-action]'
        ).forEach(el => {
          const key = insActionKeys[el.dataset.action];
          if (key) {
            const span = el.querySelector('span:first-of-type');
            if (span) span.textContent = t(key);
          }
        });
  
        // ====== data-i18n (category labels without actions, e.g. toolbar dropdowns) ======
        document.querySelectorAll('[data-i18n]').forEach(el => {
          const key = el.dataset.i18n;
          if (key) {
            const lbl = el.querySelector('.lbl');
            if (lbl) lbl.textContent = t(key);
          }
        });
  
        // 折叠切换按钮文案随展开/收起状态变化
        const fmtLabel = document.querySelector('#fmt-collapse .fmt-toggle-label');
        if (fmtLabel) {
          fmtLabel.textContent = this.settings.toolbarCollapsed ? t('expandToolbar') : t('collapseToolbar');
        }
  
        // ====== CONTEXT MENUS ======
        // Submenu triggers
        const ctxSubKeys = {
          'ctx-structure': 'structure',
          'ctx-text-format': 'textFormat',
          'ctx-list': 'list',
          'ctx-link-media': 'linkMedia',
          'ctx-heading': 'heading',
          'ctx-callout': 'callout',
        };
        document.querySelectorAll('.context-submenu-trigger').forEach(el => {
          const key = ctxSubKeys[el.dataset.submenu];
          if (key) {
            const span = el.querySelector('span:first-of-type');
            if (span) span.textContent = t(key);
          }
        });
  
        // Items with data-action
        const ctxActionKeys = {
          cut: 'cut',
          copy: 'copy',
          paste: 'paste',
          'find-replace': 'findReplace',
          'select-all': 'selectAll',
          'preview-copy': 'copy',
          'preview-select-all': 'selectAll',
          'preview-copy-html': 'copyAsHTML',
          'preview-find': 'findInPreview',
          'tab-close': 'closeTab',
          'tab-close-others': 'closeOther',
          'tab-close-all': 'closeAll',
          'tab-copy-path': 'copyFilePath',
          'tab-open-containing': 'openContainingFolder',
          // 注意：'folder-open-containing' 文案由 updateFolderMenuLabel() 按 _folderCtxIsDir 动态切换
          // （文件夹→openFolder / 文件→openContainingFolder），不走这里的静态映射。
          'folder-copy-path': 'copyFilePath',
        };
        document.querySelectorAll('.context-menu-item[data-action]').forEach(el => {
          const key = ctxActionKeys[el.dataset.action];
          if (key) {
            const span = el.querySelector('span:first-of-type');
            if (span) span.textContent = t(key);
          }
        });
  
        // ====== SETTINGS DROPDOWN OPTIONS ======
        // 自绘下拉：随语言刷新选项文案（替代原生 select，展开面板可主题化 + 完整 ARIA）
        if (this._selects && this._selects.themeMode) this._selects.themeMode.applyI18n(t);
        if (this._selects && this._selects.colorScheme) this._selects.colorScheme.applyI18n(t);
        if (this._selects && this._selects.language) this._selects.language.applyI18n(t);
        if (this._selects && this._selects.tabSize) this._selects.tabSize.applyI18n(t);
        if (this._selects && this._selects.lineHeight) this._selects.lineHeight.applyI18n(t);
        if (this._selects && this._selects.maxWidth) this._selects.maxWidth.applyI18n(t);
        if (this._selects && this._selects.defaultView) this._selects.defaultView.applyI18n(t);
        if (this._selects && this._selects.closeAction) this._selects.closeAction.applyI18n(t);
        if (this._selects && this._selects.imageInsertMode) this._selects.imageInsertMode.applyI18n(t);
        if (this._selects && this._selects.imageAssetPathMode) this._selects.imageAssetPathMode.applyI18n(t);
        // 快捷键/插入图片/文件夹排序下拉（各自独立实例）随语言刷新
        if (this._schemeSelect) this._schemeSelect.applyI18n(t);
        if (this._imageSourceSelect) this._imageSourceSelect.applyI18n(t);
        if (this._folderSortSelect) this._folderSortSelect.applyI18n(t);
        if (this._outlineFilterSelect) this._outlineFilterSelect.applyI18n(t);
        // 自定义字体区（空状态 + 编辑/预览字体下拉的「跟随方案」）随语言刷新
        this.renderCustomFontSettings();
      },
  };

  // 向后兼容重导出：notify.js 等仍通过 TMI18n.ERROR_MESSAGES 取用错误字典，
  // 故此处保留引用，避免改动下游消费方。
  const api = { mixin, ERROR_MESSAGES, I18N };
  window.TMI18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
