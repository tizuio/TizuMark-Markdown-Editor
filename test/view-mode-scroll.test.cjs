// 视图模式切换滚动位置保持 —— 回归测试
// 验证：edit<->preview 切换时，编辑器/预览的滚动位置被保存并在切换后恢复，不再跳回顶部
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

// 拆分后 app.js 依赖 modules/ 下的各域模块，须按生产顺序整体注入（同 index.html 清单）。
const { readBundle } = require('./helpers/app-bundle.cjs');
const appjs = readBundle();

const HTML = `<!DOCTYPE html><html><body>
  <div class="editor-container">
    <div class="editor-pane"></div>
    <div class="preview-pane"><div class="preview-content"></div></div>
  </div>
  <div id="find-panel"></div>
  <div id="preview-find-panel"></div>
  <div id="editor-pane"></div>
  <div id="preview-pane"></div>
  <button id="btn-view-preview"></button>
  <button id="btn-view-edit"></button>
  <button id="btn-side-left"></button>
  <button id="btn-side-right"></button>
</body></html>`;

const dom = new JSDOM(HTML, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });

// 注入 Tauri 桩（app.js 顶部 const { invoke } = window.__TAURI__.core 需要）
dom.window.__TAURI__ = { core: { invoke: () => Promise.resolve(null) }, path: {}, app: {}, event: {}, shell: {} };
// 把 app.js 源码透传给窗口作用域，供场景 D 抽取真实编辑器 scroll 处理器闭包使用
dom.window.__APPJS_SOURCE = appjs;

