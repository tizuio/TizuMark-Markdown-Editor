// 主题、背景色、视图模式与面板折叠
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';

  const mixin = {
      // 同步托盘显隐状态到 Rust 后端
      async applyWindowBehavior() {
        const showTray = this.settings.showTrayIcon !== false;
        try {
          await TauriApi.setWindowBehavior({ showTray });
        } catch (err) {
          console.warn('applyWindowBehavior failed', err);
        }
      },
      // 按 RGB 16 进制计算感知亮度（ITU-R BT.601），越接近 255 越亮。
      _bgLuminance(hex) {
        const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
        if (!m) return 255;
        const v = parseInt(m[1], 16);
        const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
        return 0.299 * r + 0.587 * g + 0.114 * b;
      },
      // 自定义页面底色：编辑+预览区背景用 customBgColor，文字按亮度反色。
      // 实现：在 <html> 上设 --custom-bg/--custom-fg，styles.css 里这两变量优先覆盖编辑/预览区；
      // body 加 custom-bg-active 类作为开关标记。关闭时清除变量与类，恢复主题默认。
      applyCustomBg() {
        const root = document.documentElement;
        const body = document.body;
        if (!root || !body) return;
        if (this.settings.customBgEnabled) {
          const bg = this.settings.customBgColor || '#f8f7f4';
          const lum = this._bgLuminance(bg);
          const fg = lum >= 128 ? '#2c2c2e' : '#d1d2d6';
          root.style.setProperty('--custom-bg', bg);
          root.style.setProperty('--custom-fg', fg);
          body.classList.add('custom-bg-active');
        } else {
          root.style.removeProperty('--custom-bg');
          root.style.removeProperty('--custom-fg');
          body.classList.remove('custom-bg-active');
        }
      },
      async applyThemeMode() {
        const mode = this.settings.themeMode;
        if (mode === 'light') {
          this.isDark = false;
        } else if (mode === 'dark') {
          this.isDark = true;
        } else {
          this.isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
        document.documentElement.setAttribute('data-theme', this.isDark ? 'dark' : 'light');
        document.documentElement.setAttribute('data-color-scheme', this.settings.colorScheme || 'default');
        this.cm.setOption('theme', this.isDark ? 'material-darker' : 'default');
        this.updateThemeIcon();
        const highlightTheme = document.getElementById('highlight-theme');
        if (highlightTheme) {
          highlightTheme.href = this.isDark
            ? 'lib/highlight.js/github-dark.min.css'
            : 'lib/highlight.js/github.min.css';
        }
        await this.rerenderMermaid();
      },
      async rerenderMermaid() {
        if (typeof mermaid === 'undefined') return;
        // 主题切换：旧主题的 SVG 缓存失效，清空后让下次 updatePreview / 本函数按新主题重渲染
        this._mermaidCache.clear();
        const gen = ++this._mermaidGeneration;
        const containers = this.preview.querySelectorAll('.mermaid-container');
        if (containers.length === 0) return;
  
        // 保存代码并创建全新容器（避免复用旧容器的渲染状态）
        const containerData = [];
        containers.forEach(container => {
          const code = container.getAttribute('data-code') || container.textContent;
          const sourceLine = container.getAttribute('data-source-line');
          containerData.push({
            code,
            sourceLine,
            nextSibling: container.nextSibling,
            parent: container.parentNode,
          });
        });
  
        // 重建容器
        containerData.forEach((data, i) => {
          const newContainer = document.createElement('div');
          newContainer.className = 'mermaid-container';
          newContainer.id = 'mermaid-' + Date.now() + '-' + i;
          newContainer.setAttribute('data-code', data.code);
          if (data.sourceLine) newContainer.setAttribute('data-source-line', data.sourceLine);
          newContainer.textContent = data.code;
          if (data.nextSibling) {
            data.parent.insertBefore(newContainer, data.nextSibling);
          } else {
            data.parent.appendChild(newContainer);
          }
        });
  
        // 移除旧容器
        containers.forEach(c => c.remove());
  
        if (this._mermaidGeneration !== gen) return;
  
        try {
          mermaid.initialize({
            startOnLoad: false,
            theme: this.isDark ? 'dark' : 'default',
            securityLevel: 'loose',
            fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif',
          });
          // 主题切换重渲染全部图表。一次性 mermaid.run(全部节点) 是同步 CPU 密集任务
          // （layout 计算），图表多时阻塞主线程造成明显卡顿（含转圈动画被卡住）。
          // 分批渲染：每批【渲染前】先让出主线程一帧（保证转圈持续转动、不被阻塞），
          // 图表较多时再叠加预览区 loading 提示。
          const nodes = Array.from(this.preview.querySelectorAll('.mermaid-container'));
          const BATCH = 2;
          const showLoading = nodes.length > 6;
          if (showLoading) this._beginPaneLoad();
          try {
            for (let i = 0; i < nodes.length; i += BATCH) {
              if (this._mermaidGeneration !== gen) return; // 中途又切主题，放弃本次
              // 每批渲染前让出主线程一帧：mermaid.run 是同步 CPU 密集，若首批立即执行，
              // 转圈动画帧会被阻塞（表现为"点完停顿一下才开始转"）
              await new Promise((r) => requestAnimationFrame(r));
              const batch = nodes.slice(i, i + BATCH);
              try {
                await mermaid.run({ nodes: batch });
              } catch (e) {
                console.error('Mermaid re-render error:', e);
              }
            }
          } finally {
            if (showLoading) this._endPaneLoad();
          }
        } catch (e) {
          console.error('Mermaid re-render error:', e);
        }
      },
      async toggleTheme() {
        // 复用启动 loading（logo + 进度条 + 文字）作全局遮罩。平滑策略：
        //  1) 先把遮罩背景/文字固定为【切换前】主题色（inline style）——切换瞬间 var(--bg-primary)
        //     跳变不会让遮罩"啪"地变色，且遮罩初始色与页面一致，出现时无缝；
        //  2) 双 rAF：第一帧绘制遮罩，第二帧才改主题（单 rAF 回调在绘制前执行会与遮罩同帧）；
        //  3) 完成后的隐藏用 opacity 淡出（合成器属性，不占主线程，mermaid 渲染期间也流畅，
        //     不用 background-color 渐变——那是主线程 repaint，会被渲染阻塞导致跳帧卡顿）。
        const overlay = document.getElementById('loading-overlay');
        const cs = getComputedStyle(document.documentElement);
        overlay.style.backgroundColor = cs.getPropertyValue('--bg-primary').trim() || '#f5f5f5';
        const textEl = document.getElementById('loading-text');
        if (textEl) textEl.style.color = cs.getPropertyValue('--text-secondary').trim();
        overlay.classList.remove('hidden');
        overlay.offsetHeight; // 强制重排，确保下一帧一定绘制遮罩
        const showTime = Date.now();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        try {
          if (this.settings.themeMode !== 'light' && this.settings.themeMode !== 'dark') {
            this.settings.themeMode = this.isDark ? 'light' : 'dark';
            if (this._selects && this._selects.themeMode) this._selects.themeMode.setValue(this.settings.themeMode, true);
          }
          this.isDark = !this.isDark;
          this.settings.themeMode = this.isDark ? 'dark' : 'light';
          if (this._selects && this._selects.themeMode) this._selects.themeMode.setValue(this.settings.themeMode, true);
          this.saveSettings();
          document.documentElement.setAttribute('data-theme', this.isDark ? 'dark' : 'light');
          document.documentElement.setAttribute('data-color-scheme', this.settings.colorScheme || 'default');
          this.cm.setOption('theme', this.isDark ? 'material-darker' : 'default');
          this.updateThemeIcon();
  
          const highlightTheme = document.getElementById('highlight-theme');
          if (highlightTheme) {
            highlightTheme.href = this.isDark
              ? 'lib/highlight.js/github-dark.min.css'
              : 'lib/highlight.js/github.min.css';
          }
  
          await this.rerenderMermaid();
        } finally {
          // 最小显示时长：图表少/切换很快时遮罩也不一闪而过，保证用户能看清 loading 界面
          const MIN_SHOW_MS = 300;
          const elapsed = Date.now() - showTime;
          if (elapsed < MIN_SHOW_MS) {
            await new Promise((r) => setTimeout(r, MIN_SHOW_MS - elapsed));
          }
          // 清除固定色 → opacity 淡出（0.3s，合成器流畅）→ 隐藏。淡出时页面已是新主题，
          // 旧色遮罩渐渐透明、新主题页面透出，自然交叉过渡
          overlay.style.backgroundColor = '';
          if (textEl) textEl.style.color = '';
          overlay.style.opacity = '0';
          await new Promise((r) => setTimeout(r, 320));
          overlay.style.opacity = '';
          overlay.classList.add('hidden');
        }
        this.setStatus(this.t('themeSwitched', { theme: this.isDark ? this.t('themeDark') : this.t('themeLight') }));
      },
      updateThemeIcon() {
        const svg = document.getElementById('theme-icon');
        const text = document.getElementById('theme-text');
        if (!svg) return;
        if (this.isDark) {
          svg.innerHTML = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
          if (text) text.textContent = this.t('themeDark');
        } else {
          svg.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>';
          if (text) text.textContent = this.t('themeLight');
        }
      },
      loadTheme() {
        this.applyThemeMode();
        
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          if (this.settings.themeMode === 'system') {
            this.applyThemeMode();
          }
        });
      },
      // 视图模式跟随当前标签页类型，与「打开文件」逻辑完全一致：
      // 图片 → 预览（单栏）；非 Markdown 明文 → 编辑（无预览栏）；
      // 有路径的 Markdown → 会话记忆（_sessionMdViewMode）优先，其次设置中的默认视图；
      // 未命名（无路径）Markdown → 编辑（当新建文档）。
      // 类型以文件后缀为准（window.FileTypes.classifyFile），避免 tab.kind 因会话恢复等残留旧值。
      // 覆盖「打开文件 / 切换标签 / 当前标签」所有情况。
      syncViewModeToTab() {
        const tab = this.activeTab;
        // 未命名（无路径）不按类型切换，保留当前视图：newFile 已显式 setViewMode('edit')，
        // 初始化则继承 settings.defaultView。与改动前行为一致。
        if (!tab || !tab.filePath) return;
        let kind = window.FileTypes.classifyFile(tab.filePath);
        let target = 'preview';
        if (kind === 'image') target = 'preview';
        else if (kind === 'text') target = 'edit';
        else target = this._sessionMdViewMode || this.settings.defaultView || 'preview'; // md：会话记忆优先，其次默认视图
        // 视图布局由「模式 + 类型」共同决定：即使模式没变（如 md 编辑 → 文本编辑），
        // 类型变了也需重新 applyViewMode（重新决定 preview-collapsed 等），否则预览栏不会收起。
        if (target !== this.viewMode || this._lastViewKind !== kind) {
          this.viewMode = target;
          this._lastViewKind = kind;
          this.applyViewMode();
        } else {
          this._lastViewKind = kind;
        }
      },
      setViewMode(mode) {
        // 图片只支持预览模式、非 Markdown 明文只支持编辑模式：拦截切换到不支持的视图
        // 类型以文件后缀为准（window.FileTypes.classifyFile），避免 tab.kind 因会话恢复等残留旧值
        const _tab = this.activeTab;
        let _kind = _tab ? _tab.kind : 'markdown';
        if (_tab && _tab.filePath && window.FileTypes && window.FileTypes.classifyFile) {
          _kind = window.FileTypes.classifyFile(_tab.filePath);
        }
        if (_kind === 'image' && mode !== 'preview') { this.showToast(this.t('editUnsupported'), 'warning'); return; }
        if (_kind === 'text' && mode !== 'edit') { this.showToast(this.t('previewUnsupported'), 'warning'); return; }
        if (this.viewMode === mode) return;
        
        if (mode === 'preview') {
          document.getElementById('find-panel').classList.add('hidden');
        } else {
          document.getElementById('preview-find-panel').classList.add('hidden');
          this.clearPreviewHighlight();
        }
  
        // 切换前保存滚动位置 + 行锚点。
        // 关键：像素位置（scrollPos / previewScrollTop）与宽度绑定——纯预览 100% 宽与分屏 50% 宽
        // 下同一像素对应不同段落。切换会让预览重排，跨宽度用旧像素定位必然错位。
        // 因此额外算出「视口顶部对应的源码行号」作为宽度无关的锚点，切换后按该行在新宽度下定位。
        this._pendingSwitchAnchorLine = null;
        const swTab = this.activeTab;
        if (swTab) {
          // 预览在分屏/纯预览两种模式都可见，始终记录其像素位置（锚点失效时回退用）
          if (this.preview) swTab.previewScrollTop = this.preview.scrollTop;
          if (this.cm && this.viewMode === 'edit') {
            // 离开编辑（分屏）：编辑器可见，存像素 + 视口顶部源码行
            const si = this.cm.getScrollInfo();
            swTab.scrollPos = { top: si.top, left: si.left };
            try { this._pendingSwitchAnchorLine = this.cm.lineAtHeight(si.top, 'local') + 1; } catch (_) {}
          } else if (this.preview && this.viewMode === 'preview') {
            // 离开纯预览（100% 宽）：预览可见，存视口顶部源码行
            this._pendingSwitchAnchorLine = this._lineAtPreviewTop(this.preview.scrollTop);
          }
        }
  
        this.viewMode = mode;
        // 会话级 md 模式记忆：仅当当前 tab 有 filePath 且为 markdown 时记录，
        // 无路径的新建文档（kind 兜底 markdown）不记录；图片/txt 不触碰记忆，
        // 这样「其他格式按特殊展示 → 再切回 md」仍沿用之前的 md 记忆。
        if (_tab && _tab.filePath && _kind === 'markdown') {
          this._sessionMdViewMode = mode;
        }
        this.applyViewMode();
      },
      toggleViewMode() {
        this.setViewMode(this.viewMode === 'preview' ? 'edit' : 'preview');
      },
      applyViewMode() {
        const container = document.querySelector('.editor-container');
        const editorPane = document.getElementById('editor-pane');
        const previewPane = document.getElementById('preview-pane');
        const btnPreview = document.getElementById('btn-view-preview');
        const btnEdit = document.getElementById('btn-view-edit');
        const sideLeft = document.getElementById('btn-side-left');
        const sideRight = document.getElementById('btn-side-right');
  
        editorPane.style.flex = '';
        editorPane.style.width = '';
        previewPane.style.flex = '';
        previewPane.style.width = '';
  
        container.classList.remove('preview-mode', 'editor-collapsed', 'preview-collapsed', 'text-only');
        if (this.viewMode === 'preview') {
          container.classList.add('preview-mode');
        }
  
        btnPreview.classList.toggle('active', this.viewMode === 'preview');
        btnEdit.classList.toggle('active', this.viewMode === 'edit');
  
        let activeTabKind = this.activeTab ? this.activeTab.kind : 'markdown';
        if (this.activeTab && this.activeTab.filePath && window.FileTypes && window.FileTypes.classifyFile) {
          activeTabKind = window.FileTypes.classifyFile(this.activeTab.filePath);
        }
  
        // 图片只支持预览、非 md 明文只支持编辑：两个模式按钮都保留可见；
        // 切到不支持的模式时由 setViewMode 的 _kind 守卫弹提示拦截，不隐藏按钮。
        btnPreview.style.display = '';
        btnEdit.style.display = '';
  
        // 侧边收缩/展开按钮（#btn-side-left / #btn-side-right）默认隐藏，仅 Markdown 显示。
        sideLeft.classList.add('side-hidden', 'side-active');
        sideRight.classList.add('side-hidden', 'side-active');
  
        if (activeTabKind === 'text') {
          // 非 Markdown 明文：编辑器占满整行，无预览栏、无收缩/展开按钮，只支持编辑
          container.classList.add('text-only');
        } else if (activeTabKind === 'markdown' && this.viewMode === 'edit') {
          // 仅 Markdown 在编辑模式下保留侧边收缩/展开按钮（折叠编辑器或预览）；预览模式一律不显示
          sideLeft.classList.remove('side-hidden', 'side-active');
          sideRight.classList.remove('side-hidden', 'side-active');
          sideLeft.innerHTML = '&#9664;';
          sideLeft.title = this.t('collapseEditor');
          sideRight.innerHTML = '&#9654;';
          sideRight.title = this.t('collapsePreview');
        }
        // 图片：预览显示图片，但同样不需要侧边收缩/展开按钮（图片不可编辑），保持隐藏
  
        // 存句柄：大纲跳转等用户操作可在本定时器到期前 clearTimeout 取消，
        // 避免「视图模式恢复滚动」在跳转之后晚到、把编辑器/预览又拉回旧位置。
        clearTimeout(this._viewModeRestoreTimer);
        this._viewModeRestoreTimer = setTimeout(() => {
          this.cm.refresh();
          this.updateSideButtons();
          // 切换视图模式后，若虚拟滚动状态与新模式不一致则按新模式重建预览
          if (this.previewWindow && this._previewVirtual !== (this.viewMode === 'preview')) {
            this.updatePreview();
          }
          // 恢复滚动位置：用切换前算出的「源码行锚点」在新宽度下定位目标面板。
          // 行锚点与宽度无关，能正确跨越分屏(50%)↔纯预览(100%)的重排；像素值只在锚点失效时回退。
          const rTab = this.activeTab;
          if (rTab) {
            const anchor = this._pendingSwitchAnchorLine;
            this._pendingSwitchAnchorLine = null;
            if (this.viewMode === 'preview') {
              // 进入纯预览（100% 宽）：预览已重排，用锚点行在新布局下的预览位置定位
              let restored = false;
              if (anchor != null) {
                this._computedPosition();
                const list = this._previewElementList;
                if (list && anchor - 1 < list.length) {
                  const pMax = Math.max(this.preview.scrollHeight - this.preview.clientHeight, 0);
                  this.preview.scrollTop = Math.min(Math.max(0, list[anchor - 1] || 0), pMax);
                  restored = true;
                }
              }
              if (!restored) {
                const pMax = Math.max(this.preview.scrollHeight - this.preview.clientHeight, 0);
                this.preview.scrollTop = Math.min(rTab.previewScrollTop || 0, pMax);
              }
              // 进入预览后立即按预览位置校准大纲高亮（不依赖 scroll 事件触发）
              this.updateOutlineFromPreview();
            } else {
              // 切回编辑（分屏）：编辑器已 refresh，用锚点行在编辑器里的像素位置定位
              let restored = false;
              if (anchor != null && this.cm) {
                try {
                  const targetTop = this.cm.heightAtLine(Math.max(0, anchor - 1), 'local');
                  if (typeof targetTop === 'number') { this.cm.scrollTo(0, targetTop); restored = true; }
                } catch (_) {}
              }
              if (!restored) {
                const sp = rTab.scrollPos || { top: 0, left: 0 };
                this.cm.scrollTo(sp.left || 0, sp.top || 0);
              }
            }
          }
          requestAnimationFrame(() => this._resumeScroll());
          this._viewModeRestoreTimer = null;
        }, 50);
      },
      toggleCollapse(pane) {
        const container = document.querySelector('.editor-container');
        if (this.viewMode === 'preview') {
          this.setStatus(this.t('collapseHint'));
          return;
        }
  
        this._canScroll.editor = false;
        this._canScroll.preview = false;
  
        const sideLeft = document.getElementById('btn-side-left');
        const sideRight = document.getElementById('btn-side-right');
        const editorPane = document.getElementById('editor-pane');
        const previewPane = document.getElementById('preview-pane');
        const previewScrollTop = this.preview.scrollTop;
  
        editorPane.style.flex = '';
        editorPane.style.width = '';
        previewPane.style.flex = '';
        previewPane.style.width = '';
  
        if (pane === 'editor') {
          container.classList.toggle('editor-collapsed');
          const isCollapsed = container.classList.contains('editor-collapsed');
          sideLeft.innerHTML = isCollapsed ? '&#9654;' : '&#9664;';
          sideLeft.title = isCollapsed ? this.t('restoreEditor') : this.t('collapseEditor');
          sideLeft.classList.toggle('side-active', isCollapsed);
        } else {
          container.classList.toggle('preview-collapsed');
          const isCollapsed = container.classList.contains('preview-collapsed');
          sideRight.innerHTML = isCollapsed ? '&#9664;' : '&#9654;';
          sideRight.title = isCollapsed ? this.t('restorePreview') : this.t('collapsePreview');
          sideRight.classList.toggle('side-active', isCollapsed);
        }
  
        let restored = false;
        const doRefresh = () => {
          if (restored) return;
          restored = true;
          this.cm.refresh();
          this.preview.scrollTop = previewScrollTop;
          this.updateSideButtons();
          requestAnimationFrame(() => {
            this._resumeScroll();
          });
        };
        const targetPane = pane === 'editor' ? editorPane : previewPane;
        targetPane.addEventListener('transitionend', (e) => {
          if (e.propertyName === 'flex') doRefresh();
        }, { once: true });
        setTimeout(doRefresh, 280);
      },
      async openUserGuide() {
        const isEn = this.settings.language === 'en';
        const fileName = isEn ? 'guide.en.md' : 'guide.md';
        const tabName = isEn ? 'User Guide.md' : '使用说明.md';
        const existingIndex = this.tabs.findIndex(t => t.name === tabName);
        if (existingIndex !== -1) {
          this.switchTab(existingIndex);
          return;
        }
        let content = null;
        // 优先用 fetch 读取打包后的前端资源（开发/多数运行环境）
        // guide.md 位于 src/ 目录，webview 前端路径 frontendDist: ../src 可访问
        try {
          const resp = await fetch(fileName);
          if (resp.ok) {
            const text = await resp.text();
            // 防止静态服务把未知路径回退成 index.html：内容是 HTML 则视为读取失败，走兜底
            const looksLikeHtml = text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html');
            if (!looksLikeHtml) content = text;
          }
        } catch (_) { /* 落到下面的兜底读取 */ }
        // 兜底：通过 Rust 从应用资源目录读取（部分打包/WebView 环境下 fetch 受限）
        if (content === null) {
          try {
            const baseDir = (await TauriApi.resourceDir()) || '';
            const p = baseDir ? (baseDir.replace(/[/\\]$/, '') + '/' + fileName) : fileName;
            content = await TauriApi.readFile({ path: p });
          } catch (e) {
            this.reportError('guide', { error: e });
            return;
          }
          // read_file 也可能返回 HTML（某些资源目录解析不符预期），同样排除
          if (content && (content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html'))) {
            content = null;
          }
        }
        if (content === null) {
          this.reportError('guide');
          return;
        }
        this.addTab(tabName, content, null);
        this.activeTab.savedContent = content;
        this.activeTab.isGuide = true;
        this.updateTabDisplay();
        this.setStatus(isEn ? this.t('openedGuideEn') : this.t('openedGuide'));
      },
      async _openBundledFile(href, content, filePath = null) {
        const name = filePath ? filePath.split(/[/\\]/).pop() : href.split(/[/\\]/).pop();
        // 去重：有真实路径按路径，无路径（打包资源，如从「使用说明」打开的 demo.md）按名称，
        // 避免同一资源重复打开多个标签页
        const existingIndex = filePath
          ? this.tabs.findIndex(t => t.filePath === filePath)
          : this.tabs.findIndex(t => t.name === name);
        if (existingIndex !== -1) {
          this.switchTab(existingIndex);
          return;
        }
        this.addTab(name, content, filePath);
        this.activeTab.savedContent = content;
        // 标记为打包资源 tab：processImages 仅对这类 tab 启用 read_bundled_image_as_base64
        // 回退（dev 模式 filePath 目录可能读不到图片），普通本地文档不回退，避免误加载打包资源。
        this.activeTab.isBundled = true;
        this.updateTabDisplay();
      },
      // 还原被渲染器编码的链接 URL（%5C→\、%2F→/ 等），得到可读取的真实文件路径。
      // 兼容 Windows 盘符路径（D:\ 或 D:/）与 macOS/Linux 绝对路径（/...），
      // 相对路径原样返回，交由 resolveDocPath 处理。
      normalizeLinkHref(href) {
        let p = href;
        try { p = decodeURIComponent(href); } catch (_) { p = href; }
        return p;
      },
  };

  const api = { mixin };
  window.TMTheme = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
