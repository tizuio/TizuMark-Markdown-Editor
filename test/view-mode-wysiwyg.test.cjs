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
  // 与阅读模式完全一致（2026-10-08 用户要求）：早期「淡色块标识」灰底（color-mix --bg-secondary）
  // 让整页呈灰条观感、与阅读模式肉眼可辨，已改为透明底；渲染态与源码态靠字体差异区分
  assert.match(css, /wysiwyg-block-mask\.preview-content[\s\S]{0,900}background: transparent;/,
    '遮罩应为透明底（与阅读模式一致，不得再有块级底色）');
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
  }
  // 鼠标来源标注只约束 mousedown 分支（另有 #锚点跳转的程序化 setSelection，非鼠标触发）
  const md = mousedownBlock(wsrc);
  const mouseCalls = md.match(/cm\.setSelection\([\s\S]{0,200}?\}\)/g) || [];
  assert.ok(mouseCalls.length >= 2, `mousedown 内应有两处 setSelection（表格/普通），实得 ${mouseCalls.length}`);
  for (const c of mouseCalls) {
    assert.match(c, /origin: '\*mouse'/, 'mousedown 内 setSelection 未标注鼠标来源');
  }
  // 不得再用会触发自动滚动的 setCursor
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

test('遮罩须补跑预览后处理（与阅读模式 render() 同序全链）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /_postProcessWysiwygNode\(node\)/, 'maskWysiwygBlock 未调用后处理');
  // renderMarkdown 只产出结构 HTML，各 pass 都是预览端独立步骤（preview-controller render()），
  // 遮罩里须逐一补跑（同步 pass 在 _postProcessWysiwygNode，异步 pass 在 _wysiwygPostProcessAsync）
  const pIdx = wsrc.indexOf('_postProcessWysiwygNode(node) {');
  const pblk = wsrc.slice(pIdx, pIdx + 4000);
  assert.match(pblk, /PreviewPost\.processEmojiShortcodes\(node\)/, '未补跑 emoji 还原（遮罩里露 :rocket: 短码）');
  assert.match(pblk, /PreviewPost\.processMath\(node\)/, '未补跑公式渲染（遮罩里会露原始 $$ 源码）');
  assert.match(pblk, /PreviewPost\.processAbbreviations\(node, postOpts\)/, '未补跑缩写还原');
  assert.match(pblk, /PreviewPost\.processHeadings\(node, postOpts\)/, '未补跑标题锚点 id（#链接跳转失效）');
  assert.match(pblk, /PreviewPost\.addCopyButtons\(node, postOpts\)/, '未补跑代码块复制按钮');
  assert.match(pblk, /CodeBlock\.processCodeBlocks\(node/, '未补跑代码高亮（遮罩里代码无高亮）');
  // 代码行号与阅读模式同源：看 #preview 的 code-line-numbers 类（同一设置写入，
  // preview-controller:220 同款判据）
  assert.match(pblk, /preview\.classList\.contains\('code-line-numbers'\)/, '代码行号未与阅读模式同源');
  // remark-gfm 输出 disabled 复选框，渲染后须解禁（否则渲染态点不动）
  assert.match(pblk, /removeAttribute\('disabled'\)/, '复选框未解禁');
  // 后处理要在 innerHTML 赋值之后、markText 之前对节点执行
  const mIdx = wsrc.indexOf('node.innerHTML = html;');
  const seg = wsrc.slice(mIdx, mIdx + 300);
  assert.match(seg, /_postProcessWysiwygNode\(node\)/, '后处理未紧跟 innerHTML 赋值');
});

