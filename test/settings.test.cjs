// 设置模块测试：默认值 / 校验 / 合并 / 主题色 / 字体 / 重置
// 仅依赖共享 harness（jsdom + 真实 CodeMirror），不触及 Tauri 集成。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

async function makeEditor() {
  const { w, getInitErr } = await buildEnv({ captureInitErr: true });
  await delay(300); // 等异步初始化（DOMContentLoaded -> new MarkdownEditor）完成
  return { w, ed: w.editor, getInitErr };
}

test('settings: defaultSettings 返回完整默认配置', async () => {
  const { w, ed, getInitErr } = await makeEditor();
  try {
    assert.strictEqual(getInitErr(), null, '初始化不应报错');
    const d = ed.defaultSettings();
    assert.strictEqual(d.fontSize, 14);
    assert.strictEqual(d.tabSize, 4);
    assert.strictEqual(d.lineWrap, true);
    assert.strictEqual(d.lineNumbers, true);
    assert.strictEqual(d.previewFontSize, 16);
    assert.strictEqual(d.lineHeight, 1.7);
    assert.strictEqual(d.maxWidth, 0);
    assert.strictEqual(d.themeMode, 'light');
    assert.strictEqual(d.colorScheme, 'default');
    assert.strictEqual(d.defaultView, 'preview');
    assert.strictEqual(d.scrollSync, true);
    assert.strictEqual(d.language, 'zh');
    assert.strictEqual(d.imageInsertMode, 'assets');
    assert.strictEqual(d.imageAssetPath, 'assets');
    assert.strictEqual(d.imageAssetPathMode, 'relative');
    assert.strictEqual(d.outlineWidth, 240);
    assert.strictEqual(d.codeLineNumbers, false);
    assert.strictEqual(d.codeWrap, false);
    assert.strictEqual(d.codeScroll, true, '代码块滚动条默认开启（保持原行为）');
    assert.strictEqual(d.softBreaks, true);
    assert.strictEqual(d.showTrayIcon, true);
    assert.strictEqual(d.closeAction, 'ask');
    assert.strictEqual(d.toolbarCollapsed, false);
    assert.strictEqual(d.sidebarHidden, false);
    assert.ok(Array.isArray(d.customFonts), 'customFonts 应为数组');
    assert.strictEqual(d.customFonts.length, 0, 'customFonts 应为空');
    assert.strictEqual(d.editorFont, '');
    assert.strictEqual(d.previewFont, '');
    assert.strictEqual(d.codeFont, '', 'codeFont 默认为空（跟随等宽默认）');
  } finally { cleanup(w); }
});

test('settings: _validConfigObject 类型校验', async () => {
  const { w, ed } = await makeEditor();
  try {
    assert.strictEqual(ed._validConfigObject(null), null);
    assert.strictEqual(ed._validConfigObject(undefined), null);
    assert.strictEqual(ed._validConfigObject([1, 2, 3]), null, '数组应被拒绝');
    assert.strictEqual(ed._validConfigObject('nope'), null, '字符串应被拒绝');
    assert.deepStrictEqual(ed._validConfigObject({ a: 1 }), { a: 1 });
  } finally { cleanup(w); }
});

test('settings: loadSettings 合并已知字段并保留默认', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.localStorage.setItem('tizumark-settings', JSON.stringify({ tabSize: 2, themeMode: 'dark' }));
    const loaded = ed.loadSettings();
    assert.strictEqual(loaded.tabSize, 2);
    assert.strictEqual(loaded.themeMode, 'dark');
    assert.strictEqual(loaded.fontSize, 14, '未提供字段应保留默认');
    assert.strictEqual(loaded.maxWidth, 0);
  } finally { cleanup(w); }
});

test('settings: loadSettings 对类型不符字段回退默认', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.localStorage.setItem('tizumark-settings', JSON.stringify({ tabSize: '4', lineWrap: 'yes' }));
    const loaded = ed.loadSettings();
    assert.strictEqual(loaded.tabSize, 4, '字符串应回退为 number 默认');
    assert.strictEqual(loaded.lineWrap, true, '字符串应回退为 boolean 默认');
  } finally { cleanup(w); }
});

test('settings: loadSettings 丢弃未知键', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.localStorage.setItem('tizumark-settings', JSON.stringify({ bogusKey: 'hello' }));
    const loaded = ed.loadSettings();
    assert.strictEqual(loaded.bogusKey, undefined, '未知键应被类型校验清为 undefined');
  } finally { cleanup(w); }
});

test('settings: loadSettings 残留旧版 fontScheme 字段被自愈清除', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.localStorage.setItem('tizumark-settings', JSON.stringify({ colorScheme: 'forest', fontScheme: 'classic-serif' }));
    const loaded = ed.loadSettings();
    assert.strictEqual(loaded.colorScheme, 'forest', '配色保留');
    assert.strictEqual(loaded.fontScheme, undefined, '旧版 fontScheme 字段应被自愈清除（defaults 已无此键）');
  } finally { cleanup(w); }
});

test('settings: loadSettings 坏 JSON 回退默认', async () => {
  const { w, ed } = await makeEditor();
  try {
    w.localStorage.setItem('tizumark-settings', 'not-json{');
    const loaded = ed.loadSettings();
    assert.strictEqual(loaded.fontSize, 14, '坏 JSON 应回退默认');
    assert.strictEqual(loaded.colorScheme, 'default');
  } finally { cleanup(w); }
});

test('settings: saveSettings 回写 localStorage', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings = ed.defaultSettings();
    ed.settings.tabSize = 2;
    ed.saveSettings();
    const stored = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    assert.strictEqual(stored.tabSize, 2);
  } finally { cleanup(w); }
});

test('settings: applyThemeMode dark 设置 data-theme 与 cm 主题', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.themeMode = 'dark';
    ed.settings.colorScheme = 'nord';
    await ed.applyThemeMode();
    assert.strictEqual(w.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.strictEqual(w.document.documentElement.getAttribute('data-color-scheme'), 'nord');
    assert.strictEqual(ed.cm.getOption('theme'), 'material-darker');
  } finally { cleanup(w); }
});

test('settings: applyThemeMode system 跟随 matchMedia(返回 light)', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.themeMode = 'system';
    await ed.applyThemeMode();
    assert.strictEqual(w.document.documentElement.getAttribute('data-theme'), 'light', 'matchMedia 默认 false 应为 light');
  } finally { cleanup(w); }
});

test('settings: loadSystemFonts 从 Rust 命令注入系统字体列表', async () => {
  const { w } = await buildEnv({
    captureInitErr: true,
    invokeImpl: (cmd) => (cmd === 'list_system_fonts' ? ['Arial', 'Segoe UI', 'Consolas'] : undefined),
  });
  await delay(300);
  const ed = w.editor;
  try {
    assert.deepStrictEqual(ed._systemFonts, ['Arial', 'Segoe UI', 'Consolas'], '系统字体列表来自 Rust 命令');
    assert.strictEqual(ed._systemFontsError, '', '无错误');
    const picker = ed._fontPickers.editor;
    assert.ok(picker, '编辑器 FontPicker 存在');
    picker.open();
    const vals = [...picker.dropdown.querySelectorAll('.font-picker-item')].map((el) => el.getAttribute('data-value'));
    assert.ok(vals.includes('Arial') && vals.includes('Segoe UI'), '系统字体出现在选择器');
    assert.ok(w.document.getElementById('btn-retry-system-fonts').classList.contains('hidden'), '成功时重试按钮隐藏');
  } finally { cleanup(w); }
});

