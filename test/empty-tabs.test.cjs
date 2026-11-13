// 允许关闭所有标签页（tabs=[] / activeTabIndex=-1）的回归测试。
// 覆盖：数据层归零、空态欢迎页（方案 B：新建/打开 + 最近文件 + 提示）、
// 三个集中动作守卫、会话持久化、恢复入口、静态防回退。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { withEditor, delay } = require('./helpers/app-env.cjs');

const ROOT = path.join(__dirname, '..');

async function enterEmpty(ed, via = 'closeAllTabs') {
  ed.showSaveDialog = async () => 'discard';
  ed.updatePreview = async () => {};
  ed.setStatus = () => {};
  if (via === 'closeTab') await ed.closeTab(ed.activeTabIndex);
  else await ed.closeAllTabs();
}

const isShown = (w) => {
  const el = w.document.getElementById('empty-welcome');
  return !!el && !el.classList.contains('hidden');
};

test('空态: closeAllTabs 允许 0 标签并显示欢迎页', async () => {
  await withEditor({}, async (w, ed) => {
    await enterEmpty(ed);
    assert.strictEqual(ed.tabs.length, 0, '应允许 0 个标签');
    assert.strictEqual(ed.activeTabIndex, -1, '无活动文档时用 -1 哨兵');
    assert.strictEqual(ed.activeTab, undefined, 'activeTab 应为 undefined');
    assert.ok(isShown(w), '欢迎页应显示');
    assert.strictEqual(ed.cm.getOption('readOnly'), 'nocursor', 'CM 应只读且无光标');
    assert.strictEqual(ed.preview.innerHTML, '', '预览残留内容应清空');
    assert.ok(w.document.getElementById('btn-save').classList.contains('no-doc-disabled'),
      '依赖文档的按钮应置灰');
    assert.strictEqual(w.document.getElementById('empty-welcome').getAttribute('aria-hidden'), 'false');
  });
});

test('空态: 关闭最后一个标签也走同一条归零路径', async () => {
  await withEditor({}, async (w, ed) => {
    ed.showSaveDialog = async () => 'discard';
    ed.updatePreview = async () => {};
    ed.setStatus = () => {};
    // harness 启动后可能有指南 / demo 等多个标签，先收敛到单标签再验证「关掉最后一个」
    while (ed.tabs.length > 1) await ed.closeTab(ed.activeTabIndex);
    assert.strictEqual(ed.tabs.length, 1, '应先收敛到单标签');
    await ed.closeTab(ed.activeTabIndex);
    assert.strictEqual(ed.tabs.length, 0);
    assert.strictEqual(ed.activeTabIndex, -1);
    assert.ok(isShown(w));
  });
});

test('空态: 单标签也渲染 × 关闭按钮', async () => {
  await withEditor({}, async (w, ed) => {
    ed.updateTabBar();
    const tabs = w.document.querySelectorAll('.tab');
    assert.ok(tabs.length >= 1, '至少渲染一个标签');
    tabs.forEach(t => assert.ok(t.querySelector('.tab-close'), '每个标签都必须能关闭'));
  });
});

test('空态: addTab 恢复出第一个标签，只读解除且欢迎页隐藏', async () => {
  await withEditor({}, async (w, ed) => {
    await enterEmpty(ed);
    await ed.addTab('x.md', '# 标题', null);
    assert.strictEqual(ed.tabs.length, 1);
    assert.strictEqual(ed.activeTabIndex, 0);
    assert.strictEqual(ed.cm.getValue(), '# 标题', '内容应落到 CM');
    assert.strictEqual(ed.cm.getOption('readOnly'), false, '只读必须解除');
    assert.ok(!isShown(w), '欢迎页应隐藏');
    assert.ok(!w.document.getElementById('btn-save').classList.contains('no-doc-disabled'));
  });
});

