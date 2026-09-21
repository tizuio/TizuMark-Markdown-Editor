// 右键菜单构建与显示
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';

  const mixin = {
      initContextMenu() {
        const editorWrapper = document.getElementById('editor-wrapper');
        const previewWrapper = document.getElementById('preview-wrapper');
  
        editorWrapper.addEventListener('contextmenu', (e) => {
          if (e.target.closest('.copy-btn')) return;
          e.preventDefault();
          this.hideAllContextMenus();
          this.showContextMenu('context-menu-editor', e.clientX, e.clientY);
        });
  
        // 点击编辑器区域即视为离开文件树：清除树选中态，恢复编辑器的文本复制/剪切/粘贴。
        // 否则 _fileTreeCtx 持续存在会让 Ctrl+C/V 优先按文件树操作，误拦截编辑器文本操作。
        // 注意：从目录树点击文件打开编辑器是 openFilePath 程序化 focus，不会触发此 mousedown，
        // 因此「点文件 → Ctrl+C 复制文件」的常用流程不受影响。
        editorWrapper.addEventListener('mousedown', () => {
          if (this._fileTreeCtx) this._fileTreeCtx = null;
        });
  
        previewWrapper.addEventListener('contextmenu', (e) => {
          if (e.target.closest('.copy-btn')) return;
          e.preventDefault();
          this.hideAllContextMenus();
          this.showContextMenu('context-menu-preview', e.clientX, e.clientY);
        });
  
        document.querySelectorAll('.tab').forEach(tab => {
          tab.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideAllContextMenus();
            this._contextTabIndex = parseInt(tab.dataset.index);
            this.showContextMenu('context-menu-tab', e.clientX, e.clientY);
          });
        });
  
        const observer = new MutationObserver(() => {
          document.querySelectorAll('.tab').forEach(tab => {
            if (!tab._ctxBound) {
              tab._ctxBound = true;
              tab.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.hideAllContextMenus();
                this._contextTabIndex = parseInt(tab.dataset.index);
                this.showContextMenu('context-menu-tab', e.clientX, e.clientY);
              });
            }
          });
        });
        observer.observe(document.getElementById('tab-bar'), { childList: true, subtree: true });
  
        document.addEventListener('click', () => this.hideAllContextMenus());
        document.addEventListener('contextmenu', (e) => {
          if (e.target.closest('input:not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea, select') &&
              !e.target.closest('#editor-wrapper') && !e.target.closest('#preview-wrapper')) {
            return;
          }
          e.preventDefault();
          if (!e.target.closest('.context-menu') && !e.target.closest('.dropdown-menu') && !e.target.closest('#editor-wrapper') && !e.target.closest('#preview-wrapper') && !e.target.closest('.tab')) {
            this.hideAllContextMenus();
          }
        });
  
        document.querySelectorAll('.context-menu-item[data-action]').forEach(item => {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = item.dataset.action;
            this.hideAllContextMenus();
            this.executeMenuAction(action);
          });
        });
  
        document.querySelectorAll('.context-submenu-trigger').forEach(trigger => {
          const showSubmenu = () => {
            const parentMenu = trigger.closest('.context-menu');
            const submenuId = trigger.dataset.submenu;
            const submenu = document.getElementById(submenuId);
            if (!submenu) return;
  
            const ancestors = [];
            let el = parentMenu;
            while (el) {
              if (el.classList && el.classList.contains('context-menu')) {
                ancestors.push(el);
              }
              el = el.parentElement;
            }
  
            document.querySelectorAll('.context-menu.submenu').forEach(s => {
              if (!ancestors.includes(s) && s !== submenu) {
                s.classList.add('hidden');
              }
            });
  
            submenu.classList.remove('hidden');
            const parentRect = trigger.getBoundingClientRect();
            submenu.style.left = (parentRect.right - 1) + 'px';
            submenu.style.top = parentRect.top + 'px';
  
            requestAnimationFrame(() => {
              const subRect = submenu.getBoundingClientRect();
              if (subRect.right > window.innerWidth) {
                submenu.style.left = (parentRect.left - subRect.width + 1) + 'px';
              }
              if (subRect.bottom > window.innerHeight) {
                submenu.style.top = (window.innerHeight - subRect.height - 4) + 'px';
              }
            });
          };
  
          trigger.addEventListener('mouseenter', showSubmenu);
          trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const submenuId = trigger.dataset.submenu;
            const submenu = document.getElementById(submenuId);
            if (submenu && submenu.classList.contains('hidden')) {
              showSubmenu();
            }
          });
        });
  
        let ctxHideTimer = null;
  
        document.querySelectorAll('.context-menu').forEach(menu => {
          menu.addEventListener('mouseleave', () => {
            clearTimeout(ctxHideTimer);
            ctxHideTimer = setTimeout(() => {
              if (!document.querySelector('.context-menu.submenu:hover') && !document.querySelector('.context-submenu-trigger:hover')) {
                document.querySelectorAll('.context-menu.submenu').forEach(s => s.classList.add('hidden'));
              }
            }, 150);
          });
          menu.addEventListener('mouseenter', () => {
            if (menu.classList.contains('submenu')) {
              clearTimeout(ctxHideTimer);
            }
          });
        });
  
        document.querySelectorAll('.context-menu .context-menu-item:not(.context-submenu-trigger)').forEach(item => {
          item.addEventListener('mouseenter', () => {
            const parentMenu = item.closest('.context-menu');
            parentMenu.querySelectorAll('.context-submenu-trigger').forEach(trigger => {
              const sub = document.getElementById(trigger.dataset.submenu);
              if (sub) sub.classList.add('hidden');
            });
          });
        });
      },
      showContextMenu(menuId, x, y) {
        const menu = document.getElementById(menuId);
        if (!menu) return;
        menu.classList.remove('hidden');
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
  
        requestAnimationFrame(() => {
          const rect = menu.getBoundingClientRect();
          if (rect.right > window.innerWidth) {
            menu.style.left = (x - rect.width) + 'px';
          }
          if (rect.bottom > window.innerHeight) {
            menu.style.top = (y - rect.height) + 'px';
          }
        });
      },
      hideAllContextMenus() {
        document.querySelectorAll('.context-menu').forEach(m => m.classList.add('hidden'));
        document.querySelectorAll('.dropdown-menu.submenu').forEach(m => m.classList.add('hidden'));
      },
  };

  const api = { mixin };
  window.TMCtxMenu = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