test('settings: loadSystemFonts 失败不伪造名单，重试成功后恢复', async () => {
  let calls = 0;
  const { w } = await buildEnv({
    captureInitErr: true,
    invokeImpl: (cmd) => {
      if (cmd === 'list_system_fonts') {
        calls++;
        if (calls === 1) throw new Error('boom');
        return ['Arial'];
      }
      return undefined;
    },
  });
  await delay(300);
  const ed = w.editor;
  try {
    // 注：_systemFonts 由 jsdom realm 的 app.js 赋值，deepStrictEqual 跨 realm 比较原型会误判，用 length 断言
    assert.strictEqual(ed._systemFonts.length, 0, '首次失败：空列表（绝不伪造降级名单）');
    assert.ok(ed._systemFontsError, '记录错误信息');
    const retry = w.document.getElementById('btn-retry-system-fonts');
    assert.ok(retry && !retry.classList.contains('hidden'), '失败时显示重试按钮');
    // 点击重试 → 第二次成功
    await ed.loadSystemFonts(true);
    assert.strictEqual(ed._systemFonts.length, 1, '重试成功后列表恢复');
    assert.strictEqual(ed._systemFonts[0], 'Arial');
    assert.strictEqual(ed._systemFontsError, '', '错误清除');
    assert.ok(retry.classList.contains('hidden'), '成功后重试按钮隐藏');
  } finally { cleanup(w); }
});

test('settings: refreshFontSelectors 渲染系统字体与自定义字体分组到 FontPicker', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._systemFonts = ['DengXian', 'Consolas'];
    ed.settings.customFonts = [{ id: 'cfX', name: 'My Font', fileName: 'x.ttf', hash: 'hx' }];
    ed.renderCustomFontSettings();
    const picker = ed._fontPickers.editor;
    assert.ok(picker, '编辑器 FontPicker 存在');
    picker.open();
    const values = [...picker.dropdown.querySelectorAll('.font-picker-item')].map((el) => el.getAttribute('data-value'));
    assert.deepStrictEqual(values, ['', 'DengXian', 'Consolas', 'cfX'], '默认 + 系统2 + 自定义1');
    const labels = [...picker.dropdown.querySelectorAll('.font-picker-group-label')].map((el) => el.textContent);
    assert.deepStrictEqual(labels, [ed.t('systemFonts'), ed.t('customFonts')], '分组标签走 i18n');
    // 代码块选择器同步同构
    const codePicker = ed._fontPickers.code;
    codePicker.open();
    const codeVals = [...codePicker.dropdown.querySelectorAll('.font-picker-item')].map((el) => el.getAttribute('data-value'));
    assert.deepStrictEqual(codeVals, ['', 'DengXian', 'Consolas', 'cfX'], '代码块选择器同步');
    // 系统字体可选中映射
    ed.settings.editorFont = 'DengXian';
    ed.renderCustomFontSettings();
    assert.strictEqual(picker.getValue(), 'DengXian', '系统字体可选中映射');
    assert.strictEqual(picker.input.value, '等线', '输入框显示本地化中文名（中文 UI）');
  } finally { cleanup(w); }
});

test('settings: 系统字体下拉按白名单过滤，去除未列入的字体', async () => {
  const { w, ed } = await makeEditor();
  try {
    // 模拟 Rust 返回全部系统字体（含大量白名单外字体）
    ed._systemFonts = ['DengXian', 'Consolas', 'SomeObscureFont', 'AnotherRandomFontFamily', 'Arial'];
    ed.renderCustomFontSettings();
    const picker = ed._fontPickers.editor;
    picker.open();
    const sysVals = [...picker.dropdown.querySelectorAll('.font-picker-item')]
      .map((el) => el.getAttribute('data-value'))
      .filter((v) => v && !v.startsWith('cf'));
    // 白名单内（DengXian/Consolas/Arial）保留，白名单外（SomeObscureFont/AnotherRandomFontFamily）过滤
    assert.ok(sysVals.includes('DengXian'), '白名单内字体应保留');
    assert.ok(sysVals.includes('Consolas'), '白名单内字体应保留');
    assert.ok(sysVals.includes('Arial'), '白名单内字体应保留');
    assert.strictEqual(sysVals.includes('SomeObscureFont'), false, '白名单外字体应被过滤');
    assert.strictEqual(sysVals.includes('AnotherRandomFontFamily'), false, '白名单外字体应被过滤');
  } finally { cleanup(w); }
});

test('settings: 系统字体中英文名归一去重，UI 语言决定显示名', async () => {
  const { w, ed } = await makeEditor();
  try {
    // fontdb 返回中英文两套族名 + UI 变体（视觉与主族一致）
    ed._systemFonts = ['Microsoft YaHei', '微软雅黑', 'Microsoft YaHei UI', 'Arial'];
    ed.renderCustomFontSettings();
    const picker = ed._fontPickers.editor;
    picker.open();
    const sysItems = [...picker.dropdown.querySelectorAll('.font-picker-item')].filter((el) => el.getAttribute('data-value'));
    const yahei = sysItems.filter((el) => el.getAttribute('data-value') === 'Microsoft YaHei');
    assert.strictEqual(yahei.length, 1, '中英文同族只保留一条（微软雅黑）');
    assert.strictEqual(yahei[0].textContent, '微软雅黑', '中文 UI 显示中文名');
    assert.strictEqual(sysItems.some((el) => el.getAttribute('data-value') === 'Microsoft YaHei UI'), false, '微软雅黑 UI 变体合并进主族');
    const arial = sysItems.find((el) => el.getAttribute('data-value') === 'Arial');
    assert.strictEqual(arial.textContent, 'Arial', '拉丁字体中英文同名，显示原名');
    // 输入框显示本地化名（value 仍为英文）
    ed.settings.editorFont = 'Microsoft YaHei';
    ed.renderCustomFontSettings();
    assert.strictEqual(picker.input.value, '微软雅黑', '输入框显示中文名（value 仍为英文）');
    assert.strictEqual(picker.getValue(), 'Microsoft YaHei', '存储值保持英文族名');
  } finally { cleanup(w); }
});

test('settings: 英文 UI 下系统字体显示英文族名', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.language = 'en';
    ed._systemFonts = ['DengXian', 'Arial'];
    ed.renderCustomFontSettings();
    const picker = ed._fontPickers.editor;
    picker.open();
    const deng = [...picker.dropdown.querySelectorAll('.font-picker-item')].find((el) => el.getAttribute('data-value') === 'DengXian');
    assert.strictEqual(deng.textContent, 'DengXian', '英文 UI 显示英文族名');
    ed.settings.editorFont = 'DengXian';
    ed.renderCustomFontSettings();
    assert.strictEqual(w.document.getElementById('font-name-editor').textContent, 'DengXian', '预览标题英文 UI 显示英文名');
  } finally { cleanup(w); }
});

test('settings: 字体搜索同时支持中英文关键词', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._systemFonts = ['Microsoft YaHei', 'Arial'];
    ed.renderCustomFontSettings();
    const picker = ed._fontPickers.editor;
    picker.open();
    picker.input.value = '微软';
    picker._filter = '微软';
    picker._renderList();
    const vals = [...picker.dropdown.querySelectorAll('.font-picker-item')].map((el) => el.getAttribute('data-value'));
    assert.ok(vals.includes('Microsoft YaHei'), '中文关键词能过滤出微软雅黑');
    assert.strictEqual(vals.includes('Arial'), false, '无关字体被过滤');
  } finally { cleanup(w); }
});

test('settings: 已选中的白名单外系统字体仍保留显示（防御）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._systemFonts = ['DengXian']; // 枚举列表不含该字体
    ed.settings.editorFont = 'MyLegacyFont'; // 旧配置选中了白名单外字体
    ed.renderCustomFontSettings();
    const picker = ed._fontPickers.editor;
    picker.open();
    const vals = [...picker.dropdown.querySelectorAll('.font-picker-item')].map((el) => el.getAttribute('data-value'));
    assert.ok(vals.includes('MyLegacyFont'), '已选中的白名单外字体应保留显示，避免「字体消失」');
    assert.strictEqual(picker.getValue(), 'MyLegacyFont', '输入框保持已选值');
  } finally { cleanup(w); }
});

