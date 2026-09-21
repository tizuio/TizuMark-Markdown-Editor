// Markdown 行内格式化与表格编辑
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';

  const mixin = {
      wrapSelection(before, after) {
        const sel = this.cm.getSelection();
        if (sel) {
          this.cm.replaceSelection(before + sel + after);
        } else {
          const cursor = this.cm.getCursor();
          this.cm.replaceRange(before + after, cursor);
          this.cm.setCursor({ line: cursor.line, ch: cursor.ch + before.length });
        }
        this.cm.focus();
      },
      insertAtCursor(text, cursorOffset) {
        const cursor = this.cm.getCursor();
        const prevLine = cursor.line > 0 ? this.cm.getLine(cursor.line - 1) : '';
        const needNewline = cursor.line > 0 && prevLine.trim() !== '';
        const prefix = needNewline ? '\n' : '';
        const addedLines = needNewline ? 1 : 0;
        this.cm.replaceRange(prefix + text, cursor);
        if (cursorOffset !== undefined) {
          this.cm.setCursor({ line: cursor.line + addedLines, ch: cursor.ch + cursorOffset });
        } else {
          this.cm.setCursor({ line: cursor.line + addedLines, ch: cursor.ch + text.length });
        }
        this.cm.focus();
      },
      insertImageBlock(text) {
        const cursor = this.cm.getCursor();
        const line = this.cm.getLine(cursor.line);
        const afterText = line.slice(cursor.ch);
        const prevLine = cursor.line > 0 ? this.cm.getLine(cursor.line - 1) : '';
        let prefix = '';
        let addedLines = 0;
        if (cursor.ch > 0 || (cursor.line > 0 && prevLine.trim() !== '')) {
          prefix = '\n';
          addedLines = 1;
        }
        this.cm.replaceRange(prefix + text + '\n' + afterText, cursor, { line: cursor.line, ch: line.length });
        this.cm.setCursor({ line: cursor.line + addedLines + 1, ch: 0 });
        this.cm.focus();
      },
      handleTaskCheckboxToggle(checkbox) {
        // 通过 li 的 data-source-line 反查源码行（remark plugin 给所有节点标注，1-based）
        const li = checkbox.closest('li');
        if (!li) return;
        const lineAttr = li.getAttribute('data-source-line');
        if (!lineAttr) return;
        const lineNum = parseInt(lineAttr, 10) - 1;  // 转 0-based
        if (isNaN(lineNum) || lineNum < 0 || lineNum >= this.cm.lineCount()) return;
        const lineText = this.cm.getLine(lineNum);
        // 匹配任务列表行：可选 > 前缀（引用块嵌套）+ 前缀（- * + 或 数字.）+ [ ] / [x] + 可选内容
        const taskRe = /^(\s*(?:>\s*)*(?:[*+-]|\d+[.)])\s+)\[([ xX])\](\s.*)?$/;
        const m = lineText.match(taskRe);
        if (!m) return;
        // 按源码标记取反作为目标态（与即将发生的原生 click 默认切换结果一致）。
        // 这里【不】手动设置 checkbox.checked：不 preventDefault，原生默认行为会把
        // checkbox 切到 newChecked 并自己重绘 :checked 样式；若我们抢先设了 checked，
        // 原生默认行为会在事件末尾再翻一次，反而错。
        const sourceChecked = m[2] === 'x' || m[2] === 'X';
        const newChecked = !sourceChecked;
        const newMark = newChecked ? 'x' : ' ';
        const newLine = m[1] + '[' + newMark + ']' + (m[3] || '');
        const cursor = this.cm.getCursor();
        // 预览 checkbox 已由原生 click 默认行为即时切到 newChecked（浏览器自绘，必然有响应）；
        // 抑制整篇重渲染，避免重复重建把即时勾选态覆盖 / 引发预览或编辑器跳动。
        this._suppressNextPreviewRerender = true;
        // 同时取消任何已排队的防抖重建（如打字 / setValue 触发的待执行 300ms 定时器）：
        // 否则勾选后那个遗留定时器仍会到期并整篇重建 preview，覆盖即时勾选并引发跳动/“看似没反应”。
        clearTimeout(this.debounceTimer);
        // 取消任何在途的滚动同步调度：用户刚滚动到勾选框、点击间隔 < 100ms 时，
        // 上一次滚动留下的 throttle 尾随 _syncPreviewToEditor / debounce _resumeScroll 会在
        // 本函数设的抑制窗口外补跑，越权把编辑器滚到别处。一并清掉，避免越权同步。
        this._scrollThrottleTimer = null;
        this._scrollThrottlePending = null;
        clearTimeout(this._scrollDebounceTimer);
        this._scrollDebounceTimer = null;
        // 记录编辑器滚动位置：cm.replaceRange/cm.setCursor 在某些 WebView 下会让 CodeMirror
        // 内部滚动编辑器（即便 setCursor scroll:false）。_canScroll 双标志只挡「滚动同步」、
        // 挡不住 CM 自身滚动，表现为「点完勾选框编辑器跳到别处」。故显式捕获并在变更后还原。
        const edScrollTop = this.cm.getScrollInfo().top;
        // 临时关闭滚动同步：cm.replaceRange/cm.setCursor 可能让编辑器自动滚动，
        // 触发 _syncEditorToPreview 把预览滚到光标行（任务列表某行），导致上方 H3「任务列表」
        // 被滚出视野顶部——表现为「点完之后预览框根本没有渲染出来」。
        // _resumeScroll 会在 100ms 后自动恢复 _canScroll 标志，不影响正常滚动同步。
        const prevCanScroll = { editor: this._canScroll.editor, preview: this._canScroll.preview };
        this._canScroll.editor = false;
        this._canScroll.preview = false;
        this.cm.replaceRange(newLine, { line: lineNum, ch: 0 }, { line: lineNum, ch: lineText.length });
        this.cm.setCursor(cursor, { scroll: false });  // 保持光标位置不跳动且不让编辑器自动滚动
        if (typeof edScrollTop === 'number') {
          this.cm.scrollTo(0, edScrollTop); // 立即还原编辑器滚动，消除 CM 内部滚动导致的跳动
          // 兜住 CM 在 operation 收尾时的异步滚动（下一帧），避免长时间错位闪烁
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => { if (typeof edScrollTop === 'number') this.cm.scrollTo(0, edScrollTop); });
          }
        }
        setTimeout(() => {
          // 安全网：若 CM 在变更后异步（rAF/operation 收尾）调整了编辑器滚动，再还原一次；
          // 此时 _canScroll.editor 仍为 false，scrollTo 触发的滚动事件被同步处理器忽略，不会联动预览。
          if (typeof edScrollTop === 'number') this.cm.scrollTo(0, edScrollTop);
          if (this._canScroll) {
            this._canScroll.editor = prevCanScroll.editor;
            this._canScroll.preview = prevCanScroll.preview;
          }
        }, 120);
        // activeTab.content 由 change 事件同步；预览 DOM 已就地更新，无需重渲染.
      },
      insertLinePrefix(prefix, ordered = false) {
        const cm = this.cm;
        // 有选区（跨行 / 多选区）：对选区覆盖的每一行逐行加前缀，用 operation 包裹保证一次 undo 撤销整批
        if (cm.somethingSelected()) {
          cm.operation(() => {
            const selections = cm.listSelections();
            const newSelections = [];
            for (const sel of selections) {
              const startLine = Math.min(sel.anchor.line, sel.head.line);
              const endLine = Math.max(sel.anchor.line, sel.head.line);
              let n = 1;
              for (let ln = startLine; ln <= endLine; ln++) {
                const text = cm.getLine(ln);
                // 单行替换不增删行，行号在循环中保持有效
                const linePrefix = ordered ? (n++) + '. ' : prefix;
                cm.replaceRange(linePrefix + text, { line: ln, ch: 0 }, { line: ln, ch: text.length });
              }
              // 选中整批改动行（行首到末行行尾），让用户直观看到加前缀后的范围
              const lastLineText = cm.getLine(endLine);
              newSelections.push({
                anchor: { line: startLine, ch: 0 },
                head: { line: endLine, ch: lastLineText.length },
              });
            }
            cm.setSelections(newSelections);
          });
          cm.focus();
          return;
        }
        // 无选区：原单行行为（含上一行非空时自动换行再加前缀）
        const cursor = cm.getCursor();
        const line = cm.getLine(cursor.line);
        const prevLine = cursor.line > 0 ? cm.getLine(cursor.line - 1) : '';
        const needNewline = cursor.line > 0 && prevLine.trim() !== '';
        const newLine = needNewline ? '\n' : '';
        cm.replaceRange(newLine + prefix + line, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
        cm.setCursor({ line: cursor.line + (needNewline ? 1 : 0), ch: prefix.length + cursor.ch });
        cm.focus();
      },
      // 标题快捷键：智能设置 / 切换标题层级（替代原先的「行首盲目加 #」）。
      // - 行首已是标题（^#{1,6}\s*）：目标层级不同 → 原位替换旧的 # 前缀（如 ## 标题 + Ctrl+3 → ### 标题）；
      //   目标层级相同 → 取消标题（移除 # 前缀回到正文，Typora 式 toggle）。
      // - 行首无标题标记：沿用 insertLinePrefix 的插入行为（含上一行非空时自动换行）。
      // 多行选区：对选区内每一行分别执行「替换 / 取消 / 追加」，不触发换行逻辑，整体一次 undo。
      applyHeadingLevel(level) {
        const cm = this.cm;
        const prefix = '#'.repeat(level) + ' ';
        const HEADING_RE = /^(#{1,6})\s*/;
  
        if (cm.somethingSelected()) {
          cm.operation(() => {
            const selections = cm.listSelections();
            const newSelections = [];
            for (const sel of selections) {
              const startLine = Math.min(sel.anchor.line, sel.head.line);
              const endLine = Math.max(sel.anchor.line, sel.head.line);
              for (let ln = startLine; ln <= endLine; ln++) {
                const text = cm.getLine(ln);
                const m = text.match(HEADING_RE);
                if (m) {
                  const newPrefix = m[1].length === level ? '' : prefix;
                  cm.replaceRange(newPrefix, { line: ln, ch: 0 }, { line: ln, ch: m[0].length });
                } else {
                  cm.replaceRange(prefix + text, { line: ln, ch: 0 }, { line: ln, ch: text.length });
                }
              }
              const lastLineText = cm.getLine(endLine);
              newSelections.push({
                anchor: { line: startLine, ch: 0 },
                head: { line: endLine, ch: lastLineText.length },
              });
            }
            cm.setSelections(newSelections);
          });
          cm.focus();
          return;
        }
  
        // 无选区：单行
        const cursor = cm.getCursor();
        const line = cm.getLine(cursor.line);
        const m = line.match(HEADING_RE);
        if (m) {
          const newPrefix = m[1].length === level ? '' : prefix;
          const delta = newPrefix.length - m[0].length;
          cm.replaceRange(newPrefix, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: m[0].length });
          const newCh = Math.max(0, Math.min(cursor.ch + delta, (newPrefix + line.slice(m[0].length)).length));
          cm.setCursor({ line: cursor.line, ch: newCh });
          cm.focus();
          return;
        }
        // 无标题标记 → 沿用原有插入行为（含上一行非空时自动换行）
        this.insertLinePrefix(prefix);
      },
      // 表格行内按 Enter 自动补充表格结构
      // 表格行内 Enter：整理整段表格（对齐/补齐分隔行/统一列数）并在当前行下方插入等列空白行。
      // 整理规则（用户反馈）：① 缺分隔行→自动补齐；② 分隔行数量不足→补全；
      // ③ 分隔行不规范（如 |--|）→规范为 | --- |；④ 各行列数不统一→缺失行补空白格；
      // ⑤ 单元格不规范（如 |内容 |）→规范为 | 内容 |。
      _handleTableEnter(cm) {
        const TABLE_ROW_RE = /^\|.*\|\s*$/;
        const TABLE_SEPARATOR_RE = /^\|\s*[-:][-:\s]*\|/;
        const pos = cm.getCursor();
        const line = cm.getLine(pos.line);
        // 非表格行或分隔行 → 走正常换行/列表延续
        if (!TABLE_ROW_RE.test(line) || TABLE_SEPARATOR_RE.test(line)) {
          this._newlineAndIndent(cm);
          return;
        }
        // 有选区 → 交回原有逻辑
        if (cm.somethingSelected()) {
          this._newlineAndIndent(cm);
          return;
        }
        // 计算列数
        const colCount = (line.match(/\|/g) || []).length - 1;
        if (colCount < 1) {
          this._newlineAndIndent(cm);
          return;
        }
        // 空表格行（去除 | 与空白后无内容）→ 退出表格：删除本行
        const stripped = line.replace(/\|/g, '').trim();
        if (stripped === '') {
          const nextLine = cm.getLine(pos.line + 1);
          if (nextLine !== undefined) {
            cm.replaceRange('', { line: pos.line, ch: 0 }, { line: pos.line + 1, ch: 0 });
          } else {
            // 最后一行：清空内容
            cm.replaceRange('', { line: pos.line, ch: 0 }, { line: pos.line, ch: line.length });
          }
          cm.setCursor({ line: pos.line, ch: 0 });
          return;
        }
        // 正常表格行 → 整理整段表格 + 在当前行下方插入等列空白新行
        cm.operation(() => {
          const res = this._normalizeTableBlock(cm, pos.line, TABLE_ROW_RE, TABLE_SEPARATOR_RE, pos.line);
          if (!res) { this._newlineAndIndent(cm); return; }
          cm.setCursor({ line: res.newRowLine, ch: 2 });
        });
      },
      // 在光标所在表格行下方插入等列空白行（同时整理整段表格），光标置于新行第一格。
      // 默认无键位，可在「自定义快捷键」中为 addTableRow 绑定（用户反馈：表格加行）。
      _addTableRow(cm) {
        if (!cm) return;
        const pos = cm.getCursor();
        const line = cm.getLine(pos.line);
        const TABLE_ROW_RE = /^\|.*\|\s*$/;
        const TABLE_SEPARATOR_RE = /^\|\s*[-:][-:\s]*\|/;
        if (!TABLE_ROW_RE.test(line) || TABLE_SEPARATOR_RE.test(line)) return; // 不在表格数据行 → 不操作
        const colCount = (line.match(/\|/g) || []).length - 1;
        if (colCount < 1) return;
        cm.operation(() => {
          const res = this._normalizeTableBlock(cm, pos.line, TABLE_ROW_RE, TABLE_SEPARATOR_RE, pos.line);
          if (res) cm.setCursor({ line: res.newRowLine, ch: 2 });
        });
        cm.focus();
      },
      // 在光标所在列右侧插入空白列（跨整段表格），光标置于新列首格。
      // 默认无键位，可在「自定义快捷键」中为 addTableColumn 绑定（用户反馈：表格加列）。
      _addTableColumn(cm) {
        if (!cm) return;
        const pos = cm.getCursor();
        const line = cm.getLine(pos.line);
        const TABLE_ROW_RE = /^\|.*\|\s*$/;
        const TABLE_SEPARATOR_RE = /^\|\s*[-:][-:\s]*\|/;
        if (!TABLE_ROW_RE.test(line)) return; // 不在表格行 → 不操作
        const colIdx = this._cursorColumnIndex(line, pos.ch); // 光标所在列（0 起）
        if (colIdx < 0) return;
        // 扩展表格块范围
        let start = pos.line, end = pos.line;
        while (start - 1 >= 0 && TABLE_ROW_RE.test(cm.getLine(start - 1))) start--;
        while (end + 1 <= cm.lastLine() && TABLE_ROW_RE.test(cm.getLine(end + 1))) end++;
        cm.operation(() => {
          let curStarts = null;
          for (let i = start; i <= end; i++) {
            const l = cm.getLine(i);
            const isSep = TABLE_SEPARATOR_RE.test(l);
            const cells = this._splitCells(l);
            const insertIdx = Math.min(colIdx + 1, cells.length); // 插到光标列右侧
            cells.splice(insertIdx, 0, isSep ? '---' : '');
            const { text, starts } = this._buildRow(cells);
            cm.replaceRange(text, { line: i, ch: 0 }, { line: i, ch: l.length });
            if (i === pos.line) curStarts = starts;
          }
          if (curStarts) {
            const target = Math.min(colIdx + 1, curStarts.length - 1);
            cm.setCursor({ line: pos.line, ch: curStarts[target] });
          }
        });
        cm.focus();
      },
      // 返回光标所在列的 0 起索引；越界时回落到最近列。
      _cursorColumnIndex(line, ch) {
        let pipes = 0;
        for (let i = 0; i < ch && i < line.length; i++) {
          if (line[i] === '|') pipes++;
        }
        // 首个 | 开启第 0 列，故列索引 = 其前的 | 数 - 1
        return Math.max(0, pipes - 1);
      },
      // 整理光标所在表格块：补齐/规范分隔行、统一单元格对齐与列数；可选在 blankAfterLine
      // 指定的原始数据行下方追加一条等列空白行。返回 { newRowLine }（追加行的绝对行号；未追加为 -1）。
      _normalizeTableBlock(cm, cursorLine, TABLE_ROW_RE, TABLE_SEPARATOR_RE, blankAfterLine) {
        let start = cursorLine, end = cursorLine;
        while (start - 1 >= 0 && TABLE_ROW_RE.test(cm.getLine(start - 1))) start--;
        while (end + 1 <= cm.lastLine() && TABLE_ROW_RE.test(cm.getLine(end + 1))) end++;
        const raws = [];
        for (let i = start; i <= end; i++) {
          const t = cm.getLine(i);
          raws.push({ text: t, isSep: TABLE_SEPARATOR_RE.test(t), origLine: i });
        }
        let colCount = 0;
        for (const r of raws) if (!r.isSep) colCount = Math.max(colCount, this._splitCells(r.text).length);
        if (colCount === 0) return null;
        const hasSep = raws.some((r) => r.isSep);
        const out = [];
        let newRowLine = -1;
        let pendingBlank = false; // 标记：在当前数据行之后（跨过紧随的分隔行）插入空白行
        const pushBlank = () => {
          const blankIdx = out.length;
          out.push(this._buildRow(Array(colCount).fill('')).text);
          newRowLine = start + blankIdx;
        };
        for (let i = 0; i < raws.length; i++) {
          const r = raws[i];
          if (r.isSep) {
            out.push(this._buildRow(this._normalizeSepCells(r.text, colCount)).text);
            if (pendingBlank) { pushBlank(); pendingBlank = false; }
            continue;
          }
          const cells = this._splitCells(r.text);
          while (cells.length < colCount) cells.push('');
          out.push(this._buildRow(cells).text);
          // 在指定数据行下方追加空白行（若紧随其后是分隔行，则延后到分隔行之后，保证表头→分隔→正文顺序）
          if (blankAfterLine != null && r.origLine === blankAfterLine) {
            pendingBlank = true;
          }
          // 缺分隔行 → 在首行（表头/首数据行）下方补齐
          if (!hasSep && i === 0 && !r.isSep) {
            out.push(this._buildRow(Array(colCount).fill('---')).text);
            if (pendingBlank) { pushBlank(); pendingBlank = false; }
          }
        }
        if (pendingBlank) pushBlank();
        const newText = out.join('\n');
        cm.replaceRange(newText, { line: start, ch: 0 }, { line: end, ch: cm.getLine(end).length });
        return { newRowLine };
      },
      // 把表格行拆分为单元格数组（去首尾 | 并按 | 切分、trim）。
      _splitCells(text) {
        let t = text.trim();
        if (t.startsWith('|')) t = t.slice(1);
        if (t.endsWith('|')) t = t.slice(0, -1);
        return t.split('|').map((c) => c.trim());
      },
      // 把单元格数组组装为标准表格行，返回 { text, starts }；starts[k] 为第 k 列内容起始 ch。
      _buildRow(cells) {
        let text = '| ';
        const starts = [];
        for (let k = 0; k < cells.length; k++) {
          starts.push(text.length);
          text += cells[k];
          if (k < cells.length - 1) text += ' | ';
        }
        text += ' |';
        return { text, starts };
      },
      // 规范分隔行单元格：保留对齐标记（:-- / --: / :-:），不足列数补 ---。
      _normalizeSepCells(sepText, colCount) {
        const cells = this._splitCells(sepText);
        while (cells.length < colCount) cells.push('---');
        return cells.map((c) => {
          const t = c.trim();
          const left = t.startsWith(':');
          const right = t.endsWith(':');
          let s = '---';
          if (left) s = ':' + s;
          if (right) s = s + ':';
          return s;
        });
      },
      _newlineAndIndent(cm) {
        const cmdName = 'newlineAndIndentContinueMarkdownList';
        if (CodeMirror.commands[cmdName]) {
          cm.execCommand(cmdName);
        } else {
          cm.execCommand('newlineAndIndent');
        }
      },
      insertBlock(text, cursorOffset) {
        const cursor = this.cm.getCursor();
        const line = this.cm.getLine(cursor.line);
        const needNewline = line.trim() !== '';
        const prefix = needNewline ? '\n\n' : '';
        const addedLines = needNewline ? 2 : 0;
        this.cm.replaceRange(prefix + text + '\n', cursor);
        if (cursorOffset !== undefined) {
          const before = text.substring(0, cursorOffset);
          const lastNewline = before.lastIndexOf('\n');
          const targetLine = cursor.line + addedLines + (before.split('\n').length - 1);
          const targetCh = lastNewline === -1 ? cursorOffset : (cursorOffset - lastNewline - 1);
          this.cm.setCursor({ line: targetLine, ch: targetCh });
        } else {
          const lines = text.split('\n');
          this.cm.setCursor({ line: cursor.line + addedLines + lines.length - 1, ch: lines[lines.length - 1].length });
        }
        this.cm.focus();
      },
      // 在光标所在行下方插入空行（不截断当前行），光标保持在原来位置（原行、原列），不移动到新行。
      insertLineBelow() {
        const cm = this.cm;
        if (!cm) return;
        const cur = cm.getCursor();
        const lineNo = cur.line;
        const lineLen = cm.getLine(lineNo).length;
        cm.operation(() => {
          // 在行尾追加换行 → 当前行光标后文本留在原行，不截断；下方生成一个新的空行。
          cm.replaceRange('\n', { line: lineNo, ch: lineLen });
          // 光标保持在原行、原列位置（新空行在其下方，原行内容不受影响）。
          cm.setCursor({ line: lineNo, ch: cur.ch });
        });
      },
      // 在光标所在行上方插入空行：原行整体下移，光标跟随原文本行、保持原列位置（不移动到新行）。
      insertLineAbove() {
        const cm = this.cm;
        if (!cm) return;
        const cur = cm.getCursor();
        const lineNo = cur.line;
        cm.operation(() => {
          // 在当前行行首插入换行 → 原行整体下移，上方生成一个新的空行。
          cm.replaceRange('\n', { line: lineNo, ch: 0 });
          // 原文本整体下移一行，光标跟随到原文本所在的新行（lineNo+1），保持原列位置。
          cm.setCursor({ line: lineNo + 1, ch: cur.ch });
        });
      },
  };

  const api = { mixin };
  window.TMFormat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
