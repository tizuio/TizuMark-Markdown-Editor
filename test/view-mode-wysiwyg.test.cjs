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

// ---------- 7. 块级遮罩核心（阶段1 补做项） ----------

test('wysiwyg 模块已注册且核心方法齐备', () => {
  assert.match(html, /<script src="modules\/wysiwyg\.js"><\/script>/, 'index.html 未引入 wysiwyg.js');
  assert.match(bundle, /Object\.assign\(MarkdownEditor\.prototype,\s*TMWysiwyg\.mixin\)/, 'TMWysiwyg mixin 未挂载');
  for (const m of ['computeWysiwygBlocks', 'wysiwygBlockIndexAt', 'renderWysiwygMasks',
                   'maskWysiwygBlock', 'unmaskWysiwygBlock', 'setWysiwygActiveBlock',
                   'syncWysiwygActiveBlock', 'refreshWysiwygBlocks', 'clearWysiwygMasks']) {
    assert.match(bundle, new RegExp(m + '\\s*\\('), '缺少核心方法 ' + m);
  }
});

test('遮罩用 markText+replacedWith 真正替换源码（单一数据源，不做逆序列化）', () => {
  // ⚠️ 不得用 addLineWidget：只在行下方「附加」、不隐藏源码行 -> 源码与渲染重复
  assert.doesNotMatch(bundle, /cm\.addLineWidget\(/, '仍用 addLineWidget（源码与渲染会重复）');
  assert.match(bundle, /cm\.markText\(/, '未用 markText');
  assert.match(bundle, /replacedWith: node/, '未用 replacedWith 替换源码文本');
  assert.match(bundle, /clearWhenEmpty: false/, '缺 clearWhenEmpty:false（文本清空时标记消失会闪烁）');
  // 渲染入口必须是既有 unified 管线，不得引入 DOM->MD 反序列化
  assert.match(bundle, /UnifiedRenderer\.renderMarkdown\(/, '未走既有 unified 渲染管线');
  assert.doesNotMatch(bundle, /turndown/i, '出现了 turndown（逆序列化），与单一数据源原则冲突');
});

test('遮罩必须带 preview-content 类，否则标题/表格/列表全无排版样式', () => {
  // 预览排版 CSS 的作用域是 `.preview-content xxx`（styles.css 1801 起）。
  // 遮罩节点不带该类 → 一张样式都套不上；真机表现为「渲染出来格式基本全丢」。
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /node\.className = MASK_CLASS \+ ' preview-content'/,
    '遮罩节点未带 preview-content 类（渲染将无标题/表格/列表样式）');
  // CSS 侧须用更高优先级覆盖 preview-content 自身的容器属性，否则撑坏 CM 行盒
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.CodeMirror \.wysiwyg-block-mask\.preview-content \{/,
    '缺少 .CodeMirror .wysiwyg-block-mask.preview-content 覆盖规则');
  for (const prop of ['overflow: visible', 'display: block', 'white-space: normal']) {
    assert.ok(css.indexOf(prop) >= 0, '覆盖规则缺少 ' + prop);
  }
  // ⚠️ white-space:normal 是关键：CM 行是 pre，遮罩继承会把渲染 HTML 里标签间的
  //    换行符全显示为真实换行（列表序号单独成行、块内大空隙）——2026-10-07 真机定位
  assert.match(css, /wysiwyg-block-mask\.preview-content[\s\S]{0,900}white-space: normal;/,
    '遮罩未恢复 white-space:normal（渲染 HTML 的标签间换行会变成真实换行）');
  // 淡色块标识（阶段1 计划项）
  assert.match(css, /wysiwyg-block-mask\.preview-content[\s\S]{0,900}background: color-mix/,
    '缺少淡色块标识底色');
});

test('点击必须能进块：遮罩自行接管 mousedown，不得依赖 CM 坐标映射', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // pointer-events:none 会让点击穿透到空白 -> CM 拿不到有效坐标 -> 点不进块（真机实测）
  assert.doesNotMatch(wsrc, /pointerEvents = 'none'/,
    '仍设 pointer-events:none（点击穿透，CM 无法定位，块点不进去）');
  assert.match(wsrc, /addEventListener\('mousedown'/, '遮罩未接管 mousedown');
  assert.match(wsrc, /ev\.stopPropagation\(\)/, '未阻止冒泡（CM 的坐标映射会覆盖我们的定位）');
  // 定位必须基于 marker.find() 的实时位置，块划分变化后才不会错位
  assert.match(wsrc, /mark && mark\.find \? mark\.find\(\) : null/, '未用 marker.find() 取实时位置');
  // 定位光标用 setSelection（不是 setCursor）：后者会 ensureCursorVisible 抢先滚动，
  // 使随后的点击锚定判定「已可见」而失效（真机「点击屏幕乱跳」根因之一）。
  assert.match(wsrc, /cm\.setSelection\(/, '接管点击后未设置光标');
  assert.match(wsrc, /cm\.focus\(\)/, '未聚焦编辑器（光标设了但键盘输入不到）');
});

test('块划分以 remark 解析器为主（与阅读模式同一套解析），splitBlocks 仅回退', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 主路径：remark 切块 —— 手写行级切块器与 CommonMark 边界有系统性偏差
  //（`1.` 独立行 + 缩进内容被拆开 → 渲染出「只剩序号的空列表项」），逐块渲染对不上阅读模式
  assert.match(wsrc, /UnifiedRenderer\.renderMarkdownBlocks\(/, 'computeWysiwygBlocks 未走 remark 切块主路径');
  assert.match(wsrc, /if \(blocks\) return blocks;/, 'remark 切块失败时未直接采用其结果');
  // 回退路径保留（渲染器不可用时兜底）；行为验证见 test/wysiwyg-blocks.test.cjs
  assert.match(bundle, /function splitBlocks\(lines\)/, '回退切块器 splitBlocks 缺失');
  const codeOnly = wsrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /function isBlockStart/, 'wysiwyg.js 仍保留粗粒度 isBlockStart（会误切块）');
  // 渲染器侧：块边界取自 remark node.position
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  assert.match(rsrc, /function renderMarkdownBlocks\(content, options\)/, '渲染器缺少 renderMarkdownBlocks');
  assert.match(rsrc, /node\.position\.start\.line/, '块边界未取自 remark node.position');
  assert.match(rsrc, /module\.exports = \{ renderMarkdown, renderMarkdownBlocks \}/, 'Node 导出缺 renderMarkdownBlocks');
  assert.match(rsrc, /return \{ renderMarkdown, renderMarkdownBlocks \};/, '浏览器导出缺 renderMarkdownBlocks');
});

test('增量更新：change 不得全量重建遮罩（否则每次按键都卡）', () => {
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  // change 事件里必须是廉价的 refreshWysiwygBlocks（仅更新行索引缓存 + 防抖补齐）
  assert.match(coreSrc, /if \(this\.viewMode === 'wysiwyg'\) this\.refreshWysiwygBlocks\(\)/,
    'change 未走增量 refreshWysiwygBlocks');
  assert.doesNotMatch(coreSrc, /viewMode === 'wysiwyg'\) this\.renderWysiwygMasks\(\)/,
    'change 仍在全量 renderWysiwygMasks（每次按键把整篇重渲染一遍）');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 昂贵的渲染必须防抖
  assert.match(wsrc, /_wysiwygMaskTimer = setTimeout\(/, '缺少防抖补齐定时器');
  // 跨块只处理受影响的两个块（旧块恢复遮罩 + 新块撤遮罩）
  assert.match(wsrc, /if \(prev >= 0\) \{[\s\S]{0,300}?this\.maskWysiwygBlock\(prev\);/, '未恢复旧块遮罩');
  // 旧块在活动期间被编辑过，缓存 html 已过期，恢复遮罩前必须重渲染
  assert.match(wsrc, /b\.html = this\.renderWysiwygBlockHtml\(b\.start, b\.end\);/,
    '旧块恢复遮罩前未按最新源码重渲染（会把编辑前的旧内容盖回去）');
  assert.match(wsrc, /this\.unmaskWysiwygBlock\(idx\);/, '未撤掉新活动块遮罩');
  const setIdx = wsrc.indexOf('setWysiwygActiveBlock(idx) {');
  assert.ok(setIdx > 0, '未找到 setWysiwygActiveBlock');
  assert.doesNotMatch(wsrc.slice(setIdx, setIdx + 400), /clearWysiwygMasks/,
    'setWysiwygActiveBlock 内部不得全量重建（每次跨块都会整篇重排）');
});

test('块高抖动补偿必须同步完成（不得用 rAF，异步补偿本身就是可见跳动）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /cm\.cursorCoords\(null, 'window'\)/, '未用 cursorCoords 取光标视口坐标');
  assert.match(wsrc, /cm\.scrollTo\(info\.left, info\.top \+ delta\)/, '未按差值回滚滚动');
  assert.doesNotMatch(wsrc, /requestAnimationFrame/, '仍在用 rAF 做异步补偿（本身就会看到跳动）');
  assert.doesNotMatch(wsrc, /info\.clientHeight/, '误用 info.clientHeight（CM5 scrollInfo 无此字段）');
  // 差值过大说明是结构级变化，此时补偿反而更糟，须放弃
  assert.match(wsrc, /Math\.abs\(delta\) > vh/, '缺少过大差值的放弃判定');
});

test('遮罩生命周期正确：离开模式清理，不泄漏 mark', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 注意：必须锚到定义体（'clearWysiwygMasks() {'），首个出现处是 renderWysiwygMasks 里的调用
  const cIdx = wsrc.indexOf('clearWysiwygMasks() {');
  assert.ok(cIdx > 0, '缺少 clearWysiwygMasks 定义');
  const blk = wsrc.slice(cIdx, cIdx + 700);
  assert.match(blk, /Array\.from\(this\._wysiwygMarks\.values\(\)\)/, '未遍历清理 mark');
  assert.match(blk, /mark\.clear\(\)/, '未 clear mark（会泄漏）');
  assert.match(blk, /clearTimeout\(this\._wysiwygMaskTimer\)/, '未清理防抖定时器');
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const avIdx = themeSrc.indexOf('applyViewMode()');
  assert.ok(avIdx > 0, '未找到 applyViewMode');
  assert.match(themeSrc.slice(avIdx, avIdx + 4000), /this\.clearWysiwygMasks\(\)/, 'applyViewMode 未清理遮罩');
});

test('所见即所得独占编辑区：预览栏隐藏（与阅读/源码区分）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.editor-container\.wysiwyg-mode \.preview-pane \{ display: none; \}/,
    '所见即所得下预览栏应隐藏（否则与阅读模式无异）');
  assert.match(css, /\.editor-container\.wysiwyg-mode \.editor-pane \{ flex: 1 1 100%/,
    '所见即所得下编辑区应占满宽度');
});
// ---------- 8. 模式名回归护栏（曾被 i18n 覆盖回「预览/编辑」） ----------