test('settings: 每个字体选择器下方有独立预览并更新字体与名称', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._systemFonts = ['DengXian', 'Consolas'];
    ed.settings.editorFont = 'DengXian';
    ed.settings.previewFont = '';
    ed.settings.codeFont = 'Consolas';
    ed.renderCustomFontSettings();
    const edPrev = w.document.getElementById('font-preview-editor');
    const pvPrev = w.document.getElementById('font-preview-preview');
    const codePrev = w.document.getElementById('font-preview-code');
    assert.ok(edPrev && pvPrev && codePrev, '三个独立预览元素存在');
    const edText = edPrev.querySelector('.font-preview-text');
    const edCap = w.document.getElementById('font-name-editor');
    assert.ok(/DengXian/.test(edText.style.fontFamily), '编辑器预览应以 DengXian 渲染，实际: ' + edText.style.fontFamily);
    assert.strictEqual(edCap.textContent, '等线', '编辑器预览标题显示本地化中文名（中文 UI）');
    assert.strictEqual(w.document.getElementById('font-name-preview').textContent, ed.t('defaultFont'), '预览字体为空时标题显示默认');
    const codeText = codePrev.querySelector('.font-preview-text');
    assert.ok(/Consolas/.test(codeText.style.fontFamily), '代码预览应以 Consolas 渲染');
  } finally { cleanup(w); }
});

test('settings: FontPicker 选择系统字体写入 settings（editor/code）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed._systemFonts = ['DengXian', 'Consolas'];
    ed.renderCustomFontSettings();
    const picker = ed._fontPickers.editor;
    picker.open();
    const item = [...picker.dropdown.querySelectorAll('.font-picker-item')].find((el) => el.getAttribute('data-value') === 'DengXian');
    assert.ok(item, 'DengXian 可选');
    item.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(ed.settings.editorFont, 'DengXian', '编辑器字体选择写入 settings');
    const codePicker = ed._fontPickers.code;
    codePicker.open();
    const itemC = [...codePicker.dropdown.querySelectorAll('.font-picker-item')].find((el) => el.getAttribute('data-value') === 'Consolas');
    itemC.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(ed.settings.codeFont, 'Consolas', '代码块字体选择写入 settings（回归缺失监听）');
  } finally { cleanup(w); }
});

test('settings: applyCustomFonts 设置编辑器/预览/代码块字体族', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.customFonts = [
      { id: 'cf123', name: 'F1', fileName: '1.ttf', hash: 'h1' },
      { id: 'cf456', name: 'F2', fileName: '2.ttf', hash: 'h2' },
      { id: 'cf789', name: 'F3', fileName: '3.ttf', hash: 'h3' },
    ];
    ed.settings.editorFont = 'cf123';
    ed.settings.previewFont = 'cf456';
    ed.settings.codeFont = 'cf789';
    ed.applyCustomFonts();
    assert.ok(ed.cm.getWrapperElement().style.fontFamily.includes('tizumark-custom-cf123'), 'CM 应应用自定义字体 cf123，实际: ' + ed.cm.getWrapperElement().style.fontFamily);
    assert.ok(ed.preview.style.fontFamily.includes('tizumark-custom-cf456'), '预览应应用自定义字体 cf456，实际: ' + ed.preview.style.fontFamily);
    assert.ok(ed.preview.style.getPropertyValue('--font-code-preview').includes('tizumark-custom-cf789'), '代码块字体应注入 --font-code-preview 为自定义字体 cf789');
  } finally { cleanup(w); }
});

test('settings: applyCustomFonts 系统字体族名直接应用（不在 customFonts 列表）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.customFonts = [];
    ed.settings.editorFont = 'Microsoft YaHei';
    ed.settings.previewFont = 'DengXian';
    ed.settings.codeFont = 'Consolas';
    ed.applyCustomFonts();
    assert.strictEqual(ed.cm.getWrapperElement().style.fontFamily, '"Microsoft YaHei"', '编辑器系统字体应加引号直用，实际: ' + ed.cm.getWrapperElement().style.fontFamily);
    assert.strictEqual(ed.preview.style.fontFamily, '"DengXian"', '预览系统字体应加引号直用，实际: ' + ed.preview.style.fontFamily);
    assert.strictEqual(ed.preview.style.getPropertyValue('--font-code-preview'), '"Consolas"', '代码块系统字体应注入 --font-code-preview 加引号直用');
  } finally { cleanup(w); }
});

test('settings: applyCustomFonts 代码块字体为空时回退等宽默认', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.codeFont = '';
    ed.applyCustomFonts();
    assert.strictEqual(ed.preview.style.getPropertyValue('--font-code-preview').trim(), 'var(--font-mono)', 'codeFont 为空时应回退 var(--font-mono)');
  } finally { cleanup(w); }
});

test('settings: applySettings 应用 maxWidth 与代码块选项', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.maxWidth = 800;
    ed.settings.codeLineNumbers = true;
    ed.settings.codeWrap = true;
    await ed.applySettings();
    assert.ok(ed.preview.classList.contains('max-width-active'), 'maxWidth>0 应加 max-width-active');
    assert.strictEqual(ed.preview.style.maxWidth, '800px');
    assert.ok(ed.preview.classList.contains('code-line-numbers'));
    assert.ok(ed.preview.classList.contains('code-wrap'));
  } finally { cleanup(w); }
});

test('settings: applySettings 按 codeScroll 切换 code-no-scroll 类（关闭时撑开高度）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.codeScroll = false;
    await ed.applySettings();
    assert.ok(ed.preview.classList.contains('code-no-scroll'), 'codeScroll=false 应加 code-no-scroll（高度自适应、不滚动）');
    ed.settings.codeScroll = true;
    await ed.applySettings();
    assert.ok(!ed.preview.classList.contains('code-no-scroll'), 'codeScroll=true 应移除 code-no-scroll（恢复滚动条行为）');
  } finally { cleanup(w); }
});

test('settings: applySettings maxWidth=0 移除限制', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.maxWidth = 0;
    await ed.applySettings();
    assert.ok(!ed.preview.classList.contains('max-width-active'), 'maxWidth=0 不应有 max-width-active');
    assert.strictEqual(ed.preview.style.maxWidth, '');
  } finally { cleanup(w); }
});

test('settings: resetSettings 仅重置值并保留自定义字体，不立即生效/落盘', async () => {
  const { w, ed } = await makeEditor();
  try {
    // 预置 resetSettings 操作的设置表单元素，避免 jsdom 下 null 崩溃
    const ids = ['set-font-size', 'font-size-label', 'set-tab-size', 'set-line-wrap', 'set-line-numbers',
      'set-preview-font-size', 'preview-font-size-label', 'set-line-height', 'set-max-width', 'set-theme-mode',
      'set-color-scheme', 'set-default-view', 'set-scroll-sync', 'set-soft-breaks',
      'set-language', 'settings-image-asset-path', 'setting-image-asset-path-hint-text'];
    for (const id of ids) {
      if (!w.document.getElementById(id)) {
        const el = w.document.createElement('input');
        el.id = id;
        w.document.body.appendChild(el);
      }
    }
    let storeMode = w.document.getElementById('settings-image-store-mode');
    if (!storeMode) { storeMode = w.document.createElement('div'); storeMode.id = 'settings-image-store-mode'; w.document.body.appendChild(storeMode); }
    storeMode.innerHTML = '<input type="radio" value="assets">';
    let pathMode = w.document.getElementById('settings-image-asset-path-mode');
    if (!pathMode) { pathMode = w.document.createElement('div'); pathMode.id = 'settings-image-asset-path-mode'; w.document.body.appendChild(pathMode); }
    pathMode.innerHTML = '<input type="radio" value="relative">';

    // 模拟"已把 tabSize 设为 8 并应用/保存"：编辑器实际为 8、持久层为 8
    ed.cm.setOption('tabSize', 8);
    ed.settings = ed.defaultSettings();
    ed.settings.customFonts = [{ id: 'cf1', name: 'A', fileName: 'a.ttf', hash: 'h' }];
    ed.settings.tabSize = 8;
    ed.saveSettings(); // 持久层=8（不触碰编辑器，编辑器已手动设 8）

    ed.renderCustomFontSettings = () => {};
    ed.resetSettings(); // 仅重置内存值，不应用、不落盘
    assert.strictEqual(ed.settings.tabSize, 4, '内存应回到默认 tabSize');
    assert.strictEqual(ed.settings.customFonts.length, 1, '自定义字体应保留');
    assert.strictEqual(ed.settings.customFonts[0].id, 'cf1');
    assert.strictEqual(ed.cm.getOption('tabSize'), 8, '恢复默认不立即生效（编辑器仍为 8）');
    assert.strictEqual(JSON.parse(w.localStorage.getItem('tizumark-settings')).tabSize, 8, '恢复默认不立即落盘（持久层仍为 8）');
  } finally { cleanup(w); }
});

