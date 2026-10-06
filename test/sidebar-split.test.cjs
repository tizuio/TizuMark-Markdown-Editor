// 侧边栏分屏改造（文件在上 / 大纲在下）回归测试：
// - 双面板常显（无 .hidden 互斥）
// - 水平分隔条 #sidebar-h-resizer 存在、#tab-outline/#tab-files 已移除
// - 拖拽分隔条改变文件面板 flex-basis 并写入 settings.filesPanelRatio
// - 大纲层级过滤（outlineFilterLevel）按 maxLevel 裁剪渲染
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');
const Outline = require('../src/modules/outline.js');
const fs = require('fs');
const path = require('path');
// jsdom 不加载 styles.css，computed style 断言不可靠；折叠态的视觉位置由 CSS 规则保证，
// 这里直接校验源码中存在对应规则作为回归护栏。
const STYLES = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

async function makeEditor() {
  const { w, getInitErr } = await buildEnv({ captureInitErr: true });
  await delay(300);
  return { w, ed: w.editor, getInitErr };
}

function sampleEntries() {
  return [
    { name: 'c.md', path: '/root/c.md', is_dir: false, mtime: 300, size: 2048 },
    { name: 'a.md', path: '/root/a.md', is_dir: false, mtime: 100, size: 512 },
    { name: 'proj', path: '/root/proj', is_dir: true, mtime: 50, size: 0 },
    { name: 'docs', path: '/root/docs', is_dir: true, mtime: 10, size: 0 },
  ];
}

test('sidebar-split: 双面板常显，tab 切换元素已移除', async () => {
  const { w, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const outline = w.document.getElementById('outline-content');
    const folder = w.document.getElementById('folder-content');
    assert.ok(outline, '#outline-content 应存在');
    assert.ok(folder, '#folder-content 应存在');
    // 分屏后两面板都不再用 .hidden 隐藏
    assert.ok(!outline.classList.contains('hidden'), '大纲面板不应被 hidden');
    assert.ok(!folder.classList.contains('hidden'), '文件面板不应被 hidden');
    // 旧的 tab 切换按钮应已移除
    assert.strictEqual(w.document.getElementById('tab-outline'), null, '#tab-outline 应已移除');
    assert.strictEqual(w.document.getElementById('tab-files'), null, '#tab-files 应已移除');
    // 水平分隔条应存在
    assert.ok(w.document.getElementById('sidebar-h-resizer'), '#sidebar-h-resizer 应存在');
  } finally { cleanup(w); }
});

test('sidebar-split: 文件树与大纲同时渲染', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.TauriApi.listDir = async () => sampleEntries();
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();
    const treeLabels = Array.from(w.document.querySelectorAll('#folder-tree .tree-label')).map((e) => e.textContent);
    assert.deepStrictEqual(treeLabels, ['docs', 'proj', 'a.md', 'c.md']);

    // 大纲随内容渲染到 #outline-content
    ed.cm.setValue('# 标题一\n## 子标题\n# 标题二\n');
    ed.updateOutline();
    const items = w.document.querySelectorAll('#outline-content .outline-item');
    assert.ok(items.length >= 3, '大纲应渲染多个标题项');
  } finally { cleanup(w); }
});

test('sidebar-split: 拖拽分隔条改变文件面板高度比例并持久化', async () => {
  const { w, ed } = await makeEditor();
  try {
    const resizer = w.document.getElementById('sidebar-h-resizer');
    const filesPanel = w.document.getElementById('folder-content');
    const sidebar = w.document.getElementById('outline-sidebar');
    assert.ok(resizer && filesPanel && sidebar);

    // 模拟 sidebar 有确定高度（jsdom 默认 offsetHeight=0，直接赋 style 高度）
    sidebar.style.height = '600px';
    filesPanel.style.flexBasis = '300px';
    const before = filesPanel.style.flexBasis;

    // mousedown 记录起点
    const down = new w.window.MouseEvent('mousedown', { bubbles: true, clientY: 100 });
    resizer.dispatchEvent(down);
    // mousemove 拖动 +80px
    const move = new w.window.MouseEvent('mousemove', { bubbles: true, clientY: 180 });
    w.document.dispatchEvent(move);
    assert.notStrictEqual(filesPanel.style.flexBasis, before, '拖拽后文件面板 flex-basis 应变化');

    // mouseup 写入比例
    const up = new w.window.MouseEvent('mouseup', { bubbles: true });
    w.document.dispatchEvent(up);
    assert.ok(typeof ed.settings.filesPanelRatio === 'number', 'filesPanelRatio 应被写入');
    assert.ok(ed.settings.filesPanelRatio > 0 && ed.settings.filesPanelRatio < 1, 'filesPanelRatio 应在 0~1');
  } finally { cleanup(w); }
});

test('sidebar-split: showSidebar 确保侧栏可见（替代旧 showSidebarTab）', async () => {
  const { w, ed } = await makeEditor();
  try {
    const sidebar = w.document.getElementById('outline-sidebar');
    sidebar.classList.add('hidden');
    ed.settings.sidebarHidden = true;
    ed.showSidebar();
    assert.ok(!sidebar.classList.contains('hidden'), 'showSidebar 后侧栏应可见');
    assert.strictEqual(ed.settings.sidebarHidden, false);
    assert.strictEqual(typeof ed.showSidebarTab, 'undefined', '旧 showSidebarTab 应已删除');
  } finally { cleanup(w); }
});

