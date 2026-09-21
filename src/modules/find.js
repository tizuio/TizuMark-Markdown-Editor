// 文档内查找替换与跨文件搜索
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { dialogOpen } = TMConst;

  const mixin = {
      initFindReplace() {
        const findPanel = document.getElementById('find-panel');
        const findInput = document.getElementById('find-input');
        const replaceInput = document.getElementById('replace-input');
        const findCount = document.getElementById('find-count');
        let lastQuery = '';
        this.findMarks = this.findMarks || []; // 全部高亮的 markText 句柄
  
        const isSafeRegex = FindReplace.isSafeRegex;
  
        // 带步数上限的安全匹配计数：避免灾难性回溯卡死主线程
        const safeMatchCount = (text, re, limit = 200000) => {
          if (!re.global) re = new RegExp(re.source, re.flags + 'g');
          let count = 0, steps = 0;
          let m;
          re.lastIndex = 0;
          while ((m = re.exec(text)) !== null) {
            count++;
            steps += m.index + 1;
            if (steps > limit || count > 100000) return -1; // 超限：疑似 ReDoS
            if (re.lastIndex === m.index) re.lastIndex++;
          }
          return count;
        };
  
        const makeRegex = (q, flags) => {
          try { return new RegExp(q, flags); } catch { return null; }
        };
  
        const getSearchCursor = () => {
          const query = findInput.value;
          if (!query) return null;
          const caseSensitive = document.getElementById('find-case').checked;
          const useRegex = document.getElementById('find-regex').checked;
          if (useRegex) {
            if (!isSafeRegex(query)) { this.setStatus(this.t('unsafeRegex')); return null; }
            try { new RegExp(query); } catch { return null; }
          }
          const cursor = this.cm.getSearchCursor(
            useRegex ? new RegExp(query, caseSensitive ? 'g' : 'gi') : query,
            this.cm.getCursor(),
            { caseFold: !caseSensitive }
          );
          return cursor;
        };
  
        let findComposing = false; // 输入法合成中（拼音/手写）：期间不触发搜索，避免主线程被反复全量高亮占满而卡死
        const debounce = (fn, delay) => {
          let t = null;
          return (...args) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
        };
        const updateCount = () => {
          if (findComposing) return; // 拼音合成中跳过；合成结束会立刻搜一次
          const query = findInput.value;
          if (!query) { findCount.textContent = ''; return; }
          const caseSensitive = document.getElementById('find-case').checked;
          const useRegex = document.getElementById('find-regex').checked;
          const text = this.cm.getValue();
          let count = 0;
          if (useRegex) {
            if (!isSafeRegex(query)) { findCount.textContent = ''; return; }
            const re = makeRegex(query, caseSensitive ? 'g' : 'gi');
            if (re) { const c = safeMatchCount(text, re); count = c < 0 ? '∞' : c; }
          } else {
            const lower = caseSensitive ? text : text.toLowerCase();
            const q = caseSensitive ? query : query.toLowerCase();
            let pos = 0;
            while ((pos = lower.indexOf(q, pos)) !== -1) { count++; pos += q.length; }
          }
          if (count === '∞') { findCount.textContent = this.t('tooManyMatches') || '∞'; }
          else findCount.textContent = count > 0 ? count + this.t('matches') : this.t('noMatches');
          this.highlightAllMatches();
          // 预览框（编辑模式下与编辑框并排）同样黄色高亮
          this.highlightPreviewMatches(query, caseSensitive, useRegex);
        };
  
        // 输入防抖：避免每敲一个字符就同步全量搜索+高亮（尤其中文拼音边输边搜会卡死）
        const debouncedFindUpdate = debounce(() => updateCount(), 160);
        findInput.addEventListener('input', debouncedFindUpdate);
        findInput.addEventListener('compositionstart', () => { findComposing = true; });
        findInput.addEventListener('compositionend', () => {
          findComposing = false;
          updateCount(); // 合成结束立即搜索一次，即时反馈
        });
        document.getElementById('find-case').addEventListener('change', updateCount);
        document.getElementById('find-regex').addEventListener('change', updateCount);
  
        document.getElementById('find-next').addEventListener('click', () => {
          const loop = document.getElementById('find-loop').checked;
          const cursor = getSearchCursor();
          if (cursor && cursor.findNext()) {
            this.cm.setSelection(cursor.from(), cursor.to());
            this.cm.scrollIntoView({ from: cursor.from(), to: cursor.to() }, 100);
          } else if (cursor && loop) {
            const q = findInput.value;
            const useRegex = document.getElementById('find-regex').checked;
            if (useRegex && !isSafeRegex(q)) return;
            const cursor2 = this.cm.getSearchCursor(
              useRegex ? new RegExp(q, document.getElementById('find-case').checked ? 'g' : 'gi') : q,
              { line: 0, ch: 0 },
              { caseFold: !document.getElementById('find-case').checked }
            );
            if (cursor2.findNext()) {
              this.cm.setSelection(cursor2.from(), cursor2.to());
              this.cm.scrollIntoView({ from: cursor2.from(), to: cursor2.to() }, 100);
            }
          }
        });
  
        document.getElementById('find-prev').addEventListener('click', () => {
          const query = findInput.value;
          if (!query) return;
          const caseSensitive = document.getElementById('find-case').checked;
          const useRegex = document.getElementById('find-regex').checked;
          const cursor = this.cm.getCursor();
          const text = this.cm.getValue();
  
          // 用 CodeMirror 原生 indexFromPos/posFromIndex 做偏移换算：
          // 历史实现每次调用都对全文 split('\n')，多匹配循环下近 O(n²)；原生 API 走行表，常数级。
          const currentOffset = this.cm.indexFromPos(cursor);
          const flags = caseSensitive ? 'g' : 'gi';
          if (useRegex && !isSafeRegex(query)) return;
          const regex = useRegex
            ? new RegExp(query, flags)
            : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  
          let lastMatch = null;
          let lastOverall = null;
          let m;
          while ((m = regex.exec(text)) !== null) {
            const cand = { from: this.cm.posFromIndex(m.index), to: this.cm.posFromIndex(m.index + m[0].length) };
            lastOverall = cand;
            if (m.index + m[0].length < currentOffset) {
              lastMatch = cand;
            }
            if (regex.lastIndex === m.index) { regex.lastIndex++; }
          }
  
          const loop = document.getElementById('find-loop').checked;
          if (lastMatch) {
            this.cm.setSelection(lastMatch.from, lastMatch.to);
            this.cm.scrollIntoView({ from: lastMatch.from, to: lastMatch.to }, 100);
          } else if (loop && lastOverall) {
            this.cm.setSelection(lastOverall.from, lastOverall.to);
            this.cm.scrollIntoView({ from: lastOverall.from, to: lastOverall.to }, 100);
          }
        });
  
        document.getElementById('replace-one').addEventListener('click', () => {
          if (this.cm.somethingSelected()) {
            this.cm.replaceSelection(replaceInput.value);
          }
          document.getElementById('find-next').click();
        });
  
        document.getElementById('replace-all').addEventListener('click', () => {
          const query = findInput.value;
          const replacement = replaceInput.value;
          if (!query) return;
          const caseSensitive = document.getElementById('find-case').checked;
          const useRegex = document.getElementById('find-regex').checked;
  
          if (useRegex && !isSafeRegex(query)) return;
          // 使用 CodeMirror 的 searchCursor.replace，原生支持 $1/$& 反向引用（正则替换不被退化为文本替换）
          const search = useRegex ? new RegExp(query, caseSensitive ? 'g' : 'gi') : query;
          const cursor = this.cm.getSearchCursor(search, { line: 0, ch: 0 }, { caseFold: !caseSensitive });
          let count = 0;
          let steps = 0;
          this.cm.operation(() => {
            while (cursor.findNext()) {
              count++;
              steps++;
              if (steps > 100000) break; // 防御性上限，避免极端情况卡死
              cursor.replace(replacement);
            }
          });
          if (count > 0) this.setStatus(this.t('replaceAllDone', { n: count }));
        });
  
        document.getElementById('find-close').addEventListener('click', () => this.closeFindPanel());
  
        findInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('find-next').click();
          }
          if (e.key === 'Escape') this.closeFindPanel();
        });
  
        replaceInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('replace-one').click();
          }
          if (e.key === 'Escape') this.closeFindPanel();
        });
  
        this.initPreviewFind();
      },
      initPreviewFind() {
        const previewFindInput = document.getElementById('preview-find-input');
        const previewFindCount = document.getElementById('preview-find-count');
        this.previewSelections = [];
        this.previewSelectionIndex = -1;
  
        let previewComposing = false; // 输入法合成中：期间不触发预览搜索，避免卡顿
        const debouncePreview = (fn, delay) => { let t = null; return (...args) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), delay); }; };
        const updatePreviewCount = () => {
          if (previewComposing) return;
          const query = previewFindInput.value;
          if (!query) { previewFindCount.textContent = ''; this.clearPreviewHighlight(); return; }
          const caseSensitive = document.getElementById('preview-find-case').checked;
          const useRegex = document.getElementById('preview-find-regex').checked;
          const text = this.preview.textContent;
          let count = 0;
          if (useRegex) {
            if (!isSafeRegex(query)) { previewFindCount.textContent = ''; return; }
            const re = makeRegex(query, caseSensitive ? 'g' : 'gi');
            if (re) { const c = safeMatchCount(text, re); count = c < 0 ? '∞' : c; }
          } else {
            const lower = caseSensitive ? text : text.toLowerCase();
            const q = caseSensitive ? query : query.toLowerCase();
            let pos = 0;
            while ((pos = lower.indexOf(q, pos)) !== -1) { count++; pos += q.length; }
          }
          if (count === '∞') { previewFindCount.textContent = this.t('tooManyMatches') || '∞'; }
          else previewFindCount.textContent = count > 0 ? count + this.t('matches') : this.t('noMatches');
          if (query && count !== '∞' && count > 0) {
            this.highlightPreviewMatches(query, caseSensitive, useRegex);
          } else {
            this.clearPreviewHighlights();
          }
        };
  
        const doPreviewFind = (reverse = false) => {
          const query = previewFindInput.value;
          if (!query) return;
          const caseSensitive = document.getElementById('preview-find-case').checked;
          const useRegex = document.getElementById('preview-find-regex').checked;
  
          const text = this.preview.textContent;
          let matches = [];
          
          if (useRegex) {
            if (!isSafeRegex(query)) return;
            const regex = makeRegex(query, caseSensitive ? 'g' : 'gi');
            if (regex) {
              let m;
              while ((m = regex.exec(text)) !== null) {
                matches.push({ start: m.index, end: m.index + m[0].length });
                if (matches.length > 10000) break;
              }
            }
          } else {
            const flags = caseSensitive ? 'g' : 'gi';
            const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedQuery, flags);
            let m;
            while ((m = regex.exec(text)) !== null) {
              matches.push({ start: m.index, end: m.index + m[0].length });
              if (matches.length > 10000) break;
            }
          }
  
          if (matches.length === 0) return;
  
          let currentPos = 0;
          const selection = window.getSelection();
          if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const preRange = document.createRange();
            preRange.selectNodeContents(this.preview);
            preRange.setEnd(range.endContainer, range.endOffset);
            currentPos = preRange.toString().length;
          }
  
          const loop = document.getElementById('preview-find-loop').checked;
          let targetMatch = null;
          if (reverse) {
            let found = false;
            for (let i = matches.length - 1; i >= 0; i--) {
              if (matches[i].end < currentPos) { targetMatch = matches[i]; found = true; break; }
            }
            if (!found && loop) targetMatch = matches[matches.length - 1];
          } else {
            let found = false;
            for (let i = 0; i < matches.length; i++) {
              if (matches[i].start >= currentPos) { targetMatch = matches[i]; found = true; break; }
            }
            if (!found && loop) targetMatch = matches[0];
          }
  
          if (targetMatch) this.highlightPreviewMatch(targetMatch);
        };
  
        this.highlightPreviewMatch = (target) => {
          const walker = document.createTreeWalker(this.preview, NodeFilter.SHOW_TEXT, null, false);
          let node;
          let charCount = 0;
          while (node = walker.nextNode()) {
            const nodeLen = node.nodeValue.length;
            if (charCount + nodeLen > target.start) {
              const startOffset = target.start - charCount;
              // 匹配可能跨多个文本节点（如 <strong> 边界），endOffset 在本节点内钳制，
              // 避免 range.setEnd 越界抛 IndexSizeError（历史 bug：跨节点匹配直接崩掉高亮）
              const endOffset = Math.min(target.end - charCount, nodeLen);
              const range = document.createRange();
              range.setStart(node, startOffset);
              range.setEnd(node, Math.max(endOffset, startOffset));
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              range.startContainer.parentElement.scrollIntoView({ behavior: 'auto', block: 'center' });
              return;
            }
            charCount += nodeLen;
          }
        };
  
        this.clearPreviewHighlight = () => {
          this.clearPreviewHighlights();
        };
  
        // 输入防抖 + 输入法合成守卫：避免预览框边输边搜卡死
        const debouncedPreviewUpdate = debouncePreview(() => updatePreviewCount(), 160);
        previewFindInput.addEventListener('input', debouncedPreviewUpdate);
        previewFindInput.addEventListener('compositionstart', () => { previewComposing = true; });
        previewFindInput.addEventListener('compositionend', () => {
          previewComposing = false;
          updatePreviewCount(); // 合成结束立即搜索一次
        });
        document.getElementById('preview-find-case').addEventListener('change', updatePreviewCount);
        document.getElementById('preview-find-regex').addEventListener('change', updatePreviewCount);
  
        document.getElementById('preview-find-next').addEventListener('click', () => doPreviewFind(false));
        document.getElementById('preview-find-prev').addEventListener('click', () => doPreviewFind(true));
        document.getElementById('preview-find-close').addEventListener('click', () => {
          document.getElementById('preview-find-panel').classList.add('hidden');
          this.clearPreviewHighlight();
        });
  
        previewFindInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            doPreviewFind(e.shiftKey);
          }
          if (e.key === 'Escape') {
            document.getElementById('preview-find-panel').classList.add('hidden');
            this.clearPreviewHighlight();
          }
        });
      },
      toggleFindPanel(replaceMode = false) {
        // 互斥：打开页面内查找时关闭跨文件搜索弹框
        const csDlg = document.getElementById('cross-search-dialog');
        if (csDlg) csDlg.classList.add('hidden');
        if (this.viewMode === 'preview') {
          const panel = document.getElementById('preview-find-panel');
          const isHidden = panel.classList.contains('hidden');
          document.getElementById('find-panel').classList.add('hidden');
          panel.classList.toggle('hidden');
          if (isHidden) {
            const input = document.getElementById('preview-find-input');
            const selection = window.getSelection();
            if (selection.toString()) {
              input.value = selection.toString();
            }
            input.focus();
            input.select();
            if (input.value) this.highlightPreviewMatches(input.value, document.getElementById('preview-find-case').checked, document.getElementById('preview-find-regex').checked);
          } else {
            this.clearPreviewHighlights();
          }
        } else {
          const panel = document.getElementById('find-panel');
          const isHidden = panel.classList.contains('hidden');
          document.getElementById('preview-find-panel').classList.add('hidden');
          panel.classList.toggle('hidden');
          if (isHidden) {
            const input = document.getElementById('find-input');
            if (this.cm.somethingSelected()) {
              input.value = this.cm.getSelection();
            }
            input.focus();
            input.select();
            this.highlightAllMatches();
            // 预览框（编辑模式下与编辑框并排）同样黄色高亮
            this.highlightPreviewMatches(input.value, document.getElementById('find-case').checked, document.getElementById('find-regex').checked);
          } else {
            this.clearFindHighlights();
          }
        }
      },
      closeFindPanel() {
        document.getElementById('find-panel').classList.add('hidden');
        document.getElementById('preview-find-panel').classList.add('hidden');
        this.clearPreviewHighlight();
        this.clearFindHighlights();
        if (this.viewMode === 'edit') {
          this.cm.focus();
        }
      },
      highlightAllMatches() {
        // 全部高亮：用 getSearchCursor 遍历所有匹配，markText 加 .search-match 类。
        // 上限 2000 防止超大文档卡顿；超限仅高亮前 2000 个（计数仍由 updateCount 准确显示）。
        this.clearFindHighlights();
        const findInput = document.getElementById('find-input');
        if (!findInput) return;
        const query = findInput.value;
        if (!query) return;
        const caseSensitive = document.getElementById('find-case').checked;
        const useRegex = document.getElementById('find-regex').checked;
        let re;
        try {
          if (useRegex) {
            if (!FindReplace.isSafeRegex(query)) return;
            re = new RegExp(query, caseSensitive ? 'g' : 'gi');
          } else {
            re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
          }
        } catch { return; }
        const LIMIT = 2000;
        this.cm.operation(() => {
          const cursor = this.cm.getSearchCursor(re, { line: 0, ch: 0 }, { caseFold: !caseSensitive });
          let count = 0;
          while (cursor.findNext()) {
            if (count >= LIMIT) break;
            try {
              const mark = this.cm.markText(cursor.from(), cursor.to(), { className: 'search-match' });
              this.findMarks.push(mark);
            } catch (_) {}
            count++;
          }
        });
      },
      clearFindHighlights() {
        if (this.findMarks && this.findMarks.length) {
          this.findMarks.forEach(m => { try { m.clear(); } catch (_) {} });
        }
        this.findMarks = [];
      },
      // 跨文件搜索高亮：独立于文件内查找（findMarks），便于两种查找互斥时各自清理互不干扰
      clearCrossSearchHighlights() {
        if (!this.crossSearchMarks) { this.crossSearchMarks = []; return; }
        this.crossSearchMarks.forEach(m => { try { m.clear(); } catch (_) {} });
        this.crossSearchMarks = [];
      },
      // 预览高亮：在 #preview 的文本节点中把匹配片段包裹为 <mark class="search-match">，
      // 与编辑器高亮共用同一配色（醒目黄色）。从后往前包裹，避免节点切分影响更早偏移。
      clearPreviewHighlights() {
        const pv = this.preview;
        if (!pv) { this._safeClearSelection(); return; }
        const marks = pv.querySelectorAll('mark.preview-search-hl');
        marks.forEach(mk => {
          const parent = mk.parentNode;
          while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
          parent.removeChild(mk);
        });
        pv.normalize();
        this._safeClearSelection();
      },
      // 仅清空落在 #preview 内的文档选区。
      // 关键修复：若焦点落在搜索框 / 编辑器等可编辑元素上（其选区不在 #preview 内），
      // 绝不调用 window.getSelection().removeAllRanges()——WebView2/Chromium 下该调用会令
      // 当前聚焦的 <input> 失焦，表现为「搜索框里打一个字符光标就移走」。
      _safeClearSelection() {
        const sel = window.getSelection && window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const pv = this.preview;
        // 选区锚点不在预览内（例如在搜索输入框里）→ 不动它，避免抢焦点
        if (!pv || !pv.contains(sel.anchorNode)) return;
        sel.removeAllRanges();
      },
      highlightPreviewMatches(query, caseSensitive, useRegex) {
        const pv = this.preview;
        if (!pv) return;
        this.clearPreviewHighlights();
        if (!query) return;
        const text = pv.textContent;
        if (!text) return;
        const matches = [];
        const LIMIT = 2000;
        if (useRegex) {
          if (!FindReplace.isSafeRegex(query)) return;
          let re;
          try { re = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch { return; }
          let m;
          while ((m = re.exec(text)) !== null) {
            matches.push([m.index, m.index + m[0].length]);
            if (matches.length >= LIMIT) break;
            if (re.lastIndex === m.index) re.lastIndex++;
          }
        } else {
          const hay = caseSensitive ? text : text.toLowerCase();
          const q = caseSensitive ? query : query.toLowerCase();
          let pos = 0;
          while ((pos = hay.indexOf(q, pos)) !== -1) {
            matches.push([pos, pos + q.length]);
            pos += q.length;
            if (matches.length >= LIMIT) break;
          }
        }
        if (!matches.length) return;
        const walker = document.createTreeWalker(pv, NodeFilter.SHOW_TEXT, null, false);
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) { if (node.nodeValue) nodes.push(node); }
        let mi = 0;
        let charCount = 0;
        for (const n of nodes) {
          const len = n.nodeValue.length;
          const nodeMatches = [];
          while (mi < matches.length && matches[mi][0] >= charCount && matches[mi][1] <= charCount + len) {
            nodeMatches.push([matches[mi][0] - charCount, matches[mi][1] - charCount]);
            mi++;
          }
          while (mi < matches.length && matches[mi][0] >= charCount && matches[mi][0] < charCount + len && matches[mi][1] > charCount + len) mi++;
          for (let k = nodeMatches.length - 1; k >= 0; k--) {
            const s = nodeMatches[k][0], e = nodeMatches[k][1];
            const range = document.createRange();
            range.setStart(n, s);
            range.setEnd(n, e);
            const mark = document.createElement('mark');
            mark.className = 'search-match preview-search-hl';
            try { range.surroundContents(mark); } catch (_) {}
          }
          charCount += len;
        }
      },
      openCrossSearchDialog() {
        const dlg = document.getElementById('cross-search-dialog');
        if (!dlg) return;
        dlg.classList.remove('hidden');
        // 互斥：打开跨文件搜索时关闭页面内查找并清除高亮，避免两种查找同时干扰编辑器/预览
        document.getElementById('find-panel').classList.add('hidden');
        document.getElementById('preview-find-panel').classList.add('hidden');
        this.clearFindHighlights();
        this.clearPreviewHighlights();
        this.clearCrossSearchHighlights();
        // 浮动面板定位：首次显示在右上角避免遮挡正文；已拖动过则保持上次位置并夹取在视口内
        const panel = document.getElementById('cs-panel');
        if (panel) {
          const w = panel.offsetWidth || 560;
          const vw = window.innerWidth || 1200;
          const vh = window.innerHeight || 800;
          let left = panel.style.left ? parseInt(panel.style.left, 10) : Math.max(12, vw - w - 24);
          let top = panel.style.top ? parseInt(panel.style.top, 10) : Math.max(12, Math.round(vh * 0.08));
          left = Math.max(0, Math.min(left, vw - 80));
          top = Math.max(0, Math.min(top, vh - 40));
          panel.style.left = left + 'px';
          panel.style.top = top + 'px';
        }
        // 默认目录：当前文件所在目录
        const dirInput = document.getElementById('cs-dir');
        if (this.activeTab && this.activeTab.filePath) {
          const fp = this.activeTab.filePath;
          const m = fp.match(/[/\\][^/\\]*$/);
          dirInput.value = m ? fp.substring(0, m.index) : fp;
        }
        const q = document.getElementById('cs-query');
        if (this.cm && this.cm.somethingSelected()) q.value = this.cm.getSelection();
        q.focus();
        q.select();
      },
      // 文件搜索（VS Code 风格 Ctrl+P，合并自 PR #36）：委托给 modules/file-search.js 的全局函数。
      // 该模块负责扫描工作区、渲染列表与键盘导航；此处仅做初始化与入口转发，保持 IPC 收敛在模块内。
      openFileSearchDialog() {
        if (typeof openFileSearchDialog === 'function') openFileSearchDialog();
      },
      initFileSearchModule() {
        if (typeof initFileSearch === 'function') initFileSearch();
      },
      initCrossSearch() {
        const dlg = document.getElementById('cross-search-dialog');
        if (!dlg) return;
        // 标题栏拖动 + 缩放统一交由 dialog-drag-resize.js（在 initDialogsDragResize 中遍历所有 .dialog-overlay 接入），
        // 此处不再自写拖动逻辑，保证一套逻辑复用所有弹框。
  
        document.getElementById('cs-close').addEventListener('click', () => {
          dlg.classList.add('hidden');
          this.clearCrossSearchHighlights();
          this.clearPreviewHighlights();
        });
        const updateDirRow = () => {
          const isDir = document.querySelector('input[name="cs-scope"]:checked')?.value === 'dir';
          document.getElementById('cs-dir-row').classList.toggle('hidden', !isDir);
        };
        document.querySelectorAll('input[name="cs-scope"]').forEach(r => r.addEventListener('change', updateDirRow));
        document.getElementById('cs-browse').addEventListener('click', async () => {
          const sel = await dialogOpen({ directory: true });
          if (sel) document.getElementById('cs-dir').value = Array.isArray(sel) ? sel[0] : sel;
        });
        document.getElementById('cs-run').addEventListener('click', () => this.runCrossSearch());
        document.getElementById('cs-query').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            // 已有结果且 query 未变 → 跳到下一个匹配（循环查找可选）；否则重新搜索
            if (this.crossSearchFlat && this.crossSearchFlat.length && this.csLastQuery === e.target.value) {
              this.csNextMatch();
            } else {
              this.runCrossSearch();
            }
          }
          if (e.key === 'Escape') dlg.classList.add('hidden');
        });
      },
      // 跨文件搜索 - 打开文件范围：遍历 this.tabs，ensureTabLoaded 后对 content 按行搜索。
      async searchOpenFiles(query, caseSensitive, useRegex) {
        const results = [];
        let re = null;
        if (useRegex) {
          if (!FindReplace.isSafeRegex(query)) return results;
          try { re = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch { return results; }
        }
        const qLower = query.toLowerCase();
        for (let i = 0; i < this.tabs.length; i++) {
          const tab = this.tabs[i];
          await this.ensureTabLoaded(tab);
          const content = tab.content || '';
          const lines = content.split('\n');
          const matches = [];
          const LIMIT = 500;
          for (let j = 0; j < lines.length && matches.length < LIMIT; j++) {
            const line = lines[j];
            let col = -1, len = 0;
            if (re) {
              re.lastIndex = 0;
              const m = re.exec(line);
              if (m) { col = m.index; len = m[0].length; }
            } else {
              const hay = caseSensitive ? line : line.toLowerCase();
              const idx = hay.indexOf(caseSensitive ? query : qLower);
              if (idx >= 0) { col = idx; len = query.length; }
            }
            if (col >= 0) {
              matches.push({ line: j + 1, col: col + 1, len, line_text: line.substring(0, 300) });
            }
          }
          if (matches.length) {
            results.push({ tabIndex: i, filePath: tab.filePath || '', name: tab.name || '', path: tab.filePath || tab.name || '', matches });
          }
        }
        return results;
      },
      async runCrossSearch() {
        const query = document.getElementById('cs-query').value;
        if (!query) return;
        const caseSensitive = document.getElementById('cs-case').checked;
        const useRegex = document.getElementById('cs-regex').checked;
        const scope = document.querySelector('input[name="cs-scope"]:checked')?.value || 'open';
        const progress = document.getElementById('cs-progress');
        const totalEl = document.getElementById('cs-total');
        const resultsEl = document.getElementById('cs-results');
        progress.classList.remove('hidden');
        progress.textContent = this.t('searchRunning');
        totalEl.textContent = '';
        resultsEl.innerHTML = '';
        this.csLastQuery = query;
        this.clearCrossSearchHighlights();
        this.crossSearchFlat = [];
        this.crossSearchPos = -1;
        try {
          let results;
          if (scope === 'open') {
            results = await this.searchOpenFiles(query, caseSensitive, useRegex);
          } else {
            const dir = document.getElementById('cs-dir').value;
            if (!dir) { totalEl.textContent = this.t('noResults'); progress.classList.add('hidden'); return; }
            const raw = await TauriApi.searchInFiles({ dir, pattern: query, caseSensitive, useRegex, extensions: [] });
            results = raw.map(r => ({ path: r.path, matches: r.matches.map(m => ({ line: m.line, col: m.col, len: 0, line_text: m.line_text })) }));
          }
          // 扁平化匹配列表，供“下一个 / 循环查找”导航
          for (const f of results) {
            for (const m of f.matches) {
              this.crossSearchFlat.push({ filePath: f.path, line: m.line, col: m.col, len: m.len || 0 });
            }
          }
          this.renderCrossSearchResults(results, query);
        } catch (e) {
          this.reportError('E_IO', { context: { query }, error: e });
        } finally {
          progress.classList.add('hidden');
        }
      },
      // 跳到下一个匹配：勾选“循环查找”时在末尾回到第一个，否则停在最后一条
      csNextMatch() {
        const flat = this.crossSearchFlat;
        if (!flat || !flat.length) return;
        const loop = document.getElementById('cs-loop') ? document.getElementById('cs-loop').checked : false;
        let next = this.crossSearchPos + 1;
        if (next >= flat.length) {
          if (!loop) return; // 不循环则停在最后
          next = 0;
        }
        this.crossSearchPos = next;
        const m = flat[next];
        this.csHighlightCurrent();
        this.jumpToMatch(m.filePath, m.line, m.col, m.len);
      },
      csHighlightCurrent() {
        const items = document.querySelectorAll('#cs-results .cs-match');
        items.forEach((el, i) => el.classList.toggle('current', i === this.crossSearchPos));
        const cur = items[this.crossSearchPos];
        if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
      },
      renderCrossSearchResults(results, query) {
        const totalEl = document.getElementById('cs-total');
        const resultsEl = document.getElementById('cs-results');
        const total = results.reduce((s, r) => s + r.matches.length, 0);
        if (total === 0) {
          totalEl.textContent = this.t('noResults');
          resultsEl.innerHTML = '';
          return;
        }
        totalEl.textContent = this.t('totalMatches', { n: total });
        resultsEl.innerHTML = '';
        for (const file of results) {
          const group = document.createElement('div');
          group.className = 'cs-file-group';
          const header = document.createElement('div');
          header.className = 'cs-file-header';
          header.textContent = `${file.path || file.name} (${file.matches.length})`;
          group.appendChild(header);
          for (const m of file.matches) {
            const item = document.createElement('div');
            item.className = 'cs-match';
            const snippet = (m.line_text || '').trim().substring(0, 120);
            item.textContent = `${m.line}:${m.col}  ${snippet}`;
            item.addEventListener('click', () => this.jumpToMatch(file.path, m.line, m.col, m.len || 0));
            group.appendChild(item);
          }
          resultsEl.appendChild(group);
        }
      },
      async jumpToMatch(filePath, line, col, len) {
        const prevViewMode = this.viewMode;
        if (filePath) {
          await this.openFilePath(filePath);
          // openFilePath 打开新文件时会切到 preview，这里恢复原视图模式，避免每次跳转改变用户视图
          if (this.viewMode !== prevViewMode) {
            this.viewMode = prevViewMode;
            this.applyViewMode();
          }
        }
        const pos = { line: Math.max(0, line - 1), ch: Math.max(0, col - 1) };
        // 编辑区跳转目标行；大文档滑动窗口需先以该行为焦点重渲染，否则匹配行不在窗口片段内无法定位
        this._previewFocusLine = pos.line;
        this._previewScrollDriven = false;
        await this.ensureTabLoaded(this.activeTab);
        // 确保预览已用新文件内容渲染完（异步），便于后续预览高亮准确定位
        await this.updatePreview();
        this.cm.focus();
        // 计算高亮区间：优先用后端返回的 len；目录搜索 len=0 时按查询在行内定位
        let from = pos, to = pos;
        const query = this.csLastQuery || '';
        const cs = document.getElementById('cs-case').checked;
        const ur = document.getElementById('cs-regex').checked;
        if (len > 0) {
          to = { line: pos.line, ch: pos.ch + len };
        } else if (query) {
          const lineText = this.cm.getLine(pos.line) || '';
          let matchLen = 0;
          if (ur) {
            try {
              const re = new RegExp(query, cs ? '' : 'i');
              const m = lineText.slice(pos.ch).match(re);
              if (m) matchLen = m[0].length;
            } catch (_) { /* 非法正则忽略 */ }
          } else {
            const hay = cs ? lineText : lineText.toLowerCase();
            const q = cs ? query : query.toLowerCase();
            const idx = hay.indexOf(q, pos.ch);
            if (idx !== -1) matchLen = q.length;
          }
          if (matchLen > 0) to = { line: pos.line, ch: pos.ch + matchLen };
        }
        // 编辑框黄色高亮：清除上一次跨文件高亮，标记当前匹配
        this.clearCrossSearchHighlights();
        if (to.ch !== pos.ch || to.line !== pos.line) {
          this.cm.setSelection(from, to);
          try {
            const mark = this.cm.markText(from, to, { className: 'search-match' });
            this.crossSearchMarks.push(mark);
          } catch (_) {}
        } else {
          this.cm.setCursor(pos);
        }
        this.cm.scrollIntoView(pos, 100);
        // 预览同步滚动到匹配行：预览 / 分屏模式下用户才能直观看到“跳转”
        try {
          this._buildWindowLineTops();
          this._focusPreviewToLine(pos.line);
        } catch (_) {}
        // 预览框黄色高亮（编辑与预览两种模式下预览均可见）
        if (query && (this.viewMode === 'preview' || this.viewMode === 'edit')) {
          this.highlightPreviewMatches(query, cs, ur);
        }
      },
  };

  const api = { mixin };
  window.TMFind = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
