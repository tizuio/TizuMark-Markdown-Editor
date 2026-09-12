// 格式化工具栏与标签栏滚动
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';

  const mixin = {
      initFormatToolbar() {
        // 格式工具栏：直接按钮 + 复合下拉（悬停展开），折叠状态持久化
        const fmtToolbar = document.getElementById('format-toolbar');
        if (fmtToolbar) {
          fmtToolbar.classList.toggle('collapsed', !!this.settings.toolbarCollapsed);
          fmtToolbar.querySelectorAll('[data-action]').forEach(item => {
            item.addEventListener('click', (e) => {
              e.stopPropagation();
              this.executeMenuAction(item.dataset.action);
              // 点击菜单项后关闭弹出菜单：强制隐藏，直到鼠标移出下拉区再恢复 hover 展开
              const menu = item.closest('.dropdown-menu');
              if (menu) menu.classList.add('force-hide');
            });
          });
          // 鼠标移出下拉区后清除强制隐藏，恢复 hover 展开能力
          fmtToolbar.querySelectorAll('.fmt-dropdown').forEach(dd => {
            dd.addEventListener('mouseleave', () => {
              const m = dd.querySelector('.dropdown-menu');
              if (m) m.classList.remove('force-hide');
            });
          });
          const fmtCollapse = document.getElementById('fmt-collapse');
          if (fmtCollapse) {
            fmtCollapse.addEventListener('click', (e) => {
              e.stopPropagation();
              this.settings.toolbarCollapsed = !this.settings.toolbarCollapsed;
              fmtToolbar.classList.toggle('collapsed', this.settings.toolbarCollapsed);
              const lbl = fmtCollapse.querySelector('.fmt-toggle-label');
              if (lbl) lbl.textContent = this.settings.toolbarCollapsed ? this.t('expandToolbar') : this.t('collapseToolbar');
              this.saveSettings();
            });
          }
        }
      },
      initTabScroll() {
        this.scrollContainer = document.getElementById('tab-bar-scroll');
        this.scrollLeftBtn = document.getElementById('tab-scroll-left');
        this.scrollRightBtn = document.getElementById('tab-scroll-right');
  
        if (!this.scrollContainer) return;
  
        const updateArrows = () => {
          const maxScroll = this.scrollContainer.scrollWidth - this.scrollContainer.clientWidth;
          if (maxScroll <= 1) {
            this.scrollLeftBtn.classList.add('hidden');
            this.scrollRightBtn.classList.add('hidden');
          } else {
            this.scrollLeftBtn.classList.toggle('hidden', this.scrollContainer.scrollLeft <= 1);
            this.scrollRightBtn.classList.toggle('hidden', this.scrollContainer.scrollLeft >= maxScroll - 1);
          }
        };
  
        this.scrollContainer.addEventListener('scroll', updateArrows, { passive: true });
  
        this.scrollContainer.addEventListener('wheel', (e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            this.scrollContainer.scrollLeft += e.deltaY;
            e.preventDefault();
          }
        }, { passive: false });
  
        this.scrollLeftBtn.addEventListener('click', () => {
          this.scrollContainer.scrollBy({ left: -200, behavior: 'auto' });
        });
  
        this.scrollRightBtn.addEventListener('click', () => {
          this.scrollContainer.scrollBy({ left: 200, behavior: 'auto' });
        });
  
        // Update arrows after tab bar changes or window resize
        const observer = new ResizeObserver(updateArrows);
        observer.observe(this.scrollContainer);
  
        // Also observe the tab bar itself for changes when tabs are added/removed
        const tabBar = document.getElementById('tab-bar');
        if (tabBar) {
          const tabObserver = new ResizeObserver(updateArrows);
          tabObserver.observe(tabBar);
        }
  
        // Store updateArrows for external calls (e.g. after updateTabBar)
        this.updateTabScrollArrows = updateArrows;
      },
  };

  const api = { mixin };
  window.TMToolbar = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