test('sidebar-split: 大纲层级过滤 maxLevel 裁剪渲染', async () => {
  const { w, ed } = await makeEditor();
  try {
    const md = [
      '# H1',
      '## H2',
      '### H3',
      '#### H4',
      '##### H5',
      '###### H6',
      '# H1-2',
    ].join('\n');
    ed.cm.setValue(md);
    ed.settings.outlineFilterLevel = 0; // 全部
    ed.updateOutline();
    let items = w.document.querySelectorAll('#outline-content .outline-item');
    assert.strictEqual(items.length, 7, '全部时应渲染 7 个标题');

    ed.settings.outlineFilterLevel = 2; // 仅 H1–H2
    ed.updateOutline();
    items = w.document.querySelectorAll('#outline-content .outline-item');
    assert.strictEqual(items.length, 3, '过滤到 H2 时应为 3 个（2×H1 + 1×H2）');
    // 渲染结果不得包含 level-3 及更深
    const deep = w.document.querySelectorAll('#outline-content .outline-item.level-3, #outline-content .outline-item.level-4, #outline-content .outline-item.level-5, #outline-content .outline-item.level-6');
    assert.strictEqual(deep.length, 0, '不应渲染 H3 及以下');
  } finally { cleanup(w); }
});

test('sidebar-split: renderOutlineHtml maxLevel 纯函数（父节点保留、深子树跳过）', async () => {
  const { w } = await makeEditor();
  try {
    const headings = Outline.extractHeadings('# A\n## B\n### C\n## D\n', {});
    const tree = Outline.buildOutlineTree(headings);
    const html = Outline.renderOutlineHtml(tree, { escapeHtml: (s) => s, maxLevel: 2 });
    assert.ok(html.includes('level-1'), '应含 H1');
    assert.ok(html.includes('level-2'), '应含 H2');
    assert.ok(!html.includes('level-3'), '不应含 H3');
  } finally { cleanup(w); }
});

test('sidebar-split: outline-filter 下拉存在并切换过滤级别', async () => {
  const { w, ed } = await makeEditor();
  try {
    const filterHost = w.document.getElementById('outline-filter');
    assert.ok(filterHost, '#outline-filter 容器应存在');
    assert.ok(ed._outlineFilterSelect, '大纲过滤下拉应已自绘为 Select 组件');

    ed.cm.setValue('# H1\n## H2\n### H3\n');
    ed.settings.outlineFilterLevel = 0;
    ed.updateOutline();
    assert.strictEqual(w.document.querySelectorAll('#outline-content .outline-item').length, 3);

    // 模拟用户在下拉列表中点击「仅 H1–H2」（value='2'）：先 open 渲染选项，再点击选项触发 onChange
    ed._outlineFilterSelect.open();
    const opt = filterHost.querySelector('.select-component-item[data-value="2"]');
    assert.ok(opt, '下拉应渲染 value=2 的选项');
    opt.dispatchEvent(new w.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(ed.settings.outlineFilterLevel, 2, '切换后 setting 应为 2');
    await delay(10);
    assert.strictEqual(w.document.querySelectorAll('#outline-content .outline-item').length, 2, '过滤后仅 2 项');
  } finally { cleanup(w); }
});

test('sidebar-split: 面板 header 带图标与标题，上下对齐', async () => {
  const { w, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const filesHeader = w.document.querySelector('.files-panel-header');
    const outlineHeader = w.document.querySelector('.outline-panel-header');
    assert.ok(filesHeader, '.files-panel-header 应存在');
    assert.ok(outlineHeader, '.outline-panel-header 应存在');
    // 文件头：图标 + 「文件」标题
    assert.ok(filesHeader.querySelector('.panel-title-icon'), '文件头应带图标');
    assert.strictEqual(filesHeader.querySelector('.panel-title').textContent.trim(), '文件', '文件头标题应为「文件」');
    // 大纲头：图标 + 「大纲」标题
    assert.ok(outlineHeader.querySelector('.panel-title-icon'), '大纲头应带图标');
    assert.strictEqual(outlineHeader.querySelector('.panel-title').textContent.trim(), '大纲', '大纲头标题应为「大纲」');
    // 折叠按钮与「全部」按钮均存在
    assert.ok(w.document.getElementById('files-chevron'), '文件折叠按钮应存在');
    assert.ok(w.document.getElementById('outline-chevron'), '大纲折叠按钮应存在');
    assert.ok(w.document.getElementById('btn-all-folders'), '文件全部按钮应存在');
    assert.ok(w.document.getElementById('btn-all-outline'), '大纲全部按钮应存在');
  } finally { cleanup(w); }
});

test('sidebar-split: 折叠文件面板 → 大纲占满，resizer 隐藏', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    ed.settings.filesCollapsed = true;
    ed.applyPanelCollapse();
    const filesPanel = w.document.getElementById('folder-content');
    const outlinePanel = w.document.getElementById('outline-content');
    const resizer = w.document.getElementById('sidebar-h-resizer');
    const sidebar = w.document.getElementById('outline-sidebar');
    assert.ok(filesPanel.classList.contains('panel-collapsed'), '文件面板应被折叠');
    assert.ok(!outlinePanel.classList.contains('panel-collapsed'), '大纲面板不应被折叠');
    assert.ok(resizer.classList.contains('hidden'), '任一折叠时 resizer 应隐藏');
    // 状态类：文件折叠时 sidebar 挂 files-collapsed（自然顺序停靠模型，不 reorder）
    assert.ok(sidebar.classList.contains('files-collapsed'), '折叠文件时侧栏应有 files-collapsed 状态类');
    // 新模型：折叠面板缩为标题条、另一面板占满剩余；标题相对位置不变（文件标题恒在上、大纲恒在下）
    assert.ok(!/\#outline-sidebar\.files-collapsed\s+\.folder-content\s*\{[^}]*order:\s*3/.test(STYLES), '新模型不应再用 order:3 把文件面板推到底部');
    assert.ok(
      /\#outline-sidebar\.files-collapsed\s+\.folder-content\s*\{[^}]*flex:\s*0 0 auto/.test(STYLES),
      '折叠态文件面板应 flex:0 0 auto 缩为标题条高度',
    );
    // 切换回展开
    ed.settings.filesCollapsed = false;
    ed.applyPanelCollapse();
    assert.ok(!filesPanel.classList.contains('panel-collapsed'), '展开后文件面板不应折叠');
    assert.ok(!sidebar.classList.contains('files-collapsed'), '展开后侧栏应移除 files-collapsed');
    assert.ok(!resizer.classList.contains('hidden'), '均展开时 resizer 应显示');
  } finally { cleanup(w); }
});

