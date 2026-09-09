// 快捷键设置项整理回归测试：
// 1. previewFind / findReplace 不再是独立设置项（与 find 同一功能 toggleFindPanel）
// 2. find 显示名为「查找替换」
// 3. crossSearch 出现在设置列表中，默认键 Ctrl+H
// 4. 设置列表按功能分组渲染（shortcut-group / shortcut-group-title）
// 5. 已保存的 previewFind / findReplace 键位在 loadShortcuts 中被迁移清理

const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

test('设置项：previewFind/findReplace 不再存在，find 改名查找替换', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    assert.strictEqual(ed.shortcuts.previewFind, undefined, 'previewFind 不应存在于 shortcuts');
    assert.strictEqual(ed.shortcuts.findReplace, undefined, 'findReplace 不应存在于 shortcuts');
    const defaults = ed.getDefaultShortcuts();
    assert.strictEqual(defaults.previewFind, undefined, 'previewFind 不应存在于默认方案');
    assert.strictEqual(defaults.findReplace, undefined, 'findReplace 不应存在于默认方案');
    const zhLabels = ed.t('shortcutLabel');
    assert.strictEqual(zhLabels.find, '查找替换', 'find 显示名应为「查找替换」');
    assert.strictEqual(zhLabels.previewFind, undefined, 'shortcutLabel 不应再含 previewFind');
  } finally {
    cleanup(w);
  }
});

test('设置项：crossSearch 出现在设置列表且默认 Ctrl+H', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    assert.strictEqual(ed.shortcuts.crossSearch?.key, 'Ctrl+H', 'crossSearch 默认键应为 Ctrl+H');
    ed.renderShortcutsList();
    const row = w.document.querySelector('#shortcuts-list .shortcut-row[data-action="crossSearch"]');
    assert.ok(row, '设置列表中应有 crossSearch 行');
    assert.match(row.textContent, /跨文件搜索/, 'crossSearch 行应显示「跨文件搜索」');
    // previewFind 行不应存在
    const pfRow = w.document.querySelector('#shortcuts-list .shortcut-row[data-action="previewFind"]');
    assert.strictEqual(pfRow, null, '设置列表中不应有 previewFind 行');
  } finally {
    cleanup(w);
  }
});

test('设置项：列表按功能分组渲染且默认项全覆盖', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    ed.renderShortcutsList();
    const groups = w.document.querySelectorAll('#shortcuts-list .shortcut-group');
    assert.ok(groups.length >= 5, `应至少有 5 个分组，实际 ${groups.length}`);
    const titles = [...w.document.querySelectorAll('#shortcuts-list .shortcut-group-title')].map(el => el.textContent.trim());
    assert.ok(titles.includes('文件'), '应有「文件」分组');
    assert.ok(titles.includes('查找与搜索'), '应有「查找与搜索」分组');
    // 所有默认设置项都应渲染出来（分组不遗漏）
    const renderedIds = new Set([...w.document.querySelectorAll('#shortcuts-list .shortcut-row')].map(el => el.dataset.action));
    for (const id of Object.keys(ed.getDefaultShortcuts())) {
      assert.ok(renderedIds.has(id), `设置项 ${id} 应在分组列表中渲染`);
    }
  } finally {
    cleanup(w);
  }
});

test('迁移：已保存的 previewFind/findReplace 键位被清理，旧 crossSearch 键位迁移为 Ctrl+H', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    // 模拟旧版本保存的配置
    w.localStorage.setItem('tizumark-shortcuts', JSON.stringify({
      previewFind: { key: 'Ctrl+Shift+P', label: '预览查找' },
      findReplace: { key: 'Ctrl+H', label: '查找和替换' },
      crossSearch: { key: 'Ctrl+Shift+F', label: '跨文件搜索' },
    }));
    const loaded = ed.loadShortcuts();
    assert.strictEqual(loaded.previewFind, undefined, '已保存的 previewFind 应被迁移清理');
    assert.strictEqual(loaded.findReplace, undefined, '已保存的 findReplace 应被迁移清理');
    assert.strictEqual(loaded.crossSearch.key, 'Ctrl+H', '旧 Ctrl+Shift+F 应迁移为 Ctrl+H');
  } finally {
    cleanup(w);
  }
});

