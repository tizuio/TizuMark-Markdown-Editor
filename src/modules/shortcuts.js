// 快捷键预设、录制、冲突检测与渲染
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { Tab } = TMConst;

  const mixin = {
      getDefaultShortcuts() {
        return {
          newFile: { key: 'Ctrl+N', label: '新建' },
          openFile: { key: 'Ctrl+O', label: '打开' },
          saveFile: { key: 'Ctrl+S', label: '保存' },
          closeTab: { key: 'Ctrl+W', label: '关闭标签页' },
          find: { key: 'Ctrl+F', label: '查找替换' },
          nextTab: { key: 'Ctrl+Tab', label: '下一个标签页' },
          prevTab: { key: 'Ctrl+Shift+Tab', label: '上一个标签页' },
          bold: { key: 'Ctrl+B', label: '加粗' },
          italic: { key: 'Ctrl+I', label: '斜体' },
          insertLink: { key: 'Ctrl+K', label: '插入链接' },
          exportPDF: { key: 'Ctrl+Shift+P', label: '导出 PDF' },
          inlineCode: { key: 'Ctrl+Shift+`', label: '行内代码' },
          strikethrough: { key: 'Ctrl+Shift+5', label: '删除线' },
          codeBlock: { key: 'Ctrl+Shift+K', label: '代码块' },
          blockquote: { key: 'Ctrl+Shift+Q', label: '引用块' },
          toggleView: { key: 'Ctrl+\\', label: '切换视图' },
          toggleSidebar: { key: '', label: '切换侧边栏' },
          toggleTheme: { key: 'Ctrl+Shift+T', label: '切换主题' },
          saveAs: { key: '', label: '另存为' },
          crossSearch: { key: 'Ctrl+H', label: '跨文件搜索' },
          insertTable: { key: '', label: '插入表格' },
          insertImage: { key: 'Ctrl+Shift+I', label: '插入图片' },
          insertUl: { key: '', label: '无序列表' },
          insertOl: { key: '', label: '有序列表' },
          insertTask: { key: '', label: '任务列表' },
          insertHr: { key: '', label: '水平线' },
          highlight: { key: '', label: '高亮标记' },
          insertSuperscript: { key: '', label: '上标' },
          insertSubscript: { key: '', label: '下标' },
          insertH1: { key: 'Ctrl+1', label: '标题1' },
          insertH2: { key: 'Ctrl+2', label: '标题2' },
          insertH3: { key: 'Ctrl+3', label: '标题3' },
          insertH4: { key: 'Ctrl+4', label: '标题4' },
          insertH5: { key: 'Ctrl+5', label: '标题5' },
          insertH6: { key: 'Ctrl+6', label: '标题6' },
          insertMathBlock: { key: 'Ctrl+Shift+M', label: '数学公式' },
          insertMermaid: { key: '', label: 'Mermaid 图表' },
          insertToc: { key: '', label: '目录' },
          insertCalloutNote: { key: '', label: 'Note 提示' },
          insertCalloutTip: { key: '', label: 'Tip 建议' },
          insertCalloutWarning: { key: '', label: 'Warning 警告' },
          insertCalloutCaution: { key: '', label: 'Caution 注意' },
          insertCalloutImportant: { key: '', label: 'Important 重要' },
          closeToTray: { key: '', label: '关闭到托盘' },
          // 文件树/编辑器增强（合并自 PR #36）：文件搜索为 VS Code 风格 Ctrl+P，
          // 原 Ctrl+P 的「导出 PDF」迁到 Ctrl+Shift+P（见 loadShortcuts 迁移逻辑）。
          fileSearch: { key: 'Ctrl+P', label: '文件搜索' },
          moveLineUp: { key: 'Alt+Up', label: '上移行/选区' },
          moveLineDown: { key: 'Alt+Down', label: '下移行/选区' },
          // Eclipse/VS Code 风格：在当前行下方/上方插入空行，光标移到新行行首，不截断当前行、不继承缩进
          insertLineBelow: { key: 'Ctrl+Enter', label: '在下方插入行' },
          insertLineAbove: { key: 'Ctrl+Shift+Enter', label: '在上方插入行' },
          // 表格编辑增强（用户反馈）：Enter 已在表格内自动整理；加行/加列默认无键位，
          // 可在「自定义快捷键」中绑定（避免占用 Ctrl+F 等高频键）。
          addTableRow: { key: '', label: '表格插入行' },
          addTableColumn: { key: '', label: '表格插入列' },
        };
      },
      getShortcutPresets() {
        // 每个方案仅列出“有键”的 actionId；缺失项在 applyShortcutScheme 中回落为空串。
        // 方案内部键位已保证互不重复；空值用省略表示。
        return {
          vscode: {
            newFile:'Ctrl+N', openFile:'Ctrl+O', saveFile:'Ctrl+S', saveAs:'Ctrl+Shift+S',
            closeTab:'Ctrl+W', find:'Ctrl+F', crossSearch:'Ctrl+H',
            nextTab:'Ctrl+Tab', prevTab:'Ctrl+Shift+Tab',
            bold:'', italic:'Ctrl+I', inlineCode:'Ctrl+`', insertLink:'Ctrl+K',
            insertMathBlock:'Ctrl+Shift+M', toggleTheme:'Ctrl+Shift+T', fileSearch:'Ctrl+P',
            // VS Code 特色绑定（合并自 PR #36）：Ctrl+B 切换侧边栏（与 bold 冲突，bold 留空可自定义）；
            // Ctrl+P 为文件搜索（VS Code Quick Open），原「导出 PDF」迁到 Ctrl+Shift+P（见 default 方案）。
            toggleSidebar:'Ctrl+B',
            insertLineBelow:'Ctrl+Enter', insertLineAbove:'Ctrl+Shift+Enter',
          },
          typora: {
            newFile:'Ctrl+N', openFile:'Ctrl+O', saveFile:'Ctrl+S', closeTab:'Ctrl+W',
            find:'Ctrl+F', crossSearch:'Ctrl+H',
            nextTab:'Ctrl+Tab', prevTab:'Ctrl+Shift+Tab',
            bold:'Ctrl+B', italic:'Ctrl+I', insertLink:'Ctrl+K', exportPDF:'Ctrl+P', fileSearch:'',
            inlineCode:'Ctrl+Shift+`', strikethrough:'Ctrl+Shift+5', codeBlock:'Ctrl+Shift+K',
            blockquote:'Ctrl+Shift+Q', toggleTheme:'Ctrl+Shift+T',
            insertImage:'Ctrl+Shift+I', insertMathBlock:'Ctrl+Shift+M',
            insertH1:'Ctrl+1', insertH2:'Ctrl+2', insertH3:'Ctrl+3', insertH4:'Ctrl+4',
            insertH5:'Ctrl+5', insertH6:'Ctrl+6',
            insertLineBelow:'Ctrl+Enter', insertLineAbove:'Ctrl+Shift+Enter',
          },
          sublime: {
            newFile:'Ctrl+N', openFile:'Ctrl+O', saveFile:'Ctrl+S', saveAs:'Ctrl+Shift+S',
            closeTab:'Ctrl+W', find:'Ctrl+F', crossSearch:'Ctrl+H',
            nextTab:'Ctrl+Tab', prevTab:'Ctrl+Shift+Tab',
            exportPDF:'Ctrl+P', toggleTheme:'Ctrl+Shift+T', fileSearch:'',
            insertLineBelow:'Ctrl+Enter', insertLineAbove:'Ctrl+Shift+Enter',
          },
        };
      },
      // 预览方案：把预置键位加载到 this.shortcuts 并渲染列表（供用户「随意切换」查看），
      // 不持久化、不应用 CM（编辑器实际键位不变）；点快捷键对话框「确认」按钮才正式生效。
      previewShortcutScheme(name) {
        if (name === 'custom') {
          // 自定义方案：预览已保存/编辑中的自定义键位（不含其他方案的临时预览值）
          this.shortcuts = this.loadShortcuts();
          this.shortcutScheme = 'custom';
          this.renderShortcutsList();
          return;
        }
        const defaults = this.getDefaultShortcuts();
        let next;
        if (name === 'default') {
          next = JSON.parse(JSON.stringify(defaults)); // 整体恢复默认键位
        } else {
          const preset = this.getShortcutPresets()[name];
          if (!preset) return;
          next = {};
          for (const [aid, def] of Object.entries(defaults)) {
            const k = preset[aid];
            next[aid] = { key: (k != null ? k : ''), label: def.label };
          }
        }
        this.shortcuts = next;
        this.shortcutScheme = name;
        this.renderShortcutsList();
      },
      applyShortcutScheme(name) {
        if (name === 'custom') {
          this.shortcutScheme = 'custom';
          this.saveShortcutScheme('custom');
          return;
        }
        const defaults = this.getDefaultShortcuts();
        let next;
        if (name === 'default') {
          next = JSON.parse(JSON.stringify(defaults)); // 整体恢复默认键位
        } else {
          const preset = this.getShortcutPresets()[name];
          if (!preset) return;
          next = {};
          for (const [aid, def] of Object.entries(defaults)) {
            const k = preset[aid];
            next[aid] = { key: (k != null ? k : ''), label: def.label };
          }
        }
        this.shortcuts = next;
        this.shortcutScheme = name;
        this.saveShortcuts();
        this.saveShortcutScheme(name);
        this.renderShortcutsList();
        this.applyShortcuts();
      },
      // 归一化单条快捷键：兼容旧版字符串格式、补齐缺失字段、损坏 key 回落默认，
      // 自愈 localStorage 中残留的旧/损坏数据，确保加粗等键位不会因数据格式变更而丢失。
      _normalizeShortcutEntry(raw, def) {
        const dKey = def && def.key ? def.key : '';
        const dLabel = def && def.label ? def.label : '';
        if (raw == null) return { key: dKey, label: dLabel };
        // 旧版曾把 bold 等存成字符串（"Ctrl+B"）而非 {key,label} 对象
        if (typeof raw === 'string') {
          const k = raw.trim();
          return { key: k, label: dLabel };
        }
        if (typeof raw === 'object') {
          let key = (typeof raw.key === 'string') ? raw.key.trim() : '';
          if (key === '') key = dKey; // 旧数据 key 缺失/损坏 → 回落默认键（自愈）
          const label = (typeof raw.label === 'string' && raw.label.trim()) ? raw.label.trim() : dLabel;
          return { key, label };
        }
        return { key: dKey, label: dLabel };
      },
      // 以 defaults 为基准逐项归一化 saved：未知项丢弃、缺失项落默认、字符串/损坏项自愈。
      _normalizeShortcuts(saved, defaults) {
        const out = {};
        for (const [aid, def] of Object.entries(defaults)) {
          out[aid] = this._normalizeShortcutEntry(saved ? saved[aid] : undefined, def);
        }
        return out;
      },
      loadShortcuts() {
        const defaults = this.getDefaultShortcuts();
        try {
          const parsed = JSON.parse(localStorage.getItem('tizumark-shortcuts'));
          const saved = this._validConfigObject(parsed);
          const merged = this._normalizeShortcuts(saved, defaults);
          // 迁移：crossSearch 受输入法/保留键拦截的键位，统一迁到 Ctrl+H（不受输入法拦截）。
          // 此前中间版本用过 Ctrl+Shift+F / Ctrl+Shift+L，也一并迁移到 Ctrl+H。
          if (merged.crossSearch && (merged.crossSearch.key === 'Ctrl+Shift+F' || merged.crossSearch.key === 'Ctrl+Shift+L')) {
            merged.crossSearch = { ...merged.crossSearch, key: 'Ctrl+H' };
          }
          // 迁移：findReplace / previewFind 不再作为独立快捷键项（与 find 是同一功能），清理残留。
          if (merged.findReplace) delete merged.findReplace;
          if (merged.previewFind) delete merged.previewFind;
          // 迁移：fileSearch 现占用 Ctrl+P（VS Code Quick Open 风格），若用户旧配置仍把
          // exportPDF 绑在 Ctrl+P（旧默认），将 exportPDF 迁到 Ctrl+Shift+P，避免二者冲突。
          if (merged.fileSearch && merged.fileSearch.key === 'Ctrl+P' && merged.exportPDF && merged.exportPDF.key === 'Ctrl+P') {
            merged.exportPDF = { ...merged.exportPDF, key: 'Ctrl+Shift+P' };
          }
          return merged;
        } catch {
          return defaults;
        }
      },
      saveShortcuts() {
        try { localStorage.setItem('tizumark-shortcuts', JSON.stringify(this.shortcuts)); } catch {}
      },
      loadShortcutScheme() {
        const VALID = ['default', 'vscode', 'typora', 'sublime', 'custom'];
        const stored = localStorage.getItem('tizumark-shortcut-scheme');
        if (stored && VALID.includes(stored)) return stored; // 白名单校验，防脏数据
        // 旧数据无 scheme：与默认逐项比对，有差异视为自定义（保留用户旧自定义数据）
        const def = this.getDefaultShortcuts();
        const cur = this.shortcuts || def;
        for (const [aid, d] of Object.entries(def)) {
          if ((cur[aid] && cur[aid].key || '') !== (d.key || '')) return 'custom';
        }
        return 'default';
      },
      saveShortcutScheme(name) {
        try { localStorage.setItem('tizumark-shortcut-scheme', name); } catch {}
      },
      _markShortcutCustom() {
        if (this.shortcutScheme !== 'custom') {
          this.shortcutScheme = 'custom';
          this.saveShortcutScheme('custom');
        }
      },
      clearShortcut(action) {
        // 仅更新面板内编辑草稿（内存），不落盘、不应用；点「确认」才生效
        this.shortcuts[action].key = '';
        if (this.shortcutScheme !== 'custom') this.shortcutScheme = 'custom';
        this.renderShortcutsList();
      },
      resetShortcuts() {
        // 仅把面板内各选项值重置为默认（内存草稿预览），不落盘、不立即应用到 CM。
        // 必须点「确认」按钮才正式生效；未确认关闭面板后，重开仍读 localStorage 旧值。
        this.shortcuts = this.getDefaultShortcuts();
        this.shortcutScheme = 'default';
        this.renderShortcutsList();
        this.setStatus(this.t('shortcutsReset'));
      },
      formatShortcutDisplay(key) {
        if (!key) return `<span class="shortcut-key shortcut-key-empty">${this.t('none')}</span>`;
        // 方向键 / 功能键映射为更直观的符号，键位显示更紧凑美观
        const SYM = {
          ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
          Home: 'Home', End: 'End', Backspace: '⌫', Delete: '⌦',
          Enter: '↵', Space: 'Space', Escape: 'Esc', Tab: 'Tab',
        };
        const inner = key.split('+').map(k => `<kbd>${SYM[k] || k}</kbd>`).join('<span class="key-separator">+</span>');
        return `<span class="shortcut-key">${inner}</span>`;
      },
      // 系统内置、固定不可由用户改写的快捷键（附通俗解释）。
      // 结构化数据（含 combo/group/name/desc）不便塞进「值为字符串」的 i18n 字典，
      // 故在此按语言返回，combo 用录制规范格式（与 handleShortcutRecording 产出一致），
      // 便于冲突校验直接比对；group 用于在内置区内再细分（nav=光标与选区 / edit=编辑通用）。
      getBuiltinFixedShortcuts() {
        const ZH = [
          { combo: 'Ctrl+Home', group: 'nav', name: '跳到开头', desc: '把光标移到整篇文档的最前面' },
          { combo: 'Ctrl+End', group: 'nav', name: '跳到结尾', desc: '把光标移到整篇文档的最后面' },
          { combo: 'Shift+Ctrl+Home', group: 'nav', name: '选到开头', desc: '从光标位置一路选中到文档开头' },
          { combo: 'Shift+Ctrl+End', group: 'nav', name: '选到结尾', desc: '从光标位置一路选中到文档结尾' },
          { combo: 'Ctrl+ArrowLeft', group: 'nav', name: '按词左移', desc: '光标向左跳过一个完整的词' },
          { combo: 'Ctrl+ArrowRight', group: 'nav', name: '按词右移', desc: '光标向右跳过一个完整的词' },
          { combo: 'Shift+Ctrl+ArrowLeft', group: 'nav', name: '向左选词', desc: '按住 Shift，再向左按词选中文本' },
          { combo: 'Shift+Ctrl+ArrowRight', group: 'nav', name: '向右选词', desc: '按住 Shift，再向右按词选中文本' },
          { combo: 'Ctrl+Z', group: 'edit', name: '撤销', desc: '撤销上一步操作' },
          { combo: 'Ctrl+Y', group: 'edit', name: '重做', desc: '恢复刚刚被撤销的操作' },
          { combo: 'Ctrl+A', group: 'edit', name: '全选', desc: '选中编辑器里的全部内容' },
          { combo: 'Ctrl+C', group: 'edit', name: '复制', desc: '把选中的文本复制到剪贴板' },
          { combo: 'Ctrl+X', group: 'edit', name: '剪切', desc: '把选中的文本剪切到剪贴板' },
          { combo: 'Ctrl+V', group: 'edit', name: '粘贴', desc: '在光标处粘贴剪贴板内容' },
          { combo: 'Tab', group: 'edit', name: '增加缩进', desc: '为当前行或选中的多行增加一级缩进' },
          { combo: 'Shift+Tab', group: 'edit', name: '减少缩进', desc: '为当前行或选中的多行减少一级缩进' },
        ];
        const EN = [
          { combo: 'Ctrl+Home', group: 'nav', name: 'Go to start', desc: 'Move the cursor to the very beginning of the document' },
          { combo: 'Ctrl+End', group: 'nav', name: 'Go to end', desc: 'Move the cursor to the very end of the document' },
          { combo: 'Shift+Ctrl+Home', group: 'nav', name: 'Select to start', desc: 'Select from the cursor all the way to the document start' },
          { combo: 'Shift+Ctrl+End', group: 'nav', name: 'Select to end', desc: 'Select from the cursor all the way to the document end' },
          { combo: 'Ctrl+ArrowLeft', group: 'nav', name: 'Word left', desc: 'Move the cursor left by one whole word' },
          { combo: 'Ctrl+ArrowRight', group: 'nav', name: 'Word right', desc: 'Move the cursor right by one whole word' },
          { combo: 'Shift+Ctrl+ArrowLeft', group: 'nav', name: 'Select word left', desc: 'Hold Shift to select words to the left' },
          { combo: 'Shift+Ctrl+ArrowRight', group: 'nav', name: 'Select word right', desc: 'Hold Shift to select words to the right' },
          { combo: 'Ctrl+Z', group: 'edit', name: 'Undo', desc: 'Undo the last action' },
          { combo: 'Ctrl+Y', group: 'edit', name: 'Redo', desc: 'Redo the last undone action' },
          { combo: 'Ctrl+A', group: 'edit', name: 'Select all', desc: 'Select everything in the editor' },
          { combo: 'Ctrl+C', group: 'edit', name: 'Copy', desc: 'Copy the selected text to the clipboard' },
          { combo: 'Ctrl+X', group: 'edit', name: 'Cut', desc: 'Cut the selected text to the clipboard' },
          { combo: 'Ctrl+V', group: 'edit', name: 'Paste', desc: 'Paste clipboard content at the cursor' },
          { combo: 'Tab', group: 'edit', name: 'Indent', desc: 'Add one level of indent to the line or selection' },
          { combo: 'Shift+Tab', group: 'edit', name: 'Outdent', desc: 'Remove one level of indent from the line or selection' },
        ];
        const lang = (this.settings && this.settings.language) || 'zh';
        return lang === 'en' ? EN : ZH;
      },
      // 把任意来源的键位字符串规范化为「小写修饰键 + 小写主键」的规范串，
      // 用于冲突比对（不区分 Ctrl/Control、修饰键顺序、字母大小写）。
      _normalizeShortcutKey(key) {
        if (!key) return '';
        const mods = [];
        let main = '';
        for (const p of key.split('+')) {
          const up = p.trim().toLowerCase();
          if (up === 'ctrl' || up === 'control') mods.push('ctrl');
          else if (up === 'shift') mods.push('shift');
          else if (up === 'alt') mods.push('alt');
          else if (up === 'meta' || up === 'cmd') mods.push('meta');
          else main = up;
        }
        return [...mods.sort(), main].join('+');
      },
      // 查询某键位是否已被某个「内置固定快捷键」占用，命中返回该条目，否则 null。
      findBuiltinShortcut(key) {
        if (!key) return null;
        const norm = this._normalizeShortcutKey(key);
        for (const item of this.getBuiltinFixedShortcuts()) {
          if (this._normalizeShortcutKey(item.combo) === norm) return item;
        }
        return null;
      },
      updateShortcutHints() {
        const s = this.shortcuts;
        const map = {
          'insert-bold': 'bold',
          'insert-italic': 'italic',
          'insert-strikethrough': 'strikethrough',
          'insert-inline-code': 'inlineCode',
          'insert-highlight': 'highlight',
          'insert-code-block': 'codeBlock',
          'insert-table': 'insertTable',
          'insert-quote': 'blockquote',
          'insert-hr': 'insertHr',
          'insert-ul': 'insertUl',
          'insert-ol': 'insertOl',
          'insert-task': 'insertTask',
          'insert-link': 'insertLink',
          'insert-image': 'insertImage',
          // find-replace / preview-find 菜单项与 find 是同一功能（toggleFindPanel），
          // 提示统一显示 find 的键位
          'find-replace': 'find',
          'preview-find': 'find',
          'insert-superscript': 'insertSuperscript',
          'insert-subscript': 'insertSubscript',
          'insert-h1': 'insertH1',
          'insert-h2': 'insertH2',
          'insert-h3': 'insertH3',
          'insert-h4': 'insertH4',
          'insert-h5': 'insertH5',
          'insert-h6': 'insertH6',
          'insert-math-block': 'insertMathBlock',
          'insert-mermaid': 'insertMermaid',
          'insert-toc': 'insertToc',
          'insert-callout-note': 'insertCalloutNote',
          'insert-callout-tip': 'insertCalloutTip',
          'insert-callout-warning': 'insertCalloutWarning',
          'insert-callout-caution': 'insertCalloutCaution',
          'insert-callout-important': 'insertCalloutImportant',
        };
        const idMap = {
          'btn-new': 'newFile',
          'btn-open': 'openFile',
          'btn-save': 'saveFile',
          'btn-save-as': 'saveAs',
          'btn-export-pdf': 'exportPDF',
        };
        for (const [action, id] of Object.entries(map)) {
          const els = document.querySelectorAll(`[data-action="${action}"] .shortcut`);
          const key = s[id]?.key;
          for (const el of els) {
            el.textContent = key || '';
          }
        }
        for (const [elId, id] of Object.entries(idMap)) {
          const el = document.getElementById(elId);
          if (!el) continue;
          const span = el.querySelector('.shortcut');
          if (!span) continue;
          span.textContent = s[id]?.key || '';
        }
      },
      renderShortcutsList() {
        const container = document.getElementById('shortcuts-list');
        const labels = this.t('shortcutLabel');
        const groupLabels = this.t('shortcutGroup') || {};
        // 按功能分组展示，便于在长列表中查找
        const groups = [
          { key: 'file', ids: ['newFile', 'openFile', 'saveFile', 'saveAs', 'closeTab', 'exportPDF', 'closeToTray'] },
          { key: 'search', ids: ['find', 'crossSearch', 'fileSearch'] },
          { key: 'tabView', ids: ['nextTab', 'prevTab', 'toggleView', 'toggleSidebar', 'toggleTheme'] },
          { key: 'format', ids: ['bold', 'italic', 'strikethrough', 'inlineCode', 'highlight', 'insertSuperscript', 'insertSubscript', 'moveLineUp', 'moveLineDown', 'insertLineBelow', 'insertLineAbove'] },
          { key: 'insert', ids: ['insertLink', 'insertImage', 'insertTable', 'addTableRow', 'addTableColumn', 'insertUl', 'insertOl', 'insertTask', 'insertHr', 'codeBlock', 'blockquote', 'insertMathBlock', 'insertMermaid', 'insertToc'] },
          { key: 'heading', ids: ['insertH1', 'insertH2', 'insertH3', 'insertH4', 'insertH5', 'insertH6'] },
          { key: 'callout', ids: ['insertCalloutNote', 'insertCalloutTip', 'insertCalloutWarning', 'insertCalloutCaution', 'insertCalloutImportant'] },
        ];
  
        // 折叠状态在对话框会话内保持（重渲染不丢失用户的展开/收起选择）。
        // 内置区默认收缩（内容多、且不可改），放在顶部；方案与自定义默认展开。
        if (!this._sectionCollapsed) this._sectionCollapsed = { builtin: false, config: false };
  
        // —— 可配置区（方案与自定义）：保留原有按功能分组 + 录制/清除按钮 ——
        const configGroupsHtml = groups.map(group => {
          const rows = group.ids
            .filter(id => this.shortcuts[id])
            .map(id => {
              const shortcut = this.shortcuts[id];
              const isRecording = this.recordingAction === id;
              const label = labels[id] || shortcut.label || id;
              return `
            <div class="shortcut-row" data-action="${id}">
              <span class="shortcut-label">${label}</span>
                <div class="shortcut-actions">
                  ${this.formatShortcutDisplay(shortcut.key)}
                  <button class="shortcut-record-btn${isRecording ? ' recording' : ''}" data-action="${id}">${isRecording ? this.t('pressKeys') : this.t('modify')}</button>
                  <button class="shortcut-clear-btn" data-action="${id}">${this.t('clear')}</button>
                </div>
            </div>`;
            }).join('');
          if (!rows) return '';
          return `
            <div class="shortcut-group">
              <div class="shortcut-group-title">${groupLabels[group.key] || group.key}</div>
              ${rows}
            </div>`;
        }).join('');
  
        // —— 内置固定区：不可改，紧凑两列表格（快捷键 | 名称+说明）——
        const builtin = this.getBuiltinFixedShortcuts();
        const builtinTable = (grp, title) => {
          const rows = builtin.filter(b => b.group === grp);
          if (!rows.length) return '';
          const body = rows.map(b => `
              <tr class="shortcut-builtin-row">
                <td class="shortcut-builtin-key">${this.formatShortcutDisplay(b.combo)}</td>
                <td class="shortcut-builtin-meta">
                  <span class="shortcut-label">${b.name}</span>
                  <span class="shortcut-builtin-desc">${b.desc}</span>
                </td>
              </tr>`).join('');
          return `
            <div class="shortcut-group">
              <div class="shortcut-group-title">${title}</div>
              <table class="shortcut-builtin-table">
                <tbody>${body}</tbody>
              </table>
            </div>`;
        };
  
        const builtinHtml =
          builtinTable('nav', this.t('builtinNavGroup')) +
          builtinTable('edit', this.t('builtinEditGroup'));
  
        const caretHtml = '<svg class="collapse-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
        // 分类标题左侧图标：与文件/大纲面板头的 panel-title-icon 同一类名，保持视觉统一
        const ICON_KEYBOARD = '<svg class="panel-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 8h.01" /><path d="M12 12h.01" /><path d="M14 8h.01" /><path d="M16 12h.01" /><path d="M18 8h.01" /><path d="M6 8h.01" /><path d="M7 16h10" /><path d="M8 12h.01" /><rect width="20" height="16" x="2" y="4" rx="2" /></svg>';
        const ICON_SLIDERS = '<svg class="panel-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 8h4" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M17 16h4" /><path d="M19 12V3" /><path d="M19 21v-5" /><path d="M3 14h4" /><path d="M5 10V3" /><path d="M5 21v-7" /></svg>';
        const sectionHtml = (key, title, icon, body) => `
          <div class="shortcut-section" data-collapsed="${this._sectionCollapsed[key] ? 'true' : 'false'}">
            <div class="shortcut-section-title" data-toggle="${key}">
              ${icon}
              <span class="shortcut-section-name">${title}</span>
              ${caretHtml}
            </div>
            <div class="shortcut-section-body">${body}</div>
          </div>`;
  
        // 方案下拉归位到「方案与自定义」分类顶部：方案切换预设键位，下方再列可改项。
        const schemeBlockHtml = `
          <div class="scheme-block">
            <div class="scheme-block-head">
              <span class="scheme-block-label">${this.t('shortcutScheme')}</span>
              <span class="scheme-block-hint">${this.t('schemeHint')}</span>
            </div>
            <div id="shortcuts-scheme-host" class="scheme-select-host"></div>
          </div>`;
  
        container.innerHTML =
          sectionHtml('builtin', this.t('builtinShortcutsTitle'), ICON_KEYBOARD, builtinHtml) +
          sectionHtml('config', this.t('configurableShortcutsTitle'), ICON_SLIDERS, schemeBlockHtml + configGroupsHtml);
  
        // 把方案 Select 的宿主节点移入当前渲染出的占位容器（每次 innerHTML 重建后需重新挂接）。
        if (this._schemeSelect) this._schemeSelect.setValue(this.shortcutScheme || 'default', true);
        const schemePlaceholder = container.querySelector('#shortcuts-scheme-host');
        if (schemePlaceholder && this._schemeHost && this._schemeHost.parentElement !== schemePlaceholder) {
          schemePlaceholder.appendChild(this._schemeHost);
        }
  
        // 折叠/展开：由全局事件委托统一处理（bindCollapseToggle），
        // 每次 innerHTML 重建后新节点自动生效，无需逐节点绑定。
  
        container.querySelectorAll('.shortcut-record-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            this.startRecording(action);
          });
        });
  
        container.querySelectorAll('.shortcut-clear-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            this.clearShortcut(action);
          });
        });
      },
      startRecording(action) {
        this.recordingAction = action;
        this.renderShortcutsList();
      },
      handleShortcutRecording(e) {
        if (!this.recordingAction) return false;
  
        e.preventDefault();
        e.stopPropagation();
  
        if (e.key === 'Escape') {
          this.recordingAction = null;
          this.renderShortcutsList();
          return true;
        }
  
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return true;
  
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
        if (e.shiftKey) parts.push('Shift');
        if (e.altKey) parts.push('Alt');
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  
        const keyStr = parts.join('+');
        const dup = this.findDuplicateShortcut(keyStr, this.recordingAction);
        if (dup) {
          this.showToast(this.t('shortcutOccupied', { key: keyStr, name: this.t('shortcutLabel')[dup] || dup }));
          this.recordingAction = null;
          this.renderShortcutsList();
          return true;
        }
        // 不与「内置固定快捷键」冲突：内置键由编辑器内核占用，用户不可改写，
        // 否则录制成功却不生效，反而造成困惑。冲突即拦截并提示。
        const builtin = this.findBuiltinShortcut(keyStr);
        if (builtin) {
          this.showToast(this.t('shortcutBuiltinOccupied', { key: keyStr, name: builtin.name }));
          this.recordingAction = null;
          this.renderShortcutsList();
          return true;
        }
        this.shortcuts[this.recordingAction].key = keyStr;
        this.recordingAction = null;
        // 仅更新面板内的编辑草稿（内存 this.shortcuts），不落盘、不应用到 CM/全局派发。
        // 必须点「确认」按钮（shortcuts-save-btn）才正式 saveShortcuts + applyShortcuts 生效。
        if (this.shortcutScheme !== 'custom') this.shortcutScheme = 'custom'; // 内存预览标记，不落盘
        this.renderShortcutsList();
        return true;
      },
      findDuplicateShortcut(key, excludeAction) {
        if (!key) return null;
        for (const [action, config] of Object.entries(this.shortcuts)) {
          if (action === excludeAction) continue;
          if (config.key === key) return action;
        }
        return null;
      },
      initShortcutsDialog() {
        document.getElementById('btn-shortcuts').addEventListener('click', () => {
          document.getElementById('file-menu').classList.add('hidden');
          this.showShortcutsDialog();
        });
        document.getElementById('shortcuts-close').addEventListener('click', () => this.hideShortcutsDialog());
        // 注：快捷键框不支持点击遮罩层关闭，只能通过「×」关闭（放弃改动），与设置框一致。
        document.getElementById('shortcuts-reset').addEventListener('click', () => this.resetShortcuts());
        document.getElementById('shortcuts-save-btn').addEventListener('click', async () => {
          // 与设置框「保存」行为一致：按钮进入 loading 态（文字「正在保存」+ spinner），
          // 完成后弹「保存成功」成功提示并关闭；顶部不再显示 loading toast。
          const saveBtn = document.getElementById('shortcuts-save-btn');
          saveBtn.classList.add('is-loading');
          saveBtn.disabled = true;
          saveBtn.innerHTML = '<span class="btn-spinner"></span>' + this.t('saving');
          await this._ensurePainted(); // 让 spinner 先绘制一帧，避免被同步重活推后导致看不到
          try {
            // 「确认」按钮：方案切换与按键编辑在此正式生效（切换下拉只预览不生效）
            const name = this._schemeSelect ? this._schemeSelect.getValue() : this.shortcutScheme;
            if (name === 'custom') {
              // 自定义：以当前编辑后的键位为准，持久化并应用到 CM
              this.shortcutScheme = 'custom';
              this.saveShortcuts();
              this.saveShortcutScheme('custom');
              this.applyShortcuts();
            } else {
              // 预置方案：加载键位 + 持久化 + 应用到 CM
              this.applyShortcutScheme(name);
            }
            await this._minDelay(300); // 保证 loading 至少可见 300ms，避免一闪而过
            this.showToast(this.t('savedSuccess'), 'success'); // 保存完成后弹成功提示
            this.hideShortcutsDialog();
          } finally {
            saveBtn.disabled = false;
            saveBtn.classList.remove('is-loading');
            saveBtn.textContent = this.t('save');
          }
        });
  
        // 快捷键方案下拉：自绘 Select 组件（替代原生 select，展开面板可主题化 + 完整 ARIA）。
        // 宿主用一个持久化的游离 div，渲染时再挂入「方案与自定义」分类内的占位容器，
        // 避免每次 renderShortcutsList 重写 innerHTML 时把 Select 实例的 DOM 冲掉。
        if (!this._schemeHost) {
          this._schemeHost = document.createElement('div');
          this._schemeHost.className = 'scheme-select-host';
        }
        this._schemeSelect = new Select(this._schemeHost, {
          value: this.shortcutScheme || 'default',
          t: this.t.bind(this),
          ariaLabelKey: 'shortcutScheme',
          optionsProvider: (t) => ([
            { value: 'default', label: t('schemeDefault') },
            { value: 'vscode', label: t('schemeVSCode') },
            { value: 'typora', label: t('schemeTypora') },
            { value: 'sublime', label: t('schemeSublime') },
            { value: 'custom', label: t('schemeCustom') },
          ]),
          // 随意切换：仅把键位加载到列表预览（不应用 CM、不持久化），点「保存」按钮才正式生效。
          // 历史实现：change 即弹 window.confirm 并立即生效，Tauri 下 confirm 依赖
          // dialog:allow-confirm 权限（缺失报 "dialog.confirm not allowed"），且交互不符直觉。
          onChange: (name) => { this.previewShortcutScheme(name); },
        });
        this.populateSchemeSelect();
      },
      // 折叠组件统一点击委托：设置面板 / 关于面板 / 快捷键面板 的折叠块标题
      // （.shortcut-section-title / .dependency-title / .settings-section-title）
      // 点击切换最近 [data-collapsed] 容器的展开/收起；快捷键面板额外同步 _sectionCollapsed 供重渲染保持。
      // 事件委托挂在 document，各面板 innerHTML 重建后无需逐节点重新绑定。
      bindCollapseToggle() {
        document.addEventListener('click', (e) => {
          const title = e.target.closest('.shortcut-section-title, .dependency-title, .settings-section-title');
          if (!title) return;
          const panel = title.closest('.shortcut-section, .dependency-details, .settings-section');
          if (!panel) return;
          const collapsed = panel.getAttribute('data-collapsed') === 'true';
          panel.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
          const sec = title.dataset.toggle;
          if (sec && this._sectionCollapsed && Object.prototype.hasOwnProperty.call(this._sectionCollapsed, sec)) {
            this._sectionCollapsed[sec] = !collapsed;
          }
        });
      },
      // 为所有弹框（任意 .dialog-overlay）统一接入拖动 + 缩放（dialog-drag-resize.js）。
      // 一套逻辑复用给全部弹框：标题栏拖动、右下角手柄缩放、双击标题栏还原默认尺寸。
      // 首次（任一弹框）拖动或缩放时给出一次性引导提示，告知可双击标题栏还原默认尺寸。
      initDialogsDragResize() {
        if (typeof window.initDialogDragResize !== 'function') return;
        const hinted = { value: false };
        const onFirstInteract = () => {
          if (hinted.value) return;
          hinted.value = true;
          this.showToast(this.t('dialogResizeHint'), 'info');
        };
        document.querySelectorAll('.dialog-overlay').forEach((el) => {
          if (el.querySelector('.dialog')) {
            window.initDialogDragResize(el, { minWidth: 360, minHeight: 260, onFirstInteract });
          }
        });
      },
      showShortcutsDialog() {
        // 每次打开重置为默认居中尺寸（拖动/缩放状态不记忆，符合预期）
        const kd = document.getElementById('shortcuts-dialog');
        const kp = kd ? kd.querySelector('.dialog') : null;
        if (kp && typeof window.resetDialog === 'function') window.resetDialog(kp);
        this.recordingAction = null;
        // 每次打开都从 localStorage 重新加载已保存键位 + 方案，作为编辑基线。
        // 这样「未点确认就关闭面板」留下的内存草稿不会残留，重开仍显示已保存值。
        this.shortcuts = this.loadShortcuts();
        this.shortcutScheme = this.loadShortcutScheme();
        // 每次打开重置折叠默认：内置固定区收缩、方案与自定义区展开。
        this._sectionCollapsed = { builtin: false, config: false };
        this.renderShortcutsList();
        this.populateSchemeSelect();
        document.getElementById('shortcuts-dialog').classList.remove('hidden');
      },
      populateSchemeSelect() {
        if (!this._schemeSelect) return;
        const opts = [
          { value: 'default', label: this.t('schemeDefault') },
          { value: 'vscode', label: this.t('schemeVSCode') },
          { value: 'typora', label: this.t('schemeTypora') },
          { value: 'sublime', label: this.t('schemeSublime') },
          { value: 'custom', label: this.t('schemeCustom') },
        ];
        this._schemeSelect.setOptions(opts);
        this._schemeSelect.setValue(this.shortcutScheme || 'default', true);
      },
      hideShortcutsDialog() {
        this.recordingAction = null;
        document.getElementById('shortcuts-dialog').classList.add('hidden');
      },
      applyShortcuts() {
        const s = this.shortcuts;
        const LIST_LINE_RE = /^(\s*)(?:>[> ]*|[*+-]\s\[[xX ]\]\s|[*+-]\s|\d+[.)]\s)/;
        this.cm.setOption('extraKeys', {
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
        });
  
        // 把 DOM 键名规范化为 CodeMirror 5 的 keyName（CM5 用 'Up'/'Down' 而非 'ArrowUp'，
        // 用 'Esc' 而非 'Escape'）。否则录 Alt+ArrowUp 注册成 'Alt-ArrowUp'，而 CM 查找
        // 'Alt-Up'，handler 永不触发（合并自 PR #36 的行移动功能配套修正）。
        const KEY_ALIAS = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', ' ': 'Space' };
        const toCmKey = (k) => {
          const parts = k.split('+');
          let key = parts.pop();
          key = KEY_ALIAS[key] || key;
          const order = { Shift: 0, Ctrl: 1, Alt: 2, Cmd: 3, Meta: 3 };
          parts.sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99));
          return parts.concat([key]).join('-');
        };
  
        // Editor-only actions (work in CodeMirror extraKeys when editor is focused)
        const editorMap = {
          bold: () => this.wrapSelection('**', '**'),
          italic: () => this.wrapSelection('*', '*'),
          strikethrough: () => this.wrapSelection('~~', '~~'),
          inlineCode: () => this.wrapSelection('`', '`'),
          highlight: () => this.wrapSelection('==', '=='),
          codeBlock: () => this.insertBlock('```javascript\n// code here\n```', 14),
          blockquote: () => this.insertLinePrefix('> '),
          insertTable: () => this.insertBlock('| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |', 2),
          addTableRow: () => this._addTableRow(cm),
          addTableColumn: () => this._addTableColumn(cm),
          insertUl: () => this.insertLinePrefix('- '),
          insertOl: () => this.insertLinePrefix('1. ', true),
          insertTask: () => this.insertLinePrefix('- [ ] '),
          insertHr: () => this.insertBlock('---'),
          insertLink: () => this.showInsertLinkDialog(),
          insertImage: () => this.showInsertImageDialog(),
          insertSuperscript: () => this.executeMenuAction('insert-superscript'),
          insertSubscript: () => this.executeMenuAction('insert-subscript'),
          insertH1: () => this.executeMenuAction('insert-h1'),
          insertH2: () => this.executeMenuAction('insert-h2'),
          insertH3: () => this.executeMenuAction('insert-h3'),
          insertH4: () => this.executeMenuAction('insert-h4'),
          insertH5: () => this.executeMenuAction('insert-h5'),
          insertH6: () => this.executeMenuAction('insert-h6'),
          insertMathBlock: () => this.executeMenuAction('insert-math-block'),
          insertMermaid: () => this.executeMenuAction('insert-mermaid'),
          insertToc: () => this.executeMenuAction('insert-toc'),
          insertCalloutNote: () => this.executeMenuAction('insert-callout-note'),
          insertCalloutTip: () => this.executeMenuAction('insert-callout-tip'),
          insertCalloutWarning: () => this.executeMenuAction('insert-callout-warning'),
          insertCalloutCaution: () => this.executeMenuAction('insert-callout-caution'),
          insertCalloutImportant: () => this.executeMenuAction('insert-callout-important'),
          // 行/选区上下移动（合并自 PR #36）：CM5 核心无 moveLineUp/Down 命令，自实现 _moveLine。
          moveLineUp: () => this._moveLine(-1),
          moveLineDown: () => this._moveLine(1),
          // Eclipse/VS Code 风格：在当前行下方/上方插入空行，光标移到新行行首
          insertLineBelow: () => this.insertLineBelow(),
          insertLineAbove: () => this.insertLineAbove(),
        };
  
        // Global actions (work anywhere via document keydown handler)
        const globalMap = {
          saveFile: () => this.saveFile(),
          openFile: () => this.openFile(),
          newFile: () => this.newFile(),
          closeTab: () => this.closeTab(this.activeTabIndex),
          exportPDF: () => this.exportPDF(),
          saveAs: () => this.saveAsFile(),
          toggleView: () => this.toggleViewMode(),
          toggleSidebar: () => this.toggleSidebar(),
          toggleTheme: () => this.toggleTheme(),
          find: () => this.toggleFindPanel(),
          crossSearch: () => this.openCrossSearchDialog(),
          fileSearch: () => this.openFileSearchDialog(),
          nextTab: () => {
            const next = (this.activeTabIndex + 1) % this.tabs.length;
            this.switchTab(next);
          },
          closeToTray: () => this.hideToTray(),
          prevTab: () => {
            const prev = this.activeTabIndex > 0 ? this.activeTabIndex - 1 : this.tabs.length - 1;
            this.switchTab(prev);
          },
        };
  
        // Editor-local actions (bold/italic/insert-*, need the CM instance) are
        // registered as real handlers in extraKeys — they only apply when the
        // editor is focused, which is exactly what we want.
        const extraKeys = this.cm.getOption('extraKeys');
        for (const [action, fn] of Object.entries(editorMap)) {
          const key = s[action]?.key;
          if (key) extraKeys[toCmKey(key)] = fn;
        }
        // Global actions (save/find/crossSearch/nextTab/... ) are dispatched
        // centrally by the document-level keydown handler (works in ALL focus
        // states). Here we neutralize them in CM with `false` so CM's own default
        // keymap (e.g. search.js binds Shift-Ctrl-F→"replace", Ctrl-F→"find") can't
        // fire and there is no double-dispatch. CodeMirror does not stop propagation
        // for handled keys, so the event still reaches the document handler.
        for (const [action, fn] of Object.entries(globalMap)) {
          const key = s[action]?.key;
          if (key) extraKeys[toCmKey(key)] = false;
        }
  
        // 文档首/末导航（与常见编辑器一致：无 Shift=移动光标，带 Shift=从光标处选中）。
        // 这些键与 a/c/v/x/z/y 同逻辑：在全局捕获 keydown 监听里「放行」（不 preventDefault /
        // 不 stopPropagation），事件自然到达 CodeMirror，由下方 extraKeys handler 处理；
        // 这样 CM 的 onKeyDown 不会因 e.defaultPrevented 提前 return，handler 能正常执行。
        // 用自定义 handler 而非 CM 默认 goDocStart/goDocEnd，因为：CM 默认 Ctrl+End 落末行
        // 首列（我们要末行末列）；CM 默认 Ctrl+Home 反而「选中」（我们要移动）。
        // 注意：CM 的 extendSelection(head) 单参数等价 setCursor（移动、collapsed），并不会
        // 保留原锚点；真正的「从光标选中到目标」需用 setSelection(原光标, 目标)。
        extraKeys['Ctrl-Home']       = (cm) => cm.setCursor({ line: cm.firstLine(), ch: 0 });
        extraKeys['Ctrl-End']        = (cm) => cm.setCursor({ line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length });
        extraKeys['Shift-Ctrl-Home'] = (cm) => { const c = cm.getCursor(); cm.setSelection(c, { line: cm.firstLine(), ch: 0 }); };
        extraKeys['Shift-Ctrl-End']  = (cm) => { const c = cm.getCursor(); cm.setSelection(c, { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length }); };
  
        // 按「词」移动 / 选择（方案 B：Intl.Segmenter 中文分词）。
        // 方向键与 Home/End 同逻辑：需在全局捕获 keydown 监听里「放行」（见下方放行名单），
        // 否则事件被 preventDefault 后 CM 收不到、custom handler 永不执行。
        // Shift 版本复用同一 handler：extendSelectionsBy 会按 display.shift 自动扩展选区。
        extraKeys['Ctrl-Left']        = (cm) => this._moveByWord(cm, -1, false);
        extraKeys['Ctrl-Right']       = (cm) => this._moveByWord(cm, 1, false);
        extraKeys['Shift-Ctrl-Left']  = (cm) => this._moveByWord(cm, -1, true);
        extraKeys['Shift-Ctrl-Right'] = (cm) => this._moveByWord(cm, 1, true);
  
        this.cm.setOption('extraKeys', extraKeys);
  
        // Build global shortcut lookup for document-level handling.
        // 全局动作（保存/查找等）在任何焦点下都派发；编辑器动作（加粗/标题等）包一层
        // 「编辑器聚焦才执行」的守卫，这样无论 CodeMirror 自身的 extraKeys 派发是否生效
        // （焦点/事件到达问题），都能通过全局捕获通道稳定触发，且不会在非编辑场景误触。
        // 命中即 stopPropagation（见 document keydown 监听），事件不再冒泡到 CM，不会重复执行。
        this.globalShortcutLookup = {};
        const registerGlobal = (action, fn, editorOnly) => {
          const key = s[action]?.key;
          if (!key) return;
          this.globalShortcutLookup[key] = editorOnly
            ? () => { if (this.cm && this.cm.hasFocus()) fn(); }
            : fn;
        };
        for (const [action, fn] of Object.entries(globalMap)) registerGlobal(action, fn, false);
        for (const [action, fn] of Object.entries(editorMap)) registerGlobal(action, fn, true);
  
        this.updateShortcutHints();
      },
    // 屏蔽浏览器 / WebView 默认行为：功能键、历史导航，以及 Esc 关闭浮层
    _handleKeydownBlocklist(e) {
      if (/^F(1[0-2]|[1-9])$/.test(e.key)) {
        e.preventDefault();
        return true;
      }
      // Block WebView history navigation (back/forward)
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        return true;
      }
      if (e.key === 'Escape') {
        const aboutDialog = document.getElementById('about-dialog');
        if (aboutDialog && !aboutDialog.classList.contains('hidden')) {
          this.hideAbout();
          return true;
        }
        const shortcutsDialog = document.getElementById('shortcuts-dialog');
        if (shortcutsDialog && !shortcutsDialog.classList.contains('hidden')) {
          this.hideShortcutsDialog();
          return true;
        }
      }
      return false;
    },

    // TizuMark 全局快捷键派发（编辑器无焦点时也生效）
    _dispatchGlobalShortcut(e) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const key = e.key.toLowerCase();

      // 文档导航键（Home/End）：与 a/c/v/x 同逻辑，放行给 CodeMirror 处理。
      // 事件自然到达 CM，由 extraKeys 注册的 handler 接管（Ctrl+End 落末行末列、
      // Ctrl+Home 移动而非选中）；CM 命中后会自行 preventDefault（阻止页面滚动）。
      // 不放行的话全局捕获监听会 preventDefault，导致 CM 因 defaultPrevented 提前
      // return、handler 永不执行（见 codemirror.js onKeyDown → signalDOMEvent）。
      if (key === 'home' || key === 'end' || key === 'arrowleft' || key === 'arrowright') {
        // 文档导航键 / 方向键：放行给 CodeMirror 处理（Ctrl+←/→ 按词移动、
        // Ctrl+Shift+←/→ 选词）。若在此 preventDefault，CM 因 defaultPrevented 提前
        // return，extraKeys 里自定义的 _moveByWord handler 永不执行（同 Home/End 坑）。
        return;
      }

      // Essential browser editing shortcuts — always let through
      if (['a', 'c', 'v', 'x', 'z', 'y'].includes(key)) {
        if (!e.shiftKey) return;
        if (key === 'z') return; // Ctrl+Shift+Z for redo
        e.preventDefault(); // Block Ctrl+Shift+C (DevTools) etc.
        return;
      }

      // Block ALL other Ctrl shortcuts from triggering browser defaults
      e.preventDefault();

      // 主键用 e.code（物理键位）推导，规避某些浏览器/环境下 Ctrl+Shift+字母的
      // e.key 取值异常（如被当成其它字符），保证 keyStr 与 globalShortcutLookup
      // 中存储的 'Ctrl+Shift+F' 等稳定匹配。
      let baseKey;
      if (e.code && /^Key[A-Za-z]$/.test(e.code)) baseKey = e.code.slice(3).toUpperCase();
      else if (e.code && /^Digit[0-9]$/.test(e.code)) baseKey = e.code.slice(5);
      else baseKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const gParts = [];
      if (e.ctrlKey || e.metaKey) gParts.push('Ctrl');
      if (e.shiftKey) gParts.push('Shift');
      if (e.altKey) gParts.push('Alt');
      gParts.push(baseKey);
      const keyStr = gParts.join('+');
      const gHandler = this.globalShortcutLookup?.[keyStr];
      // 全局快捷键在【捕获阶段】统一派发：命中即 stopPropagation，阻断事件继续
      // 冒泡到 CodeMirror（及其默认键位 search.js 的 Shift-Ctrl-F→replace）或
      // Tauri WebView 的原生处理，确保编辑器有焦点时也能且仅由本处触发一次。
      // （CM 的 extraKeys 仍对相关键置 false 作为兜底。）
      if (gHandler) {
        e.stopPropagation();
        gHandler();
      }
    },

  };

  const api = { mixin };
  window.TMShortcuts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