test('sidebar-split: 折叠大纲面板 → 文件占满', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    ed.settings.outlineCollapsed = true;
    ed.applyPanelCollapse();
    const filesPanel = w.document.getElementById('folder-content');
    const outlinePanel = w.document.getElementById('outline-content');
    assert.ok(outlinePanel.classList.contains('panel-collapsed'), '大纲面板应被折叠');
    assert.ok(!filesPanel.classList.contains('panel-collapsed'), '文件面板不应被折叠');
  } finally { cleanup(w); }
});

test('sidebar-split: 一键全部展开/折叠文件目录', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    // 多级目录：/root/proj/sub
    const tree = {
      '/root': [
        { name: 'a.md', path: '/root/a.md', is_dir: false, mtime: 1, size: 1 },
        { name: 'proj', path: '/root/proj', is_dir: true, mtime: 1, size: 0 },
      ],
      '/root/proj': [
        { name: 'sub', path: '/root/proj/sub', is_dir: true, mtime: 1, size: 0 },
      ],
      '/root/proj/sub': [
        { name: 'b.md', path: '/root/proj/sub/b.md', is_dir: false, mtime: 1, size: 1 },
      ],
    };
    w.TauriApi.listDir = async (args) => tree[args.path] || [];
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();

    // 默认全折叠：所有 .tree-children 隐藏
    let hiddenCount = w.document.querySelectorAll('#folder-tree .tree-children.hidden').length;
    assert.ok(hiddenCount >= 1, '默认应存在隐藏的子目录块');

    // 一键展开
    await ed.toggleAllFolders(true);
    const allFolders = w.document.querySelectorAll('#folder-tree .tree-node.tree-folder');
    const visibleChildren = w.document.querySelectorAll('#folder-tree .tree-children:not(.hidden)');
    assert.strictEqual(allFolders.length, 2, '应渲染 2 个目录节点（proj、sub）');
    assert.strictEqual(visibleChildren.length, 2, '展开后两个子目录块都应可见');
    assert.ok(ed.expandedFolders.has('/root/proj'), 'expandedFolders 应含 /root/proj');
    assert.ok(ed.expandedFolders.has('/root/proj/sub'), 'expandedFolders 应含 /root/proj/sub');

    // 一键折叠
    await ed.toggleAllFolders(false);
    // 重渲染后所有已渲染的 .tree-children 都应隐藏（子目录懒加载未展开属正常）
    const allChildren = w.document.querySelectorAll('#folder-tree .tree-children');
    const hiddenAfter = w.document.querySelectorAll('#folder-tree .tree-children.hidden').length;
    assert.strictEqual(hiddenAfter, allChildren.length, '折叠后所有已渲染子目录块都应隐藏');
    assert.strictEqual(ed.expandedFolders.size, 0, 'expandedFolders 应清空');
  } finally { cleanup(w); }
});

test('sidebar-split: 一键全部展开/折叠大纲', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    // 构造带嵌套的大纲 DOM（H1 > H2 > H3）
    const content = w.document.getElementById('outline-content');
    content.innerHTML = [
      '<div class="outline-item-wrapper"><div class="outline-item level-1" data-id="1" data-line="1"><span class="outline-toggle"><svg viewBox="0 0 10 10" fill="currentColor"><path d="M1.5 1.5 L8.5 1.5 L5 8.5 Z"/></svg></span><span class="outline-label">A</span></div>',
      '<div class="outline-children"><div class="outline-item-wrapper"><div class="outline-item level-2" data-id="2" data-line="2"><span class="outline-toggle"><svg viewBox="0 0 10 10" fill="currentColor"><path d="M1.5 1.5 L8.5 1.5 L5 8.5 Z"/></svg></span><span class="outline-label">B</span></div>',
      '<div class="outline-children"><div class="outline-item-wrapper"><div class="outline-item level-3" data-id="3" data-line="3"><span class="outline-toggle outline-toggle--hidden"><svg viewBox="0 0 10 10" fill="currentColor"><path d="M1.5 1.5 L8.5 1.5 L5 8.5 Z"/></svg></span><span class="outline-label">C</span></div></div></div>',
      '</div></div></div>',
    ].join('');
    // 注意：不调用 updateOutline()，否则会用编辑器真实内容覆盖手造的嵌套 DOM。
    // 本用例只验证 toggleAllOutline 对现有 DOM 的批量折叠/展开行为。

    // 初始全部展开
    let collapsed = content.querySelectorAll('.outline-children.collapsed').length;
    assert.strictEqual(collapsed, 0, '初始应无折叠块');

    // 一键折叠
    ed.toggleAllOutline(false);
    collapsed = content.querySelectorAll('.outline-children.collapsed').length;
    assert.strictEqual(collapsed, 2, '折叠后应有 2 个折叠块');
    const toggles = content.querySelectorAll('.outline-toggle:not(.outline-toggle--hidden)');
    toggles.forEach((t) => assert.ok(t.classList.contains('collapsed'), '折叠后 toggle 应带 collapsed 类（CSS 旋转成 ▶）'));

    // 一键展开
    ed.toggleAllOutline(true);
    collapsed = content.querySelectorAll('.outline-children.collapsed').length;
    assert.strictEqual(collapsed, 0, '展开后应无折叠块');
    toggles.forEach((t) => assert.ok(!t.classList.contains('collapsed'), '展开后 toggle 不应带 collapsed 类（恢复 ▼ 向下）'));
  } finally { cleanup(w); }
});

