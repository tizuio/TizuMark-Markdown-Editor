// 阶段1 回归测试：三模式（阅读 / 源码 / 所见即所得）骨架。
//
// 覆盖本次改动的行为契约：
//   1. 顶部三钮存在且文案为新名（阅读 / 源码 / 所见即所得），data-mode 正确；
//   2. setViewMode 支持第三模式：切到 wysiwyg 写 viewMode、加 wysiwyg-mode 类、按钮 active；
//   3. Ctrl+\（toggleViewMode）三模式循环 阅读→源码→所见即所得→阅读；
//   4. 类型守卫：非 Markdown（图片/明文）切所见即所得被拦截并提示，不改状态；
//   5. 悬停简介 tooltip 挂载 + i18n key 齐全（三语言）。
//
// 静态断言走 readBundle()（app.js 已拆分到 modules/，不可直接 readFileSync('src/app.js')）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { readBundle, ROOT } = require('./helpers/app-bundle.cjs');

const INDEX = path.join(ROOT, 'src', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');
const bundle = readBundle();

// ---------- 1. 顶部三钮结构与文案 ----------

test('顶部视图模式为三钮，且文案已重命名为 阅读/源码/所见即所得', () => {
  assert.match(html, /id="btn-view-preview"/, '缺少 btn-view-preview');
  assert.match(html, /id="btn-view-edit"/, '缺少 btn-view-edit');
  assert.match(html, /id="btn-view-wysiwyg"/, '缺少 btn-view-wysiwyg（第三模式按钮）');

  // 只在 .view-mode-tabs 容器内断言文案，避免误伤设置面板里的「预览」分区名等
  const start = html.indexOf('class="view-mode-tabs"');
  assert.ok(start > 0, '未找到 .view-mode-tabs 容器');
  const block = html.slice(start, html.indexOf('</div>', html.indexOf('btn-view-wysiwyg')) + 6);
  assert.doesNotMatch(block, />\s*预览\s*<\/span>/, '模式按钮仍写「预览」，应改为「阅读」');
  assert.doesNotMatch(block, />\s*编辑\s*<\/span>/, '模式按钮仍写「编辑」，应改为「源码」');
  assert.match(block, />\s*阅读\s*<\/span>/);
  assert.match(block, />\s*源码\s*<\/span>/);
  assert.match(block, />\s*所见即所得\s*<\/span>/);

  assert.match(html, /data-mode="preview"/);
  assert.match(html, /data-mode="edit"/);
  assert.match(html, /data-mode="wysiwyg"/);
});

test('三钮均带 data-tip-key（悬停简介数据源），且不再用原生 title', () => {
  const keys = [...html.matchAll(/data-tip-key="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(
    keys.slice(0, 3),
    ['viewModeReadTip', 'viewModeSourceTip', 'viewModeWysiwygTip'],
    '三钮 tip-key 缺失或顺序不对'
  );
  // 原生 title 延迟高、无法多行、样式不可控，本阶段统一改自定义 tooltip
  const tabsBlock = html.slice(html.indexOf('view-mode-tabs'), html.indexOf('view-mode-tabs') + 2000);
  assert.doesNotMatch(tabsBlock, /title="(预览模式|编辑模式)"/, '三钮仍在用原生 title');
});

// ---------- 2. setViewMode / applyViewMode 支持第三模式 ----------

test('applyViewMode 依据 viewMode 切换三钮 active 并挂 wysiwyg-mode 类', () => {
  assert.match(bundle, /btn-view-wysiwyg/, 'theme.js 未引用第三模式按钮');
  assert.match(bundle, /classList\.add\('wysiwyg-mode'\)/, '缺少 wysiwyg-mode 容器类');
  assert.match(
    bundle,
    /classList\.remove\('preview-mode',\s*'editor-collapsed',\s*'preview-collapsed',\s*'text-only',\s*'wysiwyg-mode'\)/,
    'applyViewMode 未在重置类名时清除 wysiwyg-mode（会导致模式切换后残留）'
  );
  assert.match(
    bundle,
    /btnWysiwyg\.classList\.toggle\('active',\s*this\.viewMode === 'wysiwyg'\)/,
    '第三钮 active 态未随 viewMode 切换'
  );
});

test('所见即所得仅对 Markdown 开放：非 md 被 setViewMode 守卫拦截', () => {
  assert.match(
    bundle,
    /if \(_kind !== 'markdown' && mode === 'wysiwyg'\) \{[^}]*showToast[^}]*return;/s,
    '缺少「非 Markdown 不得切所见即所得」的守卫'
  );
});

// ---------- 3. Ctrl+\ 三模式循环 ----------

test('toggleViewMode 为三模式循环（阅读→源码→所见即所得→阅读）', () => {
  // 旧的二态实现必须已消失
  assert.doesNotMatch(
    bundle,
    /setViewMode\(this\.viewMode === 'preview' \? 'edit' : 'preview'\)/,
    'toggleViewMode 仍是旧的二态切换'
  );
  const m = bundle.match(/toggleViewMode\(\)\s*\{([\s\S]*?)\n\s{6}\},/);
  assert.ok(m, '未找到 toggleViewMode 实现');
  assert.match(m[1], /const order = \['preview',\s*'edit',\s*'wysiwyg'\]/, '循环顺序不是 阅读→源码→所见即所得');
  assert.match(m[1], /order\[\(cur \+ 1\) % order\.length\]/, '未按顺序取下一模式（无法循环）');
});

// ---------- 4. 空行占位提示 ----------

test('空行占位提示：markText 实现 + 光标/输入事件均已接线', () => {
  assert.match(html, /<script src="modules\/empty-hint\.js"><\/script>/, 'index.html 未引入 empty-hint.js');
  assert.match(bundle, /Object\.assign\(MarkdownEditor\.prototype,\s*TMEmptyHint\.mixin\)/, 'TMEmptyHint mixin 未挂载');

  // 事件接线：change 与 cursorActivity 两处都要重算
  const coreChanges = bundle.match(/this\.cm\.on\('change',[\s\S]*?\n\s*\}\);/);
  assert.ok(coreChanges && /updateEmptyLineHint\(\)/.test(coreChanges[0]), 'change 事件未重算空行提示');
  // cursorActivity 段以 updateOutlineActive(cursor.line) 收尾（该行之后可能还有别的语句，故用宽松边界）
  const cursorIdx = bundle.indexOf("this.cm.on('cursorActivity'");
  assert.ok(cursorIdx > 0, '未找到 cursorActivity 绑定');
  const coreCursor = bundle.slice(cursorIdx, cursorIdx + 2000);
  assert.match(coreCursor, /updateEmptyLineHint\(\)/, 'cursorActivity 未重算空行提示（光标进出空行不增删）');
});