test('settings: 删除正在使用的自定义字体时，codeFont 与 editor/preview 同步清空', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings = ed.defaultSettings();
    ed.settings.customFonts = [
      { id: 'cfToDel', name: 'Del', fileName: 'd.ttf', hash: 'hd' },
      { id: 'cfKeep', name: 'Keep', fileName: 'k.ttf', hash: 'hk' },
    ];
    ed.settings.editorFont = 'cfToDel';
    ed.settings.previewFont = 'cfToDel';
    ed.settings.codeFont = 'cfToDel';
    // 自动确认并真正执行删除 action（清除逻辑在 action 回调内）
    ed.showConfirmDialog = async (title, msg, action) => { if (action) await action(); return true; };
    ed.registerCustomFonts = async () => {}; // 避免依赖真实 @font-face 注册
    await ed.removeCustomFont('cfToDel');
    assert.strictEqual(ed.settings.editorFont, '', 'editorFont 应清空');
    assert.strictEqual(ed.settings.previewFont, '', 'previewFont 应清空');
    assert.strictEqual(ed.settings.codeFont, '', 'codeFont 应清空（与 editor/preview 对称）');
    assert.strictEqual(ed.settings.customFonts.length, 1, '应只剩未删除字体');
    assert.strictEqual(ed.settings.customFonts[0].id, 'cfKeep', '保留 cfKeep');
  } finally { cleanup(w); }
});

test('settings: 预览代码块 CSS 引用 --font-code-preview 且 :root 已定义', async () => {
  const fs = require('fs');
  const p = require('path');
  const css = fs.readFileSync(p.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  assert.ok(/--font-code-preview:\s*var\(--font-mono\)/.test(css), ':root/classic-serif 应定义 --font-code-preview 并回退 --font-mono');
  assert.ok(/\.preview-content code\s*\{[^}]*font-family:\s*var\(--font-code-preview\)/.test(css), '行内代码应引用 --font-code-preview');
  assert.ok(/\.preview-content pre code[^{]*\{[^}]*font-family:\s*var\(--font-code-preview\)\s*!important/.test(css), '代码块应 !important 引用 --font-code-preview');
});

test('settings: saveSettings→loadSettings 端到端一致（真往返）', async () => {
  const { w, ed } = await makeEditor();
  try {
    // 构造一份偏离默认的配置
    ed.settings = ed.defaultSettings();
    ed.settings.tabSize = 2;
    ed.settings.themeMode = 'dark';
    ed.settings.colorScheme = 'nord';
    ed.settings.maxWidth = 720;
    ed.settings.customFonts = [{ id: 'cf9', name: 'X', fileName: 'x.ttf', hash: 'h9' }];
    ed.saveSettings();

    // 模拟"重启"：清空内存对象，仅从 localStorage 重新载入
    ed.settings = null;
    const loaded = ed.loadSettings();

    assert.strictEqual(loaded.tabSize, 2, '保存的 tabSize 应原样取回');
    assert.strictEqual(loaded.themeMode, 'dark');
    assert.strictEqual(loaded.colorScheme, 'nord');
    assert.strictEqual(loaded.maxWidth, 720);
    assert.strictEqual(loaded.fontSize, 14, '未改动的字段应仍是默认');
    // customFonts 逐字段比较：JSON 往返后元素键序可能变化，deepStrictEqual 对键序敏感会误报
    assert.strictEqual(loaded.customFonts.length, 1, 'customFonts 应整组保留');
    assert.strictEqual(loaded.customFonts[0].id, 'cf9');
    assert.strictEqual(loaded.customFonts[0].name, 'X');
    assert.strictEqual(loaded.customFonts[0].fileName, 'x.ttf');
    assert.strictEqual(loaded.customFonts[0].hash, 'h9');
    // 持久层内容应与内存一致
    const stored = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    assert.strictEqual(stored.tabSize, 2);
    assert.strictEqual(stored.maxWidth, 720);
  } finally { cleanup(w); }
});

// ====== 应用式语义（2026-08-04 定稿）：面板内改动只改内存与控件显示，
// 点「应用」生效并落盘（面板保持打开）、点「保存」生效+落盘+关闭、取消/× 直接回滚 ======

test('settings: 面板外 saveSettings 正常落盘', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings = ed.defaultSettings();
    ed.settings.tabSize = 8;
    ed.saveSettings();
    const stored = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    assert.strictEqual(stored.tabSize, 8, '未打开面板时保存应立即写入');
  } finally { cleanup(w); }
});

test('settings: 面板内修改不生效不落盘，点保存才生效并落盘', async () => {
  const { w, ed } = await makeEditor();
  try {
    assert.strictEqual(w.localStorage.getItem('tizumark-settings'), null, '初始无持久化设置');
    ed.showSettings();
    assert.ok(!w.document.getElementById('settings-dialog').classList.contains('hidden'), '面板应打开');

    ed._selects.tabSize.setValue('2');
    assert.strictEqual(ed.settings.tabSize, 2, '内存设置已更新');
    assert.strictEqual(ed.cm.getOption('tabSize'), 4, '未点应用/保存前编辑器不生效');
    assert.strictEqual(w.localStorage.getItem('tizumark-settings'), null, '未点保存不落盘');

    w.document.getElementById('settings-save-btn').dispatchEvent(new w.Event('click'));
    await delay(400); // rAF 让帧 + applySettings + 落盘 + 最小 loading 可见时长(300ms) + 关闭
    assert.strictEqual(ed.cm.getOption('tabSize'), 2, '保存后编辑器生效');
    const stored = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    assert.strictEqual(stored.tabSize, 2, '保存后落盘');
    assert.ok(w.document.getElementById('settings-dialog').classList.contains('hidden'), '保存后关闭面板');
  } finally { cleanup(w); }
});

test('settings: 点「应用」生效并落盘，面板保持打开', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    ed._selects.tabSize.setValue('2');
    assert.strictEqual(ed.cm.getOption('tabSize'), 4, '应用前不生效');

    w.document.getElementById('settings-apply-btn').dispatchEvent(new w.Event('click'));
    await delay(50); // applySettings + 落盘
    assert.strictEqual(ed.cm.getOption('tabSize'), 2, '应用后编辑器生效');
    assert.strictEqual(JSON.parse(w.localStorage.getItem('tizumark-settings')).tabSize, 2, '应用后落盘');
    assert.ok(!w.document.getElementById('settings-dialog').classList.contains('hidden'), '应用后面板保持打开');
  } finally { cleanup(w); }
});

test('settings: 应用后继续修改再点 × 关闭，回滚到最近一次应用的状态', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    // 第一次改动并应用（生效 2）
    ed._selects.tabSize.setValue('2');
    w.document.getElementById('settings-apply-btn').dispatchEvent(new w.Event('click'));
    await delay(50);
    assert.strictEqual(ed.cm.getOption('tabSize'), 2, '应用后为 2');

    // 第二次改动（8）不应用直接取消 → 应回滚到应用后的 2，而非打开面板时的 4
    ed._selects.tabSize.setValue('8');
    assert.strictEqual(ed.settings.tabSize, 8, '内存为 8');
    w.document.getElementById('settings-close-x').dispatchEvent(new w.Event('click'));
    assert.strictEqual(ed.settings.tabSize, 2, '取消回滚到最近一次应用的值 2');
    assert.strictEqual(ed.cm.getOption('tabSize'), 2, '编辑器仍为 2');
    assert.strictEqual(JSON.parse(w.localStorage.getItem('tizumark-settings')).tabSize, 2, '持久层为 2');
  } finally { cleanup(w); }
});

