// 编辑器实例与光标/选区行为
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { Tab } = TMConst;

  const mixin = {
      // 上下移动当前行/选中行块（CM5 核心无 moveLineUp/Down 命令，自实现，合并自 PR #36）。
      // dir=-1：与上一行交换块（上移）；dir=+1：与下一行交换块（下移）。
      // 无选区移当前单行；有选区移选中范围内所有行；块到达文档边界时 no-op。
      // 选区/光标的 ch 与方向跟随整体平移，保持原有选择语义。
      _moveLine(dir) {
        const cm = this.cm;
        if (!cm) return;
        const sel = cm.listSelections()[0];
        if (!sel) return;
        const fromLine = Math.min(sel.anchor.line, sel.head.line);
        const toLine = Math.max(sel.anchor.line, sel.head.line);
        const last = cm.lastLine();
        if (dir < 0 && fromLine === 0) return;        // 已在第一行
        if (dir > 0 && toLine === last) return;       // 已在最后一行
        cm.operation(() => {
          // 取出待移动块（fromLine..toLine）的文本
          const block = [];
          for (let i = fromLine; i <= toLine; i++) block.push(cm.getLine(i));
          const blockText = block.join('\n');
          if (dir < 0) {
            // 上移：与上一行交换。替换为 block + '\n' + 上一行 → 块整体上移一行，原上一行落到块尾
            const aboveText = cm.getLine(fromLine - 1);
            cm.replaceRange(
              blockText + '\n' + aboveText,
              { line: fromLine - 1, ch: 0 },
              { line: toLine, ch: cm.getLine(toLine).length }
            );
            // 块新位置 fromLine-1..toLine-1：选区整体上移一行
            cm.setSelection(
              { line: sel.anchor.line - 1, ch: sel.anchor.ch },
              { line: sel.head.line - 1, ch: sel.head.ch }
            );
          } else {
            // 下移：与下一行交换。替换为 下一行 + '\n' + block → 块整体下移一行，原下一行升到块首
            const belowText = cm.getLine(toLine + 1);
            cm.replaceRange(
              belowText + '\n' + blockText,
              { line: fromLine, ch: 0 },
              { line: toLine + 1, ch: cm.getLine(toLine + 1).length }
            );
            // 块新位置 fromLine+1..toLine+1：选区整体下移一行
            cm.setSelection(
              { line: sel.anchor.line + 1, ch: sel.anchor.ch },
              { line: sel.head.line + 1, ch: sel.head.ch }
            );
          }
        });
      },
      // ---- Ctrl+方向键「按词移动 / 选择」 ----
      // 词边界分词器：优先用 Intl.Segmenter 做中文分词（地基/承载 等独立成词），
      // 环境不支持时降级为正则（连续 字母/数字/中文 视为一个词）。懒创建并缓存。
      _createWordSegmenter() {
        if (this._wordSegmenterCached) return this._wordSegmenterCached;
        let info = { type: 'regex' };
        if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
          try {
            const seg = new Intl.Segmenter('zh', { granularity: 'word' });
            seg.segment('探测'); // 触发一次，确认可用
            info = { type: 'segmenter', seg };
          } catch (e) { /* 降级到 regex */ }
        }
        this._wordSegmenterCached = info;
        return info;
      },
      // 单行内从 ch 沿 dir 方向计算「词边界」目标（不含跨行）。
      // 返回 { ch, isEdgeWord }：ch 为目标列；isEdgeWord 表示该边界恰好处在行首/行尾
      // （词起点在行首 / 词尾在行尾），此时应视为有效停靠点而非继续跨行。
      // 语义对齐主流编辑器：向右先在词内跳到词尾、再跳下一词尾；向左跳到词头。
      // 标点 / 空格 / 公式符号等非 word-like 段被跳过，光标落在相邻词的边界。
      _wordBoundaryInLine(lineText, ch, dir, segInfo) {
        const words = [];
        if (segInfo.type === 'segmenter') {
          for (const s of segInfo.seg.segment(lineText)) {
            if (s.isWordLike) words.push([s.index, s.index + s.segment.length]);
          }
        } else {
          const re = /[\w一-鿿]+/g;
          let m;
          while ((m = re.exec(lineText)) !== null) words.push([m.index, m.index + m[0].length]);
        }
        const len = lineText.length;
        if (dir > 0) {
          // 向右：词内 → 当前词尾；否则第一个 start>=ch 的词尾
          for (const [s, e] of words) {
            if (ch >= s && ch < e) return { ch: e, isEdgeWord: e === len };
          }
          for (const [s, e] of words) {
            if (s >= ch) return { ch: e, isEdgeWord: e === len };
          }
          return { ch: len, isEdgeWord: false };
        }
        // 向左：词内/词尾 → 词头；否则最后一个 start<ch 的词头
        for (const [s, e] of words) {
          if (ch > s && ch <= e) return { ch: s, isEdgeWord: s === 0 };
        }
        let target = null;
        for (const [s] of words) {
          if (s < ch) target = s; else break;
        }
        return { ch: target != null ? target : 0, isEdgeWord: target != null && target === 0 };
      },
      // Ctrl+←/→ 按词移动；Ctrl+Shift+←/→ 选择词。
      // extend=true 时临时置 doc.extend，强制 extendSelectionsBy 扩展选区（不依赖
      // display.shift，确保 Shift 版无论事件路径都能选中）；extend=false 时若有选区则折叠。
      // 跨行时沿 dir 续算到相邻行的词边界。
      _moveByWord(cm, dir, extend) {
        if (!cm) return;
        const segInfo = this._createWordSegmenter();
        const doc = cm.doc;
        const prevExtend = doc.extend;
        if (extend) doc.extend = true;
        try {
          cm.extendSelectionsBy((range) => {
          let line = range.head.line;
          let ch = range.head.ch;
          let guard = 0;
          const maxLine = cm.lineCount();
          while (guard++ < maxLine + 2) {
            const lt = cm.getLine(line);
            const target = this._wordBoundaryInLine(lt, ch, dir, segInfo);
            if (dir > 0) {
              // 命中词尾（非行尾）即停靠；词尾恰在行尾也视为有效停靠；否则跨下一行
              if (target.ch < lt.length) return { line, ch: target.ch };
              if (target.isEdgeWord) return { line, ch: lt.length };
              if (line >= cm.lastLine()) return { line, ch: lt.length };
              line += 1; ch = 0;
            } else {
              // 命中词头（非行首）即停靠；词头恰在行首也视为有效停靠；否则跨上一行
              if (target.ch > 0) return { line, ch: target.ch };
              if (target.isEdgeWord) return { line, ch: 0 };
              if (line <= cm.firstLine()) return { line, ch: 0 };
              line -= 1; ch = cm.getLine(line).length;
            }
          }
          return { line, ch };
          });
        } finally {
          doc.extend = prevExtend;
        }
      },
      initEditor() {
        // slash 命令面板状态
        this._slashOpen = false;
        this._slashCommands = null;
        this._slashStart = null;
        this._slashQuery = '';
        this._slashSel = 0;
        this._slashFiltered = [];
  
        const LIST_LINE_RE = /^(\s*)(?:>[> ]*|[*+-]\s\[[xX ]\]\s|[*+-]\s|\d+[.)]\s)/;
        this.cm = CodeMirror(document.getElementById('editor-wrapper'), {
          value: '',
          mode: 'gfm',
          theme: 'default',
          inputStyle: 'contenteditable',
          lineNumbers: true,
          lineWrapping: true,
          styleActiveLine: true,
          matchBrackets: true,
          autoCloseBrackets: true,
          indentUnit: this.settings.tabSize,
          extraKeys: {
            'Enter': (cm) => this._handleTableEnter(cm),
            'Tab': (cm) => {
              if (cm.somethingSelected()) {
                cm.indentSelection('add');
                return;
              }
              // 列表/引用行无选区：缩进整行形成子级（支持多级列表层级调整）
              const lineText = cm.getLine(cm.getCursor().line);
              if (LIST_LINE_RE.test(lineText)) {
                cm.indentSelection('add');
                return;
              }
              cm.replaceSelection(' '.repeat(this.settings.tabSize), 'end');
            },
            'Shift-Tab': (cm) => cm.indentSelection('subtract'),
          }
        });
  
        // Ctrl + 鼠标滚轮缩放编辑器字体（全局，不持久化到 settings 面板，hint 消失后写回）
        const _zoomWrapper = this.cm.getWrapperElement();
        this.editorZoom = null; // null=未缩放，回落到 settings.fontSize
        // 「还原」按钮的目标字号 = 出厂默认（defaultSettings），而非当前设置值
        const _defaultSizes = this.defaultSettings();
        this._defaultEditorFontSize = _defaultSizes.fontSize;
        this._defaultPreviewFontSize = _defaultSizes.previewFontSize;
  
        // 顶部缩放提示（与 .lightbox-hint 视觉一致）
        this.zoomHint = document.createElement('div');
        this.zoomHint.className = 'zoom-hint';
        this.zoomHint.innerHTML = '<span class="zoom-hint-text"></span><span class="zoom-hint-reset hidden" role="button" title="Reset font size"></span>';
        this.zoomHint.querySelector('.zoom-hint-reset').addEventListener('click', () => {
          // 编辑器/预览共用同一提示条，按当前显示模式分派重置目标
          if (this._zoomHintMode === 'preview') this.resetPreviewFontSize();
          else this.resetEditorFontSize();
        });
        this._zoomHintHovering = false;
        this.zoomHint.addEventListener('mouseenter', () => {
          this._zoomHintHovering = true;
          clearTimeout(this._zoomHintTimer);
        });
        this.zoomHint.addEventListener('mouseleave', () => {
          this._zoomHintHovering = false;
          this._zoomHintTimer = setTimeout(() => this._zoomHintTimeout(), 3000);
        });
        document.body.appendChild(this.zoomHint);
  
        this.showZoomHint = (mode = 'editor') => {
          if (!this.zoomHint) return;
          if (mode !== 'preview' && !this.activeTab) return;
          this._zoomHintMode = mode; // 记录当前显示模式，供重置按钮分派
          const isPreview = mode === 'preview';
          // 编辑器/预览共用同一提示条（避免两个 fixed 元素叠加遮挡）；内容按模式切换
          const cur = isPreview
            ? (this.previewZoom ?? this.settings.previewFontSize)
            : (this.editorZoom ?? this.settings.fontSize);
          const base = isPreview ? this._defaultPreviewFontSize : this._defaultEditorFontSize;
          const textEl = this.zoomHint.querySelector('.zoom-hint-text');
          const resetEl = this.zoomHint.querySelector('.zoom-hint-reset');
          // 左侧始终显示当前字号，并明确是编辑器还是预览
          textEl.textContent = this.t(isPreview ? 'previewFontSizeHint' : 'fontSizeHint', { size: cur });
          if (cur !== base) {
            // 右侧显示「还原 Npx」按钮（还原到出厂默认字号）
            resetEl.textContent = this.t('fontSizeReset', { base });
            resetEl.classList.remove('hidden');
          } else {
            resetEl.classList.add('hidden');
          }
          this.zoomHint.classList.add('show');
          clearTimeout(this._zoomHintTimer);
          // hover 期间保持显示；离开后才按 3 秒倒计时消失（消失即持久化字号）
          if (!this._zoomHintHovering) {
            this._zoomHintTimer = setTimeout(() => this._zoomHintTimeout(), 3000);
          }
        };
  
        this.hideZoomHint = () => {
          if (!this.zoomHint) return;
          this.zoomHint.classList.remove('show');
          clearTimeout(this._zoomHintTimer);
        };
  
        // 字号调整落盘：hint 消失（3 秒无操作）后把运行时字号写回 settings 并持久化，
        // 保证下次重启保持上次调整的大小。编辑器按缩放源 tab 写回，预览按 previewZoom 写回。
        this._zoomHintTimeout = () => {
          this.zoomHint.classList.remove('show');
          this._persistZoom();
        };
  
        this._persistZoom = () => {
          try {
            let changed = false;
            if (this.editorZoom != null) {
              this.settings.fontSize = this.editorZoom;
              changed = true;
            }
            if (this.previewZoom != null) {
              this.settings.previewFontSize = this.previewZoom;
              changed = true;
            }
            if (changed) this.saveSettings();
          } catch {}
        };
  
        this.resetEditorFontSize = () => {
          const tab = this.activeTab;
          if (!tab) return;
          this.editorZoom = null;
          this.settings.fontSize = this._defaultEditorFontSize; // 还原到出厂默认字号
          this.cm.getWrapperElement().style.fontSize = this.settings.fontSize + 'px';
          this.cm.refresh();
          this.saveSettings(); // 还原即持久化，重启保持默认
          this.showZoomHint();
        };
  
        _zoomWrapper.addEventListener('wheel', (e) => {
          if (!e.ctrlKey) return;            // 非 Ctrl：放行，CM 正常滚动
          e.preventDefault();               // 阻止 CM 滚动 + 浏览器整页/页面缩放
          e.stopPropagation();
          if (!this.activeTab) return;
          const cur = this.editorZoom ?? this.settings.fontSize;
          const next = Math.max(8, Math.min(72, cur + (e.deltaY < 0 ? 1 : -1)));
          if (next === cur) return;
          this.editorZoom = next;
          _zoomWrapper.style.fontSize = next + 'px';
          this.cm.refresh();
          this.showZoomHint();
        }, true);  // capture：先于 CM 内部 mousewheel 监听拦截
  
        // 预览区 Ctrl + 鼠标滚轮缩放字号（全局，不持久化到 settings 面板，hint 消失后写回
        // settings.previewFontSize 并落盘，重启保持）。顶部提示复用编辑器的 zoomHint。
        this.previewZoom = null; // null=未缩放，回落到 settings.previewFontSize
  
        this.resetPreviewFontSize = () => {
          this.previewZoom = null;
          this.settings.previewFontSize = this._defaultPreviewFontSize; // 还原到出厂默认字号
          this.preview.style.fontSize = this.settings.previewFontSize + 'px';
          this.saveSettings(); // 还原即持久化，重启保持默认
          this.showZoomHint('preview');
        };
  
        const _previewScroll = document.getElementById('preview-pane');
        _previewScroll.addEventListener('wheel', (e) => {
          if (!e.ctrlKey) return;            // 非 Ctrl：放行，预览正常滚动
          e.preventDefault();               // 阻止预览滚动 + 浏览器整页/页面缩放
          e.stopPropagation();
          const cur = this.previewZoom ?? this.settings.previewFontSize;
          const next = Math.max(8, Math.min(72, cur + (e.deltaY < 0 ? 1 : -1)));
          if (next === cur) return;
          this.previewZoom = next;
          this.preview.style.fontSize = next + 'px';
          this.showZoomHint('preview');
        }, true);  // capture：先于预览内部可能的滚动监听拦截
  
        this.cm.on('change', () => {
          this.activeTab.content = this.cm.getValue();
          this.updateTabDisplay();
          // 大文档滑动窗口模式：打字时把窗口焦点同步到光标当前行（0-based），
          // 否则 updatePreview 仍按旧 _previewFocusLine 渲染切片，导致光标处新输入不显示、且预览跳到旧焦点。
          // 滚动驱动的虚拟重渲染走各自的焦点计算，这里只在窗口模式下跟随光标。
          if (this.previewWindow) {
            this._previewFocusLine = this.cm.getCursor().line;
          }
          this.debounceUpdatePreview();
        });
  
        this.cm.on('renderLine', (cm, line, el) => {
          if (line.text.length > 500 && line.text.includes('data:image/')) {
            el.classList.add('cm-base64-line');
          } else {
            el.classList.remove('cm-base64-line');
          }
        });
  
        this.cm.on('cursorActivity', () => {
          const cursor = this.cm.getCursor();
          // slash 命令面板：面板开启时按光标重算/关闭（回退到 / 前或换行列即关闭）；
          // 未开启时检测光标前的 / 是否满足「行首或空格后」触发条件。
          // 注意：不依赖 cm 的 inputRead 事件（在 Tauri WebView 下不可靠），改用 cursorActivity
          // —— 每次输入/光标移动必触发，覆盖真实输入路径。
          if (this._slashOpen) {
            this._updateSlashFromCursor();
          } else {
            this._maybeTriggerSlash(this.cm, cursor);
          }
          this.activeTab.cursorPos = cursor;
          this.cursorPosition.textContent = this.t('cursorPos', { line: cursor.line + 1, col: cursor.ch + 1 });
          this.updateBreadcrumb();
          // 光标移动时大纲同步高亮当前标题（与面包屑一致）
          this.updateOutlineActive(cursor.line);
        });
  
        // 双标志锁机制（demo 风格：canScroll.editor / canScroll.showDom）
        this._canScroll = { editor: true, preview: true };
        this._scrollThrottlePending = null;
        this._scrollThrottleTimer = null;
        this._scrollDebounceTimer = null;
  
        // 编辑器滚动 → 同步预览（demo 的 onScroll 思路）
        this.cm.on('scroll', () => {
          const container = document.querySelector('.editor-container');
          // 编辑器被隐藏（纯预览模式 / 编辑器折叠）时 getScrollInfo().top 恒为 0，
          // 若写回 scrollPos 会把已保存位置清零，导致切回编辑跳顶部。仅当编辑器可见才更新快照。
          if (container.classList.contains('preview-mode') || container.classList.contains('editor-collapsed')) return;
          const info = this.cm.getScrollInfo();
          this.activeTab.scrollPos = { top: info.top, left: info.left };
  
          // 滚动时按视口顶部行更新面包屑，实现「滚动到某标题时面包屑自动切换」
          if (this._breadcrumbHeadings && this._breadcrumbHeadings.length) {
            const topLine = this.cm.lineAtHeight(info.top + 4, 'local');
            this.updateBreadcrumb(false, Math.max(0, topLine));
            // 大纲同步跟随：滚动到某标题时，大纲高亮并滚动到当前标题
            this.updateOutlineActive(Math.max(0, topLine));
          }
  
          if (!this.settings.scrollSync || !this._canScroll.editor) return;
          if (container.classList.contains('preview-collapsed') || container.classList.contains('preview-mode')) return;
  
          this._canScroll.preview = false;
          this._throttleScroll(() => this._syncEditorToPreview(), 50);
          this._debounceScroll(() => this._resumeScroll(), 100);
        });
  
        // 预览滚动 → 同步编辑器（demo 的 onScroll 思路，方向相反）
        this.preview.addEventListener('scroll', () => {
          const container = document.querySelector('.editor-container');
          // 持续记录预览滚动位置（预览可见时）。edit/preview 切换恢复以及滚动同步都依赖它；
          // 预览折叠时其 scrollTop 不可靠，跳过以免覆盖有效值。
          if (this.activeTab && !container.classList.contains('preview-collapsed')) {
            this.activeTab.previewScrollTop = this.preview.scrollTop;
          }
          // 纯预览模式：编辑器隐藏，其滚动同步会提前退出，大纲须直接跟随预览内容。
          // 注意：先驱动虚拟预览懒加载（若需），再统一派生当前标题，避免漏渲染。
          if (container.classList.contains('preview-mode')) {
            if (this._previewVirtual && this.previewWindow) this._syncPreviewVirtualScroll();
            this.updateOutlineFromPreview();
            return;
          }
          // 纯预览模式 + 大文档虚拟滚动：驱动预览自身懒加载（拖到任意位置查看全文）
          if (container.classList.contains('preview-mode') && this._previewVirtual && this.previewWindow) {
            this._syncPreviewVirtualScroll();
            return;
          }
          if (!this.settings.scrollSync || !this._canScroll.preview) return;
          if (container.classList.contains('preview-collapsed')) return;
  
          this._canScroll.editor = false;
          this._throttleScroll(() => this._syncPreviewToEditor(), 50);
          this._debounceScroll(() => this._resumeScroll(), 100);
        });
  
        // ---- 行号点击选行 + 拖动连选 ----
        this._gutterDrag = null;
        this._gutterAnchor = null;
        this.cm.on('gutterClick', (cm, line, gutter, ev) => this.onGutterClick(cm, line, gutter, ev));
        this._gutterMouseMove = (e) => this.onGutterMouseMove(e);
        this._gutterMouseUp = (e) => this.onGutterMouseUp(e);
        document.addEventListener('mousemove', this._gutterMouseMove);
        document.addEventListener('mouseup', this._gutterMouseUp);
  
        // IME 适配说明：已切换到 inputStyle:'contenteditable'，IME 候选框由
        // WebView2 原生锚定在光标行下方（与浏览器行为一致），不再需要
        // compositionstart 滚动补偿。之前的滚动处理器在视口边缘行上会打断
        // composition（输入不了）+ 触发滚动反馈循环（页面乱滚），已移除。
      },
      _selectLineRange(cm, fromLine, toLine) {
        const a = Math.min(fromLine, toLine), b = Math.max(fromLine, toLine);
        const last = cm.lastLine();
        const end = b < last ? { line: b + 1, ch: 0 } : { line: b, ch: cm.getLine(b).length };
        cm.setSelection({ line: a, ch: 0 }, end);
      },
      onGutterClick(cm, line, gutter, ev) {
        if (ev.button !== 0) return;        // 仅左键
        ev.preventDefault();                // 阻止 CM 原生行选区/拖拽干扰
        if (ev.shiftKey) {
          const anchor = this._gutterAnchor == null ? cm.getCursor().line : this._gutterAnchor;
          this._gutterAnchor = anchor;
          this._gutterDrag = { anchor, startLine: anchor };
          this._selectLineRange(cm, anchor, line);
        } else {
          this._gutterAnchor = line;
          this._gutterDrag = { anchor: line, startLine: line };
          this._selectLineRange(cm, line, line);
        }
      },
      onGutterMouseMove(e) {
        const ds = this._gutterDrag;
        if (!ds) return;
        const pos = this.cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
        const line = Math.max(0, Math.min(this.cm.lastLine(), pos.line));
        this._selectLineRange(this.cm, ds.anchor, line);
      },
      onGutterMouseUp() {
        if (this._gutterDrag) {
          this._gutterAnchor = this._gutterDrag.anchor;
          this._gutterDrag = null;
        }
      },
  };

  const api = { mixin };
  window.TMEditorCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