const harnessFn = function () {
  const results = [];
  if (typeof MarkdownEditor !== 'function') { results.push(['加载', false]); return results; }

  // 构造轻量实例（复用原型方法，stub 掉重依赖）
  const ed = Object.create(MarkdownEditor.prototype);
  const cmScroll = { top: 0, left: 0, clientHeight: 800, height: 5000 };
  let scrollToCalls = [];
  ed.cm = {
    getScrollInfo: () => ({ ...cmScroll }),
    scrollTo: (left, top) => { scrollToCalls.push({ left, top }); cmScroll.top = top; cmScroll.left = left; },
    refresh: () => {},
  };
  const previewEl = document.querySelector('.preview-content') || document.querySelector('.preview-pane');
  Object.defineProperty(previewEl, 'scrollTop', { value: 0, writable: true, configurable: true });
  Object.defineProperty(previewEl, 'scrollHeight', { value: 4000, writable: true, configurable: true });
  Object.defineProperty(previewEl, 'clientHeight', { value: 800, writable: true, configurable: true });
  ed.preview = previewEl;

  // activeTab 是原型 getter（读 this.tabs[this.activeTabIndex]），需用 tabs/activeTabIndex 驱动
  ed.tabs = [{ scrollPos: { top: 0, left: 0 }, previewScrollTop: 0, filePath: '/x.md', content: 'a' }];
  ed.activeTabIndex = 0;
  ed.viewMode = 'edit';
  ed.settings = { language: 'zh', scrollSync: false };
  ed._canScroll = { editor: true, preview: false };
  ed._previewVirtual = false;
  ed.previewWindow = null;
  ed.clearPreviewHighlight = () => {};
  ed.updateSideButtons = () => {};
  ed.updatePreview = () => {};
  // container 供 applyViewMode 使用
  ed.container = document.querySelector('.editor-container');

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  return (async () => {
    // --- 场景 A: edit -> preview，编辑器可见时保存 scrollPos ---
    cmScroll.top = 500; cmScroll.left = 0;
    ed.preview.scrollTop = 300;
    ed.setViewMode('preview');
    // 保存校验（同步内完成）
    results.push(['A1: edit->preview 保存 scrollPos.top=500', ed.activeTab.scrollPos.top === 500]);
    results.push(['A2: edit->preview 保存 previewScrollTop=300', ed.activeTab.previewScrollTop === 300]);
    results.push(['A3: 已切到 preview 模式', ed.viewMode === 'preview']);
    await wait(80); // 等 applyViewMode 的 50ms setTimeout
    results.push(['A4: preview 模式恢复 preview.scrollTop=300', ed.preview.scrollTop === 300]);
    results.push(['A5: preview 模式未调用 cm.scrollTo', scrollToCalls.length === 0]);

    // --- 场景 B: preview -> edit，编辑器隐藏期间不要覆盖 scrollPos ---
    scrollToCalls = [];
    ed.preview.scrollTop = 800; // 用户在预览里滚到 800（编辑器此时隐藏）
    ed.setViewMode('edit');
    results.push(['B1: preview->edit 不覆盖 scrollPos（仍为 500）', ed.activeTab.scrollPos.top === 500]);
    results.push(['B2: preview->edit 保存 previewScrollTop=800', ed.activeTab.previewScrollTop === 800]);
    results.push(['B3: 已切回 edit 模式', ed.viewMode === 'edit']);
    await wait(80);
    results.push(['B4: 同步关闭时 edit 模式直接恢复编辑器 scrollPos top=500', scrollToCalls.length === 1 && scrollToCalls[0].top === 500]);
    results.push(['B5: scrollSync 关闭时 preview 保持原位置', ed.preview.scrollTop === 800]);

    // --- 场景 C: previewScrollTop 越界被钳制 ---
    scrollToCalls = [];
    ed.viewMode = 'preview';
    ed.activeTab.previewScrollTop = 999999; // 远超 scrollHeight
    // 直接走 applyViewMode 的 restore 分支
    ed.applyViewMode();
    await wait(80);
    const maxScroll = 4000 - 800;
    results.push(['C1: 越界 previewScrollTop 被钳制到 maxScroll', ed.preview.scrollTop === maxScroll]);

    // --- 场景 D: 编辑器 scroll 处理器守卫（防预览模式滚动清零 scrollPos）---
    // 处理器是 initEditor 内的闭包，无法被 stub 触发；此处从源码抽取真实闭包运行，
    // 确保 preview/折叠隐藏时绝不写回 scrollPos（真实 bug 路径：预览滚动→_syncPreviewToEditor→
    // 对隐藏编辑器 cm.scrollTo→触发编辑器 scroll→若没守卫则把 scrollPos 清零→切回编辑跳顶部）。
    // 该方法已搬到 modules/editor-core.js（mixin 内多两层缩进：4 → 8 空格），故结束大括号为 8 空格。
    // 处理器内部语句缩进 ≥10 空格，因此 8 空格的 `});` 唯一对应箭头函数结尾。
    const handlerMatch = window.__APPJS_SOURCE.match(/this\.cm\.on\('scroll', \(\) => \{([\s\S]*?)\n {8}\}\);/);
    results.push(['D0: 成功抽取真实编辑器 scroll 处理器', !!handlerMatch]);
    const scrollHandler = handlerMatch ? new Function(handlerMatch[1]) : null;
    const containerEl = document.querySelector('.editor-container');

    if (scrollHandler) {
      const makeEd = () => ({
        cm: { getScrollInfo: () => ({ top: 0, left: 0 }) },
        settings: { scrollSync: false },
        _canScroll: { editor: true, preview: true },
        activeTab: { scrollPos: { top: 1234, left: 0 } },
      });

      // D1: 预览模式（编辑器隐藏）→ 处理器不得写回 scrollPos（top 应保持 1234）
      containerEl.classList.add('preview-mode');
      const edD1 = makeEd();
      scrollHandler.call(edD1);
      results.push(['D1: preview 模式滚动不清零 scrollPos', edD1.activeTab.scrollPos.top === 1234]);

      // D2: 编辑模式（可见）→ 处理器应正常写回 getScrollInfo 的 top
      containerEl.classList.remove('preview-mode');
      const edD2 = makeEd();
      edD2.cm.getScrollInfo = () => ({ top: 500, left: 10 });
      scrollHandler.call(edD2);
      results.push(['D2: edit 模式滚动正常写回 scrollPos.top=500', edD2.activeTab.scrollPos.top === 500]);
    }

    // --- 场景 E: edit->preview，滚动同步关闭 → 各自独立，恢复持续跟踪的 previewScrollTop ---
    const ed2 = Object.create(MarkdownEditor.prototype);
    const cmScroll2 = { top: 0, left: 0, clientHeight: 800, height: 5000 };
    ed2.cm = {
      getScrollInfo: () => ({ ...cmScroll2 }),
      scrollTo: (l, t) => { cmScroll2.top = t; cmScroll2.left = l; },
      refresh: () => {},
    };
    const previewEl2 = document.querySelector('.preview-content');
    Object.defineProperty(previewEl2, 'scrollTop', { value: 0, writable: true, configurable: true });
    Object.defineProperty(previewEl2, 'scrollHeight', { value: 4000, writable: true, configurable: true });
    Object.defineProperty(previewEl2, 'clientHeight', { value: 800, writable: true, configurable: true });
    ed2.preview = previewEl2;
    ed2.tabs = [{ scrollPos: { top: 250, left: 0 }, previewScrollTop: 300, filePath: '/e.md', content: 'e' }];
    ed2.activeTabIndex = 0;
    ed2.viewMode = 'preview';
    ed2.settings = { language: 'zh', scrollSync: false };   // 关闭同步 → 各自独立
    ed2._canScroll = { editor: true, preview: false };
    ed2._previewVirtual = false;
    ed2.previewWindow = null;
    ed2.clearPreviewHighlight = () => {};
    ed2.updateSideButtons = () => {};
    ed2.updatePreview = () => {};
    ed2._resumeScroll = () => {};
    ed2._syncEditorToPreviewWindow = () => {};
    ed2.container = containerEl;
    ed2.applyViewMode();
    await wait(80);
    results.push(['E1: edit->preview 同步关闭恢复 previewScrollTop=300', ed2.preview.scrollTop === 300]);
    results.push(['E2: 不同步时不被 editor scrollPos(250) 覆盖', ed2.preview.scrollTop !== 250]);

    // 行锚点测试：编辑器位置表（宽度无关）+ 预览位置表（随宽度重排而不同）。
    // PL_edit = 分屏 50% 宽下的预览位置；PL_preview = 纯预览 100% 宽下的预览位置（更高，因更窄换行）。
    // 行锚点法应跨这两种布局对齐到同一源码行；旧「像素恢复/进度乘法」会因宽度错位而漂移。
    const EL = [0, 500, 1000, 1500, 2000];
    const PL_edit = [0, 400, 800, 1200, 1600];
    const PL_preview = [0, 600, 1200, 1800, 2400];
    const makeSyncEd = (initialViewMode, editorTop, previewScrollTop) => {
      const e = Object.create(MarkdownEditor.prototype);
      const cm = { top: editorTop, left: 0, clientHeight: 800, height: 5000 };
      e.cm = {
        getScrollInfo: () => ({ ...cm }),
        scrollTo: (l, t) => { cm.top = t; cm.left = l; },
        refresh: () => {},
        // 0-based 行 ← 像素（编辑器宽度恒定，用 EL）
        lineAtHeight: (h, mode) => {
          let idx = 0;
          for (let i = 0; i < EL.length; i++) { if (EL[i] <= h) idx = i; else break; }
          return idx;
        },
        // 像素 ← 0-based 行
        heightAtLine: (ln, mode) => (EL[ln] != null ? EL[ln] : 0),
      };
      const pv = document.querySelector('.preview-content');
      Object.defineProperty(pv, 'scrollTop', { value: previewScrollTop, writable: true, configurable: true });
      Object.defineProperty(pv, 'scrollHeight', { value: 2800, writable: true, configurable: true });
      Object.defineProperty(pv, 'clientHeight', { value: 400, writable: true, configurable: true });
      e.preview = pv;
      e.tabs = [{ scrollPos: { top: editorTop, left: 0 }, previewScrollTop, filePath: '/s.md', content: 's' }];
      e.activeTabIndex = 0;
      e.viewMode = initialViewMode;
      e.settings = { language: 'zh', scrollSync: true };
      e._canScroll = { editor: true, preview: true };
      e._previewVirtual = false;
      e.previewWindow = null;
      // _computedPosition 按当前 viewMode 返回对应宽度的预览位置表（模拟重排）
      e._computedPosition = () => {
        e._editorElementList = EL;
        e._previewElementList = (e.viewMode === 'preview') ? PL_preview : PL_edit;
      };
      e.clearPreviewHighlight = () => {};
      e.updateSideButtons = () => {};
      e.updatePreview = () => {};
      e._resumeScroll = () => {};
      e._syncEditorToPreviewWindow = () => {};
      e._syncPreviewToEditorWindow = () => {};
      e.container = containerEl;
      return e;
    };

    // --- 场景 E': edit->preview，行锚点对齐（编辑器在第1行 → 预览在第1行，跨宽度）---
    const edE2 = makeSyncEd('edit', 500, 0);   // 编辑器在第1行顶部（EL[1]=500）
    edE2.setViewMode('preview');                // 真实走 setViewMode→applyViewMode
    await wait(80);
    // 锚点=第2行(1-based) → 预览在 PL_preview[1]=600（100%宽下第1行顶部）
    results.push(['E2b: edit->preview 行锚点 编辑器500→预览600(跨宽度)', edE2.preview.scrollTop === 600]);

    // --- 场景 F: preview->edit，行锚点对齐（预览在第1行 → 编辑器在第1行，跨宽度）---
    const edF = makeSyncEd('preview', 250, 600); // 预览在 PL_preview[1]=600（第1行）；编辑器陈旧 250
    edF.setViewMode('edit');
    await wait(80);
    // 锚点=第2行 → 编辑器在 EL[1]=500；陈旧 scrollPos(250) 应被忽略
    results.push(['F1: preview->edit 行锚点 预览600→编辑器500(跨宽度)', edF.cm.getScrollInfo().top === 500]);
    results.push(['F2: 切回编辑不用陈旧 scrollPos(250)', edF.cm.getScrollInfo().top !== 250]);

    // --- 场景 G: 预览在第3行 → 编辑器在第3行（验证锚点随内容变化，非恒为同一行）---
    const edG = makeSyncEd('preview', 0, 1800);  // 预览在 PL_preview[3]=1800（第3行）
    edG.setViewMode('edit');
    await wait(80);
    // 锚点=第4行 → 编辑器在 EL[3]=1500
    results.push(['G1: 预览第3行(1800) → 编辑器第3行 1500', edG.cm.getScrollInfo().top === 1500]);

    // --- 场景 H: 多次 edit<->preview 切换不应漂移（直击「位置一直变」回归）---
    // 关键：预览位置表随宽度重排（PL_edit≠PL_preview）。初始预览 400 在分屏(PL_edit)是第1行顶部，
    // 但在纯预览(PL_preview)里 400 落在第0~1行之间——像素回退会把预览停在 400（错行），
    // 而行锚点法会校正到第1行 = PL_preview[1]=600。多次切换后锚点法恒定 500↔600，像素法会错位。
    const edH = makeSyncEd('edit', 500, 400);
    const editorTops = [];
    const previewTops = [];
    for (let i = 0; i < 5; i++) {
      edH.toggleViewMode();          // edit↔preview 真实切换
      await wait(70);                 // 等 50ms setTimeout + rAF(_resumeScroll) 完成
      editorTops.push(Math.round(edH.cm.getScrollInfo().top));
      previewTops.push(Math.round(edH.preview.scrollTop));
    }
    results.push(['H1: 5 次切换编辑器位置稳定在 500', editorTops.every((t) => t === 500)]);
    results.push(['H2: 5 次切换预览位置稳定在 600(锚点校正，非像素400)', previewTops.every((p) => p === 600)]);
    results.push(['H3: 跨宽度重排全程不漂移', editorTops.every((t) => t === 500) && previewTops.every((p) => p === 600)]);

    return results;
  })();
};

