// Toast、错误上报、外部变更检测与状态栏
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { ERROR_MESSAGES } = TMI18n;

  const mixin = {
      // 后端健康探测（dev 模式"僵尸界面"可见化修复）：启动时 + 每 30s 心跳 ping 一次。
      // 背景：dev 模式下前端页面与 Rust 后端 / Node dev-server 生命周期完全解耦（tauri-api 延迟
      // 求值 + 全降级是防白屏的刻意设计），后端挂掉时页面仍正常显示且无任何提示——用户无法区分
      // 「应用正常」与「后端已死」。这里复用最轻的已有命令 get_cli_args 做心跳，不新增 IPC、
      // 不改 invoke 透传语义（N21 硬约束不受影响）。失败 → 顶部红条；恢复成功 → 自动隐藏。
      initBackendHealth() {
        this._probeBackendHealth();
        this._backendHealthTimer = setInterval(() => this._probeBackendHealth(), 30000);
      },
      async _probeBackendHealth() {
        let down = false;
        try {
          if (!TauriApi.isAvailable()) throw new Error('not in tauri runtime');
          await TauriApi.getCliArgs();
        } catch (_) {
          down = true;
        }
        this._setBackendBanner(down);
      },
      _setBackendBanner(down) {
        const banner = document.getElementById('backend-banner');
        if (!banner) return;
        // 复用兜底报错条样式 .fatal-error-bar（fixed 底部红条），只切 hidden
        banner.classList.toggle('hidden', !down);
        if (down) {
          const txt = document.getElementById('backend-banner-text');
          if (txt) txt.textContent = this.t('backendDown');
        }
      },
      showToast(text, type = 'danger', opts = {}) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const el = document.createElement('div');
        el.className = 'toast ' + type;
  
        const iconSvg = type === 'danger'
          ? '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
          : type === 'warning'
            ? '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
            : type === 'info'
              ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
              : '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'toast-icon';
        iconSpan.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + iconSvg + '</svg>';
  
        const body = document.createElement('div');
        body.className = 'toast-body';
        if (typeof text === 'object' && text !== null) {
          const titleEl = document.createElement('div');
          titleEl.className = 'toast-title';
          titleEl.textContent = text.title || '';
          body.appendChild(titleEl);
          if (text.detail) {
            const detailEl = document.createElement('div');
            detailEl.className = 'toast-detail';
            detailEl.textContent = text.detail;
            body.appendChild(detailEl);
          }
          if (text.code) {
            const codeEl = document.createElement('div');
            codeEl.className = 'toast-code';
            codeEl.textContent = this.t('errorCodePrefix', { code: text.code });
            body.appendChild(codeEl);
          }
        } else {
          body.textContent = text;
        }
  
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', this.t('close') || 'Close');
        closeBtn.textContent = this.t('close') || 'Close';
  
        let timer = null;
        const dismiss = () => {
          if (timer) clearTimeout(timer);
          if (!el.parentNode) return;
          el.style.transition = 'opacity 0.25s, transform 0.25s';
          el.style.opacity = '0';
          el.style.transform = 'translateY(-12px) scale(0.98)';
          setTimeout(() => el.remove(), 250);
        };
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  
        el.appendChild(iconSpan);
        el.appendChild(body);
        el.appendChild(closeBtn);
        container.appendChild(el);
  
        const duration = opts.duration || (type === 'danger' ? 5000 : type === 'warning' ? 4000 : 3000);
        timer = setTimeout(dismiss, duration);
      },
      // 统一错误上报：用户友好提示 + 开发可诊断（错误码 + 上下文写入 console）
      reportError(code, opts = {}) {
        const lang = this.settings && this.settings.language === 'en' ? 'en' : 'zh';
        const dict = ERROR_MESSAGES[code] || {};
        const entry = dict[lang] || dict.zh || { title: code, detail: '' };
        let detail = opts.detail || entry.detail || '';
        if (detail && opts.params) {
          for (const [k, v] of Object.entries(opts.params)) {
            detail = detail.replace('{' + k + '}', v == null ? '' : v);
          }
        }
        const title = opts.title || entry.title || code;
        const context = opts.context || {};
        // 开发可诊断：错误码 + 上下文 + 完整堆栈写入 console（用户不可见，但开发可查）
        console.error('[TizuMark]', code, JSON.stringify(context), opts.error && (opts.error.stack || opts.error));
        if (opts.toast === false) {
          this.setStatus(title + (detail ? '：' + detail : ''));
        } else {
          this.showToast({ title, detail, code }, opts.type || 'danger', { duration: opts.duration });
        }
      },
      // 解析 Rust read_file 的结构化错误 JSON，返回带 .code 的 Error 供上层 reportError 使用
      _mapReadFileError(e, path) {
        let kind = 'Io';
        try {
          const raw = typeof e === 'string' ? e : (e && e.message ? e.message : null);
          const obj = raw ? JSON.parse(raw) : null;
          if (obj && obj.kind) kind = obj.kind;
        } catch (_) { /* 非结构化错误，按 Io 处理 */ }
        const codeMap = {
          NotFound: 'E_NOT_FOUND',
          PermissionDenied: 'E_PERMISSION',
          Locked: 'E_LOCKED',
          PathTooLong: 'E_PATH_TOO_LONG',
          InvalidEncoding: 'E_ENCODING',
          Io: 'E_IO',
        };
        const code = codeMap[kind] || 'E_IO';
        const name = path ? path.split(/[/\\]/).pop() : '';
        const err = new Error('读取文件失败: ' + kind);
        err.code = code;
        err.path = path;
        err.params = { name };
        return err;
      },
      // ====== 外部文件变更检测 ======
      async refreshFileMeta(tab) {
        if (!tab) return;
        if (!tab.filePath) { tab.fileMeta = null; return; }
        try {
          tab.fileMeta = await TauriApi.fileMeta({ path: tab.filePath });
        } catch (e) {
          tab.fileMeta = null;
        }
      },
      async reloadTabFromDisk(tab) {
        if (!tab || !tab.filePath) return;
        try {
          const content = await this.readFileNormalized(tab.filePath);
          tab.content = content;
          tab.savedContent = content;
          await this.refreshFileMeta(tab);
          tab.pendingExternalChange = false;
          if (tab === this.activeTab) {
            this.cm.setValue(content);
            this.updatePreview();
            this.updateOutline();
            this.updateWordCount();
          }
          this.updateTabDisplay();
        } catch (e) {
          this.reportError(e.code || 'E_IO', { context: { path: tab.filePath }, error: e, params: e.params, detail: e.detail });
        }
      },
      enqueueExternalChange(tab) {
        if (!tab || !tab.filePath) return;
        if (this._externalQueue.includes(tab)) return;
        tab.pendingExternalChange = true;
        this._externalQueue.push(tab);
        this.updateTabDisplay();
        this.updateExternalChangeBanner();
      },
      // 提示条始终反映当前激活标签页的外部变更
      updateExternalChangeBanner() {
        const tab = this.activeTab;
        if (tab && tab.pendingExternalChange) {
          this.renderExternalChangeBanner(tab);
        } else {
          this.hideExternalChangeBanner();
        }
      },
      async dismissExternalChange(tab, reload) {
        const idx = this._externalQueue.indexOf(tab);
        if (idx !== -1) this._externalQueue.splice(idx, 1);
        if (reload) {
          await this.reloadTabFromDisk(tab);
        } else {
          await this.refreshFileMeta(tab);
          tab.pendingExternalChange = false;
        }
        this.updateTabDisplay();
        this.updateExternalChangeBanner();
      },
      async reloadAllExternalChanges() {
        const queue = this._externalQueue.slice();
        for (const tab of queue) {
          await this.reloadTabFromDisk(tab);
          const i = this._externalQueue.indexOf(tab);
          if (i !== -1) this._externalQueue.splice(i, 1);
        }
        this.updateTabDisplay();
        this.updateExternalChangeBanner();
      },
      ignoreAllExternalChanges() {
        this._externalQueue.slice().forEach(t => {
          t.pendingExternalChange = false;
          this.refreshFileMeta(t);
        });
        this._externalQueue = [];
        this.updateTabDisplay();
        this.updateExternalChangeBanner();
      },
      renderExternalChangeBanner(tab) {
        const banner = document.getElementById('external-change-banner');
        if (!banner) return;
        const dirty = tab.isModified;
        banner.querySelector('.ecb-name').textContent = tab.name || tab.filePath || '';
        banner.querySelector('.ecb-msg').textContent = dirty ? this.t('externalChangedDirty') : this.t('externalChanged');
        banner.querySelector('.ecb-reload').textContent = this.t('ecbReload');
        banner.querySelector('.ecb-ignore').textContent = this.t('ecbIgnore');
        banner.querySelector('.ecb-reload-all').textContent = this.t('ecbReloadAll');
        banner.querySelector('.ecb-ignore-all').textContent = this.t('ecbIgnoreAll');
        banner.dataset.tabIndex = this.activeTabIndex;
        banner.classList.add('visible');
        this._externalBannerVisible = true;
      },
      hideExternalChangeBanner() {
        const banner = document.getElementById('external-change-banner');
        if (banner) banner.classList.remove('visible');
        this._externalBannerVisible = false;
      },
      initFileWatcher() {
        if (this._fileWatcherStarted) return;
        this._fileWatcherStarted = true;
        this._externalQueue = [];
        this._externalBannerVisible = false;
        this._watching = false;
  
        const banner = document.getElementById('external-change-banner');
        if (banner) {
          banner.querySelector('.ecb-reload').addEventListener('click', () => {
            const i = parseInt(banner.dataset.tabIndex, 10);
            const tab = this.tabs[i];
            if (tab) this.dismissExternalChange(tab, true);
          });
          banner.querySelector('.ecb-ignore').addEventListener('click', () => {
            const i = parseInt(banner.dataset.tabIndex, 10);
            const tab = this.tabs[i];
            if (tab) this.dismissExternalChange(tab, false);
          });
          banner.querySelector('.ecb-reload-all').addEventListener('click', () => this.reloadAllExternalChanges());
          banner.querySelector('.ecb-ignore-all').addEventListener('click', () => this.ignoreAllExternalChanges());
        }
  
        const pass = async () => {
          for (const tab of this.tabs) {
            if (!tab.filePath) continue;
            let meta;
            try { meta = await TauriApi.fileMeta({ path: tab.filePath }); }
            catch (e) { meta = undefined; }
            if (meta === undefined) continue;
            if (!meta) {
              if (tab.fileMeta !== null && !tab.pendingExternalChange) this.enqueueExternalChange(tab);
              continue;
            }
            if (!tab.fileMeta) { tab.fileMeta = meta; continue; }
            if (meta.mtime !== tab.fileMeta.mtime || meta.size !== tab.fileMeta.size) {
              let disk = null;
              try { disk = await this.readFileNormalized(tab.filePath); } catch (e) { disk = null; }
              // 磁盘内容换行已归一化为 LF，savedContent 同为 LF，统一比较，避免 CRLF/CR 文件每次轮询误报"外部已修改"
              if (disk !== null && disk !== tab.savedContent) this.enqueueExternalChange(tab);
              else tab.fileMeta = meta;
            }
          }
        };
  
        setInterval(async () => {
          if (this._watching) return;
          this._watching = true;
          try { await pass(); } catch (e) { /* ignore */ } finally { this._watching = false; }
        }, 1500);
  
        window.addEventListener('focus', () => {
          if (this._watching) return;
          this._watching = true;
          pass().catch(() => {}).finally(() => { this._watching = false; });
        });
      },
      setStatus(text) {
        this.statusText.textContent = text;
        setTimeout(() => {
          if (this.statusText.textContent === text) {
            this.statusText.textContent = this.t('ready');
          }
        }, 3000);
      },
      updateWordCount() {
        const { chars, lines } = WordCount.countStats(this.cm.getValue());
        // 原始字数 = 原文文件字符数（含 markdown 标记/空白），预览字数 = 渲染后可见文本字符数。
        // 两者统一按字符数口径，保证「原文 ≥ 预览」恒成立（中文/英文均如此）。
        this.wordCountEl.textContent = `${this.t('words')}: ${chars}`;
        // 预览字数：统计预览渲染后的可见文本字符数（区别于原文口径）。
        // 纯预览大文档（虚拟滚动窗口）时统计的是当前渲染窗口的文本，随滚动重渲染更新。
        const previewChars = (typeof WordCount.countPreviewText === 'function' && this.preview)
          ? WordCount.countPreviewText(this.preview)
          : 0;
        if (this.previewWordCountEl) {
          this.previewWordCountEl.textContent = `${this.t('previewWords')}: ${previewChars}`;
        }
        this.lineCountEl.textContent = `${this.t('lines')}: ${lines}`;
      },
  };

  const api = { mixin };
  window.TMNotify = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
