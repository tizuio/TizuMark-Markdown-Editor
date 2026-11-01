// 视图模式测试：初始值 / toggleViewMode 循环 / applyViewMode / toggleCollapse 折叠
// 与 app-core 的 setViewMode 互补，避免重复。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

async function makeEditor() {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  const ed = w.editor;
  // 隔离异步 DOM 副作用，聚焦视图模式状态切换
  ed.updateSideButtons = () => {};
  ed.setStatus = () => {};
  ed._resumeScroll = () => {};
  ed.cm.refresh = () => {};
  return { w, ed };
}

test('viewmode: 初始化 viewMode 继承 settings.defaultView', async () => {
  const { w, ed } = await makeEditor();
  try {
    assert.strictEqual(ed.viewMode, ed.settings.defaultView, 'viewMode 应等于默认视图设置');
  } finally { cleanup(w); }
});

test('viewmode: toggleViewMode 在 阅读/源码/实时预览 三模式间循环', async () => {
  const { w, ed } = await makeEditor();
  try {
    const container = w.document.querySelector('.editor-container');
    // 从源码起步：阅读 → 源码 → 实时预览 → 阅读
    if (ed.viewMode === 'preview') ed.setViewMode('edit');
    assert.strictEqual(ed.viewMode, 'edit');
    assert.ok(!container.classList.contains('preview-mode'));
    // 给一点内容，确保走到全量预渲染路径（空文档 lineCount=1 也走，但内容可覆盖块挂遮罩）
    ed.cm.setValue('# 标题\n\n正文行。\n');

    // 实时预览走后台全量预渲染（2026-10-09 设计）：toggleViewMode 返回时
    // 预渲染在飞（视图仍停留在源码、按钮显示「渲染中」），完成回调后才真正切模式
    ed.toggleViewMode();
    assert.strictEqual(ed._wysiwygPreRendering, true, '进入实时预览应走后台预渲染（不再同步切换）');
    assert.strictEqual(ed.viewMode, 'edit', '预渲染在飞时视图应停留在源码');
    await delay(1500); // 等预渲染 50ms 计时器 + applyViewMode 的 50ms 遮罩计时器落地
    assert.strictEqual(ed._wysiwygPreRendering, false, '预渲染完成后状态应复位');
    assert.strictEqual(ed.viewMode, 'wysiwyg', '预渲染完成后应切到实时预览');
    assert.ok(container.classList.contains('wysiwyg-mode'), '切到 wysiwyg 应有 wysiwyg-mode 类');

    ed.toggleViewMode();
    assert.strictEqual(ed.viewMode, 'preview', '实时预览之后应循环回阅读');
    assert.ok(container.classList.contains('preview-mode'), '切到 preview 应有 preview-mode 类');

    ed.toggleViewMode();
    assert.strictEqual(ed.viewMode, 'edit', '阅读之后应循环到源码');
    assert.ok(!container.classList.contains('preview-mode'));
    assert.ok(!container.classList.contains('wysiwyg-mode'), '离开实时预览应清掉 wysiwyg-mode');
  } finally { cleanup(w); }
});

test('viewmode: 全量增量刷新——同一源文本的重复块被删时 srcQueue 取空降级不崩', async () => {
  const { w, ed } = await makeEditor();
  try {
    // 两个完全相同的段落 = 同一源文本键的多个块：删掉其中一个后，
    // 增量刷新的 srcQueue 会提前取空——必须降级为撤遮罩，不能拿
    // undefined 当新索引崩掉（2026-10-09 真机：重复行文档编辑即崩）。
    // jsdom 环境无 UnifiedRenderer（挂不了真遮罩），直接构造块表 + 假标记
    // 验证匹配循环逻辑本身。
    ed.setViewMode('edit');
    ed.cm.setValue('# 标题\n\n重复行段落。\n\n重复行段落。\n\n另一段落。\n');
    ed.viewMode = 'wysiwyg';
    const mkBlock = (start, end) => {
      const b = { start, end, html: '<p>x</p>' };
      b.src = ed._wysiwygBlockSource(b);
      return b;
    };
    ed._wysiwygBlocks = [mkBlock(0, 1), mkBlock(2, 3), mkBlock(4, 5), mkBlock(6, 7)];
    ed._wysiwygActiveIdx = 0;
    const cleared = [];
    const fakeMark = (id) => ({ id, clear() { cleared.push(id); }, replacedWith: null });
    ed._wysiwygMarks = new Map([[1, fakeMark('m1')], [2, fakeMark('m2')], [3, fakeMark('m3')]]);

    // 删掉第二个重复段落（行 4）→ 直接调增量刷新（不等 250ms 防抖）
    ed.cm.replaceRange('', { line: 4, ch: 0 }, { line: 4, ch: Infinity });
    ed._refreshWysiwygFullIncremental(); // 修复前这里抛 TypeError: Cannot set properties of undefined

    assert.strictEqual((ed._wysiwygBlocks || []).length, 3, '删除后应重切为 3 块');
    // 取空的那个旧标记（m2，第二个重复段落）必须被撤掉
    assert.deepStrictEqual(cleared, ['m2'], '同一源文本队列取空时该旧遮罩应被撤除，实际: ' + JSON.stringify(cleared));
    // 遮罩索引必须全部落在新块表内（无悬挂引用）
    for (const idx of ed._wysiwygMarks.keys()) {
      assert.ok(idx >= 0 && idx < 3, '遮罩块索引越界（悬挂引用）: ' + idx);
    }
    // 源未变的两个块（第一个重复段落 + 另一段落）复用旧标记
    assert.strictEqual(ed._wysiwygMarks.size, 2, '源未变块应复用旧标记');
  } finally { cleanup(w); }
});