test('模式名由 i18n 统一提供：阅读/源码/所见即所得（三钮全覆盖）', () => {
  const i18njs = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n.js'), 'utf8');
  // 三个按钮都要被 i18n 赋值；曾因只覆盖两个而让 HTML 里的新名被改回旧名
  for (const [btn, key] of [
    ['btn-view-preview', 'viewModeRead'],
    ['btn-view-edit', 'viewModeSource'],
    ['btn-view-wysiwyg', 'viewModeWysiwyg'],
  ]) {
    assert.match(i18njs, new RegExp(`updateMenuText\\('${btn}', t\\('${key}'\\)\\)`),
      `${btn} 未用 ${key} 赋值（会被 i18n 覆盖成旧名）`);
  }
  // 不得再对三钮用旧的 preview/edit 键
  assert.doesNotMatch(i18njs, /updateMenuText\('btn-view-(preview|edit)', t\('(preview|edit)'\)\)/,
    '三钮仍在用旧的 t(preview)/t(edit)');
  // 原生 title 也换成简介（自定义 tooltip 为主，title 为无障碍/回退）
  for (const key of ['viewModeReadTip', 'viewModeSourceTip', 'viewModeWysiwygTip']) {
    assert.match(i18njs, new RegExp(`setTitle\\('btn-view-\\w+', t\\('${key}'\\)\\)`), `title 未用 ${key}`);
  }
});