test('sidebar-split: 收起文件面板后标题栏保留且置底', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const filesPanel = w.document.getElementById('folder-content');
    const filesHeader = filesPanel.querySelector('.files-panel-header');
    assert.ok(filesHeader, '文件面板应有标题栏');
    assert.ok(w.document.getElementById('files-chevron'), '应有文件面板 chevron');

    // 收起：仅加 panel-collapsed 类，标题栏保留在 DOM（修复「整块消失」#3）
    ed.togglePanel('files');
    assert.ok(filesPanel.classList.contains('panel-collapsed'), '收起后文件面板应有 panel-collapsed');
    assert.ok(filesPanel.querySelector('.files-panel-header'), '收起后标题栏仍保留在 DOM 中');
    assert.ok(w.document.getElementById('files-chevron'), '收起后 chevron 仍在');
    // 新模型：折叠态文件标题栏保留在文件面板顶部（自然顺序，不置底、不 reorder）
    assert.ok(
      /\#outline-sidebar\.files-collapsed\s+\.folder-content\s*\{[^}]*flex:\s*0 0 auto/.test(STYLES),
      '折叠态应通过 flex:0 0 auto 将文件面板缩为标题条高度（标题仍在顶部）',
    );
    assert.ok(
      !/\.folder-content\.panel-collapsed\s*\{[^}]*flex-direction:\s*column-reverse/.test(STYLES),
      '折叠态不应再用 column-reverse 把标题栏置底',
    );

    // 展开还原
    ed.togglePanel('files');
    assert.ok(!filesPanel.classList.contains('panel-collapsed'), '展开后不应有 panel-collapsed');
  } finally { cleanup(w); }
});

test('sidebar-split: 收起大纲面板后内容隐藏但标题栏保留', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const outlinePanel = w.document.getElementById('outline-content');
    const outlineHeader = w.document.querySelector('.outline-panel-header');
    assert.ok(outlineHeader, '大纲面板应有标题栏');

    ed.togglePanel('outline');
    assert.ok(outlinePanel.classList.contains('panel-collapsed'), '收起后大纲内容应有 panel-collapsed');
    // 标题栏是 #outline-content 的兄弟节点，折叠时不应被移除（保留可见）
    assert.ok(w.document.querySelector('.outline-panel-header'), '大纲标题栏应保留在 DOM 中');

    ed.togglePanel('outline');
    assert.ok(!outlinePanel.classList.contains('panel-collapsed'), '展开后恢复');
  } finally { cleanup(w); }
});

test('sidebar-split: 全部按钮双态图标 + chevron 方向', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const btnAllFolders = w.document.getElementById('btn-all-folders');
    const filesChevron = w.document.getElementById('files-chevron');
    // 建一棵浅目录树，避免 toggleAllFolders 递归时因未 stub 而卡慢
    w.TauriApi.listDir = async (args) => {
      if (args.path === '/root') return [{ name: 'proj', path: '/root/proj', is_dir: true, mtime: 1, size: 0 }];
      return [];
    };
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();

    // 初始：全部按钮为「展开」态（向上箭头），chevron 未 collapsed
    const initialBtnSvg = btnAllFolders.innerHTML;
    assert.ok(btnAllFolders.querySelector('svg'), '全部按钮应有图标');
    assert.ok(!filesChevron.classList.contains('collapsed'), '面板展开时 chevron 不应 collapsed');

    // 一键全部展开：按钮应切换为「向下箭头」（折叠态图标）
    await ed.toggleAllFolders(true);
    const expandedBtnSvg = btnAllFolders.innerHTML;
    assert.notStrictEqual(expandedBtnSvg, initialBtnSvg, '展开态图标应与初始折叠态不同（双态图标）');

    // 收起面板：chevron 加 collapsed 类（CSS 将其 ▼ 旋转 -90° 成 ▶）
    ed.togglePanel('files');
    assert.ok(filesChevron.classList.contains('collapsed'), '收起后面板 chevron 应 collapsed（向右）');
  } finally { cleanup(w); }
});