test('viewmode: applyViewMode(preview) 加 preview-mode 类并同步折叠钮状态', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.setViewMode('edit');
    ed.viewMode = 'preview';
    ed.applyViewMode();
    const container = w.document.querySelector('.editor-container');
    assert.ok(container.classList.contains('preview-mode'));
    const foldEditor = w.document.getElementById('btn-fold-editor');
    const foldPreview = w.document.getElementById('btn-fold-preview');
    assert.ok(foldEditor && foldPreview, '应存在分屏折叠钮（拖拽条内）');
    // 旧 side-btn 的 side-hidden 显隐已改由 CSS 状态类接管；jsdom 无布局，
    // 这里断言 JS 侧状态机：无折叠态时 side-active 不应残留
    assert.ok(!foldEditor.classList.contains('side-active'), 'preview 模式下编辑折叠钮不应保持激活态');
    assert.ok(!foldPreview.classList.contains('side-active'), 'preview 模式下预览折叠钮不应保持激活态');
  } finally { cleanup(w); }
});

test('viewmode: toggleCollapse 折叠/展开编辑器与预览（edit 模式）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.setViewMode('edit');
    const container = w.document.querySelector('.editor-container');
    ed.toggleCollapse('editor');
    assert.ok(container.classList.contains('editor-collapsed'), '应折叠编辑器');
    ed.toggleCollapse('editor');
    assert.ok(!container.classList.contains('editor-collapsed'), '再次切换应展开编辑器');
    ed.toggleCollapse('preview');
    assert.ok(container.classList.contains('preview-collapsed'), '应折叠预览');
  } finally { cleanup(w); }
});

test('viewmode: 纯预览模式下 toggleCollapse 不生效', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.setViewMode('preview');
    const container = w.document.querySelector('.editor-container');
    ed.toggleCollapse('editor');
    assert.ok(!container.classList.contains('editor-collapsed'), 'preview 模式下折叠编辑器应无效');
  } finally { cleanup(w); }
});

// 用户反馈（2026-10-24）：三模式切换的白色胶囊与工具栏上下横线紧贴，看起来像被切掉。
// 几何口径（真机实测）：.toolbar height 30 - 1px border-bottom = 内容区 29px；
// 胶囊高 = tab 内容高 + tab 上下内边距 2*2 + 胶囊上下内边距 2*2（方案 A 起已无描边）。
// 旧值（胶囊 3px / tab 2px + 行高随字号膨胀）在界面字号 15/18px 时胶囊 28~32px，
// 15px 时贴死、18px 时超出 29px 被 .toolbar-center 的 overflow 裁掉。
test('viewmode: 模式切换胶囊不与工具栏上下横线紧贴（内边距 + 行高回归）', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(require('./helpers/app-env.cjs').ROOT, 'src', 'styles.css'), 'utf8');
  const pick = (re, label) => {
    const m = re.exec(css);
    assert.ok(m, '未找到 ' + label + ' 的样式块');
    return m[0];
  };
  const tabsBlock = pick(/\.view-mode-tabs\s*\{[^}]*\}/, '.view-mode-tabs');
  assert.match(tabsBlock, /padding:\s*2px/, '胶囊容器内边距应为 2px（3px 会让胶囊顶满 29px 工具栏内容区，重新贴上横线）');

  // 基础态：正文标签可见时的垂直内边距 + 行高锁 1（避免行盒随界面字号膨胀）
  const tabBase = pick(/\.view-mode-tab\s*\{[^}]*\}/, '.view-mode-tab');
  assert.match(tabBase, /padding:\s*2px 14px/, '胶囊项垂直内边距应为 2px（与容器 2px 相加后默认总高 22px，上下各余 3.5px）');
  assert.match(tabBase, /line-height:\s*1[;\s]/, '胶囊项必须 line-height:1——否则界面字号 15/18px 时行盒膨胀，胶囊重新贴死甚至被裁');

  // 窄窗态：只显示图标（内容高 14px），垂直内边距同样不能取 4px（会让胶囊重新顶满）
  const narrow900 = pick(/@media \(max-width:\s*900px\)\s*\{[\s\S]*?\.view-mode-tab\s*\{[^}]*\}/, 'max-width:900px 的 .view-mode-tab');
  assert.match(narrow900, /padding:\s*2px 10px/, '窄窗（≤900px）胶囊项垂直内边距应为 2px，不得回退到 4px');
  const narrow700 = pick(/@media \(max-width:\s*700px\)\s*\{[\s\S]*?\.view-mode-tab\s*\{[^}]*\}/, 'max-width:700px 的 .view-mode-tab');
  assert.match(narrow700, /padding:\s*2px 8px/, '窄窗（≤700px）胶囊项垂直内边距应为 2px，不得回退到 4px');
});

