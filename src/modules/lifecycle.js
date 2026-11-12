// 应用关闭流程、托盘与系统挂起恢复
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { Tab } = TMConst;

  // 笔记本合盖 / 系统睡眠会停掉 WebView2 的定时器、rAF 与 IME 的 compositionend，
  // 项目里多处「等异步链落地才复位」的一次性标志因此永久卡住 → 唤醒后编辑器无响应。
  // WebView2 收不到电源事件，故用「墙钟长时间跳变」判挂起：visibilitychange / focus /
  // 心跳任一先到即触发，其余因 gap 已被刷新而自动去重。所有复位幂等，且仅在长跳变后执行，
  // 正常切窗口（<30s）不受影响。
  const SUSPEND_GAP_MS = 30000;   // 超过 30s 无心跳视为系统挂起
  const CLOCK_BACK_MS = 30000;    // 大幅墙钟回拨会让 CM5 的 Delayed 轮询长期停摆
  const WAKE_COOLDOWN_MS = 3000;  // 唤醒后合并补发的定时器 / IPC 洪峰

  const mixin = {
      // 挂起检测：只绑两个事件（心跳搭在 notify.js 的既有轮询上），不做任何重活。
      initWakeRecovery() {
        if (this._wakeRecoveryStarted) return;
        this._wakeRecoveryStarted = true;
        this._wakeLastSeen = Date.now();
        this._wakeLog = [];
        this._wakeCooldownMs = WAKE_COOLDOWN_MS;
        const self = this;
        const probe = (reason) => {
          const now = Date.now();
          const gap = now - self._wakeLastSeen;
          self._wakeLastSeen = now;
          if (gap <= SUSPEND_GAP_MS && gap >= -CLOCK_BACK_MS) return;
          self._recoverFromSuspend({ at: now, gap, reason });
        };
        this._wakeProbe = probe; // 探针 / 回归测试可直接驱动，不必伪造系统睡眠
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) probe('visible');
        });
        window.addEventListener('focus', () => probe('focus'));
        // 心跳不另起常驻定时器：复用 notify.js 现成的 1.5s 外部变更轮询，
        // 每个 tick 调一次 _wakeProbe('heartbeat')。这样即便唤醒后既无
        // visibilitychange 也无 focus（WebView2 恢复时不派发 DOM 事件），
        // 最多 1.5s 仍能复位；同时避免新增后台定时器拖住测试进程。
      },

      // 幂等复位：唤醒瞬间把「挂起时被掐断」的一次性状态全部拉回可用态。
      _recoverFromSuspend(info) {
        const at = Number.isFinite(info && info.at) ? info.at : Date.now();
        const gap = Number.isFinite(info && info.gap) ? info.gap : 0;
        const reason = (info && info.reason) || 'probe';
        // notify.js 的 1.5s 轮询与 focus 即时检查据此在冷却窗口内让路，
        // 避免唤醒瞬间对全部 tab 串行发 fileMeta IPC 形成洪峰。
        this._wakeRecoveredAt = at;
        const cleared = [];

        // ① IME：CM5 ContentEditableInput 在 composing 残留时 'input' 处理器直接
        //    return；readFromDOMSoon 的 80ms 定时器若在挂起中丢失，readDOMTimeout
        //    恒非 null 也会让后续所有输入被早退挡住 —— 两者都表现为「打字没反应」。
        const cm = this.cm;
        const cin = cm && cm.display && cm.display.input;
        if (cin) {
          if (cin.composing) {
            if (typeof cin.forceCompositionEnd === 'function') cin.forceCompositionEnd();
            else cin.composing = null;
            cleared.push('cm-composing');
          }
          if (cin.readDOMTimeout != null) {
            clearTimeout(cin.readDOMTimeout);
            cin.readDOMTimeout = null;
            if (typeof cin.readFromDOMSoon === 'function') cin.readFromDOMSoon();
            cleared.push('cm-read-dom-timer');
          }
          // CM5 的 Delayed 用 +new Date 绝对墙钟调度 100ms 轮询；仅墙钟回拨时
          // 会算出数小时级的 setTimeout 而长期停摆，此处强制重新起一次。
          if (gap < -CLOCK_BACK_MS && cin.polling) {
            try {
              clearTimeout(cin.polling.id);
              cin.polling.id = 0;
              cin.polling.time = 0;
              if (typeof cin.receivedFocus === 'function') cin.receivedFocus();
              cleared.push('cm-polling');
            } catch (_) { /* 轮询重建失败不影响其它复位 */ }
          }
        }
        if (this._wysiwygComposing) {
          this._wysiwygComposing = false;
          cleared.push('wysiwyg-composing');
        }

        // ② 预览渲染链：挂起时 await rAF 永不 resolve → finally 不执行 → 滚动双锁、
        //    pane-loading 遮罩、所见即所得预渲染 busy 标志残留，观感就是界面冻住。
        if (typeof this._resumeScroll === 'function') this._resumeScroll();
        if (this._canScroll) {
          this._canScroll.editor = true;
          this._canScroll.preview = true;
        }
        cleared.push('scroll-locks');
        if (this._wysiwygPreRendering && typeof this._cancelWysiwygPreRender === 'function') {
          this._cancelWysiwygPreRender();
          cleared.push('wysiwyg-prerender');
        }
        this._wysiwygPreRendering = false;
        this._wysiwygPreRenderLoadOpen = false;
        this._paneLoadingCount = 0;
        const loading = document.getElementById('pane-loading');
        if (loading) loading.classList.add('hidden');
        cleared.push('pane-loading');

        // ③ 外部变更轮询：挂起时卡在 await IPC 会让 _watching 恒 true、轮询永久停摆。
        this._watching = false;

        const rec = { at, gap, reason, cleared };
        if (!Array.isArray(this._wakeLog)) this._wakeLog = [];
        this._wakeLog.push(rec);
        if (this._wakeLog.length > 20) this._wakeLog.shift();
        console.info('[tizumark] wake recovery', rec);
        return rec;
      },

      async handleAppClose() {
        try {
          const appWindow = TauriApi.currentWindow();
          // 1. 处理未保存文档
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
            } else {
              for (const tab of modified) {
                tab.content = tab.savedContent;
              }
              const remaining = this.tabs.filter(t => t.filePath || t.content !== '');
              if (remaining.length === 0) {
                this.tabs.length = 0;
                this.tabs.push(new Tab(`${this.t('untitled')}${this.untitledCounter++}`));
                this.activeTabIndex = 0;
              } else {
                this.tabs = remaining;
                if (this.activeTabIndex >= this.tabs.length) {
                  this.activeTabIndex = this.tabs.length - 1;
                }
              }
              this.cm.setValue(this.activeTab.content);
              this.updateTabBar();
              this.updatePreview();
            }
          }
          // 2. 先解析关闭行为：只有真正退出（quit）才按「退出时关闭所有标签」处理会话；
          //    取消直接返回不清会话；最小化到托盘等其它行为一律保存会话。
          const action = await this._resolveCloseAction();
          if (!action) return; // 用户在弹框点了取消（不清会话）
          if (action === 'quit') {
            // 3a. 真正退出：按「退出时关闭所有标签」开关决定保存还是清空会话
            if (this.settings.clearTabsOnQuit) {
              try { localStorage.removeItem('tizumark-session'); } catch (_) {}
            } else {
              this.saveSession();
            }
            await TauriApi.quitApp();
          } else {
            // 3b. 非退出（如最小化到托盘）：不清空会话，保存后隐藏窗口
            this.saveSession();
            await appWindow.hide();
          }
        } catch (error) {
          console.error('handleAppClose error:', error);
          try {
            const w = TauriApi.currentWindow();
            if (w) await w.hide();
          } catch { /* 浏览器环境下降级 */ }
        }
      },
      async hideToTray() {
        // 快捷键「关闭到托盘」：仅把窗口隐藏到系统托盘，应用进程与文档保留在内存中，
        // 因此不会丢失未保存内容；下次从托盘图标恢复窗口即可继续编辑。
        try {
          this.saveSession();
          const w = TauriApi.currentWindow();
          if (w) await w.hide();
        } catch (error) {
          console.error('hideToTray error:', error);
          try {
            const w = TauriApi.currentWindow();
            if (w) await w.hide();
          } catch { /* 浏览器环境下降级 */ }
        }
      },
      async _resolveCloseAction() {
        const action = this.settings.closeAction || 'ask';
        if (action === 'quit') return 'quit';
        if (action === 'minimize') return 'minimize';
        // ask — 弹出确认对话框
        const result = await Dialogs.showCloseDialog({
          t: (k, p) => this.t(k, p),
          doc: document,
        });
        if (!result) return null; // cancelled
        if (result.remember) {
          this.settings.closeAction = result.action;
          this.saveSettings();
        }
        return result.action;
      },
  };

  const api = { mixin };
  window.TMLifecycle = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
