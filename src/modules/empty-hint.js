// 空行占位提示：光标位于「独立空行」时，在该行绘制淡色提示文字
// （形似 placeholder：「输入 / 可插入内容…」，提示可输入任意内容或用 / 唤起快捷插入）。
//
// 为什么不用 CM5 自带 placeholder：实测 CM 5.65.18 全库没有 placeholder widget 实现
// （src/lib/codemirror/codemirror.js 中 options.placeholder 仅在 :9741 从 textarea 初始化
// 读取一次），既无法逐空行显示、也不支持非空文档场景，故自建。
//
// 实现用 CM5 markText（与 find.js 查找高亮同一范式）：零 DOM 侵入、随光标移动自动重绘。
(function () {
  'use strict';

  const HINT_CLASS = 'cm-empty-placeholder';
  const HINT_KEY = 'emptyLineHint';

  // 该行是否处于围栏代码块内（``` 或 ~~~）。逐行扫前缀并用奇偶计数，
  // 与 preview-window.js computePreviewWindow 的围栏奇偶语义一致。
  function isInsideFence(cm, lineIdx) {
    let open = false;
    for (let i = 0; i <= lineIdx; i++) {
      const s = cm.getLine(i) || '';
      if (/^`{3,}|^~{3,}/.test(s.trim())) open = !open;
    }
    return open;
  }

  const mixin = {
    // 依据光标位置重算空行提示。change / cursorActivity 时调用。
    updateEmptyLineHint() {
      const cm = this.cm;
      if (!cm || !cm.getCursor) return;
      // 仅可编辑的两个模式需要提示；阅读模式无光标
      if (this.viewMode === 'preview') return this.clearEmptyLineHint();

      const cur = cm.getCursor();
      const line = cm.getLine(cur.line) || '';
      const showable = line.trim() === '' && !isInsideFence(cm, cur.line);
      if (!showable) return this.clearEmptyLineHint();

      // 已绘制且行号未变：避免重复 markText 抖动
      if (this._emptyHintMark && this._emptyHintLine === cur.line) return;
      this.clearEmptyLineHint();

      const mark = cm.markText(
        { line: cur.line, ch: 0 },
        { line: cur.line, ch: 0 },
        {
          className: HINT_CLASS,
          // 只读装饰：光标可穿过，不影响编辑与选区
          inclusiveLeft: true,
          atomic: false,
          replacedWith: (() => {
            const span = document.createElement('span');
            span.className = HINT_CLASS;
            span.textContent = this.t(HINT_KEY) || '输入 / 可插入内容…';
            return span;
          })(),
        }
      );
      this._emptyHintMark = mark;
      this._emptyHintLine = cur.line;
    },
    clearEmptyLineHint() {
      if (!this._emptyHintMark) return;
      try { this._emptyHintMark.clear(); } catch (_) { /* 文档已销毁等，忽略 */ }
      this._emptyHintMark = null;
      this._emptyHintLine = null;
    },
    // 切换文件/标签/模式时清掉残留提示（行号已失效）
    resetEmptyLineHint() {
      this.clearEmptyLineHint();
    },
  };

  const api = { mixin, HINT_CLASS, HINT_KEY };
  window.TMEmptyHint = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
