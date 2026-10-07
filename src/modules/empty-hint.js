// 空行占位提示：光标位于「独立空行」时，在该行行内绘制淡色提示文字
// （形似 placeholder：「输入 / 可插入内容…」，提示可输入任意内容或用 / 唤起快捷插入）。
//
// 为什么不用 CM5 自带 placeholder：CM 5.65.18 的 options.placeholder 仅在 textarea
// 初始化读取一次、只在整篇为空时显示，无法逐空行显示，故自建。
// 为什么不用 markText：空行没有任何字符，零长度 markText（ch:0-ch:0）+ replacedWith
// 在 CM5 中不渲染（clearEmptySpans 直接清掉零长度标记）。
//
// 实现方案（2026-10-07 定稿）：
//   addLineClass(handle, 'wrap', CLASS) 给光标所在空行的**行包装器**挂类，
//   CSS 对该行内的 pre.CodeMirror-line 用 ::after 绘制提示文案。
//   文案走 CSS 变量 --empty-hint-text（挂在 documentElement 上，切语言时刷新一次），
//   ⚠️ 不能用 data-hint + attr()：拿行 DOM 得走 cm.getLineElement —— CM5 根本没有
//   这个 API（恒 undefined，data-hint 永远写不上去，提示永远不显示，2026-10-07 真机反馈）。
(function () {
  'use strict';

  const HINT_CLASS = 'cm-empty-placeholder';
  const HINT_VAR = '--empty-hint-text';
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

      // 文案进 CSS 变量（带引号，供 content: var(...) 使用），切语言/首次时刷新
      const text = this.t(HINT_KEY) || '输入 / 可插入内容…';
      const quoted = '"' + text.replace(/"/g, '\\"') + '"';
      if (document.documentElement.style.getPropertyValue(HINT_VAR) !== quoted) {
        document.documentElement.style.setProperty(HINT_VAR, quoted);
      }

      const cur = cm.getCursor();
      const line = cm.getLine(cur.line) || '';
      const showable = line.trim() === '' && !isInsideFence(cm, cur.line);
      if (!showable) return this.clearEmptyLineHint();

      // 已绘制且行号未变：避免重复 addLineClass 抖动
      if (this._emptyHintLine === cur.line && this._emptyHintHandle) return;
      this.clearEmptyLineHint();

      const handle = cm.getLineHandle(cur.line);
      cm.addLineClass(handle, 'wrap', HINT_CLASS);
      this._emptyHintHandle = handle;
      this._emptyHintLine = cur.line;
    },
    clearEmptyLineHint() {
      if (this._emptyHintHandle) {
        try {
          cmRemoveLineClass(this.cm, this._emptyHintHandle);
        } catch (_) { /* 文档已销毁等，忽略 */ }
      }
      this._emptyHintHandle = null;
      this._emptyHintLine = null;
    },
    // 切换文件/标签/模式时清掉残留提示（行号已失效）
    resetEmptyLineHint() {
      this.clearEmptyLineHint();
    },
  };

  function cmRemoveLineClass(cm, handle) {
    if (cm && cm.removeLineClass) cm.removeLineClass(handle, 'wrap', HINT_CLASS);
  }

  const api = { mixin, HINT_CLASS, HINT_KEY };
  window.TMEmptyHint = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
