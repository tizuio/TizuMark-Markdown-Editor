// 应用关闭流程、托盘与系统挂起恢复
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';

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

      // 退出协调（主窗口调用）：与全部分离编辑器窗口逐窗收口——各自跑保存询问后上报
      // app-quit-ready / app-quit-aborted（事件定向，Rust emit_to + JS emitTo）。
      // 全部 ready → 聚合分离会话进主键并清 editor 键/残留交接键，返回 true；
      // 任一 aborted / 超时（默认 60s）→ 返回 false，整体不退出、主窗口保留。
      // 分离窗口文件以主窗口 tab 恢复（重启降级无损，设计定案 4）。
      async coordinateQuit(opts = {}) {
        const timeoutMs = Number.isFinite(opts && opts.timeoutMs) ? opts.timeoutMs : 60000;
        let ownLabel = null;
        try { const w0 = TauriApi.currentWindow(); ownLabel = w0 && w0.label; } catch (_) {}
        let labels = [];
        try { labels = await TauriApi.listEditorWindows(); } catch (_) { labels = []; }
        // 只协调「别的」分离窗口：自撕自建场景下排除自身，避免自己请求自己收口死锁
        labels = (labels || []).filter(l => TMMultiWindow.isDetachedLabel(l) && l !== ownLabel);
        if (labels.length === 0) {
          await this._aggregateDetachedSessions();
          return true;
        }
        const pending = new Set(labels);
        let settled = false;
        let timer = null;
        let liveTimer = null;
        let resolveOut = null;
        const done = new Promise((resolve) => { resolveOut = resolve; });
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (liveTimer) clearInterval(liveTimer);
          resolveOut(ok);
        };
        let unlistenReady = null;
        let unlistenAbort = null;
        try {
          // 先 await 挂好监听再发请求：真实 Tauri listen 是异步 IPC，超快的 ready 回复
          // 不得与注册竞速
          unlistenReady = await TauriApi.onEvent('app-quit-ready', (event) => {
            const label = event && event.payload && event.payload.label;
            pending.delete(label);
            if (pending.size === 0) finish(true);
          });
          unlistenAbort = await TauriApi.onEvent('app-quit-aborted', () => finish(false));
          timer = setTimeout(() => finish(false), timeoutMs);
          // 存活复核：窗口若已销毁/不响应，永远不会回 ready，不能干等满 60s。
          // 剩余 pending 全部不在存活列表 → 立即按失败收口，让用户看到明确结果。
          liveTimer = setInterval(async () => {
            if (settled) return;
            try {
              const live = new Set(await TauriApi.listEditorWindows());
              if ([...pending].every(l => !live.has(l))) finish(false);
            } catch (_) { /* 查询失败按未知处理，交给超时兜底 */ }
          }, 1500);
          for (const l of labels) {
            try { TauriApi.emitTo(l, 'app-quit-request', { from: 'main' }); } catch (_) {}
          }
          const ok = await done;
          if (ok) await this._aggregateDetachedSessions();
          return ok;
        } catch (e) {
          finish(false);
          return false;
        } finally {
          try { if (typeof unlistenReady === 'function') unlistenReady(); } catch (_) {}
          try { if (typeof unlistenAbort === 'function') unlistenAbort(); } catch (_) {}
        }
      },

      // 聚合分离窗口会话进主键（saveSession 只存 filePath 等元数据；未保存内容已由各窗
      // 在收口时落盘/丢弃，故此处只恢复「打开过哪些文件」）。聚合前先 saveSession 把主窗口
      // 当前 tabs 落盘，再在其上追加分离窗口 tabs——否则调用方随后的 saveSession 会只写
      // 主窗口 tabs、把合并结果覆盖掉。
      // saveSession 只在确有分离会话待合并时执行：无分离窗口时（绝大多数退出）不落盘，
      // 保住「clearTabsOnQuit=true 退出不写会话键」的既有契约（editor-clear-tabs-on-quit）。
      // 失败不阻塞退出。
      async _aggregateDetachedSessions() {
        try {
          const SESSION_PREFIX = 'tizumark-session-editor-';
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) keys.push(k);
          }
          const detached = [];
          for (const k of keys) {
            if (k.indexOf(SESSION_PREFIX) === 0) {
              try {
                const d = JSON.parse(localStorage.getItem(k));
                if (d) detached.push(d);
              } catch (_) { /* 损坏键按空会话处理 */ }
            }
          }
          if (detached.length > 0) {
            this.saveSession(); // P1-1：合并基底先落盘，再追加分离窗口 tabs
            const main = this.loadSession() || { version: 2, tabs: [], emptyTabs: false, activeFilePath: null };
            const merged = TMMultiWindow.mergeDetachedSessions(main, detached);
            if (merged.tabs.length > 0) {
              localStorage.setItem('tizumark-session', JSON.stringify(merged));
            }
          }
          // 供 quit 分支判断“聚合已落盘与否”：true = 已写入合并结果，调用方不得再 saveSession
          this._sessionAggregated = detached.length > 0;
          for (const k of keys) {
            if (k.indexOf(SESSION_PREFIX) === 0 || k.indexOf(TMMultiWindow.HANDOFF_PREFIX) === 0) {
              try { localStorage.removeItem(k); } catch (_) {}
            }
          }
        } catch (e) { console.warn('aggregateDetachedSessions failed:', e); }
      },

      async handleAppClose(opts = {}) {
        // ---------- 分离编辑器窗口：关闭只关自己（Rust 已按 label 分流 close-requested） ----------
        // 进程生命周期由主窗口决定；退出协调时由主窗口 app-quit-request 触发收口
        // （_quitRequested 置位 → 上报 ready/aborted 给主窗口）。
        let ownLabel = null;
        try { const w0 = TauriApi.currentWindow(); ownLabel = w0 && w0.label; } catch (_) {}
        if (TMMultiWindow.isDetachedLabel(ownLabel) || this._detachedLabel) {
          if (this._closingWindow) return; // destroy 再触发 CloseRequested 的防循环哨兵
          this._closingWindow = true;
          try {
            const modified = this.tabs.filter(t => t.isModified);
            if (modified.length > 0) {
              const result = await this.showSaveDialog(
                this.t('saveChanges'),
                this.t('filesModifiedConfirm', { n: modified.length }),
                this.t('saveAll'), this.t('discardAll'), this.t('cancel')
              );
              if (result === 'cancel' || result === null) {
                this._closingWindow = false;
                this._reportQuitAbort(ownLabel);
                return;
              }
              if (result === 'save') {
                const ok = await this.batchSaveTabs(modified);
                if (!ok) {
                  this._closingWindow = false;
                  this._reportQuitAbort(ownLabel);
                  return;
                }
              } else {
                for (const tab of modified) tab.content = tab.savedContent;
              }
            }
            // 协调退出：落 label 会话键供主窗口聚合；普通关窗：删除自己的会话键，
            // 避免早已关闭的窗口文件在下次启动时被聚合“复活”。
            if (this._quitRequested) {
              this.saveSession();
              try { TauriApi.emitTo('main', 'app-quit-ready', { label: ownLabel || this._detachedLabel }); } catch (_) {}
              this._quitRequested = false; // 本轮协调已应答，复位防止后续普通关窗误发 ready
            } else {
              try { localStorage.removeItem(this.sessionKey()); } catch (_) {}
            }
            const w1 = TauriApi.currentWindow();
            if (w1) {
              try {
                await w1.destroy();
              } catch (e) {
                // destroy 失败不得回退 close()：Rust CloseRequested 会 prevent_close 并重新
                // emit，而 _closingWindow 哨兵会让重入直接早退，窗口将永久关不掉。
                // 复位哨兵并显式记录错误，用户可再次点 X 重试，不会陷入关闭死循环。
                this._closingWindow = false;
                console.error('detached window destroy failed:', e);
              }
            }
          } catch (error) {
            // 复位关闭哨兵：否则 showSaveDialog 等异常会让后续所有关闭尝试被早退挡住，窗口永久关不掉
            // 。同时显式上报 aborted，避免主窗口只能干等 60s。
            this._closingWindow = false;
            this._reportQuitAbort(ownLabel);
            console.error('detached handleAppClose error:', error);
          }
          return;
        }
        // ---------- 主窗口原流程 ----------
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
              this.tabs = remaining;
              if (this.tabs.length === 0) {
                this.activeTabIndex = -1;
              } else if (this.activeTabIndex >= this.tabs.length) {
                this.activeTabIndex = this.tabs.length - 1;
              }
              if (this.activeTab) this.cm.setValue(this.activeTab.content);
              this.updateTabBar();
              if (this.activeTab) this.updatePreview();
            }
          }
          // 2. 先解析关闭行为：只有真正退出（quit）才按「退出时关闭所有标签」处理会话；
          //    取消直接返回不清会话；最小化到托盘等其它行为一律保存会话。
          const action = await this._resolveCloseAction(opts);
          if (!action) return; // 用户在弹框点了取消（不清会话）
          if (action === 'quit') {
            // 先与分离编辑器窗口协调收口（各自保存询问），全部 ready 后才动主会话/退出——
            // 任一取消/超时 → 主会话保持原样（clearTabsOnQuit 不执行）、窗口保留、失败可见
            // （先改会话再协调，被拒退出会留下被清空的会话键）。
            const coordinated = await this.coordinateQuit();
            if (!coordinated) {
              this.setStatus(this.t('quitCoordinatedAborted'));
              return;
            }
            // 3a. 真正退出。落盘口径三分支（P1-1 + clearTabsOnQuit 契单）：
            //   - clearTabsOnQuit=true：清会话键，不落盘；
            //   - 聚合已发生（有分离会话，_aggregateDetachedSessions 内先 save 再合并）：
            //     不再 saveSession，否则会把合并结果覆盖回纯主窗口 tabs；
            //   - 无分离会话（绝大多数退出）：按原行为 saveSession。
            if (this.settings.clearTabsOnQuit) {
              try { localStorage.removeItem(this.sessionKey()); } catch (_) {}
            } else if (!this._sessionAggregated) {
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
      // 取消退出协调时向主窗口上报 aborted（_quitRequested 置位才有意义,普通关窗静默）
      _reportQuitAbort(ownLabel) {
        if (!this._quitRequested) return;
        try { TauriApi.emitTo('main', 'app-quit-aborted', { label: ownLabel || this._detachedLabel }); } catch (_) {}
        this._quitRequested = false; // 本轮协调已应答，复位防止后续普通关窗误发 abort
      },

      async _resolveCloseAction(opts = {}) {
        // 托盘「退出」（app-quit-requested）：无条件走退出路径——它必须退出，而不是尊重
        // closeAction 可能配的「最小化」。
        if (opts && opts.forceQuit) return 'quit';
        // 无托盘模式：窗口隐藏后无法恢复，关 X 的旧语义就是直接退出——保持该口径
        // （区别仅在于现在先经前端协调未保存内容，不再 Rust 直杀，见设计定案 11）。
        if (this.settings && this.settings.showTrayIcon === false) return 'quit';
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