test('空态: 欢迎页「新建」「打开」按钮可用且文案随语言', async () => {
  await withEditor({}, async (w, ed) => {
    await enterEmpty(ed);
    const newBtn = w.document.getElementById('btn-empty-new');
    const openBtn = w.document.getElementById('btn-empty-open');
    assert.strictEqual(newBtn.textContent, ed.t('emptyWelcomeNew'));
    assert.strictEqual(openBtn.textContent, ed.t('emptyWelcomeOpen'));
    let opened = 0;
    ed.openFile = () => { opened++; };
    openBtn.click();
    assert.strictEqual(opened, 1, '「打开文件」应放行');
    newBtn.click();
    await delay(80);
    assert.strictEqual(ed.tabs.length, 1, '「新建文档」应建出第一个标签');
  });
});

test('空态: 最近文件最多 5 条，点击走 openFilePath', async () => {
  await withEditor({}, async (w, ed) => {
    ed._recentFiles = Array.from({ length: 7 }, (_, i) => `C:/work/doc${i}.md`);
    await enterEmpty(ed);
    const items = w.document.querySelectorAll('.empty-welcome-recent-item');
    assert.strictEqual(items.length, 5, '最近文件最多展示 5 条');
    assert.strictEqual(items[0].querySelector('.empty-welcome-recent-name').textContent, 'doc0.md');
    assert.ok(!w.document.getElementById('empty-welcome-recent').classList.contains('hidden'));
    const opened = [];
    ed.openFilePath = (p) => { opened.push(p); return Promise.resolve(); };
    items[0].click();
    assert.deepStrictEqual(opened, ['C:/work/doc0.md']);
  });
});

test('空态: 无最近文件时隐藏该区块', async () => {
  await withEditor({}, async (w, ed) => {
    ed._recentFiles = [];
    await enterEmpty(ed);
    assert.ok(w.document.getElementById('empty-welcome-recent').classList.contains('hidden'));
  });
});

test('空态: 菜单按钮与 executeMenuAction 守卫，恢复入口不被误伤', async () => {
  await withEditor({}, async (w, ed) => {
    await enterEmpty(ed);
    let saved = 0; let wrapped = 0; let created = 0;
    ed.saveFile = () => { saved++; };
    ed.wrapSelection = () => { wrapped++; };
    ed.fileTreeNewFile = () => { created++; };
    w.document.getElementById('btn-save').click();
    ed.executeMenuAction('insert-bold');
    assert.strictEqual(saved, 0, '无文档时保存应静默短路');
    assert.strictEqual(wrapped, 0, '无文档时格式动作应短路');
    ed.executeMenuAction('file-new-file');
    assert.strictEqual(created, 1, '文件树新建文件必须放行');
  });
});

test('空态: 全局快捷键短路依赖文档的动作，放行 Ctrl+N', async () => {
  await withEditor({}, async (w, ed) => {
    await enterEmpty(ed);
    let saved = 0; let created = 0;
    ed.saveFile = () => { saved++; };
    ed.newFile = () => { created++; };
    const s = ed.shortcuts || ed.getDefaultShortcuts();
    const saveKey = (s.saveFile && s.saveFile.key) || 'Ctrl+S';
    const newKey = (s.newFile && s.newFile.key) || 'Ctrl+N';
    const lookup = ed.globalShortcutLookup || {};
    assert.ok(lookup[saveKey], `快捷键 ${saveKey} 应已注册`);
    lookup[saveKey]();
    assert.strictEqual(saved, 0, '空态下 Ctrl+S 不应执行');
    lookup[newKey]();
    assert.strictEqual(created, 1, '空态下 Ctrl+N 必须放行');
  });
});

test('空态: 保存/导出方法本身也有判空防线', async () => {
  const invoked = [];
  await withEditor({ invokeImpl: (cmd) => { invoked.push(cmd); return null; } }, async (w, ed) => {
    await enterEmpty(ed);
    // 直接调用（绕过菜单/快捷键守卫）不应抛异常，也不应弹保存对话框
    await ed.saveFile();
    await ed.saveAsFile();
    await ed.exportHTML();
    await ed.exportWord();
    await ed.exportImage();
    await ed.exportPDF();
    assert.ok(!invoked.some(c => String(c).includes('dialog|save')),
      '无文档时不应触发保存对话框');
  });
});