test('空行占位提示：仅独立空行显示，排除代码围栏内', () => {
  assert.match(bundle, /line\.trim\(\) === ''/, '未判定空行');
  assert.match(bundle, /isInsideFence/, '未排除代码围栏内的空行');
  assert.match(bundle, /\/\^`\{3,\}\|\^~\{3,\}\//, '围栏判定正则缺失');
  // 阅读模式无光标，不应显示提示
  assert.match(bundle, /if \(this\.viewMode === 'preview'\) return this\.clearEmptyLineHint\(\);/, '阅读模式不应显示空行提示');
});

test('空行占位提示：样式与 i18n 文案齐备（三语言）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.cm-empty-placeholder/, '缺少 .cm-empty-placeholder 样式');
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  const hits = i18n.match(/emptyLineHint:/g) || [];
  assert.strictEqual(hits.length, 3, 'emptyLineHint 应在 zh/en/es 三语言各有一份');
});

// ---------- 5. i18n 文案完整性 ----------

test('三模式名与简介的 i18n key 在 zh/en/es 三语言齐备', () => {
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  for (const key of ['viewModeRead', 'viewModeSource', 'viewModeWysiwyg',
                     'viewModeReadTip', 'viewModeSourceTip', 'viewModeWysiwygTip']) {
    const n = (i18n.match(new RegExp(`${key}:`, 'g')) || []).length;
    assert.strictEqual(n, 3, `${key} 应在 zh/en/es 各有一份，实际 ${n} 份`);
  }
  // 简介必须是可读长度（一两个字不算简介）
  assert.match(i18n, /viewModeWysiwygTip: '[^']{20,}'/, '所见即所得简介过短');
});

test('设置「默认视图」下拉新增所见即所得选项', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'settings.js'), 'utf8');
  const start = settings.indexOf('_selects.defaultView = new Select');
  assert.ok(start > 0, '未找到默认视图 Select');
  const block = settings.slice(start, start + 600);
  assert.match(block, /value: 'wysiwyg'/, '默认视图下拉缺少「所见即所得」选项');
  // 选项文案改用新模式名
  assert.match(block, /t\('viewModeRead'\)/, '默认视图选项文案未用 viewModeRead');
  assert.match(block, /t\('viewModeSource'\)/, '默认视图选项文案未用 viewModeSource');
  assert.match(block, /t\('viewModeWysiwyg'\)/, '默认视图选项文案未用 viewModeWysiwyg');
});

// ---------- 6. 未保存保护 ----------

test('beforeunload 拦截未保存内容（防所见即所得下静默丢失）', () => {
  const m = bundle.match(/window\.addEventListener\('beforeunload',[\s\S]*?\}\);\s*\n\s{2}\}/);
  assert.ok(m, '未找到 beforeunload 处理');
  assert.match(m[0], /t\.isModified/, 'beforeunload 未检查未保存标签');
  assert.match(m[0], /e\.preventDefault\(\)/, 'beforeunload 未 preventDefault（不会触发提示）');
  assert.match(m[0], /e\.returnValue = ''/, '缺少 returnValue 兜底（旧内核兼容）');
});