test('sidebar-split: 点击文件面板标题切换工作区 + 点击目录路径打开所在文件夹', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const filesHeader = w.document.querySelector('.files-panel-header .panel-title-group');
    const outlineHeader = w.document.querySelector('.outline-panel-header .panel-title-group');
    const folderPathEl = w.document.getElementById('folder-path');
    assert.ok(filesHeader, '文件面板标题区域应存在');
    assert.ok(outlineHeader, '大纲面板标题区域应存在');
    assert.ok(folderPathEl, '目录路径元素应存在');

    const origWs = ed.workspaceFolder;
    const origPick = ed.openFolder;
    const origOpen = ed.openContainingFolder;

    // 已打开工作区：点击「文件」标题 → 仍弹出文件夹选择（openFolder()），选中后切换工作区
    ed.workspaceFolder = 'C:\\workspace\\notes';
    let picked = 0;
    ed.openFolder = async () => { picked++; };
    filesHeader.click();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(picked, 1, '已打开工作区时点击标题也应弹出文件夹选择');

    // 已打开工作区：点击目录路径 → openContainingFolder(工作区, true)（isDir=true 打开文件夹自身）
    let opened = null;
    ed.openContainingFolder = async (p, isDir) => { opened = { p, isDir }; };
    folderPathEl.click();
    await new Promise(r => setTimeout(r, 20));
    assert.deepStrictEqual(opened, { p: 'C:\\workspace\\notes', isDir: true }, '点击路径应打开该文件夹（isDir=true）');

    // 未打开工作区：点击标题 → openFolder()；点击路径（无工作区）→ 不动作
    ed.workspaceFolder = null;
    picked = 0;
    filesHeader.click();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(picked, 1, '未打开工作区时点击标题应调用 openFolder()');
    opened = null;
    folderPathEl.click();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(opened, null, '未打开工作区时点击路径不应触发打开动作');

    ed.openFolder = origPick;
    ed.openContainingFolder = origOpen;
    ed.workspaceFolder = origWs;

    // 大纲标题：仍为折叠/展开切换（折叠面板由 chevron 承担，文件标题不再折叠）
    const outlineChevron = w.document.getElementById('outline-chevron');
    outlineHeader.click();
    assert.strictEqual(outlineChevron.getAttribute('aria-expanded'), 'false', '点击大纲标题应折叠面板');
    outlineHeader.click();
    assert.strictEqual(outlineChevron.getAttribute('aria-expanded'), 'true', '再次点击大纲标题应展开面板');
  } finally { cleanup(w); }
});

test('sidebar-split: 按钮体系字形族区分 + 无边框 + aria 状态', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const btnAllFolders = w.document.getElementById('btn-all-folders');
    const filesChevron = w.document.getElementById('files-chevron');
    const sortOrder = w.document.getElementById('folder-sort-order');

    // 三类按钮字形族不同（解决「区分度」诉求，统一 Lucide path 型图标后）：
    // 全部按钮=fold/unfold-vertical（多 path 折线收纳图标），面板 chevron=单箭头 disclosure(1 polyline)，排序=arrow-up/down-narrow-wide（多 path）
    assert.ok(btnAllFolders.querySelector('svg path'), '全部按钮应为 path 型 Lucide 图标（fold/unfold-vertical）');
    assert.strictEqual(btnAllFolders.querySelectorAll('svg line').length, 0, '全部按钮不应再有旧的三条横线 line');
    assert.strictEqual(filesChevron.querySelectorAll('svg polyline').length, 1, '面板 chevron 应为单箭头 disclosure');
    assert.ok(sortOrder.querySelector('svg path'), '排序按钮应使用 path 型 Lucide 箭头图标');
    assert.notStrictEqual(btnAllFolders.innerHTML, filesChevron.innerHTML, '全部按钮与面板 chevron 字形应不同');

    // 面板 chevron 折叠态应向右（CSS transform: rotate(-90deg)）
    assert.ok(/\.panel-chevron\.collapsed\s+svg\s*\{[^}]*transform:\s*rotate\(-90deg\)/.test(STYLES), '面板 chevron 折叠态应旋转 -90° 指向右侧');

    // 面板 chevron 折叠态 aria-expanded 实时反映
    assert.strictEqual(filesChevron.getAttribute('aria-expanded'), 'true', '展开态 aria-expanded=true');
    ed.togglePanel('files');
    assert.strictEqual(filesChevron.getAttribute('aria-expanded'), 'false', '收起态 aria-expanded=false');
    ed.togglePanel('files');
    assert.strictEqual(filesChevron.getAttribute('aria-expanded'), 'true', '再次展开 aria-expanded=true');

    // 全部按钮：双态双箭头 + aria-pressed 随展开态变化（建浅树避免递归卡慢）
    w.TauriApi.listDir = async (args) => {
      if (args.path === '/root') return [{ name: 'proj', path: '/root/proj', is_dir: true, mtime: 1, size: 0 }];
      return [];
    };
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();
    await ed.toggleAllFolders(true);
    assert.strictEqual(btnAllFolders.getAttribute('aria-pressed'), 'true', '全部展开后 aria-pressed=true');
    assert.ok(btnAllFolders.innerHTML.includes('m15 19-3-3-3 3'), '展开态图标应为 fold-vertical（点击折叠全部）');
    await ed.toggleAllFolders(false);
    assert.strictEqual(btnAllFolders.getAttribute('aria-pressed'), 'false', '全部折叠后 aria-pressed=false');
    assert.ok(btnAllFolders.innerHTML.includes('m15 19-3 3-3-3'), '折叠态图标应为 unfold-vertical（点击展开全部）');

    // 排序按钮点击切换方向与 aria-pressed
    const beforePressed = sortOrder.getAttribute('aria-pressed');
    sortOrder.click();
    // 点击触发 handler 内非 await 的 renderFolderTree()（src/app.js:5140），其 async 链
    // 会在测试返回后才落地 createElement，被 node:test 判为「测试结束后仍有异步活动」。
    // 这里显式排空，使该渲染在测试作用域内完成。
    await delay(60);
    assert.notStrictEqual(sortOrder.getAttribute('aria-pressed'), beforePressed, '点击排序按钮应切换 aria-pressed');

    // 排序按钮无边框（并入统一无边框图标体系，CSS 由 .folder-sort-order 保证）
    assert.ok(/\.folder-sort-order\s*\{[^}]*border:\s*none/.test(STYLES), '排序按钮应为无边框');
  } finally { cleanup(w); }
});