test('settings: 点 × 关闭恢复打开前的设置与控件显示，且不落盘', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    ed._selects.tabSize.setValue('2');
    assert.strictEqual(ed.settings.tabSize, 2, '改动已进内存');
    assert.strictEqual(w.localStorage.getItem('tizumark-settings'), null);

    w.document.getElementById('settings-close-x').dispatchEvent(new w.Event('click'));
    assert.strictEqual(ed.settings.tabSize, 4, '取消后内存恢复默认 4');
    assert.strictEqual(ed.cm.getOption('tabSize'), 4, '编辑器从未被改动过（应用式）');
    assert.strictEqual(ed._selects.tabSize.getValue(), '4', '取消后控件显示恢复');
    assert.strictEqual(w.localStorage.getItem('tizumark-settings'), null, '取消全程不落盘');
    assert.ok(w.document.getElementById('settings-dialog').classList.contains('hidden'), '取消后关闭面板');
  } finally { cleanup(w); }
});

test('settings: 点 X 关闭等同取消，恢复打开前的设置', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    ed._selects.tabSize.setValue('2');
    assert.strictEqual(ed.settings.tabSize, 2);

    w.document.getElementById('settings-close-x').dispatchEvent(new w.Event('click'));
    assert.strictEqual(ed.settings.tabSize, 4, 'X 关闭后内存恢复默认 4');
    assert.strictEqual(w.localStorage.getItem('tizumark-settings'), null, 'X 关闭不落盘');
    assert.ok(w.document.getElementById('settings-dialog').classList.contains('hidden'));
  } finally { cleanup(w); }
});

test('settings: 点击遮罩层不关闭设置框（只能 × 关闭）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const overlay = w.document.getElementById('settings-dialog');
    overlay.dispatchEvent(new w.Event('click'));
    assert.ok(!overlay.classList.contains('hidden'), '点击遮罩不应关闭设置框');
  } finally { cleanup(w); }
});

test('settings: 点「恢复默认」仅重置面板值，不立即生效/落盘；点「应用」后才生效', async () => {
  const { w, ed } = await makeEditor();
  try {
    // 模拟"打开面板前用户已把 tabSize 设为 8 并应用/保存"
    ed.cm.setOption('tabSize', 8);
    ed.settings = ed.defaultSettings();
    ed.settings.tabSize = 8;
    ed.saveSettings();
    ed.showSettings(); // 快照备份为 8

    ed.renderCustomFontSettings = () => {}; // 聚焦值还原，避免 FontPicker 依赖
    ed.resetSettings();
    // 恢复默认：仅把 this.settings 重置为默认值，未应用、未落盘
    assert.strictEqual(ed.settings.tabSize, 4, '恢复默认后内存为默认值 4');
    assert.strictEqual(ed.cm.getOption('tabSize'), 8, '恢复默认不立即生效（编辑器仍为 8）');
    assert.strictEqual(JSON.parse(w.localStorage.getItem('tizumark-settings')).tabSize, 8, '恢复默认不立即落盘');

    // 此时点「应用」→ 才将默认值生效并落盘
    w.document.getElementById('settings-apply-btn').dispatchEvent(new w.Event('click'));
    await delay(450); // rAF 一帧 + applySettings + 最小 loading 可见时长(300ms)
    assert.strictEqual(ed.cm.getOption('tabSize'), 4, '应用后编辑器生效为 4');
    assert.strictEqual(JSON.parse(w.localStorage.getItem('tizumark-settings')).tabSize, 4, '应用后落盘为 4');
    assert.ok(!w.document.getElementById('settings-dialog').classList.contains('hidden'), '应用后面板保持打开');
  } finally { cleanup(w); }
});

test('settings: 恢复默认后点 × 关闭，回滚到打开面板前的值（恢复默认是可撤销的未生效改动）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.cm.setOption('tabSize', 8);
    ed.settings = ed.defaultSettings();
    ed.settings.tabSize = 8;
    ed.saveSettings();
    ed.showSettings(); // 快照=8

    ed.renderCustomFontSettings = () => {};
    ed.resetSettings();
    assert.strictEqual(ed.settings.tabSize, 4, '恢复默认后内存为 4');

    // 直接取消（恢复默认未应用）→ 回滚到打开面板前的快照 8，而非恢复默认后的 4
    w.document.getElementById('settings-close-x').dispatchEvent(new w.Event('click'));
    assert.strictEqual(ed.settings.tabSize, 8, '取消后回滚到打开面板前的 8');
    assert.strictEqual(JSON.parse(w.localStorage.getItem('tizumark-settings')).tabSize, 8, '持久层仍为 8');
  } finally { cleanup(w); }
});

// ====== 应用/保存：按钮 loading + 完成后成功 toast（2026-08-09）======

test('settings: 点「应用」不显示 loading toast，完成后弹「应用成功」并保持面板打开', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const loadingToast = () => w.document.querySelector('#toast-container .settings-loading-toast');
    const successToast = () => w.document.querySelector('#toast-container .toast.success');
    assert.ok(!loadingToast(), '初始无 loading toast');
    const origApply = ed.applySettings.bind(ed);
    ed.applySettings = async () => {
      await new Promise(r => setTimeout(r, 100)); // 模拟真实重渲染耗时（mermaid 分批渲染）
      await origApply();
    };
    const themeSel = ed._selects && ed._selects.themeMode;
    assert.ok(themeSel, '主题 Select 组件实例应已创建');
    themeSel.setValue('dark'); // 模拟用户选择：onChange 仅写内存，不触发重渲染
    assert.ok(!loadingToast(), 'change 不触发重渲染');

    w.document.getElementById('settings-apply-btn').dispatchEvent(new w.Event('click'));
    await delay(80); // 等 _ensurePainted resolve（jsdom 无 rAF 时回退 ~16ms）
    assert.ok(!loadingToast(), '应用期间不显示 loading toast');
    await delay(650); // 重活 + _minDelay(300) 后弹成功 toast（默认 3000ms 可见），留足余量
    assert.ok(successToast(), '完成后弹出成功 toast');
    assert.ok(successToast().textContent.includes('应用成功'), '成功 toast 文案为「应用成功」');
    assert.ok(!w.document.getElementById('settings-dialog').classList.contains('hidden'), '应用后面板保持打开');
  } finally { cleanup(w); }
});

test('settings: 点应用按钮进入 loading 态，应用落盘后恢复，面板保持打开', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const applyBtn = w.document.getElementById('settings-apply-btn');
    ed._selects.tabSize.setValue('2');

    applyBtn.dispatchEvent(new w.Event('click'));
    assert.ok(applyBtn.disabled, '应用中按钮应禁用');
    assert.ok(applyBtn.classList.contains('is-loading'), '应用中显示按钮 loading');
    await delay(400); // rAF 让帧 + applySettings + 落盘 + 最小 loading 可见时长(300ms)

    assert.ok(!applyBtn.disabled, '应用完成后按钮恢复可用');
    assert.ok(!applyBtn.classList.contains('is-loading'), '应用完成后移除按钮 loading');
    assert.strictEqual(applyBtn.textContent, ed.t('apply'), '应用完成后按钮文案复原');
    const stored = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    assert.strictEqual(stored.tabSize, 2, '应用已落盘');
    assert.ok(!w.document.getElementById('settings-dialog').classList.contains('hidden'), '应用后面板保持打开');
  } finally { cleanup(w); }
});

test('settings: 点「保存」不显示 loading toast，完成后弹「保存成功」并关闭面板', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const loadingToast = () => w.document.querySelector('#toast-container .settings-loading-toast');
    const successToast = () => w.document.querySelector('#toast-container .toast.success');
    const origApply = ed.applySettings.bind(ed);
    ed.applySettings = async () => {
      await new Promise(r => setTimeout(r, 100)); // 模拟重渲染耗时
      await origApply();
    };
    const sel = w.document.getElementById('set-code-wrap');
    sel.checked = true;
    sel.dispatchEvent(new w.Event('change'));
    assert.ok(!loadingToast(), 'change 不触发重渲染');

    w.document.getElementById('settings-save-btn').dispatchEvent(new w.Event('click'));
    await delay(80); // 等 _ensurePainted resolve（jsdom 无 rAF 时回退 ~16ms）
    assert.ok(!loadingToast(), '保存期间不显示 loading toast');
    await delay(650); // 重活 + _minDelay(300) 后弹成功 toast（默认 3000ms 可见），留足余量
    assert.ok(successToast(), '完成后弹出成功 toast');
    assert.ok(successToast().textContent.includes('保存成功'), '成功 toast 文案为「保存成功」');
    assert.ok(w.document.getElementById('settings-dialog').classList.contains('hidden'), '保存后关闭');
  } finally { cleanup(w); }
});