// 方案 A（2026-10-24 用户选定，保留「实时预览（beta）」全称）：
// 轨道去描边（轮廓由 --bg-primary 与 --bg-toolbar 的明度差界定，9 套主题实测 1.14~1.20:1），
// 选中项从「实心主题色填充 + 白字 + 投影」改为「主题色淡底 + 主题色文字」，
// 悬停补灰淡底，transition 逐项给时长（旧写法只有末项拿到 0.2s，其余是 0s 瞬变）。
test('viewmode: 分段控件走浅色指示器方案（无描边 / 淡底选中 / hover / 过渡时长）', () => {
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(path.join(require('./helpers/app-env.cjs').ROOT, 'src', 'styles.css'), 'utf8');
  // 先剥注释：规则上方的说明文字里含 `transition: a, b, ... 0.2s` 这样的反例写法，
  // 不剥会被下面的正则先匹到（断言过假的坑）。
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const pick = (re, label) => {
    const m = re.exec(css);
    assert.ok(m, '未找到 ' + label + ' 的样式块');
    return m[0];
  };

  const tabsBlock = pick(/\.view-mode-tabs\s*\{[^}]*\}/, '.view-mode-tabs');
  assert.doesNotMatch(tabsBlock, /border:\s*1px/, '轨道不应再描边：轮廓改由 --bg-primary 与 --bg-toolbar 的明度差界定');
  // 轮廓用 inset box-shadow 补：不参与布局，才不会吃掉上面算好的 3.5px 上下空隙
  assert.match(tabsBlock, /box-shadow:\s*inset 0 0 0 1px color-mix/, '轨道应有 1px 发丝内环（必须用 inset box-shadow，用 border 会占布局、挤掉空隙）');

  const activeBlock = pick(/\.view-mode-tab\.active\s*\{[^}]*\}/, '.view-mode-tab.active');
  assert.match(activeBlock, /background-color:\s*var\(--accent-muted\)/, '选中项应为主题色淡底（实心填充在深色主题下会抢正文视觉重心）');
  assert.match(activeBlock, /color:\s*var\(--accent-color\)/, '选中项文字应为主题色');
  assert.match(activeBlock, /inset 0 0 0 1px color-mix/, '选中项应有主题色发丝内环（玻璃片质感，且不占布局）');
  assert.match(activeBlock, /var\(--shadow-sm\)/, '选中项应叠一档主题自带微投影');
  // 加粗靠 text-shadow 而不是 font-weight：字重变宽会让整个胶囊在切换时跳动
  assert.match(activeBlock, /text-shadow:\s*0 0 [\d.]+px currentColor/, '选中项加粗应用 text-shadow 外扩，不能用 font-weight');
  assert.doesNotMatch(activeBlock, /font-weight/, '选中项不得用 font-weight 加粗（会改变字宽 → 切换时胶囊跳动）');

  const hoverBlock = pick(/\.view-mode-tab:hover\s*\{[^}]*\}/, '.view-mode-tab:hover');
  assert.match(hoverBlock, /background-color:\s*var\(--bg-hover\)/, '未选中项悬停应有灰淡底，否则点击热区感太弱');

  // 选中项悬停必须单独覆盖，否则会落到上一条的灰底（语义变成「未选中」）
  const activeHover = pick(/\.view-mode-tab\.active:hover\s*\{[^}]*\}/, '.view-mode-tab.active:hover');
  assert.match(activeHover, /background-color:\s*var\(--accent-muted\)/, '选中项悬停应维持淡彩底');

  // transition 每一项都必须带时长：`transition: a, b, c 0.2s` 里只有 c 拿到 0.2s
  const tabBase = pick(/\.view-mode-tab\s*\{[^}]*\}/, '.view-mode-tab');
  const tr = /transition:\s*([^;]+);/.exec(tabBase);
  assert.ok(tr, '胶囊项应有 transition');
  const items = tr[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.ok(items.length >= 2, 'transition 应至少覆盖 background-color 与 color');
  items.forEach((it) => {
    assert.match(it, /\d+m?s/, 'transition 每项都要自带时长，否则该项是 0s 瞬变：' + it);
  });
});