test('sidebar-split: 折叠保持标题相对位置（文件在上/大纲在下，自然顺序）', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const sidebar = w.document.getElementById('outline-sidebar');
    const folderContent = w.document.getElementById('folder-content');
    const outlineContent = w.document.getElementById('outline-content');

    // 文件折叠：文件面板收缩为标题条（flex:0 0 auto），大纲内容占满；标题仍保持文件在上
    ed.togglePanel('files');
    assert.ok(sidebar.classList.contains('files-collapsed'), '文件折叠时 sidebar 应有 files-collapsed');
    assert.ok(folderContent.classList.contains('panel-collapsed'), '文件面板应有 panel-collapsed');
    assert.ok(
      /#outline-sidebar\.files-collapsed\s+\.folder-content\s*\{[^}]*flex:\s*0 0 auto/.test(STYLES),
      '文件折叠时文件面板应收缩为标题条高度（flex:0 0 auto），而非 order 重排',
    );
    assert.ok(
      !/#outline-sidebar\.files-collapsed\s+\.folder-content\s*\{[^}]*order:\s*3/.test(STYLES),
      '文件折叠不应再用 order 把文件面板推到对侧（标题相对位置不变）',
    );

    // 还原
    ed.togglePanel('files');
    assert.ok(!sidebar.classList.contains('files-collapsed'), '再次展开文件应移除 files-collapsed');

    // 大纲折叠：大纲内容隐藏，文件内容占满；标题仍保持文件在上、大纲在下
    ed.togglePanel('outline');
    assert.ok(sidebar.classList.contains('outline-collapsed'), '大纲折叠时 sidebar 应有 outline-collapsed');
    assert.ok(outlineContent.classList.contains('panel-collapsed'), '大纲面板应有 panel-collapsed');
    assert.ok(
      /#outline-sidebar\.outline-collapsed\s+#outline-content\s*\{[^}]*display:\s*none/.test(STYLES),
      '大纲折叠时内容应 display:none',
    );
    assert.ok(
      !/#outline-sidebar\.outline-collapsed\s+\.folder-content\s*\{[^}]*order:\s*2/.test(STYLES),
      '大纲折叠不应再用 order 重排（标题相对位置不变）',
    );

    // 联动：仅显示大纲时点击收缩文件 → 文件折叠 + 大纲自动展开（保证至少一个可见，且尊重本次收起意图）
    ed.settings.filesCollapsed = false;
    ed.settings.outlineCollapsed = true;
    ed.applyPanelCollapse();
    ed.togglePanel('files');
    assert.strictEqual(ed.settings.filesCollapsed, true, '仅显示大纲时再点收缩文件应折叠文件面板');
    assert.strictEqual(ed.settings.outlineCollapsed, false, '联动：大纲面板应自动展开');

    // 反之同理：仅显示文件时点击收缩大纲 → 大纲折叠 + 文件自动展开
    ed.settings.filesCollapsed = true;
    ed.settings.outlineCollapsed = false;
    ed.applyPanelCollapse();
    ed.togglePanel('outline');
    assert.strictEqual(ed.settings.outlineCollapsed, true, '仅显示文件时再点收缩大纲应折叠大纲面板');
    assert.strictEqual(ed.settings.filesCollapsed, false, '联动：文件面板应自动展开');

    // 两者都展开时点收缩文件：只收文件，不联动（另一已展开）
    ed.settings.filesCollapsed = false;
    ed.settings.outlineCollapsed = false;
    ed.applyPanelCollapse();
    ed.togglePanel('files');
    assert.strictEqual(ed.settings.filesCollapsed, true, '两者都展开时收缩文件应仅收文件');
    assert.strictEqual(ed.settings.outlineCollapsed, false, '两者都展开时大纲应保持展开');

    // 双折叠异常态（持久化/历史脏数据）兜底：applyPanelCollapse 强制都展开，避免整栏空白
    ed.settings.filesCollapsed = true;
    ed.settings.outlineCollapsed = true;
    ed.applyPanelCollapse();
    assert.ok(
      !sidebar.classList.contains('files-collapsed') && !sidebar.classList.contains('outline-collapsed'),
      '双折叠异常态应被强制展开',
    );
  } finally { cleanup(w); }
});