test('空行占位提示：wrap 类 + CSS 变量文案（data-hint 方案已被证伪）', () => {
  const esrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'empty-hint.js'), 'utf8');
  // 曾用零长度 markText + replacedWith，CM5 中不渲染 → 提示不显示
  assert.doesNotMatch(esrc, /cm\.markText\(/,
    '仍用 markText（零长度 markText 在 CM5 不渲染，提示不会出现）');
  assert.match(esrc, /cm\.addLineClass\(/, '未用 addLineClass');
  assert.match(esrc, /cm\.removeLineClass\(/, '未实现清理（removeLineClass）');
  // ⚠️ data-hint 方案已证伪：CM5 没有 getLineElement API，行 DOM 拿不到，属性永远写不上
  // 只禁代码调用，注释里提到该 API 名是允许的（用于记录踩坑）
  assert.doesNotMatch(esrc, /cm\.getLineElement\(/, '仍调用不存在的 cm.getLineElement（data-hint 永远写不上）');
  // 同上：只禁代码写入，注释中提及方案名是允许的
  assert.doesNotMatch(esrc, /setAttribute\('data-hint'|data-hint\s*=/,
    '仍用 data-hint（拿不到行 DOM，属性写不上）');
  // 文案走 CSS 变量（documentElement 上设置，切语言自动刷新）
  assert.match(esrc, /--empty-hint-text/, '未写入 --empty-hint-text CSS 变量');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.CodeMirror \.cm-empty-placeholder \.CodeMirror-line::after \{/, '缺少行内 ::after');
  assert.match(css, /content: var\(--empty-hint-text/, '::after 未取 CSS 变量');
  // 类挂在 wrap（行包装器），CSS 从包装器穿透到 .CodeMirror-line
  assert.match(esrc, /addLineClass\(handle, 'wrap'/, '未挂到 wrap（挂 background 时 ::after 不在行内）');
});

// ---------- 9. 块间空行塌缩（2026-10-07 真机反馈「间隔了很多空行」） ----------

test('空行塌缩：updateWysiwygBlankLines 存在且增量挂类，光标所在空行例外', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  for (const m of ['updateWysiwygBlankLines', '_setWysiwygBlankClass', '_isWysiwygBlankLine']) {
    assert.match(wsrc, new RegExp(m + '\\s*\\('), '缺少方法 ' + m);
  }
  // 必须走 diff 增量（prev/next 集合比对），不得每次全量 addLineClass
  assert.match(wsrc, /const prev = this\._wysiwygBlankLines;/, '未做增量 diff');
  assert.match(wsrc, /if \(!next\.has\(i\)\) this\._setWysiwygBlankClass\(i, false\);/, '未摘除失效行');
  assert.match(wsrc, /if \(!prev\.has\(i\)\) this\._setWysiwygBlankClass\(i, true\);/, '未挂新增行');
  // 光标所在空行不塌缩（需要光标与占位提示可见）
  assert.match(wsrc, /i !== curLine && cm\.getLine\(i\)\.trim\(\) === ''/,
    '未排除光标所在行（光标会被压扁）');
  // cursorActivity 时临时摘掉光标行塌缩类，离开后恢复
  assert.match(wsrc, /_setWysiwygBlankClass\(line, false\)/, '光标进入空行未恢复全高');
  // 生命周期：清理时须撤掉全部塌缩类
  const cIdx = wsrc.indexOf('clearWysiwygMasks() {');
  const blk = wsrc.slice(cIdx, cIdx + 1100);
  assert.match(blk, /for \(const i of this\._wysiwygBlankLines\) this\._setWysiwygBlankClass\(i, false\);/,
    '清理未撤空行塌缩类（离开模式后空行仍是塌缩态）');
  // 两处调用：全量重建后 + 防抖补齐后
  assert.match(wsrc, /cm\.refresh\(\); \} catch \(_\) \{ \/\* ignore \*\/ \}\n      this\.updateWysiwygBlankLines\(\);/,
    '全量重建后未更新空行塌缩');
  assert.match(wsrc, /self\.updateWysiwygBlankLines\(\);/, '防抖补齐后未更新空行塌缩');
});

test('CSS：空行塌缩为小间距，遮罩行盒 strut 置 0', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.CodeMirror \.cm-wysiwyg-blank \.CodeMirror-line \{ line-height: 12px; \}/,
    '缺少空行塌缩样式（块与块之间会隔出整行空白）');
  assert.match(css, /pre\.CodeMirror-line:has\(> span > \.CodeMirror-widget > \.wysiwyg-block-mask\)/,
    '缺少遮罩行 strut 置 0 规则');
  assert.match(css, /:has\(\> span \> \.CodeMirror-widget \> \.wysiwyg-block-mask\)[\s\S]{0,80}line-height: 0;/,
    'strut 置 0 规则缺少 line-height: 0');
});

// ---------- 10. 渲染态任务复选框（阶段2 计划项） ----------

test('复选框回写须加块起始行偏移（data-source-line 是切片内相对行号）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /toggleWysiwygTaskCheckbox\(box\)/, '缺少 toggleWysiwygTaskCheckbox');
  // 从遮罩节点取块索引并用块表换算绝对行号
  assert.ok(wsrc.indexOf("box.closest ? box.closest('.' + MASK_CLASS) : null") >= 0,
    '未从遮罩节点定位所在块');
  assert.match(wsrc, /\(block \? block\.start : 0\) \+ srcLine - 1/,
    '未按块起始行偏移换算（data-source-line 是切片内相对行号，漏加会勾错行）');
  // 点击接管里须先让位给复选框处理
  assert.match(wsrc, /closest\('input\[type="checkbox"\]'\)/, 'mousedown 未识别复选框点击');
  // 翻转后立即重渲染所在块
  assert.match(wsrc, /toggleWysiwygTaskCheckbox\(box\);\n            return;/, '复选框点击未短路光标定位');
});