test('settings: 点保存按钮进入 loading 态，应用落盘后恢复并关闭', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const saveBtn = w.document.getElementById('settings-save-btn');
    ed._selects.tabSize.setValue('2');

    saveBtn.dispatchEvent(new w.Event('click'));
    assert.ok(saveBtn.disabled, '保存中按钮应禁用');
    assert.ok(saveBtn.classList.contains('is-loading'), '保存中显示按钮 loading');
    await delay(400); // rAF 让帧 + applySettings + 落盘 + 最小 loading 可见时长(300ms) + 关面板

    assert.ok(!saveBtn.disabled, '保存完成后按钮恢复可用');
    assert.ok(!saveBtn.classList.contains('is-loading'), '保存完成后移除按钮 loading');
    assert.strictEqual(saveBtn.textContent, ed.t('save'), '保存完成后按钮文案复原');
    const stored = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    assert.strictEqual(stored.tabSize, 2, '保存已落盘');
    assert.ok(w.document.getElementById('settings-dialog').classList.contains('hidden'), '保存后关闭面板');
  } finally { cleanup(w); }
});

// ====== 取消恢复：自定义字体/提示文案等独立渲染控件（2026-08-04） ======

test('settings: 自定义字体选择后点 × 关闭，字体选择器恢复原值', async () => {
  const { w, ed } = await makeEditor();
  try {
    // jsdom 下 loadSystemFonts 默认无注入（空列表）；本测试聚焦自定义字体，显式置空系统字体列表
    ed._systemFonts = [];
    ed.settings.customFonts = [
      { id: 'cfA', name: 'Font A', fileName: 'a.ttf', hash: 'h1' },
      { id: 'cfB', name: 'Font B', fileName: 'b.ttf', hash: 'h2' },
    ];
    ed.settings.editorFont = 'cfA';
    ed.renderCustomFontSettings(); // 渲染选择器（初始选中 cfA）
    const picker = ed._fontPickers.editor;
    assert.ok(picker, '编辑器 FontPicker 存在');
    assert.strictEqual(picker.getValue(), 'cfA', '初始值 cfA');
    assert.strictEqual(picker.input.value, 'Font A', '显示导入名');

    ed.showSettings();
    picker.open();
    const itemB = [...picker.dropdown.querySelectorAll('.font-picker-item')].find((el) => el.getAttribute('data-value') === 'cfB');
    assert.ok(itemB, '自定义字体 cfB 在列表中');
    itemB.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(ed.settings.editorFont, 'cfB', '面板内改为 cfB');
    assert.strictEqual(picker.getValue(), 'cfB', '选择器值为 cfB');

    w.document.getElementById('settings-close-x').dispatchEvent(new w.Event('click'));
    assert.strictEqual(ed.settings.editorFont, 'cfA', '取消后内存恢复 cfA');
    assert.strictEqual(picker.getValue(), 'cfA', '取消后选择器恢复 cfA');
    assert.strictEqual(picker.input.value, 'Font A', '显示恢复 Font A');
  } finally { cleanup(w); }
});

test('settings: 图片路径模式切换后点 × 关闭，提示文案恢复', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const hint = w.document.getElementById('setting-image-asset-path-hint-text');
    const sel = ed._selects && ed._selects.imageAssetPathMode;
    assert.ok(sel, '图片存储路径 Select 组件实例应已创建');
    const initialText = hint.textContent;
    assert.ok(initialText.length > 0, '初始提示文案非空');

    sel.setValue('absolute');
    assert.strictEqual(ed.settings.imageAssetPathMode, 'absolute', '面板内改为 absolute');
    assert.notStrictEqual(hint.textContent, initialText, '提示文案已切换');

    w.document.getElementById('settings-close-x').dispatchEvent(new w.Event('click'));
    assert.strictEqual(ed.settings.imageAssetPathMode, 'relative', '取消后模式恢复 relative');
    assert.strictEqual(hint.textContent, initialText, '取消后提示文案恢复');
  } finally { cleanup(w); }
});

// ====== 应用式：滑块/主题等重量级设置不实时生效（2026-08-04） ======

test('settings: 字号滑块拖动只更新数值，应用后才改编辑器字号', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const slider = w.document.getElementById('set-font-size');
    slider.value = '18';
    slider.dispatchEvent(new w.Event('input'));
    assert.strictEqual(w.document.getElementById('font-size-label').textContent, '18px', 'label 实时更新');
    assert.strictEqual(ed.cm.getWrapperElement().style.fontSize, '14px', '编辑器字号未变（初始 14）');
    slider.dispatchEvent(new w.Event('change'));
    assert.strictEqual(ed.settings.fontSize, 18, '内存已更新');
    assert.strictEqual(ed.cm.getWrapperElement().style.fontSize, '14px', '应用前编辑器仍 14');

    w.document.getElementById('settings-apply-btn').dispatchEvent(new w.Event('click'));
    await delay(50);
    assert.strictEqual(ed.cm.getWrapperElement().style.fontSize, '18px', '应用后编辑器字号 18');
    assert.strictEqual(JSON.parse(w.localStorage.getItem('tizumark-settings')).fontSize, 18, '应用后落盘');
  } finally { cleanup(w); }
});

test('settings: 主题/配色 change 不触发重渲染，应用后才生效', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    let themeApplyCount = 0;
    const orig = ed.applyThemeMode.bind(ed);
    ed.applyThemeMode = async () => { themeApplyCount++; await orig(); };

    const themeSel = ed._selects && ed._selects.themeMode;
    assert.ok(themeSel, '主题 Select 组件实例应已创建');
    themeSel.setValue('dark');
    themeSel.setValue('light');
    assert.strictEqual(themeApplyCount, 0, '连续切换 change 不触发重渲染');
    assert.strictEqual(ed.settings.themeMode, 'light', '内存为最后值');
    assert.strictEqual(w.document.documentElement.getAttribute('data-theme'), 'light', '界面主题未变（初始 light）');

    w.document.getElementById('settings-apply-btn').dispatchEvent(new w.Event('click'));
    await delay(50);
    assert.strictEqual(themeApplyCount, 1, '应用只重渲染一次');
    assert.strictEqual(w.document.documentElement.getAttribute('data-theme'), 'light', 'light 仍是 light（dark 被覆盖）');
  } finally { cleanup(w); }
});

// ====== en 模式设置对话框 i18n 完整性（2026-08-04 回归） ======

