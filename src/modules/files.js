// 文件/文件夹读写、会话与文件树操作
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { Tab, dialogOpen, dialogSave } = TMConst;

  const mixin = {
      newFile() {
        this.addTab(this.t('untitled'), '', null);
        this.setViewMode('edit');
        this.setStatus(this.t('newFileCreated'));
      },
      async reloadFile() {
        const tab = this.activeTab;
        if (!tab || !tab.filePath) {
          this.setStatus(this.t('noFileToReload') || '当前文件无关联路径，无法重新加载');
          return;
        }
        this.showLoading();
        try {
          const scrollInfo = this.cm.getScrollInfo();
          const cursorPos = this.cm.getCursor();
          const previewScrollTop = this.preview.scrollTop;
          const content = await TauriApi.readFile({ path: tab.filePath });
          tab.content = content;
          tab.savedContent = content;
          // 重新加载：markdown 和图片都可能在外部被改动，清图片 base64 缓存强制重读
          this._imageBase64Cache.clear();
          this.cm.setValue(content);
          // 取消 change 事件调度的 debounced 预览更新，后续显式调用 updatePreview 替代
          clearTimeout(this.debounceTimer);
          this.cm.setCursor(cursorPos);
          this.cm.clearHistory();
          await this.updatePreview();
          // 统一恢复该 tab 记忆的编辑器/预览滚动位置（临时关闭滚动同步避免互相重定位）
          this._restoreSwitchScroll(scrollInfo, previewScrollTop);
          this.updateWordCount();
          this.updateOutline();
          this.updateTabDisplay();
          this.setStatus(`${this.t('reloaded') || '已重新加载'}: ${tab.name}`);
        } catch (err) {
          this.reportError('E_IO', { context: { path: tab.filePath }, error: err, params: { name: tab.name } });
        } finally {
          this.hideLoading();
        }
      },
      async openFile() {
        try {
          const selected = await dialogOpen({
            multiple: true,
            filters: [
              { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
              { name: this.t('allFiles'), extensions: ['*'] }
            ]
          });
  
          if (!selected) return;
          this.showLoading();
          const files = Array.isArray(selected) ? selected : [selected];
          let openedCount = 0;
  
          for (const filePath of files) {
            const existingIndex = this.tabs.findIndex(t => t.filePath === filePath);
            if (existingIndex !== -1) {
              this.switchTab(existingIndex);
              continue;
            }
            try {
              const content = await this.readFileNormalized(filePath);
              const name = filePath.split(/[/\\]/).pop();
              this.addTab(name, content, filePath);
              openedCount++;
            } catch (e) {
              console.error('Failed to open file:', filePath, e);
            }
          }
          this.syncViewModeToTab();
          this.applyViewMode();
          this.updateWordCount();
          this.setStatus(openedCount > 0 ? this.t('openedFiles', { n: openedCount }) : this.t('alreadyOpen'));
        } catch (error) {
          // 多选打开时单个文件失败：弹 toast 而非仅 console，避免用户无感
          this.reportError(error.code || 'E_IO', { context: { path: error.path }, error, params: error.params, detail: error.detail });
        } finally {
          this.hideLoading();
        }
      },
      loadSession() {
        try {
          const raw = localStorage.getItem('tizumark-session');
          if (!raw) return null;
          const data = JSON.parse(raw);
          if (!data || data.version !== 2) return null;
          return data;
        } catch (e) {
          return null;
        }
      },
      saveSession() {
        try {
          const tabs = this.tabs
            .filter(t => t.filePath)
            .map(t => ({
              name: t.name,
              filePath: t.filePath,
              cursorPos: t.cursorPos || { line: 0, ch: 0 },
              scrollPos: t.scrollPos || { top: 0, left: 0 },
              previewScrollTop: t.previewScrollTop || 0,
              fileMeta: t.fileMeta || null,
            }));
          const data = {
            version: 2,
            activeFilePath: (this.activeTab && this.activeTab.filePath) ? this.activeTab.filePath : null,
            tabs,
            workspaceFolder: this.workspaceFolder || null,
            expandedFolders: this.expandedFolders ? Array.from(this.expandedFolders) : [],
          };
          localStorage.setItem('tizumark-session', JSON.stringify(data));
        } catch (e) { /* ignore */ }
      },
      async restoreSession() {
        const session = this.loadSession();
        if (!session) return false;
        const tabs = session.tabs || [];
        const workspaceFolder = session.workspaceFolder || null;
        if (tabs.length === 0 && !workspaceFolder) return false;
  
        const restored = [];
        for (const st of tabs) {
          if (!st.filePath) continue;
          const tab = new Tab(st.name || st.filePath.split(/[/\\]/).pop(), '', st.filePath);
          // 恢复时必须按后缀正确分类 kind：否则图片会被当成 markdown，
          // 后续 ensureTabLoaded 仍按文本读取二进制 → 显示成代码
          if (window.FileTypes && window.FileTypes.classifyFile) {
            tab.kind = window.FileTypes.classifyFile(st.filePath);
          }
          tab.cursorPos = st.cursorPos || { line: 0, ch: 0 };
          tab.scrollPos = st.scrollPos || { top: 0, left: 0 };
          tab.previewScrollTop = st.previewScrollTop || 0;
          tab.fileMeta = st.fileMeta || null;
          tab._loaded = false;
          restored.push(tab);
        }
        if (restored.length === 0 && !workspaceFolder) return false;
        if (restored.length === 0) {
          restored.push(new Tab(`${this.t('untitled')}${this.untitledCounter++}`));
        }
  
        this.tabs = restored;
        this.activeTabIndex = 0;
        if (session.activeFilePath) {
          const idx = this.tabs.findIndex(t => t.filePath === session.activeFilePath);
          if (idx !== -1) this.activeTabIndex = idx;
        }
  
        const active = this.activeTab;
        if (active && active.filePath) {
          // 图片不按文本读取（否则二进制被当代码显示），与 ensureTabLoaded / switchTab 保持一致
          let _activeKind = active.kind;
          if (active.filePath && window.FileTypes && window.FileTypes.classifyFile) {
            _activeKind = window.FileTypes.classifyFile(active.filePath);
          }
          if (_activeKind === 'image') {
            active.content = '';
            active.savedContent = '';
            active._loaded = true;
          } else {
            try {
              const content = await this.readFileNormalized(active.filePath);
              active.content = content;
              active.savedContent = content;
            } catch (e) {
              // 读盘失败（文件被删除/移动/无权限）：保留标签页但标记为加载失败，
              // 不再静默置空 content/savedContent（避免后续保存用空内容覆盖原文件）
              active.content = '';
              active.savedContent = '';
              active._loadError = true;
              this.reportError('E_NOT_FOUND', { context: { path: active.filePath }, params: { name: active.name }, error: e });
            }
            active._loaded = true;
          }
        } else if (active) {
          active._loaded = true;
        }
  
        await Promise.all(this.tabs.map(t => this.refreshFileMeta(t)));
  
        // 同 switchTab：setValue 会同步触发 scroll / cursorActivity 事件，污染 activeTab.scrollPos / cursorPos，先取快照
        const restoreCursor = (active && active.cursorPos) || { line: 0, ch: 0 };
        const restoreScroll = (active && active.scrollPos) || { top: 0, left: 0 };
        const restorePreviewTop = (active && active.previewScrollTop) || 0;
  
        this.cm.setValue(this.activeTab.content || '');
        this.cm.setCursor(restoreCursor);
        this.cm.clearHistory();
        this.updateTabBar();
        this.updateTabDisplay();
        this.syncViewModeToTab();
        await this.updatePreview();
        // 统一恢复该 tab 记忆的编辑器/预览滚动位置（临时关闭滚动同步避免互相重定位）
        this._restoreSwitchScroll(restoreScroll, restorePreviewTop);
        this.updateOutline();
        this.updateWordCount();
        this.highlightTreeActiveFile();
  
        if (workspaceFolder) {
          this.workspaceFolder = workspaceFolder;
          this.expandedFolders = new Set(session.expandedFolders || []);
          await this.renderFolderTree();
          this.showSidebar();
          this.saveSession();
          this.startFolderWatch();
        }
        return true;
      },
      async openFilePath(filePath) {
        this._largeFileNoticeDismissed = false;
        this._previewFocusLine = 0;
        this.previewWindow = null;
        // 类型判断：unsupported 直接提示，不打开
        const kind = (window.FileTypes && window.FileTypes.classifyFile)
          ? window.FileTypes.classifyFile(filePath)
          : 'markdown';
        if (kind === 'unsupported') {
          this.showToast(this.t('formatUnsupported'), 'warning');
          this.setStatus(this.t('formatUnsupported'));
          return;
        }
        this._beginPaneLoad();
        try {
          const existingIndex = this.tabs.findIndex(t => t.filePath === filePath);
          if (existingIndex !== -1) {
            await this.switchTab(existingIndex);
            this.saveSession();
            return;
          }
          // 图片：不读文本内容，预览面板内显示图片
          if (kind === 'image') {
            const name = filePath.split(/[/\\]/).pop();
            await this.addTab(name, '', filePath, 'image');
            this.viewMode = 'preview';
            this.applyViewMode();
            this.updateWordCount();
            this.setStatus(this.t('fileOpened', { name }));
            this.saveSession();
            return;
          }
          const content = await this.readFileNormalized(filePath);
          const name = filePath.split(/[/\\]/).pop();
          // text：按原始文本显示（不按 Markdown 渲染）；markdown：现有渲染管线
          await this.addTab(name, content, filePath, kind);
          // 按扩展名设置编辑器语法高亮（image 不进入编辑器）
          if (kind === 'text') {
            const ext = (window.FileTypes && window.FileTypes.extOf) ? window.FileTypes.extOf(filePath) : '';
            this._applyCodeMode(ext);
          } else {
            this._applyCodeMode('md');
          }
          // 视图模式：text 强制编辑；markdown 优先会话记忆（_sessionMdViewMode），其次设置默认视图
          this.viewMode = (kind === 'text') ? 'edit' : (this._sessionMdViewMode || this.settings.defaultView || 'preview');
          this.applyViewMode();
          this.updateWordCount();
          this.setStatus(this.t('fileOpened', { name }));
          this.saveSession();
        } catch (e) {
          // 打开失败：结构化错误码（E_NOT_FOUND/E_PERMISSION/...）或兜底 E_IO，用户可见 toast + 开发可见 console
          this.reportError(e.code || 'E_IO', { context: { path: filePath }, error: e, params: e.params, detail: e.detail });
        } finally {
          this._endPaneLoad();
        }
      },
      // 非 Markdown 明文文件：按扩展名选择 CodeMirror 语法高亮模式（仅高亮，不改变编辑行为）
      _applyCodeMode(ext) {
        if (!this.cm || typeof this.cm.setOption !== 'function') return;
        const map = {
          js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
          ts: 'javascript', tsx: 'javascript',
          py: 'python', pyw: 'python',
          rs: 'rust',
          html: 'htmlmixed', htm: 'htmlmixed',
          xml: 'xml', svg: 'xml',
          css: 'css',
          json: 'javascript',
          yml: 'yaml', yaml: 'yaml',
          sh: 'shell', bash: 'shell', zsh: 'shell',
          md: 'gfm', markdown: 'gfm',
        };
        const mode = map[(ext || '').toLowerCase()] || 'gfm';
        try { this.cm.setOption('mode', mode); } catch (e) { try { this.cm.setOption('mode', 'gfm'); } catch (_) {} }
      },
      async openFolder() {
        try {
          const selected = await dialogOpen({ directory: true });
          if (!selected) return;
          const folderPath = Array.isArray(selected) ? selected[0] : selected;
          if (!folderPath) return;
          await this.openFolderPath(folderPath);
        } catch (e) {
          this.setStatus(this.t('openFailed') + ': ' + e);
        }
      },
      // 直接按给定路径加载为工作区目录（不走 dialog）。
      // CLI 参数 / file-open 事件 / drag-drop 都复用此入口。
      async openFolderPath(folderPath) {
        if (!folderPath) return;
        this.showLoading();
        try {
          this.workspaceFolder = folderPath;
          this.expandedFolders = new Set();
          await this.renderFolderTree();
          this.showSidebar();
          this.startFolderWatch();
          this.saveSession();
          this.addRecentWorkspace(folderPath);
          this.setStatus(this.t('folderOpened', { path: folderPath }));
        } catch (e) {
          this.setStatus(this.t('openFailed') + ': ' + e);
        } finally {
          this.hideLoading();
        }
      },
      // 运行中收到目录（拖放 / 二次实例 file-open）时的工作区切换入口：
      // 已有不同工作区则弹确认框，取消则忽略该目录；启动 CLI 场景传 confirm=false 直接打开。
      async maybeOpenFolderPath(folderPath, { confirm = true } = {}) {
        if (!folderPath) return false;
        if (confirm && this.workspaceFolder && this.workspaceFolder !== folderPath) {
          const ok = await this.showConfirmDialog(
            this.t('switchWorkspaceTitle'),
            this.t('switchWorkspaceMsg', { path: folderPath })
          );
          if (!ok) return false;
        }
        await this.openFolderPath(folderPath);
        return true;
      },
      // 统一「一批路径按目录/文件分发」：目录加载为工作区（仅第一个，多余目录提示忽略），
      // 文件走 openFilePath。drag-drop / file-open 事件 / 启动 CLI 参数三处入口共用。
      async openPathsSmart(paths, { confirmWorkspaceSwitch = true } = {}) {
        let dirOpened = false;
        const ignoredDirs = [];
        for (const p of paths || []) {
          if (!p || p.startsWith('-')) continue;
          try {
            let isDir = false;
            try { isDir = await TauriApi.isDirectory({ path: p }); }
            catch (_) { /* 非 Tauri 环境或路径不可访问，按文件处理 */ }
            if (isDir) {
              if (dirOpened) {
                ignoredDirs.push(p);
                continue;
              }
              const opened = await this.maybeOpenFolderPath(p, { confirm: confirmWorkspaceSwitch });
              if (opened) dirOpened = true;
            } else {
              await this.openFilePath(p);
            }
          } catch (err) {
            this.setStatus(`${this.t('openFailed')}: ${err}`);
          }
        }
        // 多余目录合并成一条 toast，避免一次拖十几个文件夹时刷屏
        if (ignoredDirs.length > 0) {
          this.showToast(this.t('extraDirsIgnoredBatch', { n: ignoredDirs.length }), 'warning');
        }
      },
      closeFolder() {
        this.workspaceFolder = null;
        this.expandedFolders = new Set();
        this.saveSession();
        this.renderFolderTree();
        try { TauriApi.stopWatch().catch(() => {}); } catch (e) { /* ignore */ }
      },
      // 开始监听工作区目录树变化（先停掉旧的，避免重复监听）。外部增删目录/文件时会收到 folder-changed 事件
      async startFolderWatch() {
        if (!this.workspaceFolder) return;
        try { await TauriApi.stopWatch(); } catch (e) { /* ignore */ }
        try { await TauriApi.watchFolder({ path: this.workspaceFolder }); }
        catch (e) { console.warn('[folder-watch] failed:', e); }
      },
      // 文件夹监听异常处理：弹确认框提供「重新监听（确认）/ 继续使用（取消）」。
      // 手动触发所以无自动重挂的风暴风险；_folderWatchDialogOpen 防重入（panic 反复时
      // 避免弹窗互相覆盖、监听叠加）
      async _handleFolderWatchError(event) {
        if (this._folderWatchDialogOpen) return;
        this._folderWatchDialogOpen = true;
        try {
          const detail = event && event.payload && event.payload.message
            ? '：' + event.payload.message
            : '';
          const ok = await this.showConfirmDialog(
            this.t('folderWatchErrorTitle'),
            this.t('folderWatchErrorMessage') + detail,
            async () => { await this.startFolderWatch(); },
          );
          if (ok) this.showToast(this.t('folderWatchRecovered'), 'success');
        } finally {
          this._folderWatchDialogOpen = false;
        }
      },
      // 收到 folder-changed 后防抖重建文件树（保留已展开目录），避免单次操作触发多次重渲染
      _scheduleTreeRefresh() {
        if (this._treeRefreshTimer) clearTimeout(this._treeRefreshTimer);
        this._treeRefreshTimer = setTimeout(() => {
          this._treeRefreshTimer = null;
          if (this.workspaceFolder) this.renderFolderTree();
        }, 400);
      },
      sortFolderEntries(entries, key, order, dirFirst = true) {
        const arr = entries.slice();
        const sign = order === 'desc' ? -1 : 1;
        arr.sort((a, b) => {
          if (dirFirst && a.is_dir !== b.is_dir) {
            return a.is_dir ? -1 : 1;
          }
          let cmp;
          if (key === 'time') {
            cmp = (a.mtime || 0) - (b.mtime || 0);
          } else if (key === 'created') {
            cmp = (a.created || a.mtime || 0) - (b.created || b.mtime || 0);
          } else {
            cmp = String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
          }
          return cmp * sign;
        });
        return arr;
      },
      // 文件大小自适应格式化：B / KB / MB / GB（保留 1 位小数，>=1000 才进级）
      formatFileSize(bytes) {
        const b = Number(bytes) || 0;
        if (b < 1024) return b + ' B';
        const units = ['KB', 'MB', 'GB', 'TB'];
        let val = b / 1024;
        let i = 0;
        while (val >= 1024 && i < units.length - 1) {
          val /= 1024;
          i += 1;
        }
        return val.toFixed(val >= 100 ? 0 : 1) + ' ' + units[i];
      },
      // 修改时间友好格式化：今天显示 HH:mm，今年显示 MM-DD HH:mm，跨年显示 YYYY-MM-DD
      formatFileTime(mtime) {
        const ms = Number(mtime) || 0;
        if (!ms) return '';
        const d = new Date(ms);
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
          return hm;
        }
        const md = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        if (d.getFullYear() === now.getFullYear()) {
          return md + ' ' + hm;
        }
        return d.getFullYear() + '-' + md;
      },
      updateFolderSortOrderButton() {
        const el = document.getElementById('folder-sort-order');
        if (!el) return;
        const asc = (this.settings.fileSortOrder || 'asc') !== 'desc';
        // 排序字形：清晰的上下双箭头（升序=上箭头实色+下箭头淡显；降序反之），与面板 chevron 明显区分
        // 升序/降序：使用 Lucide arrow-up-narrow-wide / arrow-down-wide-narrow（条形由窄到宽表征顺序方向）
        const SORT_ASC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/></svg>';
        const SORT_DESC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg>';
        el.innerHTML = asc ? SORT_ASC : SORT_DESC;
        el.classList.toggle('desc', !asc);
        el.title = this.t(asc ? 'sortAsc' : 'sortDesc');
        el.setAttribute('aria-pressed', String(asc));
      },
      // 文件树右键菜单首项文案：文件夹→「打开文件夹」，文件→「打开所在目录」（动态切换，i18n 键均有）
      updateFolderMenuLabel() {
        const span = document.getElementById('folder-open-label');
        if (!span) return;
        span.textContent = this.t(this._folderCtxIsDir ? 'openFolder' : 'openContainingFolder');
      },
      // 文件树右键的「目标目录」：
      //   - 文件夹 → 该文件夹本身
      //   - 文件   → 文件所在目录（即与它同级，这是右键文件时期望的行为）
      //   - 空白处 → 工作区根目录
      // 之前只有文件夹右键能新建，文件上和空白处的「新建文件/文件夹」是禁用的，用起来别扭。
      _fileTreeTargetDir() {
        const ctx = this._fileTreeCtx;
        if (!ctx || ctx.isBlank) return this.workspaceFolder || '';
        if (ctx.isDir) return ctx.path;
        return this.parentPath(ctx.path);
      },
      // 根据当前右键目标和剪贴板状态更新菜单项禁用状态
      updateFileTreeMenuState() {
        const menu = document.getElementById('context-menu-file-tree');
        if (!menu) return;
        const ctx = this._fileTreeCtx;
        const isBlank = !ctx || !!ctx.isBlank; // 空白处右键：没有具体节点
        const targetDir = this._fileTreeTargetDir();
        const setDisabled = (action, disabled) => {
          const item = menu.querySelector(`[data-action="${action}"]`);
          if (item) item.classList.toggle('disabled', disabled);
        };
        // 新建 / 粘贴只需要「目标目录」：文件夹→自身，文件→同级目录，空白→根目录。
        setDisabled('file-new-file', !targetDir);
        setDisabled('file-new-folder', !targetDir);
        setDisabled('file-paste', !targetDir || !this._fileClipboard);
        // 需要具体节点的操作：空白处一律禁用（没有选中项可操作）。
        const nodeActions = ['file-cut', 'file-copy', 'file-rename', 'file-copy-path', 'file-delete', 'folder-open-containing'];
        nodeActions.forEach(a => setDisabled(a, isBlank));
      },
      // 通用输入对话框：返回用户输入的字符串（trim），取消返回 null
      showPromptDialog({ title, message = '', value = '', placeholder = '', selectBase = false }) {
        return new Promise((resolve) => {
          const dialog = document.getElementById('prompt-dialog');
          const titleEl = document.getElementById('prompt-dialog-title');
          const msgEl = document.getElementById('prompt-dialog-message');
          const input = document.getElementById('prompt-dialog-input');
          const confirmBtn = document.getElementById('prompt-dialog-confirm');
          const cancelBtn = document.getElementById('prompt-dialog-cancel');
          if (!dialog || !input) { resolve(null); return; }
          titleEl.textContent = title || '';
          msgEl.textContent = message;
          msgEl.style.display = message ? '' : 'none';
          input.value = value;
          input.placeholder = placeholder;
          dialog.classList.remove('hidden');
          input.focus();
          if (selectBase && value) {
            const dot = value.lastIndexOf('.');
            if (dot > 0) input.setSelectionRange(0, dot);
            else input.select();
          } else {
            input.select();
          }
          const cleanup = () => {
            dialog.classList.add('hidden');
            input.removeEventListener('keydown', onKey);
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            dialog.removeEventListener('click', onOverlay);
          };
          const onConfirm = () => { const v = input.value.trim(); cleanup(); resolve(v || null); };
          const onCancel = () => { cleanup(); resolve(null); };
          const onKey = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          };
          const onOverlay = (e) => { if (e.target === dialog) onCancel(); };
          input.addEventListener('keydown', onKey);
          confirmBtn.addEventListener('click', onConfirm);
          cancelBtn.addEventListener('click', onCancel);
          dialog.addEventListener('click', onOverlay);
        });
      },
      validateFileName(name) {
        if (!name || !name.trim()) return this.t('nameEmpty');
        if (/[\/\\:*?"<>|]/.test(name)) return this.t('nameInvalid');
        return null;
      },
      joinPath(parent, name) {
        if (!parent) return name;
        return parent.replace(/[\/\\]+$/, '') + '/' + name;
      },
      parentPath(path) {
        const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return idx > 0 ? path.substring(0, idx) : '';
      },
      baseName(path) {
        const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return idx >= 0 ? path.substring(idx + 1) : path;
      },
      async pathExists(path) {
        try {
          const parent = this.parentPath(path);
          const name = this.baseName(path);
          if (!parent) return false;
          const entries = await TauriApi.listDir({ path: parent });
          return entries.some(e => e.name === name);
        } catch { return false; }
      },
      async fileTreeNewFile() {
        const dir = this._fileTreeTargetDir();
        if (!dir) return;
        let name = await this.showPromptDialog({
          title: this.t('fileNewFile'),
          message: this.t('newFileNamePrompt'),
          placeholder: 'note.md'
        });
        if (name === null) return;
        if (!name.includes('.')) name += '.md';
        const err = this.validateFileName(name);
        if (err) { this.showToast(err, 'danger'); return; }
        const newPath = this.joinPath(dir, name);
        if (await this.pathExists(newPath)) { this.showToast(this.t('nameExists'), 'danger'); return; }
        try {
          await TauriApi.writeFile({ path: newPath, content: '' });
          this.expandedFolders.add(dir);
          this.renderFolderTree();
          this.setStatus(this.t('fileNewFile') + ': ' + name);
        } catch (e) {
          this.showToast(this.t('fileCreateFailed') + ': ' + e, 'danger');
        }
      },
      async fileTreeNewFolder() {
        const dir = this._fileTreeTargetDir();
        if (!dir) return;
        const name = await this.showPromptDialog({
          title: this.t('fileNewFolder'),
          message: this.t('newFolderNamePrompt'),
          placeholder: 'new-folder'
        });
        if (name === null) return;
        const err = this.validateFileName(name);
        if (err) { this.showToast(err, 'danger'); return; }
        const newPath = this.joinPath(dir, name);
        if (await this.pathExists(newPath)) { this.showToast(this.t('nameExists'), 'danger'); return; }
        try {
          await TauriApi.ensureDir({ path: newPath });
          this.expandedFolders.add(dir);
          this.renderFolderTree();
          this.setStatus(this.t('fileNewFolder') + ': ' + name);
        } catch (e) {
          this.showToast(this.t('fileCreateFailed') + ': ' + e, 'danger');
        }
      },
      async fileTreeRename() {
        const ctx = this._fileTreeCtx;
        if (!ctx) return;
        const oldName = this.baseName(ctx.path);
        let newName = await this.showPromptDialog({
          title: this.t('fileRename'),
          message: this.t('renamePrompt'),
          value: oldName,
          selectBase: true
        });
        if (newName === null) return;
        const oldExt = oldName.includes('.') ? oldName.slice(oldName.lastIndexOf('.')) : '';
        if (!newName.includes('.') && (oldExt === '' || oldExt === '.md')) newName += '.md';
        const err = this.validateFileName(newName);
        if (err) { this.showToast(err, 'danger'); return; }
        if (newName === oldName) return;
        const parent = this.parentPath(ctx.path);
        const newPath = this.joinPath(parent, newName);
        if (await this.pathExists(newPath)) { this.showToast(this.t('nameExists'), 'danger'); return; }
        try {
          await TauriApi.renamePath({ from: ctx.path, to: newPath });
          const tab = this.tabs.find(t => t.filePath === ctx.path);
          if (tab) {
            tab.filePath = newPath;
            tab.name = newName;
            this.updateTabBar();
            this.saveSession();
          }
          this.renderFolderTree();
          this.setStatus(this.t('fileRename') + ': ' + oldName + ' → ' + newName);
        } catch (e) {
          this.showToast(this.t('fileRenameFailed') + ': ' + e, 'danger');
        }
      },
      async fileTreeDelete() {
        const ctx = this._fileTreeCtx;
        if (!ctx) return;
        const name = this.baseName(ctx.path);
        const msg = ctx.isDir
          ? this.t('confirmDeleteFolder', { name })
          : this.t('confirmDeleteFile', { name });
        const ok = await this.showConfirmDialog(this.t('fileDelete'), msg);
        if (!ok) return;
        try {
          await TauriApi.removePath({ path: ctx.path });
          const tabIdx = this.tabs.findIndex(t => t.filePath === ctx.path);
          if (tabIdx >= 0) await this.closeTab(tabIdx);
          this.renderFolderTree();
          this.setStatus(this.t('fileDelete') + ': ' + name);
        } catch (e) {
          this.showToast(this.t('fileDeleteFailed') + ': ' + e, 'danger');
        }
      },
      fileTreeCut() {
        const ctx = this._fileTreeCtx;
        if (!ctx) return;
        this._fileClipboard = { op: 'cut', path: ctx.path, isDir: ctx.isDir };
        this.setStatus(this.t('fileCutDone') + ': ' + this.baseName(ctx.path));
        // 操作完成后清除文件树上下文，避免残留的 _fileTreeCtx 继续劫持编辑器/预览区的
        // Ctrl+C/V（见 fileTreeCopyPath 的同类处理）：用户复制/剪切文件后回到正文 Ctrl+V
        // 不应被 fileTreePaste 当成文件粘贴。
        this._fileTreeCtx = null;
      },
      fileTreeCopy() {
        const ctx = this._fileTreeCtx;
        if (!ctx) return;
        this._fileClipboard = { op: 'copy', path: ctx.path, isDir: ctx.isDir };
        this.setStatus(this.t('fileCopyDone') + ': ' + this.baseName(ctx.path));
        // 同上：复制完成后清除上下文，避免残留劫持编辑器/预览区的 Ctrl+C/V。
        this._fileTreeCtx = null;
      },
      async fileTreePaste() {
        const ctx = this._fileTreeCtx;
        if (!ctx || !this._fileClipboard) {
          this.showToast(this.t('clipboardEmpty'), 'danger');
          return;
        }
        // 目标目录：选中目录时为目标本身；选中文件时取其所在目录（粘贴到同级）。
        const targetDir = ctx.isDir ? ctx.path : this.parentPath(ctx.path);
        if (!targetDir) {
          this.showToast(this.t('clipboardEmpty'), 'danger');
          return;
        }
        const clip = this._fileClipboard;
        // 安全检查：禁止把目录复制/移动到自身或自身子目录内，否则递归复制直到路径超长
        const normClip = clip.path.replace(/[\/\\]+$/, '');
        const normTarget = targetDir.replace(/[\/\\]+$/, '');
        if (normClip === normTarget
            || normTarget.startsWith(normClip + '/')
            || normTarget.startsWith(normClip + '\\')) {
          this.showToast(this.t('pasteIntoSelf'), 'danger');
          return;
        }
        const srcName = this.baseName(clip.path);
        let dstPath = this.joinPath(targetDir, srcName);
        // 同名冲突时加 (n) 后缀
        if (await this.pathExists(dstPath)) {
          const dot = srcName.lastIndexOf('.');
          const base = dot > 0 ? srcName.substring(0, dot) : srcName;
          const ext = dot > 0 ? srcName.substring(dot) : '';
          let i = 1;
          while (await this.pathExists(this.joinPath(targetDir, `${base} (${i})${ext}`))) i++;
          dstPath = this.joinPath(targetDir, `${base} (${i})${ext}`);
        }
        try {
          if (clip.op === 'cut') {
            await TauriApi.movePath({ from: clip.path, to: dstPath });
            const tab = this.tabs.find(t => t.filePath === clip.path);
            if (tab) {
              tab.filePath = dstPath;
              this.updateTabBar();
              this.saveSession();
            }
            this._fileClipboard = null;
          } else {
            await TauriApi.copyPath({ from: clip.path, to: dstPath });
          }
          this.expandedFolders.add(targetDir);
          this.renderFolderTree();
          this.setStatus(this.t('filePasteDone') + ': ' + this.baseName(dstPath));
          // 粘贴完成后清除文件树上下文，避免残留劫持编辑器/预览区的 Ctrl+C/V（与 copy/cut 一致）。
          this._fileTreeCtx = null;
        } catch (e) {
          this.showToast(this.t('filePasteDone') + ': ' + e, 'danger');
        }
      },
      fileTreeCopyPath() {
        const ctx = this._fileTreeCtx;
        if (!ctx) return;
        // 「复制路径」为瞬时动作，不进入「复制文件待粘贴」状态；执行后清除文件树上下文，
        // 否则 _fileTreeCtx 持续存在会让后续编辑器内 Ctrl+C 被 fileTreeCopy 劫持、一直复制该路径。
        this._fileTreeCtx = null;
        navigator.clipboard.writeText(ctx.path).then(() => {
          this.setStatus(this.t('fileCopyPath') + ': ' + ctx.path);
        }).catch(() => {
          this.showToast(this.t('fileCopyPath') + ' ' + this.t('failed'), 'danger');
        });
      },
      _filterTreeEntries(entries, showAll) {
        if (showAll) return entries;
        // 文件夹始终保留：保证树可继续下钻；空文件夹也会显示（避免「目录消失」错觉）
        if (!window.FileTypes || !window.FileTypes.classifyFile) return entries;
        return entries.filter((e) => e && e.is_dir ? true : window.FileTypes.classifyFile(e.name) !== 'unsupported');
      },
      async renderFolderTree() {
        const treeEl = document.getElementById('folder-tree');
        if (!treeEl) return;
        // 空白处右键：新建到工作区根目录。树节点自己的 contextmenu 会 stopPropagation，
        // 这里的兜底判断防止事件从非节点区域冒泡上来时误判。
        if (!treeEl.dataset.blankMenuBound) {
          treeEl.dataset.blankMenuBound = '1';
          treeEl.addEventListener('contextmenu', (e) => {
            if (e.target && e.target.closest && e.target.closest('.tree-node')) return;
            if (!this.workspaceFolder) return; // 未打开工作区时无根目录可建
            e.preventDefault();
            // 必须 stopPropagation：document 上还有一个冒泡阶段的 contextmenu 监听
            // 会调用 hideAllContextMenus()，不拦住的话刚显示的文件菜单会被它立刻隐藏（表现为"没反应"）。
            // 文件节点的 handler 同样是靠 stopPropagation 拦住它的。
            e.stopPropagation();
            this._fileTreeCtx = { path: this.workspaceFolder, isDir: true, isBlank: true, nodeEl: null };
            this._folderCtxPath = this.workspaceFolder;
            this._folderCtxIsDir = true;
            this.updateFolderMenuLabel();
            this.hideAllContextMenus();
            this.updateFileTreeMenuState();
            this.showContextMenu('context-menu-file-tree', e.clientX, e.clientY);
          });
        }
        const headerEl = document.getElementById('folder-header');
        const pathEl = document.getElementById('folder-path');
        treeEl.innerHTML = '';
        if (pathEl) pathEl.textContent = this.workspaceFolder || '';
        if (headerEl) headerEl.classList.toggle('hidden', !this.workspaceFolder);
        if (!this.workspaceFolder) {
          const empty = document.createElement('button');
          empty.className = 'folder-empty';
          empty.textContent = this.t('openFolder');
          empty.addEventListener('click', () => this.openFolder());
          treeEl.appendChild(empty);
          return;
        }
        await this.renderFolderLevel(this.workspaceFolder, treeEl, 0);
      },
      async renderFolderLevel(dirPath, containerEl, depth) {
        if (depth > 20) return; // 防御：限制目录递归深度，避免深层嵌套/符号链接环导致浏览器卡死
        const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>';
        const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>';
        const FOLDER_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>';
        const FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /></svg>';
        const IMAGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
  
        let listing;
        try {
          listing = await TauriApi.listDir({ path: dirPath });
        } catch (e) {
          return;
        }
        const rawEntries = Array.isArray(listing)
          ? listing
          : (listing && Array.isArray(listing.entries) ? listing.entries : []);
        const sorted = this.sortFolderEntries(rawEntries, this.settings.fileSortKey, this.settings.fileSortOrder);
        // 默认按「受支持格式」过滤文件（Markdown 7 / 图片 20 / 明文代码 145），
        // 设置里开启「显示所有文件」时退回原始列表。文件夹始终保留，保证可继续下钻。
        const entries = this._filterTreeEntries(sorted, this.settings.showAllFiles);
        const truncated = !!(listing && listing.truncated);
        for (const entry of entries) {
          const node = document.createElement('div');
          node.className = 'tree-node ' + (entry.is_dir ? 'tree-folder' : 'tree-file');
          node.dataset.path = entry.path;
          node.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // 文件树右键目标上下文（合并自 PR #36）：驱动 file-* 菜单 + F2/Delete/Ctrl+X/C/V 快捷键
            this._fileTreeCtx = { path: entry.path, isDir: entry.is_dir, nodeEl: node };
            // 同时设置「打开所在目录」所需状态
            this._folderCtxPath = entry.path;
            this._folderCtxIsDir = entry.is_dir;
            this.updateFolderMenuLabel();
            this.hideAllContextMenus();
            this.updateFileTreeMenuState();
            this.showContextMenu('context-menu-file-tree', e.clientX, e.clientY);
          });
  
          const row = document.createElement('div');
          row.className = 'tree-row';
          row.style.paddingLeft = (8 + depth * 14) + 'px';
  
          const arrow = document.createElement('span');
          arrow.className = 'tree-arrow';
          arrow.innerHTML = CHEVRON;
          const icon = document.createElement('span');
          const label = document.createElement('span');
          label.className = 'tree-label';
          label.textContent = entry.name;
  
          if (entry.is_dir) {
            const expanded = this.expandedFolders.has(entry.path);
            icon.className = 'tree-icon folder';
            icon.innerHTML = expanded ? FOLDER_OPEN : FOLDER;
            node.classList.toggle('expanded', expanded);
            const childContainer = document.createElement('div');
            childContainer.className = 'tree-children' + (expanded ? '' : ' hidden');
            node.appendChild(row);
            node.appendChild(childContainer);
            if (expanded) {
              await this.renderFolderLevel(entry.path, childContainer, depth + 1);
            }
            row.addEventListener('click', async () => {
              // 左键点击也更新文件树选中目标，让 F2/Delete/Ctrl+C 等快捷键作用于当前点击项
              this._fileTreeCtx = { path: entry.path, isDir: true, nodeEl: node };
              const isOpen = !childContainer.classList.contains('hidden');
              if (isOpen) {
                childContainer.classList.add('hidden');
                node.classList.remove('expanded');
                icon.innerHTML = FOLDER;
                this.expandedFolders.delete(entry.path);
              } else {
                childContainer.classList.remove('hidden');
                node.classList.add('expanded');
                icon.innerHTML = FOLDER_OPEN;
                this.expandedFolders.add(entry.path);
                if (childContainer.childElementCount === 0) {
                  await this.renderFolderLevel(entry.path, childContainer, depth + 1);
                }
              }
              this.saveSession();
            });
          } else {
            arrow.innerHTML = '';
            const cat = (window.FileTypes && window.FileTypes.classifyFile)
              ? window.FileTypes.classifyFile(entry.name)
              : 'markdown';
            icon.className = 'tree-icon file';
            icon.innerHTML = cat === 'image' ? IMAGE_ICON : FILE;
            node.appendChild(row);
            row.addEventListener('click', () => {
              // 左键点击也更新文件树选中目标，让 F2/Delete/Ctrl+C 等快捷键作用于当前点击项
              this._fileTreeCtx = { path: entry.path, isDir: false, nodeEl: node };
              this.openFilePath(entry.path);
            });
          }
          row.appendChild(arrow);
          row.appendChild(icon);
          row.appendChild(label);
  
          const meta = document.createElement('span');
          meta.className = 'tree-meta';
          if (!entry.is_dir && entry.size != null) {
            const sizeEl = document.createElement('span');
            sizeEl.className = 'tree-size';
            sizeEl.textContent = this.formatFileSize(entry.size);
            meta.appendChild(sizeEl);
          }
          const mtime = Number(entry.mtime) || 0;
          const created = Number(entry.created) || 0;
          // 上下文时间戳：显示当前排序依据的那种时间（按创建时间排序→创建，否则→修改）；
          // 另一时间 + 大小收进 hover tooltip，避免每行常驻两串时间导致拥挤。
          const byCreated = this.settings.fileSortKey === 'created';
          let primaryVal = 0, primaryLabelKey = 'modifiedLabel';
          if (byCreated && created) { primaryVal = created; primaryLabelKey = 'createdLabel'; }
          else if (!byCreated && mtime) { primaryVal = mtime; primaryLabelKey = 'modifiedLabel'; }
          else { primaryVal = byCreated ? mtime : created; primaryLabelKey = byCreated ? 'modifiedLabel' : 'createdLabel'; }
          const timeLine = document.createElement('span');
          timeLine.className = 'tree-time-line';
          const lab = document.createElement('span');
          lab.className = 'tree-meta-label';
          lab.textContent = this.t(primaryLabelKey);
          timeLine.appendChild(lab);
          timeLine.appendChild(document.createTextNode(' ' + this.formatFileTime(primaryVal)));
          const titleParts = [];
          if (mtime) titleParts.push(this.t('modifiedFullTitle') + new Date(mtime).toLocaleString());
          if (created) titleParts.push(this.t('createdFullTitle') + new Date(created).toLocaleString());
          if (!entry.is_dir && entry.size != null) titleParts.push(this.t('sizeFullTitle') + this.formatFileSize(entry.size));
          if (titleParts.length) timeLine.title = titleParts.join('\n');
          meta.appendChild(timeLine);
          row.appendChild(meta);
  
          containerEl.appendChild(node);
        }
        if (truncated) {
          const ph = document.createElement('div');
          ph.className = 'tree-node tree-file tree-truncated';
          const phRow = document.createElement('div');
          phRow.className = 'tree-row';
          const phLabel = document.createElement('span');
          phLabel.className = 'tree-label tree-label--muted';
          phLabel.textContent = this.t('moreFilesHidden');
          phRow.appendChild(phLabel);
          ph.appendChild(phRow);
          containerEl.appendChild(ph);
        }
        this.highlightTreeActiveFile();
      },
      highlightTreeActiveFile() {
        const treeEl = document.getElementById('folder-tree');
        if (!treeEl) return;
        const activePath = (this.activeTab && this.activeTab.filePath) ? this.activeTab.filePath : null;
        treeEl.querySelectorAll('.tree-row.active').forEach(el => el.classList.remove('active'));
        if (!activePath) return;
        treeEl.querySelectorAll('.tree-node.tree-file').forEach(node => {
          if (node.dataset.path === activePath) {
            const row = node.querySelector('.tree-row');
            if (row) row.classList.add('active');
          }
        });
      },
      async saveFile() {
        try {
          let path = this.activeTab.filePath;
          if (!path) {
            path = await dialogSave({
              filters: [
                { name: 'Markdown', extensions: ['md'] },
                { name: this.t('allFiles'), extensions: ['*'] }
              ]
            });
            if (!path) return;
          }
  
          await TauriApi.writeFile({ path, content: this.activeTab.content });
          if (!this.activeTab.filePath) {
            this.activeTab.filePath = path;
            this.activeTab.name = path.split(/[/\\]/).pop();
          }
          this.activeTab.savedContent = this.activeTab.content;
          this.updateTabDisplay();
          await this.refreshFileMeta(this.activeTab);
          this.setStatus(`${this.t('saved')}: ${this.activeTab.filePath}`);
          this.saveSession();
        } catch (error) {
          this.setStatus(`${this.t('saveFailed')}: ${error}`);
        }
      },
      async saveAsFile() {
        try {
          const path = await dialogSave({
            defaultPath: this.activeTab.filePath || `${this.activeTab.name}`,
            filters: [
              { name: 'Markdown', extensions: ['md'] },
              { name: this.t('allFiles'), extensions: ['*'] }
            ]
          });
          if (!path) return;
  
          await TauriApi.writeFile({ path, content: this.activeTab.content });
          this.activeTab.filePath = path;
          this.activeTab.name = path.split(/[/\\]/).pop();
          this.activeTab.savedContent = this.activeTab.content;
          this.updateTabBar();
          await this.refreshFileMeta(this.activeTab);
          this.setStatus(`${this.t('savedAs')}: ${path}`);
          this.saveSession();
        } catch (error) {
          this.setStatus(`${this.t('saveFailed')}: ${error}`);
        }
      },
      async copyPath(path) {
        if (!path) {
          this.setStatus(this.t('notSaved'));
          return;
        }
        try {
          await navigator.clipboard.writeText(path);
          this.setStatus(this.t('pathCopied'));
        } catch {
          this.setStatus(this.t('copyFailed'));
        }
      },
      async copyTabPath(index) {
        if (index < 0 || index >= this.tabs.length) return;
        const tab = this.tabs[index];
        if (!tab.filePath) {
          this.setStatus(this.t('notSaved'));
          return;
        }
        await this.copyPath(tab.filePath);
      },
      // 标签页右键「打开所在目录」：tab 均为文件（markdown），isDir=false，
      // 调用通用 openContainingFolder 打开父目录并选中该文件。
      async openTabContainingFolder(index) {
        if (index < 0 || index >= this.tabs.length) return;
        const tab = this.tabs[index];
        if (!tab.filePath) { this.setStatus(this.t('notSaved')); return; }
        await this.openContainingFolder(tab.filePath, false);
      },
      // 在系统文件管理器中「打开所在目录」：文件→打开父目录并选中文件，目录→打开并选中自身。
      // 主路径 = Rust reveal_in_folder 命令（直接 spawn 系统文件管理器，不受 shell 插件 scope 限制，最可靠，
      //   且能「选中」目标文件）；兜底 = shell.open(dir)（需 capability 放行本地路径，链接同理走此通道）。
      // 注意：shell.open 对文件夹默认被 scope 拒绝，必须由 capability 显式允许本地路径，否则静默失败。
      async openContainingFolder(path, isDir) {
        if (!path) { console.error('[openFolder] path 为空'); this.setStatus(this.t('openFolderFailed')); return; }
        // 去掉 Windows 长路径前缀 \\?\（explorer / shell 都不认，会导致静默失败）。
        const stripLong = (p) => (p && p.startsWith('\\\\?\\')) ? p.slice(4) : p;
        const normPath = stripLong(path);
        // 目录本身，或文件取其父目录
        const dir = stripLong(isDir ? path : path.replace(/[/\\][^/\\]*$/, ''));
        if (!dir) { console.error('[openFolder] dir 为空, path=', path); this.setStatus(this.t('openFolderFailed')); return; }

        // 1) 主路径：Rust 命令直接 spawn 文件管理器（能选中目标文件，最可靠）。
        if (TauriApi.isAvailable()) {
          try {
            // 注意：Tauri v2 invoke 参数名 JS 侧必须 camelCase（Rust 侧 is_dir ↔ JS 侧 isDir）
            await TauriApi.revealInFolder({ path: normPath, isDir: !!isDir });
            return;
          } catch (e) {
            console.error('[openFolder] reveal_in_folder 失败:', e && e.message ? e.message : String(e));
          }
        } else {
          console.error('[openFolder] TauriApi.isAvailable()=false，跳过 reveal_in_folder');
        }
  
        // 2) 兜底：shell.open 打开所在目录（capability 已放行本地路径）。
        let dirOpened = false;
        if (TauriApi.shellOpen) {
          try { dirOpened = await TauriApi.shellOpen(dir); } catch (e) { console.error('[openFolder] shell.open 异常:', e); dirOpened = false; }
        } else {
          console.error('[openFolder] shellOpen 不可用');
        }
        if (dirOpened) return;
  
        this.setStatus(this.t('openFolderFailed'));
      },
      async batchSaveTabs(tabs) {
        for (const tab of tabs) {
          if (!tab.isModified) continue;
          try {
            if (!tab.filePath) {
              const path = await dialogSave({
                filters: [
                  { name: 'Markdown', extensions: ['md'] },
                  { name: this.t('allFiles'), extensions: ['*'] }
                ]
              });
              if (!path) return false;
              tab.filePath = path;
              tab.name = path.split(/[/\\]/).pop();
            }
            await TauriApi.writeFile({ path: tab.filePath, content: tab.content });
            tab.savedContent = tab.content;
            await this.refreshFileMeta(tab);
          } catch (error) {
            this.setStatus(`${this.t('saveFailed')}: ${error}`);
            return false;
          }
        }
        return true;
      },
    // 文件树排序键与升降序控件
    initFolderSortControls() {
      document.getElementById('folder-close').addEventListener('click', () => {
        this.closeFolder();
      });
      // 文件目录排序控件：自绘 Select 组件（替代原生 select，展开面板可主题化 + 完整 ARIA）
      const sortKeyHost = document.getElementById('folder-sort-key');
      if (sortKeyHost) {
        this._folderSortSelect = new Select(sortKeyHost, {
          value: this.settings.fileSortKey || 'name',
          t: this.t.bind(this),
          ariaLabelKey: 'fileSort',
          optionsProvider: (t) => ([
            { value: 'name', label: t('sortByName') },
            { value: 'time', label: t('sortByTime') },
            { value: 'created', label: t('sortByCreated') },
          ]),
          onChange: (v) => {
            this.settings.fileSortKey = v;
            this.saveSettings();
            this.renderFolderTree();
          },
        });
      }
      const sortOrderEl = document.getElementById('folder-sort-order');
      if (sortOrderEl) {
        sortOrderEl.addEventListener('click', () => {
          this.settings.fileSortOrder = this.settings.fileSortOrder === 'desc' ? 'asc' : 'desc';
          this.saveSettings();
          this.updateFolderSortOrderButton();
          this.renderFolderTree();
        });
      }
      this.updateFolderSortOrderButton();
    },
    // 文件树右键菜单快捷键（合并自 PR #36）：_fileTreeCtx 存在时，F2/Delete/Ctrl+X/C/V 对其生效。
    // 关键修复：点击文件打开后焦点落在编辑器（.CodeMirror），旧逻辑用「!inEditor」拦截导致
    // Ctrl+C/V 被 CodeMirror 吞掉、文件复制/粘贴「不起作用」。现改为：Ctrl+C/X/V 以文件树操作为先，
    // 仅当编辑器或预览区存在文本选区时才让位给文本复制/剪切/粘贴。
    // 用户真正点进编辑器编辑时（editorWrapper mousedown）会清掉 _fileTreeCtx，恢复纯文本操作。
    _handleFileTreeKeydown(e) {
      if (!this._fileTreeCtx) return false;
      const inInput = e.target.closest('input, textarea, select');
      if (inInput) return false;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'F2') { e.preventDefault(); this.fileTreeRename(); return true; }
      if (e.key === 'Delete') { e.preventDefault(); this.fileTreeDelete(); return true; }
      if (ctrl && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        // 检查编辑器或预览区是否有文本选区——有选区时交给浏览器原生 copy/cut，
        // 不走文件树操作。预览区是 HTML 内容，window.getSelection() 检测其选区。
        const hasTextSelection = (this.cm && this.cm.somethingSelected())
          || (window.getSelection && window.getSelection().toString().length > 0);
        // 复制 / 剪切：有文本选区时交给编辑器/浏览器；否则按文件树复制/剪切
        if (k === 'x' || k === 'c') {
          if (hasTextSelection) return true;
          e.preventDefault();
          if (k === 'c') this.fileTreeCopy(); else this.fileTreeCut();
          return true;
        }
        // 粘贴：文件树选中节点（目录或文件）且无文本选区时，粘贴文件。
        // 选中目录→粘贴进该目录；选中文件→粘贴进其所在目录（同级）。有文本选区时交给文本粘贴。
        if (k === 'v') {
          if (!hasTextSelection) {
            e.preventDefault();
            this.fileTreePaste();
          }
          return true;
        }
      }
      if (ctrl && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        if (this._fileTreeTargetDir()) this.fileTreeNewFile();
        return true;
      }
      if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        if (this._fileTreeTargetDir()) this.fileTreeNewFolder();
        return true;
      }
      return false;
    },

  };

  const api = { mixin };
  window.TMFiles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
