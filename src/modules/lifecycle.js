// 应用关闭流程与托盘
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { Tab } = TMConst;

  const mixin = {
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
