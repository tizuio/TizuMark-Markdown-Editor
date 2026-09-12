// 标签页管理与最近文件/工作区
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { Tab, dialogSave } = TMConst;

  const mixin = {
      async ensureTabLoaded(tab) {
        if (!tab) return;
        if (tab._loaded || !tab.filePath) { tab._loaded = true; return; }
        // 图片不读文本：内容由预览面板经 fetchImageAsBase64 从路径渲染，按文本读会污染 tab.content（乱码）
          if (tab.kind === 'image') { tab.content = ''; tab._loaded = true; return; }
        try {
          const content = await this.readFileNormalized(tab.filePath);
          tab.content = content;
          tab.savedContent = content;
          await this.refreshFileMeta(tab);
        } catch (e) {
          // 懒加载失败（文件被删/锁定/无权限）：标记错误并提示，避免静默空白
          tab._loadError = true;
          tab.content = '';
          tab.savedContent = '';
          this.reportError(e.code || 'E_IO', { context: { path: tab.filePath }, error: e, params: e.params, detail: e.detail });
        }
        tab._loaded = true;
      },
      // 切换/打开/重载文档后，恢复该 tab 记忆的滚动位置（编辑器 + 预览）。
      // 统一临时关闭滚动同步，避免恢复过程中的程序化滚动事件互相重定位，导致
      // 「切换标签页后预览/页面跳到别处」。下一帧再恢复滚动同步，交还给用户。
      _restoreSwitchScroll(restoreScroll, restorePreviewTop) {
        this._canScroll.editor = false;
        this._canScroll.preview = false;
        this.cm.scrollTo(restoreScroll.left || 0, restoreScroll.top || 0);
        const maxScroll = Math.max(this.preview.scrollHeight - this.preview.clientHeight, 0);
        this.preview.scrollTop = Math.min(restorePreviewTop || 0, maxScroll);
        setTimeout(() => this._resumeScroll(), 0);
      },
      async switchTab(index) {
        if (index === this.activeTabIndex || index < 0 || index >= this.tabs.length) return;
  
        this._largeFileNoticeDismissed = false;
        this._previewFocusLine = 0;
        this.previewWindow = null;
        this._beginPaneLoad();
        try {
          const oldTab = this.activeTab;
          oldTab.content = this.cm.getValue();
          oldTab.cursorPos = this.cm.getCursor();
          oldTab.scrollPos = { top: this.cm.getScrollInfo().top, left: this.cm.getScrollInfo().left };
          oldTab.previewScrollTop = this.preview.scrollTop;
  
          this.activeTabIndex = index;
          const newTab = this.activeTab;
          // 编辑器字号为全局（editorZoom），切 tab 不改变字号
          this.hideZoomHint();
  
          if (!newTab._loaded && newTab.filePath) {
            await this.ensureTabLoaded(newTab);
          }
  
          // 关键：先把恢复值读到局部变量。setValue 会同步触发 scroll / cursorActivity 事件，
          // 此刻 this.activeTab 已是 newTab，事件处理器会把 newTab.scrollPos / cursorPos 覆盖为 0，
          // 所以恢复必须用这里的快照副本，不能再回头读 newTab.*（否则会读到被污染的 0 → 回到顶部）。
          const restoreCursor = newTab.cursorPos || { line: 0, ch: 0 };
          const restoreScroll = newTab.scrollPos || { top: 0, left: 0 };
          const restorePreviewTop = newTab.previewScrollTop || 0;
  
          if (newTab.kind === 'image') {
            this.cm.setValue('');
          } else {
            this.cm.setValue(newTab.content || '');
            const newExt = (newTab.filePath && window.FileTypes && window.FileTypes.extOf)
              ? window.FileTypes.extOf(newTab.filePath)
              : (newTab.kind === 'markdown' ? 'md' : '');
            this._applyCodeMode(newExt);
          }
          clearTimeout(this.debounceTimer);
          this.cm.setCursor(restoreCursor);
          this.cm.clearHistory();
  
          this.updateTabDisplay();
          await this.updatePreview();
          // 统一恢复该 tab 记忆的编辑器/预览滚动位置。临时关闭滚动同步，避免恢复过程中
          // 程序化滚动事件互相重定位（分屏 + 滚动同步开启时预览会被编辑器同步覆盖，
          // 表现为「切换后预览/页面跳到别处」）。
          this._restoreSwitchScroll(restoreScroll, restorePreviewTop);
          this.updateWordCount();
          this.updateOutline();
          this.updateExternalChangeBanner();
          this.highlightTreeActiveFile();
          this.syncViewModeToTab();
        } finally {
          this._endPaneLoad();
        }
      },
      async addTab(name = '', content = '', filePath = null, kind = 'markdown') {
        const defaultName = this.t('untitled');
        if (!name || name === defaultName) {
          name = `${defaultName}${this.untitledCounter++}`;
        }
        content = content.replace(/\r\n/g, '\n');
        const tab = new Tab(name, content, filePath, kind);
        this.tabs.push(tab);
        this.refreshFileMeta(tab);
        await this.switchTab(this.tabs.length - 1);
        this.updateTabBar();
        try {
          if (filePath) this.addRecentFile(filePath);
        } catch (e) {
          console.error('[TizuMark] addRecentFile failed:', e);
        }
        this.saveSession();
      },
      async closeTab(index) {
        if (index < 0 || index >= this.tabs.length) return;
  
        const tab = this.tabs[index];
        if (tab.isModified) {
          const result = await this.showSaveDialog(this.t('saveChanges'), `${tab.name} ${this.t('fileModified')}`);
          if (result === 'cancel') return;
          if (result === 'save') {
            const savedIndex = this.tabs.indexOf(tab);
            if (savedIndex === -1) return;
            try {
              if (!tab.filePath) {
                const path = await dialogSave({
                  filters: [
                    { name: 'Markdown', extensions: ['md'] },
                    { name: this.t('allFiles'), extensions: ['*'] }
                  ]
                });
                if (!path) return;
                tab.filePath = path;
                tab.name = path.split(/[/\\]/).pop();
              }
              await TauriApi.writeFile({ path: tab.filePath, content: tab.content });
              tab.savedContent = tab.content;
              await this.refreshFileMeta(tab);
              this.setStatus(`${this.t('saved')}: ${tab.filePath}`);
            } catch (error) {
              this.setStatus(`${this.t('saveFailed')}: ${error}`);
              return;
            }
          }
        }
  
        const removeIndex = this.tabs.indexOf(tab);
        if (removeIndex === -1) return;
  
        if (this._externalQueue) this._externalQueue = this._externalQueue.filter(t => t !== tab);
        this.tabs.splice(removeIndex, 1);
        if (this.tabs.length === 0) {
          this.tabs.push(new Tab(`${this.t('untitled')}${this.untitledCounter++}`));
          this.activeTabIndex = 0;
          this.cm.setValue('');
        } else {
          if (removeIndex < this.activeTabIndex) {
            this.activeTabIndex--;
          } else if (this.activeTabIndex >= this.tabs.length) {
            this.activeTabIndex = this.tabs.length - 1;
          }
        }
        this.updateTabBar();
        if (this.tabs.length > 0) {
          await this.ensureTabLoaded(this.activeTab);
          this.cm.setValue(this.activeTab.content || '');
          this.cm.setCursor(this.activeTab.cursorPos || { line: 0, ch: 0 });
          this.updatePreview();
        }
        this.saveSession();
      },
      // ---- 标签页拖拽排序 ----
      reorderTab(from, to) {
        if (from === to || from < 0 || from >= this.tabs.length || to < 0 || to >= this.tabs.length) return;
        const [moved] = this.tabs.splice(from, 1);
        this.tabs.splice(to, 0, moved);
        // 跟踪 activeTab 跟随移动
        if (this.activeTabIndex === from) {
          this.activeTabIndex = to;
        } else if (from < this.activeTabIndex && to >= this.activeTabIndex) {
          this.activeTabIndex--;
        } else if (from > this.activeTabIndex && to <= this.activeTabIndex) {
          this.activeTabIndex++;
        }
        this.updateTabBar();
        this.saveSession();
      },
      // 拖拽排序辅助（基于指针事件，不依赖原生 HTML5 DnD）
      _tabElAt(index) {
        return document.querySelector(`.tab[data-index="${index}"]`);
      },
      _tabIndexAtPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const tab = el.closest('.tab');
        if (!tab || tab.dataset.index == null) return null;
        return parseInt(tab.dataset.index, 10);
      },
      _startTabDrag(from) {
        const tab = this._tabElAt(from);
        if (tab) tab.classList.add('dragging');
        document.body.style.userSelect = 'none';
      },
      _updateTabDragTarget(x, y) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
        const idx = this._tabIndexAtPoint(x, y);
        if (idx != null) {
          const t = this._tabElAt(idx);
          if (t) t.classList.add('drag-over');
        }
      },
      _endTabDrag() {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over', 'dragging'));
        document.body.style.userSelect = '';
      },
      // ---- 最近文件 ----
      loadRecentFiles() {
        try {
          const raw = localStorage.getItem('tizumark-recent-files');
          const arr = raw ? JSON.parse(raw) : [];
          this._recentFiles = Array.isArray(arr) ? arr.filter(p => typeof p === 'string') : [];
        } catch {
          this._recentFiles = [];
        }
      },
      saveRecentFiles() {
        try {
          localStorage.setItem('tizumark-recent-files', JSON.stringify(this._recentFiles || []));
        } catch {}
      },
      addRecentFile(filePath) {
        if (!filePath) return;
        const list = this._recentFiles || (this._recentFiles = []);
        const idx = list.indexOf(filePath);
        if (idx !== -1) list.splice(idx, 1);
        list.unshift(filePath);
        if (list.length > 10) list.length = 10;
        this.saveRecentFiles();
        if (this._recentSubmenuVisible) this.renderRecentFilesSubmenu();
      },
      clearRecentFiles() {
        this._recentFiles = [];
        this.saveRecentFiles();
        if (this._recentSubmenuVisible) this.renderRecentFilesSubmenu();
      },
      loadRecentWorkspaces() {
        try {
          const raw = localStorage.getItem('tizumark-recent-workspaces');
          const arr = raw ? JSON.parse(raw) : [];
          this._recentWorkspaces = Array.isArray(arr) ? arr.filter(p => typeof p === 'string') : [];
        } catch {
          this._recentWorkspaces = [];
        }
      },
      saveRecentWorkspaces() {
        try {
          localStorage.setItem('tizumark-recent-workspaces', JSON.stringify(this._recentWorkspaces || []));
        } catch {}
      },
      addRecentWorkspace(folderPath) {
        if (!folderPath) return;
        const list = this._recentWorkspaces || (this._recentWorkspaces = []);
        const idx = list.indexOf(folderPath);
        if (idx !== -1) list.splice(idx, 1);
        list.unshift(folderPath);
        if (list.length > 10) list.length = 10;
        this.saveRecentWorkspaces();
        if (this._recentWorkspacesSubmenuVisible) this.renderRecentWorkspacesSubmenu();
      },
      clearRecentWorkspaces() {
        this._recentWorkspaces = [];
        this.saveRecentWorkspaces();
        if (this._recentWorkspacesSubmenuVisible) this.renderRecentWorkspacesSubmenu();
      },
      async refreshRecentFiles() {
        if (!this._recentFiles || this._recentFiles.length === 0) return;
        const fileMenu = document.getElementById('file-menu');
        if (!fileMenu || fileMenu.classList.contains('hidden')) return;
        let changed = false;
        const survivors = [];
        for (const p of this._recentFiles) {
          let exists = true;
          try {
            const meta = await TauriApi.fileMeta({ path: p });
            exists = meta !== null && meta !== undefined;
          } catch {
            exists = true; // 查询失败保守保留，避免误删
          }
          if (exists) survivors.push(p); else changed = true;
        }
        if (changed) {
          this._recentFiles = survivors;
          this.saveRecentFiles();
          this.renderRecentFilesSubmenu();
        }
      },
      hideRecentSubmenu() {
        const sm = document.getElementById('recent-files-submenu');
        if (sm) sm.classList.add('hidden');
        this._recentSubmenuVisible = false;
      },
      showRecentSubmenu() {
        const trigger = document.getElementById('btn-recent');
        const submenu = document.getElementById('recent-files-submenu');
        if (!trigger || !submenu) return;
        this.hideRecentWorkspacesSubmenu(); // 与最近工作区子菜单互斥，避免重叠遮盖
        this.renderRecentFilesSubmenu();
        submenu.classList.remove('hidden');
        this._recentSubmenuVisible = true;
        this.positionSubmenu(trigger, submenu);
      },
      positionSubmenu(trigger, submenu) {
        if (!trigger || !submenu) return;
        const rect = trigger.getBoundingClientRect();
        submenu.style.left = (rect.right - 1) + 'px';
        submenu.style.top = rect.top + 'px';
        requestAnimationFrame(() => {
          const sr = submenu.getBoundingClientRect();
          if (sr.right > window.innerWidth) submenu.style.left = (rect.left - sr.width + 1) + 'px';
          if (sr.bottom > window.innerHeight) submenu.style.top = (window.innerHeight - sr.height - 4) + 'px';
        });
      },
      renderRecentWorkspacesSubmenu() {
        const submenu = document.getElementById('recent-workspaces-submenu');
        if (!submenu) return;
        const list = this._recentWorkspaces || [];
        submenu.innerHTML = '';
        if (list.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'dropdown-item disabled';
          empty.textContent = this.t('noRecentWorkspaces');
          submenu.appendChild(empty);
          return;
        }
        list.forEach(p => {
          const item = document.createElement('div');
          item.className = 'dropdown-item recent-file-item recent-workspace-item';
          item.dataset.path = p;
          const name = p.split(/[/\\]/).pop() || p;
          const dir = p.slice(0, Math.max(0, p.length - name.length)).replace(/[/\\]$/, '');
          const nameEl = document.createElement('span');
          nameEl.className = 'recent-file-name recent-workspace-name';
          nameEl.textContent = name;
          const dirEl = document.createElement('span');
          dirEl.className = 'recent-file-dir recent-workspace-dir';
          dirEl.textContent = dir;
          item.appendChild(nameEl);
          item.appendChild(dirEl);
          item.title = p;
          submenu.appendChild(item);
        });
        const sep = document.createElement('div');
        sep.className = 'dropdown-separator';
        submenu.appendChild(sep);
        const clear = document.createElement('div');
        clear.className = 'dropdown-item recent-clear recent-workspace-clear';
        clear.dataset.action = 'clear';
        clear.textContent = this.t('clearRecentWorkspaces');
        submenu.appendChild(clear);
      },
      showRecentWorkspacesSubmenu() {
        const trigger = document.getElementById('btn-recent-workspaces');
        const submenu = document.getElementById('recent-workspaces-submenu');
        if (!trigger || !submenu) return;
        this.hideRecentSubmenu(); // 与最近文件子菜单互斥，避免重叠遮盖
        this.renderRecentWorkspacesSubmenu();
        submenu.classList.remove('hidden');
        this._recentWorkspacesSubmenuVisible = true;
        this.positionSubmenu(trigger, submenu);
      },
      hideRecentWorkspacesSubmenu() {
        const sm = document.getElementById('recent-workspaces-submenu');
        if (sm) sm.classList.add('hidden');
        this._recentWorkspacesSubmenuVisible = false;
      },
      renderRecentFilesSubmenu() {
        const submenu = document.getElementById('recent-files-submenu');
        if (!submenu) return;
        const list = this._recentFiles || [];
        submenu.innerHTML = '';
        if (list.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'dropdown-item disabled';
          empty.textContent = this.t('noRecentFiles');
          submenu.appendChild(empty);
          return;
        }
        list.forEach(p => {
          const item = document.createElement('div');
          item.className = 'dropdown-item recent-file-item';
          item.dataset.path = p;
          const name = p.split(/[/\\]/).pop() || p;
          const dir = p.slice(0, Math.max(0, p.length - name.length)).replace(/[/\\]$/, '');
          const nameEl = document.createElement('span');
          nameEl.className = 'recent-file-name';
          nameEl.textContent = name;
          const dirEl = document.createElement('span');
          dirEl.className = 'recent-file-dir';
          dirEl.textContent = dir;
          item.appendChild(nameEl);
          item.appendChild(dirEl);
          item.title = p;
          submenu.appendChild(item);
        });
        const sep = document.createElement('div');
        sep.className = 'dropdown-separator';
        submenu.appendChild(sep);
        const clear = document.createElement('div');
        clear.className = 'dropdown-item recent-clear';
        clear.dataset.action = 'clear';
        clear.textContent = this.t('clearRecentFiles');
        submenu.appendChild(clear);
      },
      updateTabBar() {
        const tabBar = document.getElementById('tab-bar');
        const addBtn = document.getElementById('btn-add-tab');
  
        const fragment = document.createDocumentFragment();
  
        this.tabs.forEach((tab, i) => {
          const tabEl = document.createElement('div');
          tabEl.className = `tab${i === this.activeTabIndex ? ' active' : ''}${tab.isModified ? ' modified' : ''}`;
          tabEl.dataset.index = i;
          tabEl.setAttribute('role', 'tab');
          tabEl.setAttribute('aria-selected', i === this.activeTabIndex ? 'true' : 'false');
  
          const nameSpan = document.createElement('span');
          nameSpan.className = 'tab-name';
          nameSpan.textContent = tab.name;
          tabEl.appendChild(nameSpan);
  
          if (this.tabs.length > 1) {
            const closeBtn = document.createElement('span');
            closeBtn.className = 'tab-close';
            closeBtn.textContent = '\u00d7';
            closeBtn.setAttribute('role', 'button');
            closeBtn.setAttribute('aria-label', this.t('closeAria'));
            closeBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this.closeTab(i);
            });
            tabEl.appendChild(closeBtn);
          }
  
          tabEl.addEventListener('click', () => {
            if (this._suppressClick) { this._suppressClick = false; return; }
            this.switchTab(i);
          });
          // 中键点击关闭标签页；左键按下准备拖拽排序（用指针事件实现，绕过 Tauri 默认 dragDropEnabled 接管原生 DnD 导致拖不动的问题）
          tabEl.addEventListener('mousedown', (e) => {
            this._suppressClick = false;
            if (e.button === 1) { e.preventDefault(); this.closeTab(i); return; }
            if (e.button === 0) {
              this._dragState = { from: i, startX: e.clientX, startY: e.clientY, active: false };
            }
          });
          // 鼠标悬停显示完整路径（含文件名）；未保存标签无 filePath 时回退文件名
          tabEl.title = tab.filePath || tab.name;
          fragment.appendChild(tabEl);
        });
  
        tabBar.replaceChildren(fragment);
        if (addBtn) tabBar.appendChild(addBtn);
        // Refresh scroll arrows after tabs change
        if (this.updateTabScrollArrows) this.updateTabScrollArrows();
      },
      updateTabDisplay() {
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach((tab, i) => {
          if (i >= this.tabs.length) return;
          tab.className = `tab${i === this.activeTabIndex ? ' active' : ''}${this.tabs[i].isModified ? ' modified' : ''}${this.tabs[i].pendingExternalChange ? ' external-change' : ''}`;
          tab.querySelector('.tab-name').textContent = this.tabs[i].name;
        });
      },
      async closeOtherTabs(keepIndex) {
        if (keepIndex < 0 || keepIndex >= this.tabs.length) return;
        const otherModified = this.tabs.filter((t, i) => i !== keepIndex && t.isModified);
        if (otherModified.length > 0) {
          const result = await this.showSaveDialog(
            this.t('saveChanges'),
            this.t('filesModifiedConfirm', { n: otherModified.length }),
            this.t('saveAll'), this.t('discardAll'), this.t('cancel')
          );
          if (result === 'cancel') return;
          if (result === 'save') {
            const ok = await this.batchSaveTabs(otherModified);
            if (!ok) return;
          } else {
            for (const tab of otherModified) {
              tab.content = tab.savedContent;
            }
            this.cm.setValue(this.activeTab.content);
            this.updateTabDisplay();
            this.updatePreview();
          }
        }
        const tab = this.tabs[keepIndex];
        this.tabs = [tab];
        this.activeTabIndex = 0;
        await this.ensureTabLoaded(tab);
        this.cm.setValue(tab.content || '');
        this.cm.setCursor(tab.cursorPos || { line: 0, ch: 0 });
        this.updateTabBar();
        this.updatePreview();
        this.saveSession();
      },
      async closeAllTabs() {
        const modified = this.tabs.filter(t => t.isModified);
        if (modified.length > 0) {
          const result = await this.showSaveDialog(
            this.t('saveChanges'),
            this.t('filesModifiedConfirm', { n: modified.length }),
            this.t('saveAll'), this.t('discardAll'), this.t('cancel')
          );
          if (result === 'cancel') return;
          if (result === 'save') {
            const ok = await this.batchSaveTabs(modified);
            if (!ok) return;
          }
        }
        this.tabs = [new Tab(`${this.t('untitled')}${this.untitledCounter++}`)];
        this.activeTabIndex = 0;
        this.cm.setValue('');
        this.updateTabBar();
        this.updatePreview();
        this.saveSession();
      },
    // 标签页拖拽排序（指针事件，规避 Tauri 原生 DnD 接管）
    initTabDragEvents() {
      // 标签页拖拽排序：用指针事件实现，避免 Tauri 默认开启 dragDropEnabled 接管原生 DnD 导致拖不动
      document.addEventListener('mousemove', (e) => {
        const ds = this._dragState;
        if (!ds) return;
        if (!ds.active) {
          const dx = e.clientX - ds.startX;
          const dy = e.clientY - ds.startY;
          if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
          ds.active = true;
          this._startTabDrag(ds.from);
        }
        this._updateTabDragTarget(e.clientX, e.clientY);
      });
      document.addEventListener('mouseup', (e) => {
        const ds = this._dragState;
        if (!ds) return;
        if (ds.active) {
          const to = this._tabIndexAtPoint(e.clientX, e.clientY);
          if (to != null && to !== ds.from) this.reorderTab(ds.from, to);
          this._endTabDrag();
          this._suppressClick = true;
        }
        this._dragState = null;
      });
    },
    // 最近文件 / 最近工作区子菜单交互
    initRecentMenus() {
      // 最近文件子菜单交互
      document.getElementById('btn-recent').addEventListener('mouseenter', () => {
        this.showRecentSubmenu();
      });
      document.getElementById('btn-recent').addEventListener('click', (e) => {
        e.stopPropagation();
        this.showRecentSubmenu();
      });
      document.getElementById('file-menu').addEventListener('mouseover', (e) => {
        if (e.target.closest('#recent-files-submenu')) return;
        if (e.target.closest('#btn-recent')) return;
        if (e.target.closest('#recent-workspaces-submenu')) return;
        if (e.target.closest('#btn-recent-workspaces')) return;
        this.hideRecentSubmenu();
        this.hideRecentWorkspacesSubmenu();
      });
      const recentSubmenu = document.getElementById('recent-files-submenu');
      recentSubmenu.addEventListener('click', (e) => {
        e.stopPropagation();
        const clearItem = e.target.closest('[data-action="clear"]');
        if (clearItem) {
          this.clearRecentFiles();
          this.hideRecentSubmenu();
          return;
        }
        const item = e.target.closest('.recent-file-item');
        if (item && item.dataset.path) {
          const path = item.dataset.path;
          document.getElementById('file-menu').classList.add('hidden');
          this.hideRecentSubmenu();
          this.openFilePath(path);
        }
      });
      // 最近工作区子菜单交互
      const wsTrigger = document.getElementById('btn-recent-workspaces');
      if (wsTrigger) {
        wsTrigger.addEventListener('mouseenter', () => this.showRecentWorkspacesSubmenu());
        wsTrigger.addEventListener('click', (e) => {
          e.stopPropagation();
          this.showRecentWorkspacesSubmenu();
        });
      }
      const wsSubmenu = document.getElementById('recent-workspaces-submenu');
      if (wsSubmenu) {
        wsSubmenu.addEventListener('click', (e) => {
          e.stopPropagation();
          const clearItem = e.target.closest('[data-action="clear"]');
          if (clearItem) {
            this.clearRecentWorkspaces();
            this.hideRecentWorkspacesSubmenu();
            return;
          }
          const item = e.target.closest('.recent-workspace-item');
          if (item && item.dataset.path) {
            const path = item.dataset.path;
            document.getElementById('file-menu').classList.add('hidden');
            this.hideRecentWorkspacesSubmenu();
            this.maybeOpenFolderPath(path, { confirm: true });
          }
        });
      }
    },
  };

  const api = { mixin };
  window.TMTabs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