test('sidebar-split: 折叠全部目录在部分子目录读取失败时仍可用', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const btn = w.document.getElementById('btn-all-folders');
    const tree = w.document.getElementById('folder-tree');

    // 深树：/root 含子目录 a；a 的子目录读取抛错（无权限），不应中断整体展开
    w.TauriApi.listDir = async (args) => {
      if (args.path === '/root') return [
        { name: 'a', path: '/root/a', is_dir: true, mtime: 1, size: 0 },
        { name: 'f.txt', path: '/root/f.txt', is_dir: false, mtime: 1, size: 0 },
      ];
      if (args.path === '/root/a') throw new Error('EACCES'); // 模拟无权限子目录
      return [];
    };
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();

    // 一键全部展开：即便子目录抛错也应成功完成，状态/按钮正确翻转（修复「折叠全部不管用」）
    await ed.toggleAllFolders(true);
    assert.strictEqual(ed._allFoldersExpanded, true, '展开后内部状态应为 true');
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'true', '展开后按钮 aria-pressed=true');
    assert.ok(ed.expandedFolders.has('/root/a'), 'a 目录应被标记为展开（即便其下读取失败）');

    // 再次点击执行折叠：验证「折叠全部」按钮可用，不再卡在展开态
    await ed.toggleAllFolders(false);
    assert.strictEqual(ed._allFoldersExpanded, false, '折叠后内部状态应为 false');
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'false', '折叠后按钮 aria-pressed=false');
    assert.strictEqual(ed.expandedFolders.size, 0, '折叠后展开集合应清空');
    assert.strictEqual(
      tree.querySelectorAll('.tree-children:not(.hidden)').length, 0,
      '折叠后所有目录子容器应隐藏',
    );
  } finally { cleanup(w); }
});

test('sidebar-split: 全部目录按钮基于 DOM 状态交替（再点击必折叠）', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const btn = w.document.getElementById('btn-all-folders');
    const tree = {
      '/root': [
        { name: 'a', path: '/root/a', is_dir: true, mtime: 1, size: 0 },
        { name: 'f.md', path: '/root/f.md', is_dir: false, mtime: 1, size: 1 },
      ],
      '/root/a': [{ name: 'b.md', path: '/root/a/b.md', is_dir: false, mtime: 1, size: 1 }],
    };
    w.TauriApi.listDir = async (args) => tree[args.path] || [];
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();
    await delay(50);

    // 第一次点击：当前无展开目录 → 展开全部
    btn.click();
    await delay(80);
    assert.strictEqual(ed._allFoldersExpanded, true, '第1次点击后应标记为已全展开');
    assert.ok(
      /m15 19-3-3-3 3/.test(btn.innerHTML),
      '第1次点击后图标应为 fold-vertical（折叠全部）',
    );
    assert.ok(w.document.querySelector('.tree-node.tree-folder.expanded'), '目录应已展开');

    // 第二次点击：当前有展开目录 → 应折叠全部（不再卡在展开态）
    btn.click();
    await delay(80);
    assert.strictEqual(ed._allFoldersExpanded, false, '第2次点击后应标记为已折叠');
    assert.ok(
      /m15 19-3 3-3-3/.test(btn.innerHTML),
      '第2次点击后图标应为 unfold-vertical（展开全部）',
    );
    assert.strictEqual(ed.expandedFolders.size, 0, '第2次点击后展开集合应清空');
  } finally { cleanup(w); }
});

test('sidebar-split: 折叠再展开文件面板后应重新应用比例（applySplitterRatio 被调用）', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const filesPanel = w.document.getElementById('folder-content');
    // jsdom 无布局高度，applySplitterRatio 会因 offsetHeight<=0 提前 return（真实 WebView 有高度会设 basis）。
    // 这里验证折叠清空 basis、且两面板重新展开时 applyPanelCollapse 确实再次调用了 applySplitterRatio。
    let ratioCalls = 0;
    const origRatio = ed.applySplitterRatio.bind(ed);
    ed.applySplitterRatio = function () { ratioCalls++; return origRatio(); };

    // 折叠文件面板（清空 basis，CSS 接管）
    ed.togglePanel('files');
    assert.strictEqual(filesPanel.style.flexBasis, '', '折叠后 flex-basis 应被清空');
    const ratioAfterCollapse = ratioCalls;

    // 再次展开两面板：应触发 applySplitterRatio（恢复按比例分配）
    ed.togglePanel('files');
    assert.ok(ratioCalls > ratioAfterCollapse, '从折叠恢复展开应重新调用 applySplitterRatio');
  } finally { cleanup(w); }
});

test('sidebar-split: 大纲默认全展开时按钮图标应为「折叠全部」（与状态一致）', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const btn = w.document.getElementById('btn-all-outline');
    const content = w.document.getElementById('outline-content');
    // 大纲默认全展开：init 时不应有任何 .outline-children.collapsed
    assert.strictEqual(content.querySelector('.outline-children.collapsed'), null, '默认不应有折叠的大纲子块');
    // 按钮应显示为「折叠全部」fold-vertical（m15 19-3-3-3 3），而非「展开全部」unfold-vertical
    assert.ok(/m15 19-3-3-3 3/.test(btn.innerHTML), '默认全展开时图标应为折叠全部（fold-vertical）');
    assert.strictEqual(ed._allOutlineExpanded, true, '_allOutlineExpanded 应初始化为 true');
  } finally { cleanup(w); }
});

test('sidebar-split: 点击「折叠全部大纲」按钮应真正折叠（不再无效）', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const btn = w.document.getElementById('btn-all-outline');
    const content = w.document.getElementById('outline-content');
    // 构造一个带子块的大纲
    content.innerHTML = '<div class="outline-item-wrapper"><div class="outline-children"><div class="outline-item">A</div></div></div>';
    // 重新同步按钮状态（模拟真实渲染后）
    ed._allOutlineExpanded = true;
    ed._updateAllOutlineBtn();
    // 点击：默认全展开 → anyExpanded=true → toggleAllOutline(false) → 折叠
    btn.click();
    assert.ok(content.querySelector('.outline-children.collapsed'), '点击后大纲子块应被折叠');
    assert.strictEqual(ed._allOutlineExpanded, false, '折叠后标志应翻转为 false');
    assert.ok(/m15 19-3 3-3-3/.test(btn.innerHTML), '折叠后图标应变为展开全部（unfold-vertical）');
  } finally { cleanup(w); }
});