test('设置布局：内置与可配置两大分类分区渲染（可折叠）', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    ed.renderShortcutsList();
    const sections = w.document.querySelectorAll('#shortcuts-list .shortcut-section');
    assert.strictEqual(sections.length, 2, '应有两个折叠分类（内置 / 可配置）');
    const titles = [...w.document.querySelectorAll('#shortcuts-list .shortcut-section-title .shortcut-section-name')].map(el => el.textContent.trim());
    assert.ok(titles.includes('内置快捷键'), '应有「内置快捷键」分类');
    assert.ok(titles.includes('方案与自定义快捷键'), '应有「方案与自定义快捷键」分类');
    // 可配置区仍包含原有功能分组与全部设置项
    const renderedIds = new Set([...w.document.querySelectorAll('#shortcuts-list .shortcut-row')].map(el => el.dataset.action));
    for (const id of Object.keys(ed.getDefaultShortcuts())) {
      assert.ok(renderedIds.has(id), `设置项 ${id} 应在可配置分类中渲染`);
    }
    // 内置区以紧凑两列表格渲染（快捷键 | 名称+说明），含解释文本
    const builtinTable = w.document.querySelector('#shortcuts-list .shortcut-builtin-table');
    assert.ok(builtinTable, '内置快捷键应以表格形式渲染');
    const builtinRows = w.document.querySelectorAll('#shortcuts-list .shortcut-builtin-row');
    assert.ok(builtinRows.length >= 15, `内置快捷键应逐项展示（含解释），实际 ${builtinRows.length}`);
    assert.strictEqual(builtinRows[0].tagName.toLowerCase(), 'tr', '内置行应为表格行 tr');
    assert.ok(builtinRows[0].querySelector('td.shortcut-builtin-key'), '内置行应有快捷键单元格');
    assert.ok(builtinRows[0].querySelector('td.shortcut-builtin-meta .shortcut-label').textContent.includes('跳到开头'), '内置项应含名称');
    assert.ok(builtinRows[0].querySelector('.shortcut-builtin-desc').textContent.includes('整篇文档'), '内置项应含解释说明');
  } finally {
    cleanup(w);
  }
});

test('设置布局：内置分类默认收缩置顶，可折叠/展开，状态保留在折叠属性上', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    const locate = (key) => [...w.document.querySelectorAll('#shortcuts-list .shortcut-section')]
      .find(s => s.querySelector(`.shortcut-section-title[data-toggle="${key}"]`));
    ed.renderShortcutsList();
    // 顺序：内置在前、方案与自定义在后
    const sections = [...w.document.querySelectorAll('#shortcuts-list .shortcut-section')];
    assert.strictEqual(sections[0].querySelector('.shortcut-section-title').dataset.toggle, 'builtin', '内置分类应在顶部');
    assert.strictEqual(sections[1].querySelector('.shortcut-section-title').dataset.toggle, 'config', '方案与自定义应在其后');
    // 默认：内置与方案与自定义全部展开
    const builtinSection = locate('builtin');
    assert.strictEqual(builtinSection.getAttribute('data-collapsed'), 'false', '内置分类初始应为展开');
    const configSection = locate('config');
    assert.strictEqual(configSection.getAttribute('data-collapsed'), 'false', '方案与自定义初始应为展开');
    // 收缩时 body 带 data-collapsed 父级，CSS 规则 .shortcut-section[data-collapsed="true"] .shortcut-section-body { display:none } 生效
    assert.strictEqual(builtinSection.querySelector('.shortcut-section-body').parentElement, builtinSection, '内置 body 应位于内置 section 内');
    // 点击内置标题收起
    const title = builtinSection.querySelector('.shortcut-section-title');
    title.dispatchEvent(new w.Event('click', { bubbles: true }));
    assert.strictEqual(builtinSection.getAttribute('data-collapsed'), 'true', '点击后应收起');
    // 收起后重渲染应保持收起状态
    ed.renderShortcutsList();
    const reSection = locate('builtin');
    assert.strictEqual(reSection.getAttribute('data-collapsed'), 'true', '重渲染后应维持收起');
    // 再点击恢复展开
    reSection.querySelector('.shortcut-section-title').dispatchEvent(new w.Event('click', { bubbles: true }));
    assert.strictEqual(reSection.getAttribute('data-collapsed'), 'false', '再次点击应展开');
  } finally {
    cleanup(w);
  }
});