// ---------- 11. 点击锚定（真机反馈「点击后屏幕乱跳」的根因修复） ----------

// 取遮罩 mousedown 处理器的完整源码块。
// ⚠️ 不能简单 indexOf('});')：setSelection 的多行实参结尾自带 '});'，会把块提前截断。
function mousedownBlock(wsrc) {
  const start = wsrc.indexOf("node.addEventListener('mousedown'");
  const end = wsrc.indexOf('\n      });\n', start);
  return wsrc.slice(start, end < 0 ? wsrc.length : end);
}

test('点击定位须关闭 CM 自动滚动（ensureCursorVisible 会抢先滚一次）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // setSelection 默认会 ensureCursorVisible（codemirror.js:5195）把行顶到视口边缘，
  // 之后 scrollIntoView 判定「已可见」便不再动作，锚定彻底失效。
  const calls = wsrc.match(/cm\.setSelection\([\s\S]{0,200}?\}\)/g) || [];
  assert.ok(calls.length >= 2, `遮罩 mousedown 应有两处 setSelection（表格/普通），实得 ${calls.length}`);
  for (const c of calls) {
    assert.match(c, /scroll: false/, 'setSelection 未关闭自动滚动（滚动权必须独占在锚定手里）');
    assert.match(c, /origin: '\*mouse'/, 'setSelection 未标注鼠标来源');
  }
  // 不得再用会触发自动滚动的 setCursor
  const md = mousedownBlock(wsrc);
  assert.ok(!/cm\.setCursor\(/.test(md), 'mousedown 内仍用 setCursor（会 ensureCursorVisible）');
});