test('空态: saveSession 写 emptyTabs，restoreSession 重启后保持空态', async () => {
  await withEditor({}, async (w, ed) => {
    await enterEmpty(ed);
    const parsed = JSON.parse(w.localStorage.getItem('tizumark-session'));
    assert.strictEqual(parsed.version, 2);
    assert.strictEqual(parsed.emptyTabs, true, '必须区分「关光了」与「只有未保存空白文档」');
    assert.strictEqual(parsed.tabs.length, 0);

    // 模拟重启：构造器造出默认单标签，restoreSession 应覆盖成空态
    const Tab = w.TMConst.Tab;
    ed.tabs = [new Tab('未命名1')];
    ed.activeTabIndex = 0;
    ed.updateTabBar();
    assert.ok(!isShown(w), '有文档时应隐藏欢迎页');
    const ok = await ed.restoreSession();
    assert.strictEqual(ok, true, '空态恢复必须返回 true');
    assert.strictEqual(ed.tabs.length, 0);
    assert.strictEqual(ed.activeTabIndex, -1);
    assert.ok(isShown(w), '重启后应保持空态');
    assert.strictEqual(ed.cm.getOption('readOnly'), 'nocursor');
  });
});

test('空态: 有文档时 emptyTabs 为 false（会话不被误标）', async () => {
  await withEditor({}, async (w, ed) => {
    ed.saveSession();
    const parsed = JSON.parse(w.localStorage.getItem('tizumark-session'));
    assert.strictEqual(parsed.emptyTabs, false);
  });
});

test('空态: 未保存文档 cancel 时不关闭', async () => {
  await withEditor({}, async (w, ed) => {
    ed.showSaveDialog = async () => 'cancel';
    ed.tabs[0].content = '未保存的内容';
    const before = ed.tabs.length;
    await ed.closeTab(0);
    assert.strictEqual(ed.tabs.length, before, 'cancel 应保持原状');
    assert.ok(!isShown(w));
  });
});

test('空态: 分栏与折叠状态不受空态影响', async () => {
  await withEditor({}, async (w, ed) => {
    const container = w.document.querySelector('.editor-container');
    const row = w.document.querySelector('.editor-row');
    container.classList.add('editor-collapsed');
    row.classList.add('split-vertical');
    await enterEmpty(ed);
    assert.ok(container.classList.contains('editor-collapsed'), '折叠 class 应保留');
    assert.ok(row.classList.contains('split-vertical'), '分栏方向 class 应保留');
    assert.ok(!row.classList.contains('hidden'), '不应隐藏 editor-row');
    assert.ok(!container.classList.contains('hidden'), '不应隐藏 editor-container');
  });
});

