// 预览渲染与滚动同步、虚拟滚动
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';

  const mixin = {
      debounceUpdatePreview() {
        // 任务列表勾选来源：预览 DOM 已就地同步，跳过全量重渲染（不防抖，立即轻量刷新字数/大纲）
        if (this._suppressNextPreviewRerender) {
          this._suppressNextPreviewRerender = false;
          this.updateWordCount();
          this.updateOutline();
          return;
        }
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.updatePreview(true);
          this.updateWordCount();
          this.updateOutline();
        }, 300);
      },
      // 按空行切分为逻辑块，跟踪围栏代码块（内部不切分）
      parseBlocks(content) {
        const lines = content.split('\n');
        const blocks = [];
        let inFence = false;
        let fenceChar = '';
        let fenceCount = 0;
        let blockStart = -1;
  
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
  
          if (!inFence && (trimmed.startsWith('```') || trimmed.startsWith('~~~'))) {
            const fc = trimmed[0];
            const match = trimmed.match(new RegExp('^\\' + fc + '{3,}'));
            if (match) {
              inFence = true;
              fenceChar = fc;
              fenceCount = match[0].length;
              if (blockStart >= 0) {
                blocks.push({ startLine: blockStart, endLine: i - 1 });
                blockStart = -1;
              }
              blockStart = i;
              continue;
            }
          }
  
          if (inFence) {
            if (trimmed.startsWith(fenceChar)) {
              const match = trimmed.match(new RegExp('^\\' + fenceChar + '{' + fenceCount + ',}'));
              if (match && trimmed.replace(match[0], '').trim() === '') {
                blocks.push({ startLine: blockStart, endLine: i });
                blockStart = -1;
                inFence = false;
              }
            }
            continue;
          }
  
          if (trimmed === '') {
            if (blockStart >= 0) {
              blocks.push({ startLine: blockStart, endLine: i - 1 });
              blockStart = -1;
            }
          } else if (blockStart < 0) {
            blockStart = i;
          }
        }
  
        if (blockStart >= 0) {
          blocks.push({ startLine: blockStart, endLine: lines.length - 1 });
        }
  
        return blocks;
      },
      // 遍历预览 DOM，收集所有块级渲染元素（用于比例映射）
      collectBlockElements(root) {
        const blockTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'HR', 'DETAILS', 'DIV']);
        const result = [];
        const walk = (el) => {
          if (!el || !el.children) return;
          for (const child of el.children) {
            if (blockTags.has(child.tagName)) {
              result.push(child);
            } else if (child.tagName === 'IMG') {
              result.push(child);
            } else {
              walk(child);
            }
          }
        };
        walk(root);
        return result;
      },
      // 去掉 markdown 语法，提取用于匹配的纯文本关键词
      cleanMarkdownForSearch(text) {
        return text
          .replace(/^#{1,6}\s*/, '')
          .replace(/^[-*+]\s+/, '')
          .replace(/^>\s*/, '')
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/\*(.+?)\*/g, '$1')
          .replace(/~~(.+?)~~/g, '$1')
          .replace(/`(.+?)`/g, '$1')
          .replace(/\[(.+?)\]\(.+?\)/g, '$1')
          .replace(/!\[(.+?)\]\(.+?\)/g, '$1')
          .replace(/^\d+\.\s+/, '')
          .trim();
      },
      // 从预览元素获取对应的源文件行号（通过 unified 嵌入的 data-source-line）
      _getSourceLine(el) {
        if (el.dataset && el.dataset.sourceLine) {
          return parseInt(el.dataset.sourceLine, 10);
        }
        const inner = el.querySelector('[data-source-line]');
        if (inner) {
          return parseInt(inner.dataset.sourceLine, 10);
        }
        return null;
      },
      // 构建逐行密集位置映射（纯线性插值，无速度限制）
      // 每个编辑器行都有精确的 previewTop 插值
      // 无缓存：每次调用全量重建，与 legacy-master 行为一致（用户报告精准匹配）。
      // 3dac68c 引入的 dirty 缓存 + 布局指纹会造成某些场景下位置表过期（编辑器布局变化但
      // preview scrollHeight 未变时缓存命中 → 用旧表插值），此版本回退到 legacy 行为。
      _computedPosition() {
        const allElements = this.preview.querySelectorAll('[data-source-line]');
        const anchors = [];
        const seenLines = new Set();
  
        for (const el of allElements) {
          // 跳过脚注区域内的元素（source line 在文档中部但渲染在预览最底部）
          if (el.closest('.footnotes')) continue;
  
          const sourceLine = parseInt(el.dataset.sourceLine, 10);
          if (isNaN(sourceLine)) continue;
          if (seenLines.has(sourceLine)) continue;
          seenLines.add(sourceLine);
  
          const editorTop = this.cm.heightAtLine(Math.max(0, sourceLine - 1), 'local');
          const previewTop = this._getOffsetTop(el);
          if (typeof editorTop !== 'number' || typeof previewTop !== 'number') continue;
  
          anchors.push({ line: sourceLine, editorTop, previewTop });
        }
  
        if (anchors.length < 2) {
          this._editorElementList = null;
          this._previewElementList = null;
          return;
        }
  
        anchors.sort((a, b) => a.line - b.line);
  
        // 过滤非单调锚点（只检查 editorTop）
        const clean = [anchors[0]];
        for (let i = 1; i < anchors.length; i++) {
          if (anchors[i].editorTop > clean[clean.length - 1].editorTop) {
            clean.push(anchors[i]);
          }
        }
  
        if (clean.length < 2) {
          this._editorElementList = null;
          this._previewElementList = null;
          return;
        }
  
        // 逐行构建密集数组
        const totalLines = this.cm.lineCount();
        const editorList = new Array(totalLines);
        const rawPreviewList = new Array(totalLines);
        let anchorIdx = 0;
  
        for (let line = 0; line < totalLines; line++) {
          editorList[line] = this.cm.heightAtLine(line, 'local');
          const sourceLine = line + 1;
  
          while (anchorIdx + 1 < clean.length && clean[anchorIdx + 1].line <= sourceLine) {
            anchorIdx++;
          }
  
          if (anchorIdx >= clean.length - 1) {
            const last = clean[clean.length - 1];
            rawPreviewList[line] = last.previewTop + Math.max(0, sourceLine - last.line) * 20;
          } else {
            const a1 = clean[anchorIdx];
            const a2 = clean[anchorIdx + 1];
            const lineGap = a2.line - a1.line;
            if (lineGap <= 0) {
              rawPreviewList[line] = a1.previewTop;
            } else {
              rawPreviewList[line] = a1.previewTop + (sourceLine - a1.line) / lineGap * (a2.previewTop - a1.previewTop);
            }
          }
        }
  
        this._editorElementList = editorList;
        this._previewElementList = rawPreviewList;
      },
      // 返回预览视口顶部对应的源码行号（1-based）；测量失败返回 null。
      // 用于切换模式时把「预览像素位置」转成宽度无关的行锚点。
      _lineAtPreviewTop(pvTop) {
        this._computedPosition();
        const list = this._previewElementList;
        if (!list || list.length < 2) return null;
        // 二分找 previewList 中 <= pvTop 的最大行索引
        let lo = 0, hi = list.length - 1, ans = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid] <= pvTop) { ans = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        return ans + 1; // 1-based 源码行
      },
      // 根据 unified 渲染结果重建滚动同步数据（仅在内容变化时调用）
      rebuildScrollSync() {
        const content = this.cm.getValue();
        const totalLines = content.split('\n').length;
  
        // 构建平行位置数组（使用 data-source-line）
        this._computedPosition();
  
        // 生成 _linePositions（兼容 updatePreview 滚动恢复）
        const allElements = Array.from(this.preview.querySelectorAll('[data-source-line]'));
        const previewRect = this.preview.getBoundingClientRect();
        const st = this.preview.scrollTop;
        const sh = this.preview.scrollHeight || 1;
        const positions = [{ line: 0, fraction: 0 }];
        const seen = new Set();
  
        // 超大预览：元素过多时只采样测量，未测行靠行号线性插值，避免全量 getBoundingClientRect 重排卡顿
        const MAX_SYNC_SAMPLES = 2000;
        const step = Math.max(1, Math.ceil(allElements.length / MAX_SYNC_SAMPLES));
  
        for (let i = 0; i < allElements.length; i++) {
          if (step > 1 && i % step !== 0 && i !== allElements.length - 1) continue;
          const child = allElements[i];
          const sourceLine = parseInt(child.dataset.sourceLine, 10);
          if (isNaN(sourceLine)) continue;
          if (seen.has(sourceLine)) continue;
          seen.add(sourceLine);
  
          const rect = child.getBoundingClientRect();
          const elTop = rect.top - previewRect.top + st;
          const elBottom = elTop + child.offsetHeight;
  
          positions.push({ line: sourceLine, fraction: Math.min(Math.max(elTop / sh, 0), 1) });
          positions.push({ line: sourceLine + 1, fraction: Math.min(Math.max(elBottom / sh, 0), 1) });
        }
  
        positions.push({ line: totalLines - 1, fraction: 1 });
        positions.sort((a, b) => a.line - b.line);
  
        const deduped = [];
        let lastLine = -1;
        for (const p of positions) {
          if (p.line !== lastLine) {
            deduped.push(p);
            lastLine = p.line;
          }
        }
        if (deduped.length === 0 || deduped[0].line > 0) deduped.unshift({ line: 0, fraction: 0 });
        if (deduped[deduped.length - 1].line < totalLines - 1) deduped.push({ line: totalLines - 1, fraction: 1 });
        this._linePositions = deduped;
      },
      // demo 的 getHeightToTop：计算元素到容器顶部的距离（offsetTop 遍历 offsetParent）
      _getOffsetTop(el) {
        let top = el.offsetTop;
        let parent = el.offsetParent;
        while (parent && parent !== this.preview) {
          top += parent.offsetTop;
          parent = parent.offsetParent;
        }
        return top;
      },
      // demo 风格：节流函数（首次立即执行，后续在 delay 内只保存最后一次调用）
      _throttleScroll(fn, delay) {
        if (this._scrollThrottleTimer) {
          this._scrollThrottlePending = fn;
          return;
        }
        fn();
        this._scrollThrottleTimer = setTimeout(() => {
          this._scrollThrottleTimer = null;
          if (this._scrollThrottlePending) {
            const pending = this._scrollThrottlePending;
            this._scrollThrottlePending = null;
            this._throttleScroll(pending, delay);
          }
        }, delay);
      },
      // demo 风格：防抖函数（每次调用重置计时器）
      _debounceScroll(fn, delay) {
        clearTimeout(this._scrollDebounceTimer);
        this._scrollDebounceTimer = setTimeout(fn, delay);
      },
      // demo 风格：恢复滚动（重置双标志锁）
      _resumeScroll() {
        this._canScroll.editor = true;
        this._canScroll.preview = true;
      },
      // 编辑器 → 预览同步（逐行密集插值）
      _syncEditorToPreview(editorTop) {
        if (this.previewWindow) { this._syncEditorToPreviewWindow(); return; }
        this._computedPosition();
  
        const editorList = this._editorElementList;
        const previewList = this._previewElementList;
        if (!editorList || editorList.length < 2) return;
  
        const { scrollHeight, clientHeight } = this.preview;
        const cmInfo = this.cm.getScrollInfo();
        const top = (editorTop != null) ? editorTop : cmInfo.top;
  
        if (top <= 0.5) { this.preview.scrollTop = 0; return; }
        if (top + clientHeight >= cmInfo.height - 0.5) {
          this.preview.scrollTop = Math.max(0, scrollHeight - clientHeight);
          return;
        }
  
        let lo = 0, hi = editorList.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (editorList[mid] <= top) lo = mid + 1;
          else hi = mid;
        }
        let idx = lo - 1;
        if (idx < 0) { this.preview.scrollTop = 0; return; }
        if (idx >= editorList.length - 1) {
          this.preview.scrollTop = Math.max(0, scrollHeight - clientHeight);
          return;
        }
  
        const editorStart = editorList[idx];
        const editorEnd = editorList[idx + 1];
        const previewStart = previewList[idx];
        const previewEnd = previewList[idx + 1];
  
        if (editorEnd <= editorStart || previewEnd < 0 || previewStart < 0) {
          this.preview.scrollTop = previewStart;
          return;
        }
  
        const targetScrollTop = previewStart + (top - editorStart) / (editorEnd - editorStart) * (previewEnd - previewStart);
        this.preview.scrollTop = Math.max(0, Math.min(targetScrollTop, scrollHeight - clientHeight));
      },
      // 预览 → 编辑器同步（逐行密集插值）
      // previewTop 可选：指定预览滚动位置作为来源；省略则读当前预览 scrollTop。
      // 切换模式时用它传入「已保存的预览位置」，避免依赖此刻可能不可靠的实时值。
      _syncPreviewToEditor(previewTop) {
        if (this.previewWindow) { this._syncPreviewToEditorWindow(); return; }
        this._computedPosition();
  
        const previewList = this._previewElementList;
        const editorList = this._editorElementList;
        if (!previewList || previewList.length < 2) return;
  
        const { scrollHeight, clientHeight } = this.preview;
        const cmInfo = this.cm.getScrollInfo();
        const pvTop = (previewTop != null) ? previewTop : this.preview.scrollTop;
  
        if (pvTop <= 0.5) { this.cm.scrollTo(0, 0); return; }
        if (pvTop + clientHeight >= scrollHeight - 0.5) {
          this.cm.scrollTo(0, Math.max(0, cmInfo.height - cmInfo.clientHeight));
          return;
        }
  
        let lo = 0, hi = previewList.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (previewList[mid] <= pvTop) lo = mid + 1;
          else hi = mid;
        }
        let idx = lo - 1;
        if (idx < 0) { this.cm.scrollTo(0, 0); return; }
        if (idx >= previewList.length - 1) {
          this.cm.scrollTo(0, Math.max(0, cmInfo.height - cmInfo.clientHeight));
          return;
        }
  
        const previewStart = previewList[idx];
        const previewEnd = previewList[idx + 1];
        const editorStart = editorList[idx];
        const editorEnd = editorList[idx + 1];
  
        if (previewEnd <= previewStart || editorEnd < 0 || editorStart < 0) {
          this.cm.scrollTo(0, editorStart);
          return;
        }
  
        const targetEditorTop = editorStart + (pvTop - previewStart) / (previewEnd - previewStart) * (editorEnd - editorStart);
        this.cm.scrollTo(0, targetEditorTop);
      },
      // 滑动窗口模式：编辑器滚动 → 预览
      // 焦点（编辑区视口顶部对应行）落在窗口内则直接定位预览；否则以焦点重新渲染窗口
      _syncEditorToPreviewWindow() {
        const win = this.previewWindow;
        if (!win) return;
        const cmInfo = this.cm.getScrollInfo();
        const focus = this.cm.lineAtHeight(cmInfo.top, 'local'); // 0-based
        if (focus < win.start + 8 || focus > win.end - 8) {
          this._previewFocusLine = Math.max(0, Math.min(focus, this.cm.lineCount() - 1));
          this.debounceUpdatePreview();
          return;
        }
        this._focusPreviewToLine(focus);
      },
      // 滑动窗口模式：预览滚动 → 编辑器
      // 预览仅含窗口片段，按当前预览滚动位置反查窗口内对应源码行，回滚编辑器
      _syncPreviewToEditorWindow() {
        if (!this._windowLineTops || !this._windowLineTops.length) return;
        const st = this.preview.scrollTop;
        let bestLine = this.previewWindow.start;
        let bestTop = -Infinity;
        for (const [ln, top] of this._windowLineTops) {
          if (top <= st + 1 && top > bestTop) { bestLine = ln - 1; bestTop = top; }
        }
        const targetTop = this.cm.heightAtLine(bestLine, 'local');
        if (this.activeTab) this.activeTab.scrollPos = { top: targetTop, left: 0 };
        this.cm.scrollTo(0, targetTop);
      },
      // 按 markdown 块级元素边界分割源码，与 pulldown-cmark 渲染输出对齐
      // 注意：此方法保留用于兼容旧的 _blocks 数组引用
      _splitMarkdownBlocks(lines) {
        const blocks = [];
        let i = 0;
  
        while (i < lines.length) {
          while (i < lines.length && lines[i].trim() === '') i++;
          if (i >= lines.length) break;
  
          const startLine = i;
          const line = lines[i].trim();
  
          // 代码围栏：作为一个整体 block
          if (line.startsWith('```') || line.startsWith('~~~')) {
            const fence = line.match(/^(`{3,}|~{3,})/)[0];
            i++;
            while (i < lines.length) {
              if (lines[i].trim().startsWith(fence)) break;
              i++;
            }
            if (i < lines.length) i++;
            blocks.push({ startLine, endLine: i - 1 });
            continue;
          }
  
          // 标题：始终是单行 block（demo 中每个 # 行 = 一个预览元素）
          if (/^#{1,6}\s/.test(line)) {
            blocks.push({ startLine, endLine: i });
            i++;
            continue;
          }
  
          // 水平分割线：单行 block
          if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            blocks.push({ startLine, endLine: i });
            i++;
            continue;
          }
  
          // 表格：连续的 | 行
          if (line.startsWith('|')) {
            while (i < lines.length && lines[i].trim().startsWith('|')) i++;
            blocks.push({ startLine, endLine: i - 1 });
            continue;
          }
  
          // 段落/列表/引用：消费连续非空行，遇到标题/围栏/分割线/表格时停止
          i++;
          while (i < lines.length && lines[i].trim() !== '') {
            const t = lines[i].trim();
            if (/^#{1,6}\s/.test(t) ||
                t.startsWith('```') || t.startsWith('~~~') ||
                /^(-{3,}|\*{3,}|_{3,})\s*$/.test(t) ||
                t.startsWith('|')) {
              break;
            }
            i++;
          }
          blocks.push({ startLine, endLine: i - 1 });
        }
  
        return blocks;
      },
      // 获取预览 DOM 的直系 block 级子元素（与 blocks 顺序一一对应）
      _getPreviewBlockElements() {
        const tags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'HR', 'DETAILS', 'DIV', 'DL', 'FIGURE', 'IMG']);
        return Array.from(this.preview.children).filter(el => tags.has(el.tagName));
      },
      // 像素比例兜底：在文档中均匀取样 20 个点
      _fallbackPositionMap(totalLines) {
        const positions = [{ line: 0, fraction: 0 }];
        const step = Math.max(1, Math.floor(totalLines / 20));
        for (let l = step; l < totalLines - 1; l += step) {
          positions.push({ line: l, fraction: l / totalLines });
        }
        positions.push({ line: totalLines - 1, fraction: 1 });
        return positions;
      },
      // 超大文档预览保护：返回前 maxLines 行内容。
      // 若在代码围栏内被截断，向后补足到下一个围栏，避免后续整段被当作代码块。
      _headForPreview(content, maxLines) {
        const lines = content.split('\n');
        if (lines.length <= maxLines) return content;
        let head = lines.slice(0, maxLines).join('\n');
        const fences = (head.match(/^\s*```/gm) || []).length;
        if (fences % 2 === 1) {
          const rest = lines.slice(maxLines).join('\n');
          const idx = rest.indexOf('```');
          if (idx >= 0) head += '\n' + rest.slice(0, idx + 3);
        }
        return head;
      },
      // P2-1 Strangler（ADR-3）：以下 5 个虚拟窗口方法逻辑已迁至 PreviewController，
      // 当前保留薄委托，待全部调用点迁移后删除。
      _buildWindowLineTops() {
        return this.previewController._buildWindowLineTops();
      },
      _focusPreviewToLine(line) {
        return this.previewController._focusPreviewToLine(line);
      },
      _renderPreviewWindowBlock(finalHtml, win, content) {
        return this.previewController._renderPreviewWindowBlock(finalHtml, win, content);
      },
      _updateVirtualScrollMetrics() {
        return this.previewController._updateVirtualScrollMetrics();
      },
      _syncPreviewVirtualScroll() {
        return this.previewController._syncPreviewVirtualScroll();
      },
        async updatePreview(suppressLoading = false) {
          // P2-1 Strangler（ADR-3）：编排逻辑已迁至 PreviewController.render()，此处保留薄委托。
          return this.previewController.render(suppressLoading);
        },
      // P1-1：逻辑已抽到 src/modules/image-processor.js（纯函数 + 依赖注入）。
      // 这里只做 DI 适配：把实例字段/方法包成注入项，错误仍上交调用方（6772 处的 try/catch）。
      async processImages() {
        return ImageProcessor.processImages(this.preview, {
          activeTab: this.activeTab,
          imageCache: this._imageBase64Cache,
          tauri: TauriApi,
          getCachedImageURL: (dataUri) => this.getCachedImageURL(dataUri),
          getRenderGeneration: () => this._renderGeneration,
        });
      },
      processFootnotes() {
        this.preview.querySelectorAll('.footnote-ref a').forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            if (!href) return;
            const target = this.preview.querySelector(href);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.classList.add('footnote-flash');
              setTimeout(() => target.classList.remove('footnote-flash'), 1500);
            }
          });
        });
  
        this.preview.querySelectorAll('.footnote-backref').forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            if (!href) return;
            const target = this.preview.querySelector(href);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.classList.add('footnote-flash');
              setTimeout(() => target.classList.remove('footnote-flash'), 1500);
            }
          });
        });
      },
  };

  const api = { mixin };
  window.TMPreviewSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