test('回归：折叠标题 hover 背景使用 color-mix 实体色，确保不透明（不穿透下层内容）', async () => {
  const fs = require('fs');
  const path = require('path');
  const cssPath = path.resolve(__dirname, '..', 'src', 'styles.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  // 三处折叠标题（快捷键、设置、关于）的 hover 必须使用 color-mix 实体色，禁止透明 rgba 叠加，
  // 否则 sticky 标题条下方内容会穿透。
  const opaque = /color-mix\(in srgb, var\(--bg-secondary\) 88%, var\(--text-primary\) 12%\)/;
  const strongPattern = /\.shortcut-section-title:hover\s*\{\s*background-color:\s*color-mix/;
  const settingsStrongPattern = /\.settings-section-title:hover\s*\{\s*background-color:\s*color-mix/;
  const dependencyStrongPattern = /\.dependency-details \.dependency-title:hover\s*\{\s*background-color:\s*color-mix/;
  assert.ok(strongPattern.test(css), '快捷键折叠标题 hover 应使用 color-mix 实体色（不透明）');
  assert.ok(settingsStrongPattern.test(css), '设置折叠标题 hover 应使用 color-mix 实体色（不透明）');
  assert.ok(dependencyStrongPattern.test(css), '关于折叠标题 hover 应使用 color-mix 实体色（不透明）');
  // 防止退化回透明 rgba 写法
  assert.ok(!/\.shortcut-section-title:hover\s*\{\s*background-color: rgba\(/.test(css), '快捷键标题 hover 禁止使用 rgba 透明色');
  assert.ok(!/\.settings-section-title:hover\s*\{\s*background-color: rgba\(/.test(css), '设置标题 hover 禁止使用 rgba 透明色');
  assert.ok(!/\.dependency-details \.dependency-title:hover\s*\{\s*background-color: rgba\(/.test(css), '关于标题 hover 禁止使用 rgba 透明色');
});

test('样式：快捷键分类标题与文件/大纲面板头一致，弹窗标题收窄精致化', async () => {
  const fs = require('fs');
  const path = require('path');
  const STYLES = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

  // 快捷键可折叠分类标题使用常驻浅灰底（bg-secondary），静态即可辨识为折叠控件
  assert.ok(
    /\.shortcut-section-title\s*\{[^}]*background-color:\s*var\(--bg-secondary\)/.test(STYLES),
    'shortcut-section-title 应使用 bg-secondary 常驻浅灰底（区别于内容白底）'
  );
  // 分类标题文字颜色使用更醒目的 text-primary（精致扁平风），图标使用主题色
  assert.ok(
    /\.shortcut-section-title\s*\{[^}]*color:\s*var\(--text-primary\)/.test(STYLES),
    'shortcut-section-title 文字应使用更醒目的 text-primary'
  );
  // 左侧图标使用与 panel-title-icon 一致的类名：收起态浅灰、展开态随标题一起变主题色
  assert.ok(
    /\.shortcut-section-title\s+\.panel-title-icon\s*\{[^}]*color:\s*var\(--text-secondary\)/.test(STYLES),
    'shortcut-section-title 内图标收起态应为浅灰'
  );
  assert.ok(
    /\.shortcut-section\[data-collapsed="false"\]\s+\.shortcut-section-title\s+\.panel-title-icon[^}]*color:\s*var\(--accent-color\)/.test(STYLES),
    '展开态图标应变主题色'
  );
  // 弹窗标题统一收窄
  assert.ok(
    /\.dialog-header\s*\{[^}]*padding:\s*(?:8px 14px|10px 16px|8px 12px)/.test(STYLES),
    'dialog-header 应收窄 padding'
  );
  // 标题字号跟随 --ui-font-size（13px），便于整体 UI 字号联动；不再硬编码 px
  assert.ok(
    /\.dialog-header h2\s*\{[^}]*font-size:\s*(?:13px|calc\(var\(--ui-font-size\))/.test(STYLES),
    'dialog-header 标题字号应跟随 --ui-font-size（或 13px）'
  );
});

test('布局：快捷键方案下拉归位于「方案与自定义」分类内', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    ed.renderShortcutsList();
    const configSection = [...w.document.querySelectorAll('#shortcuts-list .shortcut-section')]
      .find(s => s.querySelector('.shortcut-section-title[data-toggle="config"]'));
    assert.ok(configSection, '应能定位方案与自定义分类');
    const host = configSection.querySelector('#shortcuts-scheme-host');
    assert.ok(host, '配置分类内应包含方案下拉占位容器');
    // 方案 Select 的宿主节点应被挂接到占位容器内
    assert.strictEqual(ed._schemeHost && ed._schemeHost.parentElement, host, '方案 Select 宿主应挂入占位容器');
  } finally {
    cleanup(w);
  }
});

test('校验：录制内置固定快捷键被拒绝（不写入、提示占用）', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    const toasts = [];
    ed.showToast = (msg) => toasts.push(msg);
    ed.recordingAction = 'bold';
    const before = ed.shortcuts.bold.key;
    // 录制 Ctrl+Home（内置跳到开头）应被拦截
    const handled = ed.handleShortcutRecording({ key: 'Home', ctrlKey: true, preventDefault() {}, stopPropagation() {} });
    assert.strictEqual(handled, true, '应吞掉该按键事件');
    assert.strictEqual(ed.shortcuts.bold.key, before, '内置键不可占用，bold 键位不应被改写');
    assert.strictEqual(ed.recordingAction, null, '录制应被中止');
    assert.strictEqual(toasts.length, 1, '应弹出占用提示');
    assert.match(String(toasts[0]), /内置快捷键/, '提示应说明是内置快捷键');
  } finally {
    cleanup(w);
  }
});

test('校验：findBuiltinShortcut 规范比对（Ctrl/Control、大小写均命中）', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    assert.ok(ed.getBuiltinFixedShortcuts().length >= 15, '内置快捷键清单应已定义');
    assert.ok(ed.findBuiltinShortcut('Ctrl+Home'), 'Ctrl+Home 应命中内置');
    assert.ok(ed.findBuiltinShortcut('Control+ArrowLeft'), 'Control+ArrowLeft 应命中（修饰键别名/大小写归一）');
    assert.strictEqual(ed.findBuiltinShortcut('Ctrl+G'), null, '普通键不应误判为内置');
  } finally {
    cleanup(w);
  }
});

test('显示：formatShortcutDisplay 方向键映射为直观符号', async () => {
  const { w } = await buildEnv({ captureInitErr: true });
  try {
    await waitForEditor(w);
    const ed = w.editor;
    assert.match(ed.formatShortcutDisplay('Ctrl+ArrowLeft'), /←/, '← 符号');
    assert.match(ed.formatShortcutDisplay('Ctrl+ArrowRight'), /→/, '→ 符号');
    assert.match(ed.formatShortcutDisplay('Ctrl+Home'), /Ctrl/, 'Home 保持文本 Ctrl');
  } finally {
    cleanup(w);
  }
});