test('遮罩异步 pass（图片/Mermaid/TOC）与排版同步、行号隐藏、锚点跳转齐备', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 异步 pass：挂遮罩后触发，代数（_wysiwygMaskGen）防旧请求写脏重建后的 DOM
  assert.match(wsrc, /_wysiwygPostProcessAsync\(node, idx\)/, 'maskWysiwygBlock 未触发异步 pass');
  assert.match(wsrc, /ImageProcessor\.processImages\(node/, '未补跑图片本地解析（相对路径图片不显示）');
  assert.match(wsrc, /processMermaid\(node, postOpts\)/, '未补跑 Mermaid 渲染（遮罩里露源码）');
  assert.match(wsrc, /_wysiwygReplaceToc\(node\)/, '未补跑 [TOC] 目录替换');
  assert.match(wsrc, /_wysiwygMaskGen = \(this\._wysiwygMaskGen \|\| 0\) \+ 1/, '缺代数递增（遮罩重建后旧异步会写脏 DOM）');
  // 排版同步：阅读模式的字号/行高/字体是 #preview 的内联样式，遮罩必须复制计算值
  assert.match(wsrc, /_wysiwygMaskTypography\(node\)/, 'maskWysiwygBlock 未同步排版');
  assert.match(wsrc, /getComputedStyle\(this\.preview\)/, '排版同步未读 #preview 计算值');
  // 行号：所见即所得下强制隐藏，离开按设置恢复
  assert.match(wsrc, /applyWysiwygEditorChrome\(\) \{/, '缺少编辑器外壳同步方法');
  assert.match(wsrc, /cm\.setOption\('lineNumbers', on \? false :/, '行号未在所见即所得下隐藏');
  assert.match(wsrc, /this\.applyWysiwygEditorChrome\(\);\n    \},\n  \};/, 'clearWysiwygMasks 未恢复编辑器外壳');
  // #锚点跳转（wysiwyg 下 TOC/交叉引用点击须定位到源码行）
  assert.match(wsrc, /_wysiwygScrollToAnchor\(id\) \{/, '缺少锚点跳转方法');
  assert.match(wsrc, /_wysiwygScrollLineToCenter\(line\);/, '锚点跳转未把目标行滚到视口中部');
  // 链接分派与阅读模式共用
  const musrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'misc-ui.js'), 'utf8');
  assert.match(musrc, /async handlePreviewLinkClick\(link\) \{/, '缺少链接统一分派方法');
  assert.match(musrc, /this\.viewMode === 'wysiwyg'/, '链接分派未区分所见即所得的锚点行为');
  // 设置变更不得把行号改回（applySettings 走外壳同步入口）
  const ssrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'settings.js'), 'utf8');
  assert.match(ssrc, /if \(this\.applyWysiwygEditorChrome\) this\.applyWysiwygEditorChrome\(\);/,
    'applySettings 未走所见即所得外壳同步（设置变更会把行号改回）');
});

// ---------- 13. 虚拟模式滚动锚定（真机：滚动/点击视口内容被冲走） ----------