test('settings: 切换英文后设置对话框无残留中文（除字体预览样例）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.language = 'en';
    ed.applyLanguage();
    ed.showSettings();

    const dlg = w.document.getElementById('settings-dialog');
    assert.ok(dlg, '设置对话框存在');
    // 标题与 section 标题（折叠块标题条内名称元素）
    assert.strictEqual(w.document.getElementById('settings-title').textContent, 'Settings');
    const sections = [...dlg.querySelectorAll('.settings-section .settings-section-name')].map(h => h.textContent);
    assert.deepStrictEqual(sections, ['Basic', 'Editor', 'Preview', 'Behavior', 'Custom Fonts', 'Quick Insert']);
    // 语言 / 主题 / 关闭行为 / 视图 / Tab / 最大宽度 options（自绘 Select 组件，随语言刷新）
    const lang = ed._selects && ed._selects.language;
    assert.ok(lang, '语言 Select 组件实例应已创建');
    assert.deepStrictEqual([...lang._options].map(o => o.label), ['Chinese', 'English']);
    const themeSel = ed._selects && ed._selects.themeMode;
    assert.ok(themeSel, '主题 Select 组件实例应已创建');
    assert.deepStrictEqual([...themeSel._options].map(o => o.label), ['Light', 'Dark', 'Follow System']);
    const close = ed._selects && ed._selects.closeAction;
    assert.ok(close, '关闭行为 Select 组件实例应已创建');
    assert.deepStrictEqual([...close._options].map(o => o.label), ['Ask every time', 'Quit app', 'Minimize to tray']);
    const view = ed._selects && ed._selects.defaultView;
    assert.ok(view, '默认视图 Select 组件实例应已创建');
    assert.deepStrictEqual([...view._options].map(o => o.label), ['Preview', 'Edit']);
    const tab = ed._selects && ed._selects.tabSize;
    assert.ok(tab, 'Tab 宽度 Select 组件实例应已创建');
    assert.deepStrictEqual([...tab._options].map(o => o.label), ['2 spaces', '4 spaces', '8 spaces']);
    const mw = ed._selects && ed._selects.maxWidth;
    assert.ok(mw, '最大宽度 Select 组件实例应已创建');
    assert.strictEqual(mw._options[0].label, 'Unlimited');
    // 遍历文本节点：除三个字体预览样例外不得含中文
    const leftovers = [];
    const walker = w.document.createTreeWalker(dlg, w.NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (!/[\u4e00-\u9fff]/.test(t)) continue;
      if (node.parentElement.closest('#font-preview-editor, #font-preview-preview, #font-preview-code')) continue; // 字体预览样例刻意中文
      leftovers.push(t.slice(0, 40));
    }
    assert.deepStrictEqual(leftovers, [], '设置对话框不应有残留中文，实际: ' + leftovers.join(' | '));
  } finally { cleanup(w); }
});

test('settings: 编辑/预览字号行标签应为「编辑字号」「预览字号」', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const rowLabel = (id) => {
      const el = w.document.getElementById(id);
      const label = el.closest('.settings-row').querySelector(':scope > label');
      return label ? label.textContent : null;
    };
    assert.strictEqual(rowLabel('set-font-size'), '编辑字号', '编辑器字号行标签应为「编辑字号」');
    assert.strictEqual(rowLabel('set-preview-font-size'), '预览字号', '预览字号行标签应为「预览字号」');
  } finally { cleanup(w); }
});

test('settings: 自定义字体分组内 编辑字重 紧邻 编辑器字号 之下', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const fontRow = w.document.getElementById('set-font-size').closest('.settings-row');
    const weightRow = w.document.getElementById('set-editor-font-weight').closest('.settings-row');
    const previewSizeRow = w.document.getElementById('set-preview-font-size').closest('.settings-row');
    assert.ok(fontRow && weightRow && previewSizeRow, '三行均存在');
    assert.strictEqual(weightRow.previousElementSibling, fontRow, '编辑字重应紧邻编辑器字号之后（同分组内）');
    assert.strictEqual(
      previewSizeRow.compareDocumentPosition(weightRow) & w.Node.DOCUMENT_POSITION_PRECEDING,
      w.Node.DOCUMENT_POSITION_PRECEDING,
      '编辑字重应在预览字号之前'
    );
  } finally { cleanup(w); }
});


// ====== 添加字体：立即保存列表，不自动切换选择项、不立即应用（2026-08-06） ======

// 构造 addFontFiles 所需 Tauri 运行时：dialogOpen 返回字体文件，
// appDataDir/ensureDir/fetchImageAsBase64/writeBinaryFile 均可用。
function mockFontImportEnv(w, files) {
  w.TauriApi.dialogOpen = async () => files;
  w.TauriApi.appDataDir = async () => 'C:/mock/appdata';
  w.TauriApi.ensureDir = async () => ({});
  w.TauriApi.fetchImageAsBase64 = async ({ url }) =>
    Buffer.from('font-bytes:' + url).toString('base64');
  w.TauriApi.writeBinaryFile = async () => ({});
  if (!w.requestAnimationFrame) {
    w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  }
}

test('settings: 添加字体只入列表并立即落盘，不自动切换编辑器/预览字体选择，也不应用', async () => {
  const { w, ed } = await makeEditor();
  try {
    // 预置当前选择项，验证添加后不被改写
    ed.settings.customFonts = [{ id: 'cfOld', name: 'Old Font', fileName: 'old.ttf', hash: 'h0' }];
    ed.settings.editorFont = 'cfOld';
    ed.settings.previewFont = 'cfOld';
    mockFontImportEnv(w, ['C:/fonts/NewFont.ttf']);

    await ed.addFontFiles();

    assert.strictEqual(ed.settings.customFonts.length, 2, 'customFonts 应新增一条');
    const added = ed.settings.customFonts.find(f => f.name === 'NewFont.ttf');
    assert.ok(added, '应含新字体 NewFont.ttf');
    assert.ok(added.id && added.fileName, '新字体应生成 id 与 fileName');

    // 不自动切换选择项
    assert.strictEqual(ed.settings.editorFont, 'cfOld', 'editorFont 应保持原选择');
    assert.strictEqual(ed.settings.previewFont, 'cfOld', 'previewFont 应保持原选择');

    // 不立即应用：CM/预览 fontFamily 不应变为 tizumark-custom-*
    assert.ok(!ed.cm.getWrapperElement().style.fontFamily.includes('tizumark-custom-cf'),
      '添加后不应自动应用字体到编辑器，实际: ' + ed.cm.getWrapperElement().style.fontFamily);
    assert.ok(!ed.preview.style.fontFamily.includes('tizumark-custom-cf'),
      '添加后不应自动应用字体到预览，实际: ' + ed.preview.style.fontFamily);

    // 字体列表已立即落盘
    ed.saveSettings(); // 先确保 localStorage 已有完整设置记录（tabSize=4 等）
    ed.settings.tabSize = 8; // 面板内未应用的改动（内存）
    await ed.addFontFiles();

    const stored = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    assert.strictEqual(stored.customFonts.length, 2, 'customFonts 应立即写入 localStorage');
    assert.strictEqual(stored.customFonts.find(f => f.name === 'NewFont.ttf')?.fileName, added.fileName);
    // 未应用的其他设置不应被 addFontFiles 落盘改动
    assert.strictEqual(stored.tabSize, 4, '未应用的其他设置不应被 addFontFiles 落盘');
  } finally { cleanup(w); }
});

test('settings: 添加字体后点 × 关闭面板，字体列表保留（快照已同步）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.customFonts = [];
    ed.settings.editorFont = '';
    ed.settings.previewFont = '';
    mockFontImportEnv(w, ['C:/fonts/Persist.ttf']);

    ed.showSettings(); // 打开面板会生成 _settingsSnapshot
    await ed.addFontFiles();
    assert.strictEqual(ed.settings.customFonts.length, 1, '添加后列表 1 条');

    // 取消面板：字体列表不回滚（快照已同步），选择项保持（本就未变）
    w.document.getElementById('settings-close-x').dispatchEvent(new w.Event('click'));
    assert.strictEqual(ed.settings.customFonts.length, 1, '取消后字体列表应保留');
    assert.strictEqual(ed.settings.customFonts[0].name, 'Persist.ttf');
    assert.strictEqual(ed.settings.editorFont, '', '选择项仍为空');
    assert.strictEqual(ed.settings.previewFont, '', '选择项仍为空');
  } finally { cleanup(w); }
});

test('settings: 添加字体后用户手动选择并应用/保存才生效落盘', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.customFonts = [];
    mockFontImportEnv(w, ['C:/fonts/Chosen.ttf']);
    await ed.addFontFiles();
    const added = ed.settings.customFonts[0];

    // 用户手动把选择项改为新字体（模拟下拉框 change）
    ed.settings.editorFont = added.id;
    ed.settings.previewFont = added.id;
    // 点「应用」→ applyPendingSettings → applySettings + saveSettings 全量落盘
    w.document.getElementById('settings-apply-btn').dispatchEvent(new w.Event('click'));
    await delay(60);

    const stored = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    assert.strictEqual(stored.editorFont, added.id, '应用后 editorFont 落盘为新字体');
    assert.strictEqual(stored.previewFont, added.id, '应用后 previewFont 落盘为新字体');
    assert.strictEqual(stored.customFonts.length, 1);
  } finally { cleanup(w); }
});

