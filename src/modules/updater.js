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
      // 「跳过此版本」：记住当前提示的远程版本号并落盘，之后自动检查遇到同版本不再弹窗
      // （checkUpdate 里的 skipped 判定）。与「稍后再说」的区别：稍后只关窗，下次检查还会提示。
      skipUpdateVersion() {
        const ver = (this.pendingUpdate && this.pendingUpdate.version) || '';
        if (!ver) return;
        this.settings.skippedUpdateVersion = ver;
        this.saveSettings();
        this.hideUpdateDialog();
        this.showToast(this.t('updateVersionSkipped', { ver }), 'success');
      },
      // 从 updater 返回的完整更新 JSON（raw_json.platforms[当前平台]）读下载 URL + 签名。
      // 插件 check() 内部已按当前 target 解析平台，但其回传的 Metadata 不含
      // download_url/signature（2.10.1 实测字段：rid/current_version/version/date/body/raw_json），
      // 故 JS 只能再解析 raw_json——必须显式按当前平台选键：本应用是 Windows 构建、
      // 更新端点即 windows manifest，优先 windows-x86_64；缺失时退回第一个可用键
      // （兼容旧的单平台 manifest）。禁止直接取 Object.keys 第一个——manifest 一旦
      // 出现多平台，键序在前者会导致下载错误平台的安装包（且它过官方签名校验会被直接安装）。
      _updateUrlSignature(update) {
        const platforms = update && update.raw_json && update.raw_json.platforms;
        if (!platforms) return null;
        const keys = Object.keys(platforms).filter((k) => platforms[k] && platforms[k].url && platforms[k].signature);
        const key = keys.find((k) => k === 'windows-x86_64') || keys[0] || null;
        if (!key) return null;
        return { url: platforms[key].url, signature: platforms[key].signature };
      },
      // 查本机安装包缓存（version+signature 匹配才算有效：签名变了=官方重新上传过）。
      // 命中返回 {path, size}；未命中或出错返回 null（走正常下载，绝不因缓存问题阻断更新）。
      async _findUpdateCache(update) {
        try {
          const us = this._updateUrlSignature(update);
          if (!us) return null;
          const cached = await TauriApi.findCachedUpdate({ version: update.version, signature: us.signature });
          return cached && cached.path ? { path: cached.path, size: cached.size || 0 } : null;
        } catch (_) {
          return null;
        }
      },
      // 填充「安装包已下载」态文案（版本号 + 本地包大小）
      _fillDownloadedState(update) {
        const verEl = document.getElementById('update-dl-version');
        if (verEl) verEl.textContent = update ? update.version : '';
        const infoEl = document.getElementById('update-dl-info');
        if (infoEl) {
          const size = this.pendingCachePath ? this.pendingCachePath.size : 0;
          const sizeText = size >= 1024 * 1024
            ? (size / (1024 * 1024)).toFixed(1) + ' MB'
            : (size / 1024).toFixed(0) + ' KB';
          infoEl.textContent = this.t('updateDownloadedInfo', { size: sizeText });
        }
      },
      showUpdateState(state, checkId) {
        ['checking', 'available', 'latest', 'downloaded'].forEach(s => {
          document.getElementById('update-state-' + s).classList.toggle('hidden', s !== state);
        });
        const titles = {
          checking: this.t('updateChecking'),
          available: this.t('updateAvailable'),
          latest: this.t('updateLatest'),
          downloaded: this.t('updateDownloadedTitle'),
        };
        const titleEl = document.getElementById('update-title');
        if (titleEl) titleEl.textContent = titles[state] || this.t('updateAvailable');
        const btn = document.getElementById('update-action');
        const skipBtn = document.getElementById('update-skip');
        // 「跳过此版本」在「发现新版本 / 安装包已下载」态可见：检查中版本未知、已是最新则无版本可跳
        const skipVersionBtn = document.getElementById('update-skip-version');
        if (skipVersionBtn) skipVersionBtn.classList.toggle('hidden', state !== 'available' && state !== 'downloaded');
        if (state === 'checking') {
          btn.disabled = true;
          btn.textContent = this.t('updateChecking');
          document.getElementById('update-progress-wrap').classList.add('hidden');
          if (skipBtn) skipBtn.classList.remove('hidden');
        } else if (state === 'available') {
          if (skipBtn) skipBtn.classList.remove('hidden');
        } else if (state === 'downloaded') {
          // 安装包已在本机磁盘：主按钮=「立即安装」，进度条隐藏
          if (skipBtn) skipBtn.classList.remove('hidden');
          btn.disabled = false;
          btn.dataset.state = 'install';
          btn.textContent = this.t('updateInstallNow');
          document.getElementById('update-progress-wrap').classList.add('hidden');
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
          const skipped = !!(this.settings && this.settings.skippedUpdateVersion
            && update.version === this.settings.skippedUpdateVersion);
          if (skipped && !showUpToDate) {
            // 「跳过此版本」后自动检查（启动 5s 后）遇到同一版本：静默，不弹窗。
            // 更高版本 version 不同，仍会正常提示。
            this.pendingUpdate = null;
            this.pendingUpdateRid = null;
            return;
          }
          if (!showUpToDate) this.showUpdateDialog();
          // 手动「检查更新」遇到已跳过版本：仍展示可用状态（用户主动查询，
          // 跳过只抑制自动弹窗），可继续下载更新。
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
          this.pendingUpdate = update;
          this.pendingUpdateRid = update.rid;
          // 本机已有该版本安装包（上次下载后未安装，进程重启也不丢）→ 直接「已下载」态，
          // 不重复下载；否则走「发现新版本」态由用户点下载。
          const cached = await this._findUpdateCache(update);
          if (this._updateCheckId !== checkId || this._updateDismissed) return;
          if (cached) {
            this.pendingCachePath = cached;
            this.showUpdateState('downloaded', checkId);
            this._fillDownloadedState(update);
          } else if (this._updateDownloading) {
            // 已有同版本下载在途（下载按钮被手动检查重新启用前必须拦住）：
            // 保持「发现新版本」UI 但下载按钮维持禁用，避免第二次 download
            // 与在途下载并发写同一个 installer_{version}.exe.tmp（Rust 侧 File::create
            // 截断 + 交错写 → 损坏，验签兜底必失败 + 浪费流量）。
            this.pendingCachePath = null;
            this.showUpdateState('available', checkId);
            this.setUpdateAction('downloading');
          } else {
            this.pendingCachePath = null;
            this.showUpdateState('available', checkId);
            this.setUpdateAction('download');
          }
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
        if (!this.pendingUpdate) return;
        if (this._updateDownloading) return; // 在途下载防重入：同 tmp 并发双写会损坏文件
        this._updateDownloading = true;
        try {
        // 下载 URL + 签名来自更新 JSON（raw_json.platforms）；缺失则无法下载，直接失败提示
        const us = this._updateUrlSignature(this.pendingUpdate);
        if (!us) {
          this.showToast(this.t('updateFailed'));
          this.hideUpdateDialog();
          return;
        }
        this.pendingCachePath = null;
        const checkId = this._updateCheckId;
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
          // Rust 侧流式下载到 app_data_dir/updates/ 并先验签后转正：安装包落盘后即使
          // 关掉应用也不丢，下次检查更新命中缓存直接可装（不再重复下载）。
          const cached = await TauriApi.downloadUpdateToFile({
            url: us.url,
            version: this.pendingUpdate.version,
            signature: us.signature,
            onEvent: channel,
          });
          if (this._updateCheckId !== checkId || this._updateDismissed) return;
          this.pendingCachePath = { path: cached.path, size: cached.size || 0 };
          // 切到「已下载」态：主按钮变为「立即安装」
          this.showUpdateState('downloaded', checkId);
          this._fillDownloadedState(this.pendingUpdate);
        } catch (err) {
          console.error('Download failed:', err);
          this.showToast(this.t('updateFailed'));
          this.hideUpdateDialog();
        }
        } finally {
          this._updateDownloading = false;
        }
      },
      async installUpdate() {
        // 多窗口口径（tab-tearoff-window）：安装重启会杀掉全部窗口——
        // ① 分离窗口不发起安装（重启会带走主窗口未保存内容且无人协调），提示去主窗口；
        // ② 主窗口先与分离窗口协调收口（各自保存询问），取消/超时则不装（设计定案 11）。
        try {
          const w0 = TauriApi.currentWindow();
          if (w0 && TMMultiWindow.isDetachedLabel(w0.label)) {
            this.showToast({ title: this.t('updateInMainWindow'), code: 'E_WINDOW' });
            return;
          }
        } catch (_) { /* 浏览器环境降级：无窗口概念,继续 */ }
        try {
          const coordinated = await this.coordinateQuit();
          if (!coordinated) return;
        } catch (_) { /* 协调通道不可用（如非 Tauri 环境）按原流程继续 */ }
        if (!this.pendingUpdateRid) return;
        if (!this.pendingCachePath || !this.pendingCachePath.path) {
          // 没有已落盘的安装包（理论上不会：安装按钮只在「已下载」态出现）
          this.showToast(this.t('updateFailed'));
          return;
        }
        document.getElementById('update-action').disabled = true;
        this.hideUpdateDialog();
        try {
          // Rust 侧读回缓存文件、再验一次签名后交给插件 Update::install 启动安装
          await TauriApi.installCachedUpdate({
            updateRid: this.pendingUpdateRid,
            path: this.pendingCachePath.path,
          });
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
