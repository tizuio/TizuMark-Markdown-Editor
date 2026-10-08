// P2-1 PreviewController（ADR-3 Strangler facade）
//
// 把 updatePreview 的编排逻辑 + N7 表遗留的 5 个虚拟窗口方法收编到单一 facade，
// 使上帝对象 app.js 的预览渲染职责有明确的归属边界。迁移期 app.js 保留薄委托
// （this.updatePreview / this._focusPreviewToLine / ...），全迁完再删（见 P2-1 计划）。
//
// 设计要点：
//  - 构造函数持有 app 实例引用（this.app），所有 app 侧字段/方法经 this.app 访问；
//  - 控制器自有的方法（_focusPreviewToLine / _renderPreviewWindowBlock /
//    _updateVirtualScrollMetrics / _syncPreviewVirtualScroll / _buildWindowLineTops）
//    经 this 访问，互相调用也走 this；
//  - 真·全局（PreviewWindow / UnifiedRenderer / TauriApi / PreviewPost / CodeBlock /
//    ImageProcessor / RenderPost）沿用 window 全局，不在此重复声明；
//  - hljs 例外：必须显式 `window.hljs`（裸 hljs 在非浏览器环境 ReferenceError，且参数对象
//    在 RenderPost stage 的 try/catch 之外求值，包不住）；
//  - app.js 顶层 const 的预览常量（脚本作用域、跨脚本不可见）在此复制一份，
//    与 app.js 保持同源同值（如后续调整需同步两侧）。
//
// 整文件包在 IIFE 内：经典 <script> 的顶层 const/class 会进入「全局词法环境」且跨脚本共享，
// 若与 app.js 的同名 const 撞车会触发重复声明 SyntaxError（拼接测试 / 生产均会崩）。
// 用函数作用域隔离，只经 window.PreviewController 暴露，跨独立脚本 / 拼接脚本 / harness eval 都不冲突。

