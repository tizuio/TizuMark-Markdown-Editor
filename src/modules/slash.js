// slash 命令面板与排序
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { SLASH_FONT_ACTIONS, SLASH_FRONT_ACTIONS, DEFAULT_SLASH_HIDDEN } = TMConst;

  const mixin = {
      // ===== slash 命令面板（输入 / 触发的可插入语法快捷选择）=====
      // 按重度编辑用户的使用频率排序：高频块级语法置顶，结构化/边缘语法沉底；
      // 关键字含中/英/拼音以便过滤。上标/下标为纯 HTML 边缘标签，从面板移除（手写即可）。
      _buildSlashCommands() {
        if (this._slashCommands) return this._slashCommands;
        const base = [
          // 高频：标题骨架
          { action: 'insert-h1', label: '标题 1', hint: '#', keywords: ['h1', 'heading', 'title', 'biaoti', '1', 'yiji'] },
          { action: 'insert-h2', label: '标题 2', hint: '##', keywords: ['h2', 'heading', 'title', 'biaoti', '2', 'erji'] },
          { action: 'insert-h3', label: '标题 3', hint: '###', keywords: ['h3', 'heading', 'title', 'biaoti', '3', 'sanji'] },
          // 高频：列表与块级结构
          { action: 'insert-ul', label: '无序列表', hint: '-', keywords: ['ul', 'list', 'liebiao', 'wuxu', 'unordered'] },
          { action: 'insert-ol', label: '有序列表', hint: '1.', keywords: ['ol', 'list', 'liebiao', 'youxu', 'ordered'] },
          { action: 'insert-task', label: '任务列表', hint: '- [ ]', keywords: ['task', 'todo', 'renwu', 'checkbox', 'daiban'] },
          { action: 'insert-quote', label: '引用块', hint: '>', keywords: ['quote', 'yinyong'] },
          { action: 'insert-code-block', label: '代码块', hint: '```', keywords: ['code', 'block', 'daima', 'fence'] },
          { action: 'insert-table', label: '表格', hint: '| |', keywords: ['table', 'biaoge'] },
          // 高频：链接/图片/行内格式
          { action: 'insert-link', label: '链接', hint: '[]()', keywords: ['link', 'url', 'lianjie'] },
          { action: 'insert-image', label: '图片', hint: '![]()', keywords: ['image', 'img', 'tupian'] },
          { action: 'insert-bold', label: '加粗', hint: '**', keywords: ['bold', 'strong', 'jiacu'] },
          { action: 'insert-italic', label: '斜体', hint: '*', keywords: ['italic', 'xieti'] },
          { action: 'insert-inline-code', label: '行内代码', hint: '`', keywords: ['code', 'inline', 'daima', 'hangnei'] },
          // 中频：结构化文档
          { action: 'insert-hr', label: '水平线', hint: '---', keywords: ['hr', 'line', 'shuipingxian', 'fenge'] },
          { action: 'insert-toc', label: '目录 [TOC]', hint: '[TOC]', keywords: ['toc', 'contents', 'mulu'] },
          { action: 'insert-math-block', label: '数学公式', hint: '$$', keywords: ['math', 'formula', 'gongshi', 'tex', 'latex'] },
          { action: 'insert-mermaid', label: 'Mermaid 图表', hint: '```mermaid', keywords: ['mermaid', 'flow', 'liucheng', 'tu', 'chart'] },
          { action: 'insert-callout-note', label: 'Note 提示', hint: '> [!NOTE]', keywords: ['note', 'callout', 'tishi', 'prompt'] },
          { action: 'insert-callout-tip', label: 'Tip 建议', hint: '> [!TIP]', keywords: ['tip', 'callout', 'jianyi', 'suggestion'] },
          { action: 'insert-callout-warning', label: 'Warning 警告', hint: '> [!WARNING]', keywords: ['warning', 'callout', 'jinggao', 'alert'] },
          { action: 'insert-callout-important', label: 'Important 重要', hint: '> [!IMPORTANT]', keywords: ['important', 'callout', 'zhongyao'] },
          { action: 'insert-callout-caution', label: 'Caution 注意', hint: '> [!CAUTION]', keywords: ['caution', 'callout', 'zhuyi', 'notice'] },
          // 低频：偶用行内格式
          { action: 'insert-strikethrough', label: '删除线', hint: '~~', keywords: ['strikethrough', 'shanchuxian'] },
          { action: 'insert-highlight', label: '高亮', hint: '==', keywords: ['highlight', 'gaoliang', 'mark'] },
          // 低频：深层标题
          { action: 'insert-h4', label: '标题 4', hint: '####', keywords: ['h4', 'heading', 'title', 'biaoti', '4', 'siji'] },
          { action: 'insert-h5', label: '标题 5', hint: '#####', keywords: ['h5', 'heading', 'title', 'biaoti', '5', 'wuji'] },
          { action: 'insert-h6', label: '标题 6', hint: '######', keywords: ['h6', 'heading', 'title', 'biaoti', '6', 'liuji'] },
        ];
        this._slashBaseCatalog = base;
        this._slashCommands = this._applySlashLayout(base);
        return this._slashCommands;
      },
      // 按用户保存的 slashOrder 重排、slashHidden 过滤。
      // 新命令（不在 order 中）自动补到末尾，order 中的陈旧 id 忽略。纯函数式，便于测试。
      _applySlashLayout(catalog) {
        const order = this.settings.slashOrder || [];
        const hidden = new Set(this.settings.slashHidden || []);
        const byId = new Map();
        for (const c of catalog) byId.set(c.action, c);
        const seen = new Set();
        const out = [];
        for (const id of order) {
          const c = byId.get(id);
          if (c && !seen.has(id)) { out.push(c); seen.add(id); }
        }
        for (const c of catalog) if (!seen.has(c.action)) out.push(c);
        return out.filter((c) => !hidden.has(c.action));
      },
      // 输入 / 后在满足「行首或空格后」时触发；change.to 为输入后光标位置（/ 之后）
      _maybeTriggerSlash(cm, pos) {
        const line = cm.getLine(pos.line);
        if (!line || line[pos.ch - 1] !== '/') return;
        const prev = pos.ch > 1 ? line[pos.ch - 2] : '';
        // 仅行首（/ 位于索引 0）或 / 前为空白字符时触发，避免 and/or 等正文斜杠误触
        if (pos.ch !== 1 && !/\s/.test(prev)) return;
        this._openSlashPanel(pos);
      },
      _openSlashPanel(pos) {
        this._slashOpen = true;
        this._slashStart = { line: pos.line, ch: pos.ch - 1 }; // 记录 / 所在坐标
        this._slashQuery = '';
        this._slashSel = 0;
        this._renderSlashPanel();
      },
      // 面板开启时按光标位置重算 query；失焦/回退/换行列/含空格则关闭
      _updateSlashFromCursor() {
        const cur = this.cm.getCursor();
        if (!this._slashStart) { this._closeSlashPanel(); return; }
        if (cur.line !== this._slashStart.line) { this._closeSlashPanel(); return; }
        const line = this.cm.getLine(cur.line);
        if (!line || line[this._slashStart.ch] !== '/') { this._closeSlashPanel(); return; }
        if (cur.ch < this._slashStart.ch) { this._closeSlashPanel(); return; }
        const query = line.substring(this._slashStart.ch + 1, cur.ch);
        if (/\s/.test(query)) { this._closeSlashPanel(); return; } // 空格视为放弃，关闭面板
        this._slashQuery = query;
        this._slashSel = 0;
        this._renderSlashPanel();
      },
      _renderSlashPanel() {
        const q = this._slashQuery.trim().toLowerCase();
        const cmds = this._buildSlashCommands();
        const filtered = q === ''
          ? cmds
          : cmds.filter((c) => {
              if (c.label.toLowerCase().includes(q)) return true;
              return c.keywords.some((k) => k.toLowerCase().includes(q));
            });
        this._slashFiltered = filtered;
        if (filtered.length === 0) { this._closeSlashPanel(); return; }
        if (this._slashSel >= filtered.length) this._slashSel = 0;
  
        let panel = document.getElementById('slash-panel');
        if (!panel) {
          panel = document.createElement('div');
          panel.id = 'slash-panel';
          panel.className = 'slash-panel';
          document.body.appendChild(panel);
        }
        panel.innerHTML = '';
        filtered.forEach((c, i) => {
          const item = document.createElement('div');
          item.className = 'slash-item' + (i === this._slashSel ? ' selected' : '');
          item.dataset.idx = String(i);
  
          const label = document.createElement('span');
          label.className = 'slash-label';
          label.textContent = c.label;
          item.appendChild(label);
  
          if (c.hint) {
            const hintEl = document.createElement('span');
            hintEl.className = 'slash-hint';
            hintEl.textContent = c.hint;
            item.appendChild(hintEl);
          }
  
          // mousedown + preventDefault：避免编辑器失焦导致面板/光标错乱
          item.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            this._slashSel = i;
            this._slashConfirm();
          });
          item.addEventListener('mousemove', () => {
            if (this._slashSel !== i) {
              this._slashSel = i;
              this._renderSlashPanel();
            }
          });
  
          panel.appendChild(item);
        });
  
        // 面板底部「管理命令排序」入口：mousedown + preventDefault 保编辑器焦点，避免面板提前关闭
        const footer = document.createElement('div');
        footer.className = 'slash-footer';
        const manageBtn = document.createElement('button');
        manageBtn.type = 'button';
        manageBtn.className = 'slash-manage-btn';
        manageBtn.textContent = '管理命令排序';
        manageBtn.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.showSlashOrderDialog();
        });
        footer.appendChild(manageBtn);
        panel.appendChild(footer);
  
        // 定位到 / 光标处（window 坐标，配合 position:fixed）；无布局环境（如测试）下
        // cursorCoords 可能返回 null，跳过定位即可，不影响逻辑。
        const coords = this.cm.cursorCoords(this._slashStart, 'window');
        if (coords) {
          panel.style.left = coords.left + 'px';
          panel.style.top = (coords.bottom + 4) + 'px';
        }
        panel.classList.remove('hidden');
        const sel = panel.querySelector('.slash-item.selected');
        if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
      },
      _slashMove(dir) {
        const n = this._slashFiltered ? this._slashFiltered.length : 0;
        if (n === 0) return;
        this._slashSel = (this._slashSel + dir + n) % n;
        this._renderSlashPanel();
        const panel = document.getElementById('slash-panel');
        const sel = panel && panel.querySelector('.slash-item.selected');
        if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
      },
      _slashConfirm() {
        const cmd = this._slashFiltered && this._slashFiltered[this._slashSel];
        this._closeSlashPanel();
        if (!cmd) return;
        const from = { line: this._slashStart.line, ch: this._slashStart.ch }; // 含 /
        const to = this.cm.getCursor();
        this.cm.replaceRange('', from, to); // 删除 /query 文本，光标落到 / 之前
        this.executeMenuAction(cmd.action);
      },
      _closeSlashPanel() {
        this._slashOpen = false;
        this._slashQuery = '';
        this._slashSel = 0;
        this._slashFiltered = [];
        const panel = document.getElementById('slash-panel');
        if (panel) panel.classList.add('hidden');
      },
      // ===== slash 命令排序对话框（拖动排序 + 显隐）=====
      // 草稿独立于已保存设置，关闭/取消不污染设置；「完成」才写盘。
      showSlashOrderDialog() {
        // 打开排序对话框时先关掉可能还开着的 slash 面板
        this._closeSlashPanel();
        const baseIds = this._buildSlashBaseCatalogIds();
        // 草稿顺序：以已保存顺序为基准，补齐尚未持久化的新命令到末尾
        const saved = (this.settings.slashOrder && this.settings.slashOrder.length)
          ? this.settings.slashOrder.slice()
          : baseIds.slice();
        this._slashOrderDraft = saved.filter((id) => baseIds.includes(id));
        for (const id of baseIds) if (!this._slashOrderDraft.includes(id)) this._slashOrderDraft.push(id);
        // 默认隐藏 = 字体类（开关默认关闭），其余开关默认开启；已保存设置优先
        this._slashHiddenDraft = new Set(this.settings.slashHidden || DEFAULT_SLASH_HIDDEN);
        this._slashOrderOpen = true;
        this._renderSlashOrderList();
        const dlg = document.getElementById('slash-order-dialog');
        if (dlg) {
          const kp = dlg.querySelector('.dialog');
          if (kp && typeof window.resetDialog === 'function') window.resetDialog(kp);
          dlg.classList.remove('hidden');
        }
      },
      hideSlashOrderDialog() {
        this._slashOrderOpen = false;
        const dlg = document.getElementById('slash-order-dialog');
        if (dlg) dlg.classList.add('hidden');
      },
      // 写入设置并落盘；清 slash 命令缓存，下次输入 / 立即生效
      applySlashOrder() {
        this.settings.slashOrder = this._slashOrderDraft.slice();
        this.settings.slashHidden = [...this._slashHiddenDraft];
        this.saveSettings();
        this._slashCommands = null;
        this.hideSlashOrderDialog();
      },
      // 恢复默认：顺序回到内置默认序、字体类隐藏置底（其余默认显示）
      resetSlashOrder() {
        this._slashOrderDraft = this._buildSlashBaseCatalogIds();
        this._slashHiddenDraft = new Set(DEFAULT_SLASH_HIDDEN);
        this._renderSlashOrderList();
      },
      _buildSlashBaseCatalogIds() {
        // 与 _buildSlashCommands 的基础目录保持一致（仅取 action 顺序）。
        // 默认顺序：前置高频项 → 其余项（保持原相对顺序）→ 字体类置底（默认隐藏）。
        const all = [
          'insert-h1', 'insert-h2', 'insert-h3',
          'insert-ul', 'insert-ol', 'insert-task',
          'insert-quote', 'insert-code-block', 'insert-table',
          'insert-link', 'insert-image', 'insert-bold', 'insert-italic', 'insert-inline-code',
          'insert-hr', 'insert-toc', 'insert-math-block', 'insert-mermaid',
          'insert-callout-note', 'insert-callout-tip', 'insert-callout-warning', 'insert-callout-important', 'insert-callout-caution',
          'insert-strikethrough', 'insert-highlight',
          'insert-h4', 'insert-h5', 'insert-h6',
        ];
        const front = SLASH_FRONT_ACTIONS.filter((id) => all.includes(id));
        const font = SLASH_FONT_ACTIONS.filter((id) => all.includes(id));
        const middle = all.filter((id) => !front.includes(id) && !font.includes(id));
        return [...front, ...middle, ...font];
      },
      // 完整基础目录（含所有 28 项，供对话框渲染标签/hint，不受隐藏影响）
      _slashBaseCatalogFull() {
        if (!this._slashBaseCatalog) this._buildSlashCommands();
        return this._slashBaseCatalog;
      },
      _slashCatalogById(id) {
        return this._slashBaseCatalogFull().find((c) => c.action === id);
      },
      _renderSlashOrderList() {
        const list = document.getElementById('slash-order-list');
        if (!list) return;
        const full = this._slashBaseCatalogFull();
        const byId = new Map(full.map((c) => [c.action, c]));
        list.innerHTML = '';
        this._slashOrderDraft.forEach((id, idx) => {
          const cmd = byId.get(id);
          if (!cmd) return;
          const hidden = this._slashHiddenDraft.has(id);
          const row = document.createElement('div');
          row.className = 'slash-order-row' + (hidden ? ' hidden-cmd' : '');
          row.dataset.idx = String(idx);
  
          const handle = document.createElement('span');
          handle.className = 'slash-order-handle';
          handle.setAttribute('aria-hidden', 'true');
          handle.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="16" height="16"><circle cx="9" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>';
  
          const label = document.createElement('span');
          label.className = 'slash-order-label';
          label.textContent = cmd.label;
  
          const hint = document.createElement('span');
          hint.className = 'slash-order-hint';
          hint.textContent = cmd.hint || '';
  
          // 显隐开关：复用现有 .toggle / .toggle-slider
          const toggle = document.createElement('label');
          toggle.className = 'slash-order-toggle toggle';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !hidden;
          cb.addEventListener('change', () => {
            if (cb.checked) this._slashHiddenDraft.delete(id);
            else this._slashHiddenDraft.add(id);
            row.classList.toggle('hidden-cmd', !cb.checked);
          });
          const slider = document.createElement('span');
          slider.className = 'toggle-slider';
          toggle.appendChild(cb);
          toggle.appendChild(slider);
  
          row.appendChild(handle);
          row.appendChild(label);
          row.appendChild(hint);
          row.appendChild(toggle);
  
          handle.addEventListener('pointerdown', (e) => this._startSlashOrderDrag(e, idx, row));
          list.appendChild(row);
        });
      },
      // 指针事件拖拽重排（项目红线：页内拖拽用指针事件，不用 HTML5 DnD）。
    // 交互模型（用户原话：「拖出来浮动跟着鼠标然后放回去到对应位置」）：
    //   - mousedown in handle：克隆源行作为 ghost（position: fixed，跟手），源行加 dragging-source 视觉占位
    //   - mousemove：ghost 跟随鼠标；用一条蓝色线（.slash-order-drop-line）精准指示"将插入到哪两项之间"
    //   - mouseup：根据 ghost 中心 Y 计算目标位置，draft 一次性 splice + 重渲染；移除 ghost/占位/蓝线
    // 中间态不重排 list（保持其他行原位，避免实时重排造成视觉抖动与索引混乱）。
      _startSlashOrderDrag(e, idx, row) {
        e.preventDefault();
        const list = document.getElementById('slash-order-list');
        if (!list) return;
        const rect = row.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const offsetX = startX - rect.left;
        const offsetY = startY - rect.top;
        const curIdx = idx;
  
        // 创建 ghost：克隆源行，position: fixed 跟手（Z 抬高、阴影制造浮动感、不响应鼠标）
        const ghost = row.cloneNode(true);
        ghost.classList.add('slash-order-ghost');
        ghost.style.cssText = `position:fixed !important;left:${rect.left}px !important;top:${rect.top}px !important;width:${rect.width}px !important;height:${rect.height}px !important;z-index:9999 !important;pointer-events:none !important;margin:0 !important;`;
        document.body.appendChild(ghost);
  
        // 源行：原位置视觉占位（半透明）+ 行高保留，避免落点计算时位置跳变
        row.classList.add('dragging-source');
  
        // 蓝色插入线：随鼠标在 list 内流动，精准指示插入缝隙（置于某行之前 = 插入到该行之前）
        const dropLine = document.createElement('div');
        dropLine.className = 'slash-order-drop-line';
  
        // 计算插入位置（visible 列表下标）：第一个「中心在光标之上」的行之前
        const computeVisualInsert = (centerY) => {
          const rows = Array.from(list.querySelectorAll('.slash-order-row:not(.dragging-source)'));
          for (let i = 0; i < rows.length; i++) {
            const tr = rows[i].getBoundingClientRect();
            if (centerY < tr.top + tr.height / 2) return i;
          }
          return rows.length;
        };
  
        const placeDropLine = (centerY) => {
          const rows = Array.from(list.querySelectorAll('.slash-order-row:not(.dragging-source)'));
          const v = computeVisualInsert(centerY);
          if (v >= rows.length) list.appendChild(dropLine);
          else list.insertBefore(dropLine, rows[v]);
        };
  
        // 统一参考点：拖拽全程用「ghost 中心 Y」判定插入位置（与用户看到的浮动项一致），
        // 蓝线放置与松手落点共用同一数值，保证「所见即所得」。
        let ghostCenterY = rect.top + rect.height / 2; // 初始：源行中心
  
        const onMove = (ev) => {
          ghost.style.left = (ev.clientX - offsetX) + 'px';
          ghost.style.top = (ev.clientY - offsetY) + 'px';
          ghostCenterY = (ev.clientY - offsetY) + rect.height / 2;
          placeDropLine(ghostCenterY);
        };
  
        const onUp = () => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          const rows = Array.from(list.querySelectorAll('.slash-order-row:not(.dragging-source)'));
          let visualInsert = rows.length; // 默认末尾
          for (let i = 0; i < rows.length; i++) {
            const tr = rows[i].getBoundingClientRect();
            if (ghostCenterY < tr.top + tr.height / 2) { visualInsert = i; break; }
          }
          // 蓝线指示的 visible 下标即最终 draft 索引（移除 source 后按此下标插入），
          // 不再 +1——旧逻辑的 +1 会让落点落到蓝线所示位置的下一项。
          let targetDraftIdx = Math.max(0, Math.min(visualInsert, this._slashOrderDraft.length - 1));
          if (targetDraftIdx !== curIdx) {
            this._moveSlashOrderItem(curIdx, targetDraftIdx);
          }
          // 清理视觉状态并重渲染
          ghost.parentNode && ghost.parentNode.removeChild(ghost);
          if (dropLine.parentNode) dropLine.parentNode.removeChild(dropLine);
          list.querySelectorAll('.dragging-source').forEach(el => el.classList.remove('dragging-source'));
          this._renderSlashOrderList();
        };
  
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      },
      _moveSlashOrderItem(from, to) {
        const n = this._slashOrderDraft.length;
        if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
        const moved = this._slashOrderDraft.splice(from, 1)[0];
        this._slashOrderDraft.splice(to, 0, moved);
      },
    // slash 命令面板开启时，方向键/回车/Tab/Esc 优先在此拦截，阻断 CodeMirror 的
    // 光标移动/换行/缩进默认行为，由面板自身处理导航与确认；面板关闭后这些键恢复常态。
    _handleSlashKeydown(e) {
      if (this._slashOpen) {
        switch (e.key) {
          case 'ArrowDown': e.preventDefault(); e.stopPropagation(); this._slashMove(1); return true;
          case 'ArrowUp': e.preventDefault(); e.stopPropagation(); this._slashMove(-1); return true;
          case 'Enter':
          case 'Tab': e.preventDefault(); e.stopPropagation(); this._slashConfirm(); return true;
          case 'Escape': e.preventDefault(); e.stopPropagation(); this._closeSlashPanel(); return true;
          default: break;
        }
        // 面板开启但未命中导航键：继续后续处理（保持原 if/return 链语义）
      }
      // slash 命令排序对话框开启时，Esc 关闭（草稿不保存）
      if (this._slashOrderOpen && e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); this.hideSlashOrderDialog(); return true;
      }
      return false;
    },

  };

  const api = { mixin };
  window.TMSlash = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