test('锚定须在 setSelection 返回后执行（operation 内滚动会被 pending 冲掉）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // _applyWysiwygClickAnchor：mousedown 内 setSelection/focus 之后调用
  assert.match(wsrc, /_applyWysiwygClickAnchor\(\) \{/, '缺少 _applyWysiwygClickAnchor');
  const md = mousedownBlock(wsrc);
  const seq = md.match(/cm\.focus\(\);\s*\n?\s*self\._applyWysiwygClickAnchor\(\);/g) || [];
  assert.ok(seq.length >= 2, `两处点击分支都须在 focus 后锚定，实得 ${seq.length}`);
  // _restoreWysiwygAnchor 被 cursorActivity（operation 内）调起，只清锚点量、不做滚动
  const rIdx = wsrc.indexOf('    _restoreWysiwygAnchor() {');
  const rblk = wsrc.slice(rIdx, rIdx + 700);
  assert.match(rblk, /if \(this\._wysiwygClickAnchor\) \{ this\._wysiwygAnchorY = null; return; \}/,
    '_restoreWysiwygAnchor 仍在 operation 内滚动（会被 CM pending 机制冲掉）');
  // 锚定用 scrollIntoView（走 CM 内部行模型），不用 scrollTo（DOM 未更新会被 clamp）
  const aIdx = wsrc.indexOf('_applyWysiwygClickAnchor() {');
  const ablk = wsrc.slice(aIdx, aIdx + 900);
  assert.match(ablk, /cm\.scrollIntoView\(pos,/, '锚定未用 scrollIntoView');
  assert.ok(!/cm\.scrollTo\(/.test(ablk), '锚定不应使用 scrollTo（refresh 后 DOM 高度未落定会被 clamp）');
});

test('活动块未变时也要消费点击锚点（残留会污染后续光标移动）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const sIdx = wsrc.indexOf('    setWysiwygActiveBlock(idx) {');
  const sblk = wsrc.slice(sIdx, sIdx + 700);
  assert.match(sblk, /if \(prev === idx\)/, '缺少同块短路分支');
  assert.match(sblk, /this\._restoreWysiwygAnchor\(\);\s*\n\s*return;/,
    '同块短路时未消费锚点（残留的 click 锚点会让下一次普通光标移动跳到无关位置）');
});

// ---------- 12. 遮罩渲染后处理对齐（真机 demo.md：公式块露 $$ 源码） ----------

test('遮罩须补跑预览后处理（KaTeX 公式 + 代码高亮 + 复选框解禁）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /_postProcessWysiwygNode\(node\)/, 'maskWysiwygBlock 未调用后处理');
  // renderMarkdown 只产出结构 HTML，KaTeX/highlight 是预览端独立 pass（preview-controller 207/217）
  const pIdx = wsrc.indexOf('_postProcessWysiwygNode(node) {');
  const pblk = wsrc.slice(pIdx, pIdx + 1300);
  assert.match(pblk, /PreviewPost\.processMath\(node\)/, '未补跑公式渲染（遮罩里会露原始 $$ 源码）');
  assert.match(pblk, /CodeBlock\.processCodeBlocks\(node/, '未补跑代码高亮（遮罩里代码无高亮）');
  // lineNumbers 跟随设置，与阅读模式一致
  assert.match(pblk, /settings\.codeLineNumbers/, '代码行号未跟随 settings.codeLineNumbers');
  // remark-gfm 输出 disabled 复选框，渲染后须解禁（否则渲染态点不动）
  assert.match(pblk, /removeAttribute\('disabled'\)/, '复选框未解禁');
  // 后处理要在 innerHTML 赋值之后、markText 之前对节点执行
  const mIdx = wsrc.indexOf('node.innerHTML = html;');
  const seg = wsrc.slice(mIdx, mIdx + 300);
  assert.match(seg, /_postProcessWysiwygNode\(node\)/, '后处理未紧跟 innerHTML 赋值');
});

// ---------- 13. 虚拟模式滚动锚定（真机：滚动/点击视口内容被冲走） ----------

test('视口遮罩更新须做滚动锚定，恢复性滚动不得再触发 scroll 钩子', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const uIdx = wsrc.indexOf('updateWysiwygViewportMasks() {');
  const ublk = wsrc.slice(uIdx, wsrc.indexOf('_ensureWysiwygScrollHook()', uIdx));
  // 更新前采锚（虚拟模式才需要；小文档窗口=全文，遮罩集合不变）
  assert.match(ublk, /if \(this\._wysiwygVirtual\) \{[\s\S]{0,400}coordsChar/, '未在更新前采集视口顶行锚点');
  // 迭代收敛补偿：单次 scrollTo 会被 CM 高度重算时序部分 clamp
  assert.match(ublk, /for \(let i = 0; i < 4; i\+\+\)/, '未做迭代收敛补偿（单次 scrollTo 会残留漂移）');
  assert.match(ublk, /_wysiwygAnchorRestoring = true/, '恢复性滚动未加标志位');
  // scroll 钩子须跳过恢复性滚动，否则锚定 → scroll → 更新 → 再锚定死循环
  const hIdx = wsrc.indexOf("_ensureWysiwygScrollHook() {");
  const hblk = wsrc.slice(hIdx, hIdx + 600);
  assert.match(hblk, /if \(self\._wysiwygAnchorRestoring\) return;/, 'scroll 钩子未跳过恢复性滚动（会死循环）');
});