(function () {
  // 预览常量：与 src/app.js 顶部保持一致（脚本作用域不可跨脚本共享，故此处复制）。
  const MAX_PREVIEW_LINES = 5000;
  const MAX_PREVIEW_CHARS = 4 * 1024 * 1024;
  const HEAD_RENDER_CHAR_CAP = 1.5 * 1024 * 1024;
  const PREVIEW_WINDOW_LINES = 1200;  // 窗口源码行数上限
  const PREVIEW_WINDOW_LEAD = 200;    // 焦点行前预留行数（让焦点不至于贴顶）

  class PreviewController {
    constructor(app) {
      this.app = app;
    }

    // 文档化 facade API：render() 即原 updatePreview；setDark/refresh 供后续批次调用。
    setDark(dark) {
      this.app.isDark = !!dark;
    }

    refresh() {
      return this.render();
    }

    async render(suppressLoading = false) {
      // 防御：若被勾选抑制标记触发（应已被 debounceUpdatePreview 拦截），直接轻量返回，杜绝全量重渲染
      if (this.app._suppressNextPreviewRerender) {
        this.app._suppressNextPreviewRerender = false;
        this.app.updateWordCount();
        this.app.updateOutline();
        return;
      }
    const gen = ++this.app._renderGeneration;
    let needLoad = false;
    const _tab = this.app.activeTab;
    const _tabKind = _tab ? _tab.kind : 'markdown';
    // 图片：应用内预览面板显示。
    // 注意：Tauri v2 的 convertFileSrc 返回 asset://localhost/... ，但本应用 CSP 的 img-src
    // 未放行 asset: 协议，直接用会被 WebView 拦截导致「图片打不开」。因此统一走
    // fetchImageAsBase64 拿 base64 data URI（与 markdown 内嵌图片一致，data: 已被 CSP 放行）。
    if (_tabKind === 'image') {
      this.app.preview.style.position = '';
      this.app.preview.style.padding = '';
      const imgPath = _tab.filePath || '';
      const alt = this.app.escapeAttr(_tab.name || '');
      if (!imgPath) {
        this.app.preview.innerHTML = '<div class="image-error">' + this.app.escapeHtml(this.app.t('formatUnsupported')) + '</div>';
        if (this.app._resumeScroll) this.app._resumeScroll();
        return;
      }
      const lower = imgPath.toLowerCase();
      const mime = lower.endsWith('.gif') ? 'image/gif'
        : lower.endsWith('.svg') ? 'image/svg+xml'
        : lower.endsWith('.webp') ? 'image/webp'
        : (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) ? 'image/jpeg'
        : 'image/png';
      const fallbackSrc = (typeof TauriApi !== 'undefined' && TauriApi.convertFileSrc) ? TauriApi.convertFileSrc(imgPath) : imgPath;
      try {
        if (typeof TauriApi !== 'undefined' && typeof TauriApi.fetchImageAsBase64 === 'function') {
          const base64 = await TauriApi.fetchImageAsBase64({ url: imgPath });
          const dataUri = 'data:' + mime + ';base64,' + base64;
          this.app.preview.innerHTML = '<img class="image-viewer" src="' + this.app.escapeAttr(dataUri) + '" alt="' + alt + '">';
        } else {
          this.app.preview.innerHTML = '<img class="image-viewer" src="' + this.app.escapeAttr(fallbackSrc) + '" alt="' + alt + '">';
        }
      } catch (e) {
        console.warn('[preview] 图片加载失败：', imgPath, e);
        this.app.preview.innerHTML = '<img class="image-viewer" src="' + this.app.escapeAttr(fallbackSrc) + '" alt="' + alt + '">';
      }
      if (this.app._resumeScroll) this.app._resumeScroll();
      return;
    }
    // 明文：按原始文本显示（不做 Markdown 渲染）
    if (_tabKind === 'text') {
      const content = this.app.cm.getValue();
      this.app.preview.style.position = '';
      this.app.preview.style.padding = '';
      this.app.preview.innerHTML = '<pre class="plaintext-view">' + this.app.escapeHtml(content) + '</pre>';
      if (this.app._resumeScroll) this.app._resumeScroll();
      return;
    }
    try {
      const content = this.app.cm.getValue();
        const totalLines = content.split('\n').length;
        const isLarge = content.length > MAX_PREVIEW_CHARS || totalLines > MAX_PREVIEW_LINES;

        // 大文档重渲染耗时明显：在加载层可见时由本函数接管其生命周期（引用计数），
        // 仅在「显式打开/切换/视图切换/大纲跳转」等非滚动、非打字触发的重渲染时显示 loading；
        // 滚动驱动（_previewScrollDriven）与打字（suppressLoading）不显示，避免闪烁
        needLoad = isLarge && !suppressLoading && !this.app._previewScrollDriven;
        if (needLoad) this.app._beginPaneLoad();

        // 超大文档：预览只渲染「围绕焦点的一段源码」（滑动窗口），避免整篇同步解析/渲染卡死主线程，
        // 同时保证任意位置（大纲跳转 / 滚动）都可在预览中落点。
        let renderContent = content;
        this.app._previewTruncated = false;
        if (isLarge) {
          const focus = Number.isFinite(this.app._previewFocusLine) ? this.app._previewFocusLine : 0;
          const win = PreviewWindow.computePreviewWindow(content, focus, {
            maxLines: MAX_PREVIEW_LINES,
            lead: PREVIEW_WINDOW_LEAD,
            windowLines: PREVIEW_WINDOW_LINES,
          });
          this.app.previewWindow = win;
          this.app._previewSliceOffset = win.start;
          this.app._previewVirtual = (this.app.viewMode === 'preview');
          const slice = content.split('\n').slice(win.start, win.end).join('\n');
          renderContent = slice.length > HEAD_RENDER_CHAR_CAP ? slice.slice(0, HEAD_RENDER_CHAR_CAP) : slice;
          this.app._previewTruncated = true;
        } else {
          this.app.previewWindow = null;
          this.app._previewSliceOffset = 0;
          this.app._previewVirtual = false;
        }


        const hasToc = content.includes('[TOC]') || content.includes('[toc]');
        let tocHtml = '';
        if (hasToc) {
          tocHtml = await TauriApi.generateToc({ content });
          if (gen !== this.app._renderGeneration) return;
        }

        // 仅在 loading 遮罩可见时，让出主线程两帧确保遮罩先绘制（避免大文档同步渲染期间“无 loading 白屏”）；普通打字刷新不额外延迟
        const loadingEl = document.getElementById('pane-loading');
        if (loadingEl && !loadingEl.classList.contains('hidden')) {
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        }

        // P0-0d 产物韧性：unified-bundle.js 缺失/加载失败时，这里原本是裸 ReferenceError
        // （"UnifiedRenderer is not defined"），对使用者毫无指引。改抛可操作错误，
        // 由 P0-1 的全局兜底渲染成错误条。
        if (typeof UnifiedRenderer === 'undefined' || !UnifiedRenderer || typeof UnifiedRenderer.renderMarkdown !== 'function') {
          throw new Error('渲染器未构建或加载失败（src/lib/unified-bundle.js），请运行 npm run build:renderer');
        }
        const html = UnifiedRenderer.renderMarkdown(renderContent, { softBreaks: this.app.settings.softBreaks, tabSize: this.app.settings.tabSize, extendedSyntax: this.app.settings.extendedSyntax });
        if (gen !== this.app._renderGeneration) return;

        let finalHtml = html;
        if (tocHtml) {
          finalHtml = finalHtml.replace(/<p[^>]*data-source-line="(\d+)"[^>]*>\[TOC\]<\/p>/gi, '<div class="toc-wrapper" data-source-line="$1">' + tocHtml + '</div>');
        }

        // 内嵌 base64 图片改为按内容缓存的 Blob URL，避免每次重渲染重复解码（大文档多图时是关键性能点）
        finalHtml = finalHtml.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, (m) => this.app.getCachedImageURL(m));

        // 滑动窗口：渲染的是切片后的源码，需把 data-source-line 还原为绝对行号（与编辑区一致），
        // 否则大纲锚点 / 滚动定位会错位
        if (this.app.previewWindow && this.app._previewSliceOffset > 0) {
          const off = this.app._previewSliceOffset;
          finalHtml = finalHtml.replace(/data-source-line="(\d+)"/g, (m, n) => `data-source-line="${parseInt(n, 10) + off}"`);
        }

        this.app._canScroll.editor = false;
        this.app._canScroll.preview = false;
        if (this.app._previewVirtual && this.app.previewWindow) {
          this._renderPreviewWindowBlock(finalHtml, this.app.previewWindow, content);
        } else {
          this.app.preview.style.position = '';
          this.app.preview.style.padding = '';
          this.app.preview.innerHTML = finalHtml;
        }

        // 超大文档：顶部全局横幅提示（不塞进预览内容，避免随滚动/重渲染消失）
        if (this.app._previewTruncated) {
          const totalLines = content.split('\n').length;
          const key = this.app.activeTab ? (this.app.activeTab.filePath || ('untitled:' + this.app.tabs.indexOf(this.app.activeTab))) : 'none';
          this.app.showLargeFileNotice(key, totalLines, content.length);
          this.app._previewTruncated = false;
        } else {
          this.app.hideLargeFileNotice();
        }

        // 后处理走 RenderPost 共享管线（modules/render-post.js）——与所见即所得遮罩
        // **同 stage 同顺序**，只允许编排时序差异（阅读=整篇单遍；遮罩=单块+DOM 落定后异步补跑）。
        // 具体契约（幂等/故障隔离/条件唯一来源）见 render-post.js 文件头。
        RenderPost.normalizeDetails(this.app.preview);
        // 任务列表 checkbox：remark-gfm 默认输出 disabled 不可交互，渲染后移除 disabled 使其可点击
        RenderPost.enableCheckboxes(this.app.preview);

        try { await this.app.processImages(); } catch (e) { console.warn('[preview] Images error:', e); }
        if (gen !== this.app._renderGeneration) { this.app._resumeScroll(); return; }
        const postOpts = {
          t: (k) => this.app.t(k),
          isDark: this.app.isDark,
          escapeHtml: (s) => this.app.escapeHtml(s),
          escapeAttr: (s) => this.app.escapeAttr(s),
          headingToId: (s) => this.app.headingToId(s),
          mermaidCache: this.app._mermaidCache,
        };
        RenderPost.processEmoji(this.app.preview);
        RenderPost.processMath(this.app.preview);
        RenderPost.processAbbreviations(this.app.preview, postOpts);
        try { this.app.processFootnotes(); } catch (e) { console.warn('[preview] Footnotes error:', e); }
        RenderPost.processHeadings(this.app.preview, postOpts);
        try { await RenderPost.runMermaid(this.app.preview, postOpts); } catch (e) { console.warn('[preview] Mermaid error:', e); }
        if (gen !== this.app._renderGeneration) { this.app._resumeScroll(); return; }
        RenderPost.addCopyButtons(this.app.preview, postOpts);

        // 代码高亮 + 行号（RenderPost 共享 stage，底层 CodeBlock.processCodeBlocks）。
        // ⚠️ 必须显式 window.hljs：裸 hljs 在非浏览器环境（jsdom）是 ReferenceError，
        // 且参数对象在 stage 的 try/catch 之外求值——旧 try/catch 包不住（2026-10-11 实测）。
        RenderPost.processCodeBlocks(this.app.preview, {
          hljs: (typeof window !== 'undefined' ? window.hljs : undefined),
          cache: this.app._hljsCache,
          lineNumbers: this.app.preview.classList.contains('code-line-numbers'),
        });

        // 代码块按需滚动：RenderPost 共享 stage（条件唯一来源，与所见即所得同一函数）。
        // CSS 默认 overflow-y:hidden（避免 Windows always-show 滚动条轨道在短代码块上出现），
        // 仅真溢出才显式 auto；codeScroll=false 时跳过，由 CSS(.code-no-scroll) 撑开高度。
        RenderPost.applyCodeScrollOverflow(this.app.preview, { codeScroll: this.app.settings && this.app.settings.codeScroll });

        // 等待浏览器完成布局后再测量元素位置
        await new Promise(r => requestAnimationFrame(r));
        if (gen !== this.app._renderGeneration) { this.app._resumeScroll(); return; }

        // 滑动窗口模式：构建「源码行 → 预览像素」映射，并把预览滚动定位到焦点行；
        // 不走整篇滚动同步（预览只含窗口片段，1:1 映射无意义）
        if (this.app.previewWindow) {
          this._buildWindowLineTops();
          if (this.app._previewVirtual) this._updateVirtualScrollMetrics();
          // 滚动驱动的重渲染保留当前 scrollTop（内容按 ℓ*avg 线性连续，无需回弹）；
          // 仅大纲跳转 / 打开文件等显式跳转才贴顶定位
          if (!this.app._previewScrollDriven) this._focusPreviewToLine(this.app._previewFocusLine);
          this.app._previewScrollDriven = false;
          requestAnimationFrame(() => {
            if (gen === this.app._renderGeneration) this.app._resumeScroll();
          });
          return;
        }

        // 重建滚动同步数据（blocks + 预览子元素）
        this.app.rebuildScrollSync();

        // 恢复预览滚动位置（逐行密集插值）；预览发起的编辑（复选框勾选）已保存位置，跳过以免被重算覆盖
        if (this.app.settings.scrollSync && this.app._editorElementList && this.app._editorElementList.length > 1) {
          const cmInfo = this.app.cm.getScrollInfo();
          const top = cmInfo.top;

          if (top <= 0.5) {
            this.app.preview.scrollTop = 0;
          } else if (top + cmInfo.clientHeight >= cmInfo.height - 0.5) {
            this.app.preview.scrollTop = Math.max(0, this.app.preview.scrollHeight - this.app.preview.clientHeight);
          } else {
            let idx = -1;
            for (let i = 0; i < this.app._editorElementList.length; i++) {
              if (top < this.app._editorElementList[i]) {
                idx = i - 1;
                break;
              }
            }
            if (idx < 0) idx = 0;
            if (idx < this.app._editorElementList.length - 1) {
              const editorStart = this.app._editorElementList[idx];
              const editorEnd = this.app._editorElementList[idx + 1];
              const previewStart = this.app._previewElementList[idx];
              const previewEnd = this.app._previewElementList[idx + 1];
              if (editorEnd > editorStart) {
                const ratio = (top - editorStart) / (editorEnd - editorStart);
                this.app.preview.scrollTop = previewStart + ratio * (previewEnd - previewStart);
              }
            }
          }
        } else {
          const maxScroll = Math.max(this.app.preview.scrollHeight - this.app.preview.clientHeight, 0);
          if (this.app.preview.scrollTop > maxScroll) this.app.preview.scrollTop = maxScroll;
        }
        requestAnimationFrame(() => {
          if (gen === this.app._renderGeneration) this.app._resumeScroll();
        });
      } catch (error) {
        if (gen !== this.app._renderGeneration) return;
        this.app._resumeScroll();
        const msg = String(error).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        this.app.preview.innerHTML = `<p style="color: red;">预览错误: ${msg}</p>`;
      } finally {
        if (needLoad) this.app._endPaneLoad();
      }
    }

    // 构建窗口内 [源码行(1-based), 相对预览内容顶部像素] 的有序映射
    _buildWindowLineTops() {
      const pRect = this.app.preview.getBoundingClientRect();
      const arr = [];
      this.app.preview.querySelectorAll('[data-source-line]').forEach((el) => {
        const ln = parseInt(el.dataset.sourceLine, 10);
        if (isNaN(ln)) return;
        const rect = el.getBoundingClientRect();
        arr.push([ln, rect.top - pRect.top + this.app.preview.scrollTop]);
      });
      arr.sort((a, b) => a[0] - b[0]);
      this.app._windowLineTops = arr;
    }

    // 把预览滚动定位到指定源码行（0-based），使其靠近顶部并保留上方上下文
    _focusPreviewToLine(line) {
      if (!Number.isFinite(line)) line = 0; // N22 ③：读取点归一化，NaN/undefined 焦点不污染定位
      if (!this.app._windowLineTops || !this.app._windowLineTops.length) return;
      const target = line + 1;
      let bestTop = this.app._windowLineTops[0][1];
      let bestLine = this.app._windowLineTops[0][0];
      for (const [ln, top] of this.app._windowLineTops) {
        if (ln <= target && ln > bestLine) { bestLine = ln; bestTop = top; }
      }
      const maxScroll = Math.max(this.app.preview.scrollHeight - this.app.preview.clientHeight, 0);
      this.app.preview.scrollTop = Math.max(0, Math.min(bestTop - 24, maxScroll));
    }

    // 纯预览模式大文档：把窗口片段渲染到「撑满全文高度的占位 + 绝对定位块」中，
    // 使原生滚动条代表整篇文档，用户可平滑滚动 / 拖到任意位置查看全文（虚拟滚动）。
    // 平均行高恒定（首次渲染后校准一次），故 scrollTop ↔ 源码行比例精确，与 avg 估算无关。
    _renderPreviewWindowBlock(finalHtml, win, content) {
      const totalLines = content.split('\n').length;
      const avg = this.app._avgLineHeight || 22;
      const estTotal = totalLines * avg;
      const blockTop = win.start * avg;
      this.app.preview.style.position = 'relative';
      this.app.preview.style.padding = '0';
      this.app.preview.innerHTML =
        `<div class="pv-spacer" style="position:absolute;top:0;left:0;width:100%;height:${estTotal}px;"></div>` +
        `<div class="pv-block" style="position:absolute;top:${blockTop}px;left:0;right:0;padding:16px 24px;box-sizing:border-box;">${finalHtml}</div>`;
    }

    // 首次渲染后根据已渲染窗口的真实行高校准平均行高（仅一次，之后恒定），
    // 并据此重设占位高度（此时通常位于头部，scrollTop≈0，无视觉跳动）。
    _updateVirtualScrollMetrics() {
      if (!this.app._previewVirtual || !this.app.previewWindow) return;
      if (this.app._avgLineHeight == null) {
        const arr = this.app._windowLineTops;
        if (arr && arr.length >= 2) {
          const first = arr[0], last = arr[arr.length - 1];
          const dh = last[1] - first[1];
          const dl = last[0] - first[0];
          if (dl > 0) {
            const avg = dh / dl;
            if (avg > 1 && avg < 500) this.app._avgLineHeight = avg;
          }
        }
        if (this.app._avgLineHeight == null) this.app._avgLineHeight = 22;
        const spacer = this.app.preview.querySelector('.pv-spacer');
        if (spacer) spacer.style.height = (this.app.cm.lineCount() * this.app._avgLineHeight) + 'px';
      }
    }

    // 纯预览模式虚拟滚动：预览滚动时按 scrollTop 估算当前视口顶行（锚定行），
    // 若超出当前窗口缓冲区则 debounce 重渲染相邻窗口（拖到任意位置均渲染对应内容）。
    // 重渲染使用最新 scrollTop 反推锚定行，避免滚动期间位置过期导致抖动。
    _syncPreviewVirtualScroll() {
      if (!this.app._previewVirtual || !this.app.previewWindow) return;
      const win = this.app.previewWindow;
      const avg = this.app._avgLineHeight || 22;
      const total = this.app.cm.lineCount();
      const anchor = Math.max(0, Math.min(total - 1, Math.round(this.app.preview.scrollTop / avg)));
      if (anchor >= win.start + PREVIEW_WINDOW_LEAD && anchor <= win.end - PREVIEW_WINDOW_LEAD) return;
      if (this.app._virtualRenderTimer) return;
      this.app._virtualRenderTimer = setTimeout(() => {
        this.app._virtualRenderTimer = null;
        const avg2 = this.app._avgLineHeight || 22;
        const a2 = Math.max(0, Math.min(this.app.cm.lineCount() - 1, Math.round(this.app.preview.scrollTop / avg2)));
        this.app._previewFocusLine = a2;
        this.app._previewScrollDriven = true; // 滚动驱动：重渲染后保留当前 scrollTop，避免回弹
        this.app.updatePreview();
      }, 120);
    }
  }

  // 双导出（N29 互斥式）：浏览器挂 window.PreviewController；node（契约/单元）走 module.exports。
  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    window.PreviewController = PreviewController;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PreviewController };
  }
})();