const combined = appjs + '\n;window.__harnessPromise = (' + harnessFn.toString() + ')();';
const s = dom.window.document.createElement('script');
s.textContent = combined;
dom.window.document.body.appendChild(s);

for (const name of ['A1: edit->preview 保存 scrollPos.top=500','A2: edit->preview 保存 previewScrollTop=300','A3: 已切到 preview 模式','A4: preview 模式恢复 preview.scrollTop=300','A5: preview 模式未调用 cm.scrollTo','B1: preview->edit 不覆盖 scrollPos（仍为 500）','B2: preview->edit 保存 previewScrollTop=800','B3: 已切回 edit 模式','B4: 同步关闭时 edit 模式直接恢复编辑器 scrollPos top=500','B5: scrollSync 关闭时 preview 保持原位置','C1: 越界 previewScrollTop 被钳制到 maxScroll','D0: 成功抽取真实编辑器 scroll 处理器','D1: preview 模式滚动不清零 scrollPos','D2: edit 模式滚动正常写回 scrollPos.top=500','E1: edit->preview 同步关闭恢复 previewScrollTop=300','E2: 不同步时不被 editor scrollPos(250) 覆盖','E2b: edit->preview 行锚点 编辑器500→预览600(跨宽度)','F1: preview->edit 行锚点 预览600→编辑器500(跨宽度)','F2: 切回编辑不用陈旧 scrollPos(250)','G1: 预览第3行(1800) → 编辑器第3行 1500','H1: 5 次切换编辑器位置稳定在 500','H2: 5 次切换预览位置稳定在 600(锚点校正，非像素400)','H3: 跨宽度重排全程不漂移']) {
  test(name, async () => {
    const results = await dom.window.__harnessPromise;
    const item = results.find(r => r[0] === name);
    assert.ok(item && item[1] === true, name + (item ? '' : ' (结果缺失)'));
  });
}