test('视口遮罩更新须做滚动锚定，恢复性滚动不得再触发 scroll 钩子', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const uIdx = wsrc.indexOf('updateWysiwygViewportMasks() {');
  const ublk = wsrc.slice(uIdx, wsrc.indexOf('_ensureWysiwygScrollHook()', uIdx));
  // 更新前采锚（虚拟模式才需要；小文档窗口=全文，遮罩集合不变）
  assert.match(ublk, /if \(this\._wysiwygVirtual\) \{[\s\S]{0,400}coordsChar/, '未在更新前采集视口顶行锚点');
  // 迭代收敛补偿：单次 scrollTo 会被 CM 高度重算时序部分 clamp；
  // 循环次数为调优参数（6 轮给远距一次性跳转的结构级位移留收敛余量），不锁死具体值
  assert.match(ublk, /for \(let i = 0; i < \d+; i\+\+\)[\s\S]{0,80}charCoords\(\{ line: anchor\.line/, '未做迭代收敛补偿（单次 scrollTo 会残留漂移）');
  assert.match(ublk, /_wysiwygAnchorRestoring = true/, '恢复性滚动未加标志位');
  // scroll 钩子须跳过恢复性滚动，否则锚定 → scroll → 更新 → 再锚定死循环
  const hIdx = wsrc.indexOf("_ensureWysiwygScrollHook() {");
  const hblk = wsrc.slice(hIdx, hIdx + 600);
  assert.match(hblk, /if \(self\._wysiwygAnchorRestoring\) return;/, 'scroll 钩子未跳过恢复性滚动（会死循环）');
});

// ---------- 14. 全量预渲染 + 全量视图驻留（2026-10-09：快速滚动源码闪现/落点漂移） ----------

test('行数 ≤ 10000 走全量预渲染：上限常量 + 预计算 + 前台兜底', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /WYSIWYG_FULL_RENDER_MAX_LINES = 10000;/, '缺少全量渲染行数上限（10000）');
  // 全量块表：maxBlocks:Infinity（一块不跳）+ 回退切块器
  assert.match(wsrc, /precomputeWysiwygBlocksFull\(\) \{/, '缺少全量预计算入口');
  assert.match(wsrc, /maxBlocks: Infinity/, '全量预计算未用 maxBlocks:Infinity（会跳块）');
  // renderWysiwygMasks：按行数定全量/虚拟，全量时走 _enterWysiwygFullView
  assert.match(wsrc, /const full = cm\.lineCount\(\) <= WYSIWYG_FULL_RENDER_MAX_LINES;/, '未按行数决定全量模式');
  assert.match(wsrc, /this\._wysiwygFull = full;/, '未记录全量模式标志');
  assert.match(wsrc, /if \(full\) \{[\s\S]{0,60}?this\._enterWysiwygFullView\(\);/, '全量模式未走全量视图驻留');
  // 全量预渲染期间源文变化须作废预渲染结果
  assert.match(wsrc, /cm\.getValue\(\) === preValue/, '预渲染结果未校验源文未变（期间编辑会挂旧块表）');
});

test('全量视图驻留：直接写 cm.options 扩视口（避开 setOption 的内置 refresh），离开时恢复', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ⚠️ 必须直接写 cm.options：setOption('viewportMargin') 的选项处理器自带 cm.refresh()，
  // 会多一次全量重渲染（万行文档 ~1.8s，2026-10-09 实测）
  assert.match(wsrc, /cm\.options\.viewportMargin = cm\.lineCount\(\) \+ 100;/, '全量视图驻留未扩视口到整篇');
  assert.doesNotMatch(wsrc, /setOption\('viewportMargin', cm\.lineCount/, '扩视口走了 setOption（触发内置 refresh，多一次全量重渲染）');
  // 单 operation 批量挂全部非活动块遮罩
  const eIdx = wsrc.indexOf('_enterWysiwygFullView() {');
  const eblk = wsrc.slice(eIdx, eIdx + 800);
  assert.match(eblk, /cm\.operation\(\(\) => \{/, '全量挂遮罩未用单 operation 批量（逐块=数千次 display 更新）');
  // 离开所见即所得恢复默认视口余量
  const cIdx = wsrc.indexOf('clearWysiwygMasks() {');
  const cblk = wsrc.slice(cIdx, cIdx + 1700);
  assert.match(cblk, /setOption\('viewportMargin', 10\)/, '离开全量模式未恢复默认视口余量');
  assert.match(cblk, /this\._wysiwygFull = false;/, '离开未复位全量标志');
});

test('setViewMode 拦截走后台预渲染：按钮「渲染中」，完成后才切视图', () => {
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  // setViewMode 在同步切换流程之前拦截 wysiwyg
  assert.match(themeSrc, /if \(mode === 'wysiwyg'\) \{[\s\S]{0,300}?beginWysiwygPreRender/, 'setViewMode 未拦截所见即所得走预渲染');
  assert.match(themeSrc, /this\._cancelWysiwygPreRender\(\); \/\/ 用户抢先切到别的模式：取消预渲染/, '切到别的模式未取消在飞预渲染');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 预渲染入口：行数超限/空文档不启动（返回 false 走同步流程）
  assert.match(wsrc, /beginWysiwygPreRender\(\) \{/, '缺少预渲染入口');
  assert.match(wsrc, /if \(cm\.lineCount\(\) > WYSIWYG_FULL_RENDER_MAX_LINES\) return false;/, '超限行数未退回同步流程');
  // 让出一帧再跑昂贵步骤（wysiwyg.js 禁 rAF），完成前校验标签/模式未变
  const bIdx = wsrc.indexOf('beginWysiwygPreRender() {');
  const bblk = wsrc.slice(bIdx, bIdx + 4000);
  assert.match(bblk, /setTimeout\(/, '预渲染未让出主线程（首帧 spinner 画不出来）');
  assert.match(bblk, /self\.activeTab !== self\._wysiwygPreRenderTab || self\.viewMode !== self\._wysiwygPreRenderMode/, '预渲染完成未校验标签/模式未变（期间切走会错切视图）');
  assert.match(bblk, /self\.viewMode = 'wysiwyg';/, '预渲染完成后未执行模式切换');
  assert.match(bblk, /self\.applyViewMode\(\);/, '预渲染完成后未 applyViewMode（遮罩由 50ms 计时器消费预渲染块表）');
  // 预渲染结果在 applyViewMode 之后写入（其内部 clearWysiwygMasks 会清掉未消费结果）
  assert.match(bblk, /self\.applyViewMode\(\);[\s\S]{0,200}?self\._wysiwygPreRenderedBlocks = blocks;/, '预渲染块表未在 applyViewMode 之后落位（会被内部清理吃掉）');
  // 取消路径：代数递增 + 清定时器 + 按钮还原
  assert.match(wsrc, /_cancelWysiwygPreRender\(\) \{/, '缺少预渲染取消方法');
  assert.match(wsrc, /clearTimeout\(this\._wysiwygPreRenderTimer\)/, '取消未清预渲染定时器');
  // 按钮「渲染中」指示（类 + 文案）
  assert.match(wsrc, /_setWysiwygButtonRendering\(on\) \{/, '缺少按钮渲染中指示方法');
  assert.match(wsrc, /btn\.classList\.toggle\('wysiwyg-rendering', !!on\)/, '未切换 wysiwyg-rendering 类');
  assert.match(wsrc, /t\('viewModeWysiwygRendering'\)/, '按钮文案未走 i18n');
});

test('切标签取消在飞预渲染（它面向旧标签，不能在新标签上切视图）', () => {
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const sIdx = themeSrc.indexOf('syncViewModeToTab() {');
  assert.ok(sIdx > 0, '缺少 syncViewModeToTab');
  assert.match(themeSrc.slice(sIdx, sIdx + 400), /if \(this\._wysiwygPreRendering\) this\._cancelWysiwygPreRender\(\);/,
    '切标签未取消在飞预渲染（会在新标签上错切视图 + 按钮残留「渲染中」）');
});

test('全量模式增量刷新：只重切边界 + 仅重挂源文变化的块（输入停顿不卡）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // refreshWysiwygBlocks 的全量快速路径
  assert.match(wsrc, /if \(self\._wysiwygFull\) \{\n          self\._refreshWysiwygFullIncremental\(\);/,
    '防抖刷新未走全量增量路径（万行文档每次停顿全量重挂会卡数秒）');
  const fIdx = wsrc.indexOf('_refreshWysiwygFullIncremental() {');
  assert.ok(fIdx > 0, '缺少全量增量刷新方法');
  const fblk = wsrc.slice(fIdx, fIdx + 2500);
  // 只切边界不渲染 html（skipHtml）
  assert.match(fblk, /this\.computeWysiwygBlocks\(true\)/, '增量刷新未按仅解析模式重切块');
  // 源文本同一性匹配：未变块保留旧 marker（CM 标记自动跟随文本）
  assert.match(fblk, /b\.src = this\._wysiwygBlockSource\(b\);/, '增量刷新未计算块源文本键');
  assert.match(fblk, /nb\.html = \(ob\.html !== undefined\) \? ob\.html : nb\.html;/, '未变块未复用缓存 html');
  assert.match(fblk, /data-block-index/, '块索引位移未同步遮罩节点块号（点击映射会落错块）');
  // 变化块在单 operation 内重挂
  assert.match(fblk, /cm\.operation\(\(\) => \{/, '增量刷新重挂未用单 operation 批量');
  assert.match(fblk, /this\.maskWysiwygBlock\(k\);/, '未重挂变化的块');
  // 渲染器支持 skipHtml（只切边界）
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  assert.match(rsrc, /options\.skipHtml/, 'renderMarkdownBlocks 缺 skipHtml 选项');
});

test('旧块重渲后同步源文本键（否则增量刷新误判「源未变」保留旧遮罩）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /b\.src = this\._wysiwygBlockSource\(b\); \}/, 'setWysiwygActiveBlock 重渲旧块后未同步源文本键');
});

test('虚拟模式（>10000 行）增强预取：沿滚动方向加大遮罩窗口', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /WYSIWYG_PREFETCH_MARGIN = 200;/, '缺少虚拟模式增强预取边距');
  const uIdx = wsrc.indexOf('updateWysiwygViewportMasks() {');
  const ublk = wsrc.slice(uIdx, wsrc.indexOf('_ensureWysiwygScrollHook()', uIdx));
  assert.match(ublk, /this\._wysiwygLastScrollTop/, '未记录上次滚动位置（方向预取无从谈起）');
  assert.match(ublk, /top > this\._wysiwygLastScrollTop/, '未识别向下滚动方向');
  assert.match(ublk, /WYSIWYG_PREFETCH_MARGIN \* 2/, '滚动方向未加倍预取');
});

test('批量 DOM：空行挂类 / 撤遮罩均单 operation（万行文档不进出不卡）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 空行 diff 挂类单 operation
  const blIdx = wsrc.indexOf('updateWysiwygBlankLines() {');
  const blblk = wsrc.slice(blIdx, blIdx + 1200);
  assert.match(blblk, /cm\.operation\(\(\) => \{/, '空行挂类未用单 operation 批量（数千空行=数千次 display 更新）');
  // 视口遮罩挂/撤单 operation
  const uIdx = wsrc.indexOf('updateWysiwygViewportMasks() {');
  const ublk = wsrc.slice(uIdx, wsrc.indexOf('_ensureWysiwygScrollHook()', uIdx));
  assert.match(ublk, /cm\.operation\(\(\) => \{\n        \/\/ 撤掉窗外遮罩/, '视口遮罩挂/撤未用单 operation 批量');
});

test('渲染中指示：CSS spinner + 三语言 i18n key', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.view-mode-tab\.wysiwyg-rendering \.icon \{\s*display: none;\s*\}/, '渲染中未隐藏原图标');
  assert.match(css, /\.view-mode-tab\.wysiwyg-rendering::before \{/, '缺少渲染中 spinner 伪元素');
  assert.match(css, /wysiwyg-rendering::before[\s\S]{0,300}animation: wysiwyg-mode-spin/, 'spinner 未接旋转动画');
  assert.match(css, /@keyframes wysiwyg-mode-spin/, '缺少旋转关键帧');
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  const zh = i18n.indexOf("viewModeWysiwyg: '所见即所得'");
  const en = i18n.indexOf("viewModeWysiwyg: 'WYSIWYG'");
  const es = i18n.indexOf("viewModeWysiwyg: 'WYSIWYG'", en + 10);
  for (const [name, idx] of [['zh', zh], ['en', en], ['es', es]]) {
    assert.ok(idx > 0, '未找到 ' + name + ' 的 viewModeWysiwyg');
    assert.match(i18n.slice(idx, idx + 200), /viewModeWysiwygRendering: '[^']+'/, name + ' 缺 viewModeWysiwygRendering 文案');
  }
});
