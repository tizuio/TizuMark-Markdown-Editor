// 关于、自动更新与窗口控制
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';

  const mixin = {
      async showAbout() {
        const dialog = document.getElementById('about-dialog');
        // 每次打开重置为默认居中尺寸（拖动/缩放状态不记忆，符合预期）
        const ap = dialog ? dialog.querySelector('.dialog') : null;
        if (ap && typeof window.resetDialog === 'function') window.resetDialog(ap);
        // 每次打开重置折叠状态：所有分类默认展开
        dialog.querySelectorAll('.dependency-details').forEach((sec) => sec.setAttribute('data-collapsed', 'false'));
        dialog.classList.remove('hidden');
        // 折叠块展开/收起由全局委托 bindCollapseToggle 统一处理，
        // 各块默认状态（展开/收起）由 HTML data-collapsed 初始值决定，此处不再干预。
        if (!dialog._devSetup) {
          dialog._devSetup = true;
          let cnt = 0;
          let timer = null;
          const verEl = document.getElementById('about-version');
          if (verEl) {
            verEl.addEventListener('click', async () => {
              cnt++;
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => { cnt = 0; }, 400);
              if (cnt >= 5) {
                cnt = 0;
                clearTimeout(timer);
                timer = null;
                try {
                  await TauriApi.openDevtools();
                  this.showToast(this.t('devtoolsOpened'), 'success');
                } catch (e) {
                  this.showToast(this.t('devtoolsOpenFailed', { err: e }), 'danger');
                }
              }
            });
          }
        }
        try {
          const ver = await TauriApi.getVersion();
          const el = document.getElementById('about-version');
          if (el) el.textContent = 'v' + ver;
        } catch (_) {}
      },
      hideAbout() {
        document.getElementById('about-dialog').classList.add('hidden');
      },
      showUpdateDialog() {
        document.getElementById('update-dialog').classList.remove('hidden');
      },
      hideUpdateDialog() {
        this._updateDismissed = true;
        document.getElementById('update-dialog').classList.add('hidden');
      },
      showUpdateState(state, checkId) {
        ['checking', 'available', 'latest'].forEach(s => {
          document.getElementById('update-state-' + s).classList.toggle('hidden', s !== state);
        });
        const titles = {
          checking: this.t('updateChecking'),
          available: this.t('updateAvailable'),
          latest: this.t('updateLatest'),
        };
        const titleEl = document.getElementById('update-title');
        if (titleEl) titleEl.textContent = titles[state] || this.t('updateAvailable');
        const btn = document.getElementById('update-action');
        const skipBtn = document.getElementById('update-skip');
        if (state === 'checking') {
          btn.disabled = true;
          btn.textContent = this.t('updateChecking');
          document.getElementById('update-progress-wrap').classList.add('hidden');
          if (skipBtn) skipBtn.classList.remove('hidden');
        } else if (state === 'available') {
          if (skipBtn) skipBtn.classList.remove('hidden');
        } else if (state === 'latest') {
          // 已是最新：弹框保持打开，不弹 toast，下方按钮变为单个蓝色「确认」
          if (skipBtn) skipBtn.classList.add('hidden');
          btn.disabled = false;
          btn.dataset.state = 'confirm';
          btn.textContent = this.t('updateConfirm');
          document.getElementById('update-progress-wrap').classList.add('hidden');
          this._fillLatestVersion(checkId);
        }
      },
      async _fillLatestVersion(checkId) {
        const el = document.getElementById('update-latest-version');
        if (!el) return;
        try {
          const ver = await TauriApi.getVersion();
          if (checkId !== undefined && this._updateCheckId !== checkId) return;
          el.textContent = 'v' + ver;
        } catch (_) {}
      },
      async checkUpdate(showUpToDate = false) {
        const checkId = (this._updateCheckId || 0) + 1;
        this._updateCheckId = checkId;
        this._updateDismissed = false;
        if (showUpToDate) {
          this.showUpdateDialog();
          this.showUpdateState('checking', checkId);
        }
        try {
  
          const result = await TauriApi.updater.check();
          if (this._updateCheckId !== checkId || this._updateDismissed) return;
          if (!result) {
            if (showUpToDate) {
              this.showUpdateState('latest', checkId);
            }
            return;
          }
          const update = result;
          if (!showUpToDate) this.showUpdateDialog();
          document.getElementById('update-new-version').textContent = update.version;
          try {
            const ver = await TauriApi.getVersion();
            if (this._updateCheckId !== checkId || this._updateDismissed) return;
            document.getElementById('update-current-version').textContent = ver;
          } catch (_) {}
          const notesEl = document.getElementById('update-notes-body');
          if (update.body) {
            if (window.markdownit) {
              notesEl.innerHTML = window.markdownit({ html: false, linkify: true }).render(update.body);
            } else {
              notesEl.innerHTML = update.body.replace(/\n/g, '<br>');
            }
          } else {
            notesEl.textContent = this.t('noUpdateNotes');
          }
          this.showUpdateState('available', checkId);
          this.pendingUpdate = update;
          this.pendingUpdateRid = update.rid;
          this.setUpdateAction('download');
        } catch (err) {
          console.error('Update check failed:', err);
          if (showUpToDate) {
            this.hideUpdateDialog();
            this.showToast(this.t('updateFailed'));
          }
        }
      },
      setUpdateAction(state) {
        const btn = document.getElementById('update-action');
        btn.dataset.state = state;
        btn.disabled = state === 'downloading';
        if (state === 'download') {
          btn.textContent = this.t('updateDownloadLabel');
        } else if (state === 'downloading') {
          btn.textContent = this.t('updateDownloading');
        } else if (state === 'install') {
          btn.textContent = this.t('updateInstallNow');
        }
      },
      async handleUpdateAction() {
        const state = document.getElementById('update-action').dataset.state;
        if (state === 'confirm') {
          this.hideUpdateDialog();
          return;
        }
        if (state === 'download') {
          this.setUpdateAction('downloading');
          document.getElementById('update-progress-wrap').classList.remove('hidden');
          await this.downloadUpdate();
        } else if (state === 'install') {
          await this.installUpdate();
        }
      },
      async downloadUpdate() {
        if (!this.pendingUpdate || !this.pendingUpdateRid) return;
        this.pendingBytesRid = null;
        try {
  
          const channel = new TauriApi.Channel();
          let totalSize = 0;
          let downloadedSize = 0;
          channel.onmessage = (eventData) => {
            if (eventData.event === 'Started') {
              totalSize = eventData.data?.contentLength || 0;
            } else if (eventData.event === 'Progress') {
              downloadedSize += eventData.data?.chunkLength || 0;
              const pct = totalSize > 0 ? Math.min(100, Math.round((downloadedSize / totalSize) * 100)) : 0;
              document.getElementById('update-progress-fill').style.width = pct + '%';
              document.getElementById('update-progress-text').textContent = pct + '%';
            } else if (eventData.event === 'Finished') {
              document.getElementById('update-progress-fill').style.width = '100%';
              document.getElementById('update-progress-text').textContent = '100%';
            }
          };
          const bytesRid = await TauriApi.updater.download({ rid: this.pendingUpdateRid, onEvent: channel });
          this.pendingBytesRid = bytesRid;
          this.setUpdateAction('install');
        } catch (err) {
          console.error('Download failed:', err);
          this.showToast(this.t('updateFailed'));
          this.hideUpdateDialog();
        }
      },
      async installUpdate() {
        if (!this.pendingUpdateRid || !this.pendingBytesRid) return;
        document.getElementById('update-action').disabled = true;
        this.hideUpdateDialog();
        try {
  
          await TauriApi.updater.install({ updateRid: this.pendingUpdateRid, bytesRid: this.pendingBytesRid });
        } catch (err) {
          console.error('Install failed:', err);
          document.getElementById('update-action').disabled = false;
          this.showToast(this.t('updateFailed'));
        }
      },
      openExternal(url) {
        TauriApi.shellOpen(url).then((opened) => {
          if (!opened) window.open(url, '_blank', 'noopener,noreferrer');
        });
      },
      async minimizeWindow() {
        try {
          const appWindow = TauriApi.currentWindow();
          await appWindow.minimize();
        } catch (e) {
          console.warn('minimize failed:', e);
        }
      },
      async toggleMaximize() {
        try {
          const appWindow = TauriApi.currentWindow();
          const isMaximized = await appWindow.isMaximized();
          if (isMaximized) {
            await appWindow.unmaximize();
          } else {
            await appWindow.maximize();
          }
          this.updateMaximizeIcon();
        } catch (e) {
          console.warn('maximize failed:', e);
        }
      },
      async updateMaximizeIcon() {
        try {
          const appWindow = TauriApi.currentWindow();
          const isMaximized = await appWindow.isMaximized();
          const btn = document.getElementById('btn-maximize');
          if (isMaximized) {
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
          } else {
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>';
          }
        } catch (e) {
          console.warn('updateMaximizeIcon failed:', e);
        }
      },
      async closeWindow() {
        await this.handleAppClose();
      },
    // 窗口三钮与标题栏拖拽
    initWindowControls() {
      document.getElementById('btn-minimize').addEventListener('click', () => this.minimizeWindow());
      document.getElementById('btn-maximize').addEventListener('click', () => this.toggleMaximize());
      document.getElementById('btn-close').addEventListener('click', () => this.closeWindow());

      const header = document.querySelector('.header');
      if (header) {
        header.addEventListener('mousedown', async (e) => {
          if (e.target.closest('button, input, select, textarea, .dropdown-menu, .app-icon, .view-mode-tab, .window-controls')) {
            return;
          }
          if (e.button === 0) {
            // 阻止冒泡到 document，避免 Tauri 注入的 drag.js（data-tauri-drag-region）
            // 与这里调用同一个 start_dragging IPC 造成重复触发
            e.stopPropagation();
            if (e.detail === 2) {
              this.toggleMaximize();
              return;
            }
            try {
              const appWindow = TauriApi.currentWindow();
              if (appWindow && typeof appWindow.startDragging === 'function') {
                await appWindow.startDragging();
              }
            } catch (err) {
              console.warn('startDragging failed:', err);
            }
          }
        });
      }
    },
  };

  const api = { mixin };
  window.TMUpdater = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
