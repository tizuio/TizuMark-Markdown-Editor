// 侧边栏、大纲、面包屑与分栏布局
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { Tab } = TMConst;

  const mixin = {
      initOutline() {
        // 侧边栏关闭统一由「视图 → 侧边栏」菜单（toggleSidebar）控制，不再保留顶部关闭栏。
        const outlineSidebar = document.getElementById('outline-sidebar');
        if (!outlineSidebar) return;
      },
      updateSideButtons() {
        const outlineSidebar = document.getElementById('outline-sidebar');
        const sideLeft = document.getElementById('btn-side-left');
        const sideRight = document.getElementById('btn-side-right');
        const outlineWidth = outlineSidebar.classList.contains('hidden') ? 0 : outlineSidebar.offsetWidth;
        sideLeft.style.left = outlineWidth + 'px';
        sideRight.style.left = '';
      },
        toggleSidebar() {
          const sidebar = document.getElementById('outline-sidebar');
          const wasHidden = sidebar.classList.contains('hidden');
          if (wasHidden) {
            sidebar.style.width = (this.settings.outlineWidth ?? 240) + 'px';
            sidebar.classList.remove('hidden');
          } else {
            this.settings.outlineWidth = sidebar.offsetWidth;
            sidebar.style.width = '';
            sidebar.classList.add('hidden');
          }
          this.settings.sidebarHidden = sidebar.classList.contains('hidden');
          this.saveSettings();
          this.updateSidebarChecks();
          if (!sidebar.classList.contains('hidden')) {
            this.updateOutline();
          }
          this.updateSideButtons();
        },
        // 仅确保侧边栏可见（分屏改造后无 Tab 切换，文件/大纲双面板常显）。
        showSidebar() {
          const sidebar = document.getElementById('outline-sidebar');
          if (sidebar.classList.contains('hidden')) {
            sidebar.style.width = (this.settings.outlineWidth ?? 240) + 'px';
            sidebar.classList.remove('hidden');
            this.settings.sidebarHidden = false;
            this.saveSettings();
          }
          this.updateSidebarChecks();
          this.updateSideButtons();
          if (!sidebar.classList.contains('hidden')) this.updateOutline();
        },
        applySidebarState() {
          const sidebar = document.getElementById('outline-sidebar');
          if (this.settings.sidebarHidden) {
            sidebar.style.width = '';
            sidebar.classList.add('hidden');
          } else {
            sidebar.style.width = (this.settings.outlineWidth ?? 240) + 'px';
            sidebar.classList.remove('hidden');
          }
          this.updateSidebarChecks();
          this.updateSideButtons();
          this.applySplitterRatio();
          this.applyPanelCollapse();
        },
      updateSidebarChecks() {
        const sidebar = document.getElementById('outline-sidebar');
        const visible = !sidebar.classList.contains('hidden');
        const sidebarToggle = document.getElementById('btn-sidebar-toggle');
        if (sidebarToggle) sidebarToggle.classList.toggle('checked', visible);
      },
      initPanelHeaders() {
        const filesChevron = document.getElementById('files-chevron');
        const outlineChevron = document.getElementById('outline-chevron');
        const btnAllFolders = document.getElementById('btn-all-folders');
        const btnAllOutline = document.getElementById('btn-all-outline');
        if (filesChevron) {
          filesChevron.addEventListener('click', () => this.togglePanel('files'));
        }
        if (outlineChevron) {
          outlineChevron.addEventListener('click', () => this.togglePanel('outline'));
        }
        // 面板标题（左侧图标+文字）点击等效于点击折叠按钮
        const filesHeader = document.querySelector('.files-panel-header .panel-title-group');
        const outlineHeader = document.querySelector('.outline-panel-header .panel-title-group');
        if (filesHeader) {
          filesHeader.addEventListener('click', () => this.togglePanel('files'));
        }
        if (outlineHeader) {
          outlineHeader.addEventListener('click', () => this.togglePanel('outline'));
        }
        if (btnAllFolders) {
          btnAllFolders.addEventListener('click', () => {
            // 基于文件树实际 DOM 状态决定本次动作，避免 _allFoldersExpanded 标志漂移导致
            // 「再点击不折叠」：只要还有未折叠目录就折叠，否则展开。
            const treeEl = document.getElementById('folder-tree');
            const anyExpanded = !!(treeEl && treeEl.querySelector('.tree-node.tree-folder.expanded'));
            this.toggleAllFolders(!anyExpanded);
          });
        }
        if (btnAllOutline) {
          btnAllOutline.addEventListener('click', () => {
            // 基于大纲实际展开状态决定本次动作：只要还有「可见（未折叠）」的大纲子块就折叠，否则展开。
            // 默认大纲全展开，首点应折叠；图标与 _allOutlineExpanded 同步，避免「点击没反应」。
            const content = document.getElementById('outline-content');
            const anyExpanded = !!(content && content.querySelector('.outline-children:not(.collapsed)'));
            this.toggleAllOutline(!anyExpanded);
          });
        }
        // 初始化「全部」按钮语义：基于 DOM 实际状态，而非硬编码标志，避免图标与实际折叠态不符。
        // 文件：依据已展开目录集合；大纲：默认全展开（outline.js buildOutlineTree 节点 expanded:true），
        // 故只要没有 .outline-children.collapsed 就视为「已全展开」，按钮显示「折叠全部」。
        this._allFoldersExpanded = this.expandedFolders && this.expandedFolders.size > 0;
        const outlineContent0 = document.getElementById('outline-content');
        this._allOutlineExpanded = !outlineContent0 || !outlineContent0.querySelector('.outline-children.collapsed');
        this._updateAllFoldersBtn();
        this._updateAllOutlineBtn();
      },
      initOutlineResizer() {
        const resizer = document.getElementById('outline-resizer');
        const sidebar = document.getElementById('outline-sidebar');
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;
  
        resizer.addEventListener('mousedown', (e) => {
          e.preventDefault();
          isResizing = true;
          startX = e.clientX;
          startWidth = sidebar.offsetWidth;
          document.body.classList.add('is-resizing');
        });
  
        document.addEventListener('mousemove', (e) => {
          if (!isResizing) return;
          const delta = e.clientX - startX;
          let newWidth = startWidth + delta;
          newWidth = Math.max(80, Math.min(500, newWidth));
          sidebar.style.width = newWidth + 'px';
          this.cm.refresh();
          this.updateSideButtons();
        });
  
        document.addEventListener('mouseup', () => {
          if (!isResizing) return;
          isResizing = false;
          document.body.classList.remove('is-resizing');
          this.settings.outlineWidth = sidebar.offsetWidth;
          this.saveSettings();
        });
      },
      updateOutlineCheck() {
        this.updateSidebarChecks();
      },
      // 水平分隔条：调整「文件面板 / 大纲面板」上下高度比例。
      // 仿 initOutlineResizer，但改用 clientY + offsetHeight，并写入 settings.filesPanelRatio。
      initSplitter() {
        const resizer = document.getElementById('sidebar-h-resizer');
        const filesPanel = document.getElementById('folder-content');
        const outlinePanel = document.getElementById('outline-content');
        const sidebar = document.getElementById('outline-sidebar');
        if (!resizer || !filesPanel || !outlinePanel || !sidebar) return;
  
        const MIN = 120;
  
        // 两面板实际可分配高度 = 侧栏总高 − 固定 chrome（分隔条 + 大纲标题栏）。
        // 鼠标对齐的关键：两个面板 flex-basis 之和必须等于该可用高度，否则 flex 引擎会按比例
        // 压缩，导致分隔线移动量被缩放、与鼠标脱节。
        const chromeH = () => {
          let h = resizer.offsetHeight || 4;
          const oh = sidebar.querySelector('.outline-panel-header');
          if (oh) h += oh.offsetHeight;
          return h;
        };
        const availH = () => Math.max(0, sidebar.offsetHeight - chromeH());
  
        let isResizing = false;
        let startY = 0;
        let startFilesH = 0;
  
        resizer.addEventListener('mousedown', (e) => {
          e.preventDefault();
          isResizing = true;
          startY = e.clientY;
          startFilesH = filesPanel.offsetHeight;
          document.body.classList.add('is-resizing-row');
        });
  
        document.addEventListener('mousemove', (e) => {
          if (!isResizing) return;
          const avail = availH();
          const delta = e.clientY - startY;
          const newH = Math.max(MIN, Math.min(avail - MIN, startFilesH + delta));
          filesPanel.style.flexBasis = newH + 'px';
          outlinePanel.style.flexBasis = (avail - newH) + 'px';
        });
  
        document.addEventListener('mouseup', () => {
          if (!isResizing) return;
          isResizing = false;
          document.body.classList.remove('is-resizing-row');
          const avail = availH();
          if (avail > 0) {
            this.settings.filesPanelRatio = filesPanel.offsetHeight / avail;
            this.saveSettings();
          }
        });
      },
      // 按 settings.filesPanelRatio 还原上下比例（init / 启动 / 切换主题后调用）
      applySplitterRatio() {
        const filesPanel = document.getElementById('folder-content');
        const outlinePanel = document.getElementById('outline-content');
        const sidebar = document.getElementById('outline-sidebar');
        if (!filesPanel || !outlinePanel || !sidebar) return;
        const sidebarH = sidebar.offsetHeight;
        if (sidebarH <= 0) return;
        // 扣完整 chrome（分隔条 + 大纲标题栏），保证两面板 basis 之和等于可用高度
        let chrome = (document.getElementById('sidebar-h-resizer') || {}).offsetHeight || 4;
        const oh = sidebar.querySelector('.outline-panel-header');
        if (oh) chrome += oh.offsetHeight;
        const avail = Math.max(0, sidebarH - chrome);
        const ratio = Math.max(0.1, Math.min(0.9, this.settings.filesPanelRatio ?? 0.5));
        const filesH = Math.round(avail * ratio);
        filesPanel.style.flexBasis = filesH + 'px';
        outlinePanel.style.flexBasis = (avail - filesH) + 'px';
      },
      // 还原面板整体折叠态：折叠时仅隐藏内容区、保留标题栏，对侧 flex:1 自动占满；两折叠则均展开。
      applyPanelCollapse() {
        const filesPanel = document.getElementById('folder-content');
        const outlinePanel = document.getElementById('outline-content');
        const resizer = document.getElementById('sidebar-h-resizer');
        const sidebar = document.getElementById('outline-sidebar');
        if (!filesPanel || !outlinePanel) return;
        let filesCollapsed = !!this.settings.filesCollapsed;
        let outlineCollapsed = !!this.settings.outlineCollapsed;
        // 两者同时折叠属异常态：强制都展开，避免整栏空白
        if (filesCollapsed && outlineCollapsed) {
          filesCollapsed = false;
          outlineCollapsed = false;
          this.settings.filesCollapsed = false;
          this.settings.outlineCollapsed = false;
        }
        // 任一折叠时隐藏水平拖拽条（无占比可言）
        if (resizer) resizer.classList.toggle('hidden', filesCollapsed || outlineCollapsed);
        filesPanel.classList.toggle('panel-collapsed', filesCollapsed);
        outlinePanel.classList.toggle('panel-collapsed', outlineCollapsed);
        // 状态类：驱动折叠态 CSS（文件折叠→文件面板收缩为标题条、大纲内容占满；
        // 大纲折叠→大纲内容隐藏、文件内容占满）。两标题相对位置由 DOM 顺序保证，不重排。
        if (sidebar) {
          sidebar.classList.toggle('files-collapsed', filesCollapsed);
          sidebar.classList.toggle('outline-collapsed', outlineCollapsed);
        }
        const filesChevron = document.getElementById('files-chevron');
        const outlineChevron = document.getElementById('outline-chevron');
        if (filesChevron) {
          filesChevron.classList.toggle('collapsed', filesCollapsed);
          filesChevron.title = filesCollapsed ? '展开文件面板' : '收起文件面板';
          filesChevron.setAttribute('aria-expanded', String(!filesCollapsed));
        }
        if (outlineChevron) {
          outlineChevron.classList.toggle('collapsed', outlineCollapsed);
          outlineChevron.title = outlineCollapsed ? '展开大纲面板' : '收起大纲面板';
          outlineChevron.setAttribute('aria-expanded', String(!outlineCollapsed));
        }
        if (filesCollapsed || outlineCollapsed) {
          // 折叠态下不需要按比例分配高度（CSS 接管：可见面板 flex:1 占满，折叠面板 flex:0 0 auto 缩为标题条）
          filesPanel.style.flexBasis = '';
          outlinePanel.style.flexBasis = '';
        } else {
          // 两面板都展开：恢复由 settings.filesPanelRatio 决定的上下比例（折叠时 basis 被清空过，必须重设）
          this.applySplitterRatio();
        }
      },
      // 面板整体折叠/展开切换
      togglePanel(which) {
        if (which !== 'files' && which !== 'outline') return;
        const willCollapse = which === 'files' ? !this.settings.filesCollapsed : !this.settings.outlineCollapsed;
        if (willCollapse) {
          // 收起当前面板时，若另一面板已折叠，则联动展开另一面板——
          // 保证「文件/大纲至少有一个可见」，同时尊重本次「收起当前」的意图。
          const other = which === 'files' ? 'outline' : 'files';
          const otherCollapsed = other === 'files' ? this.settings.filesCollapsed : this.settings.outlineCollapsed;
          if (otherCollapsed) {
            if (other === 'files') this.settings.filesCollapsed = false;
            else this.settings.outlineCollapsed = false;
          }
        }
        if (which === 'files') {
          this.settings.filesCollapsed = !this.settings.filesCollapsed;
        } else {
          this.settings.outlineCollapsed = !this.settings.outlineCollapsed;
        }
        this.saveSettings();
        this.applyPanelCollapse();
      },
      // 文件树：一键展开/折叠全部目录
      async toggleAllFolders(expand) {
        const treeEl = document.getElementById('folder-tree');
        if (!treeEl) return;
        const btn = document.getElementById('btn-all-folders');
        const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>';
        const FOLDER_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>';
  
        // 取消任何正在进行的展开/折叠任务，防止旧任务在新操作后继续修改 DOM。
        // 典型场景：展开全部耗时较长，用户在 loading 结束后点折叠，旧展开仍可能异步渲染子目录并重新展开。
        if (this._folderToggleToken) {
          this._folderToggleToken.cancelled = true;
        }
        const token = { cancelled: false };
        this._folderToggleToken = token;
  
        // 显示 loading 覆盖层（防重复点击 + 视觉反馈），并设超时兜底强制清除，避免卡死在 loading。
        const TIMEOUT_MS = 20000;
        const overlay = this._showFolderLoading(expand ? '正在展开全部目录…' : '正在折叠全部目录…');
        if (btn) btn.disabled = true;
        let timeoutId = null;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('folder-toggle-timeout')), TIMEOUT_MS);
        });
  
        try {
          const work = async () => {
            if (token.cancelled) return;
            if (expand) {
              // 递归展开所有已渲染目录节点（懒加载层级由 renderFolderLevel 补全）
              const expandNode = async (container) => {
                if (token.cancelled) return;
                const folders = container.querySelectorAll(':scope > .tree-node.tree-folder');
                for (const node of folders) {
                  if (token.cancelled) return;
                  const childContainer = node.querySelector(':scope > .tree-children');
                  const path = node.dataset.path;
                  if (!childContainer) continue;
                  if (childContainer.childElementCount === 0) {
                    // 单个子目录读取失败（无权限/IO 异常）不应中断整棵展开
                    try {
                      await this.renderFolderLevel(path, childContainer, this._depthOf(node));
                    } catch (_) { /* 忽略，继续展开其余目录 */ }
                    if (token.cancelled) return;
                  }
                  childContainer.classList.remove('hidden');
                  node.classList.add('expanded');
                  const icon = node.querySelector(':scope > .tree-row .tree-icon.folder');
                  if (icon) icon.innerHTML = FOLDER_OPEN;
                  if (path) this.expandedFolders.add(path);
                  await expandNode(childContainer);
                }
              };
              await expandNode(treeEl);
            } else {
              // 直接折叠当前所有已展开目录的 DOM，不依赖重建：清空集合 + 隐藏 .tree-children
              this.expandedFolders.clear();
              treeEl.querySelectorAll('.tree-children').forEach((c) => c.classList.add('hidden'));
              treeEl.querySelectorAll('.tree-node.tree-folder.expanded').forEach((n) => n.classList.remove('expanded'));
              treeEl.querySelectorAll('.tree-row .tree-icon.folder').forEach((icon) => { icon.innerHTML = FOLDER; });
            }
          };
          // 超时强制兜底：无论成功或超时都进 finally 清理；超时不抛错，只提示
          await Promise.race([work(), timeoutPromise.then(() => { throw new Error('folder-toggle-timeout'); })]);
        } catch (err) {
          if (err && err.message === 'folder-toggle-timeout') {
            // 超时：目录可能过多/IO 慢，强制结束并提示，不让用户卡在 loading
            token.cancelled = true;
            this.showToast(expand ? '展开全部目录超时' : '折叠全部目录超时');
          }
          // 其它异常也继续走 finally 清理
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
          token.cancelled = true;
          this._hideFolderLoading(overlay);
          if (btn) btn.disabled = false;
          // 仅当本任务仍是当前任务时才更新状态与按钮，避免被更新的操作覆盖。
          // （如用户在新展开中途点折叠，折叠已设置状态为 false，旧展开的 finally 不应再把它改回 true。）
          if (this._folderToggleToken === token) {
            this.saveSession();
            this._allFoldersExpanded = expand;
            this._updateAllFoldersBtn();
          }
        }
      },
      // 在文件面板内显示半透明 loading 覆盖层；返回该元素以便后续移除
      _showFolderLoading(text) {
        const folderContent = document.getElementById('folder-content');
        if (!folderContent) return null;
        let overlay = folderContent.querySelector('.folder-loading-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = 'folder-loading-overlay';
          const spinner = document.createElement('div');
          spinner.className = 'folder-loading-spinner';
          const label = document.createElement('span');
          label.className = 'folder-loading-text';
          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'folder-loading-cancel';
          cancelBtn.textContent = this.t('cancel') || '取消';
          cancelBtn.addEventListener('click', () => {
            // 取消：中止展开/折叠的剩余递归（已展开/折叠的目录保持现状），并收起遮罩
            if (this._folderToggleToken) this._folderToggleToken.cancelled = true;
            this._hideFolderLoading(overlay);
          });
          overlay.appendChild(spinner);
          overlay.appendChild(label);
          overlay.appendChild(cancelBtn);
          folderContent.appendChild(overlay);
        }
        overlay.querySelector('.folder-loading-text').textContent = text || '';
        overlay.classList.remove('hidden');
        return overlay;
      },
      _hideFolderLoading(overlay) {
        if (!overlay || !overlay.parentNode) return;
        overlay.classList.add('hidden');
      },
      // 大纲：一键展开/折叠全部
      toggleAllOutline(expand) {
        const content = document.getElementById('outline-content');
        if (!content) return;
        const childrenBlocks = content.querySelectorAll('.outline-children');
        childrenBlocks.forEach((block) => {
          block.classList.toggle('collapsed', !expand);
        });
        const toggles = content.querySelectorAll('.outline-toggle:not(.outline-toggle--hidden)');
        toggles.forEach((tg) => {
          // 通过 collapsed 类让 CSS 旋转 SVG（不再用 textContent 写 ▼/▶，否则会破坏矢量三角、变大且风格不一致）
          tg.classList.toggle('collapsed', !expand);
        });
        this._allOutlineExpanded = expand;
        this._updateAllOutlineBtn();
      },
      _depthOf(node) {
        let depth = 0;
        let p = node.parentElement;
        while (p && p.id !== 'folder-tree') {
          if (p.classList.contains('tree-children')) depth++;
          p = p.parentElement;
        }
        return depth;
      },
      _updateAllFoldersBtn() {
        const btn = document.getElementById('btn-all-folders');
        if (!btn) return;
        // 双态字形：三条横线 + 三角（与单箭头 disclosure 的面板 chevron 明显区分）
        // 已全展开→「上三角」表示点击将折叠全部；否则→「下三角」表示点击将展开全部
        // 展开/折叠全部：使用 Lucide fold-vertical / unfold-vertical（收纳/展开，二者互为镜像，语义清晰）
        const COLLAPSE_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/></svg>';
        const EXPAND_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3 3-3-3"/><path d="m15 5-3-3-3 3"/></svg>';
        btn.innerHTML = this._allFoldersExpanded ? COLLAPSE_ALL : EXPAND_ALL;
        btn.title = this._allFoldersExpanded ? '折叠全部目录' : '展开全部目录';
        btn.setAttribute('aria-pressed', String(this._allFoldersExpanded));
      },
      _updateAllOutlineBtn() {
        const btn = document.getElementById('btn-all-outline');
        if (!btn) return;
        // 展开/折叠全部：使用 Lucide fold-vertical / unfold-vertical（收纳/展开，二者互为镜像，语义清晰）
        const COLLAPSE_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/></svg>';
        const EXPAND_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3 3-3-3"/><path d="m15 5-3-3-3 3"/></svg>';
        btn.innerHTML = this._allOutlineExpanded ? COLLAPSE_ALL : EXPAND_ALL;
        btn.title = this._allOutlineExpanded ? '折叠全部大纲' : '展开全部大纲';
        btn.setAttribute('aria-pressed', String(this._allOutlineExpanded));
      },
      initBreadcrumb() {
        const bc = document.getElementById('editor-breadcrumb');
        const scroll = document.getElementById('editor-breadcrumb-scroll');
        const overflowBtn = document.getElementById('editor-breadcrumb-overflow');
        if (!bc || !scroll) return;
        this._breadcrumbOverflowBtn = overflowBtn;
  
        // 滚轮横向滚动：鼠标滚轮在面包屑上时转换为左右滚动
        bc.addEventListener('wheel', (e) => {
          if (e.deltaY !== 0 && scroll.scrollWidth > scroll.clientWidth) {
            e.preventDefault();
            scroll.scrollLeft += e.deltaY;
            this._updateBreadcrumbOverflow();
          }
        }, { passive: false });
  
        // 横向滚动时同步左侧溢出指示器（回到开头按钮）的显隐
        scroll.addEventListener('scroll', () => this._updateBreadcrumbOverflow(), { passive: true });
  
        // 点击左侧指示器平滑回到开头（查看被折叠/滚走的根标题）
        if (overflowBtn) {
          overflowBtn.addEventListener('click', () => {
            scroll.scrollTo({ left: 0, behavior: 'smooth' });
          });
        }
  
        // 点击标题跳转（事件委托）
        bc.addEventListener('click', (e) => {
          const item = e.target.closest('[data-breadcrumb-line]');
          if (!item || !this.cm) return;
          const line = parseInt(item.dataset.breadcrumbLine, 10);
          if (Number.isNaN(line)) return;
          this._jumpToHeadingLine(line);
        });
      },
      // 当内容溢出且已向左滚动离开起点时，显示左侧"回到开头"指示器
      _updateBreadcrumbOverflow() {
        const bc = document.getElementById('editor-breadcrumb');
        const scroll = document.getElementById('editor-breadcrumb-scroll');
        if (!bc || !scroll || !this._breadcrumbOverflowBtn) return;
        const show = scroll.scrollWidth > scroll.clientWidth && scroll.scrollLeft > 1;
        bc.classList.toggle('show-overflow', show);
      },
      _jumpToHeadingLine(line) {
        if (!this.cm) return;
        this.cm.setCursor({ line, ch: 0 });
        this.cm.focus();
        // WebView 中 scrollIntoView 不触发，改用精确滚动公式
        const y = this.cm.heightAtLine(line, 'local');
        this.cm.scrollTo(0, Math.max(0, y - 80));
      },
      updateBreadcrumb(force = false, line = null) {
        if (!this.cm) return;
        const content = this.cm.getValue();
        if (force || this._breadcrumbLastContent !== content) {
          this._breadcrumbHeadings = Outline.extractHeadings(content, { headingToId: (t) => this.headingToId(t) });
          this._breadcrumbLastContent = content;
        }
        const targetLine = typeof line === 'number' ? line : this.cm.getCursor().line;
        const path = Outline.computeBreadcrumbPath(this._breadcrumbHeadings, targetLine);
        this._renderBreadcrumb(path);
      },
      _renderBreadcrumb(path) {
        const bc = document.getElementById('editor-breadcrumb');
        const content = document.getElementById('editor-breadcrumb-content');
        const scroll = document.getElementById('editor-breadcrumb-scroll');
        if (!bc || !content) return;
  
        // diff guard：路径或文件名未变时不重写 DOM，避免滚动/光标高频事件导致重排
        const rawFileName = this.activeTab?.name || '';
        const key = (path ? path.map((h) => h.line + ':' + h.text).join('|') : '') + '|' + rawFileName;
        if (this._breadcrumbLastKey === key) return;
        this._breadcrumbLastKey = key;
  
        if (!path) path = [];
  
        // 始终显示面包屑（含文件名）。即使光标在第一标题前导致 path 为空，
        // 也只渲染文件名占位、保留栏体高度，避免编辑区因 .hidden{display:none}
        // 上下跳动；标题链由后续 for 循环按 path 长度追加。
        bc.classList.remove('hidden');
        const fileIcon = '<svg class="breadcrumb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /></svg>';
        content.innerHTML = Outline.renderBreadcrumbHtml(path, rawFileName || this.t('untitled'), {
          iconSvg: fileIcon,
        });
  
        // 自动定位当前项：仅当活动标题（最后一个）不完全可见时滚动到末尾，
        // 避免用户手动左滚查看开头时被强行拉回。
        if (scroll) {
          const activeEl = content.querySelector('.editor-breadcrumb-item.active');
          if (activeEl) {
            const right = activeEl.offsetLeft + activeEl.offsetWidth;
            if (right > scroll.scrollLeft + scroll.clientWidth) {
              scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth;
            }
          }
          this._updateBreadcrumbOverflow();
        }
      },
      updateOutline() {
        const content = this.cm.getValue();
        const outlineContent = document.getElementById('outline-content');
        const headings = Outline.extractHeadings(content, { headingToId: (t) => this.headingToId(t) });
  
        // 面包屑共享同一套标题数据，避免重复抽取
        this._breadcrumbHeadings = headings;
        this._breadcrumbLastContent = content;
        this._renderBreadcrumb(Outline.computeBreadcrumbPath(headings, this.cm.getCursor().line));
  
        if (headings.length === 0) {
          outlineContent.innerHTML = `<div class="outline-empty">${this.t('noHeadings')}</div>`;
          return;
        }
  
        const tree = Outline.buildOutlineTree(headings);
        outlineContent.innerHTML = Outline.renderOutlineHtml(tree, {
          escapeHtml: (t) => this.escapeHtml(t),
          maxLevel: this.settings.outlineFilterLevel || 0,
        });
  
        // Event delegation on outline-content
        outlineContent.onclick = (e) => {
          const toggle = e.target.closest('.outline-toggle');
          const item = e.target.closest('.outline-item');
          if (!item) return;
  
          if (toggle) {
            e.stopPropagation();
            const wrapper = item.closest('.outline-item-wrapper');
            const children = wrapper?.querySelector('.outline-children');
            if (children) {
              const isCollapsed = children.classList.toggle('collapsed');
              // 通过 collapsed 类让 CSS 旋转 SVG（不再用 textContent 写 ▼/▶，否则会破坏矢量三角、变大且风格不一致）
              toggle.classList.toggle('collapsed', isCollapsed);
            }
            return;
          }
  
          // Label click → jump
          const id = item.dataset.id;
          const line = parseInt(item.dataset.line, 10);
          // 跳转期间关闭滚动同步：setCursor/scrollIntoView 与 preview.scrollTo 都会触发各自的
          // scroll 事件，若不抑制，滚动同步会把对方刚设好的目标位置覆盖掉，表现为「点完大纲
          // 编辑区/预览仍停在顶部、光标却跳到了标题行」。先取消在途同步调度，再双标志锁住，
          // 跳转完成 120ms 后恢复（与 handleTaskCheckboxToggle 同一做法）。
          this._scrollThrottleTimer = null;
          this._scrollThrottlePending = null;
          clearTimeout(this._scrollDebounceTimer);
          this._scrollDebounceTimer = null;
          // 取消可能晚到的「视图模式恢复滚动」定时器（applyViewMode 50ms），
          // 否则它会在本次跳转之后把编辑器/预览又拉回旧位置。
          clearTimeout(this._viewModeRestoreTimer);
          this._viewModeRestoreTimer = null;
          this._canScroll.editor = false;
          this._canScroll.preview = false;
          // 编辑区始终跳转到该标题行（与文档大小无关，大文件预览只渲染头部时也能跳）
          if (!isNaN(line)) {
            this.cm.setCursor({ line, ch: 0 });
            // 显式滚动到标题行顶部留 80px 余量：scrollIntoView 在某些 WebView 下不触发实际滚动，
            // 导致「光标到了标题行、可视区仍停在顶部」；scrollTo 直接生效且不受上方 _canScroll 抑制影响。
            const targetTop = this.cm.heightAtLine(line, 'local') - 80;
            this.cm.scrollTo(0, Math.max(0, targetTop));
          }
          // 预览区跳转（仅当该标题已渲染在预览中时）
          // 守卫：纯符号标题（如 `# ===`）headingToId 会产出空串，querySelector('#') 抛
          // SyntaxError（历史 bug），跳过预览跳转仅保留编辑区跳转
          if (id) {
            const target = this.preview.querySelector(`#${CSS.escape(id)}`);
            if (target) {
              const previewHeight = this.preview.clientHeight;
              const targetRect = target.getBoundingClientRect();
              const previewRect = this.preview.getBoundingClientRect();
              // 顶部对齐：标题行与预览视口顶部对齐（余量 0），与编辑区跳转（顶部 -80px）一致，
              // 符合用户预期「点大纲即定位到标题顶部」，且不依赖居中逻辑、不影响滚动同步。
              const top = targetRect.top - previewRect.top + this.preview.scrollTop;
              this.preview.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
            } else if (this.previewWindow) {
              // 大文档窗口模式：目标标题尚未渲染在预览中，以该行为焦点重渲染预览窗口，使其落点
              this._previewScrollDriven = false;
              if (Number.isFinite(line)) this._previewFocusLine = line;
              this.updatePreview();
            }
          }
          // 安全网：120ms 后恢复滚动同步（此时两个面板均已停在标题位置，无在途滚动事件）。
          // 直接还原为可用状态，避免把上一轮滚动同步残留的 false 标志固化下来。
          setTimeout(() => {
            if (this._canScroll) {
              this._canScroll.editor = true;
              this._canScroll.preview = true;
            }
          }, 120);
          outlineContent.querySelectorAll('.outline-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
        };
  
        // 渲染后按当前光标行设置高亮（DOM 已重建，重置 guard 再派生）
        this._outlineActiveKey = null;
        this.updateOutlineActive(this.cm.getCursor().line);
      },
      // 大纲动态跟随：根据给定行号高亮当前标题，并将该标题滚动进 outline 视口，
      // 与面包屑共用 computeBreadcrumbPath，保证二者指向同一当前标题。
      // 用于：编辑器滚动、光标移动、内容/标签页切换后保持大纲与文档/面包屑一致。
      updateOutlineActive(line) {
        const outlineContent = document.getElementById('outline-content');
        if (!outlineContent) return;
        const items = outlineContent.querySelectorAll('.outline-item');
        const headings = this._breadcrumbHeadings;
  
        if (!headings || !headings.length || typeof line !== 'number') {
          items.forEach(el => el.classList.remove('active'));
          this._outlineActiveKey = null;
          return;
        }
  
        // 当前标题 = 面包屑路径最后一个（最深、且行号 <= line 的标题），与面包屑完全一致
        const path = Outline.computeBreadcrumbPath(headings, line);
        const current = path.length ? path[path.length - 1] : null;
  
        let target = null;
        if (current) {
          target = outlineContent.querySelector(`.outline-item[data-line="${current.line}"][data-id="${CSS.escape(String(current.id))}"]`)
               || outlineContent.querySelector(`.outline-item[data-line="${current.line}"]`);
        }
  
        const key = current ? (current.line + ':' + current.id) : '';
        // diff guard：当前标题未变时跳过 DOM 写入与滚动，避免同段内滚动抖动
        if (this._outlineActiveKey === key && target) return;
        this._outlineActiveKey = key;
  
        items.forEach(el => el.classList.remove('active'));
        if (!target) return;
        target.classList.add('active');
  
        // 纵向跟随：仅当该标题离开 outline 视口时才滚动其回可见区域（不改横向滚动）
        // 若标题因父级折叠而隐藏（offsetParent 为 null），仅保留高亮、跳过滚动
        if (target.offsetParent === null) return;
        const cRect = outlineContent.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();
        if (tRect.top < cRect.top + 4 || tRect.bottom > cRect.bottom - 4) {
          const delta = (tRect.top + tRect.bottom) / 2 - (cRect.top + cRect.bottom) / 2;
          outlineContent.scrollTop += delta;
        }
      },
      // 预览模式大纲跟随：编辑器隐藏时，按预览滚动位置推导当前标题（源码行）再高亮。
      // 视图模式切换后预览 recreate，标题 id 与大纲 id 同源（均由 headingToId 生成），
      // 故可直接用预览 DOM 中的 h1~h6[id] 反查源码行，保证大纲与预览内容一致。
      updateOutlineFromPreview() {
        const preview = this.preview;
        const headings = this._breadcrumbHeadings;
        if (!preview || !headings || !headings.length) {
          this.updateOutlineActive(-1); // 无标题：清空高亮
          return;
        }
        let line = null;
        if (this._previewVirtual && Number.isFinite(this._previewFocusLine)) {
          // 大文档虚拟预览：渲染切片不含所有标题，直接用窗口焦点行推导当前标题
          line = this._previewFocusLine;
        } else {
          const pRect = preview.getBoundingClientRect();
          const els = preview.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]');
          let foundId = null;
          for (const el of els) {
            const r = el.getBoundingClientRect();
            // 取最后一个顶部已滚过视口上沿的标题（文档顺序 == 标题顺序，遇未越过者即停）
            if (r.top - pRect.top <= 4) foundId = el.id; else break;
          }
          if (foundId) {
            const h = headings.find((hh) => hh.id === foundId);
            if (h) line = h.line;
          }
        }
        if (line == null) {
          // 滚到首个标题之前：清空高亮（line 取首标题前一行，computeBreadcrumbPath 返回空）
          this.updateOutlineActive(headings[0].line - 1);
        } else {
          this.updateOutlineActive(line);
        }
      },
      headingToId(text) {
        let id = '';
        for (const ch of text) {
          if (/[\p{L}\p{N}]/u.test(ch)) {
            id += ch.toLowerCase();
          } else if (ch === ' ' || ch === '-' || ch === '_') {
            id += '-';
          }
        }
        return id.replace(/-+/g, '-').replace(/^-|-$/g, '');
      },
      escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      },
      // 转义双引号 HTML 属性值（img alt、a title 等），防止属性提前闭合
      escapeAttr(text) {
        return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },
      // 转义 Markdown 链接/图片 alt 文本中破坏语法的字符（] 与 \）
      escapeMdText(text) {
        return String(text).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
      },
      initResizer() {
        const resizer = document.getElementById('resizer');
        const container = document.querySelector('.editor-container');
        const editorPane = document.getElementById('editor-pane');
        const previewPane = document.getElementById('preview-pane');
        const outlineSidebar = document.getElementById('outline-sidebar');
        let isResizing = false;
        let startX = 0;
        let startEditorWidth = 0;
  
        const onMouseMove = (e) => {
          if (!isResizing) return;
          const delta = e.clientX - startX;
          const newEditorWidth = startEditorWidth + delta;
          const outlineWidth = outlineSidebar.classList.contains('hidden') ? 0 : outlineSidebar.offsetWidth;
          const resizerWidth = resizer.offsetWidth;
          const totalContentWidth = container.offsetWidth - outlineWidth - resizerWidth;
          const editorPercent = (newEditorWidth / totalContentWidth) * 100;
          if (editorPercent > 20 && editorPercent < 80) {
            const editorRatio = editorPercent / 100;
            const previewRatio = 1 - editorRatio;
            editorPane.style.flex = editorRatio.toFixed(4) + ' 0 0px';
            previewPane.style.flex = previewRatio.toFixed(4) + ' 0 0px';
            editorPane.style.width = '';
            previewPane.style.width = '';
            this._editorPercent = editorPercent;
            this.cm.refresh();
            this.updateSideButtons();
          }
        };
  
        const onMouseUp = () => {
          if (!isResizing) return;
          isResizing = false;
          document.body.classList.remove('is-resizing');
          // 保存预览区宽度到设置（合并自 PR #36）
          const pw = previewPane.getBoundingClientRect().width;
          this.settings.previewPaneWidth = Math.round(pw);
          this.saveSettings();
          document.documentElement.style.setProperty('--preview-pane-width', Math.round(pw) + 'px');
        };
  
        resizer.addEventListener('mousedown', (e) => {
          e.preventDefault();
          isResizing = true;
          startX = e.clientX;
          startEditorWidth = editorPane.getBoundingClientRect().width;
          document.body.classList.add('is-resizing');
        });
  
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      },
      // 应用已保存的预览区宽度（合并自 PR #36）：分屏模式下按 settings.previewPaneWidth 还原布局。
      // 纯预览/编辑器折叠/预览折叠由 CSS 类控制，禁止用用户分屏宽度覆盖，否则占不满且留空白。
      applyPreviewPaneWidth() {
        const container = document.querySelector('.editor-container');
        if (!container) return;
        if (container.classList.contains('preview-mode')
            || container.classList.contains('editor-collapsed')
            || container.classList.contains('preview-collapsed')) return;
        const pw = this.settings.previewPaneWidth;
        if (!pw) return;
        const editorPane = document.getElementById('editor-pane');
        const previewPane = document.getElementById('preview-pane');
        if (!editorPane || !previewPane) return;
        const outlineSidebar = document.getElementById('outline-sidebar');
        const resizer = document.getElementById('resizer');
        const outlineWidth = outlineSidebar && outlineSidebar.classList.contains('hidden') ? 0 : (outlineSidebar ? outlineSidebar.offsetWidth : 0);
        const resizerWidth = resizer ? resizer.offsetWidth : 6;
        const totalContentWidth = container.offsetWidth - outlineWidth - resizerWidth;
        if (totalContentWidth <= 0) return;
        const editorWidth = totalContentWidth - pw;
        const editorRatio = (editorWidth / totalContentWidth);
        if (editorRatio > 0.1 && editorRatio < 0.9) {
          editorPane.style.flex = editorRatio.toFixed(4) + ' 0 0px';
          previewPane.style.flex = (1 - editorRatio).toFixed(4) + ' 0 0px';
          this._editorPercent = editorRatio * 100;
        } else {
          // 比例超出范围时，直接用预设宽度设置预览区
          previewPane.style.flex = '0 0 auto';
          previewPane.style.width = pw + 'px';
          editorPane.style.flex = '1 1 0px';
          this._editorPercent = ((totalContentWidth - pw) / totalContentWidth) * 100;
        }
        document.documentElement.style.setProperty('--preview-pane-width', pw + 'px');
      },
    // 大纲层级过滤下拉（自绘 Select）
    initOutlineFilter() {
      // 大纲层级过滤下拉：自绘 Select，选项 = 全部 / 仅 H1 / 仅 H1–H2 / ... / 仅 H1–H6
      const outlineFilterHost = document.getElementById('outline-filter');
      if (outlineFilterHost) {
        this._outlineFilterSelect = new Select(outlineFilterHost, {
          value: String(this.settings.outlineFilterLevel || 0),
          t: this.t.bind(this),
          ariaLabelKey: 'outlineFilter',
          optionsProvider: (t) => ([
            { value: '0', label: t('outlineFilterAll') },
            { value: '1', label: t('outlineFilterH1') },
            { value: '2', label: t('outlineFilterH2') },
            { value: '3', label: t('outlineFilterH3') },
            { value: '4', label: t('outlineFilterH4') },
            { value: '5', label: t('outlineFilterH5') },
            { value: '6', label: t('outlineFilterH6') },
          ]),
          onChange: (v) => {
            this.settings.outlineFilterLevel = parseInt(v, 10) || 0;
            this.saveSettings();
            this.updateOutline();
          },
        });
      }
    },
    // 视图模式、面板折叠与大文档横幅按钮
    initViewControls() {
      document.getElementById('btn-view-preview').addEventListener('click', () => this.setViewMode('preview'));
      document.getElementById('btn-view-edit').addEventListener('click', () => this.setViewMode('edit'));
      document.getElementById('btn-side-left').addEventListener('click', () => this.toggleCollapse('editor'));
      document.getElementById('btn-side-right').addEventListener('click', () => this.toggleCollapse('preview'));
      document.getElementById('large-file-banner-close').addEventListener('click', () => {
        this.hideLargeFileNotice();
        this._largeFileNoticeDismissed = true;
      });
      // 「不再提醒」：本次应用运行期间彻底屏蔽大文档横幅（会话级，重启后复位）。
      document.getElementById('large-file-banner-dont-remind').addEventListener('click', () => {
        this._largeFileNoticeSessionSuppressed = true;
        this.hideLargeFileNotice();
      });
    },
  };

  const api = { mixin };
  window.TMLayout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