test('静态契约：三语文案齐备、无「归零补 Tab」回退、盖层不遮标签栏（防回退）', () => {
  const tabsSrc = fs.readFileSync(path.join(ROOT, 'src/modules/tabs.js'), 'utf8');
  const filesSrc = fs.readFileSync(path.join(ROOT, 'src/modules/files.js'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/modules/i18n-data.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');

  assert.ok(!tabsSrc.includes('if (this.tabs.length > 1) {'), '单标签 × 不得再用 length>1 条件');
  assert.ok(tabsSrc.includes('this.activeTabIndex = -1'), '必须有 -1 哨兵');
  assert.ok(tabsSrc.includes('_applyEmptyState'), '必须有统一状态刷新入口');
  assert.ok(filesSrc.includes('emptyTabs'), '会话必须带 emptyTabs 标志');
  assert.ok((i18nSrc.match(/emptyWelcomeTitle:/g) || []).length === 3, 'zh/en/es 三语文案齐备');
  assert.ok(css.includes('.empty-welcome.hidden { display: none; }'), '本应用无全局 .hidden，必须显式定义');
  // 欢迎页必须位于 .editor-row 内（在 pane-loading 之前、与 editor-row 同一层级）
  const welcomeIdx = html.indexOf('id="empty-welcome"');
  const paneIdx = html.indexOf('id="pane-loading"');
  assert.ok(welcomeIdx > 0 && welcomeIdx < paneIdx, '欢迎页应盖住编辑区而非整个 main');
});

test('空态视觉: 大图标主视觉、按钮带图标且文案随三语刷新', async () => {
  await withEditor({}, async (w, ed) => {
    ed._recentFiles = ['C:/work/doc0.md'];
    await enterEmpty(ed);
    const hero = w.document.querySelector('.empty-welcome-hero svg');
    assert.ok(hero, '「暂无打开的文档」纯文字标题应由自绘大图标取代');
    assert.ok(w.document.querySelector('#empty-welcome-title').textContent === ed.t('emptyWelcomeTitle'),
      '标题文案仍保留给屏幕阅读器 / i18n');
    assert.ok(w.document.querySelector('.ew-tip-icon'), '拖放提示带线性图标');

    const newBtn = w.document.getElementById('btn-empty-new');
    const openBtn = w.document.getElementById('btn-empty-open');
    for (const lang of ['zh', 'en', 'es']) {
      ed.settings.language = lang;
      ed._renderEmptyWelcome();
      assert.ok(newBtn.querySelector('svg'), '按钮图标不得被 textContent 覆盖');
      assert.strictEqual(newBtn.textContent, ed.t('emptyWelcomeNew'), `${lang} 新建按钮文案`);
      assert.strictEqual(openBtn.textContent, ed.t('emptyWelcomeOpen'), `${lang} 打开按钮文案`);
      const shortcuts = w.document.getElementById('empty-welcome-shortcuts');
      assert.strictEqual(shortcuts.textContent, ed.t('emptyWelcomeShortcuts'), `${lang} 快捷键文案需逐字保真`);
      assert.strictEqual(shortcuts.querySelectorAll('kbd.ew-kbd').length, 2, `${lang} 应有两个键位胶囊`);
      assert.strictEqual(w.document.getElementById('empty-welcome-drop').textContent,
        ed.t('emptyWelcomeDrop'), `${lang} 拖放提示文案`);
    }
  });
});

test('空态视觉: 最近文件行带文件图标，点击行为不变', async () => {
  await withEditor({}, async (w, ed) => {
    ed._recentFiles = ['C:/work/doc0.md', 'D:/notes/readme.md'];
    await enterEmpty(ed);
    const items = w.document.querySelectorAll('.empty-welcome-recent-item');
    assert.strictEqual(items.length, 2);
    items.forEach(item => assert.ok(item.querySelector('.ew-recent-icon svg'), '每行需有文件图标'));
    assert.strictEqual(items[0].querySelector('.empty-welcome-recent-name').textContent, 'doc0.md');
    const opened = [];
    ed.openFilePath = (p) => { opened.push(p); return Promise.resolve(); };
    items[1].click();
    assert.deepStrictEqual(opened, ['D:/notes/readme.md']);
  });
});

test('静态契约：欢迎页紧凑按钮 / 强 hover / 柔光走 background-image（防视觉回退）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  const tabsSrc = fs.readFileSync(path.join(ROOT, 'src/modules/tabs.js'), 'utf8');
  assert.ok(html.includes('class="empty-welcome-hero"') && html.includes('id="ew-paper-fill"'),
    '大图标主视觉与自绘 SVG 渐变必须在');
  assert.ok(html.includes('id="btn-empty-new-label"'), '按钮文案须由 label span 承载，不能写回按钮本体');
  assert.ok(css.includes('.empty-welcome-btn {') && css.includes('height: 30px;'), '按钮高度收紧到 30px');
  assert.ok(css.includes('clip: rect(0 0 0 0)'), '旧大字标题须降级为屏幕阅读器文本');
  assert.ok(/\.empty-welcome-recent-item:hover,\s*\.empty-welcome-recent-item:focus-visible\s*\{[^}]*var\(--bg-hover-strong\)/.test(css),
    'hover 必须用明暗主题都明显的 --bg-hover-strong');
  assert.ok(!/\.empty-welcome-recent-item:hover\s*\{\s*background:\s*var\(--bg-secondary\)/.test(css),
    '不得回退到暗色下几乎不可见的 --bg-secondary');
  assert.ok(css.includes('background-image: radial-gradient'), '柔光只能走 background-image');
  assert.ok(tabsSrc.includes('ew-kbd'), '快捷键需渲染成 kbd 胶囊');
});