test('设置折叠块：5 个分类为折叠结构，默认展开，点击标题切换收起/展开', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const dlg = w.document.getElementById('settings-dialog');
    const sections = [...dlg.querySelectorAll('.settings-section')];
    assert.strictEqual(sections.length, 6, '应有 6 个设置分类');
    for (const sec of sections) {
      assert.strictEqual(sec.getAttribute('data-collapsed'), 'false', '设置分类默认展开');
      assert.ok(sec.querySelector('.settings-section-title'), '分类应含标题条');
      assert.ok(sec.querySelector('.settings-section-title .panel-title-icon'), '标题条应含图标');
      assert.ok(sec.querySelector('.settings-section-title .collapse-caret'), '标题条应含 caret');
      assert.ok(sec.querySelector('.settings-section-body'), '分类应含内容体');
    }
    // 点击第一个标题 → 收起
    const first = sections[0];
    first.querySelector('.settings-section-title').dispatchEvent(new w.Event('click', { bubbles: true }));
    assert.strictEqual(first.getAttribute('data-collapsed'), 'true', '点击标题应切换为收起');
    // 再点 → 展开
    first.querySelector('.settings-section-title').dispatchEvent(new w.Event('click', { bubbles: true }));
    assert.strictEqual(first.getAttribute('data-collapsed'), 'false', '再次点击应展开');
  } finally { cleanup(w); }
});

test('设置折叠块：每次打开重置为全展开', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.showSettings();
    const dlg = w.document.getElementById('settings-dialog');
    const sections = [...dlg.querySelectorAll('.settings-section')];
    // 收起第一块
    sections[0].querySelector('.settings-section-title').dispatchEvent(new w.Event('click', { bubbles: true }));
    assert.strictEqual(sections[0].getAttribute('data-collapsed'), 'true', '点击后应收起');
    // 重新打开 → 重置为全展开
    ed.hideSettings();
    ed.showSettings();
    const sections2 = [...dlg.querySelectorAll('.settings-section')];
    for (let i = 0; i < sections2.length; i++) {
      assert.strictEqual(sections2[i].getAttribute('data-collapsed'), 'false', `重新打开后第 ${i + 1} 块应重置为展开`);
    }
  } finally { cleanup(w); }
});

test('关于折叠块：4 块统一结构，默认全部展开，每次打开重置为全展开，点击标题切换', async () => {
  const { w, ed } = await makeEditor();
  try {
    await ed.showAbout();
    const blocks = [...w.document.querySelectorAll('#about-dialog .dependency-details')];
    assert.strictEqual(blocks.length, 4, '关于面板应有 4 个折叠块');
    const names = blocks.map(b => b.querySelector('.dependency-name').textContent);
    assert.deepStrictEqual(names, ['版本信息', '联系我们', '许可协议', '第三方组件']);
    // 默认全部展开
    for (let i = 0; i < blocks.length; i++) {
      assert.strictEqual(blocks[i].getAttribute('data-collapsed'), 'false', `第 ${i + 1} 块默认展开`);
    }
    // 每块标题条含图标 + caret
    for (const b of blocks) {
      assert.ok(b.querySelector('.dependency-title .panel-title-icon'), '标题条应含图标');
      assert.ok(b.querySelector('.dependency-title .collapse-caret'), '标题条应含 caret');
    }
    // 点击「联系我们」→ 收起
    blocks[1].querySelector('.dependency-title').dispatchEvent(new w.Event('click', { bubbles: true }));
    assert.strictEqual(blocks[1].getAttribute('data-collapsed'), 'true', '点击标题应收起');
    // 重新打开 → 重置为全部展开
    ed.hideAbout ? ed.hideAbout() : w.document.getElementById('about-dialog').classList.add('hidden');
    await ed.showAbout();
    const blocks2 = [...w.document.querySelectorAll('#about-dialog .dependency-details')];
    for (let i = 0; i < blocks2.length; i++) {
      assert.strictEqual(blocks2[i].getAttribute('data-collapsed'), 'false', `重新打开后第 ${i + 1} 块应重置为展开`);
    }
  } finally { cleanup(w); }
});

test('图标源统一为 Lucide（内联 SVG，无 Feather 残留）', () => {
  const fs = require('fs');
  const path = require('path');
  const files = ['index.html', 'app.js', 'modules/file-search.js'];
  const all = files.map(f => fs.readFileSync(path.resolve(__dirname, '..', 'src', f), 'utf8')).join('\n');
  // Lucide 特征路径应存在（folder / list / file）
  assert.ok(/M20 20a2 2 0 0 0 2-2V8/.test(all), '应含 Lucide folder 路径');
  assert.ok(/M3 5h\.01/.test(all), '应含 Lucide list 路径');
  assert.ok(/M6 22a2 2 0 0 1-2-2V4/.test(all), '应含 Lucide file 路径');
  // Feather 旧式 folder/file 路径不应再出现（避免回退）
  assert.ok(!/M3 7a2 2 0 0 1 2-2h4l2 2h8a2/.test(all), '不应残留 Feather 式 folder 路径');
  assert.ok(!/M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10/.test(all), '不应残留 Feather 式 file 路径');
});

test('settings: 新增 界面字号/预览字重/编辑字重 默认值', async () => {
  const { w, ed } = await makeEditor();
  try {
    const d = ed.defaultSettings();
    assert.strictEqual(d.uiFontSize, 13, '界面字号默认 13px');
    assert.strictEqual(d.previewFontWeight, 400, '预览字重默认 400');
    assert.strictEqual(d.editorFontWeight, 400, '编辑字重默认 400');
  } finally { cleanup(w); }
});

test('settings: applySettings 写入 UI字号与字重 CSS 变量（含动态加粗联动）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.uiFontSize = 18;
    ed.settings.previewFontWeight = 300;
    ed.settings.editorFontWeight = 500;
    await ed.applySettings();
    const root = w.document.documentElement;
    assert.strictEqual(root.style.getPropertyValue('--ui-font-size').trim(), '18px', '界面字号应写入 :root');
    assert.strictEqual(root.style.getPropertyValue('--preview-weight').trim(), '300', '预览基础字重应写入');
    assert.strictEqual(root.style.getPropertyValue('--preview-bold-weight').trim(), '500', '基础300→加粗应动态500');
    assert.strictEqual(ed.cm.getWrapperElement().style.fontWeight, '500', '编辑字重应套到 CodeMirror 包裹层');
  } finally { cleanup(w); }
});

test('settings: 预览字重加粗联动封顶 900（基础600→加粗800）', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.previewFontWeight = 600;
    await ed.applySettings();
    assert.strictEqual(
      w.document.documentElement.style.getPropertyValue('--preview-bold-weight').trim(),
      '800', '基础600 时加粗应为 800，明显重于正文'
    );
  } finally { cleanup(w); }
});

test('settings: 界面字号与字重滑块初始化后存在并可回填', async () => {
  const { w, ed } = await makeEditor();
  try {
    assert.ok(w.document.getElementById('set-ui-font-size'), '界面字号滑块应存在');
    assert.ok(w.document.getElementById('set-preview-font-weight'), '预览字重滑块应存在');
    assert.ok(w.document.getElementById('set-editor-font-weight'), '编辑字重滑块应存在');
    // 改设置后回填控件显示
    ed.settings.uiFontSize = 15;
    ed.settings.previewFontWeight = 500;
    ed.settings.editorFontWeight = 600;
    ed.syncSettingsControls();
    assert.strictEqual(w.document.getElementById('ui-font-size-label').textContent, '15px', '字号标签应回填');
    assert.strictEqual(w.document.getElementById('preview-font-weight-label').textContent, '500', '预览字重标签应回填');
    assert.strictEqual(w.document.getElementById('editor-font-weight-label').textContent, '600', '编辑字重标签应回填');
  } finally { cleanup(w); }
});