test('sidebar-split: 展开/折叠全部目录显示 loading 并在完成后移除（超时兜底）', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const tree = {
      '/root': [
        { name: 'a', path: '/root/a', is_dir: true, mtime: 1, size: 0 },
        { name: 'f.md', path: '/root/f.md', is_dir: false, mtime: 1, size: 1 },
      ],
      '/root/a': [{ name: 'b.md', path: '/root/a/b.md', is_dir: false, mtime: 1, size: 1 }],
    };
    w.TauriApi.listDir = async (args) => tree[args.path] || [];
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();
    const btn = w.document.getElementById('btn-all-folders');
    // 点击展开全部：应显示 loading overlay 且按钮 disabled
    btn.click();
    const overlay = w.document.querySelector('.folder-loading-overlay');
    assert.ok(overlay, '点击后应出现 loading 覆盖层');
    assert.ok(!overlay.classList.contains('hidden'), 'loading 覆盖层应可见');
    assert.strictEqual(btn.disabled, true, '操作中按钮应被禁用');
    // 等待异步展开完成
    await delay(120);
    assert.ok(overlay.classList.contains('hidden'), '完成后 loading 应被隐藏');
    assert.strictEqual(btn.disabled, false, '完成后按钮应恢复可用');
    assert.strictEqual(ed._allFoldersExpanded, true, '展开后状态应为 true');
  } finally { cleanup(w); }
});

test('sidebar-split: 展开进行中点折叠应取消旧任务，不会继续展开', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const tree = {
      '/root': [
        { name: 'a', path: '/root/a', is_dir: true, mtime: 1, size: 0 },
        { name: 'f.md', path: '/root/f.md', is_dir: false, mtime: 1, size: 1 },
      ],
      '/root/a': [{ name: 'b.md', path: '/root/a/b.md', is_dir: false, mtime: 1, size: 1 }],
    };
    // 让 renderFolderLevel 慢下来，使展开任务在异步中途可被折叠打断
    let renderCalls = 0;
    const origRenderFolderLevel = ed.renderFolderLevel.bind(ed);
    ed.renderFolderLevel = async (path, container, depth) => {
      renderCalls++;
      await new Promise((res) => setTimeout(res, 30));
      return origRenderFolderLevel(path, container, depth);
    };
    w.TauriApi.listDir = async (args) => tree[args.path] || [];
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();

    // 触发展开全部（异步）
    const expandPromise = ed.toggleAllFolders(true);
    // 立即在下一个 tick 触发折叠，打断尚未完成的展开
    await new Promise((res) => setTimeout(res, 10));
    const collapsePromise = ed.toggleAllFolders(false);
    await Promise.all([expandPromise, collapsePromise]);

    // 最终状态必须是折叠：无 expanded 目录、无可见 tree-children
    const treeEl = w.document.getElementById('folder-tree');
    assert.strictEqual(treeEl.querySelectorAll('.tree-node.tree-folder.expanded').length, 0, '折叠后不应有 expanded 目录');
    assert.strictEqual(treeEl.querySelectorAll('.tree-children:not(.hidden)').length, 0, '折叠后所有子容器应 hidden');
    assert.strictEqual(ed._allFoldersExpanded, false, '折叠后状态标志应为 false');
    assert.strictEqual(ed.expandedFolders.size, 0, '折叠后 expandedFolders 应被清空');
  } finally { cleanup(w); }
});

// 回归：侧边栏吸附把手（用户反馈：标题栏位置不合适，改贴分隔线/左缘悬浮，一键开关免两步菜单）。
test('sidebar: 吸附把手一键开关侧边栏并同步骑缝/左缘两态', async () => {
  const { w, ed } = await makeEditor();
  try {
    const btn = w.document.getElementById('sidebar-float-btn');
    const sidebar = w.document.getElementById('outline-sidebar');
    assert.ok(btn, 'main 内应存在 #sidebar-float-btn 吸附把手');
    // 初始：侧边栏可见 → 骑缝态（sidebar-open）
    assert.strictEqual(sidebar.classList.contains('hidden'), false, '初始侧边栏应可见');
    assert.strictEqual(btn.classList.contains('sidebar-open'), true, '可见时把手应为骑缝态');
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'true', 'aria-pressed 应为 true');
    // 点击一次 → 关闭：把手脱离骑缝态（CSS 吸附左缘常亮）
    btn.dispatchEvent(new w.Event('click', { bubbles: true }));
    await delay(30);
    assert.strictEqual(sidebar.classList.contains('hidden'), true, '一次点击应关闭侧边栏');
    assert.strictEqual(btn.classList.contains('sidebar-open'), false, '关闭后应脱离骑缝态（吸附左缘）');
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'false', 'aria-pressed 应为 false');
    assert.strictEqual(ed.settings.sidebarHidden, true, 'settings.sidebarHidden 应同步为 true');
    // 再点一次 → 打开（此前痛点：菜单要两步）
    btn.dispatchEvent(new w.Event('click', { bubbles: true }));
    await delay(30);
    assert.strictEqual(sidebar.classList.contains('hidden'), false, '再次单击应直接重开侧边栏');
    assert.strictEqual(btn.classList.contains('sidebar-open'), true, '骑缝态应恢复');
    assert.strictEqual(btn.style.left, '0px', 'jsdom offsetWidth=0 → left 钳制为 0px（真实环境为 width-10 骑缝）');
  } finally { cleanup(w); }
});
