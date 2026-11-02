// 阶段1 回归测试：三模式（阅读 / 源码 / 实时预览）骨架。
//
// 覆盖本次改动的行为契约：
//   1. 顶部三钮存在且文案为新名（阅读 / 源码 / 实时预览），data-mode 正确；
//   2. setViewMode 支持第三模式：切到 wysiwyg 写 viewMode、加 wysiwyg-mode 类、按钮 active；
//   3. Ctrl+\（toggleViewMode）三模式循环 阅读→源码→实时预览→阅读；
//   4. 类型守卫：非 Markdown（图片/明文）切实时预览被拦截并提示，不改状态；
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

test('顶部视图模式为三钮，且文案已重命名为 阅读/源码/实时预览', () => {
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
  // 2026-07-13：实时预览标注（beta）测试功能
  assert.match(block, />\s*实时预览（beta）\s*<\/span>/);

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

test('实时预览仅对 Markdown 开放：非 md 被 setViewMode 守卫拦截', () => {
  assert.match(
    bundle,
    /if \(_kind !== 'markdown' && mode === 'wysiwyg'\) \{[^}]*showToast[^}]*return;/s,
    '缺少「非 Markdown 不得切实时预览」的守卫'
  );
});

// ---------- 3. Ctrl+\ 三模式循环 ----------

test('toggleViewMode 为三模式循环（阅读→源码→实时预览→阅读）', () => {
  // 旧的二态实现必须已消失
  assert.doesNotMatch(
    bundle,
    /setViewMode\(this\.viewMode === 'preview' \? 'edit' : 'preview'\)/,
    'toggleViewMode 仍是旧的二态切换'
  );
  const m = bundle.match(/toggleViewMode\(\)\s*\{([\s\S]*?)\n\s{6}\},/);
  assert.ok(m, '未找到 toggleViewMode 实现');
  assert.match(m[1], /const order = \['preview',\s*'edit',\s*'wysiwyg'\]/, '循环顺序不是 阅读→源码→实时预览');
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
  // 所见即所得块间独立空行保持塌缩（2026-10-17）：不显示提示，
  // 否则点击行缝会出现「输入 / 可插入内容…」提示行 = 用户看到的「新行」。
  // 判据 = 光标行块归属现查（-1 = 块外独立空行），不得用 _wysiwygBlankLines 集合成员
  //（集合随 250ms 防抖刷新，光标刚移入块内空行时成员判定会误抑制提示）
  assert.match(bundle, /this\.wysiwygBlockIndexAt\(cur\.line\) < 0\)/,
    'WYSIWYG 块间空行未抑制空行提示（点击行缝会「出现新行」）');
  assert.doesNotMatch(bundle, /this\._wysiwygBlankLines\s*&&\s*\n?\s*this\._wysiwygBlankLines\.has\(cur\.line\)/,
    '空行提示守卫不得用 _wysiwygBlankLines 集合成员判定（滞后于光标同步，误抑制块内空行提示）');
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

test('设置「默认视图」下拉新增实时预览选项', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'settings.js'), 'utf8');
  const start = settings.indexOf('_selects.defaultView = new Select');
  assert.ok(start > 0, '未找到默认视图 Select');
  const block = settings.slice(start, start + 600);
  assert.match(block, /value: 'wysiwyg'/, '默认视图下拉缺少「实时预览」选项');
  // 选项文案改用新模式名
  assert.match(block, /t\('viewModeRead'\)/, '默认视图选项文案未用 viewModeRead');
  assert.match(block, /t\('viewModeSource'\)/, '默认视图选项文案未用 viewModeSource');
  assert.match(block, /t\('viewModeWysiwyg'\)/, '默认视图选项文案未用 viewModeWysiwyg');
});

// ---------- 6. 未保存保护 ----------

test('beforeunload 拦截未保存内容（防实时预览下静默丢失）', () => {
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
  for (const prop of ['overflow: visible', 'display: flow-root', 'white-space: normal']) {
    assert.ok(css.indexOf(prop) >= 0, '覆盖规则缺少 ' + prop);
  }
  // ⚠️ white-space:normal 是关键：CM 行是 pre，遮罩继承会把渲染 HTML 里标签间的
  //    换行符全显示为真实换行（列表序号单独成行、块内大空隙）——2026-10-07 真机定位
  assert.match(css, /wysiwyg-block-mask\.preview-content[\s\S]{0,1400}white-space: normal;/,
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
  // hadPrev/hadIdx 标志同时是锚点补偿的条件（2026-10-18：幻影切换不做补偿，见专项测试）
  assert.match(wsrc, /const hadPrev = prev >= 0;[\s\S]{0,120}?if \(hadPrev\) \{[\s\S]{0,500}?this\.maskWysiwygBlock\(prev\);/, '未恢复旧块遮罩');
  // 旧块在活动期间被编辑过，缓存 html 已过期，恢复遮罩前必须重渲染
  assert.match(wsrc, /b\.html = this\.renderWysiwygBlockHtml\(b\.start, b\.end\);/,
    '旧块恢复遮罩前未按最新源码重渲染（会把编辑前的旧内容盖回去）');
  assert.match(wsrc, /this\.unmaskWysiwygBlock\(idx\);/, '未撤掉新活动块遮罩');
  const setIdx = wsrc.indexOf('setWysiwygActiveBlock(idx) {');
  assert.ok(setIdx > 0, '未找到 setWysiwygActiveBlock');
  assert.doesNotMatch(wsrc.slice(setIdx, setIdx + 400), /clearWysiwygMasks/,
    'setWysiwygActiveBlock 内部不得全量重建（每次跨块都会整篇重排）');
});

test('块高抖动补偿：document 空间差值回滚（禁 rAF；operation 内延迟至 operation 末）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // document 空间（'local'，滚动无关）测量：前后差值 = 纯结构位移；window 坐标会把 CM 自己
  // operation 末的原生滚动混进差值 → 双重补偿
  assert.match(wsrc, /cm\.cursorCoords\(null, 'local'\)/, '光标锚点未用 document 空间测量（window 坐标基准随滚动漂移）');
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
  // 窗口含开头的「标题活动行装饰清理」块（2026-10-14），需放宽到 mark 遍历之后；
  // 2026-10-17 QA 审查又在函数头新增光标行状态复位块（~430 字符），1200→1600
  const blk = wsrc.slice(cIdx, cIdx + 1600);
  assert.match(blk, /Array\.from\(this\._wysiwygMarks\.values\(\)\)/, '未遍历清理 mark');
  assert.match(blk, /mark\.clear\(\)/, '未 clear mark（会泄漏）');
  assert.match(blk, /clearTimeout\(this\._wysiwygMaskTimer\)/, '未清理防抖定时器');
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const avIdx = themeSrc.indexOf('applyViewMode()');
  assert.ok(avIdx > 0, '未找到 applyViewMode');
  assert.match(themeSrc.slice(avIdx, avIdx + 4000), /this\.clearWysiwygMasks\(\)/, 'applyViewMode 未清理遮罩');
});

test('实时预览独占编辑区：预览栏隐藏（与阅读/源码区分）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.editor-container\.wysiwyg-mode \.preview-pane \{ display: none; \}/,
    '实时预览下预览栏应隐藏（否则与阅读模式无异）');
  assert.match(css, /\.editor-container\.wysiwyg-mode \.editor-pane \{ flex: 1 1 100%/,
    '实时预览下编辑区应占满宽度');
});
// ---------- 8. 模式名回归护栏（曾被 i18n 覆盖回「预览/编辑」） ----------

test('模式名由 i18n 统一提供：阅读/源码/实时预览（三钮全覆盖）', () => {
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

test('空行塌缩：updateWysiwygBlankLines 存在且增量挂类；光标空行全高（两级语义 2026-10-17，2026-10-21 修订：光标行块内/块间同口径）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  for (const m of ['updateWysiwygBlankLines', '_setWysiwygBlankClass', '_isWysiwygBlankLine',
    '_updateWysiwygBlankGap', '_wysiwygBlockMargins']) {
    assert.match(wsrc, new RegExp(m + '\\s*\\('), '缺少方法 ' + m);
  }
  // 必须走 diff 增量（prev/next 集合比对），不得每次全量 addLineClass
  assert.match(wsrc, /const prev = this\._wysiwygBlankLines;/, '未做增量 diff');
  assert.match(wsrc, /if \(!next\.has\(i\)\) this\._setWysiwygBlankClass\(i, false\);/, '未摘除失效行');
  assert.match(wsrc, /if \(!prev\.has\(i\)\) this\._setWysiwygBlankClass\(i, true\);/, '未挂新增行');
  // 两级语义（2026-10-21 修订）：光标所在空行（块内或块间）例外恢复全高——光标与
  // 光标行灰底指示需要可见（2026-10-21 用户报：图片上方回车新增的块间空行没有灰色
  // 明确指示当前编辑行）；无光标的块间独立空行保持塌缩——点击行缝不出现「新行」，
  // 回车才出新行（2026-10-17）
  assert.match(wsrc, /if \(i === curLine\) continue; \/\/ 光标所在空行：例外，恢复全高（块内\/块间同口径）/,
    '未排除光标所在空行（块间空行光标行被塌缩 0px → 无灰底指示、光标坐标退化）');
  assert.match(wsrc, /const lineBlockIdx = this\.wysiwygBlockIndexAt\(line\);/, 'cursorActivity 缺光标行块归属判定');
  assert.match(wsrc, /if \(this\._isWysiwygBlankLine\(line\)\) \{/, '光标所在空行应恢复全高（块内/块间同口径）');
  assert.match(wsrc, /_setWysiwygBlankClass\(line, false\)/, '光标进入块内空行未恢复全高');
  // 2026-10-20：进入/离开光标空行必须同步 inline 间隙高度（gap 表只在输入防抖重算，
  // 纯光标移动不重跑 updateWysiwygBlankLines——只摘类不摘 inline，光标会落进 0px 行不可见；
  // 离开时再按 gap 表恢复块内列表 0px / 块间 Xpx）
  assert.match(wsrc, /this\._applyWysiwygBlankGapEl\(this\._wysiwygLinePreOf\(line\), null\);/,
    '光标进入块内空行未清除 inline 间隙高度（光标落进 0px 行不可见）');
  assert.match(wsrc, /this\._applyWysiwygBlankGapEl\(this\._wysiwygLinePreOf\(prevCur\), ph \? m\.get\(ph\) : undefined\);/,
    '光标离开块内空行未按间隙表恢复 inline 高度');
  // 块间间隙高度对齐阅读模式：X = max(0, 下块 mt − 上块 mb)，逐行经 renderLine 落
  // inline line-height（覆盖 12px 类默认），margin 值与 .preview-content 一致
  assert.match(wsrc, /Math\.max\(0, nextMt - prevMb\)/, '间隙高度未取 margin 折叠差（与阅读模式不一致）');
  assert.match(wsrc, /cm\.on\('renderLine', this\._wysiwygBlankGapHandler\)/, '间隙高度未走 renderLine 落到行 DOM');
  assert.match(wsrc, /if \(tag === 'ul' \|\| tag === 'ol'\) return \[0, 14\];/, '列表 margin 未与阅读模式对齐');
  assert.match(wsrc, /if \(\/\^h\[1-6\]\$\/\.test\(tag\)\) return \[24, 12\];/, '标题 margin 未与阅读模式对齐');
  // 生命周期：清理时须撤掉全部塌缩类（窗口含开头的标题装饰清理块，2026-10-14）；
  // 块间空行间隙 inline 样式同批撤（2026-10-17）
  const cIdx = wsrc.indexOf('clearWysiwygMasks() {');
  const blk = wsrc.slice(cIdx, cIdx + 2400);
  assert.match(blk, /for \(const i of this\._wysiwygBlankLines\) this\._setWysiwygBlankClass\(i, false\);/,
    '清理未撤空行塌缩类（离开模式后空行仍是塌缩态）');
  assert.match(blk, /this\._wysiwygBlankGap\)/, '清理未撤块间空行间隙高度');
  assert.match(wsrc, /cm\.off\('renderLine', this\._wysiwygBlankGapHandler\)/, '离开模式未解绑 renderLine 钩子');
  // 两处调用：全量重建后 + 防抖补齐后
  // 全量重建收尾：refresh 后必须先冲刷异步 pass（TOC/图片/图表首帧就绪），再更新空行塌缩
  //（缩进不定：renderWysiwygMasks 主体包在 try 内，行首空格数随重构变化）
  assert.match(wsrc, /cm\.refresh\(\); \} catch \(_\) \{ \/\* ignore \*\/ \}\n(?:[^\n]*\n)*?\s*this\.flushWysiwygAsyncPasses\(\);\n\s*this\.updateWysiwygBlankLines\(\);/,
    '全量重建后未冲刷异步 pass / 未更新空行塌缩');
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

// ---------- 9b. 用户三问（2026-10-20 真机截图）：普通 ul 固定画圆 + 块内列表空行 0 ----------

test('块内列表空行活动态取 0（任务列表+下方 ul 合并块激活不再多一行空白）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const gIdx = wsrc.indexOf('_updateWysiwygBlankGap() {');
  assert.ok(gIdx >= 0, '缺少 _updateWysiwygBlankGap');
  const gBlk = wsrc.slice(gIdx, gIdx + 2600);
  assert.match(gBlk, /let inner = null;/, '块内空行未识别所属块（旧版仅布尔 inside 后直接 continue）');
  assert.match(gBlk, /if \(inner\) \{/, '缺少块内空行分支');
  assert.match(gBlk, /this\._wysiwygBlockTag\(inner\)/, '块内分支未按块型分流');
  assert.match(gBlk, /if \(tag === 'ul' \|\| tag === 'ol'\) \{\s*try \{ map\.set\(cm\.getLineHandle\(i\), 0\); \} catch \(_\) \{ \/\* 行已销毁 \*\/ \}/,
    '块内列表空行未进表取 0（活动态 ul 段上方多一行 12px 空白）');
  // 块型判定收口公共方法，margin 与空行高度共用同一口径
  assert.match(wsrc, /_wysiwygBlockTag\(b\) \{/, '缺少 _wysiwygBlockTag 公共方法');
  const mIdx = wsrc.indexOf('_wysiwygBlockMargins(b) {');
  assert.ok(mIdx >= 0, '缺少 _wysiwygBlockMargins');
  assert.match(wsrc.slice(mIdx, mIdx + 400), /const tag = this\._wysiwygBlockTag\(b\);/, 'margin 未走公共 tag 方法（口径重复）');
});

test('CSS：普通 ul 弃原生 disc 改固定 6px 画圆（与 S48 / WYSIWYG 画圆同位同锚）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // 排除项必须齐全：任务列表 ul（contains-task-list / 内含复选框）走 S48 规则；
  // [TOC] 目录（.toc 内 ul，lib.rs 生成）本就不是列表，挂点会污染目录渲染
  const ulRule = /\.preview-content ul:not\(\.contains-task-list\):not\(:has\(input\[type="checkbox"\]\)\):not\(\.toc ul\) > li \{[\s\S]*?list-style: none;[\s\S]*?position: relative;[\s\S]*?\}/;
  assert.match(css, ulRule, '普通 ul li 未切固定画圆（list-style:none + position:relative + 任务/TOC 排除）');
  assert.match(css, /ul:not\(\.contains-task-list\):not\(:has\(input\[type="checkbox"\]\)\):not\(\.toc ul\) > li::before \{[\s\S]*?left: -18px;/,
    '普通 ul 画圆位置错（li 左缘=ul.x+24，left:-18px 才落 ul.x+6=38–44px 口径）');
  assert.match(css, /ul:not\(\.contains-task-list\):not\(:has\(input\[type="checkbox"\]\)\):not\(\.toc ul\) > li::before \{[\s\S]*?top: calc\(0\.938em - 3px\);[\s\S]*?width: 6px;[\s\S]*?height: 6px;[\s\S]*?border-radius: 50%;[\s\S]*?background: currentColor;/,
    '普通 ul 画圆与 S48/WYSIWYG 非同锚同形（6px 圆 + 0.938em 锚点 + currentColor）');
  // S48 混合列表规则保持（任务 ul 的普通项 left:6px 口径不动）
  assert.match(css, /ul\.contains-task-list > li:not\(\.task-list-item\)::before \{[\s\S]*?left: 6px;/,
    'S48 混合列表画圆规则被破坏');
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

// ---------- 10b. 折叠区块（details/summary）渲染态折叠/展开（2026-10-21 用户反馈） ----------

test('details 折叠：渲染态点 summary 原地折叠/展开（与阅读模式同口径，不回写源码、不撤罩）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // mousedown 识别 summary 点击（2026-10-21 用户反馈「折叠区块在实时预览没法折叠展开」）
  const sIdx = wsrc.indexOf("closest('summary')");
  assert.ok(sIdx > 0, 'mousedown 未识别 summary 点击（折叠块实时预览无法折叠/展开）');
  const seg = wsrc.slice(sIdx, sIdx + 900);
  // 只拦有效 summary（须有 details 祖先）；游离 summary 是普通内容，落下方行映射
  assert.match(seg, /summaryEl\.closest[\s\S]{0,80}'details'/,
    'summary 分支未查 details 祖先（游离 summary 不应被拦截）');
  // 分支放行原生 click 完成 open 切换：不得回写源码、不得撤罩（纯 DOM 瞬态，
  // 与阅读模式同口径——normalizeDetails 每次渲染统一展开，折叠态本就不入源）
  assert.ok(!/replaceRange|setWysiwygActiveBlock/.test(seg.slice(0, seg.indexOf('return;'))),
    'summary 分支回写了源码或撤了遮罩（须纯 DOM 瞬态切换）');
  // 切换后遮罩行盒高度变了但没有 CM 操作 → 必须刷新重测；走 toggle 事件（晚于 click
  // 默认动作）而非 mousedown 时刻的 setTimeout（计时器可能抢在 click 前量到旧高度）
  assert.match(seg, /detEl\.addEventListener\('toggle'[\s\S]{0,200}cm\.refresh\(\);/,
    'details open 切换后遮罩高度变化无 refresh 重测（后续内容行位/滚动区错位）');
  // 顺序须在复选框分支之后：summary 内的复选框先走勾选，不当折叠
  const boxIdx = wsrc.indexOf("closest('input[type=\"checkbox\"]')");
  assert.ok(boxIdx > 0 && sIdx > boxIdx, 'summary 分支未排在复选框分支之后（summary 内复选框会勾错）');
});

test('复选框编辑态可勾选：前缀槽 mousedown 回写源码（回写口径与渲染态收口同一方法）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 共用回写方法（2026-10-18 收口：渲染态/编辑态不得各持一份回写正则）
  assert.match(wsrc, /_wysiwygToggleTaskLine\(lineNo\)/, '缺少 _wysiwygToggleTaskLine');
  assert.ok(wsrc.indexOf('this._wysiwygToggleTaskLine(n) == null) return;') >= 0,
    '渲染态 toggleWysiwygTaskCheckbox 未走共用回写方法（重复口径漂移风险）');
  // 编辑态点击接线（wrapper capture mousedown，与表格点击守卫同模式）
  assert.match(wsrc, /_ensureWysiwygTaskBoxClick\(\) \{/, '缺少 _ensureWysiwygTaskBoxClick');
  assert.match(wsrc, /this\._ensureWysiwygTableClickGuard\(\);\n        this\._ensureWysiwygTaskBoxClick\(\);/,
    '_ensureWysiwygTaskBoxClick 未随模式进入接线');
  assert.ok(wsrc.indexOf("el.closest('.wysiwyg-task-prefix')") >= 0,
    '编辑态点击未识别任务行 24px 前缀槽（::before 框无 DOM，命中目标是槽 span）');
  assert.ok(wsrc.indexOf("el.closest('.wysiwyg-task-box-zero')") >= 0,
    '零宽槽上的点击未放行（= 点正文，不得当勾选）');
  // 列表/dd 行 Backspace·Delete 守卫（2026-10-24：隐藏标记前缀逐字符删 → 多次按键 +
  // 中间态裸露「• []」）。wrapper capture keydown、IME/修饰键放行、空项整行并入上一行、
  // Delete 行尾剥下一行标记后并接。
  assert.match(wsrc, /_ensureWysiwygListKeyGuard\(\) \{/, '缺少 _ensureWysiwygListKeyGuard');
  assert.match(wsrc, /this\._ensureWysiwygTaskBoxClick\(\);\n        this\._ensureWysiwygListKeyGuard\(\);/,
    '_ensureWysiwygListKeyGuard 未随模式进入接线');
  assert.ok(wsrc.indexOf('listMarkerZoneEnd(line)') >= 0 && wsrc.indexOf('function listMarkerZoneEnd(') >= 0,
    '守卫未走共用纯函数 listMarkerZoneEnd（口径须与行装饰同源，禁止散写同义正则）');
  assert.ok(wsrc.indexOf("ev.key !== 'Backspace' && ev.key !== 'Delete'") >= 0,
    '守卫未限定 Backspace/Delete 按键');
  assert.ok(wsrc.indexOf('if (ev.ctrlKey || ev.altKey || ev.metaKey) return;') >= 0,
    '守卫未放行修饰键组合（删词等原生行为）');
  assert.ok(wsrc.indexOf('if (ev.isComposing || self._wysiwygComposing) return;') >= 0,
    '守卫未放行 IME 组合期（同装饰钩子口径）');
  assert.ok(wsrc.indexOf("cm.somethingSelected()") >= 0,
    '守卫未放行有选区的删除（原生删选区）');
  assert.match(wsrc, /if \(L > 0 && isBlank\(content\)\) \{[^]*?cm\.replaceRange\('', \{ line: L - 1, ch: prevLen \}, \{ line: L, ch: line\.length \}, '\+wysiwygListKeyGuard'\)/,
    '空项 Backspace 未整行并入上一行（一次删到上一行）');
  assert.match(wsrc, /cm\.replaceRange\('', \{ line: L, ch: 0 \}, \{ line: L, ch: zoneEnd \}, '\+wysiwygListKeyGuard'\)/,
    '有正文项 Backspace 未一次剥离整个隐藏标记');
  assert.match(wsrc, /cm\.replaceRange\('', \{ line: L, ch: line\.length \}, \{ line: L \+ 1, ch: nzEnd \}, '\+wysiwygListKeyGuard'\)/,
    'Delete 行尾未剥下一行标记后并接（原生会并出「- 甲- 乙」残骸）');
});

// 引用行守卫 + 空白点击守卫 + 空引用行/空有序项光标修复（2026-10-31）
test('引用行 Backspace·Delete 守卫接线 + 字面块放行 + 空白点击守卫（2026-10-31）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // QA 实测引用行首 Backspace 不剥 `>` 反误动下方内容；用户截图空引用行裸露 `> `
  assert.ok(wsrc.indexOf('function quoteMarkerZoneEnd(') >= 0
    && wsrc.indexOf('quoteMarkerZoneEnd(line)') >= 0 && wsrc.indexOf('quoteMarkerZoneEnd(nextLine)') >= 0,
    '引用守卫未走共用纯函数 quoteMarkerZoneEnd（口径须与 stripQuotePrefix 同源，禁止散写同义正则）');
  assert.match(wsrc, /cm\.replaceRange\('', \{ line: L, ch: 0 \}, \{ line: L, ch: qZoneEnd \}, '\+wysiwygQuoteKeyGuard'\)/,
    '引用行 Backspace 未一次剥离整个 `> ` 前缀（退出引用）');
  assert.match(wsrc, /cm\.replaceRange\('', \{ line: L, ch: line\.length \}, \{ line: L \+ 1, ch: nqEnd \}, '\+wysiwygQuoteKeyGuard'\)/,
    'Delete 行尾遇引用行未剥前缀并接（原生会并出「> 甲> 乙」残骸）');
  assert.match(wsrc, /_wysiwygLineInLiteralBlock\(L\)/,
    '键守卫未放行字面块（围栏/缩进代码/HTML/frontmatter 行文里的 `- `/`> ` 是内容不是标记）');
  assert.match(wsrc, /_ensureWysiwygBlankClickGuard\(\) \{/, '缺少 _ensureWysiwygBlankClickGuard');
  assert.match(wsrc, /this\._ensureWysiwygListKeyGuard\(\);\n        this\._ensureWysiwygBlankClickGuard\(\);/,
    '_ensureWysiwygBlankClickGuard 未随模式进入接线');
  // 空引用行 `>` 仍显色（CSS）：blank-cur 类由 syncWysiwygActiveBlock 差分挂/撤，
  // 2026-10-25 用户截图「回车到新一行时，新一行没有 > 了」→ 空引用行与有内容的光标行
  // 同一口径，只显最内层一个 >（此前此处为 transparent，回车后标记凭空消失）。
  assert.ok(wsrc.indexOf('wysiwyg-quote-blank-cur') >= 0, '缺空引用行 blank-cur 类挂/撤逻辑');
  assert.match(css, /wysiwyg-quote-blank-cur span\[class\*="wysiwyg-quote-slot-inner"\] \{[^}]*color: var\(--text-secondary\);/,
    'CSS 缺空引用行 > 显色规则（wysiwyg-quote-blank-cur）：透明会让回车出的空引用行丢掉 >');
  assert.ok(!/wysiwyg-quote-blank-cur span\[class\*="wysiwyg-quote-slot-inner"\] \{[^}]*color: transparent;/.test(css),
    '空引用行 > 不应被置为透明（回归到「回车后新行没有 >」）');
  // 空有序项 caret 例外（2026-10-31 用户截图：`1. ` 正文空白时行尾光标不可见）
  assert.ok(wsrc.indexOf("' wysiwyg-ol-space-empty'") >= 0, '空有序项未挂 ol-space-empty 例外类');
  assert.match(css, /wysiwyg-ol-space-empty \{[^}]*width: 1px;/,
    'CSS 缺空有序项槽 1px 例外（零宽槽行尾 caret 无盒可锚）');
  // 有序二级括号显色（2026-10-31 用户截图：::after 继承 color:transparent →「)」不可见）
  assert.match(css, /wysiwyg-ol-paren::after \{[^}]*color: var\(--text-primary\);/,
    'ol 二级括号 ::after 未显式设色（继承透明 →「)」不渲染）');
});

test('复选框编辑态样式 ≡ 渲染态：小手光标/hover 变色/未勾选 70% 透明度/对勾 5×9 2px（2026-10-15 用户要求）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // 小手光标（渲染态 input 为 pointer；整 24px 槽即可点区，对整槽生效）
  assert.match(css, /wysiwyg-task-prefix \{[\s\S]*?cursor: pointer;/,
    '编辑态前缀槽缺 cursor:pointer（与渲染态 input 不一致）');
  // 未勾选态 opacity 0.7 + 与渲染态**同参**的 transition
  // （2026-10-25：transition 改成逐属性书写 —— 旧写法 `a, color, ..., box-shadow 0.15s ease`
  //  只有末项拿到时长，其余按规范是 0s 瞬变，勾选翻转变色其实没有过渡）
  assert.match(css,
    /wysiwyg-task-prefix::before \{[\s\S]*?opacity: 0\.7;[\s\S]*?transition: background-color 0\.15s ease, color 0\.15s ease, border-color 0\.15s ease, opacity 0\.15s ease, transform 0\.15s ease, box-shadow 0\.15s ease;/,
    '编辑态 ::before 缺未勾选 0.7 透明度 / 与渲染态同参 transition');
  // 「同参」用相等断言锁住，而不是两边各写一份字符串常量比对
  const editorTr = /wysiwyg-task-prefix::before \{[\s\S]*?(transition: [^;]+;)/.exec(css);
  const previewTr = /\.preview-content li input\[type="checkbox"\] \{[\s\S]*?(transition: [^;]+;)/.exec(css);
  assert.ok(editorTr && previewTr, '未能提取编辑态 / 渲染态 checkbox 的 transition');
  assert.strictEqual(editorTr[1], previewTr[1],
    '编辑态与渲染态 checkbox 的 transition 必须完全同参（列表、时长、缓动都要一致）');
  // hover 边框变成功色（渲染态 input:hover 同口径）
  assert.match(css, /wysiwyg-task-prefix:hover::before \{[^}]*border-color: var\(--color-success\);/,
    '缺编辑态 hover 边框变色（渲染态 input:hover 有）');
  // 勾选态 opacity 1
  assert.match(css, /wysiwyg-task-prefix\.checked::before \{[^}]*opacity: 1;/,
    '勾选态 ::before 未恢复 opacity 1（与渲染态 checked 不一致）');
  // 对勾与渲染态 input:checked::after 同参（5×9、2px 笔；left/top = 2026-10-15 Edge 逐像素
  // 实测校准值 4.5/8.5——渲染侧 input 参照盒与 border 内收推算差 1px，按推算值 5.5/9.5 时
  // 编辑态墨盒整体偏 (1,1)px）
  assert.match(css,
    /wysiwyg-task-prefix\.checked::after \{[^}]*left: 4\.5px;[^}]*top: 8\.5px;[^}]*width: 5px;[^}]*height: 9px;[^}]*border-width: 0 2px 2px 0;/,
    '编辑态对勾几何与渲染态 input:checked::after 不一致（left/top/5×9/2px）');
  assert.ok(css.indexOf('left: 0.32em;') < 0 && css.indexOf('border-width: 0 1.5px 1.5px 0;') < 0,
    '旧 em 值对勾（5.12/6.72、4.16×8、1.5px 笔）残留——比渲染态高约 2px 且笔细');
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
  // 2026-10-13 Phase 2：表格格点击改走 _wysiwygStartCellEdit 就地编辑（不再做光标定位/点击锚定），
  // 点击锚定契约保留在「普通块点击分支」（编辑按钮分支走 scrollIntoView，另一套机制）
  assert.ok(seq.length >= 1, `普通块点击分支须在 focus 后锚定，实得 ${seq.length}`);
  // _restoreWysiwygAnchor 被 cursorActivity（operation 内）调起，只清锚点量、不做滚动
  const rIdx = wsrc.indexOf('    _restoreWysiwygAnchor() {');
  const rblk = wsrc.slice(rIdx, rIdx + 700);
  assert.match(rblk, /if \(this\._wysiwygClickAnchor\) \{ this\._wysiwygAnchorY = null; return; \}/,
    '_restoreWysiwygAnchor 仍在 operation 内滚动（会被 CM pending 机制冲掉）');
  // 锚定用「事后测量 + 差值补偿」：点击位置必须换算为编辑器视口内坐标（旧实现拿窗口坐标
  // click.y 直接当 scrollIntoView 的 margin，真机编辑器上方的工具栏导致基准错位，每次点击
  // 往下滚一个工具栏高，2026-10-09 用户反馈），再 scrollTo 补偿差值把行顶放回点击处
  const aIdx = wsrc.indexOf('_applyWysiwygClickAnchor() {');
  const ablk = wsrc.slice(aIdx, aIdx + 1600);
  assert.match(ablk, /getBoundingClientRect\(\)\.top/, '点击锚点未换算为编辑器视口坐标（真机有工具栏，窗口坐标基准错位）');
  assert.match(ablk, /cm\.scrollTo\(info\.left, info\.top \+ delta\);/, '点击锚定未做差值补偿（行顶回不到精确点击处）');
  assert.match(ablk, /Math\.abs\(delta\) > vh/, '点击锚定缺少结构级变化守卫（差值过大应放弃补偿）');
  assert.ok(!/cm\.scrollIntoView\(pos,/.test(ablk), '点击锚定仍在用 scrollIntoView margin 机制（margin 带内不补偿 + 坐标基准错位）');
});

test('光标锚点补偿：document 空间测量 + operation 内延迟（2026-10-18 真机：空列表项按回车整页跳顶）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ① 采样与测量都必须在 document 空间（'local'）：window 坐标会把 CM 自己 operation 末的
  //    原生滚动混进差值 → 双重补偿
  const cIdx = wsrc.indexOf('    _captureWysiwygAnchor() {');
  assert.ok(cIdx > 0, '缺 _captureWysiwygAnchor');
  assert.match(wsrc.slice(cIdx, cIdx + 600), /cm\.cursorCoords\(null, 'local'\)/, '锚点采样未用 document 空间（window 坐标基准随滚动漂移）');
  // ② operation 进行中（cm.curOp 在）必须延迟到下一 tick：operation 内 refresh 使行高计算
  //    错乱（新挂遮罩 widget 高度未应用 → 测得几何塌缩），垃圾 delta 过视口守卫后 scrollTo
  //    负值被 operation 末钳到 0 = 整页跳到文档顶（2026-10-18 真机：末行空任务项再按回车）
  const rIdx = wsrc.indexOf('    _restoreWysiwygAnchor() {');
  assert.ok(rIdx > 0, '缺 _restoreWysiwygAnchor');
  const rblk = wsrc.slice(rIdx, rIdx + 2400);
  assert.match(rblk, /cm\.cursorCoords\(null, 'local'\)/, '锚点补偿测量未用 document 空间');
  assert.match(rblk, /if \(cm\.curOp\)/, 'operation 内未延迟补偿（operation 内 refresh 行高错乱 → 垃圾 delta 跳顶）');
  assert.match(rblk, /_wysiwygAnchorPending/, '延迟补偿缺合并守卫（同 tick 多次块切换会二次补偿）');
  assert.match(rblk, /setTimeout\(function \(\) \{ self\._wysiwygAnchorPending = false; doRestore\(\); \}, 0\)/, '延迟补偿未清合并标志（一次性标志永久挂起后补偿全失）');
});

test('点击锚点必须先于撤遮罩设置（2026-10-18 套件回归 S43：延迟补偿冲掉点击锚定）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const md = mousedownBlock(wsrc);
  const aIdx = md.search(/self\._wysiwygClickAnchor = \{ y: downY, line, refTop \};/);
  const sIdx = md.search(/setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(line\)\);/);
  assert.ok(aIdx >= 0 && sIdx >= 0, '缺点击锚点设置 / 普通块切换语句');
  assert.ok(aIdx < sIdx,
    '点击锚点在 setWysiwygActiveBlock 之后才设：该调用内部的 _capture/_restoreWysiwygAnchor 未受锚点守卫，' +
    '与点击锚点双补偿——operation 内延迟补偿在 _applyWysiwygClickAnchor 之后执行，把点击锚定滚掉（S43 段落 Δ104px）');
});

test('幻影块切换（两端皆无挂/撤遮罩工作）不做锚点补偿（2026-10-18 套件回归 S54B）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const sIdx = wsrc.indexOf('    setWysiwygActiveBlock(idx) {');
  assert.ok(sIdx > 0, '缺 setWysiwygActiveBlock');
  // 2026-10-25 引用分段活动态：setWysiwygActiveBlock 新增「分段挂载于锚点补偿前」块
  //（+4 行），restore 行函数头偏移 2497 → 窗口 2400→3000
  const sblk = wsrc.slice(sIdx, sIdx + 3000);
  // 幻影切换（如新实例首个 cursorActivity：prev=undefined、idx=-1，两端 no-op）结构未变，
  // 而 operation 内采样的 before 是未落定的陈旧几何；延迟到 operation 末用已落定的 after
  // 相减 = 虚假 delta（实测 24px）滚偏视口 → 点击落点错位。补偿必须条件于真实挂/撤工作。
  assert.match(sblk, /const hadPrev = prev >= 0;/, '缺「旧块有效」守卫标志');
  assert.match(sblk, /const hadIdx = idx >= 0;/, '缺「新块有效」守卫标志');
  assert.match(sblk, /if \(hadPrev \|\| hadIdx\) this\._restoreWysiwygAnchor\(\);/,
    '锚点补偿未条件于真实挂/撤遮罩工作（幻影切换也补偿 = 虚假 delta 滚偏视口）');
  assert.match(sblk, /else this\._wysiwygAnchorY = null;/,
    '幻影切换的陈旧采样未丢弃（下次切换会拿陈旧 before 做差值）');
});

test('点击遮罩块须先撤遮罩再落光标（CM5 会钳制标记区间内的 setSelection 位置）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const md = mousedownBlock(wsrc);
  // CM5 对落在 replacedWith 标记区间**内部**的 setSelection 位置会钳制到标记首/末端
  // （2026-10-09 实测：点多行块中部，光标恒落到块尾/块首行，用户反复点偏）。
  // 落光标前必须先 setWysiwygActiveBlock 撤掉本块标记，让目标行成为真实源码行；
  // 活动块索引按「目标行」查（增量刷新后闭包 idx 可能已位移，行→块才是准的）。
  // 2026-10-14 起走 _wysiwygBlockIndexAtFresh（防抖窗口内块表滞后守卫，见专项测试）
  const hits = md.match(/setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(/g) || [];
  assert.ok(hits.length >= 2, `表格/普通两个点击分支都须先撤目标块遮罩，实得 ${hits.length}`);
  const firstAct = md.search(/setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(/);
  const firstSel = md.search(/cm\.setSelection\(/);
  assert.ok(firstAct >= 0 && firstSel > firstAct, '撤遮罩发生在 setSelection 之后（标记未清时落光标必被 CM5 钳制）');
});

test('活动块未变时也要消费点击锚点（残留会污染后续光标移动）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const sIdx = wsrc.indexOf('    setWysiwygActiveBlock(idx) {');
  const sblk = wsrc.slice(sIdx, sIdx + 1600); // 开头含「在编格延迟提交」守卫（较长注释，2026-10-13 后变长，窗口需覆盖同块短路的 return；2026-10-16 又加选区着色补刷语句）
  assert.match(sblk, /if \(prev === idx\)/, '缺少同块短路分支');
  // 消费锚点必须在同块短路的 return 之前完成（中间允许高亮重挂/选区着色补刷等收尾语句）
  assert.match(sblk, /this\._restoreWysiwygAnchor\(\);[\s\S]{0,400}?return;/,
    '同块短路时未消费锚点（残留的 click 锚点会让下一次普通光标移动跳到无关位置）');
});

// ---------- 11b. 格编辑启动重遮罩旧活动块（2026-10-14 用户截图「点表格后下面一行还是源码态」） ----------

test('进格编辑重遮罩旧活动块：重遮 + 无活动块 + 被钳光标重激活三路拦截', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ① 格编辑启动重遮旧块（须在 _wysiwygCellEditing 立起后调用；表格自身块除外）
  const rcIdx = wsrc.indexOf('_wysiwygReMaskActiveForCellEdit(tableIdx) {');
  assert.ok(rcIdx > 0, '缺 _wysiwygReMaskActiveForCellEdit');
  const rcBlk = wsrc.slice(rcIdx, rcIdx + 900);
  assert.match(rcBlk, /prev === tableIdx\) return;/, '表格自身块被重遮（应除外）');
  assert.match(rcBlk, /this\._wysiwygActiveIdx = -1;/, '未清活动块（无活动块 = 全部遮罩）');
  assert.match(rcBlk, /this\.maskWysiwygBlock\(prev\);/, '旧活动块未重新遮罩');
  const scIdx = wsrc.indexOf('this._wysiwygCellEditing = {');
  assert.ok(scIdx > 0, '未找到 _wysiwygCellEditing 状态立起点');
  const scBlk = wsrc.slice(scIdx, scIdx + 900);
  assert.match(scBlk, /this\._wysiwygReMaskActiveForCellEdit\(idx\);/, '_wysiwygStartCellEditOn 未调用旧块重遮罩');
  // ② syncWysiwygActiveBlock 守卫：进格编辑重遮罩时 reCheckSelection 把光标钳到旧块末行
  //    （仍在块内）触发的 cursorActivity 不得把刚遮的块重新激活
  const syncIdx = wsrc.indexOf('syncWysiwygActiveBlock() {');
  const syncBlk = wsrc.slice(syncIdx, syncIdx + 1600); // 窗口须越过拖选冻结守卫注释块（2026-10-16 跨块选区）
  assert.match(syncBlk, /if \(this\._wysiwygCellEditing\) \{ this\._restoreWysiwygAnchor\(\); return; \}/,
    'syncWysiwygActiveBlock 缺格编辑守卫（被钳 cursorActivity 会重解罩旧块）');
  // ③ 结构刷新现算：已挂遮罩的块不得「激活」（被钳光标落在遮罩块内 → -1）；
  //    拖拽提交/增行增列、防抖重算、全量增量三处统一走同一助手（传旧表与旧 marks 配套，
  //    新表索引 + 旧 marks 会索引撞车 → 空行标题误遮，2026-10-19 见专项测试）
  const aifcIdx = wsrc.indexOf('_wysiwygActiveIdxFromCursor(oldBlocks) {');
  assert.ok(aifcIdx > 0, '缺 _wysiwygActiveIdxFromCursor');
  const aifcBlk = wsrc.slice(aifcIdx, aifcIdx + 1200);
  assert.match(aifcBlk, /this\._wysiwygMarks\.has\(obi\)\) return -1;/, '遮罩块可被判活动块（会解罩回源码态）');
  const uses = (wsrc.match(/_wysiwygActiveIdxFromCursor\(oldBlocks\);/g) || []).length;
  assert.ok(uses >= 3, '结构刷新路径未统一走 _wysiwygActiveIdxFromCursor（拖拽提交/防抖/全量增量 3 处），实际 ' + uses);
});

// ---------- 11c. 格内文字选中 + 点外部失焦（2026-10-14 用户要求） ----------

test('格内文字可选中 + 点其他行/空白处单元格失焦（选中三路放行、提交四处挂钩）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ① 正在编辑的本格 mousedown 直接 return（在 preventDefault 之前）——原生拖选才生效
  assert.match(wsrc,
    /hitCell && self\._wysiwygCellEditing && hitCell === self\._wysiwygCellEditing\.cell\) return;/,
    '点本格未放行原生选择（preventDefault 会杀死拖选）');
  // ② 「先提交失焦」挂钩：mask mousedown try 头（另一格/留白/另一块）+ 表格外 capture 守卫
  //    + 拖拽 up（轨道单击）+ 拖拽 cancel + 既有分支 commit-first（切格/增行增列）
  const commits = (wsrc.match(/_wysiwygEndCellEdit\(true, false\);/g) || []).length;
  assert.ok(commits >= 6, '点其他行/空白处失焦提交挂钩不足（try头/capture守卫/拖up/拖cancel/切格/增行列 6 处），实际 ' + commits);
  // ③ CSS：编辑态格子恢复文本选择（遮罩节点默认 user-select:none 会拦掉一切选中）
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const ceIdx = css.indexOf('table th.wysiwyg-cell-editing {');
  assert.ok(ceIdx > 0, '缺 .wysiwyg-cell-editing 规则');
  assert.match(css.slice(ceIdx, ceIdx + 700), /user-select: text;/, '编辑态格未恢复 user-select（格内文字选不中）');
});

// ---------- 11d. 标题活动行「灰 # 前缀 + 渲染文字」（2026-10-14 用户要求，Typora 式） ----------

test('活动块源文态装饰：标题#前缀/列表符号/代码围栏 + 应用点齐全', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /_wysiwygApplyActiveDecor\(idx\) \{/, '缺 _wysiwygApplyActiveDecor');
  const dIdx = wsrc.indexOf('_wysiwygApplyActiveDecor(idx) {');
  // 窗口 6500→8000→11500→12500（2026-10-17：函数头新增代码行排版行类先清后挂块 + 围栏分支扩为
  // 「内容行排版行类」挂法，列表分支被顶后 ~1400 字符；同日列表分支头部再插入嵌套层级
  // 计算 ~1400 字符，ol-paren 标记装饰距函数头 ~10072 字符 → 扩至 11500 覆盖；
  // 2026-10-22 围栏分支加块底槽位 + details 块判定/行类 ~370 字符 → 扩至 12500 覆盖；
  // 2026-10-28 2026-10-20..28 未提交积累（函数头先清后挂块扩充 + 引用编辑态行类管理等）
  // 把 ol-paren 从 12003（HEAD）顶到 12499，差 1 字符越出 12500 → 扩至 14000 覆盖）
  const dBlk = wsrc.slice(dIdx, dIdx + 14000);
  assert.match(dBlk, /add\(b\.start, 0, m\[0\]\.length, 'wysiwyg-heading-hash'\);/, '# 前缀段缺失（应小灰显示）');
  assert.match(dBlk, /wysiwyg-heading-text wysiwyg-heading-text-' \+ level/, '正文段缺失（应渲染尺寸显示）');
  assert.match(dBlk, /b\.end - b\.start === 1 && RE\.heading\.test\(first\)/, '标题分支未按单行块判定');
  assert.match(dBlk, /RE\.fence\.test\(first\.trim\(\)\)/, '缺代码块（围栏）分支');
  assert.match(dBlk, /wysiwyg-code-fence/, '缺围栏行标记类（上下三个 ` 应灰显）');
  // 2026-10-18 用户要求：上下围栏都在灰框内 → 开/闭围栏行同挂代码排版行类（codeCls）
  assert.match(dBlk, /codeCls\(b\.start\);/, '开围栏行未挂代码排版行类（围栏应在灰盒内）');
  assert.match(dBlk, /if \(hasClose\) codeCls\(last\);/, '闭围栏行未挂代码排版行类（围栏应在灰盒内）');
  assert.match(dBlk, /wysiwyg-list-bullet/, '缺列表圆点标记类（• 应渲染化）');
  assert.match(dBlk, /wysiwyg-task-prefix/, '缺任务前缀槽标记类（☐☑ 应渲染化）');
  assert.match(dBlk, /checked/, '复选框无勾选态（[x] 应渲染为已勾选）');
  assert.match(dBlk, /wysiwyg-ol-marker/, '缺有序序号标记类');
  assert.match(dBlk, /!RE\.hr\.test\(first\.trim\(\)\)/, 'HR 行（- - -）未排除（会被误装饰成列表）');
  // 列表块级排版行类（2026-10-15）：挂挂 + 追踪清理（切块/拆场先清后挂）
  assert.match(dBlk, /wysiwyg-list-line/, '活动列表行未挂块级排版行类');
  assert.match(dBlk, /wysiwyg-list-indent/, 'ul/ol 活动行未挂缩进行类');
  assert.ok((wsrc.match(/_wysiwygListLines/g) || []).length >= 5, '列表行类未追踪（切块/拆场需先清后挂）');
  // 嵌套层级（2026-10-17 用户截图：列表有嵌套子项时两态不一致）：层级判定 +
  // 前导缩进零宽 + lvl 行类 + 续行类 + ol 二级括号 marker
  assert.match(dBlk, /lvlSeq\.indexOf\(ind\) \+ 1/, '缺嵌套层级判定（条目行缩进升序去重序列）');
  assert.match(dBlk, /wysiwyg-list-space-zero/, '嵌套前导缩进未零宽化（padding 会与源空格数耦合）');
  assert.match(dBlk, /wysiwyg-list-lvl-' \+ Math\.min\(lvl, 6\)/, '缺嵌套层级行类（wysiwyg-list-lvl-N）');
  assert.match(dBlk, /wysiwyg-list-cont/, '缺续行类（wysiwyg-list-cont，正文落 li 内容缘）');
  assert.match(dBlk, /wysiwyg-ol-paren/, '缺 ol 二级括号 marker（渲染 paren-decimal「N)」）');
  assert.ok((wsrc.match(/wysiwyg-list-lvl-' \+ n\)/g) || []).length >= 2,
    '嵌套层级行类撤除点不足（_apply 重挂 + clearWysiwygMasks 两处都要撤）');
  // 应用点：setWysiwygActiveBlock / change 钩子 / 进 wysiwyg 尾 / 防抖尾 / 全量增量尾
  const applies = (wsrc.match(/_wysiwygApplyActiveDecor\((?:this|self)\._wysiwygActiveIdx\)|_wysiwygApplyActiveDecor\(idx\);/g) || []).length;
  assert.ok(applies >= 5, '装饰应用点不足（切块/change钩子/进wysiwyg尾/防抖尾/全量增量尾），实际 ' + applies);
  assert.match(wsrc, /_ensureWysiwygActiveDecorHook\(\);/, 'change 钩子未登记');
  assert.match(wsrc, /c\.from\.line < b\.end && c\.to\.line >= b\.start\)/, 'change 钩子未按编辑交叠重算装饰');
  const clIdx = wsrc.indexOf('clearWysiwygMasks() {');
  assert.match(wsrc.slice(clIdx, clIdx + 1200), /_wysiwygActiveDecor/, '离开模式未清活动块装饰（源文行残留样式）');
  // CSS：标题——灰 # + 预览字族/加粗变量 + h1–h6 六级尺寸
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /wysiwyg-heading-hash \{[\s\S]{0,200}color: var\(--text-secondary\);/, '# 前缀未用主题次级色（灰）');
  assert.match(css, /wysiwyg-heading-hash \{[\s\S]{0,400}font-size: 0\.8em;/,
    '# 前缀未统一字号（2026-10-15 用户要求：各级 # 一样大）');
  assert.doesNotMatch(css, /wysiwyg-heading-hash-\d \{/, '残留按级 # 字号规则（应已合并为统一 0.8em）');
  assert.match(css, /wysiwyg-heading-text \{[\s\S]{0,200}font-family: var\(--font-preview\);/, '正文未用预览字族（与渲染标题不一致）');
  for (let n = 1; n <= 6; n++) {
    assert.ok(css.indexOf('wysiwyg-heading-text-' + n + ' {') >= 0, '缺 h' + n + ' 渲染尺寸 CSS');
  }
});

test('列表/代码块活动行渲染化 CSS：源符号透明化 + ::before 渲染符号 + 围栏灰显', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // 圆点/复选框：源字符所在 span 透明化（保留真实宽度 → 光标测量精准；
  // 不可用 width:0 + overflow:hidden——会连 ::before 符号一起裁掉）
  assert.match(css, /\.wysiwyg-list-bullet \{[\s\S]{0,400}color: transparent;/,
    '圆点 span 未透明化（源字符会同时可见）');
  assert.match(css, /\.wysiwyg-task-prefix \{[\s\S]{0,300}color: transparent;/,
    '任务前缀槽 span 未透明化（源字符会同时可见）');
  // 画圆垂直居中锚定行盒（真机 WebView2 内联 span 字体盒按基线放置，与渲染 disc
  // 差 1px——2026-10-15 用户截图「点入编辑黑点往上移一点点」）：盒高=行高 1.7em +
  // vertical-align:top → ::before top:50% 严格=行盒中心
  assert.match(css, /\.wysiwyg-list-bullet \{[\s\S]{0,700}display: inline-block;[\s\S]{0,120}height: 1\.7em;[\s\S]{0,120}vertical-align: top;/,
    '圆点盒未锁定行盒（inline-block + 1.7em + vertical-align:top 缺一，真机黑点会偏 1px）');
  assert.doesNotMatch(css.slice(css.indexOf('.wysiwyg-list-bullet {'),
    css.indexOf('.wysiwyg-list-bullet {') + 400), /overflow:\s*hidden/,
    '源符号 span 用了 overflow:hidden（会裁掉 ::before 渲染符号）');
  // 圆点符号：画圆而非 '•' 字符（2026-10-15 用户截图：'•' 字符比渲染 disc marker 小且偏上）
  assert.match(css, /wysiwyg-list-bullet::before[\s\S]{0,250}width: 6px;[\s\S]{0,120}border-radius: 50%;/,
    '无序圆点未用画圆（须与渲染 disc marker 同形：6px 实心圆）');
  assert.match(css, /wysiwyg-list-bullet::before[\s\S]{0,250}left: -7px;/,
    '圆点 left 应为 -7px（canvas 像素实测：渲染 disc x=38–43，画圆 38–44 逐像素重合；-6px 偏右 1px，用户仍觉「黑点往右移」）');
  // 画圆垂直位=disc 字形绘制位（非几何中心）：Edge154（=WebView2 同引擎）加权重心实测
  // disc 中心=行顶+0.906em；absolute 盒 round 落位 vs disc AA 不取整 → 0.906em 部分行差
  // 1px（用户第三组截图「有一部分黑点会动」）；绿圆分离法扫描：0.922–0.952em 全同 Δ=0，
  // 取中值 0.938em（取整平台正中，相位滚动/字号组合都稳）
  assert.match(css, /wysiwyg-list-bullet::before[\s\S]{0,300}top: calc\(0\.938em - 3px\);/,
    '画圆 top 须为 calc(0.938em - 3px)（disc 重心 0.906em + round/AA 取整差补偿的中值；50%/0.906em 都会在真机部分行偏 1px）');
  assert.match(css, /wysiwyg-list-bullet::before[\s\S]{0,300}background: var\(--text-primary\);/, '圆点未用正文色');
  // 任务行「- [ ]」整段进固定 24px 前缀槽（2026-10-17 用户截图：任务列表编辑态与渲染态
  // 不一致——旧 -2ch 偏移按等宽字口径估算，预览比例字体下框左漂 6.4px；框宽随 [x]/[ ]
  // 中字符变 → 勾选行正文右漂 4px）。固定 24px（= 渲染复选框 16px + margin 8px）
  // 一次对齐：复选框恒落行基准 32px、正文恒落 56px、勾选/未勾选同位。
  const wsrc2 = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc2, /'wysiwyg-task-prefix' \+ \(\/\[xX]\/\.test/, 'bullet 字符未挂 24px 前缀槽');
  assert.match(wsrc2, /'wysiwyg-task-box-zero'/,
    '「空格 + [ ]」段未挂零宽槽（24px 类挂整段会被 CM5 按 token 拆成两个 24px 槽 → 正文跳 80，S51 实测）');
  assert.match(css, /\.wysiwyg-task-prefix \{[\s\S]{0,300}display: inline-block;[\s\S]{0,120}width: 24px;/,
    '任务前缀槽未固定 24px（= 渲染复选框 16px + margin 8px；框宽/位置随源字符变会漂移）');
  assert.match(css, /\.wysiwyg-task-box-zero \{[\s\S]{0,160}width: 0;/,
    '任务「空格 + [ ]」零宽槽缺失（[x]/[ ] 宽度差会把勾选行正文推右 4px）');
  assert.match(css, /\.wysiwyg-task-prefix::before[\s\S]{0,200}left: 0;/,
    '复选框未锚定槽左缘 left:0（左漂根因是旧 -2ch 随字体度量变）');
  assert.match(css, /\.wysiwyg-task-prefix::before[\s\S]{0,400}width: 16px;[\s\S]{0,120}height: 16px;/,
    '复选框尺寸未固定 16px（与渲染 input[checkbox] 一致）');
  assert.match(css, /wysiwyg-task-prefix::before[\s\S]{0,300}border: 1\.5px solid var\(--border-color\);/,
    '复选框未对齐预览样式（1.5px 边框）');
  assert.match(css, /wysiwyg-task-prefix\.checked::before[\s\S]{0,150}--color-success/, '勾选态未用主题成功色');
  assert.match(css,
    /wysiwyg-task-prefix\.checked::after[\s\S]{0,600}border-width: 0 2px 2px 0;[\s\S]{0,40}transform: rotate\(45deg\);/,
    '缺勾选对勾（2px 笔 + 45° 旋转）');
  // 正文/序号：预览字族（与渲染列表一致）
  assert.match(css, /wysiwyg-list-text \{[\s\S]{0,100}var\(--font-preview\)/, '列表正文未用预览字族');
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,100}var\(--font-preview\)/, '有序序号未用预览字族');
  // 有序序号 24px 右对齐槽（2026-10-16 用户反馈「有序列表点入编辑态有向右偏移」：
  // 旧「行缩进+8px + 源空格自然宽」按「1. 」≈16px 估算、实测 16.48px → 正文偏右
  // 0.48px、序号偏左 ~4px）。固定 width:24px（= 渲染 ol padding，border-box）右对齐
  // + padding-right 4.4px（2026-10-18 整墨迹 L1 子像素扫描：「N.」整墨迹两态一致的最优窗口
  // 4.36–4.42px，6 个 preL 小数相位下窗口不变；4px 时「1/2」细笔左缘越像素边界、编辑态整字偏右 1px）
  // ⚠️ 历史教训（2026-10-17）：曾按「数字墨迹右缘 render=50 / edit=50 逐行重合」取 4px——右缘列重合 ≠ 同相：2px 宽的 period
  // 墨迹跨像素边界时右列相同、质量中心却差 0.5px；右对齐对齐的是**锚点**（推进盒右缘 = 56 − padding-right），详见 styles.css ③ 注释
  // + 源空格零宽（.wysiwyg-ol-space）→ 正文恒 56px、序号墨迹与原生逐列一致。
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,200}display: inline-block;/, '有序序号未 inline-block（无法固定槽宽/右对齐）');
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,200}width: 24px;/, '有序序号槽宽未固定 24px（= 渲染 ol padding；多位数撑宽会推正文）');
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,200}text-align: right;/, '有序序号未右对齐（应复刻渲染 outside marker 右缘对齐）');
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,200}padding-right: 4\.4px;/, '有序序号右距须 4.4px（整墨迹扫描最优窗口 4.36–4.42px、6 个 preL 小数相位下不变；4px 时编辑态数字偏右 1px）');
  assert.match(css, /wysiwyg-ol-space \{[\s\S]{0,120}width: 0;/, '有序源空格未零宽（会把正文再推一个空格宽）');
  // IME 组合文本落进固定 24px 前缀槽必须 nowrap（2026-10-18 真机 CDP dump 定位）：
  // 空列表项（`1. ` / `- [ ] ` 正文为空）时，Chromium 把拼音组合串并进光标处最近的文本容器
  // —— 恰是这两个 24px 固定前缀槽；槽内容宽仅 19px + 继承行盒 pre-wrap → 逐字折行，
  // marker 盒高实测 27.19 → 108.75px（4 行）= 用户截图「拼音竖排、字间有点」；
  // 有正文的行组合文本落自动宽正文 span，故「先输内容再打拼音就正常」。
  // ⚠️ 旧修复（.wysiwyg-ol-space nowrap）无效：真机把该槽加宽到 1px 后 marker 仍 108.75px。
  // 断言用「规则块内」匹配（{…} 内不含嵌套花括号），窗口按实测规则长度取宽（marker 规则含长注释
  // 约 770 字符、task-prefix 约 500）——用固定小窗口会漏判。
  const ruleBody = (sel) => {
    const i = css.indexOf('.' + sel + ' {');
    return i < 0 ? '' : css.slice(i, css.indexOf('\n}', i) + 2);
  };
  assert.match(ruleBody('wysiwyg-ol-marker'), /white-space: nowrap;/,
    '有序 24px 序号槽未 nowrap（空列表项 IME 组合文本会在 19px 内容宽里逐字竖排）');
  assert.match(ruleBody('wysiwyg-task-prefix'), /white-space: nowrap;/,
    '任务 24px 前缀槽未 nowrap（同族缺陷：组合期 scrollHeight 27→82/109 竖排）');
  assert.match(wsrc2, /'wysiwyg-ol-space'/, '有序标记后未挂零宽空格 span');
  assert.match(wsrc2, /else if \(!taskM && !olM && indentList\)/, 'ol 标记行未排除行缩进（应只由 24px marker 槽提供缩进，续行才走 -indent-ol）');
  // 列表活动行块级排版（2026-10-15 用户反馈：编辑态比渲染态「小、密、缩进不同」）：
  // 项间距 4px（渲染 li margin-bottom）+ ul/ol 行缩进在行基准 32px 上叠 12px（序号左缘对齐）
  assert.match(css, /wysiwyg-list-line \{[\s\S]{0,80}padding-bottom: 4px;/, '列表活动行缺项间距（渲染 li 有 4px margin-bottom，编辑态「密」）');
  assert.match(css, /wysiwyg-list-line\.wysiwyg-list-indent-ul \{[\s\S]{0,120}calc\(var\(--wysiwyg-line-inset, 32px\) \+ 13px\)/,
    'ul 缩进未在行基准上 calc 叠加 13px（「- 」≈11px，24−11=13 正文才落回渲染 56px）');
  // ol **续行**仍走 +8px 行缩进 + 源前导空格近似（标记行已改用 24px marker 槽，见上）
  assert.match(css, /wysiwyg-list-line\.wysiwyg-list-indent-ol \{[\s\S]{0,120}calc\(var\(--wysiwyg-line-inset, 32px\) \+ 8px\)/,
    'ol 续行缩进未在行基准上 calc 叠加 8px（续行无 marker 槽，沿用旧近似口径）');
  assert.match(css, /padding-left: var\(--wysiwyg-line-inset, 32px\);/, 'wysiwyg 行基准留白未变量化（列表缩进无法叠加）');
  // S42（2026-10-15 用户截图：列表项 "5454554" 编辑态带下划线、渲染态没有）：
  // gfm 模式 gitHubSpice 把 7–40 位十六进制串认成 SHA → cm-link token →
  // codemirror.css .cm-link { text-decoration: underline } 在编辑态漏出；渲染器不识别
  // → 不一致。必须关 gitHubSpice（普通 URL 的 cm-link 走 urlRE 分支，渲染态本有下划线，保留）。
  const ecore = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  assert.match(ecore, /gitHubSpice:\s*false/, 'gfm 模式未关 gitHubSpice（SHA/issue 串被认成链接，编辑态漏下划线）');
  // token 的 text-decoration 也要中和（.cm-link 下划线 / .cm-strikethrough 删除线漏出）；
  // 渲染态链接口径 = .preview-content a { text-decoration:none } → 编辑态 cm-link 无下划线
  assert.match(css, /wysiwyg-plain-text span\[class[*]="cm-"\] \{[\s\S]{0,800}text-decoration: none;/,
    'cm- token span 未中和 text-decoration（gitHubSpice 关后 URL 的 cm-link 下划线仍会漏出，与渲染态 <a> 口径不符）');
  assert.doesNotMatch(css, /wysiwyg-inline-link \{\s*color: var\(--accent-color\);\s*text-decoration: underline;/,
    '独立 wysiwyg-inline-link 规则不应带 underline（渲染态链接无下划线）');
  // S43（2026-10-15 用户截图：「点击编辑后内容会向上动一下」；2026-10-17 随遮罩
  // 盒模型归零重标定）：遮罩高度 = 渲染内容 + 14px 自身 margin-bottom（BFC 内收；
  // > *:last-child 清零被 block-edit-btn 占了 last-child 位而失效）。旧 1px
  // padding-top / 2px padding-bottom / 1px border-bottom 的 4px 结构补偿已于
  // 2026-10-17 移除（它是块间间隙恒比阅读模式大 4px 的元凶）→ 活动块只需块边缘
  // 行（wysiwyg-block-edge-bottom，非 cm-wysiwyg-active-first/last——那对非容器块
  // 只挂光标行 lo=hi）给 14px 边距族末行补 底距 14px 即逐像素等高；首行不再补
  // 顶距（遮罩顶缘 = 内容顶缘，> *:first-child margin-top:0）。
  assert.match(wsrc2, /wysiwyg-block-edge-top/, '缺块边缘行类（wysiwyg-block-edge-top）');
  assert.match(wsrc2, /wysiwyg-block-edge-bottom/, '缺块边缘行类（wysiwyg-block-edge-bottom）');
  assert.match(wsrc2, /wysiwyg-para-line/, '缺段落行类（wysiwyg-para-line）——段落块（p 的 14px 边距族）无法参与块高补齐');
  assert.match(css, /wysiwyg-list-line\.wysiwyg-block-edge-bottom,\s*\n[^}]*wysiwyg-para-line\.wysiwyg-block-edge-bottom \{[\s\S]{0,60}padding-bottom: 14px;/,
    '块边缘末行未补 14px 底距（= 遮罩内收的 14px margin-bottom）');
  // 「首行不再补顶距」只约束 14px 边距族（列表/段落：遮罩顶缘 = 内容顶缘）；
  // 引用族参数不同（渲染盒有 12px padding-top，2026-10-20 活动态首行补 12px 对齐渲染盒顶缘）
  const e14 = css.indexOf('wysiwyg-list-line.wysiwyg-block-edge-bottom');
  assert.ok(e14 > 0, '缺 14px 边距族块边缘末行规则');
  assert.doesNotMatch(css.slice(e14, e14 + 300), /padding-top:/,
    '14px 边距族块边缘首行不应再补顶距（遮罩 padding-top 已归零，补了会破坏 S43 等高）');
  // 遮罩盒模型：padding 0 + flow-root（BFC 内收 mb）+ 无 border-bottom
  assert.match(css, /wysiwyg-block-mask\.preview-content \{[\s\S]{0,400}display: flow-root;/, '遮罩未改 BFC（mb 会外溢，块间间隙无法对齐阅读模式）');
  assert.match(css, /wysiwyg-block-mask\.preview-content \{[\s\S]{0,700}padding: 0;/, '遮罩 padding 未归零（4px 结构补偿会复活）');
  assert.doesNotMatch(css, /wysiwyg-block-mask\.preview-content \{[\s\S]{0,700}border-bottom: 1px/, '遮罩 border-bottom 未移除（4px 结构补偿会复活）');
  // 代码围栏：灰显（语法标志）
  assert.match(css, /wysiwyg-code-fence \{[\s\S]{0,100}var\(--text-secondary\)/, '围栏未灰显');
});

// ---------- 12. 遮罩渲染后处理对齐（真机 demo.md：公式块露 $$ 源码） ----------

test('遮罩须补跑预览后处理（与阅读模式 render() 同序全链，走 RenderPost 共享管线）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /_postProcessWysiwygNode\(node\)/, 'maskWysiwygBlock 未调用后处理');
  // renderMarkdown 只产出结构 HTML，后处理统一走 RenderPost 共享管线（modules/render-post.js）：
  // 与阅读模式 render() 同 stage 同顺序（同步 stage 在 _postProcessWysiwygNode，
  // 异步 stage 在 _wysiwygPostProcessAsync 里 DOM 落定后补跑）
  const pIdx = wsrc.indexOf('_postProcessWysiwygNode(node) {');
  const pblk = wsrc.slice(pIdx, pIdx + 2500);
  assert.match(pblk, /RenderPost\.enableCheckboxes\(node\)/, '复选框未解禁（渲染态点不动）');
  assert.match(pblk, /RenderPost\.processEmoji\(node\)/, '未补跑 emoji 还原（遮罩里露 :rocket: 短码）');
  assert.match(pblk, /RenderPost\.processMath\(node\)/, '未补跑公式渲染（遮罩里会露原始 $$ 源码）');
  assert.match(pblk, /RenderPost\.processAbbreviations\(node, postOpts\)/, '未补跑缩写还原');
  assert.match(pblk, /RenderPost\.processHeadings\(node, postOpts\)/, '未补跑标题锚点 id（#链接跳转失效）');
  assert.match(pblk, /RenderPost\.addCopyButtons\(node, postOpts\)/, '未补跑代码块复制按钮');
  assert.match(pblk, /RenderPost\.processCodeBlocks\(node/, '未补跑代码高亮（遮罩里代码无高亮）');
  // 代码行号与阅读模式同源：看 #preview 的 code-line-numbers 类（同一设置写入，
  // preview-controller 同款判据）
  assert.match(pblk, /preview\.classList\.contains\('code-line-numbers'\)/, '代码行号未与阅读模式同源');
  // 后处理要在 innerHTML 赋值之后、markText 之前对节点执行
  //（窗口 300→700：2026-11-01 性能改造在 innerHTML 与后处理之间插入「最终缓存命中则跳过
  // 同步后处理」条件分支——命中块的缓存 HTML 已含全部同步 stage 产物，语义见
  // _wysiwygFinalHtmlCacheMap 注释）
  const mIdx = wsrc.indexOf('node.innerHTML = html;');
  const seg = wsrc.slice(mIdx, mIdx + 700);
  assert.match(seg, /_postProcessWysiwygNode\(node\)/, '后处理未紧跟 innerHTML 赋值');
  // 共享管线本体必须真的调各 pass（两模式共用的渲染逻辑收敛在 render-post.js）
  const rpIdx = bundle.indexOf('const RenderPost = {');
  assert.ok(rpIdx > 0, '缺少 RenderPost 共享管线（两模式渲染逻辑必须同一入口）');
  const rblk = bundle.slice(rpIdx, rpIdx + 9000);
  assert.match(rblk, /PreviewPost\.processEmojiShortcodes\(container\)/, '共享管线未接 emoji pass');
  assert.match(rblk, /PreviewPost\.processMath\(container\)/, '共享管线未接公式 pass');
  assert.match(rblk, /PreviewPost\.processAbbreviations\(container, opts\)/, '共享管线未接缩写 pass');
  assert.match(rblk, /PreviewPost\.processHeadings\(container, opts\)/, '共享管线未接标题锚点 pass');
  assert.match(rblk, /PreviewPost\.addCopyButtons\(container, opts\)/, '共享管线未接复制按钮 pass');
  assert.match(rblk, /CodeBlock\.processCodeBlocks\(container/, '共享管线未接代码高亮 pass');
  assert.match(rblk, /removeAttribute\('disabled'\)/, '共享管线未解禁复选框');
});

test('遮罩异步 pass（图片/Mermaid/TOC）与排版同步、行号隐藏、锚点跳转齐备', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 异步 pass：挂遮罩后登记，DOM 落定后由 flush 统一执行；节点级代数防旧请求写脏重建后的 DOM
  assert.match(wsrc, /_wysiwygPostProcessAsync\(node, idx\)/, '缺少异步 pass 方法');
  assert.match(wsrc, /RenderPost\.prepareImages\(node/, '未补跑图片本地解析（相对路径图片不显示）');
  assert.match(wsrc, /RenderPost\.runMermaid\(node/, '未补跑 Mermaid 渲染（遮罩里露源码）');
  assert.match(wsrc, /RenderPost\.applyCodeScrollOverflow\(node/, '未补跑代码块按需滚动条');
  assert.match(wsrc, /_wysiwygReplaceToc\(node\)/, '未补跑 [TOC] 目录替换');
  assert.match(wsrc, /_wysiwygMaskGen = \(this\._wysiwygMaskGen \|\| 0\) \+ 1/, '缺代数递增（遮罩重建后旧异步会写脏 DOM）');
  // 共享管线必须真的接图片/mermaid pass
  assert.match(bundle, /ImageProcessor\.processImages\(container/, '共享管线未接图片 pass');
  assert.match(bundle, /processMermaid\(container, opts\)/, '共享管线未接 mermaid pass');
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
  // 单 operation 批量挂非活动块遮罩（窗口 800→1600：2026-11-01 视口优先改造在 operation
  // 前插入视口范围求解——先挂视口 ±15 块、其余 _wysiwygPumpIdleMount 分批补挂，批量操作仍在）
  const eIdx = wsrc.indexOf('_enterWysiwygFullView() {');
  const eblk = wsrc.slice(eIdx, eIdx + 1600);
  assert.match(eblk, /cm\.operation\(\(\) => \{/, '全量挂遮罩未用单 operation 批量（逐块=数千次 display 更新）');
  // 离开所见即所得恢复默认视口余量（窗口 5800→6600：函数内含批量撤遮罩 + 活动块高亮撤行类 +
  // 正文排版行类撤除 + 块间空行间隙清理（2026-10-17），函数体变长；
  // 2026-10-17 QA 审查又新增光标行状态复位块（~430 字符），5200→5800；
  // 2026-10-17 代码块灰盒又新增代码行排版行类撤除块（~560 字符），5800→6600；
  // 2026-10-25 引用分段清退块（~600 字符），6600→7600）
  const cIdx = wsrc.indexOf('clearWysiwygMasks() {');
  const cblk = wsrc.slice(cIdx, cIdx + 7600);
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
  const fblk = wsrc.slice(fIdx, fIdx + 1500);
  // 只切边界不渲染 html（skipHtml）
  assert.match(fblk, /this\.computeWysiwygBlocks\(true\)/, '增量刷新未按仅解析模式重切块');
  // 2026-10-21 逐项切块 + S38 遮罩键漂移修复：重键/重挂核心抽成公共方法
  // _wysiwygRekeyMarksToBlocks（防抖刷新与 _wysiwygBlockIndexAtFresh 即时切块共用口径），
  // 增量刷新必须调用它（否则旧键遮罩被新 idx 误撤，S38 回归）
  assert.match(fblk, /this\._wysiwygRekeyMarksToBlocks\(oldBlocks, newBlocks\);/, '增量刷新未走公共重键方法（S38 误撤罩回归）');
  const rIdx = wsrc.indexOf('_wysiwygRekeyMarksToBlocks(oldBlocks, newBlocks) {');
  assert.ok(rIdx > 0, '缺少公共遮罩重键方法');
  const rblk = wsrc.slice(rIdx, rIdx + 4000);
  // 源文本同一性匹配：未变块保留旧 marker（CM 标记自动跟随文本）
  assert.match(rblk, /b\.src = this\._wysiwygBlockSource\(b\);/, '增量刷新未计算块源文本键');
  assert.match(rblk, /nb\.html = \(ob\.html !== undefined\) \? ob\.html : nb\.html;/, '未变块未复用缓存 html');
  assert.match(rblk, /data-block-index/, '块索引位移未同步遮罩节点块号（点击映射会落错块）');
  // 变化块在单 operation 内重挂
  assert.match(rblk, /cm\.operation\(\(\) => \{/, '增量刷新重挂未用单 operation 批量');
  assert.match(rblk, /this\.maskWysiwygBlock\(k\);/, '未重挂变化的块');
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
  const zh = i18n.indexOf("viewModeWysiwyg: '实时预览（beta）'");
  const en = i18n.indexOf("viewModeWysiwyg: 'Live Preview (beta)'");
  const es = i18n.indexOf("viewModeWysiwyg: 'Vista en vivo (beta)'", en + 10);
  for (const [name, idx] of [['zh', zh], ['en', en], ['es', es]]) {
    assert.ok(idx > 0, '未找到 ' + name + ' 的 viewModeWysiwyg');
    assert.match(i18n.slice(idx, idx + 200), /viewModeWysiwygRendering: '[^']+'/, name + ' 缺 viewModeWysiwygRendering 文案');
  }
});

// ---------- 15. 2026-10-12 六项真机反馈 + 卡死回归 + 跳转修复 ----------

test('格编辑 + 行列拖：按下前已存在的格编辑阈值不取消、释放时源码重建前提交（2026-10-14 用户反馈）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(src, /st\.cellEditAtDown = this\._wysiwygCellEditing;/,
    '拖拽启动未记录按下前已存在的格编辑');
  assert.match(src, /this\._wysiwygCellEditing !== st\.cellEditAtDown\) this\._wysiwygEndCellEdit\(false\);/,
    '阈值块应只取消「本次按下才触发」的格编辑（取消已存在的编辑会丢内容）');
  const up = src.indexOf('_wysiwygTableDragUp() {');
  const upEnd = up >= 0 ? src.indexOf('_wysiwygTableDragCancel', up) : -1;
  assert.ok(up >= 0 && upEnd > up, '找不到 _wysiwygTableDragUp 函数体');
  assert.match(src.slice(up, upEnd), /if \(this\._wysiwygCellEditing\) this\._wysiwygEndCellEdit\(true, false\);/,
    '拖拽释放（已移动）必须先在源码重建前提交已存在的格编辑');
});

test('引用 + 行内语法渲染化：活动块 > 前缀灰显/左竖条，行内标记透明/文本渲染（2026-10-14 用户要求，Typora 式）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(src, /function parseWysiwygInlineSpans\(text\)/, '缺少行内语法单遍扫描纯函数 parseWysiwygInlineSpans');
  for (const c of ['wysiwyg-inline-marker', 'wysiwyg-bold', 'wysiwyg-italic', 'wysiwyg-inline-code',
    'wysiwyg-strike', 'wysiwyg-highlight', 'wysiwyg-inline-link']) {
    assert.match(src, new RegExp(c), '缺少行内类 ' + c);
  }
  // 2026-10-20 用户要求：引用样式与渲染态完全一致、> 只在光标行显示
  assert.match(src, /wysiwyg-quote-slot/, '缺少引用 > 槽类（24px 固定槽 + 竖条 ::before）');
  // 空格必须随 > 进槽（行尾零宽 span 会让 Chromium caret 锚定写乱 DOM 差分、
  // 源空格被挤到行尾，2026-10-20 实测）→ 不得再有独立的零宽空格槽
  assert.match(src, /line\[end\] === ' ' \|\| line\[end\] === '\\t'\) end\+\+/, '空格未随 > 进 24px 槽');
  assert.doesNotMatch(src, /wysiwyg-quote-space/, '引用空格零宽槽复活（行尾 caret 锚定写乱模型）');
  assert.match(src, /wysiwyg-quote-line/, '缺少引用行类（淡色背景盒 + 边缘/嵌套 padding）');
  assert.match(src, /wysiwyg-quote-cursor-line/, '缺少引用光标行类（> 只在光标行显示）');
  assert.match(src, /_setWysiwygQuoteCurClass\(/, '缺少引用光标行类的挂/撤方法');
  assert.match(src, /wysiwyg-quote-text/, '缺少引用正文预览字体类');
  // 排除项：围栏（代码内容）/表格（格编辑独立机制）/frontmatter 不得参与行内解析
  const dIdx = src.indexOf('_wysiwygApplyActiveDecor');
  const dBody = src.slice(dIdx, src.indexOf('_ensureWysiwygActiveDecorHook'));
  assert.match(dBody, /isFenceBlock/, '围栏块未排除行内解析（代码内容里的 ** 会被误判粗体）');
  assert.match(dBody, /isTableBlock/, '表格块未排除行内解析');
  assert.match(dBody, /isFrontmatter/, 'frontmatter 未排除行内解析（YAML 行会误判行内语法）');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // 2026-10-20：引用活动态 = 渲染 blockquote 几何复现（淡色盒 + 连续 4px 竖条 + 24px 缩进槽）
  assert.match(css, /pre\.wysiwyg-quote-line \{[^}]*var\(--accent-subtle\)/, '引用活动行未画渲染淡色背景盒');
  assert.match(css, /\.wysiwyg-quote-slot \{[^}]*width: 24px;[^}]*height: 1\.7em;[^}]*vertical-align: top;/,
    '引用 > 槽未固定 24px（= 渲染 border 4 + padding 20，正文缘才与渲染态同位）');
  assert.match(css, /\.wysiwyg-quote-slot::before \{[^}]*width: 4px;[^}]*height: 100%;[^}]*var\(--accent-color\)/,
    '引用左竖条未用 4px 连续竖条（渲染 border-left 4px accent-color；top:0/height:100% 才无缝）');
  assert.match(css, /pre\.wysiwyg-quote-line\.wysiwyg-block-edge-top \{[^}]*padding-top: 12px/, '引用首行未补渲染盒 padding-top 12px');
  assert.match(css, /pre\.wysiwyg-quote-line\.wysiwyg-block-edge-bottom \{[^}]*padding-bottom: 28px/, '引用末行未补 28px（盒 padB 12 + BFC 收进遮罩的盒 mb 16，缺了进编辑态块下内容上跳）');
  assert.match(css, /wysiwyg-quote-nested\.wysiwyg-block-edge-bottom \{[^}]*padding-bottom: 40px/, '嵌套末行未相加各段 padding（12 嵌套 + 12 盒 + 16 盒 mb）');
  assert.match(css, /span\[class\*="wysiwyg-quote-slot"\] \{\s*\n\s*color: transparent;/, '引用 > 槽默认未透明（应只在光标行显示）');
  // 2026-10-28 S89 口径更新：嵌套光标行只显最内层一个 >（slot-inner 标记），外层各层 >
  // 在光标行也透明 → 显色规则从「光标行全部槽」收口到「光标行 slot-inner 槽」
  assert.match(css, /wysiwyg-quote-cursor-line span\[class\*="wysiwyg-quote-slot-inner"\] \{[^}]*var\(--text-secondary\)/, '光标行 > 标志未显色（S89：仅最内层 slot-inner）');
  assert.match(css, /\.wysiwyg-inline-marker \{[^}]*color: transparent/, '行内标记未透明');
  // 标记须零宽（2026-10-20 用户截图 demo.md：渲染态与编辑态差异巨大——透明保留宽度
  // 每对 ** 留 14.6px 空隙、密集 token 行被撑多折一行）；口径同 .wysiwyg-ol-space：
  // inline-block + width:0 + nowrap（font-size:0 会扰动行盒基线，禁用）
  assert.match(css, /\.wysiwyg-inline-marker \{[^}]*display: inline-block;[^}]*width: 0;[^}]*white-space: nowrap;/,
    '行内标记未零宽（活动态留标记宽空隙，与渲染态不一致）');
  assert.doesNotMatch(css, /\.wysiwyg-inline-marker \{[^}]*font-size: 0/, '行内标记零宽误用 font-size:0（扰动行盒基线，口径须同 ol-space）');
  // 列表符号/任务前缀不得被本规则波及（各有专槽与 ::before 符号）
  assert.doesNotMatch(css, /\.wysiwyg-inline-marker[^{]*,\s*\n\s*\.wysiwyg-list-bullet/, '行内标记零宽规则误挂列表符号类');
  assert.doesNotMatch(css, /\.wysiwyg-list-bullet \{[^}]*width: 0/, '列表符号被零宽（会破坏 ::before 画圆几何）');
  // S95（2026-10-29 用户截图：编辑态 chip 内部文字左右间隔 ≠ 渲染态）：横 padding 各 6px
  // ≡ 渲染 .preview-content code（2px 6px）；竖 padding 必须 0（行盒 27.2px 不变式）
  assert.match(css, /\.wysiwyg-inline-code \{[^}]*padding: 0 6px;/,
    '行内代码 chip 左右内距须 6px ≡ 渲染态（padding: 0 6px，竖向 0 保行盒，S95）');
  // S96（2026-10-29 用户截图：高亮橙底内部文字左右间隔 ≠ 渲染态 mark padding: 1px 4px）
  assert.match(css, /\.wysiwyg-highlight \{[^}]*padding: 0 4px;/,
    '高亮左右内距须 4px ≡ 渲染 mark（padding: 0 4px，竖向 0 保行盒，S96）');
  // S97（2026-10-29 用户截图：高亮橙底高度不一致——实测 16px 基准渲染 mark 盒 29.19 /
  // 遮罩 mark 盒 27.19 / 源文态 inline 盒 21）：
  // ① 源文态 highlight = inline-block（盒 = 行盒基准 27.19，实测行盒不撑）+ padding 0 4px；
  // ② 遮罩/源文态视觉加高 2px 一律 box-shadow ±1px（纯绘制零布局；竖 padding 恢复会撑
  //    行盒破 S90① 块高不变式，禁用）
  assert.match(css, /\.wysiwyg-highlight \{[^}]*display: inline-block;/,
    '源文态高亮须 inline-block（盒 = 行盒基准 27.19，inline 盒 = 字体度量 21 会矮 6px，S97）');
  assert.match(css, /\.wysiwyg-highlight \{[^}]*box-shadow: 0 -1px 0 0 var\(--color-warning\), 0 1px 0 0 var\(--color-warning\);/,
    '源文态高亮视觉盒高须 box-shadow ±1px 加到 ≡ 渲染 mark 29.19（竖 padding 0 保行盒，S97）');
  assert.match(css, /\.wysiwyg-block-mask mark \{[^}]*padding-top: 0;[^}]*padding-bottom: 0;[^}]*box-shadow: 0 -1px 0 0 var\(--color-warning\), 0 1px 0 0 var\(--color-warning\);/,
    '遮罩 mark 竖 padding 须 0 + box-shadow ±1px（视觉盒 ≡ 渲染 mark、行盒不变，S97）');
});

test('行内代码 backtick 状态机 + 边缘空格剥离 + 语法边界对齐渲染态（2026-10-29 S93/S98）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const pIdx = wsrc.indexOf('function parseWysiwygInlineSpans(text) {');
  assert.ok(pIdx > 0, '缺 parseWysiwygInlineSpans');
  const pblk = wsrc.slice(pIdx, pIdx + 6000);
  // S98：code span = CommonMark backtick run 状态机（数 run 长 N → 恰为 N 的 run 闭合 →
  // 失败整 run 字面量、run 尾继续）；旧 reCode 正则的左起匹配错位与内容式残差已被取代
  assert.match(pblk, /const codeSpanAt = \(pos\)/, '缺 code span backtick run 状态机（S98）');
  assert.match(pblk, /if \(r === n\)/, 'code span 闭合须为「恰为 N」的 run（```a`` 不被双闭合，≡ remark）');
  // S98：正则分支须「就地」匹配（左起匹配恰在 slice 0）——旧实现把 index>0 的匹配按
  // start=i 消费 → **x* / [a [b](c) / `` `a` 三类 span 整体错位（编辑态 ≠ 渲染态）
  assert.match(pblk, /return \(m && m\.index === 0\) \? m : null;/,
    '缺语法分支 index-0 守卫（S98：触发字符处不就地成语法时不得消费后续匹配）');
  // CommonMark 边缘空格规则：内容首尾空格（非全空格）各剥一个，chip 宽 ≡ 渲染 <code>
  assert.match(pblk, /cTo - cFrom >= 2 && s\.charAt\(cFrom\) === ' ' && s\.charAt\(cTo - 1\) === ' ' && s\.slice\(cFrom \+ 1, cTo - 1\)\.trim\(\) !== ''/,
    '缺 code span CommonMark 边缘空格剥离（编辑态 chip 比渲染 <code> 宽，编辑≠渲染）');
  // 行为（同 guardMathBlocks 提取先例：纯函数、无闭包依赖，直接从源提取执行）
  const eIdx = wsrc.indexOf('\n  const mixin = {', pIdx);
  assert.ok(eIdx > pIdx, 'parseWysiwygInlineSpans 函数尾未定位');
  const fnSrc = wsrc.slice(pIdx, eIdx).trim();
  const fn = eval('(' + fnSrc + ')');
  assert.equal(typeof fn, 'function', '提取的 parseWysiwygInlineSpans 不是函数');
  const codes = (t) => fn(t).filter((x) => x.cls === 'wysiwyg-inline-code');
  // —— S93 回归 ——
  const t1 = '用 `` ` `` 包裹';
  const c1 = codes(t1);
  assert.equal(c1.length, 1, '`` ` `` 应恰产生 1 个 code span（S93 修复前为跨段级联假 span）');
  assert.equal(t1.slice(c1[0].from, c1[0].to), '`', 'code span 内容 = 单反引号（边缘空格剥离，≡ 渲染 <code>`</code>）');
  const t2 = '变量名 `userName`、命令 `npm install`';
  assert.deepEqual(codes(t2).map((x) => t2.slice(x.from, x.to)), ['userName', 'npm install'],
    '单引号代码 span 回归（修复前该两 span 的反引号被 `` ` `` 失配后的级联吞掉）');
  const t3 = '前 ` b ` 后';
  assert.equal(codes(t3).length, 1, '单引号 code span 数');
  assert.equal(t3.slice(codes(t3)[0].from, codes(t3)[0].to), 'b', '单引号 code span 边缘空格剥离（CommonMark，≡ 渲染）');
  const t4 = '`**text**` 与 **粗体**';
  assert.deepEqual(codes(t4).map((x) => t4.slice(x.from, x.to)), ['**text**'], '回归：`**text**` 代码 span 内容不变');
  assert.ok(fn(t4).some((x) => x.cls === 'wysiwyg-bold'), '回归：bold span 不受扫描器改动影响');
  const t4b = 'a `b``c` d';
  assert.deepEqual(codes(t4b).map((x) => t4b.slice(x.from, x.to)), ['b``c'],
    'S98：短于开 run 的反引号在内容内（`b``c` ≡ 渲染 <code>b``c</code>，旧正则错拆两 chip）');
  // —— S98：语法边界对齐渲染态（≡ remark 渲染输出实测）——
  const t5 = '**x*';
  const it5 = fn(t5).filter((x) => x.cls === 'wysiwyg-italic');
  assert.equal(it5.length, 1, '**x* 应恰 1 个 italic span');
  assert.equal(t5.slice(it5[0].from, it5[0].to), 'x', '**x* 斜体须精确落 x（S98 前落在第 2 个 * 上，≠ 渲染 *<em>x</em>）');
  assert.equal(fn(t5).filter((x) => x.cls === 'wysiwyg-bold').length, 0, '**x* 不成 bold（渲染亦无 strong）');
  const t6 = '[a [b](c)';
  const lk6 = fn(t6).filter((x) => x.cls === 'wysiwyg-inline-link');
  assert.equal(lk6.length, 1, '[a [b](c) 应恰 1 个 link span');
  assert.equal(t6.slice(lk6[0].from, lk6[0].to), 'b', '[a [b](c) 链接须精确落 b（S98 前 a 着链接色，≠ 渲染 [a <a>b</a>）');
  const t7 = '`` `a` 尾巴';
  const c7 = codes(t7);
  assert.equal(c7.length, 1, '`` `a` 应恰 1 个 code span（S98 前孤立反引号上出假 chip）');
  assert.equal(t7.slice(c7[0].from, c7[0].to), 'a', '`` `a` = 字面 `` 后 `a` 成 span（≡ 渲染 `` <code>a</code>）');
  assert.equal(codes('```a`` b').length, 0, '```a`` 无 code span（三重 run 无三重闭合 = 全字面量，≡ 渲染）');
  const t8 = '~~a ~b~';
  assert.equal(fn(t8).filter((x) => x.cls === 'wysiwyg-strike').length, 0, '~~a ~b~ 不成删除线（渲染全字面）');
  const t9 = '==a =b=';
  assert.equal(fn(t9).filter((x) => x.cls === 'wysiwyg-highlight').length, 0, '==a =b= 不成高亮（渲染全字面）');
  const t10 = '_x _y_';
  const it10 = fn(t10).filter((x) => x.cls === 'wysiwyg-italic');
  assert.equal(it10.length, 1, '_x _y_ 应恰 1 个 italic span');
  assert.equal(t10.slice(it10[0].from, it10[0].to), 'y', '_x _y_ 斜体须精确落 y（≡ 渲染 _x <em>y</em>）');
  // —— 常规回归（S98 改动不伤正常匹配）——
  const t11 = '**粗体** 和 *斜体* 和 ~~删除~~ 和 ==高亮== 和 [链接](url) 和 <u>下划</u>';
  assert.deepEqual(fn(t11).filter((x) => !x.cls.endsWith('marker')).map((x) => t11.slice(x.from, x.to)),
    ['粗体', '斜体', '删除', '高亮', '链接', '下划'], '六类语法 span 内容回归');
  assert.equal(fn('snake_case 不变').length, 0, 'snake_case 词内守卫回归');
});

test('底部滚动余量：padding-bottom 50vh 且特异性须压过 codemirror.css（2026-10-14 + 2026-10-17 真机：文末贴底缘）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // 须同时覆盖 app 挂载点（#editor-wrapper，editor-core.js）与 harness 挂载点（#editor）
  assert.match(css, /#editor-wrapper \.CodeMirror-lines,\s*\n\s*#editor \.CodeMirror-lines \{[^}]*padding-bottom: 50vh;/,
    '缺少底部滚动余量（内容底缘即滚动底缘，编辑底部行不便）');
  // 不得回退裸 .CodeMirror-lines 规则：真实 app 的 index.html 中 styles.css 先于
  // codemirror.css 加载，后者 .CodeMirror-lines { padding: 4px 0 }（shorthand）会以
  // 同特异性覆盖裸规则 → 50vh 失效（harness 顺序相反，套件测不出，2026-10-17 真机复现）
  assert.doesNotMatch(css, /(^|\})\.CodeMirror-lines \{[^}]*padding-bottom: 50vh;/,
    '底部滚动余量不得用裸 .CodeMirror-lines 选择器（被后加载的 codemirror.css 覆盖）');
});

test('异步 pass 刷新风暴守卫：仅块内含 img/mermaid/[TOC] 才启动 pass 链（卡死回归）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const pIdx = wsrc.indexOf('_wysiwygPostProcessAsync(node, idx) {');
  assert.ok(pIdx > 0, '缺少 _wysiwygPostProcessAsync');
  const pblk = wsrc.slice(pIdx, pIdx + 2500);
  // 三个存在性守卫：无内容可处理的块不得进入 pass 链（no-op promise 的 then 仍会触发 refresh）
  assert.match(pblk, /querySelector\('img'\) != null|querySelector\('img'\)/, '缺 img 存在性守卫（无图片块也跑 prepareImages → 每块一次 cm.refresh 风暴）');
  assert.match(pblk, /code\.language-mermaid/, '缺 mermaid 存在性守卫');
  // 源码里 [TOC] 是转义字面量 \[TOC\]，按 hasToc 守卫变量 + TOC 字样匹配
  assert.match(pblk, /hasToc = node\.querySelectorAll[\s\S]{0,160}?TOC/, '缺 [TOC] 段存在性守卫');
});

test('ref 定义行 / 孤闭合标签块：渲染器输出零高度占位 + 判据 + CSS 塌缩（阅读模式对齐）', () => {
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  // 源文本为 REF_DEF_LINE = /^\s{0,3}\[：`^` 需 \^ 转义，源里的反斜杠需 \\ 匹配
  assert.match(rsrc, /REF_DEF_LINE = \/\^\\s\{0,3\}\\\[/, '缺少 ref 定义行判定正则');
  assert.match(rsrc, /function isOnlyLinkRefDefs\(slice\)/, '缺少「整块纯定义」判据函数');
  // 2026-07-13 demo.md 审计：尾部孤立 </p> 行渲染为空，WYSIWYG 源码裸露而阅读模式不可见
  // → 与 ref 定义同法输出零高度占位；判据扩为「纯定义行 | 纯孤闭合标签行」
  assert.match(rsrc, /STRAY_CLOSE_TAG_LINE = \/\^\\s\{0,3\}<\\s\*\\\/\[a-zA-Z\]/, '缺少孤闭合标签行判定正则');
  assert.match(rsrc, /function isOnlyStrayClosingTags\(slice\)/, '缺少「整块纯孤闭合标签」判据函数');
  assert.match(rsrc, /html === '' && slice\.trim\(\) && !renderFailed &&[\s\S]{0,40}\(isOnlyLinkRefDefs\(slice\) \|\| isOnlyStrayClosingTags\(slice\)\)/,
    '占位必须三条件（空 html + 未渲染失败 + 纯定义/纯孤闭合行）——渲染失败的块保持源码可见');
  assert.match(rsrc, /renderFailed = true;/, '渲染失败未标记（失败空块会被误隐藏）');
  assert.match(rsrc, /<div class="wysiwyg-block-hidden"><\/div>/, '占位输出缺失');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.wysiwyg-block-hidden \{\s*height: 0;\s*overflow: hidden;/, '缺占位塌缩 CSS（height:0 + overflow:hidden）');
});

test('未闭合裸 HTML 容器块合并：块表并到闭标签行 + 白名单按管线实测（demo.md details 审计）', () => {
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  // 白名单：rehype-sanitize + parse5 全串重解析实测会「保持打开并吞并后续内容」的标签才合并；
  // p/table 族/form/html 实测不合并（两模式同样片段化，天然一致）不得入名单
  const setStart = rsrc.indexOf('const OPEN_CONTAINER_TAGS = new Set([');
  assert.ok(setStart > 0, '缺少未闭合容器合并白名单');
  const setBody = rsrc.slice(setStart, setStart + 800);
  assert.match(setBody, /'details',/, '白名单须含 details（demo.md 折叠块实测合并）');
  assert.match(setBody, /'figure',/, '白名单须含 figure（审计实测合并）');
  assert.doesNotMatch(setBody, /'p',/, "p 误入合并白名单（浏览器遇下一块即隐式闭合，实测不合并）");
  assert.doesNotMatch(setBody, /'table'/, 'table 误入合并白名单（parse5 表格解析特殊，实测不合并）');
  assert.match(rsrc, /OPEN_CONTAINER_TAGS\.has\(tag\)/, '合并循环未查白名单');
  // 合并循环：首行开标签判定 + 块内已闭合跳过 + 围栏感知扫描闭标签行 + 600 行上限
  assert.match(rsrc, /first && first\.match\(/, '缺少块首开标签判定');
  assert.match(rsrc, /om\[2\]\.trim\(\)\.endsWith\('\/'\)\) continue; \/\/ 自闭合/, '未排除自闭合开标签');
  assert.match(rsrc, /\.test\(val\)\) continue; \/\/ 块内已闭合/, '未跳过块内已闭合容器');
  assert.match(rsrc, /fence = fm\[1\]\[0\];/, '闭标签扫描未跟踪围栏代码块（代码里的 </div> 文本会提前截断）');
  assert.match(rsrc, /b\.end \+ 600/, '闭标签扫描缺上限（病态文档会扫穿全文）');
  // 合并必须在「相邻/重叠段合并」之前（吞掉的块靠后者收编）
  assert.ok(rsrc.indexOf("if (found > b.end) b.end = found;") < rsrc.indexOf('相邻/重叠段合并'), '容器合并在重叠段合并之后，吞掉的块收不进去');
});

test('公式 guard：反斜杠转义 + 反引号状态行局部（demo.md L963 \\`` 失同步审计，2026-07-13）', () => {
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  const gIdx = rsrc.indexOf('function guardMathBlocks(content) {');
  assert.ok(gIdx > 0, '缺少 guardMathBlocks');
  const gblk = rsrc.slice(gIdx, gIdx + 6500);
  // 行局部：行内代码跨度不能跨行（CommonMark：backtick string 不能含行结束符）。
  // 缺行重置时，某行游离的奇数反引号（如转义表 \``）会翻转 inBacktick，
  // 使其后整篇「反引号内 $...$」被误判为数学占位 → 占位在 <code> 内被转义后
  // restore 匹配不到 → 阅读/遮罩残留 <!--MATHBLOCK_N--> 字面垃圾。
  assert.match(gblk, /if \(content\[i\] === '\\n' \|\| content\[i\] === '\\r'\) \{\s*inBacktick = false;\s*inDoubleBacktick = false;/,
    '反引号状态未在换行重置（行内代码跨度按 CommonMark 不能跨行，状态必须行局部）');
  // 反斜杠转义：`\`` = 字面反引号（不翻 inBacktick）、`\$` = 字面美元（不开数学）。
  // 源文件里条件写作 content[i] === '\\' && i + 1 < len && (content[i + 1] === '`' || content[i + 1] === '$')
  assert.match(gblk, /content\[i\] === '\\\\' && i \+ 1 < len && \(content\[i \+ 1\] === '`' \|\| content\[i \+ 1\] === '\$'\)/,
    '缺少反斜杠转义分支（\\`` 会翻转 inBacktick，\\$ 会误开数学）');
  // 行为（与审计脚本同款：从源提取 guard 及其依赖直接执行；bundle 的 Node 加载
  // 因内联浏览器模块初始化引用 document 不可用）
  function extractFn(name) {
    const start = rsrc.indexOf('function ' + name + '(');
    assert.ok(start >= 0, '提取失败: ' + name);
    let i = rsrc.indexOf('{', start), depth = 0;
    for (let j = i; j < rsrc.length; j++) {
      if (rsrc[j] === '{') depth++;
      else if (rsrc[j] === '}') { depth--; if (depth === 0) return rsrc.substring(start, j + 1); }
    }
    assert.fail('提取失败（花括号失衡）: ' + name);
  }
  const fns = ['looksLikeMath', 'looksLikeLatexMath', 'isAtBlockStart', 'escapeHTML', 'guardMathBlocks'].map(extractFn).join('\n');
  const guard = new Function(fns + '\nreturn guardMathBlocks;')();
  // 最小复现（demo.md L963 转义表行 + 其后反引号内 $...$）：
  const repro = '| 转义写法 | 显示效果 |\n| --- | --- |\n| ``\\` `` | \\` 字面反引号 |\n\n除 `$...$` 行内公式外。';
  const r = guard(repro);
  assert.ok(r.content.indexOf('MATHBLOCK') < 0, '转义反引号翻转状态 → 其后反引号内 $...$ 被误判为数学占位');
  assert.match(r.content, /除 \`\$\.\.\.\$\` 行内公式外/, '反引号内 $...$ 必须保持反引号包裹原样（交 remark 渲染代码跨度）');
  // 正常数学不受影响
  const r2 = guard('公式 $E = mc^2$ 正常');
  assert.strictEqual(r2.placeholders.length, 1, '真实行内数学必须仍被保护为占位');
  assert.strictEqual(r2.placeholders[0].text, '$E = mc^2$');
});

test('遮罩排版同步：行高必须是无单位比率，不得写 getComputedStyle 的 px 已解析值', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const tIdx = wsrc.indexOf('_wysiwygMaskTypography(node) {');
  assert.ok(tIdx > 0, '缺少 _wysiwygMaskTypography');
  const tblk = wsrc.slice(tIdx, tIdx + 1600);
  // 2026-07-13 demo.md 审计：cs.lineHeight 是字号 16px 下已解析的 27.2px——写成
  // 遮罩内联样式后是固定 px，sub/sup 等小字号元素（0.75em）的行高不再随字号等比
  // 缩放，而阅读模式是无单位 1.7 随字号走 → 含上下标的行遮罩 37.7 vs 阅读 33.2。
  assert.doesNotMatch(tblk, /node\.style\.lineHeight = cs\.lineHeight;/,
    '行高不得直接写计算值 px（sub/sup 行高失配）');
  assert.match(tblk, /this\.preview\.style && this\.preview\.style\.lineHeight/,
    '行高须优先取 #preview 作者值（applySettings 写无单位 String(s.lineHeight)）');
  assert.match(tblk, /a \/ f > 0\.5 && a \/ f < 4/,
    '作者值缺失时须从计算值反推无单位比率（绝不落 px 固定值）');
});

test('普通文字段落不挂块级「编辑」按钮（2026-07-13 用户要求；点文字即编辑）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 判定函数：渲染结果恰为单个 <p> 且不含 img（点图开灯箱，吞点击映射）/ .katex（公式非普通文字）
  const pIdx = wsrc.indexOf('_wysiwygMaskIsPlainText(node) {');
  assert.ok(pIdx > 0, '缺少普通文字段落判定 _wysiwygMaskIsPlainText');
  const pblk = wsrc.slice(pIdx, pIdx + 700);
  assert.match(pblk, /node\.children\.length !== 1/, '普通文字须是单个顶层元素');
  assert.match(pblk, /first\.tagName !== 'P'/, '普通文字顶层元素须是 <p>（表格/围栏/引用/占位 div 自然保留按钮）');
  assert.match(pblk, /querySelector\('img'\)/, '含图片的段落须保留按钮（点图片开灯箱，点不到源码）');
  assert.match(pblk, /querySelector\('\.katex'\)/, '含公式的段落须保留按钮（公式非普通文字，保守保留）');
  // 接线：普通文字 → no-btn 类（14px 底边距补回，与列表同款，遮罩不矮 14px）
  assert.match(wsrc, /else if \(this\._wysiwygMaskIsPlainText\(node\)\) node\.classList\.add\('wysiwyg-mask-no-btn'\);/,
    '普通文字段落未挂 no-btn（撤按钮后 p 的 14px 底边距被清零，遮罩矮一截）');
  // 顺序：TOC 判定必须先于普通文字（[TOC] 行异步替换目录前遮罩就是单个 <p>，
  // 先判普通文字会漏掉「删除」按钮）
  assert.ok(wsrc.indexOf('else if (isTocBlock) this._addWysiwygTocDeleteButton(node);')
    < wsrc.indexOf("else if (this._wysiwygMaskIsPlainText(node)) node.classList.add('wysiwyg-mask-no-btn');"),
    'TOC 判定未先于普通文字判定（[TOC] 漏挂删除按钮）');
  // no-btn 的底边距补回仍在（14px 边距族：ul/ol/p）
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /wysiwyg-mask-no-btn > \*?:last-child \{ margin-bottom: 14px; \}/, 'no-btn 14px 底边距补回缺失');
});

test('预渲染带 loading 覆盖层：挂起至遮罩挂完、按代配对释放（不残留/不早放）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 释放助手：按代（gen）配对，错代不得消费（新一代预渲染持有自己的 loading 层）
  assert.match(wsrc, /_wysiwygReleasePreRenderLoad\(\) \{[\s\S]{0,420}this\._wysiwygPreRenderLoadGen !== this\._wysiwygPreRenderGen[\s\S]{0,240}this\._endPaneLoad\(\);/,
    '缺少 _wysiwygReleasePreRenderLoad（按代配对的 loading 层释放）');
  const bIdx = wsrc.indexOf('beginWysiwygPreRender() {');
  assert.ok(bIdx > 0, '缺少 beginWysiwygPreRender');
  const bblk = wsrc.slice(bIdx, bIdx + 4200);
  // 打开 loading 层并标记本代持有（setTimeout 闭包内是 self.，this 不指向 mixin 对象）
  assert.match(bblk, /this\._beginPaneLoad\(\)/, '预渲染开始未调 _beginPaneLoad（用户看到全屏源码数秒）');
  assert.match(bblk, /this\._wysiwygPreRenderLoadOpen = true/, '预渲染开始未标记 loading 层持有（释放配对错乱）');
  assert.match(bblk, /this\._wysiwygPreRenderLoadGen = gen/, '未记录持有 loading 层的代（新预渲染启动会吃掉旧覆盖层）');
  // 完成路径**不得**裸调 _endPaneLoad 提前释放：applyViewMode 的 50ms 计时器之后还要挂全部
  // 遮罩（数秒同步步骤），早放 = 「loading 消失 → 源码/空白数秒」（2026-10-13 用户反馈 #1）
  assert.ok(!/self\._endPaneLoad\(\)/.test(bblk), 'beginWysiwygPreRender 内仍裸调 _endPaneLoad（应按代经助手释放）');
  assert.match(bblk, /self\._wysiwygReleasePreRenderLoad\(\);/, '预渲染中止路径未收尾 loading 层（覆盖层残留）');
  const cIdx = wsrc.indexOf('_cancelWysiwygPreRender() {');
  assert.ok(cIdx > 0, '缺少 _cancelWysiwygPreRender');
  const cblk = wsrc.slice(cIdx, cIdx + 900);
  const relAt = cblk.indexOf('this._wysiwygReleasePreRenderLoad()');
  const bumpAt = cblk.indexOf('_wysiwygPreRenderGen = (this._wysiwygPreRenderGen || 0) + 1');
  assert.ok(relAt > 0 && (bumpAt < 0 || relAt < bumpAt),
    '取消预渲染未先于 gen 推进释放 loading 层（按代配对会失败，覆盖层残留）');
  // renderWysiwygMasks 挂完遮罩（含 refresh/冲刷异步 pass）才在 finally 释放——所有提前返回路径同样收尾
  const rIdx = wsrc.indexOf('renderWysiwygMasks() {');
  assert.ok(rIdx > 0, '缺少 renderWysiwygMasks');
  assert.match(wsrc.slice(rIdx, rIdx + 3400), /finally \{[\s\S]{0,80}this\._wysiwygReleasePreRenderLoad\(\);/,
    'renderWysiwygMasks 未在 finally 释放预渲染 loading 层（早放露源码/残留）');
  // 离开所见即所得（快切模式会清掉 50ms 计时器、renderWysiwygMasks 永不执行）也要收尾
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const aIdx = themeSrc.indexOf('applyViewMode() {');
  assert.ok(aIdx > 0, '缺少 applyViewMode');
  assert.match(themeSrc.slice(aIdx, aIdx + 1500),
    /viewMode !== 'wysiwyg'[\s\S]{0,220}this\._wysiwygReleasePreRenderLoad\(\);/,
    'applyViewMode 离开所见即所得时未收尾仍持有的预渲染 loading 层');
});

test('切标签进 wysiwyg 走预渲染管线（不裸奔源码）+ renderWysiwygMasks 预渲染期守卫', () => {
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const sIdx = themeSrc.indexOf('syncViewModeToTab() {');
  assert.ok(sIdx > 0, '缺少 syncViewModeToTab');
  const sblk = themeSrc.slice(sIdx, sIdx + 2000);
  assert.match(sblk, /if \(target === 'wysiwyg'\)/, '切标签未对 wysiwyg 目标单列分支');
  assert.match(sblk, /this\.beginWysiwygPreRender && this\.beginWysiwygPreRender\(\)/, '切标签进 wysiwyg 未走 beginWysiwygPreRender（大文档会同步 precompute 数秒源码裸奔）');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const rIdx = wsrc.indexOf('renderWysiwygMasks() {');
  assert.ok(rIdx > 0, '缺少 renderWysiwygMasks');
  assert.match(wsrc.slice(rIdx, rIdx + 400), /if \(this\._wysiwygPreRendering\) return;/, '预渲染在飞时 renderWysiwygMasks 未跳过（会消费到旧块表/空块表）');
});

test('块「编辑」按钮：非列表块挂载 + 列表块豁免（点行即编辑）+ 点击先取区间再解罩 + 右键放行 + i18n/CSS 齐备', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /_addWysiwygEditButton\(node\) \{/, '缺少 _addWysiwygEditButton');
  const eIdx = wsrc.indexOf('_addWysiwygEditButton(node) {');
  const eblk = wsrc.slice(eIdx, eIdx + 1200);
  assert.match(eblk, /class\.\.\.|'block-edit-btn'/, '按钮缺 block-edit-btn 类');
  assert.match(eblk, /t\('editBlock'\)/, '按钮文案未走 i18n');
  assert.match(eblk, /querySelector\('button\.block-edit-btn'\)/, '按钮未做去重（重复挂）');
  // 列表块豁免（2026-10-16 用户反馈 #1）：maskWysiwygBlock 按块首行判列表，列表不挂按钮、
  // 改挂 no-btn 类（补回 14px 底边距，遮罩高度与有按钮时一致）
  assert.match(wsrc, /_wysiwygBlockIsList\(b\) \{/, '缺少 _wysiwygBlockIsList（列表块判据）');
  const lIdx = wsrc.indexOf('_wysiwygBlockIsList(b) {');
  const lblk = wsrc.slice(lIdx, lIdx + 700);
  assert.match(lblk, /\^\s*\\s\{0,3\}\(\[-\*\+\]\|\\d\{1,9\}\[\.\)\]\)\(\\s\|\$\)/,
    '列表判据未用「≤3 空格 + 列表标记，后随空格/Tab/行尾」CommonMark 口径（`1.` 独占一行也是合法标记）');
  const mkIdx = wsrc.indexOf('maskWysiwygBlock(idx) {');
  const mkblk = wsrc.slice(mkIdx, mkIdx + 4000);
  assert.match(mkblk, /_wysiwygBlockIsList\(b\)\) \{\n\s*node\.classList\.add\('wysiwyg-mask-no-btn'\);/, '列表块遮罩未挂 no-btn 类（ul 成 last-child 后 14px 边距被清零、遮罩矮 14px）');
  // 列表逐项块（2026-10-21 用户反馈：点列表项只该项显源码、兄弟项保持渲染）：非末项
  // 片段挂 wysiwyg-mask-li-mid（把 ul/ol 底距清零 → 片段底缘 = li 底缘 + 4px 项间距；
  // 14px 列表底距只归属末项），叠起来的逐项片段总高与整列表遮罩逐像素一致。
  assert.match(mkblk, /b\.listItem && b\.listItemPos !== 'last'\) node\.classList\.add\('wysiwyg-mask-li-mid'\);/, '非末项列表片段未挂 wysiwyg-mask-li-mid（项间距底缘失配，切项跳动）');
  // 标题块豁免（2026-10-19 用户反馈 #1：点标题行即编辑，按钮多余）：单行 ATX 标题判据 +
  // no-btn-heading 类（与列表 no-btn 同一机制，补回 12px 底边距 = 预览 h1–h6 统一 margin-bottom）
  assert.match(wsrc, /_wysiwygBlockIsHeading\(b\) \{/, '缺少 _wysiwygBlockIsHeading（标题块判据）');
  const hIdx = wsrc.indexOf('_wysiwygBlockIsHeading(b) {');
  const hblk = wsrc.slice(hIdx, hIdx + 500);
  assert.match(hblk, /b\.end - b\.start !== 1/, '标题判据未限定单行块');
  assert.match(hblk, /\^\\s\{0,3\}#\{1,6\}\(\\s\|\$\)/, '标题判据未用 ATX（≤3 空格 + 1–6 个 #，后随空格/行尾）口径');
  assert.match(mkblk, /_wysiwygBlockIsHeading\(b\)\) node\.classList\.add\('wysiwyg-mask-no-btn-heading'\);/,
    '标题块遮罩未挂 no-btn-heading 类（标题成 last-child 后 12px 边距被清零、遮罩矮 12px）');
  assert.match(mkblk, /else this\._addWysiwygEditButton\(node\);/, 'maskWysiwygBlock 未在非列表/非标题块挂载编辑按钮');
  // CSS：no-btn 遮罩补回内容元素 14px 底边距（特异性须压过 last-child 清零规则）
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /wysiwyg-mask-no-btn > \*:last-child \{ margin-bottom: 14px; \}/, 'no-btn 遮罩未补回 14px 底边距（渲染↔源码切换块下内容跳动）');
  assert.match(css, /wysiwyg-mask-no-btn-heading > \*:last-child \{ margin-bottom: 12px; \}/,
    'no-btn-heading 遮罩未补回 12px 底边距（预览 h1–h6 margin-bottom 统一 12px）');
  // 点击：先 mark.find() 取块区间（撤罩后区间失效），再解罩 + 光标落块首
  const mIdx = wsrc.indexOf('button.block-edit-btn');
  assert.ok(mIdx > 0, '缺 block-edit-btn 的 mousedown 处理');
  const mblk = wsrc.slice(mIdx, mIdx + 900);
  assert.match(mblk, /mark\.find\(\)/, '编辑按钮点击未用 mark.find() 取块区间');
  assert.match(mblk, /setWysiwygActiveBlock/, '编辑按钮点击未解罩目标块');
  // 列表行精确落行（2026-10-16 用户反馈 #2）：点 <li> 内走 data-source-line（remark 插件
  // 标注的块切片内 1-based 行号）还原精确行，替代整块竖向比例估算（点中间项恒偏上一行）
  assert.match(wsrc, /ev\.target\.closest\('li'\)/, '列表行点击未取 <li> 目标（精确落行入口缺失）');
  const liIdx = wsrc.indexOf("ev.target.closest('li')");
  const liblk = wsrc.slice(liIdx, liIdx + 1500);
  assert.match(liblk, /data-source-line/, '列表行落点未用 data-source-line 标注');
  assert.match(liblk, /r\.from\.line \+ Math\.max\(0, srcLine - 1\)/, '列表行精确行号未按「块首行 + 标注行号 − 1」还原');
  assert.match(liblk, /!exactLine && rect\.height > 0/, '非列表项点击未保留比例估算回退');
  // 右键菜单放行（与 copy-btn 同待遇）
  const cmSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'context-menu.js'), 'utf8');
  assert.ok((cmSrc.match(/\.copy-btn, \.block-edit-btn/g) || []).length >= 2, 'context-menu 右键放行未含 block-edit-btn（两处 handler 都要）');
  // i18n 三语言
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  assert.ok((i18n.match(/editBlock: /g) || []).length >= 3, 'editBlock i18n 三语言不齐');
  // CSS：hover 显现 + 代码块块内让位复制按钮
  assert.match(css, /\.block-edit-btn \{/, '缺 .block-edit-btn 基础样式');
  assert.match(css, /\.wysiwyg-block-mask:hover \.block-edit-btn \{ opacity: 1/, '编辑按钮未在 hover 时显现');
  assert.match(css, /right: 76px/, '代码块块内编辑按钮未让位复制按钮');
});

test('[TOC] 块遮罩：不允许编辑、点击无反应、「编辑」改「删除」（2026-10-21 用户要求）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 判据：单行块 + 内容恰为 [TOC]（与 _wysiwygReplaceToc 的 <p> 匹配口径一致）
  assert.match(wsrc, /_wysiwygBlockIsToc\(b\) \{/, '缺少 _wysiwygBlockIsToc（TOC 块判据）');
  const tIdx = wsrc.indexOf('_wysiwygBlockIsToc(b) {');
  const tblk = wsrc.slice(tIdx, tIdx + 600);
  assert.match(tblk, /b\.end - b\.start !== 1/, 'TOC 判据未限定单行块');
  assert.match(tblk, /\^\\\[TOC\\\]\$\/i/, 'TOC 判据未用「内容恰为 [TOC]（大小写不敏感）」口径');
  // 挂遮罩时刻取判定（行号位移后块表刷新重建遮罩，生命周期内不变）
  assert.match(wsrc, /const isTocBlock = this\._wysiwygBlockIsToc\(b\);/, 'TOC 判定未在挂遮罩时刻捕获（闭包用 b.start 会随行号位移过期）');
  // 删除按钮：复用 block-edit-btn 位置/hover 样式 + data-toc-delete 标记 + i18n + 去重
  assert.match(wsrc, /_addWysiwygTocDeleteButton\(node\) \{/, '缺少 _addWysiwygTocDeleteButton');
  const dIdx = wsrc.indexOf('_addWysiwygTocDeleteButton(node) {');
  const dblk = wsrc.slice(dIdx, dIdx + 900);
  assert.match(dblk, /'block-edit-btn'/, 'TOC 删除按钮未复用 block-edit-btn 类（位置/hover 样式）');
  assert.match(dblk, /data-toc-delete/, 'TOC 删除按钮缺 data-toc-delete 标记（mousedown 识别）');
  assert.match(dblk, /t\('deleteToc'\)/, 'TOC 删除按钮文案未走 i18n');
  // maskWysiwygBlock 路由：TOC 挂删除按钮，其余（非列表/非标题）挂编辑按钮
  const mkIdx = wsrc.indexOf('maskWysiwygBlock(idx) {');
  const mkblk = wsrc.slice(mkIdx, mkIdx + 4000);
  assert.match(mkblk, /else if \(isTocBlock\) this\._addWysiwygTocDeleteButton\(node\);/, 'maskWysiwygBlock 未对 TOC 块挂删除按钮');
  // mousedown：TOC 遮罩内任何点击无反应（不映射源码行/不进编辑/不跳转）；
  // 保留先提交在编表格格；仅删除按钮有效（mark.find 取区间 + replaceRange 删源行）
  const gIdx = wsrc.indexOf('if (isTocBlock) {');
  assert.ok(gIdx > 0, '缺 TOC 遮罩 mousedown 无反应守卫');
  const gblk = wsrc.slice(gIdx, gIdx + 1600);
  assert.match(gblk, /_wysiwygEndCellEdit\(true, false\)/, 'TOC 遮罩点击未先提交在编表格格（格编辑会悬空）');
  assert.match(gblk, /closest\('button\[data-toc-delete\]'\)/, 'TOC 删除按钮未在 mousedown 识别');
  assert.match(gblk, /ev\.preventDefault\(\);\s*\n\s*if \(!tocDel\) return;/, 'TOC 遮罩点击未无反应返回（preventDefault 吞默认 + 不落行）');
  assert.match(gblk, /mark\.find\(\)/, 'TOC 删除未用 mark.find() 取实时块区间');
  assert.match(gblk, /replaceRange\('', from, to\)/, 'TOC 删除未用 replaceRange 删 [TOC] 源行');
  assert.match(gblk, /\(cm\.getLine\(s - 1\) \|\| ''\)\.trim\(\) === '' && \(cm\.getLine\(e \+ 1\) \|\| ''\)\.trim\(\) === ''/, 'TOC 删除未处理「块前后各一空行」连删前导换行（会留连续两个空行）');
  // i18n 三语言
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  assert.ok((i18n.match(/deleteToc: /g) || []).length >= 3, 'deleteToc i18n 三语言不齐');
});

test('光标行显示源码：行内标记真宽+次级色（2026-10-21 用户要求；2026-07-13 换 JS 行类载体）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // 载体（2026-07-13 换）= JS 显式行类 wysiwyg-inline-cursor-line（'text' 域落 pre）：
  // 原 activeline addon 载体对**非空选区清掉全部活动行** → 鼠标选中时该行源码消失
  // （用户反馈 ①），且 addon 存 handle 与光标行可失步（<ins> 行离开整列表才回渲染，②）
  const idx = css.indexOf('pre.wysiwyg-plain-text.wysiwyg-inline-cursor-line span[class*="wysiwyg-inline-marker"]');
  assert.ok(idx > 0, '缺「光标行行内标记显示源码」CSS 规则（wysiwyg-inline-cursor-line 载体）');
  const blk = css.slice(idx, idx + 400);
  assert.match(blk, /width: auto/, '光标行标记未恢复真宽（零宽即无源码可见性）');
  assert.match(blk, /color: var\(--text-secondary\)/, '光标行标记未用次级色（与光标行 > 槽 / # 哈希同源口径）');
  assert.ok(css.indexOf('.CodeMirror-activeline > pre.wysiwyg-plain-text span[class*="wysiwyg-inline-marker"]') < 0,
    'activeline 版标记规则未移除（双载体并存：选区期间 addon 清类、JS 类仍在 → 行为分裂）');
  // JS 接线：syncWysiwygActiveBlock 每次 cursorActivity 把行类同步到光标行（主选区头行）
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /this\._wysiwygInlineCurLine = line;/, '缺行内标记光标行跟踪变量（_wysiwygInlineCurLine）');
  assert.match(wsrc, /_setWysiwygCurLineClass\(this\._wysiwygInlineCurLine, 'wysiwyg-inline-cursor-line', false\);/,
    '光标离开旧行未撤行内标记类（离开行不回渲染态）');
  assert.match(wsrc, /_setWysiwygCurLineClass\(line, 'wysiwyg-inline-cursor-line', true\);/, '光标行进新行未挂行内标记类');
  // 拖选释放归位：跨行拖选 mouseup 常无新选区变化 → 无末次 cursorActivity，行类会停在
  // 拖选起始行（S66 抓出）→ 冻结早退前登记一次性 pointerup，setTimeout(0) 保证在 CM
  // document mouseup 清 selectingText 之后归位
  assert.match(wsrc, /_ensureWysiwygSelEndSync\(\); return;/, '拖选冻结早退未登记释放后归位（跨行拖选行类停在起始行）');
  assert.match(wsrc, /document\.addEventListener\('pointerup', onUp\);/, '拖选释放未挂一次性 pointerup');
  assert.match(wsrc, /setTimeout\(\(\) => \{[\s\S]{0,120}self\._applyWysiwygInlineCurLine\(\);/,
    '拖选释放归位未延迟到下一宏任务（pointerup 先于 mouseup，CM 在 mouseup 才清 selectingText）');
  // 2026-10-21 逐项切块后口径：释放后活动块归位到光标（选区头）所在块——CM 原生拖选
  // （mousedown 落真实行/行缘 margin）释放时无 cursorActivity 补同步，活动块会停在拖选
  // 起始行（S66 跨行拖选：光标行被遮、源码不显示）→ pointerup 延时里完整同步
  assert.match(wsrc, /self\._applyWysiwygInlineCurLine\(\);[\s\S]{0,400}self\.syncWysiwygActiveBlock\(\);[\s\S]{0,40}\}, 0\);/,
    '拖选释放后活动块未跟随光标行（逐项语义：光标行显示源码）');
  // 行类挂/撤公共方法（'text' 域 = pre；行销毁/越界 no-op）
  const fIdx = wsrc.indexOf('_setWysiwygCurLineClass(n, cls, on) {');
  assert.ok(fIdx > 0, '缺光标行行类挂/撤方法 _setWysiwygCurLineClass');
  assert.match(wsrc.slice(fIdx, fIdx + 600), /cm\.addLineClass\(h, 'text', cls\)/, '行类未走 addLineClass text 域（须落 pre 元素）');
  assert.match(wsrc.slice(fIdx, fIdx + 600), /cm\.removeLineClass\(h, 'text', cls\)/, '行类未走 removeLineClass text 域');
  // 引用 > 槽类改走同一公共方法（不复制挂/撤逻辑）
  const qIdx = wsrc.indexOf('_setWysiwygQuoteCurClass(n, on) {');
  assert.ok(qIdx > 0, '缺引用光标行类方法');
  assert.match(wsrc.slice(qIdx, qIdx + 300), /this\._setWysiwygCurLineClass\(n, 'wysiwyg-quote-cursor-line', on\);/,
    '引用光标行类未复用公共挂/撤方法');
  // addon 仍保留：光标行底色（codemirror.css #e8f2ff）与失步守卫仍依赖它
  const core = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  assert.match(core, /styleActiveLine: true/, 'editor-core 未开 styleActiveLine（光标行底色/失步守卫载体缺失）');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  assert.match(html, /lib\/codemirror\/addon\/selection\/active-line\.js/, 'index.html 未加载 active-line addon');
  // harness 与 app 对齐（否则 S58/S61 在 harness 测不出光标行行为）
  const harness = fs.readFileSync(path.join(ROOT, '_wysiwyg_compare.html'), 'utf8');
  assert.match(harness, /lib\/codemirror\/addon\/selection\/active-line\.js/, 'harness 未加载 active-line addon（与 app 不对齐）');
  assert.match(harness, /styleActiveLine: true/, 'harness 未开 styleActiveLine（与 editor-core 不对齐）');
  // 失步守卫：光标落进遮罩（collapsed span）时 addon 的 getLineHandleVisualStart 按视觉行
  // 解析到遮罩起始行、解罩后不自愈 → syncWysiwygActiveBlock 末尾校验并重放当前选区
  const gIdx = wsrc.indexOf('active-line addon 失步守卫');
  assert.ok(gIdx > 0, '缺 active-line addon 失步守卫（跳转行号落遮罩时底色/类挂错行）');
  const gblk = wsrc.slice(gIdx, gIdx + 1200);
  assert.match(gblk, /cm2\.state\.activeLines/, '守卫未校验 addon 存储的 handle');
  assert.match(gblk, /setSelection\(rng\.anchor, rng\.head, \{ scroll: false \}\)/, '守卫未重放当前选区让 addon 重解析');
  assert.match(gblk, /const cm2 = this\.cm;/, '守卫须用 this.cm 取编辑器（本函数无局部 cm，裸用会 ReferenceError 被 catch 吞）');
});

test('IME 组合期标题字号恒定：compositionstart 挂类 + compositionend 立即读 DOM（2026-10-19 用户反馈 #2：输入标题字号闪）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const csrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // ① 接线必须挂在输入域**原生 DOM** composition 事件（CM 5.65.18 不触发用户级编辑器事件，
  //    cm.on('compositionend') 是死代码——与 _wysiwygComposing 同一教训）
  const startIdx = csrc.indexOf("inputField.addEventListener('compositionstart'");
  const endIdx = csrc.indexOf("inputField.addEventListener('compositionend'");
  assert.ok(startIdx > 0 && endIdx > 0, '缺输入域原生 composition 监听');
  assert.match(csrc.slice(startIdx, startIdx + 700), /_wysiwygImeCompositionStart\(\)/,
    'compositionstart 未调 _wysiwygImeCompositionStart（组合文本按基准字号渲染）');
  assert.match(csrc.slice(endIdx, endIdx + 900), /_wysiwygImeCompositionEnd\(\)/,
    'compositionend 未摘组合期标题类');
  assert.match(csrc.slice(endIdx, endIdx + 900), /_wysiwygImeFlushDOM\(\)/,
    'compositionend 未立即读 DOM（CM5 readFromDOMSoon 80ms 空窗 = 字号闪烁窗口）');
  // ② 立即读 DOM = display.input.updateFromDOM（CM5 的 input 实例挂在 display 上，
  //    cm.input 是 CM6 习惯写法、在 5.65.18 上不存在 → 调用即静默 no-op）
  const fIdx = wsrc.indexOf('    _wysiwygImeFlushDOM() {');
  assert.ok(fIdx > 0, '缺 _wysiwygImeFlushDOM');
  assert.match(wsrc.slice(fIdx, fIdx + 900), /cm\.display && cm\.display\.input/, '立即读 DOM 未走 CM5 的 display.input');
  assert.match(wsrc.slice(fIdx, fIdx + 900), /input\.updateFromDOM\(\)/, '立即读 DOM 未调 updateFromDOM');
  // ②b flush 后对活动块直接幂等重挂装饰（2026-10-19 浏览器 suite 实测根因）：组合中途被
  //     CM5 提前提交（onFocus 的 webkit 20ms 延迟 reset → forceCompositionEnd，
  //     codemirror.js L3353-3356/9165-9171；或组合期 mousedown/键位绑定走 ensurePolled）时，
  //     change 钩子被 _wysiwygComposing 守卫顺延、compositionend 的 flush 又查无 diff →
  //     span 无人重挂直到 250ms 防抖；且提前提交插在旧 mark 边界处时 CM 不拉伸 mark →
  //     新文本落在 span 外、基准字号闪。change 事件只是重挂通道之一，flush 须兜底重挂
  assert.match(wsrc.slice(fIdx, fIdx + 900), /this\._wysiwygActiveIdx/, 'flush 未取活动块索引（直接重挂缺判定）');
  assert.match(wsrc.slice(fIdx, fIdx + 900), /this\._wysiwygApplyActiveDecor\(idx\);/,
    'flush 未对活动块直接重挂装饰（提前提交后 span 悬空到 250ms 防抖 = 上屏后仍闪烁）');
  // ③ 组合期挂类：仅标题行（ATX 口径）+ 非格编辑；类名 wysiwyg-ime-heading-{级}
  const sIdx = wsrc.indexOf('    _wysiwygImeCompositionStart() {');
  assert.ok(sIdx > 0, '缺 _wysiwygImeCompositionStart');
  const sblk = wsrc.slice(sIdx, sIdx + 1200);
  assert.match(sblk, /this\.viewMode !== 'wysiwyg' \|\| this\._wysiwygCellEditing/, '组合期挂类缺 模式/格编辑 守卫');
  assert.match(sblk, /wysiwyg-ime-heading-' \+ m\[1\]\.length/, '挂类未按标题级别生成 wysiwyg-ime-heading-{1..6}');
  // CM5 无 lineInfo（CM6 API，5.65.18 上调用即抛错被吞 = 类永不挂）：必须走视口行取 pre
  assert.match(sblk, /_wysiwygLinePreOf\(line\)/, '未用 CM5 视口取行 pre 挂类（lineInfo 是 CM6 API）');
  const lpIdx = wsrc.indexOf('    _wysiwygLinePreOf(lineNo) {');
  assert.ok(lpIdx > 0, '缺 _wysiwygLinePreOf（CM5 视口取行 pre 辅助）');
  assert.match(wsrc.slice(lpIdx, lpIdx + 700), /cm\.display && cm\.display\.view/, '取行 pre 未走 CM5 视口（display.view）');
  assert.match(wsrc.slice(lpIdx, lpIdx + 700), /lv\.line === handle/, '视口行未按 LineObject 恒等匹配（行号漂移误配）');
  // ④ CSS：基准字号抬到标题尺寸 + 行内 span 反比缩放（组合文本/正文/# 前缀三级同尺寸）
  assert.match(css, /pre\.wysiwyg-ime-heading-1 \{ font-size: calc\(var\(--wysiwyg-text-size, 16px\) \* 2\);/,
    '组合期 h1 行基准字号未抬到 2×基准（组合文本仍按 16px 渲染 = H1 先缩后胀）');
  assert.match(css, /pre\.wysiwyg-ime-heading-6 \{ font-size: calc\(var\(--wysiwyg-text-size, 16px\) \* 0\.9\);/,
    '组合期 h6 行基准字号未抬到 0.9×基准');
  assert.match(css, /pre\.wysiwyg-ime-heading-1 \.wysiwyg-heading-hash,/,
    '组合期 # 前缀未反比缩放（pre 抬字号后 0.8em 会放大成 25.6px）');
  assert.match(css, /pre\.wysiwyg-ime-heading-6 \.wysiwyg-heading-text,?[\s\S]{0,400}font-size: 1em;/,
    '组合期正文 span 未反比缩放（pre 抬字号后 2em 会放大成 64px）');
});

test('活动块按光标行现算时「钳光标在遮罩块」判定须用与 marks 同键的块表（2026-10-19 空行标题被误遮、字号跳变）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ① 方法签名带 oldBlocks 参数：刷新路径的旧表 + 旧 marks 是配套键空间
  const idx = wsrc.indexOf('    _wysiwygActiveIdxFromCursor(oldBlocks) {');
  assert.ok(idx > 0, '_wysiwygActiveIdxFromCursor 缺 oldBlocks 参数');
  const blk = wsrc.slice(idx, idx + 1600);
  assert.match(blk, /this\.wysiwygBlockIndexAt\(line, oldBlocks\)/,
    '「钳光标」判定未用旧表查（新表索引 + 旧 marks = 索引撞车，空行新切出的标题块被误判已遮罩 → 重遮字号跳）');
  assert.match(blk, /this\._wysiwygMarks\.has\(obi\)/, '「钳光标」判定未查 marks');
  assert.match(blk, /return this\.wysiwygBlockIndexAt\(line\);/, '返回值未用新表（活动块索引必须是新表键）');
  // ② wysiwygBlockIndexAt 支持显式块表
  const bIdx = wsrc.indexOf('    wysiwygBlockIndexAt(line, blocks) {');
  assert.ok(bIdx > 0, 'wysiwygBlockIndexAt 缺 blocks 参数');
  // ③ 三处「重切块表后现算活动块」的调用点都传旧表（表格结构提交 / 防抖刷新 / 全量增量）
  const callSites = wsrc.match(/_wysiwygActiveIdxFromCursor\(oldBlocks\);/g) || [];
  assert.strictEqual(callSites.length, 3,
    `重切块表路径应传旧表现算活动块（表格提交/防抖刷新/全量增量各一处），实得 ${callSites.length} 处`);
});

test('活动块背景高亮：cm-wysiwyg-active-block 行类 + 统一挂/撤 + CSS', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /ACTIVE_CLASS = 'cm-wysiwyg-active-block'/, '缺少 ACTIVE_CLASS 常量');
  assert.match(wsrc, /_applyWysiwygActiveHighlight\(\) \{/, '缺少 _applyWysiwygActiveHighlight');
  // 至少 5 个挂/撤挂点：setWysiwygActiveBlock 两路、全量渲染尾、增量刷新尾、清遮罩撤光（setTimeout 闭包内为 self.）
  const callCount = (wsrc.match(/(?:this|self)\._applyWysiwygActiveHighlight\(\)/g) || []).length;
  assert.ok(callCount >= 5, '_applyWysiwygActiveHighlight 挂点不足（应覆盖活动块切换两路/全量渲染尾/增量刷新尾/清遮罩撤光），实际 ' + callCount);
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // ⚠️ 选择器必须命中 CM5 实际渲染的 div.CodeMirror-linebackground（addLineClass('background')
  // 的类不在 pre.CodeMirror-line 上——旧选择器从未生效，2026-10-13 浏览器诊断发现）
  const hlIdx = css.indexOf('div.CodeMirror-linebackground.cm-wysiwyg-active-block');
  assert.ok(hlIdx > 0, '活动块高亮 CSS 未锚定 div.CodeMirror-linebackground（CM5 bgClass 实际落点）');
  const hlRule = css.slice(hlIdx, hlIdx + 300);
  // 2026-10-13 三轮修正（用户：「左边一个个的小圆角不好看，要显示为其他颜色、看起来像一块
  // 编辑」，参考图 = 代码块灰盒）：底色 = 代码块同色 --code-bg；逐行无圆角（多行连成整块）；
  // 仅块首行上缘/末行下缘圆角（JS 挂 first/last 行类）→ 整块读作一个圆角矩形编辑区
  assert.match(hlRule, /background: var\(--code-bg\)/, '活动块高亮未用代码块同色 --code-bg 底色');
  assert.ok(!/border-radius/.test(hlRule), '活动块底色规则仍带逐行圆角（多行会看起来一排小圆角条）');
  assert.match(css, /cm-wysiwyg-active-first \{[^}]*border-top-left-radius: 6px/, '缺块首行上缘圆角规则');
  assert.match(css, /cm-wysiwyg-active-last \{[^}]*border-bottom-left-radius: 6px/, '缺块末行下缘圆角规则');
  // JS 侧首/末行角类成对管理（挂/撤都含两个角类）
  assert.match(wsrc, /ACTIVE_FIRST_CLASS = 'cm-wysiwyg-active-first'/, '缺少 ACTIVE_FIRST_CLASS 常量');
  assert.match(wsrc, /ACTIVE_LAST_CLASS = 'cm-wysiwyg-active-last'/, '缺少 ACTIVE_LAST_CLASS 常量');
  const hlFnIdx = wsrc.indexOf('_applyWysiwygActiveHighlight() {');
  // 窗口需覆盖方法体（2026-10-21 起含 idx=-1 块间空行光标行灰底分支，前段加长）
  const hlFn = wsrc.slice(hlFnIdx, hlFnIdx + 4200);
  assert.match(hlFn, /addLineClass\(h, 'background', ACTIVE_FIRST_CLASS\)/, '活动块首行未挂圆角类');
  assert.match(hlFn, /addLineClass\(h, 'background', ACTIVE_LAST_CLASS\)/, '活动块末行未挂圆角类');
  // 2026-10-14 用户要求「只有光标所在行是灰色」：非容器块按选区头行取行号，
  // 光标块内移动时由 setWysiwygActiveBlock 同块路径重挂 → 底色跟随光标
  assert.match(hlFn, /getCursor\('head'\)/, '活动块高亮未按光标行（选区头行）取行号（单行灰底）');
  // 2026-10-18 用户要求：上下围栏都在灰框内 → 围栏块整块进盒（lo=b.start 含开围栏、
  // hi=last 含闭围栏），围栏行同挂灰底 + 代码排版行类（旧「围栏行在盒外」口径废弃）
  assert.match(hlFn, /const isFence = RE\.fence\.test\(\(first \|\| ''\)\.trim\(\)\);/,
    '缺围栏块判定（isFence）');
  assert.doesNotMatch(wsrc, /lo = b\.start \+ 1/, '围栏块灰盒仍排除围栏行（上下围栏应在盒内）');
  assert.match(hlFn, /ACTIVE_CODE_BOX_CLASS\)/, '代码块内容行未挂灰盒描边类（cm-wysiwyg-code-box）');
  assert.match(wsrc, /ACTIVE_CODE_BOX_CLASS = 'cm-wysiwyg-code-box'/, '缺少 ACTIVE_CODE_BOX_CLASS 常量');
  assert.ok((wsrc.match(/removeLineClass\(h, 'background', ACTIVE_CODE_BOX_CLASS\)/g) || []).length >= 2,
    '灰盒描边类撤除点不足（_apply 重挂 + clearWysiwygMasks 两处都要撤）');
  // 内容行排版行类（wysiwyg-code-line / pad-top / pad-bottom）挂撤成对
  assert.match(wsrc, /addLineClass\(h, 'text', 'wysiwyg-code-line'\)/, '代码块内容行未挂排版行类');
  assert.ok((wsrc.match(/removeLineClass\(h, 'text', 'wysiwyg-code-line'\)/g) || []).length >= 2,
    '代码行排版类撤除点不足（装饰重挂 + clearWysiwygMasks 两处都要撤）');
  // CSS：排版行类同参渲染态 pre（0.9×预览字号 / 行高 1 / 16px 内距）+ 灰盒 inset 描边
  const css67 = css;
  assert.match(css67, /pre\.CodeMirror-line\.wysiwyg-code-line \{[^}]*font-family: var\(--font-code-preview\)/,
    '代码行排版规则未用渲染态代码字族');
  assert.match(css67, /pre\.CodeMirror-line\.wysiwyg-code-line \{[^}]*font-size: calc\(var\(--wysiwyg-text-size, 16px\) \* 0\.9\)/,
    '代码行字号未对齐渲染态 0.9×预览字号');
  assert.match(css67, /pre\.CodeMirror-line\.wysiwyg-code-line \{[^}]*line-height: 1\.8/,
    '代码行行高未对齐渲染态 .code-line（1.8）');
  // 2026-10-21：左右内距 = 行留白 + 33（渲染态文本 x = pre 左缘+33 = 行基准+行留白+33）
  assert.match(css67, /pre\.CodeMirror-line\.wysiwyg-code-line \{[^}]*padding-left: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 33px\)/,
    '代码行左右内距未加行留白（编辑态文本偏左一整段行留白）');
  assert.match(css67, /wysiwyg-code-pad-top \{ padding-top: 29px/, '缺首内容行 29px 顶内距（1 border + 16 pre + 12 hljs）');
  assert.match(css67, /wysiwyg-code-pad-bottom \{ padding-bottom: 29px/, '缺末内容行 29px 底内距');
  // 2026-10-21 用户截图修正：旧 inset shadow 画满整个 linebackground（整行宽含行留白区），
  // 编辑态灰盒左右各比渲染态 pre 宽出一段行留白 → 底色/描边/圆角移入 ::before 内缩盒
  // （left/right = var(--wysiwyg-line-inset)），水平范围 = 行内容盒 = 遮罩 pre 范围
  assert.match(css67, /div\.CodeMirror-linebackground\.cm-wysiwyg-code-box \{[^}]*background: none/,
    '灰盒底色未从满行宽 linebackground 移入 ::before 内缩盒');
  assert.match(css67, /cm-wysiwyg-code-box::before \{[^}]*left: var\(--wysiwyg-line-inset, 32px\);[^}]*right: var\(--wysiwyg-line-inset, 32px\);/,
    '灰盒 ::before 未内缩行留白（left/right 应 = --wysiwyg-line-inset）');
  assert.match(css67, /cm-wysiwyg-code-box::before \{[^}]*background: var\(--code-bg\);/,
    '灰盒 ::before 底色未用渲染态 --code-bg');
  assert.match(css67, /cm-wysiwyg-code-box::before \{[^}]*border-left: 1px solid var\(--border-color\);[^}]*border-right: 1px solid var\(--border-color\);/,
    '灰盒 ::before 左右竖线未用 pre 同参 1px 描边');
  assert.match(css67, /cm-wysiwyg-code-box\.cm-wysiwyg-active-first::before \{[^}]*border-top: 1px solid var\(--border-color\);[^}]*border-radius: 6px 6px 0 0/,
    '灰盒首行 ::before 缺顶线+上圆角');
  assert.match(css67, /cm-wysiwyg-code-box\.cm-wysiwyg-active-last::before \{[^}]*border-bottom: 1px solid var\(--border-color\);[^}]*border-radius: 0 0 6px 6px/,
    '灰盒末行 ::before 缺底线+下圆角');
  assert.match(css67, /cm-wysiwyg-code-box\.cm-wysiwyg-active-first\.cm-wysiwyg-active-last::before \{[^}]*border-radius: 6px\;/,
    '灰盒单行（首末同挂）::before 缺四边四角收口规则（旧 box-shadow 方案单行缺顶线）');
  // 嵌套列表层级 CSS（2026-10-17）：每层 +24px 三口径 + 续行 li 内容缘 + 零宽槽 +
  // ol-paren 4.828px 槽 + ul circle/square marker
  assert.match(css67, /wysiwyg-list-indent-ul\.wysiwyg-list-lvl-2 \{ padding-left: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 13px \+ 24px\)/,
    'ul 二级行类未叠加 24px');
  assert.match(css67, /wysiwyg-list-indent-ol\.wysiwyg-list-lvl-2 \{ padding-left: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 24px \+ 24px\)/,
    'ol 续行二级未叠加 24px');
  assert.match(css67, /wysiwyg-list-line\.wysiwyg-list-lvl-2 \{ padding-left: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 24px\)/,
    'ol 项行/任务行二级未叠加 24px');
  assert.match(css67, /wysiwyg-list-cont \{ padding-left: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 24px\)/,
    '续行未对齐 li 内容缘（行基准+24）');
  assert.match(css67, /wysiwyg-list-space-zero \{[^}]*width: 0/, '缺嵌套前导缩进零宽槽');
  // ul 嵌套圆点：Edge 154 @16px 下渲染 disc/circle/square 同为 ~6px 实心点
  // （2026-10-17 逐像素对比）→ 各层同用 disc，不得引入按层空心环/方块覆盖
  assert.ok(!/wysiwyg-list-lvl-2 \.wysiwyg-list-bullet::before/.test(css67),
    'ul 二级圆点不应按层改形态（渲染 circle 在本引擎 @16px 即实心点）');
  assert.match(css67, /pre\.wysiwyg-list-lvl-2 \.wysiwyg-ol-marker \{[^}]*padding-right: 9\.228px/,
    'ol 二级数字槽 padding 未按「)」advance 实测值（4.4+4.828）左移');
  assert.match(css67, /wysiwyg-ol-marker\.wysiwyg-ol-paren \{[^}]*width: 0/,
    'ol 二级点 span 未零宽化（CM5 重叠区间合挂双类，须按双类收口）');
  assert.match(css67, /wysiwyg-ol-paren::after \{[^}]*content: '\)'/, 'ol 二级括号未用 ::after 绘制');
  assert.match(css67, /wysiwyg-ol-paren::after \{[^}]*left: -9\.228px/, 'ol 二级括号回画位未对齐渲染「)」墨迹同相');
  // 撤除须在两处都覆盖：_applyWysiwygActiveHighlight 重挂旧行 + clearWysiwygMasks 整体清理
  assert.ok((wsrc.match(/removeLineClass\(h, 'background', ACTIVE_FIRST_CLASS\)/g) || []).length >= 2,
    '首行角类撤除点不足（_apply 重挂 + clearWysiwygMasks 两处都要撤）');
  assert.ok((wsrc.match(/removeLineClass\(h, 'background', ACTIVE_LAST_CLASS\)/g) || []).length >= 2,
    '末行角类撤除点不足（_apply 重挂 + clearWysiwygMasks 两处都要撤）');
});

test('编辑态排版对齐渲染态（2026-10-14 用户截图反馈）：plain-text 行类 + 字号同步 + CSS 同参', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // JS：活动块源文行挂 .wysiwyg-plain-text 行类（先清后挂，撤除两处覆盖）
  assert.match(wsrc, /addLineClass\(h, 'text', 'wysiwyg-plain-text'\)/, '活动块源文行未挂 plain-text 行类');
  assert.ok((wsrc.match(/removeLineClass\(h, 'text', 'wysiwyg-plain-text'\)/g) || []).length >= 2,
    'plain-text 行类撤除点不足（_apply 重挂 + clearWysiwygMasks 两处都要撤）');
  // 字号同步：读 #preview 计算值（用户「预览字号」设置，含缩放），回落 settings
  assert.match(wsrc, /_syncWysiwygTextSize\(\) \{/, '缺少 _syncWysiwygTextSize');
  const syncIdx = wsrc.indexOf('_syncWysiwygTextSize() {');
  const syncFn = wsrc.slice(syncIdx, syncIdx + 1400);
  assert.match(syncFn, /getComputedStyle\(this\.preview\)/, '未读 #preview 计算字号');
  assert.match(syncFn, /previewFontSize/, '缺 settings.previewFontSize 回落');
  assert.match(syncFn, /--wysiwyg-text-size/, '未同步 --wysiwyg-text-size 变量');
  // CSS：与渲染态遮罩 .wysiwyg-block-mask.preview-content 同参（预览字族/1.7 行高/正文色/
  // 字号=「预览字号」变量，默认 16px）
  const ptIdx = css.indexOf('.wysiwyg-plain-text {');
  assert.ok(ptIdx > 0, '缺少 .wysiwyg-plain-text 规则');
  const ptRule = css.slice(ptIdx, ptIdx + 400);
  assert.match(ptRule, /font-family: var\(--font-preview\)/, 'plain-text 未用预览字族');
  assert.match(ptRule, /font-size: var\(--wysiwyg-text-size, 16px\)/, 'plain-text 字号未同步「预览字号」设置');
  assert.match(ptRule, /line-height: 1\.7/, 'plain-text 行高未对齐渲染态 1.7');
  assert.match(ptRule, /color: var\(--text-primary\)/, 'plain-text 颜色未对齐渲染态正文色');
  // 2026-10-14 用户截图二轮：① 块内空行（松散列表项间）不挂 plain-text——本类行高 1.7
  // 特异性高于空行塌缩规则（.CodeMirror .cm-wysiwyg-blank .CodeMirror-line 12px），
  // 挂了会把空行撑回全高 → 列表编辑态「多出来很多空白行」
  const plainLoop = wsrc.indexOf('this._wysiwygPlainLines = [];');
  assert.ok(plainLoop > 0, '缺 plain-text 挂行循环');
  // 2026-10-30 空引用行例外（图3）：空行分支改为 if 块——空引用行只补跟踪（_wysiwygPlainLines
  // push，清理路径撤净行类）、不挂 plain-text（挂了会把空行撑回全高 → 列表编辑态多空白行）
  const blankSkip = wsrc.slice(plainLoop, plainLoop + 900)
    .match(/\(cm\.getLine\(lineNo\) \|\| ''\)\.trim\(\) === ''\) \{([\s\S]{0,400}?)\n {12}\}/);
  assert.ok(blankSkip, 'plain-text 挂行循环未跳过块内空行');
  assert.doesNotMatch(blankSkip[1], /wysiwyg-plain-text/, '空行分支不得挂 wysiwyg-plain-text（会撑回全高）');
  assert.match(blankSkip[1], /_wysiwygPlainLines\.push/, '空引用行须补跟踪（离开块时清理路径能撤净行类）');
  // ② gfm token 色中和：标题 cm-header（蓝）/列表 cm-variable-2（海军蓝）/引用 cm-quote（绿）
  // 等 token span 嵌在渲染化 span 内，内层 color 压过继承 → 编辑态文字发蓝。
  // plain-text 行内所有 cm-* span 统一 color:inherit
  const tokIdx = css.indexOf('.wysiwyg-plain-text span[class*="cm-"]');
  assert.ok(tokIdx > 0, '缺少 gfm token 色中和规则（.wysiwyg-plain-text span[class*="cm-"]）');
  assert.match(css.slice(tokIdx, tokIdx + 200), /color: inherit/, 'token 色中和规则未设 color: inherit');
});

test('表格单元格就地源码编辑（Phase 2 / R5，2026-10-13）：点击进格编辑、提交回写+重渲、三处守卫齐备', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // mousedown 表格分支路由到单元格编辑（Ctrl/Cmd+格内链接放行到链接分支）
  const cellBranch = src.indexOf("cellEl.closest('a')");
  assert.ok(cellBranch > 0, '缺表格单元格点击分支');
  assert.match(src.slice(cellBranch, cellBranch + 1500), /_wysiwygStartCellEdit\(/,
    '表格格点击未路由到 _wysiwygStartCellEdit');
  assert.match(src.slice(cellBranch, cellBranch + 1500), /ctrlKey \|\| ev\.metaKey/,
    '格内链接 Ctrl/Cmd 跟随未放行');
  // 提交回写：专用 origin 的 replaceRange + b.src 同步 + 立即重渲本块
  const endIdx = src.indexOf('_wysiwygEndCellEdit(commit, settle) {');
  assert.ok(endIdx > 0, '缺 _wysiwygEndCellEdit');
  const endBody = src.slice(endIdx, endIdx + 4000);
  assert.match(endBody, /replaceRange\([\s\S]{0,220}\+wysiwygTableCell'\)/, '单元格提交缺专用 origin 的 replaceRange 回写');
  assert.match(endBody, /b\.src = this\._wysiwygBlockSource\(b\)/, '单元格提交未同步 b.src（全量增量刷新将误判源未变）');
  assert.match(endBody, /this\.maskWysiwygBlock\(blockIdx\)/, '单元格提交未立即重渲本块遮罩');
  assert.match(endBody, /this\._wysiwygCellEditing = null/, '结束编辑未清状态（重入守卫失效）');
  // 三处守卫：活动块切换 / 撤本块遮罩 / 整体清遮罩 前必须先提交。
  // setWysiwygActiveBlock 的守卫必须**延迟**到下一 tick（它常由 cursorActivity 调起、
  // 在 CM mousedown operation 内，同步提交 → NotFoundError，2026-10-13 用户报）；
  // 另两处撤罩会销毁在编格 DOM，必须同步。
  const actIdx = src.indexOf('setWysiwygActiveBlock(idx) {');
  assert.ok(actIdx > 0, '缺 setWysiwygActiveBlock');
  // 守卫须延迟到下一 tick（CM mousedown operation 内同步提交 → NotFoundError）；
  // 延迟 tick 内还须防误触发：单元格已被替换（st2.cell !== cell）或焦点仍在原格
  // （cursorActivity 误触发，打字到一半被提交/光标跳走，2026-10-13 真机反馈）都跳过
  assert.match(src.slice(actIdx, actIdx + 1000), /setTimeout\(\(\) => \{[\s\S]{0,400}st2\.cell !== cell[\s\S]{0,300}document\.activeElement === cell[\s\S]{0,200}self\._wysiwygEndCellEdit\(true\);[\s\S]{0,40}\}, 0\);/,
    'setWysiwygActiveBlock 的在编格提交守卫未延迟到下一 tick（CM operation 内同步提交 → NotFoundError；延迟 tick 内需防误触发）');
  const unmaskIdx = src.indexOf('unmaskWysiwygBlock(idx) {');
  assert.ok(unmaskIdx > 0, '缺 unmaskWysiwygBlock');
  assert.match(src.slice(unmaskIdx, unmaskIdx + 600), /_wysiwygCellEditing\.blockIdx === idx[\s\S]{0,120}_wysiwygEndCellEdit\(true\)/,
    'unmaskWysiwygBlock 缺本块在编格提交守卫');
  const clearIdx = src.indexOf('clearWysiwygMasks() {');
  assert.ok(clearIdx > 0, '缺 clearWysiwygMasks');
  assert.match(src.slice(clearIdx, clearIdx + 500), /_wysiwygEndCellEdit\(true\)/, 'clearWysiwygMasks 缺在编格提交守卫');
  // 纯函数导出（行为测试见 wysiwyg-blocks.test.cjs）
  assert.match(src, /const api = \{[\s\S]{0,220}splitTableRow, editTableRowCell\,/,
    'splitTableRow / editTableRowCell 未导出');
  // CSS：单元格源码编辑态样式
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /wysiwyg-cell-editing[\s\S]{0,320}outline: 1px solid var\(--accent-color\)/,
    '缺表格单元格源码编辑态样式（accent 描边）');
});

test('表格行/列操作（2026-10-13 用户要求）：hover 增行/增列 + 拖拽换位接线齐备；blur 提交延迟到下一 tick（NotFoundError 修复）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 结构纯函数导出（行为测试见 wysiwyg-blocks.test.cjs）
  assert.match(src, /parseTableStructure, buildTableLine, addTableRow, addTableColumn, moveTableRow, moveTableColumn\,/,
    '增行/增列/换位纯函数未导出');
  // 遮罩构建时注入表格工具（wrap 定位容器 + 两枚按钮）
  assert.match(src, /this\._addWysiwygTableTools\(node\);/, 'maskWysiwygBlock 未挂载表格工具');
  const tIdx = src.indexOf('_addWysiwygTableTools(node) {');
  assert.ok(tIdx > 0, '缺 _addWysiwygTableTools');
  assert.match(src.slice(tIdx, tIdx + 900), /wysiwyg-table-wrap/, '表格未包进定位容器（按钮无法相对表格定位）');
  assert.match(src.slice(tIdx, tIdx + 900), /wysiwyg-table-add-col/, '缺增列按钮');
  assert.match(src.slice(tIdx, tIdx + 900), /wysiwyg-table-add-row/, '缺增行按钮');
  // mousedown 路由：工具按钮短路 → _wysiwygTableAdd；格分支带拖拽守卫
  const toolBranch = src.indexOf("closest('.wysiwyg-table-add-row, .wysiwyg-table-add-col')");
  assert.ok(toolBranch > 0, 'mousedown 未识别表格工具按钮');
  assert.match(src.slice(toolBranch, toolBranch + 400), /_wysiwygTableAdd\(/, '工具按钮点击未路由到 _wysiwygTableAdd');
  const cellBranch = src.indexOf('const dragSt = self._wysiwygTableDrag;');
  assert.ok(cellBranch > 0, '格点击分支未引用拖拽状态');
  assert.match(src.slice(cellBranch, cellBranch + 200), /if \(dragSt\) return;/,
    '格点击分支缺拖拽守卫（拖拽中不得再进格编辑；2026-10-20 表头不再是拖拽入口，无例外）');
  // mousedown 顶部总守卫：拖拽中 gutter 按下的目标是轨道 span（非单元格），
  // 不吞掉会落到「点击映射源码行」分支 → 拖拽中途撤罩表格块 + 挪光标
  const mdIdx = src.indexOf("node.addEventListener('mousedown'");
  assert.match(src.slice(mdIdx, mdIdx + 900), /if \(self\._wysiwygTableDrag\) \{ ev\.preventDefault\(\); return; \}/,
    'mousedown 缺拖拽中总守卫（轨道按下会触发点击映射 → 撤罩表格块）');
  // pointerdown 拖拽入口 + 行把手区（首格左 16px）
  assert.match(src, /node\.addEventListener\('pointerdown'/, '遮罩未委托 pointerdown（行/列拖拽入口）');
  const dIdx = src.indexOf('_wysiwygTableDragStart(ev) {');
  assert.ok(dIdx > 0, '缺 _wysiwygTableDragStart');
  assert.match(src.slice(dIdx, dIdx + 3300), /dxRow < 16 && dxRow >= -16/,
    '行拖拽把手区未限定在 [格左缘-16, 格左缘+16)（表格外左缘把手，下界防整条 gutter 误判）');
  // 格编辑结束焦点恢复（2026-10-13 反馈残留：Enter 提交后 blur 焦点掉 body = 光标丢失）：
  // 下一 tick 判定——仅当焦点掉 body 才回编辑器（不干扰点另一格/点源码行已接走的焦点）
  const rfIdx = src.indexOf('_wysiwygRestoreEditorFocus(endLine) {');
  assert.ok(rfIdx > 0, '缺 _wysiwygRestoreEditorFocus（格编辑结束焦点回编辑器）');
  assert.match(src.slice(rfIdx, rfIdx + 900), /setTimeout\(\(\) => \{[\s\S]{0,300}_wysiwygTableDrag[\s\S]{0,200}document\.activeElement/,
    '焦点恢复未延迟判定 / 未在拖拽进行中让路');
  assert.match(src.slice(rfIdx, rfIdx + 900), /ae && ae !== document\.body[\s\S]{0,400}cm\.focus\(\)/,
    '焦点恢复未在焦点掉 body 时回 CM（光标丢失根因）');
  // 提交 + 取消两路都必须调用（定义 1 处 + 调用 2 处 = 3）
  assert.strictEqual((src.match(/_wysiwygRestoreEditorFocus\(/g) || []).length, 3,
    '焦点恢复未同时接在提交路径与取消（Esc）路径');
  // 列悬停高亮 + 表上方拖拽胶囊（2026-10-13 参考图）：CSS 选不到「同列」，JS 按悬停列
  // 给整列挂 wysiwyg-col-hover；胶囊 = th::before，表头按下 + 4px 阈值逻辑零改动接管
  assert.match(src, /setColHover/, '缺列悬停类托管（setColHover）');
  assert.match(src, /wysiwyg-col-hover/, '缺列悬停类名');
  // 行悬停也须 JS 托管：行把手盒在 tr 盒外而又是 tr:hover 的产物（循环依赖，纯 CSS
  // 时指针移向把手 → :hover 失效 → 把手消失 → 命中掉 pre，行拖拽启动不了）
  assert.match(src, /setRowHover/, '缺行悬停类托管（setRowHover）');
  assert.match(src, /wysiwyg-row-hover/, '缺行悬停类名');
  // 边缘邻近悬停（2026-10-13 用户第 2/3 条）：左 gutter → 行握点；顶 gutter → 列握点；
  // 停在单元格上 → 都不出（悬停零高亮，只有拖动才蓝）
  assert.match(src, /addEventListener\('mousemove', \((e)\) => \{[\s\S]{0,900}gridLeft[\s\S]{0,600}gridTop - 24[\s\S]{0,600}gridLeft - 24/,
    '缺 mousemove 边缘邻近判定（左 gutter 带 gridLeft-24 / 顶 gutter 带 gridTop-24，与 24px 常驻轨道同宽）');
  assert.match(src, /addEventListener\('mousemove', \((e)\) => \{[\s\S]{0,1600}setRowHover\(null\); setColHover\(-1\);/,
    '缺 mousemove 兜底（停在单元格上 → 两握点都隐藏）');
  assert.match(src, /addEventListener\('mouseleave', \(\) => \{ setRowHover\(null\); setColHover\(-1\); \}\)/, '缺离开 wrap 清行/列悬停接线');
  // 轨道 + 握点两件套：轨道常驻命中区（DOM 冒泡进 wrap），握点 JS 定位
  assert.match(src, /rowGripEl\.className = 'wysiwyg-table-row-grip'/, '缺行握点元素（可见小把手，轨道内 JS 定位）');
  assert.match(src, /colGripEl\.className = 'wysiwyg-table-col-grip'/, '缺列握点元素（可见小把手，轨道内 JS 定位）');
  // 结构提交：整块 replaceRange + 清 250ms 防抖 + 立即重算块表（全量增量 / 非全量视口重挂两路）
  const cIdx = src.indexOf('_wysiwygCommitTableBlock(blockIdx, newSource, origin) {');
  assert.ok(cIdx > 0, '缺 _wysiwygCommitTableBlock（行数可能变，不能走单行提交路径）');
  const cblk = src.slice(cIdx, cIdx + 1800);
  assert.match(cblk, /clearTimeout\(this\._wysiwygMaskTimer\)/, '整块回写后未清 250ms 输入防抖（会重复解析）');
  assert.match(cblk, /_refreshWysiwygFullIncremental\(\)/, '全量模式回写后未立即重算块表');
  assert.match(cblk, /computeWysiwygBlocks\(\);/, '非全量模式回写后未立即重算块表');
  // 增行/增列 → 自动格编辑新格（回写后块索引可能位移，须显式传新索引）
  const aIdx = src.indexOf('_wysiwygTableAdd(kind, maskNode) {');
  assert.ok(aIdx > 0, '缺 _wysiwygTableAdd');
  assert.match(src.slice(aIdx, aIdx + 1700), /_wysiwygStartCellEditAt\(tRow, tCol, newIdx\)/,
    '增行/增列后未自动进入新格编辑（Typora 式无缝续输）');
  assert.match(src.slice(aIdx, aIdx + 1700), /const tRow = \(kind === 'row'\) \? rows\.length - 2 : 0;[\s\S]{0,120}const tCol = \(kind === 'row'\) \? 0 : lastInfo\.cells\.length - 1;/,
    '增行/增列落格未改新增行/列的第一个单元格（2026-10-14 用户要求：增行=新末行首格，增列=新末列表头格）');
  // 拖拽：4px 阈值（表头不动手=格编辑）+ 进拖先取消误触发的格编辑 + 释放按纯函数回写
  const mIdx = src.indexOf('_wysiwygTableDragMove(e) {');
  assert.ok(mIdx > 0, '缺 _wysiwygTableDragMove');
  assert.match(src.slice(mIdx, mIdx + 700), /Math\.abs\(e\.clientX - st\.startX\) < 4/, '缺拖拽阈值（表头按下不动手 = 格编辑）');
  assert.match(src.slice(mIdx, mIdx + 700), /_wysiwygEndCellEdit\(false\)/, '进入拖拽未先取消表头误触发的格编辑');
  const upIdx = src.indexOf('_wysiwygTableDragUp() {');
  assert.ok(upIdx > 0, '缺 _wysiwygTableDragUp');
  // 窗口含开头的「无位移+格编辑失焦」分支（2026-10-14），需放宽到回写模式之后
  assert.match(src.slice(upIdx, upIdx + 2200), /moveTableRow\(src, st\.idx, to\) : moveTableColumn\(src, st\.idx, to\)/,
    '拖拽释放未走纯函数回写');
  assert.match(src.slice(upIdx, upIdx + 2200), /_wysiwygCommitTableBlock\(idx, newSrc, '\+wysiwygTableMove'\)/,
    '拖拽释放未整块回写');
  // blur 提交一律延迟到下一 tick：blur 常发生在 CM 自己的 mousedown operation 内，
  // 同步 replaceRange + 重挂遮罩会毁掉 CM 操作还要移动的节点 → NotFoundError（2026-10-13 用户报）
  const blurIdx = src.indexOf("cell.addEventListener('blur'");
  assert.ok(blurIdx > 0, '缺 blur 监听');
  assert.match(src.slice(blurIdx, blurIdx + 1000), /setTimeout\(\(\) => \{[\s\S]{0,320}document\.activeElement === cell[\s\S]{0,200}_wysiwygEndCellEdit\(true\);/,
    'blur 提交未延迟（同步提交在 CM operation 内重建行 DOM → NotFoundError；延迟 tick 内需防焦点搬回误触发）');
  // 悬停状态 JS 托管（2026-10-13 反馈 #3：按钮在盒外 6px 空隙 + 下缘落下方块内容区被
  // 相邻行 z-index:2 压在下面 → 纯 CSS :hover 点不到）。JS 维护悬停类 + 延迟隐藏。
  // 反馈 #4/#5（边缘条带）：显示改由 per-strip 悬停类驱动——条带自身即悬停区
  //（透明时也恒可命中），鼠标在表格本体上不显示；悬停桥（行 z-index 抬升）保留。
  assert.match(src, /wysiwyg-table-tools-hover/, '缺 JS 托管的悬停桥状态类');
  assert.match(src, /addEventListener\('mouseleave', scheduleHideTools\)/, '缺离开 wrap 的延迟隐藏接线');
  assert.match(src, /wysiwyg-table-line-hover/, '缺悬停期表格行 z-index 抬升接线（压过下方块）');
  assert.match(src, /armStripHover\(colBtn, 'wysiwyg-table-add-col-hover'\)/, '缺增列条带 per-strip 悬停接线');
  assert.match(src, /armStripHover\(rowBtn, 'wysiwyg-table-add-row-hover'\)/, '缺增行条带 per-strip 悬停接线');
  const ashIdx = src.indexOf('const armStripHover = (stripEl, cls) => {');
  assert.ok(ashIdx > 0, '缺条带悬停托管函数（armStripHover）');
  assert.match(src.slice(ashIdx, ashIdx + 700), /setTimeout\(\(\) => \{ timer = null; wrap\.classList\.remove\(cls\); \}, 200\)/,
    '条带悬停缺 200ms 宽限（跨越 6px 间隙时会在点击落定前消失）');
  assert.match(src.slice(ashIdx, ashIdx + 700), /stripEl\.addEventListener\('mouseenter', show\);/,
    '条带悬停缺 mouseenter 显示接线');
  // CSS：边缘条带由 per-strip 悬停类驱动显隐（opacity，恒 display:flex；条带自身恒可命中）
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.wysiwyg-table-wrap \{ position: relative; width: fit-content; max-width: 100%; padding-top: 24px; padding-bottom: 24px; \}/,
    '缺表格容器定位锚 / 未收窄到表格网格宽（整宽 wrap 会让条带漂离表格）/ 缺上下留白（各 24px：上容纳列拖把手、下容纳增行条带，2026-10-13 反馈 #8 定稿）');
  assert.match(css, /\.wysiwyg-table-wrap\.wysiwyg-table-add-col-hover \.wysiwyg-table-add-col[\s\S]{0,120}\.wysiwyg-table-wrap\.wysiwyg-table-add-row-hover \.wysiwyg-table-add-row \{[\s\S]{0,120}opacity: 1;/,
    '增列/增行条带未随 per-strip 悬停类显示（反馈 #5：移到边缘才显示）');
  assert.match(css, /opacity: 0;/, '条带默认未透明隐藏（恒 display:flex，用 opacity 显隐）');
  assert.match(css, /pointer-events: auto;[\s\S]{0,80}条带自身即悬停触发区|\.wysiwyg-table-add-col,[\s\S]{0,400}pointer-events: auto;/,
    '条带透明态未保持可命中（反馈 #5：条带自身即悬停触发区，必须恒 pointer-events:auto）');
  assert.match(css, /\.CodeMirror \.CodeMirror-line\.wysiwyg-table-line-hover \{ z-index: 3; \}/, '缺悬停期表格行 z-index 抬升（须含 .CodeMirror 前缀压过 codemirror.css）');
  assert.match(css, /wysiwyg-table-add-col \{ left: 100%; top: 24px; bottom: 24px; width: 16px; margin-left: 0; \}/,
    '缺增列竖条几何（右缘、与表格同高、16px 宽；反馈 #3 紧贴表格边框 = margin-left:0；上下界=24px 留白内表体区）');
  assert.match(css, /wysiwyg-table-add-row \{ bottom: 8px; left: 0; width: 100%; height: 16px; \}/,
    '缺增行横条几何（下缘通宽、16px 厚与竖条一致；反馈 #3 紧贴表格底边 = bottom:8px 即条带顶缘=表底缘，落 wrap 下留白 24px 内不压下一行）');
  // 拖拽视觉（2026-10-13 用户第 6 条：只有拖动才高亮）：被拖行/列浅蓝底
  //（2026-10-13 反馈 #1/#2 定稿：淡蓝背景 = 被拖行/列；列原「右缘蓝线」inset 阴影移除，
  // 蓝线统一为独立落点指示线 .wysiwyg-table-drop-line，避免双蓝线混淆）
  assert.match(css, /wysiwyg-table-dragging-row \{[\s\S]{0,120}background-color: var\(--accent-subtle\)/, '缺拖动中被拖行高亮');
  assert.match(css, /wysiwyg-table-dragging-col \{[\s\S]{0,120}background-color: var\(--accent-subtle\);\s*\}/, '缺拖动中被拖列高亮（仅浅蓝底，右缘蓝线已移交给落点指示线）');
  assert.ok(!/wysiwyg-table-dragging-col[\s\S]{0,200}inset -2px/.test(css), '被拖列右缘蓝线未移除（参考图只有一条落点蓝线，双蓝线会混淆）');
  // 落点指示线（2026-10-13 反馈 #1/#2：蓝线 = 要拖动到的位置）：行拖横线通表宽、
  // 列拖竖线通表高（top:24/bottom:24 = 留白内表体区，随 wrap 上下留白 24px），
  // 默认 opacity:0 只在拖动态显示
  assert.match(css, /\.wysiwyg-table-drop-line \{[\s\S]{0,200}position: absolute;[\s\S]{0,200}background: var\(--accent-color\);[\s\S]{0,200}opacity: 0;[\s\S]{0,200}pointer-events: none;/,
    '缺落点指示线基础规则（蓝线、默认隐藏、不拦命中）');
  assert.match(css, /wysiwyg-drop-line-row \{ left: 0; width: 100%; height: 2px; \}/, '缺行拖落点横线几何（通表宽 2px 细线）');
  assert.match(css, /wysiwyg-drop-line-col \{ top: 24px; bottom: 24px; width: 2px; \}/, '缺列拖落点竖线几何（通表高 2px 细线，上下界=留白内表体区）');
  assert.match(css, /wysiwyg-table-col-pill\.wysiwyg-dragging \.wysiwyg-table-col-grip \{[\s\S]{0,200}background: var\(--accent-color\)/,
    '缺拖动中握点蓝底胶囊（轨道 .wysiwyg-dragging → 内部握点变蓝底）');
  // 表格外拖拽轨道+握点（2026-10-13 参考图）：必须是 wrap 上的真实元素——伪元素伸到
  // 表盒外会被 .preview-content table 的 overflow-x:auto 裁剪（不可见/不可命中）。
  // 轨道 = 常驻透明命中区（gutter 在 wrap 盒外，事件靠 DOM 冒泡进 wrap，轨道不常驻则
  // gutter 里 mousemove/pointerdown 收不到）；握点 = 可见小把手，JS 定位。
  const rhIdx = css.indexOf('.wysiwyg-table-row-handle');
  assert.ok(rhIdx > 0, '缺行轨道元素规则（.wysiwyg-table-row-handle，wrap 上常驻真实元素）');
  assert.match(css.slice(rhIdx, rhIdx + 300), /position: absolute;[\s\S]{0,60}left: -24px;[\s\S]{0,80}top: 24px;[\s\S]{0,80}bottom: 24px;[\s\S]{0,80}width: 24px;/,
    '行轨道未覆盖左 gutter 带（left:-24px 宽 24px = 常驻命中区，与列轨同宽；上下界随 wrap 留白 24px）');
  const rgIdx = css.indexOf('.wysiwyg-table-row-grip');
  assert.ok(rgIdx > 0, '缺行握点规则（.wysiwyg-table-row-grip，轨道内可见小把手）');
  assert.match(css.slice(rgIdx, rgIdx + 400), /color: var\(--text-tertiary/, '行握点悬停态非中性灰点阵');
  const pillIdx2 = css.indexOf('.wysiwyg-table-col-pill');
  assert.ok(pillIdx2 > 0, '缺列轨道元素规则（.wysiwyg-table-col-pill，wrap 上常驻真实元素）');
  assert.match(css.slice(pillIdx2, pillIdx2 + 300), /top: 0;[\s\S]{0,160}height: 24px;/,
    '列轨道未覆盖顶 gutter 带（top:0 高 24px = wrap 上留白区，底边贴表顶，不再伸到行外）');
  const cgIdx = css.indexOf('.wysiwyg-table-col-grip');
  assert.ok(cgIdx > 0, '缺列握点规则（.wysiwyg-table-col-grip，轨道内可见小把手）');
  assert.match(css.slice(cgIdx, cgIdx + 450), /color: var\(--text-tertiary/, '列握点悬停态非中性灰点阵');
  // 悬停不高亮：wysiwyg-row-hover / wysiwyg-col-hover 只作状态类，不得再有底色规则；
  // 阅读模式的行 hover 高亮（.preview-content tbody tr:hover）在遮罩上必须豁免
  assert.ok(css.indexOf('tr.wysiwyg-row-hover {') < 0, '悬停行高亮规则未移除（用户第 6 条：只有拖动才高亮）');
  assert.ok(!/td\.wysiwyg-col-hover[\s\S]{0,200}background-color/.test(css), '悬停列高亮规则未移除（用户第 6 条：只有拖动才高亮）');
  assert.match(css, /\.editor-container\.wysiwyg-mode \.wysiwyg-block-mask tbody tr:hover \{[\s\S]{0,80}background-color: transparent/,
    '缺 wysiwyg 遮罩 tr:hover 豁免（阅读模式行 hover 高亮漏进遮罩 → 悬停行出浅蓝底）');
  // 顶部留白：表格是文档首行时，表上方把手不得被滚动容器裁掉（用户第 1 条反馈）
  assert.match(css, /\.editor-container\.wysiwyg-mode \.CodeMirror-lines \{[\s\S]{0,80}padding-top: 24px;/,
    '缺 wysiwyg 模式内容顶部留白（表格在文档首行时列把手被顶缘裁剪）');
  // JS：轨道元素创建（常驻命中区）+ 握点定位 + 拖拽入口分支
  assert.match(src, /rowTrackEl\.className = 'wysiwyg-table-row-handle'/, '缺行轨道元素创建（wrap 上常驻真实元素）');
  assert.match(src, /colTrackEl\.className = 'wysiwyg-table-col-pill'/, '缺列轨道元素创建（wrap 上常驻真实元素）');
  assert.match(src, /rowGripEl\.style\.top = \(rr\.top - kr\.top \+ rr\.height \/ 2 - gh \/ 2\)/,
    '行握点未随悬停行中线定位（按实测握点高 gh 居中；offsetParent = 行轨，须以行轨 rect 为基准）');
  assert.match(src, /colGripEl\.style\.left = \(hr\.left - kr\.left \+ hr\.width \/ 2\)/,
    '列握点未随悬停列中心定位（offsetParent = 列轨，须以列轨 rect 为基准）');
  assert.match(src, /rowTrackEl\.getBoundingClientRect\(\)[\s\S]{0,260}rowGripEl\.style\.top/,
    '行握点定位未以行轨 rect 为基准（wrap 加上下留白后以 wrap rect 为基准会整体偏移上留白 24px）');
  const dsIdx = src.indexOf('_wysiwygTableDragStart(ev) {');
  assert.match(src.slice(dsIdx, dsIdx + 2500), /closest\('\.wysiwyg-table-row-handle'\)/, '拖拽入口未接行把手元素');
  assert.match(src.slice(dsIdx, dsIdx + 2500), /closest\('\.wysiwyg-table-col-pill'\)/, '拖拽入口未接列把手元素');
  // 表头行可拖（2026-10-13 反馈 #2）：行轨反查从 i=0 起、行握点不再排除 THEAD
  assert.match(src.slice(dsIdx, dsIdx + 2500), /closest\('\.wysiwyg-table-row-handle'\)[\s\S]{0,400}for \(let i = 0; i < trsAll\.length/,
    '拖拽入口行轨反查未含表头行（i 须从 0 起，反馈 #2）');
  assert.ok(src.indexOf("parentElement.tagName !== 'THEAD'") < 0,
    '行握点仍排除表头行（反馈 #2：表头行也要出握点、可拖）');
  // 表头格不得作为列拖把手（2026-10-20 用户要求：表头不允许拖动，只有顶部/左侧
  // 把手可发起拖拽；表头格按下 = 普通格编辑）。列拖唯一入口 = 顶部列轨（pill）。
  const dStart = src.slice(dsIdx, dsIdx + 2600);
  assert.doesNotMatch(dStart, /if \(isHeader && cIdx/,
    '表头格仍可作为列拖把手启动拖拽（2026-10-20 起只允许顶部/左侧把手）');
  assert.match(dStart, /closest\('\.wysiwyg-table-col-pill'\)[\s\S]{0,600}kind: 'col'/,
    '列拖未从顶部列轨（pill）启动');
  // 阈值处只取消「本次按下才触发」的格编辑（防御路径）；按下前已存在的格编辑
  // 保留到释放时提交（2026-10-14 用户反馈：改完格内容立即拖行/列不得丢内容）
  assert.match(src, /if \(this\._wysiwygCellEditing && this\._wysiwygCellEditing !== st\.cellEditAtDown\) this\._wysiwygEndCellEdit\(false\);/,
    '拖拽超阈值未区分「本次按下触发的格编辑」与「按下前已存在的格编辑」（取消后者会丢内容）');
  // 表头行拖拽的 DOM 结构保护：tr 离开 thead 会被浏览器收进 tbody——
  // 恢复时须归位 thead；原位释放（no-op）也须恢复 DOM（防留下空 thead）
  assert.match(src, /thead\.appendChild\(dragTr\)/, '表头行拖拽恢复未归位 thead（会留下空 thead 坏结构）');
  assert.match(src, /to === st\.idx\) \{[\s\S]{0,120}_wysiwygTableRestoreDom\(st\);/,
    '原位释放未恢复 DOM（表头拖拽 no-op 会留下坏结构）');
  // 拖动中蓝胶囊跟随指针（2026-10-13 反馈 #1，行/列同款）：
  // 行拖按 y、列拖按 x 连续定位（clamp 到轨道），mouse 移动让位给 pointermove 写入
  assert.match(src, /gripEl\.style\.top = top \+ 'px'/, '拖拽中行握点未按指针 y 连续跟随（反馈 #1）');
  assert.match(src, /gripEl\.style\.left = left \+ 'px'/, '拖拽中列握点未按指针 x 连续跟随（反馈 #1）');
  assert.match(src, /if \(self\._wysiwygTableDrag && self\._wysiwygTableDrag\.moved\) return;/,
    'mousemove 未在拖拽中让位（会与拖拽跟随两路写入打架 → 胶囊跳动/消失）');
  // 拖动态切换：超阈值轨道加 .wysiwyg-dragging（内部握点变蓝底），结束态恢复
  assert.match(src, /track\.classList\.add\('wysiwyg-dragging'\)/, '进入拖拽未把轨道切为拖动态（握点变蓝底胶囊）');
  assert.match(src, /querySelectorAll\('\.wysiwyg-dragging'\)/, '结束拖拽未恢复握点悬停态');
  // 落点指示线（2026-10-13 反馈 #1/#2：拖拽中被拖行/列留在原位淡蓝高亮、蓝线标落点，
  // 对齐参考图——不再实时重排 DOM，释放时按 st.target 一次换位提交）
  assert.match(src, /dropLineEl\.className = 'wysiwyg-table-drop-line'/, '缺落点指示线元素创建');
  assert.match(src, /lineEl\.style\.top = \(boundary - wr\.top - 1\) \+ 'px'/, '行拖落点线未按边界 y 定位（相对 wrap 盒、2px 线居中于边界 = 边界-1）');
  assert.match(src, /lineEl\.style\.left = \(boundary - wr\.left - 1\) \+ 'px'/, '列拖落点线未按边界 x 定位（相对 wrap 盒、2px 线居中于边界 = 边界-1）');
  assert.match(src, /lineEl\.className = 'wysiwyg-table-drop-line wysiwyg-drop-line-row'/, '行拖落点线未切横线形态');
  assert.match(src, /lineEl\.className = 'wysiwyg-table-drop-line wysiwyg-drop-line-col'/, '列拖落点线未切竖线形态');
  assert.match(src, /const to = \(typeof st\.target === 'number' && isFinite\(st\.target\)\) \? st\.target : st\.idx;/,
    '拖拽释放未按 st.target（move 中算出的落点）提交（拖拽中 DOM 恒为原序，不能读 DOM 序）');
  assert.ok(src.indexOf('ref.before(dragTr)') < 0 && src.indexOf('after(dragTr)') < 0,
    '拖拽中仍在实时重排 DOM（反馈 #1/#2：被拖项应留在原位高亮，蓝线指示落点，释放时一次换位）');
  assert.match(src, /st\.target = st\.idx;/, '拖拽状态未初始化落点 st.target（未动指针即释放时的兜底）');
  // 蓝把手尺寸（2026-10-13 反馈「行/列拖按钮样式一致」）：同一风格 = 16px 厚 + 4px 圆角，
  // 点阵恒为未按下态 ⋮⋮ 2×3 点阵（2026-10-14 用户反馈：按下/拖动只背景变蓝，不换点阵）
  // ——行拖 = 竖条（16px 宽 × 行高）；列拖 = 横条（宽 = 被拖列宽、高 16px）；结束态清除 inline 尺寸
  assert.match(css, /wysiwyg-table-row-handle\.wysiwyg-dragging \.wysiwyg-table-row-grip \{[\s\S]{0,200}background: var\(--accent-color\);[\s\S]{0,120}border-radius: 4px;/,
    '行拖蓝把手未做 16px 厚圆角竖条（与列拖/增行增列条同厚 16px）');
  assert.match(src, /grip\.style\.height = rh \+ 'px'/, '行拖进入拖动态未把蓝把手高度设为行高（反馈 #3）');
  assert.match(src, /const refRow = st\.trs\[st\.idx\];/, '行拖蓝把手行高取值源不对（行拖 = 被拖行）');
  assert.ok(!/grip\.textContent = '\\u22EE';/.test(src) && !/grip\.textContent = '\\u22EF'/.test(src),
    '按下/拖动仍换点阵文本（2026-10-14 用户反馈：点阵须保持未按下态 ⋮⋮ 2×3 点阵，只变蓝底）');
  assert.match(css, /wysiwyg-table-col-pill\.wysiwyg-dragging \.wysiwyg-table-col-grip \{[\s\S]{0,200}border-radius: 4px;/,
    '列拖蓝把手未做圆角宽横条（参考图：宽横条）');
  assert.ok(!/wysiwyg-table-col-pill\.wysiwyg-dragging \.wysiwyg-table-col-grip \{[\s\S]{0,200}width: 16px;/.test(css),
    '列拖把手仍定宽 16px（应为宽横条、宽度 = 被拖列宽）');
  assert.match(src, /grip\.style\.width = Math\.max\(26, Math\.round\(cw\)\) \+ 'px'/,
    '列拖蓝把手宽未按被拖列宽设置（参考图：宽横条，最小 26px 兜底）');
  assert.match(src, /g\.style\.height = '';[\s\S]{0,160}g\.style\.width = '';[\s\S]{0,160}g\.textContent = '\\u22EE\\u22EE';/,
    '结束拖拽未清除蓝胶囊 inline 尺寸/点阵文本（会残留行高/宽横胶囊）');
  // 落点线 inline 坐标残留（2026-10-14 用户截图「线跑右边去了」）：无提交的拖拽
  // （原位释放/取消）不重建遮罩，同一 drop-line 元素存活到下一次拖拽；行拖/列拖各写
  // 各的轴（top/left），残留的 inline 压过 CSS left:0/top:24px → 另一方向的线串位
  // （列拖残留 left=表宽 → 行拖横线从表右缘起飞、向右延伸出表格）。收尾必须连
  // left/top 一起清；move 中写自己轴前清另一轴（每次拖拽自洽，纵深防御）。
  const edDragIdx = src.indexOf('_wysiwygEndTableDragState() {');
  assert.ok(edDragIdx > 0, '缺 _wysiwygEndTableDragState');
  const edDragBody = src.slice(edDragIdx, edDragIdx + 2200);
  assert.match(edDragBody, /lineEl\.style\.opacity = '0';[\s\S]{0,200}lineEl\.style\.left = '';[\s\S]{0,80}lineEl\.style\.top = '';[\s\S]{0,120}lineEl\.className = 'wysiwyg-table-drop-line';/,
    '结束拖拽未清落点线 inline 坐标（残留 left/top 会让下一方向拖拽的线串位）');
  assert.match(src, /lineEl\.style\.left = ''; \/\/ 清上一次列拖残留的 inline left/,
    '行拖未清上一次列拖残留的 inline left（纵深防御：每次拖拽自洽）');
  assert.match(src, /lineEl\.style\.top = ''; \/\/ 清上一次行拖残留的 inline top/,
    '列拖未清上一次行拖残留的 inline top（纵深防御：每次拖拽自洽）');
  // 握点尺寸（2026-10-13 反馈 #3 定稿）：16×16 小方块、点阵 12px、与增行/增列条同厚
  assert.match(css.slice(rgIdx, rgIdx + 400), /height: 16px;/, '行握点未做 16px 高小方块（与增行/增列条同厚 16px）');
  assert.match(css.slice(rgIdx, rgIdx + 400), /font-size: 12px;/, '行握点点阵未加大（反馈 #3）');
  assert.match(css.slice(cgIdx, cgIdx + 450), /top: 2px;[\s\S]{0,80}height: 16px;/, '列握点未做 16px 高小方块（24px 上留白内底缘距表顶缘 6px，与行握点同距）');
  // IME 时序怪癖守卫（2026-10-13 用户第 7 条「输入完马上丢光标，像被回写」）：
  // compositionend 可能先于选字确认 Enter 到达（isComposing=false）——250ms 内只吞不提交
  assert.match(src, /lastCompositionEnd: 0/, '格编辑状态未记录组合结束时刻');
  assert.match(src, /st\.lastCompositionEnd = Date\.now\(\)/, 'compositionend 未记录时刻');
  assert.match(src, /e\.key === 'Enter' && st\.lastCompositionEnd && Date\.now\(\) - st\.lastCompositionEnd < 250/,
    '缺 IME 确认键残影守卫（组合刚结束的 Enter 被误当提交 → 回写重渲 + 焦点跳出格）');
  // 提交路径同步补焦点（延迟恢复的同步兜底）：setSelection 后直接 cm.focus()
  assert.ok((src.match(/cm\.focus\(\)/g) || []).length >= 2,
    '提交路径未同步 cm.focus()（延迟恢复外的第一道焦点归宿保障）');
});

test('配色方案：default 白底蓝 + 独立 classic 主题 + 设置项/导出透传', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // default = 白底 + #2563EB 蓝
  const dIdx = css.indexOf('[data-color-scheme="default"]');
  assert.ok(dIdx > 0, '缺 default 配色变量块');
  const dblk = css.slice(dIdx, dIdx + 2600);
  assert.match(dblk, /--bg-primary: #ffffff/, 'default 未改白底');
  assert.match(dblk, /--accent-color: #2563eb/, 'default 主题色未改 #2563EB');
  // classic 独立主题（旧暖灰风格）
  const cIdx = css.indexOf('[data-color-scheme="classic"]');
  assert.ok(cIdx > 0, '缺 classic 配色变量块');
  const cblk = css.slice(cIdx, cIdx + 2600);
  assert.match(cblk, /--bg-primary: #faf9f7/, 'classic 未保留暖灰底');
  assert.match(css, /data-color-scheme="classic"\]\[data-theme="dark"\]/, 'classic 深色变量块未纳入选择器组');
  // 设置项 + i18n
  const stSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'settings.js'), 'utf8');
  assert.match(stSrc, /\{ value: 'classic', label: t\('schemeClassic'\) \}/, '设置选项缺 classic');
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  assert.match(i18n, /schemeClassic: '经典'/, 'zh 缺 schemeClassic');
  assert.match(i18n, /schemeClassic: 'Classic'/, 'en 缺 schemeClassic');
  assert.match(i18n, /schemeClassic: 'Clásico'/, 'es 缺 schemeClassic');
});

test('所见即所得跳转修复：面包屑/锚点/全局搜索跳转前解罩目标块', () => {
  const laySrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'layout.js'), 'utf8');
  const jIdx = laySrc.indexOf('_jumpToHeadingLine(line) {');
  assert.ok(jIdx > 0, '缺少 _jumpToHeadingLine');
  const jblk = laySrc.slice(jIdx, jIdx + 1400);
  assert.match(jblk, /this\.viewMode === 'wysiwyg'/, '面包屑跳转未识别 wysiwyg 模式');
  assert.match(jblk, /this\.setWysiwygActiveBlock\(idx\)/, '面包屑跳转未先解罩目标块（光标被 clamp 到遮罩边缘，跳不准）');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const aIdx = wsrc.indexOf('_wysiwygScrollToAnchor(id) {');
  assert.ok(aIdx > 0, '缺少 _wysiwygScrollToAnchor');
  const ablk = wsrc.slice(aIdx, aIdx + 3000);
  assert.match(ablk, /this\._wysiwygMarks\.has\(aIdx\)\) this\.setWysiwygActiveBlock\(aIdx\)/, '锚点跳转未先解罩目标块');
  const fSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'find.js'), 'utf8');
  const fmIdx = fSrc.indexOf('async jumpToMatch(filePath, line, col, len) {');
  assert.ok(fmIdx > 0, '缺少 jumpToMatch');
  const fblk = fSrc.slice(fmIdx, fmIdx + 3000);
  assert.match(fblk, /this\.viewMode === 'wysiwyg'/, '全局搜索跳转未识别 wysiwyg 模式');
  assert.match(fblk, /this\.setWysiwygActiveBlock\(idx\)/, '全局搜索跳转未解罩目标块');
  assert.match(fblk, /Date\.now\(\) - t0 < 2000/, '遮罩未挂完时未等块表就绪（刚切文件预渲染在飞会落空）');
});

test('precompute 防御：返回前滤除缺 start/end 的畸形块（HMR 混载 reading-start 崩溃双保险）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const pIdx = wsrc.indexOf('precomputeWysiwygBlocksFull() {');
  assert.ok(pIdx > 0, '缺少 precomputeWysiwygBlocksFull');
  const pblk = wsrc.slice(pIdx, pIdx + 2200);
  assert.match(pblk, /blocks\.filter\(\(b\) => b && typeof b\.start === 'number' && typeof b\.end === 'number' && b\.end > b\.start\)/,
    'precompute 返回前未滤畸形块条目（undefined 元素进下游 .start 读取即崩）');
});

test('表格交互 2026-10-14 四项修复：表后落行/Enter 切格/点空白不撤罩', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ① 表格是文档最后块时，格编辑结束须在块后补空行再落光标——clamp 到块内最后一行会
  // 把表格判成活动块撤罩，「表格下面的一行一旦输入内容，表格就会变成源码格式」
  const elIdx = src.indexOf('_wysiwygCellEditEndLine(b) {');
  assert.ok(elIdx > 0, '缺 _wysiwygCellEditEndLine（格编辑结束落位行）');
  const elblk = src.slice(elIdx, elIdx + 900);
  assert.match(elblk, /base >= cm\.lineCount\(\)/, '未识别「块是文档最后块」（b.end == lineCount）');
  assert.match(elblk, /cm\.replaceRange\('\\n', \{ line: last, ch \}, \{ line: last, ch \}, '\+wysiwygTableCell'\)/,
    '块后无行时未补空行（光标仍会落进表格遮罩区间）');
  assert.strictEqual((src.match(/_wysiwygCellEditEndLine\(/g) || []).length, 3,
    '补空行落位未同时接在提交路径与取消（Esc）路径（定义 1 处 + 调用 2 处 = 3）');
  // ③ Enter = 移到下一格：同行右邻 → 下一行首格 → 末行提交回编辑器；
  // 切格前必须先提交本格（状态被新格覆盖后旧格 blur 守卫变 no-op，内容会丢）
  assert.match(src, /let nr = st\.rowIdx, nc = st\.colIdx \+ 1;[\s\S]{0,60}if \(nc >= n\) \{ nr = st\.rowIdx \+ 1; nc = 0; \}/,
    'Enter 未算下一格（右邻 → 下一行首格）');
  assert.match(src, /if \(nr < trsNow\.length\) \{[\s\S]{0,60}self\._wysiwygStartCellEditAt\(nr, nc\);/,
    'Enter 有下一格时未进下一格编辑（末行才走提交回编辑器）');
  const saIdx = src.indexOf('_wysiwygStartCellEditAt(rowIdx, colIdx, blockIdx) {');
  assert.ok(saIdx > 0, '缺少 _wysiwygStartCellEditAt');
  assert.match(src.slice(saIdx, saIdx + 400), /if \(this\._wysiwygCellEditing\) this\._wysiwygEndCellEdit\(true, false\);/,
    '切格（Tab/Enter/增行增列）未先提交本格（旧格内容丢失）/ 提交未用 settle=false（切格会误挪光标到块后、表格是最后块时误补空行）');
  // ④ 点表格右侧/下方空白不进源码模式：capture 阶段按「点击映射行是否落在已挂遮罩的
  // 表格块」拦截（preventDefault → CM onMouseDown 先查 defaultPrevented 不挪光标）；
  // 遮罩内表格杂点（wrap 留白）在遮罩 mousedown 吞掉，不再走纵向比例映射源码行
  const gIdx = src.indexOf('_ensureWysiwygTableClickGuard() {');
  assert.ok(gIdx > 0, '缺表格点击守卫 _ensureWysiwygTableClickGuard');
  const gblk = src.slice(gIdx, gIdx + 1600);
  assert.match(gblk, /wrapper\.addEventListener\('mousedown', \(ev\) => \{[\s\S]{0,200}t\.closest\('\.' \+ MASK_CLASS\)\) return;/,
    '守卫未排除遮罩内部点击（格/轨道/条带/按钮由遮罩自行派发）');
  assert.match(gblk, /cm\.coordsChar\(\{ left: ev\.clientX, top: ev\.clientY \}\)/, '守卫未按点击坐标换算源码行');
  assert.match(gblk, /wysiwygBlockIndexAt\(pos\.line\)/, '守卫未把点击行映射到块');
  assert.match(gblk, /maskNode\.querySelector\('\.wysiwyg-table-wrap'\)/, '守卫未识别「已挂遮罩的表格块」');
  assert.match(gblk, /ev\.preventDefault\(\);[\s\S]{0,80}\}, true\);/, '守卫未 preventDefault（CM 仍会把光标落进表格行撤罩）');
  assert.match(src, /this\._ensureWysiwygTableClickGuard\(\);/, '守卫未在遮罩挂载流程接线');
  assert.match(src, /if \(node\.querySelector && node\.querySelector\('\.wysiwyg-table-wrap'\)\) return;/,
    '遮罩内表格杂点未吞掉（会落入纵向比例映射 → 整表撤罩变源码）');
  // ① 根因修复：GFM 会把表格末行之下紧邻的非空文本行解析成表格行（吸进表格 → 光标行
  // 落入表格块 → 判活动块撤罩变源码）。输入守卫：表下空行被插入非空白文本时整体下移
  // 一行（空行留在表格与文本之间）；IME 组合期跳过、compositionend 后补下移。
  const pgIdx = src.indexOf('_wysiwygPushTypedLineBelowTable(L) {');
  assert.ok(pgIdx > 0, '缺表下输入下移 _wysiwygPushTypedLineBelowTable');
  const pgblk = src.slice(pgIdx, pgIdx + 1200);
  assert.match(pgblk, /blocks\[i\]\.end === L/, '未识别「行上方是块末行」');
  assert.match(pgblk, /node\.querySelector\('\.wysiwyg-table-wrap'\)/, '未限定已挂遮罩的表格块（活动表格 = 源码态，正常编辑不得干扰）');
  assert.match(pgblk, /cm\.replaceRange\('\\n', \{ line: L, ch: 0 \}, \{ line: L, ch: 0 \}, '\+wysiwygTableTypeGuard'\)/, '未把输入下移一行（空行分隔被吃掉）');
  const tgIdx = src.indexOf('_ensureWysiwygTableTypeGuard() {');
  assert.ok(tgIdx > 0, '缺表下输入守卫接线 _ensureWysiwygTableTypeGuard');
  const tgblk = src.slice(tgIdx, tgIdx + 1600);
  assert.match(tgblk, /if \(c\.from\.line !== c\.to\.line \|\| c\.from\.ch !== c\.to\.ch\) return;/,
    '守卫未限定「纯插入」（零宽替换 from==to；CM5 零宽插入 removed=[""]，不能按 removed 判）');
  assert.match(tgblk, /before\.trim\(\) !== ''/, '守卫未限定「插入前行为空白」（已有内容的行不是分隔空行）');
  assert.match(tgblk, /this\.cm\.on\('compositionend'/, '缺 IME compositionend 补下移（组合期跳过、组合落定后下移）');
  assert.match(src, /this\._ensureWysiwygTableTypeGuard\(\);/, '输入守卫未在遮罩挂载流程接线');
});

test('遮罩点击防抖窗口守卫：输入后 250ms 内点其他块遮罩不得整篇闪烁（S38 全格式矩阵实锤的竞态）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 块表在 change 后 250ms 防抖才重切；窗口内点遮罩时实时行号查旧表漏块 → -1 →
  // setWysiwygActiveBlock(-1) 撤掉当前活动块 → 整篇瞬间全遮罩闪一下。-1 时须同步轻
  // 切块（computeWysiwygBlocks(true) parseOnly，不渲染）用最新表再查。
  const fIdx = src.indexOf('_wysiwygBlockIndexAtFresh(line) {');
  assert.ok(fIdx > 0, '缺 _wysiwygBlockIndexAtFresh（遮罩点击的防抖窗口块表守卫）');
  const fblk = src.slice(fIdx, fIdx + 700);
  assert.match(fblk, /this\.computeWysiwygBlocks\(true\)/, '守卫未做 parseOnly 轻切块（只切边界不渲染，廉价同步）');
  assert.match(fblk, /idx = this\.wysiwygBlockIndexAt\(line\);/, '轻切块后未按最新表重查索引');
  // 遮罩 mousedown 的两条活动块落点（普通点击 + 块编辑按钮）都必须走 Fresh 版
  assert.match(src, /self\.setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(line\)\);/,
    '遮罩普通点击未走 _wysiwygBlockIndexAtFresh（防抖窗口内点击会整篇遮罩闪烁）');
  assert.match(src, /self\.setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(r\.from\.line\)\);/,
    '块编辑按钮点击未走 _wysiwygBlockIndexAtFresh（同一竞态）');
});

test('幽灵 Enter 吞除：WebView2 中文 IME 选字确认残影键不再多续列表行（2026-10-14 用户反馈「列表回车后光标落新行的下一行」）', () => {
  const fsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'format.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  // ① Enter 键处理体（extraKeys 'Enter' 绑定，editor-core L170-171）开头有幽灵窗守卫：
  // 组合刚结束 250ms 内返回（undefined = 键被消费，codemirror.js doHandleBinding 语义）
  const hIdx = fsrc.indexOf('_handleTableEnter(cm) {');
  assert.ok(hIdx > 0, '缺 _handleTableEnter（Enter 键映射处理体）');
  const hblk = fsrc.slice(hIdx, hIdx + 1400);
  assert.match(hblk, /this\._lastCompositionEnd && now - this\._lastCompositionEnd < 250\) return;/,
    '缺幽灵 Enter 吞除窗守卫（组合刚结束的残影 Enter 会多续一条列表行 → 真实 Enter 再续一条 → 光标在新行下面一行）');
  // ② 时间戳必须来自输入域的原生 DOM compositionend：CM 5.65.18 不触发用户级
  // compositionstart/end 编辑器事件（cm.on 处理器不执行，官方源码已核），
  // 挂 cm.on 上的时间戳永远是 undefined → 守卫失效
  assert.match(coreSrc, /inputField\.addEventListener\('compositionend', \(\) => \{[\s\S]{0,120}this\._lastCompositionEnd = Date\.now\(\);/,
    '幽灵 Enter 时间戳未挂输入域原生 DOM compositionend（cm.on compositionend 在 CM 5.65.18 不触发）');
  // ③ 2026-10-17 补：组合标志须同样挂输入域原生 DOM compositionstart（cm.on compositionstart
  // 是死代码）——组合期逐字幽灵 insertLineBreak 靠此标志识别吞除（S50 场景：防幽灵换行进模型）。
  // ⚠️ 与「拼音竖排」症状无关：竖排是 CSS 层 24px 前缀槽折行（见 S52 + styles.css），
  // 组合期模型全程干净（2026-10-18 真机 dump 证实 model 恒为 "1. "）。
  assert.match(coreSrc, /inputField\.addEventListener\('compositionstart', \(\) => \{[\s\S]{0,60}this\._wysiwygComposing = true;/,
    '组合标志未挂输入域原生 DOM compositionstart（cm.on compositionstart 死代码 → _wysiwygComposing 恒 false，组合期逐字幽灵全漏）');
  assert.match(coreSrc, /if \(this\._wysiwygComposing\) \{[\s\S]{0,80}e\.preventDefault\(\);/,
    'beforeinput 守卫缺「组合期吞换行」分支（_wysiwygComposing 为 true → 吞；双时间戳窗口无法覆盖组合中逐字幽灵）');
});

test('token 中和 + 同身 span 渲染色重申（CM5 合并同区间 marker 成同身 span）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // 中和规则本体：plain-text 行内所有 cm- token span 继承（压掉 gfm 蓝/海军蓝/绿/紫）
  assert.match(css, /wysiwyg-plain-text span\[class[*]="cm-"\] \{[\s\S]{0,40}color: inherit;/,
    'token 中和规则本体丢失（编辑态文字会恢复 gfm token 色）');
  // CM5 把 token 区间与渲染化区间完全重合的两个 marker 合并成同一个 span
  //（cm-quote + wysiwyg-quote-text 同身、cm-header + wysiwyg-heading-hash 同身）；
  // 中和规则 (0,4,1) 压过渲染化颜色规则 (0,3,0) → 同身 span 的渲染色被洗掉
  //（引用正文次级色被洗成主色、列表符号透明被洗成实色，2026-10-14 全格式矩阵实测）。
  // 必须以 (0,5,1) 同前缀重申「有渲染色设计」的类（规则序在中和之后）。
  const oIdx = css.indexOf('class*="wysiwyg-quote-text"]');
  assert.ok(oIdx > 0, '缺同身 span 渲染色重申（引用正文的 --text-secondary 会被中和规则洗成主色）');
  // 2026-10-30：锚点后新增引用任务行 > 槽隐藏规则（约 +370 字符），窗口 2400 → 3200
  const oblk = css.slice(Math.max(0, oIdx - 900), oIdx + 3200);
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-quote-text"\][\s\S]{0,120}color: var\(--text-secondary\);/,
    '引用正文次级色未用 (0,5,1) 重申');
  // 2026-10-20：> 槽同身（cm-quote + slot）须重申透明（默认只在光标行显示），
  // 光标行再以上述 (0,6,1) 规则显色
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-quote-slot"\][\s\S]{0,120}color: transparent;/,
    '引用 > 槽透明未用 (0,5,1) 重申（同身时 token 中和会把 > 洗回实色）');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-heading-hash"\][\s\S]{0,120}color: var\(--text-secondary\);/,
    '标题 # 前缀次级色未用 (0,5,1) 重申');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-inline-link"\][\s\S]{0,160}color: var\(--accent-color\);/,
    '链接主题色未用 (0,5,1) 重申');
  assert.doesNotMatch(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-inline-link"\][\s\S]{0,200}text-decoration: underline/,
    '链接重申规则不得含 underline（渲染态 .preview-content a 是 text-decoration:none，2026-10-15 对齐口径）');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-underline"\][\s\S]{0,100}text-decoration: underline;/,
    '缺 <u> 同身 span 下划线重申（中和规则会洗掉，与渲染态 ins/u 不一致）');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-strike"\][\s\S]{0,100}text-decoration: line-through;/,
    '缺 ~~ 同身 span 删除线重申（cm-strikethrough token 同身会被中和规则洗掉）');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-inline-marker"\][\s\S]{0,1200}wysiwyg-list-bullet[\][\s\S]{0,500}wysiwyg-task-prefix[\][\s\S]{0,120}color: transparent;/,
    '标记透明/列表符号透明/任务前缀槽透明未用 (0,5,1) 重申（源字符会压住 ::before 渲染符号）');
});

test('列表回车幽灵键双窗：keydown 重复投递窗（窗②）+ input 通道幽灵换行守卫', () => {
  const fsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'format.js'), 'utf8');
  const csrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  // format.js：先记录本笔 keydown Enter（即使被吞也记录）——input 通道守卫靠它识别重复投递
  assert.match(fsrc, /this\._lastEnterKeydownAt = now;/,
    '缺 _lastEnterKeydownAt 记录（input 通道守卫依赖它识别「同一按键的重复投递」）');
  // 窗②：距上一笔 Enter <150ms 且组合 10s 内刚结束 → 吞（真人连按 ≥80ms + 无 IME 上下文不误吞）
  assert.match(fsrc, /sincePrevEnter < 150 && this\._lastCompositionEnd && now - this\._lastCompositionEnd < 10000\) return;/,
    '缺幽灵窗②（用户选字后又输入一段再回车：重复投递 Enter 紧随真实 Enter 数十 ms 到达，窗①已失效 → 多一行、光标落新行下一行）');
  // editor-core：beforeinput 幽灵换行守卫（CM5 ContentEditableInput 只监听 input 不监听
  // beforeinput → 幽灵 insertLineBreak 会作为裸换行进模型；合法 keydown Enter 被
  // extraKeys preventDefault 后浏览器不再投递 beforeinput → 窗口内到达者必为幽灵）
  assert.match(csrc, /addEventListener\('beforeinput', \(e\) => \{[\s\S]{0,120}insertLineBreak[\s\S]{0,80}insertParagraph/,
    '缺 input 通道守卫（幽灵 beforeinput insertLineBreak 会被 CM5 当裸换行读进模型）');
  assert.match(csrc, /_lastCompositionEnd \? \w+ - this\._lastCompositionEnd/,
    '幽灵换行守卫缺 _lastCompositionEnd 通道（IME 确认 Enter 无残留 keydown 时 _lastEnterKeydownAt 不刷新 → 幽灵全漏 → 模型每字一行）');
  assert.match(csrc, /< 2000 \|\|[\s\S]{0,60}< 2000/,
    '幽灵守卫非双时间戳（Enter keydown + compositionend）OR 2000ms 窗口（300ms 漏检；单戳在 IME 确认 Enter 无残留 keydown 时漏）');
  assert.match(csrc, /e\.preventDefault\(\);/, '缺幽灵 beforeinput 的取消（不取消则对应 input 事件仍触发、CM 仍读得到）');
});

test('块内回车续行保持活动块：光标行紧邻活动块末端时同步轻切块再查（2026-10-15 用户反馈「提示块按一次回车就退出编辑渲染」）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const sIdx = src.indexOf('syncWysiwygActiveBlock() {');
  assert.ok(sIdx > 0, '缺 syncWysiwygActiveBlock（cursorActivity 活动块同步）');
  // 窗口需覆盖方法体（2026-10-20 光标空行 inline 同步段前移后 >3.2k；2026-10-21 光标
  // 空行两级语义修订注释加长后 >4.6k）
  const sblk = src.slice(sIdx, sIdx + 5400);
  // 旧表未命中（-1）时不再直接按 -1 处理（2026-10-17 起块归属判定提前到空行两级
  // 语义共用，现算值存 lineBlockIdx 再赋给 activeIdx）
  assert.match(sblk, /const lineBlockIdx = this\.wysiwygBlockIndexAt\(line\);/,
    '活动块现算未走可纠正路径（旧块表滞后 250ms，Enter 续行新行不在旧表里）');
  // 紧邻活动块末端 → 同步轻切块（parseOnly）按最新表再查：续行仍在块内 → 保持活动；
  // 真在块外 → 照旧 -1（防抖刷新的 marks 守卫会把重遮固化，错过这个时机活动块回不来）
  assert.match(sblk, /line === pb\.end\) activeIdx = this\._wysiwygBlockIndexAtFresh\(line\);/,
    '缺紧邻活动块末端行的同步重查（Enter 续行新行 = 活动块 end 的下一行，旧表漏它 → 当前块被重遮渲染、没法继续换行）');
});

test('下划线渲染化：<u> 原生 HTML 标签在编辑态同渲染观感（2026-10-14 全格式矩阵用户要求）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const pIdx = wsrc.indexOf('function parseWysiwygInlineSpans(text) {');
  assert.ok(pIdx > 0, '缺 parseWysiwygInlineSpans');
  const pblk = wsrc.slice(pIdx, pIdx + 6000);
  assert.match(pblk, /reUnderline = \/\^<u>\(\[\^<\\n\][+]\)<\\\/u>\//, '缺 <u></u> 行内形态正则（单标签成对、不含嵌套标签/换行）');
  assert.match(pblk, /kind = 'underline'/, '缺 underline 分支');
  assert.match(pblk, /push\(start, start \+ 3, 'wysiwyg-inline-marker'\);[\s\S]{0,120}push\(start \+ 3, end - 4, 'wysiwyg-underline'\);/,
    '开/闭标签宽度不对称（<u> 3 字符 / </u> 4 字符）未单独处理（走了对称 tick 分支会错位）');
  assert.match(css, /\.wysiwyg-underline \{ text-decoration: underline; \}/, '缺 .wysiwyg-underline 渲染样式（与渲染态 <u> 观感一致）');
});

test('混合列表黑点归位（CommonMark：空行不拆列表；::before 画圆取代原生 marker，2026-10-16 用户反馈 #3 规范口径）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 用户场景 = ul + 空行 + 任务列表。CommonMark：空行只把列表变松散，同型列表从不因
  // 空行断开 → 必须渲染为一个 contains-task-list（用户确认按规范、不拆块）。
  // 任务样式把 ul padding 清零后，普通项若只恢复 list-style:disc，原生 outside marker
  // 相对 **li 边框缘**（=ul 内容缘）定位 → 黑点偏左 24px（截图「黑点与左侧距离异常」）。
  // 修复：list-style:none + padding-left:24px（正文回 x=56）+ ::before 画圆（38–44px，
  // 与正常 ul disc / WYSIWYG 画圆同坐标）。
  assert.match(css, /ul\.contains-task-list > li:not\(\.task-list-item\)\s*\{[^}]*list-style: none;/,
    '混合列表普通项应 list-style:none（原生 disc 相对 li 边框缘定位会偏左 24px，不能恢复原生 marker）');
  assert.match(css, /ul\.contains-task-list > li:not\(\.task-list-item\)\s*\{[^}]*padding-left: 24px;/,
    '混合列表普通项未恢复 padding-left:24px（正文应与任务文本同列 x=56）');
  assert.match(css, /li:not\(\.task-list-item\)\s*::before[^}]*left: 6px;[^}]*width: 6px;/,
    '缺 ::before 画圆（left:6px → 38–44px，与正常 ul disc 同位）');
  assert.match(css, /li:not\(\.task-list-item\)\s*::before[^}]*top: calc\(0\.938em - 3px\)/,
    '画圆 top 锚点未用 WYSIWYG 画圆同式 0.938em（S45 已对正常 ul disc 做像素校准，两态同锚才同位）');
  // 回归守卫：渲染层/遮罩层不得再出现「按空行拆列表」机制（2026-10-16 用户否决：
  // 拆块与 CommonMark 相悖，且引入 gap 块/CM5 行合并等新问题）
  assert.ok(!rsrc.includes('splitListAtBlankLines'), 'splitListAtBlankLines 不得复活（CommonMark 空行只松散、不拆）');
  assert.ok(!rsrc.includes('wysiwyg-list-gap'), 'wysiwyg-list-gap 空行占位不得复活');
  assert.ok(!wsrc.includes('listGap'), 'wysiwyg.js 的 listGap 遮罩特判不得复活');
  // no-btn 列表判定：标记后允许「空格/Tab/行尾」（`1.` 独占一行的有序列表也是列表；
  // 只认 \s 会误判为非列表 → 漏 no-btn，S14 实测）
  assert.match(wsrc, /_wysiwygBlockIsList\(b\) \{[\s\S]{0,400}\(\\s\|\$\)/,
    'no-btn 列表判定未允许标记位于行尾（`1.` 独占一行的有序列表被误判为非列表）');
});

// ---------- 跨块选区（2026-10-16 用户反馈「用鼠标选中和全选都只能选中当前编辑的一小块，
// 没法跨块去选中」） ----------
// 根因（CM5 源码级）：遮罩 = markText+replacedWith → 强制 collapsed+atomic（codemirror.js
// L6013/L6052）。① inclusiveLeft:true 让连遮罩起点都算「区间内部」→ reCheckSelection 把
// Ctrl+A 锚点 {0,0} 推到首块末尾（实测 42/47 字符丢首块）；② 遮罩 mousedown 的
// stopPropagation+preventDefault 让 CM 收不到按下 → 从遮罩起拖永远是「跳光标」；③ CM 只给
// 可见源码行画选框，widget 节点无选中态 → 跨块选区看起来只剩当前活动块。
test('跨块选区：遮罩两端非包含（选区端点可停在遮罩边界，Ctrl+A 不得丢首块）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const mIdx = wsrc.indexOf('maskWysiwygBlock(idx) {');
  assert.ok(mIdx > 0, '缺 maskWysiwygBlock');
  // markText 调用在 mousedown 接管块之后（接管块 2026-10-16 点击/拖拽分流后很长，且其后
  // 持续追加逻辑）——固定窗口会随函数变长而截断（2026-07-13 普通文字按钮注释加长即触发），
  // 改为在全文中定位 markText（全文件唯一）后开窗，不再受函数长度影响
  const optIdx = wsrc.indexOf('cm.markText(from, to, {', mIdx);
  assert.ok(optIdx > 0, 'maskWysiwygBlock 未用 markText');
  const opts = wsrc.slice(optIdx, optIdx + 700);
  assert.match(opts, /inclusiveLeft: false/, '遮罩标记须 inclusiveLeft:false（true 时 {0,0} 算区间内部被推到遮罩末 → Ctrl+A 丢首块）');
  assert.match(opts, /inclusiveRight: false/, '遮罩标记须 inclusiveRight:false（右端点同样要能停在遮罩边界）');
});

test('跨块选区：遮罩 mousedown 点击同步执行 + ≥4px 升级为选区拖拽', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const md = mousedownBlock(wsrc);
  // 点击行为必须在 mousedown 同步执行（不可推迟到 mouseup）：harness 模拟点击只派发
  // mousedown，真机按下瞬间解罩落光标也是既有交互契约（S1/S3/S15 全依赖此时序）
  assert.match(md, /self\.setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(line\)\);[\s\S]{0,700}cm\.focus\(\);[\s\S]{0,80}self\._applyWysiwygClickAnchor\(\);/,
    '点击行为未在 mousedown 同步执行（撤罩目标块 + 落行尾 + 点击锚定）');
  // 升级阈值：Manhattan 距离 <4px 视为未移动（不触发拖选）
  assert.match(md, /Math\.abs\(mv\.clientX - downX\) \+ Math\.abs\(mv\.clientY - downY\) < 4/,
    '缺 4px 升级阈值（从遮罩起拖永远是跳光标，选区跨不了块）');
  // 拖拽期冻结活动块同步（setSelection 触发 cursorActivity 会解罩指针下的块打断拖拽）
  assert.match(md, /self\._wysiwygSelDragging = true/, '拖拽分支未置 _wysiwygSelDragging 冻结位');
  const sIdx = wsrc.indexOf('syncWysiwygActiveBlock() {');
  const sblk = wsrc.slice(sIdx, sIdx + 1400);
  // 2026-07-13：冻结早退前先登记拖选释放归位（行内标记行类，见光标行显示源码测试）
  assert.match(sblk, /if \(this\._wysiwygSelDragging\) \{ this\._ensureWysiwygSelEndSync\(\); return; \}/,
    'syncWysiwygActiveBlock 缺遮罩拖选冻结守卫（或冻结前未登记释放归位）');
  // CM 原生拖选冻结须限定「非折叠选区」：普通单击窗口内 selectingText 也非空但选区折叠，
  // 无差别冻结会打断光标行灰底跟随（S15 回归）
  assert.match(sblk, /if \(this\.cm\.state && this\.cm\.state\.selectingText\) \{[\s\S]{0,200}if \(pr && !pr\.empty\(\)\) \{ this\._ensureWysiwygSelEndSync\(\); return; \}/,
    'syncWysiwygActiveBlock 缺 CM 原生拖选冻结守卫（活动块真实行起拖扫过遮罩行会中途解罩、几何漂移打断拖选）');
  // 拖拽 anchor 取遮罩边界（atomic 整块单元：向下/水平拖取块首、向上拖取块末）
  assert.match(md, /anchor = mv\.clientY >= downY \? \{ line: r\.from\.line, ch: r\.from\.ch \}[\s\S]{0,80}\{ line: r\.to\.line, ch: r\.to\.ch \}/,
    '拖拽 anchor 未取遮罩边界（atomic 区间不可部分选中，须以块首/块末为端点整块选中）');
  // head 随鼠标经 coordsChar 推进（落在遮罩内被 skipAtomic 钳到该遮罩边界 → 逐块跨越）
  assert.match(md, /cm\.coordsChar\(\{ left: mv\.clientX, top: mv\.clientY \}\)/, '拖拽 head 未随鼠标坐标映射推进');
});

test('跨块选区：被选区覆盖的遮罩挂选中着色类（CM 不给 widget 画选框，须手动补）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(wsrc, /_applyWysiwygSelectionMaskClasses\(\) \{/, '缺 _applyWysiwygSelectionMaskClasses');
  // 选区变化接线：⚠️ CM5 没有 'selection' 事件（on 未知事件静默不触发）——必须挂
  // cursorActivity（选区每次变化必触发，含鼠标拖选）
  assert.match(wsrc, /_ensureWysiwygSelectionHook\(\) \{[\s\S]{0,400}this\.cm\.on\('cursorActivity'/, '选区着色未挂 cursorActivity（CM5 无 selection 事件，挂错事件名着色恒不生效）');
  assert.ok(!/cm\.on\('selection'/.test(wsrc), "CM5 没有 'selection' 事件——挂错事件名会静默失效");
  assert.match(wsrc, /this\._ensureWysiwygSelectionHook\(\);/, 'renderWysiwygMasks 未调 _ensureWysiwygSelectionHook');
  // 覆盖判据：range.from ≤ mark.from 且 mark.to ≤ range.to（atomic 遮罩只有整块被盖/不盖）
  const aIdx = wsrc.indexOf('_applyWysiwygSelectionMaskClasses() {');
  const ablk = wsrc.slice(aIdx, aIdx + 1500);
  assert.match(ablk, /classList\.toggle\('wysiwyg-mask-selected', covered\)/, '未给遮罩节点挂 wysiwyg-mask-selected 类');
  // 遮罩挂/撤不触发 selection 事件：各变更路径须显式补刷（setWysiwygActiveBlock 两端 +
  // 渲染/刷新路径）——只认 selection 事件一条路会让跨块选区下的点击切换瞬间丢着色
  const calls = (wsrc.match(/this\._applyWysiwygSelectionMaskClasses\(\);|self\._applyWysiwygSelectionMaskClasses\(\);/g) || []).length;
  assert.ok(calls >= 6, `遮罩变更路径补刷不足（应 ≥6 处：setWysiwygActiveBlock 两端 + 渲染/刷新/视口，实得 ${calls}）`);
  // CSS 着色
  assert.match(css, /\.wysiwyg-block-mask\.preview-content\.wysiwyg-mask-selected \{[^}]*background-color: rgba\(38, 139, 210, 0\.16\);/,
    '缺 .wysiwyg-mask-selected 半透明着色（选区覆盖的遮罩块无选中观感）');
});

// ---------- 有序列表输入打散竖排（2026-10-16 用户截图；2026-10-17 补 compositionend 通道） ----------
// ⚠️ 2026-10-18 真机复核：本条守的是「幽灵换行进模型」（模型被打散成每字一行），
// 与用户 2026-10-18 报的「拼音组合期竖排」（模型干净、纯 CSS 折行）是**两个不同**问题，
// 后者见 S52 + styles.css 24px 前缀槽 nowrap。
// 根因①（2026-10-16）：幽灵 insertLineBreak（WebView2 input 通道）经 IPC 延迟 + WYSIWYG
//   防抖刷新阻塞主线程后，可在 Enter keydown 后 300ms+ 才到达 → 原 300ms 守卫窗外泄漏
//   → 裸换行进模型、光标逃逸出列表，逐字+逐幽灵换行 = 每字一行。修复① = 窗口扩到 2000ms。
// 根因②（2026-10-17）：IME 选字确认的 Enter 被输入法完整消费（无残留 keydown 进
//   extraKeys）时 _lastEnterKeydownAt 不刷新，幽灵仍到达 → 单戳守卫全漏（harness 探针
//   实测 6/6 漏、_lastEnterKeydownAt unset / _lastCompositionEnd set）。修复② = 守卫补
//   _lastCompositionEnd 双时间戳。安全性：合法键盘 Enter 恒被 extraKeys 消费（不产生
//   beforeinput）、粘贴 inputType 不同 → 窗口内 insertLineBreak/insertParagraph 必是幽灵。
test('幽灵换行守卫：双时间戳（Enter keydown + compositionend）且 2000ms 窗口', () => {
  const core = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  const harness = fs.readFileSync(path.join(ROOT, '_wysiwyg_compare.html'), 'utf8');
  const GHOST = "e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph'";
  const gIdx = core.indexOf(GHOST);
  assert.ok(gIdx > 0, 'editor-core 缺幽灵换行守卫（input 通道，2026-10-15 修复不得回退）');
  const gCore = core.slice(gIdx, gIdx + 2000);
  assert.match(gCore, /_lastEnterKeydownAt/, 'editor-core 守卫缺 _lastEnterKeydownAt 通道');
  assert.match(gCore, /_lastCompositionEnd/,
    'editor-core 守卫缺 _lastCompositionEnd 通道（IME 确认 Enter 无残留 keydown 时漏检 → 模型每字一行）');
  assert.match(gCore, /< 2000/, 'editor-core 幽灵换行守卫窗口不足（须 2000ms 覆盖 WebView2 IPC 延迟）');
  const hIdx = harness.indexOf(GHOST);
  assert.ok(hIdx > 0, 'harness 缺幽灵换行守卫（与 editor-core 同一守卫）');
  const gH = harness.slice(hIdx, hIdx + 1200);
  assert.match(gH, /_lastEnterKeydownAt/, 'harness 守卫缺 _lastEnterKeydownAt 通道（与 editor-core 不同步）');
  assert.match(gH, /_lastCompositionEnd/, 'harness 守卫缺 _lastCompositionEnd 通道（与 editor-core 不同步）');
  assert.match(gH, /< 2000/, 'harness 幽灵换行守卫窗口与 editor-core 不同步（须 2000ms）');
});

// ---------- 13. IME 上屏写坏列表前缀 → Enter 必须续行（2026-10-19 用户反馈） ----------
// 用户口径：「有序列表按回车没有新增一行，比如第一行是序号 1，行尾按回车，应该新增一行、
// 序号是 2，但现在是直接跳出有序列表了」。
// 成因（真机 CDP 用 Input.insertText 复现）：空列表项（"1. " / "- " / "- [ ] "）是列表行里唯一
// 「正文没有文本节点」的行——前缀槽固定 24px、源空格槽零宽（styles.css .wysiwyg-ol-marker /
// .wysiwyg-ol-space），Chromium 找不到能承载组合串的正文文本节点，就把拼音组合串塞进前缀槽**自己的
// 文本节点**。上屏后 CM 读 DOM 差分，marker 与正文之间那个分隔空格被挤到行尾 → 模型成为 "1.中国 "，
// 不再是合法列表项（continuelist 的 listRE 要求标记后必须有 \s）→ Enter 落到普通 newlineAndIndent
// 分支 = 退出列表，而不是续出 "2. "。只有空的有序列表项会中招。
// 修复 = format.js _recordBareListMarkerForIme（组合前记下「这行只有列表标记」）+
// _repairImeDamagedListPrefix（上屏后把丢掉的空格补回标记之后、并同步右移光标）。
// 行为回归在 scripts/wysiwyg-browser-check.mjs 的 S53 场景（真实浏览器 + 真实 DOM/CM 流程）；
// 此处只断言接线与实现要点，防止修复被静默回退。

const FORMAT_SRC = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'format.js'), 'utf8');

test('IME 上屏写坏列表前缀的修复：接线齐备（组合前记录 + 组合后修复）', () => {
  // ① 两个真实方法都在 format.js（不是散落在调用点的复制逻辑）
  assert.match(FORMAT_SRC, /_recordBareListMarkerForIme\(\)\s*\{/,
    'format.js 缺 _recordBareListMarkerForIme（组合前记录纯标记行）');
  assert.match(FORMAT_SRC, /_repairImeDamagedListPrefix\(\)\s*\{/,
    'format.js 缺 _repairImeDamagedListPrefix（上屏后修复被写坏的前缀）');
  // ② 只在「组合前是纯列表标记」时才记录（有正文的行组合串落在正文 span，天然安全 → 不得误伤）
  assert.match(FORMAT_SRC, /_imeBareMarker = \{ line: pos\.line \}/,
    '未记录组合前的纯标记行（修复无从判断该不该动）');
  assert.match(FORMAT_SRC, /if \(!IME_BARE_LIST_RE\.test\(text\)\) return;/,
    '记录时未过滤「仅纯列表标记」→ 会误改有正文的行');
  // ③ 损坏形态识别：标记后直接贴非空格正文
  assert.match(FORMAT_SRC, /IME_DAMAGED_LIST_RE/,
    'format.js 缺损坏形态识别正则（标记与正文之间丢了必需的分隔空格）');
  // ④ 修复动作 = 把分隔空格补回标记之后，并右移光标
  assert.match(FORMAT_SRC, /indent \+ marker \+ ' ' \+ body/,
    '修复未把分隔空格补回标记之后（markdown 要求标记后必须有空白）');
  assert.match(FORMAT_SRC, /pos\.ch > pivot[\s\S]{0,80}setCursor/,
    '修复后未同步右移光标（光标会落在标记右缘、下次输入位置错）');
  // ⑤ CM 读 DOM 是防抖的（readFromDOMSoon 80ms）→ 必须轮询重试，不能只取一次
  assert.match(FORMAT_SRC, /tries < 10[\s\S]{0,40}setTimeout\(apply, 80\)/,
    '修复未轮询等待 CM 读回 DOM（compositionend 当下模型可能还是旧文本 → 修复落空）');
});

test('IME 前缀修复接线：原生 compositionstart/end 调用 format.js 的真实方法', () => {
  const core = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  const harness = fs.readFileSync(path.join(ROOT, '_wysiwyg_compare.html'), 'utf8');
  const idx = core.indexOf("addEventListener('compositionstart'");
  assert.ok(idx > 0, 'editor-core 缺输入域原生 compositionstart 接线');
  const block = core.slice(idx, idx + 1200);
  assert.match(block, /_recordBareListMarkerForIme\(\)/,
    'compositionstart 未记录组合前的纯标记行（修复拿不到「该不该修」的依据）');
  assert.match(block, /_repairImeDamagedListPrefix\(\)/,
    'compositionend 未调用前缀修复');
  // 与幽灵换行守卫同一接线块，不得另起一套（避免两处口径漂移）
  assert.match(block, /_wysiwygComposing = true/,
    '组合标志与修复接线被拆散（须同一对原生监听器）');
  // 对照物 harness 必须调用真实方法，不得复制一份逻辑
  assert.match(harness, /_recordBareListMarkerForIme\(\)/,
    'harness 未接线 _recordBareListMarkerForIme（对照物与产品脱节）');
  assert.match(harness, /_repairImeDamagedListPrefix\(\)/,
    'harness 未接线 _repairImeDamagedListPrefix（对照物与产品脱节）');
});

// ---------- 14. 块间空行光标行灰底 + 连续回车不跳顶（2026-10-21 真机用户报 demo.md） ----------
// 用户口径：「图片上面回车新增的这行没有灰色明确指示当前编辑行，而且输入文字时页面会
// 乱跳，滚动到了目录的位置」。
// 根因（repro 脚本实测）：
//   ① 块间空行光标行停在 0px 塌缩态且 idx=-1 时 _applyWysiwygActiveHighlight 只撤不挂
//     → 灰底不可见（行本身 0px 高）；
//   ② cm.refresh()（锚定 doRestore / 图片·TOC 异步后处理完成触发；lineWrapping=true 时
//     无条件跑 estimateLineHeights）把**已渲染行**的记录行高重置为单行估算值（WYSIWYG
//     遮罩是行内 replacedWith 节点、不是 line.widgets，启发式对其一无所知：2612px 的
//     TOC 遮罩行被重置回 ~15px）→ 操作末 updateHeightsInViewport 按「实测 − 陈旧记录值」
//     差值一次性补偿 scroller.scrollTop（mustScroll，单跳数千 px = 跳到文档顶目录区）；
//     块间间隙 inline 高度原先在 operation 外写入（记录行高与 0px DOM 失步）是第二条
//     失步通道。
// 行为回归在 scripts/wysiwyg-browser-check.mjs 的 S69 场景（真实浏览器 + 4×真实 Enter
// + 视口下方断言）；此处只断言接线与实现要点，防止修复被静默回退。

const WYSIWYG_SRC = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
const CM5_SRC = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'codemirror', 'codemirror.js'), 'utf8');

test('不跳顶修复①（根因）：estimateLineHeights 跳过已渲染行，保留其实测行高', () => {
  // ① 渲染行集合来自 display.view（Line 对象恒等）
  assert.match(CM5_SRC, /function estimateLineHeights\(cm\) \{[\s\S]{0,1200}cm\.display\.view/,
    'estimateLineHeights 未取当前渲染行集合（display.view）');
  assert.match(CM5_SRC, /rendered\.add\(vl\)/, '未把渲染行加入跳过集合');
  // ② 跳过必须发生在估算写入之前（迭代体首句）
  assert.match(CM5_SRC, /doc\.iter\(function \(line\) \{\s*if \(rendered\.has\(line\)\) return;/,
    '已渲染行未被跳过（估算写入会破坏其实测行高 → refresh 必产生 mustScroll 跳顶）');
});

test('不跳顶修复②：间隙 inline 高度写入移入 updateWysiwygBlankLines 的同一 operation', () => {
  // 类 diff、集合/光标行状态、间隙表写入全部在单 operation 内（记录行高同趟重测，无失步）
  assert.match(
    WYSIWYG_SRC,
    /cm\.operation\(\(\) => \{[\s\S]{0,1000}this\._wysiwygBlankLines = next;[\s\S]{0,300}this\._wysiwygBlankCurLine = this\._isWysiwygBlankLine\(curLine\) \? curLine : null;[\s\S]{0,120}this\._updateWysiwygBlankGap\(\);[\s\S]{0,40}\}\)\;/,
    'updateWysiwygBlankLines 的间隙 inline 高度未在 operation 内写入（operation 外写 DOM 高度 → CM 记录行高失步 → 下次编辑操作 mustScroll 跳顶）'
  );
});

test('光标行灰底：块间空行（idx=-1）光标行挂单行灰底（格编辑例外不挂）', () => {
  // ① idx=-1 分支存在：wysiwyg 态 + 非格编辑 + 光标行块归属 -1 → 挂 ACTIVE 行类
  assert.match(
    WYSIWYG_SRC,
    /if \(this\.viewMode === 'wysiwyg' && !this\._wysiwygCellEditing\) \{[\s\S]{0,800}wysiwygBlockIndexAt\(head\.line\) < 0[\s\S]{0,400}addLineClass\(h, 'background', ACTIVE_CLASS\)/,
    '_applyWysiwygActiveHighlight 缺 idx=-1 光标行灰底分支（用户报：图片上方回车新增行没有灰色指示）'
  );
  // ② 单行挂齐首/末角类（四角全圆，与块内单行口径一致）
  assert.match(
    WYSIWYG_SRC,
    /this\._wysiwygActiveLines = \[h\];[\s\S]{0,300}addLineClass\(h, 'background', ACTIVE_FIRST_CLASS\);[\s\S]{0,200}addLineClass\(h, 'background', ACTIVE_LAST_CLASS\)/,
    'idx=-1 光标行灰底未挂齐首/末角类（圆角口径与块内单行不一致）'
  );
});

test('光标行全高：块间空行与块内空行同口径（不再要求光标行在块内）', () => {
  // ① 光标移动入口：光标所在空行即恢复全高（无 lineBlockIdx >= 0 限制）
  assert.match(
    WYSIWYG_SRC,
    /const lineBlockIdx = this\.wysiwygBlockIndexAt\(line\);[\s\S]{0,500}if \(this\._isWysiwygBlankLine\(line\)\) \{[\s\S]{0,300}_wysiwygBlankCurLine = line;/,
    '光标移动路径未按「光标所在空行」恢复全高（块间空行光标行停在 0px 塌缩态）'
  );
  assert.doesNotMatch(WYSIWYG_SRC, /_isWysiwygBlankLine\(line\) && lineBlockIdx >= 0/,
    '光标行全高仍要求光标行在块内（2026-10-21 修订前口径：块间空行光标行 0px → 无灰底指示）');
  // ② 全量重算：光标行例外不再依赖 curInBlock（口径已废弃，防回退）
  assert.match(WYSIWYG_SRC, /if \(i === curLine\) continue; \/\/ 光标所在空行：例外，恢复全高（块内\/块间同口径）/,
    'updateWysiwygBlankLines 的光标行例外丢失（块间空行光标行被塌缩 → 灰底/光标不可见）');
  assert.doesNotMatch(WYSIWYG_SRC, /curInBlock/,
    'curInBlock 口径残留（2026-10-21 修订后块间/块内同口径，不应再有该判定）');
  // ③ 光标离开即收回塌缩：集合成员判定失效时按「现在仍是空行」补判
  assert.match(WYSIWYG_SRC, /let recollapse = !!\(blanks && blanks\.has\(prevCur\)\);/,
    '光标离开空行未做「仍为空行则收回塌缩」补判（光标行被集合例外排除 → 离开后一直展开）');
});

test('不跳顶修复③（2026-10-21 乱跳主修）：TOC 缓存有效时同步注入 + 立即刷新（无占位→全高阶跃）', () => {
  // ① 同步分支：缓存有效（html 已生成 + 内容未变）→ 同步注入 + 同任务内刷新补偿
  //（阶跃若拖到异步，下一输入操作末才按「记录 631.9 − 占位 41.2」补出 591px 跳顶）
  assert.match(
    WYSIWYG_SRC,
    /const tocCache = this\._wysiwygToc;[\s\S]{0,120}if \(tocCache && tocCache\.html && tocCache\.value === cm\.getValue\(\)\) \{[\s\S]{0,260}this\._wysiwygApplyTocHtml\(node, tocCache\.html\);[\s\S]{0,600}this\._wysiwygRefreshAfterMaskChange\(\);/,
    'TOC 缓存有效时未同步注入（<p>[TOC]</p> 占位 → 异步全高的阶跃 = 乱跳源）'
  );
  // ② 注入助手：替换节点内**所有** [TOC] 段（与阅读模式口径一致），并透传 data-source-line
  assert.match(
    WYSIWYG_SRC,
    /_wysiwygApplyTocHtml\(node, tocHtml\) \{[\s\S]{0,200}querySelectorAll\('p'\)\)[\s\S]{0,120}\/\^\\\[TOC\\\]\$\/i\.test\(\(p\.textContent \|\| ''\)\.trim\(\)\)\);[\s\S]{0,400}data-source-line/,
    '缺 _wysiwygApplyTocHtml 全 [TOC] 段替换口径（只替首段会漏后续 [TOC] 行）'
  );
  // ③ 异步首解路径也要回填缓存 html（guarded：内容未变才写），供后续同步注入
  assert.match(WYSIWYG_SRC, /if \(cache && cache\.value === content\) cache\.html = tocHtml;/,
    'TOC 首解结果未回填缓存 html（后续遮罩重渲染无法同步注入 → 阶跃复发）');
});

test('不跳顶修复④（2026-10-21 乱跳配套）：refresh 以真实滚动重断言 + 补偿基准=DOM 探针盒漂移', () => {
  // ① D2：refresh 体首句（regChange 之前）把 doc.scrollTop 同步为真实 scroller——
  // 原生滚动锚定在 CM 操作之外移动过真实滚动，按陈旧 doc 值做 pending 重断言会把已修正
  // 位置改回（harness 实测 2570 vs 3161，叠上层 delta 二次补偿 = 1182px 过冲）
  assert.match(
    CM5_SRC,
    /refresh: methodOp\(function\(\) \{[\s\S]{0,1600}this\.doc\.scrollTop = this\.display\.scroller\.scrollTop;[\s\S]{0,240}regChange\(this\);/,
    'refresh 未以真实 scroller 滚动同步 doc.scrollTop（陈旧 doc 值重断言已修正的实际滚动）'
  );
  // ② D3：补偿基准 = 视口顶探针行的真实 DOM 盒漂移（refresh 前后同一行盒顶差），
  // 弃用 coordsChar/charCoords 记录行高基准（记录值滞后真实 DOM 时双重计入 591px）
  assert.match(
    WYSIWYG_SRC,
    /_wysiwygDomProbe\(cm\) \{[\s\S]{0,800}lv\.node\.getBoundingClientRect\(\);[\s\S]{0,240}return \{ lineNo: lv\.line\.lineNo, top: box\.top \};/,
    '缺 _wysiwygDomProbe 漂移探针（补偿基准回退到记录行高 → 591px 双重计入过冲）'
  );
  assert.match(
    WYSIWYG_SRC,
    /const probe = this\._wysiwygDomProbe\(cm\);[\s\S]{0,120}cm\.refresh\(\);[\s\S]{0,500}after\.top - probe\.top/,
    '遮罩变更刷新补偿未用 DOM 探针基准（必须在 refresh 前后量同一行盒顶并以其差补偿）'
  );
});

test('不跳顶修复⑤（2026-10-21）：ensure-vendor 再生 vendor 后重打 CM5 补丁（否则 npm install 抹掉修复）', () => {
  // src/lib/codemirror/ 在 .gitignore 内、由 ensure-vendor 从 node_modules 确定性再生——
  // 不跳顶的两处 CM5 修复只存在于该 vendor 副本，复制后必须重打，否则修复静默丢失
  const vendor = fs.readFileSync(path.join(ROOT, 'scripts', 'ensure-vendor.mjs'), 'utf8');
  assert.match(vendor, /function applyTizuMarkCm5Patches\(\) \{/,
    'ensure-vendor 缺 CM5 补丁重打步骤（vendor 再生会抹掉不跳顶修复）');
  // 补丁调用顺序：CM5 核心 → continuelist addon → vendor 同步完成（2026-10-28 新增 continuelist
  // 逐级退出补丁，须同在同步完成前重打，否则 npm install 抹掉修复；窗口 8000 = 补丁体含
  // 块尾跳出逻辑后已逾 4000，S106 曾撑爆）
  assert.match(vendor, /applyTizuMarkCm5Patches\(\);[\s\S]{0,8000}?applyTizuMarkContinuelistPatch\(\);\s*\n\s*console\.log\('\[ensure-vendor\] vendor 同步完成/,
    'ensure-vendor 的 CM5/continuelist 补丁步骤未在 vendor 同步完成前调用');
  // 两个补丁项的幂等 marker（已打则跳过；锚点丢失则 exit 1，绝不静默）
  assert.match(vendor, /marker: 'if \(rendered\.has\(line\)\) return;'/,
    'ensure-vendor CM5 补丁项一（estimateLineHeights 跳过已渲染行）缺 marker');
  assert.match(vendor, /marker: 'if \(this\.display\.wrapper\.offsetHeight\) \{ this\.doc\.scrollTop = this\.display\.scroller\.scrollTop; \}'/,
    'ensure-vendor CM5 补丁项二（refresh 真实滚动重同步）缺 marker');
  assert.match(vendor, /if \(bad > 0\) \{[\s\S]{0,200}process\.exit\(1\);/,
    'ensure-vendor CM5 补丁锚点丢失时未 exit 1（静默跳过 = 修复悄悄消失）');
});

test('S69 回归接线：harness 场景 + 驱动断言块齐备', () => {
  const harness = fs.readFileSync(path.join(ROOT, '_wysiwyg_compare.html'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  assert.match(harness, /window\.__runGapCursor2026 = async function \(\)/,
    'harness 缺 S69 场景（块间空行光标行灰底 + 连续回车不跳顶）');
  assert.match(harness, /S69_DOC[\s\S]{0,2000}\[TOC\][\s\S]{0,3000}!\[示例图片\]\('/,
    'S69 文档缺 [TOC] 大遮罩或图片行（跳顶量级/光标落点复现不了）');
  // 2026-10-21：图片必须是确定性的（内联 data: URI）——在线图（picsum.photos）加载时机
  // 逐次不同，图片行高度在测量窗内变化 → 滚动稳态逐次漂移（实测 3173 vs 3048），
  // Enter 窗口的稳态回落被记成「跳动」（假阳性）
  assert.match(harness, /const IMG = 'data:image\/svg\+xml;utf8,?'\s*\+/,
    'S69 图片必须用内联 data: URI（确定性高度，禁网络竞态）');
  const s69DocRegion = (harness.match(/const S69_DOC = \(function[\s\S]*?\)\(\);/) || [''])[0];
  // SVG xmlns（http://www.w3.org/2000/svg）是命名空间声明非网络资源，排除
  assert.doesNotMatch(s69DocRegion, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/,
    'S69 文档不得含在线资源（网络竞态使滚动稳态逐次不同，断言假阳性）');
  assert.match(harness, /pressEnter = \(\) => \{[\s\S]{0,300}KeyboardEvent\('keydown', \{ key: 'Enter'/,
    'S69 未用真实 keydown Enter（合成 input 事件到不了 CM5，Enter 不生效）');
  assert.match(driver, /window\.__runGapCursor2026\(\)/, '驱动缺 S69 调用');
  assert.match(driver, /S69：块间空行光标行灰底 \+ 连续回车不跳顶/, '驱动缺 S69 断言块');
});

test('S70 定义列表：编辑态=渲染态 + dd 行精确落行（2026-10-18 用户截图）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const harness = fs.readFileSync(path.join(ROOT, '_wysiwyg_compare.html'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 落行：遮罩 mousedown 精确落行从 li 扩到 dt/dd（convertDefLists 给 dt/dd 标源行号）
  assert.match(wsrc, /ev\.target\.closest\('dt, dd'\)/, '遮罩点击未按 dt/dd 精确落行（点 dd 行落 dt 行未修）');
  assert.match(wsrc, /const exactHost = liEl \|\| dlEl;/, '精确落行宿主未并入 li/dt/dd');
  // ② 装饰：dd 行（`: `/孤 `:`，同 convertDefLists 口径）+ dt 行（下一行是 dd）判定 +
  //    行类 + `: ` 前缀透明 span + para-line 排除
  assert.match(wsrc, /const isDd = \/\^\(: \|\:\$\)\//, '缺 dd 行判定（行首 `: `/孤 `:`）');
  assert.match(wsrc, /wysiwyg-dt-line/, '缺 dt 行排版行类');
  assert.match(wsrc, /wysiwyg-dd-line/, '缺 dd 行排版行类');
  assert.match(wsrc, /add\(lineNo, 0, content\.charAt\(1\) === ' ' \? 2 : 1, 'wysiwyg-dd-colon'\)/,
    '缺 `: ` 前缀透明 span（冒号裸露）');
  assert.match(wsrc, /&& !isDt && !isDd[\s\S]{0,400}wysiwyg-para-line/,
    'dt/dd 行未排除 para-line（会叠 14px 底距，与 dl 折叠口径冲突）');
  // ③ 撤除：先清后挂覆盖 dt/dd 行类
  assert.match(wsrc, /cm\.removeLineClass\(h, 'text', 'wysiwyg-dt-line'\);/, 'dt 行类未先清后挂（切块残留）');
  assert.match(wsrc, /cm\.removeLineClass\(h, 'text', 'wysiwyg-dd-line'\);/, 'dd 行类未先清后挂（切块残留）');
  // ④ CSS：渲染态口径复现（dt 600 + 8 顶；dd 24 左 + 8 底 + 次级色；块末 dd 16 底；冒号透明）
  assert.match(css, /pre\.wysiwyg-dt-line \{[\s\S]{0,80}font-weight: 600;/, '缺 dt 粗体（600，同渲染 dt）');
  assert.match(css, /pre\.wysiwyg-dt-line\.wysiwyg-block-edge-top \{[\s\S]{0,80}padding-top: 8px;/,
    '缺块首 dt 顶距 8px（渲染 dt margin-top 折叠口径）');
  assert.match(css, /pre\.wysiwyg-dd-line \{[\s\S]{0,220}padding-left: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 24px\);[\s\S]{0,140}padding-bottom: 8px;[\s\S]{0,140}color: var\(--text-secondary\);/,
    '缺 dd 排版（行基准留白 + 24px 左缩进 + 8px 底距 + 次级色，同渲染 dd）');
  assert.match(css, /pre\.wysiwyg-dd-line\.wysiwyg-block-edge-bottom \{[\s\S]{0,80}padding-bottom: 16px;/,
    '缺块末 dd 底距 16px（dd mb 8 与 dl mb 16 折叠口径）');
  // 2026-10-22 起冒号由透明改次级色可见（用户要求编辑态把 : 显示出来，同标题 # 前缀口径）
  assert.match(css, /\.wysiwyg-dd-colon \{[\s\S]{0,400}?color: var\(--text-secondary\);/, '缺 `: ` 冒号可见（次级色）');
  // ⑤ 回归接线：harness 场景（TizuMark 文档 + 点 dd 行上半）+ 驱动断言块
  assert.match(harness, /window\.__runDefList = async function \(\)/, 'harness 缺 S70 场景');
  assert.match(harness, /'TizuMark'[\s\S]{0,300}基于 Tauri/, 'S70 文档缺用户原样定义列表项');
  assert.match(harness, /ddRect\.top \+ ddRect\.height \* 0\.25/, 'S70 未点 dd 行上半（比例估算误落 dt 的复现位置）');
  assert.match(driver, /window\.__runDefList\(\)/, '驱动缺 S70 调用');
  assert.match(driver, /dl\.cursorLine === 6/, '驱动缺 dd 行精确落行断言（光标=行 6）');
  assert.match(driver, /Math\.abs\(dl\.hDelta\) < 0\.5/, '驱动缺编辑块高=遮罩高断言');
});

test('S71 切块页面位移：点击锚点只补偿结构位移（2026-10-21 用户反馈「点某行进编辑态再点其他行，页面往下移动一段距离」）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const harness = fs.readFileSync(path.join(ROOT, '_wysiwyg_compare.html'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 锚点参照 refTop：mousedown 捕获「被点行撤罩前行顶的屏幕 y」
  //    —— 精确宿主（li/dt/dd）=宿主框顶−自身 margin-top（dt 8px 顶距属源码行行首留白）
  assert.match(wsrc, /let refTop = null;/, '缺 refTop 捕获声明');
  assert.match(wsrc, /parseFloat\(getComputedStyle\(exactHost\)\.marginTop\)/,
    '宿主行顶未减自身 margin-top（dt 行顶会算进 8px 顶距 → 锚定差 8px）');
  assert.match(wsrc, /rect\.top \+ \(line - r\.from\.line\) \* \(rect\.height \//,
    '多行无宿主块（代码等）缺按行序均分遮罩高的行顶估算');
  assert.match(wsrc, /self\._wysiwygClickAnchor = \{ y: downY, line, refTop \};/,
    '点击锚点未携带 refTop');
  // ② 应用锚点：delta = 撤罩后行顶 − refTop（结构位移），缺 refTop 回退旧口径
  assert.match(wsrc, /click\.refTop != null && isFinite\(click\.refTop\)/, '缺 refTop 分支');
  assert.match(wsrc, /\(c\.top - click\.refTop\)/, 'delta 未按「行顶净位移」计算（仍钉点击点 = 每次点击整页下移半行高）');
  assert.match(wsrc, /\(c\.top - wrapTop - localY\);/, '缺无 refTop 时的旧口径回退');
  // ③ 标题块高补齐行类：装饰挂 + 清除撤（先清后挂，6 个级别类全撤）
  assert.match(wsrc, /cm\.addLineClass\(hh, 'text', 'wysiwyg-heading-line'\);/, '缺标题行类挂载');
  assert.match(wsrc, /cm\.addLineClass\(hh, 'text', 'wysiwyg-heading-line-' \+ m\[0\]\.length\)/, '缺按级标题行类');
  assert.match(wsrc, /cm\.removeLineClass\(h, 'text', 'wysiwyg-heading-line'\);/, '标题行类未先清后挂（切块残留）');
  assert.match(wsrc, /for \(let n = 1; n <= 6; n\+\+\) cm\.removeLineClass\(h, 'text', 'wysiwyg-heading-line-' \+ n\);/,
    '清除未全撤 6 个级别行类（残留 padding 污染其他块）');
  // ④ CSS：行高 1.3（无单位，同渲染 h 参数）+ 按级底距 h1 24 / h2 21 / h3–h6 12（渲染
  //    padding-bottom + 边框厚 + 12px 底距，边框不画——2026-10-14 定稿不加下划线）
  assert.match(css, /pre\.wysiwyg-heading-line \{ line-height: 1\.3; \}/, '缺标题行高 1.3（同渲染 h）');
  assert.match(css, /pre\.wysiwyg-heading-line-1 \{ padding-bottom: 24px; \}/, '缺 h1 底距 24px（10+2+12）');
  assert.match(css, /pre\.wysiwyg-heading-line-2 \{ padding-bottom: 21px; \}/, '缺 h2 底距 21px（8+1+12）');
  assert.match(css, /pre\.wysiwyg-heading-line-3,[\s\S]{0,260}padding-bottom: 12px;/, '缺 h3 底距 12px');
  // ⑤ h6 特例：pre 字号降 0.9em 消灭 16px strut（18.72 < 20.8 会把 h6 顶到 20.8，Δ+2.08px），
  //    em 系 span 按级补偿（正文 0.9em→1em；# 前缀 0.8em→px 直值）
  assert.match(css, /pre\.wysiwyg-heading-line-6 \{[\s\S]{0,120}font-size: calc\(var\(--wysiwyg-text-size, 16px\) \* 0\.9\);[\s\S]{0,80}line-height: 1\.3;/,
    '缺 h6 pre 字号 0.9em（strut 消灭口径）');
  assert.match(css, /pre\.wysiwyg-heading-line-6 \.wysiwyg-heading-text \{ font-size: 1em; \}/, '缺 h6 正文 span 补偿（0.9em→1em）');
  assert.match(css, /pre\.wysiwyg-heading-line-6 \.wysiwyg-heading-hash \{ font-size: calc\(var\(--wysiwyg-text-size, 16px\) \* 0\.8\); \}/,
    '缺 h6 # 前缀 span 补偿（px 直值 12.8）');
  // ⑥ 回归接线：harness 场景（h1–h6 矩阵 + 点标题再点 dl 的参照行位移）+ 驱动断言块
  assert.match(harness, /window\.__runBlockSwitch = async function \(\)/, 'harness 缺 S71 场景');
  assert.match(harness, /# 一级标题'[\s\S]{0,400}###### 六级标题/, 'S71 文档缺 h1–h6 全级别');
  assert.match(harness, /'普通段落，作为参照行。'[\s\S]{0,200}MarkDown/, 'S71 文档缺参照段落 + 定义列表');
  assert.match(harness, /out\.maxRefShift = Math\.max\.apply\(null, \[0,[\s\S]{0,160}\]/, 'S71 未量参照行最大位移');
  assert.match(driver, /window\.__runBlockSwitch\(\)/, '驱动缺 S71 调用');
  assert.match(driver, /bs\.maxRefShift != null && bs\.maxRefShift < 0\.5/, '驱动缺参照行位移断言（<0.5px）');
  assert.match(driver, /Math\.abs\(bs\.h2lineTop - bs\.h2maskTop\) < 0\.5/, '驱动缺「标题行顶边落回遮罩顶边」断言');
});

test('S72 列表按项显示源码：紧凑列表点某项只该项源码，兄弟项保持渲染（2026-10-21 用户反馈「光标在高亮标记这一行，插入内容这一行也展示源码」）', () => {
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const harness = fs.readFileSync(path.join(ROOT, '_wysiwyg_compare.html'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 主路径（remark 切块）：node.type==='list' 且块内无空行（紧凑）且项数>1 → 逐项块
  //    （每项 = listItem position，含嵌套子项行段），listItem/listItemPos 标签随块传出
  assert.match(rsrc, /if \(node\.type === 'list'\) \{/, 'renderMarkdownBlocks 缺紧凑列表按项切块分支');
  assert.match(rsrc, /lines\.slice\(start, end\)\.some\(\(l\) => \(l \|\| ''\)\.trim\(\) === ''\)/, '紧凑判据缺「块内无空行」检查（松散列表项间空行是真实源行，拆项会裸露）');
  assert.match(rsrc, /noBlank && items\.length > 1/, '未按「紧凑 且 项数>1」拆项（单项即整列表，14px 列表底距归属它）');
  assert.match(rsrc, /listItemPos: \(k === 0 \? 'first' : k === items\.length - 1 \? 'last' : 'middle'\)/, '缺 first/middle/last 位置标签（驱动 li-mid 类与 edge-bottom 判定）');
  assert.match(rsrc, /out\.push\(b\.listItem[\s\S]{0,200}listItem: true, listItemPos: b\.listItemPos/, 'out.push 重建对象时未传出 listItem 标签（下游拿到 undefined）');
  // ② 回退切块器（splitBlocks）同口径：项边界 = 下一个缩进≤当前项缩进的标记行
  assert.match(wsrc, /const itemStarts = \[\];/, 'splitBlocks 缺逐项切块（itemStarts）');
  assert.match(wsrc, /m\[1\]\.length <= itemIndent/, '项边界未按「同级/更浅标记行开新项」判定（深层标记行与缩进续行应归父项）');
  assert.match(wsrc, /if \(!loose && itemStarts\.length > 1\)/, 'splitBlocks 未按「非松散 且 多项」拆项（松散/单项保持整块）');
  // ③ 遮罩片段：非末项片段挂 li-mid（ul/ol 底距清零 → 底缘 = li 底缘 + 4px 项间距）
  assert.match(wsrc, /wysiwyg-mask-li-mid/, 'maskWysiwygBlock 缺 li-mid 类挂载');
  assert.match(css, /\.CodeMirror \.wysiwyg-block-mask\.preview-content\.wysiwyg-mask-no-btn\.wysiwyg-mask-li-mid > \*:last-child \{ margin-bottom: 0; \}/,
    'CSS 缺 li-mid 规则（非末项片段底距须 = 4px 项间距，否则切项跳 10px）');
  // ④ 活动块装饰：14px 列表底距（edge-bottom）只归属末项；非末项底缘 = wysiwyg-list-line 默认 4px
  assert.match(wsrc, /lineNo === b\.end - 1 && !\(b\.listItem && b\.listItemPos !== 'last'\)/, 'edge-bottom 未限定列表末项（非末项源行比片段高 10px → 切项跳动）');
  // ⑤ 回归接线：harness S72 场景 + 驱动断言块
  assert.match(harness, /window\.__runListItem = async function \(\)/, 'harness 缺 S72 场景');
  assert.match(driver, /window\.__runListItem\(\)/, '驱动缺 S72 调用');
  assert.match(driver, /li\.onlyItem3Source[\s\S]{0,120}pass3 \+\+|fail3 \+\+|fail\+\+/, '驱动缺「点第 3 项只该项源码」断言');
});

// ---------- 15. 代码块编辑态语法色 ≡ 渲染态（2026-10-21 用户截图反馈「代码块编辑态文字
// 高亮颜色与渲染态不一样，改为一样的」） ----------

test('S74 代码块编辑态语法色重映射到 GitHub hljs 色板（≡ 渲染态）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const harness = fs.readFileSync(path.join(ROOT, '_wysiwyg_compare.html'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // 范围：只限 WYSIWYG 活动围栏行（pre.wysiwyg-code-line，wysiwyg.js 逐行挂）——
  // 规则必须带 wysiwyg-code-line 限定，经典编辑模式 token 色不动
  const scope = '.editor-container.wysiwyg-mode .CodeMirror pre.CodeMirror-line.wysiwyg-code-line';
  // 亮态 = github.min.css 色板（实测值）
  assert.ok(css.includes(scope + ' span.cm-keyword { color: #d73a49; }'), '亮态 keyword 色不是 GitHub 色板红（#d73a49 ≡ .hljs-keyword）');
  assert.match(css, /span\.cm-def,[\s\S]{0,200}?span\.cm-property \{ color: #6f42c1; \}/, 'def/property 组色不是 GitHub 色板紫（#6f42c1 ≡ .hljs-title.function_）');
  assert.match(css, /span\.cm-number,[\s\S]{0,600}?span\.cm-type \{ color: #005cc5; \}/, 'number/atom/meta/attr/variable-3/type 组色不是 GitHub 色板蓝（#005cc5）');
  assert.match(css, /span\.cm-string,[\s\S]{0,200}?span\.cm-string-2 \{ color: #032f62; \}/, 'string 组色不是 GitHub 色板深蓝（#032f62 ≡ .hljs-string）');
  assert.ok(css.includes(scope + ' span.cm-comment:not([class*="wysiwyg-code-fence"]) { color: #6a737d; }'), '亮态 comment 色不是 #6a737d，或缺围栏标志行排除（cm-comment 与 wysiwyg-code-fence 同身会被误染）');
  assert.ok(css.includes(scope + ' { color: #24292e; }'), '缺亮态基色 #24292e（≡ .hljs 基色，无 token 色文本须同色）');
  // 暗态 = github-dark.min.css 色板
  const dscope = '[data-theme="dark"] ' + scope;
  assert.ok(css.includes(dscope + ' { color: #c9d1d9; }'), '缺暗态基色 #c9d1d9');
  assert.ok(css.includes(dscope + ' span.cm-keyword { color: #ff7b72; }'), '暗态 keyword 色不是 #ff7b72');
  assert.match(css, /span\.cm-def,[\s\S]{0,200}?span\.cm-property \{ color: #d2a8ff; \}/, '暗态 def/property 色不是 #d2a8ff');
  assert.match(css, /span\.cm-number,[\s\S]{0,700}?span\.cm-type \{ color: #79c0ff; \}/, '暗态 number 组色不是 #79c0ff');
  assert.match(css, /span\.cm-string,[\s\S]{0,200}?span\.cm-string-2 \{ color: #a5d6ff; \}/, '暗态 string 组色不是 #a5d6ff');
  assert.ok(css.includes(dscope + ' span.cm-comment:not([class*="wysiwyg-code-fence"]) { color: #8b949e; }'), '暗态 comment 色不是 #8b949e');
  // 渲染态无着色的 token 须中和为继承（防主题色漏出：material-darker cm-variable 红 /
  // cm-operator 青、codemirror.css cm-link 下划线）——亮暗两态都要有
  const neutral = (s) => (s.match(/span\.cm-bracket \{ color: inherit; \}/g) || []).length;
  assert.ok(neutral(css) >= 2, 'variable-2/variable/operator/bracket 中和规则不足（亮+暗各一组）');
  assert.ok((css.match(/span\.cm-link \{ color: inherit; text-decoration: none; \}/g) || []).length >= 2, 'cm-link 中和规则不足（亮+暗各一条，防下划线漏出）');
  // harness 必须复刻 app 的「围栏内层模式 + hljs 主题」，否则回归在 harness 里失真：
  // ① gfm 围栏要出 token span 须加载内层代码模式（javascript.js，与 index.html L504 一致）
  assert.match(harness, /codemirror\/mode\/javascript\/javascript\.js/, 'harness 缺 javascript 模式（围栏内层 token 出不来，编辑态语法色回归失真）');
  // ② 遮罩 hljs span 要有色须加载 hljs 主题（与 index.html L13 一致）
  assert.match(harness, /highlight\.js\/github\.min\.css/, 'harness 缺 hljs 主题（渲染态遮罩 token 无色，回归失真）');
  // ③ 暗态回归须加载 material-darker（与 index.html L11 一致）
  assert.match(harness, /theme\/material-darker\.css/, 'harness 缺 material-darker 暗态主题');
  // 回归接线：驱动 S74 断言块（逐 token 对比编辑态 vs 遮罩 hljs 计算色）
  assert.match(driver, /S74：WYSIWYG 代码块编辑态语法色 ≡ 渲染态/, '驱动缺 S74 场景');
  assert.match(driver, /keyword（function\/let\/const…）≡ \.hljs-keyword/, '驱动缺 keyword 逐色断言');
  assert.match(driver, /围栏标志行保持次级色、未被评论灰覆盖/, '驱动缺围栏标志行排除断言');
});

// ---------- 2026-10-22 用户截图四项：① 定义列表冒号可见 + 面板内容比对补齐；
// ② 折叠区块交互（点文字不进编辑/灰盒内编辑/小三角小手）；③ 相邻代码块间距两态一致 ----------

test('S75 快捷插入面板补齐 14 个渲染器支持项（全进排序、默认不启用）', () => {
  const cs = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'constants.js'), 'utf8');
  const slash = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'slash.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const ids = ['insert-dl', 'insert-details', 'insert-footnote', 'insert-progress',
    'insert-center', 'insert-u', 'insert-ins', 'insert-del', 'insert-figure', 'insert-kbd',
    'insert-abbreviation', 'insert-ruby', 'insert-superscript', 'insert-subscript'];
  // ① 常量：SLASH_NEW_ACTIONS 全量 14 项；DEFAULT_SLASH_HIDDEN = 字体类 + 新增项
  assert.match(cs, /const SLASH_NEW_ACTIONS = \[[\s\S]{0,600}?'insert-dl'[\s\S]{0,600}?/);
  for (const id of ids) assert.ok(cs.includes("'" + id + "'"), 'SLASH_NEW_ACTIONS 缺 ' + id);
  assert.match(cs, /DEFAULT_SLASH_HIDDEN = SLASH_FONT_ACTIONS\.concat\(SLASH_NEW_ACTIONS\)/,
    'DEFAULT_SLASH_HIDDEN 未并入 SLASH_NEW_ACTIONS（新增项须默认隐藏）');
  // ② 面板目录：14 项全在（label 与动作一一对应）
  const pairs = [
    ['insert-dl', '定义列表'], ['insert-details', '折叠区块'], ['insert-footnote', '脚注'],
    ['insert-progress', '进度条'], ['insert-center', '居中块'], ['insert-u', '下划线文本'],
    ['insert-ins', '插入内容'], ['insert-del', '删除内容'], ['insert-figure', '图注'],
    ['insert-kbd', '按键标签'], ['insert-abbreviation', '缩写词'], ['insert-ruby', '注音'],
    ['insert-superscript', '上标'], ['insert-subscript', '下标'],
  ];
  for (const [id, label] of pairs) {
    assert.match(slash, new RegExp("action: '" + id + "', label: '" + label + "'"),
      '面板目录缺 ' + id + '（' + label + '）');
  }
  // ③ 新用户（无保存值）落默认隐藏集，与排序对话框草稿口径一致
  assert.ok(slash.includes('this.settings.slashHidden || DEFAULT_SLASH_HIDDEN'),
    '_applySlashLayout 新用户未落 DEFAULT_SLASH_HIDDEN（新增项默认不启用失效）');
  // ④ app.js：12 个新动作（sup/sub 早已存在）全部接上
  const appCases = [
    ['insert-dl', "this.insertBlock('术语\\n: 释义', 2)"],
    ['insert-details', "this.insertBlock('<details>\\n<summary>点击展开</summary>\\n\\n内容\\n\\n</details>', 35)"],
    ['insert-footnote', "this.insertBlock('[^1]: 脚注内容', 6)"],
    ['insert-progress', "this.insertBlock('<progress value=\"70\" max=\"100\"></progress>', 17)"],
    ['insert-center', "this.insertBlock('<center>\\n居中显示的文本\\n</center>', 9)"],
    ['insert-u', "this.wrapSelection('<u>', '</u>')"],
    ['insert-ins', "this.wrapSelection('<ins>', '</ins>')"],
    ['insert-del', "this.wrapSelection('<del>', '</del>')"],
    ['insert-figure', "this.insertBlock('<figure>\\n  <img src=\"图片地址\" alt=\"图片描述\">\\n  <figcaption>图注文字</figcaption>\\n</figure>', 21)"],
    ['insert-kbd', "this.wrapSelection('<kbd>', '</kbd>')"],
    ['insert-abbreviation', "this.wrapSelection('<abbr title=\"完整词\">', '</abbr>')"],
    ['insert-ruby', "this.insertBlock('<ruby>文字<rt>拼音</rt></ruby>', 6)"],
  ];
  for (const [id, call] of appCases) {
    assert.ok(app.includes("case '" + id + "': " + call), 'app.js 缺 ' + id + ' 动作实现');
  }
});

test('S76 折叠区块：点文字不进编辑态 / 编辑按钮进灰盒 / 小三角小手', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 遮罩 mousedown：details 正文点击吞掉（summary 分支之后、比例映射之前）
  assert.match(wys, /const detHost = ev\.target && ev\.target\.closest \? ev\.target\.closest\('details'\) : null;[\s\S]{0,120}?if \(detHost && node\.contains\(detHost\)\) return;/,
    '缺 details 正文点击 no-op 分支（点文字仍会进编辑态）');
  // ② 活动块高亮：details 按容器块处理，整块挂代码盒背景类（开行正则收口 RE.detailsOpen）
  assert.match(wys, /const isDetails = !isFence && !isTable && RE\.detailsOpen\.test\(first \|\| ''\)/,
    '缺 isDetails 判定（details 块未按容器块处理）');
  assert.match(wys, /detailsOpen: \/\^\\s\*<details\[\\s>\]\/i,/,
    '缺 RE.detailsOpen（details 开行正则未收口，判定口径会漂移）');
  assert.ok(wys.includes('if (isFence || isDetails || isHtmlContainer) cm.addLineClass(h, \'background\', ACTIVE_CODE_BOX_CLASS);'),
    'details 块未挂 ACTIVE_CODE_BOX_CLASS（灰盒画不出；HTML 容器块同口径）');
  // ③ 源文行左右内距（源码不贴盒竖边）+ 行类先清后挂（装饰段 + 全量清除两处撤）
  assert.ok(css.includes('pre.CodeMirror-line.wysiwyg-details-line'), '缺 wysiwyg-details-line 行类规则');
  assert.ok(css.includes('padding-left: calc(var(--wysiwyg-line-inset, 32px) + 12px);'), 'details 行左右内距不是 32+12 口径');
  assert.ok(wys.includes("cm.addLineClass(h, 'text', 'wysiwyg-details-line')"), '装饰段未挂 wysiwyg-details-line');
  assert.ok((wys.match(/cm\.removeLineClass\(h, 'text', 'wysiwyg-details-line'\);/g) || []).length >= 2,
    'wysiwyg-details-line 清除不足（须装饰段 + 全量清除两处先清后挂）');
  // ④ 小三角小手：阅读/WYSIWYG 遮罩共用 preview-content，一条规则双覆盖
  assert.match(css, /\.preview-content summary \{\s*cursor: pointer;\s*\}/, '缺 .preview-content summary 小手规则（阅读+WYSIWYG 双覆盖）');
  // ⑤ 回归接线：驱动 S76 场景
  assert.match(driver, /S76：WYSIWYG details（点文字不进编辑态 \/ 编辑按钮进灰盒 \/ 小三角小手）/, '驱动缺 S76 场景');
  assert.match(driver, /summary 计算 cursor=pointer/, '驱动缺小三角小手断言');
  assert.match(driver, /点 details 正文文字：不进编辑态/, '驱动缺点文字不进编辑态断言');
  assert.match(driver, /整块灰盒/, '驱动缺整块灰盒断言');
  assert.match(driver, /44px=32\+12/, '驱动缺 details 行内距断言');
});

test('S81 定义列表不挂「编辑」按钮（2026-10-25 用户要求）+ 代码块双钮 hover：编辑钮上复制钮不消失', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 遮罩判定：渲染含 <dl> → 定义列表（公共方法，与按钮分支共用）
  assert.match(wys, /_wysiwygMaskIsDefList\(node\) \{[\s\S]{0,200}?node\.querySelector\('dl'\)/,
    '缺 _wysiwygMaskIsDefList（定义列表判定散写会漂移）');
  // ② 按钮分支接线：dl 在 plainText 判定之前挂 no-btn-dl 类（不复用 14px 族的 no-btn）
  assert.match(wys, /else if \(this\._wysiwygMaskIsDefList\(node\)\) node\.classList\.add\('wysiwyg-mask-no-btn-dl'\);/,
    '定义列表遮罩未走 no-btn-dl 分支（仍会挂「编辑」按钮）');
  // ③ CSS：dl 底距补回 16px（.preview-content dl 渲染底距，14px 族不可共用）
  assert.match(css, /\.CodeMirror \.wysiwyg-block-mask\.preview-content\.wysiwyg-mask-no-btn-dl > \*:last-child \{ margin-bottom: 16px; \}/,
    '缺 wysiwyg-mask-no-btn-dl 16px 补距规则（遮罩矮 16px，切换跳动）');
  // ④ CSS：WYSIWYG 遮罩双钮显示触发统一为遮罩 hover（修复 hover 编辑钮时复制钮淡出）
  assert.match(css, /\.CodeMirror \.wysiwyg-block-mask\.preview-content:hover pre \.copy-btn \{ opacity: 1; \}/,
    '缺遮罩 hover 显示复制钮规则（hover 编辑按钮时复制钮消失）');
  // ⑤ 阅读模式单钮口径不变（pre:hover）
  assert.match(css, /\.preview-content pre:hover \.copy-btn \{\s*opacity: 1;\s*\}/, '阅读模式复制钮 pre:hover 口径被破坏');
  // ⑥ 回归接线：驱动 S81 场景
  assert.match(driver, /S81：定义列表无编辑按钮 \+ 代码块双钮 hover/, '驱动缺 S81 场景');
  assert.match(driver, /hover 编辑按钮：复制钮仍显示（opacity 1，不再随 pre 失 hover 淡出）/, '驱动缺双钮 hover 修复断言');
  assert.match(driver, /定义列表块渲染 <dl> 遮罩，且无「编辑」按钮/, '驱动缺定义列表无按钮断言');
});

test('S80 HTML 容器块（<center>/<div>…）编辑态整块灰盒（2026-10-25 用户要求「居中显示等具有编辑按钮的，编辑时是编辑整块源码的，都在灰色块中进行编辑」）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 判定收口：CommonMark 原始 HTML 块标签集 + 公共函数（两处调用点共用，禁止散写同义正则）
  assert.ok(wys.includes('const HTML_BLOCK_TAGS = {'), '缺 HTML 块标签集 HTML_BLOCK_TAGS');
  assert.match(wys, /center: 1,/, 'HTML_BLOCK_TAGS 缺 center 标签（用户报障案例）');
  assert.ok(wys.includes('function isHtmlBlockContainerLine(line)'), '缺公共判定函数 isHtmlBlockContainerLine（整块灰盒口径会漂移）');
  assert.match(wys, /const isHtmlContainer = !isFence && !isTable && !isDetails && isHtmlBlockContainerLine\(first\);/,
    '高亮路径缺 isHtmlContainer 判定（HTML 容器块未纳入整块灰盒）');
  assert.match(wys, /\} else if \(!isTable && !isDetails && !isHtmlContainer\) \{/,
    'isHtmlContainer 未并入 lo/hi 收敛分支（仍会塌成光标行）');
  // ② 高亮：整块挂代码盒背景类（与 fence/details 同一挂法）
  assert.ok(wys.includes('if (isFence || isDetails || isHtmlContainer) cm.addLineClass(h, \'background\', ACTIVE_CODE_BOX_CLASS);'),
    'HTML 容器块未挂 ACTIVE_CODE_BOX_CLASS（灰盒画不出）');
  // ③ 装饰：源行内距行类 + 先清后挂（装饰段 + 全量清除两处撤）
  assert.match(wys, /const isHtmlContainerBlock = !isFenceBlock && !isTableBlock && !isDetailsBlock && isHtmlBlockContainerLine\(first\);/,
    '装饰段缺 isHtmlContainerBlock 判定（未与高亮路径共用口径）');
  assert.ok(wys.includes("else if (isHtmlContainerBlock) cm.addLineClass(h, 'text', 'wysiwyg-html-block-line');"),
    '装饰段未挂 wysiwyg-html-block-line');
  assert.ok((wys.match(/cm\.removeLineClass\(h, 'text', 'wysiwyg-html-block-line'\);/g) || []).length >= 2,
    'wysiwyg-html-block-line 清除不足（须装饰段 + 全量清除两处先清后挂）');
  // ④ CSS：与 wysiwyg-details-line 共享同一条内距声明（两份拷贝 = 重复口径）
  assert.match(css, /pre\.CodeMirror-line\.wysiwyg-details-line,\s*\.editor-container\.wysiwyg-mode \.CodeMirror pre\.CodeMirror-line\.wysiwyg-html-block-line \{/,
    'wysiwyg-html-block-line 未与 details-line 共享内距声明（重复口径）');
  // ⑤ 装饰段 details 判定收口 RE.detailsOpen（原散写正则已消除）
  assert.ok(wys.includes("const isDetailsBlock = !isFenceBlock && !isTableBlock && RE.detailsOpen.test(first || '');"),
    '装饰段 details 判定未收口 RE.detailsOpen');
  // ⑥ 回归接线：驱动 S80 场景
  assert.match(driver, /S80：WYSIWYG HTML 容器块（<center>\/<div>）整块灰盒/, '驱动缺 S80 场景');
  assert.match(driver, /整块 3 行全挂 code-box 灰盒（首行上角、末行下角）/, '驱动缺整块灰盒断言');
  assert.match(driver, /wysiwyg-html-block-line（左右内距 44px=32\+12，源码不贴盒竖边）/, '驱动缺 html-block-line 内距断言');
  assert.match(driver, /仅光标行底色（cm-wysiwyg-active-block），无 code-box 灰盒/, '驱动缺普通段落不受影响断言');
});

test('S79 容器块编辑态 Enter：HTML 容器闭标签行回车不出盒（2026-10-22）；围栏闭行不拦截、新行落围栏下方（2026-10-25 用户要求「``` 是普通可编辑内容」）', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const fmt = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'format.js'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 守卫方法：光标在活动 HTML 容器块的块末闭标签行 → 新行插结构行前（块内），光标落新行行首
  assert.match(wys, /_wysiwygEnterOnBlockCloseLine\(cm\) \{[\s\S]{0,1800}?cm\.replaceRange\('\\n', \{ line: prev, ch: prevLen \}\);[\s\S]{0,120}?cm\.setCursor\(\{ line: prev \+ 1, ch: 0 \}\);/,
    '缺 _wysiwygEnterOnBlockCloseLine（块末结构行回车不再插块内）');
  // ② 围栏块例外（2026-10-25）：开行为围栏 → 闭围栏行一律不拦截，回车交回默认换行
  // （行尾 → 新行落围栏下方块外；行中 → 劈围栏行，普通内容语义）
  assert.match(wys, /if \(RE\.fenceStart\.test\(first\)\) return false;/,
    '围栏块闭行未豁免拦截（``` 行回车仍被改成插块内，不是普通内容语义）');
  assert.match(wys, /fenceStart: \/\^\\s\{0,3\}\(`\{3,\}\|~\{3,\}\)\/,/, '缺 RE.fenceStart（围栏开行正则未收口）');
  // ③ HTML 容器口径：闭标签正则按开标签名派生（details/div/figure… 通用，不再特判）
  assert.match(wys, /new RegExp\('\^\\\\s\{0,3\}<\/' \+ om\[1\] \+ '\\\\b', 'i'\)\.test\(lastLine\)/,
    '闭标签行未按开标签名派生判定（details 之外的容器仍会跳出编辑态）');
  assert.match(wys, /htmlOpenTag: \/\^\\s\{0,3\}<\(\[a-zA-Z\]\[a-zA-Z0-9\]\*\)\\b\[\^>\]\*>\/,/, '缺 RE.htmlOpenTag（容器开行正则未收口）');
  // ④ Enter 接线：仅所见即所得模式挂钩，守卫处理则消费该键
  assert.match(fmt, /if \(this\.viewMode === 'wysiwyg' && this\._wysiwygEnterOnBlockCloseLine &&[\s\S]{0,120}?this\._wysiwygEnterOnBlockCloseLine\(cm\)\) return;/,
    'format.js Enter 链缺容器块结构行钩（末行回车跳出编辑态、行落块外）');
  // ⑤ 回归接线：驱动 S79 场景（details 不出盒 + 代码/图表闭围栏下方新行 + 跳出灰盒）
  assert.match(driver, /S79：WYSIWYG 容器块编辑态 Enter（块末结构行回车不出盒）/, '驱动缺 S79 场景');
  assert.match(driver, /② 编辑态保持/, '驱动缺 S79 编辑态保持断言');
  assert.match(driver, /④ 代码块内末内容行回车：250ms 防抖窗口内即时采样，闭围栏已在灰盒内/, '驱动缺 S79 围栏闪出回归断言（④ 即时采样）');
  assert.match(driver, /⑤ 代码块闭围栏行行尾回车：新空行在 \\`\\`\\` \*\*下方\*\*（块外），代码块重新遮罩（灰盒撤）/, '驱动缺 S79 代码块跳出灰盒断言（⑤）');
  assert.match(driver, /⑥ mermaid 图表闭围栏行行尾回车：新空行在 \\`\\`\\` \*\*下方\*\*（块外），图表块重新遮罩/, '驱动缺 S79 mermaid 图表断言（⑥）');
  assert.match(driver, /③ 块外段落回车/, '驱动缺 S79 钩子无误伤断言');
});

test('S82 代码块内输入时闭围栏不闪出灰盒：行号增减即时修补块表（2026-10-25 用户截图「``` 跑到灰色代码块之外去闪一下然后又恢复」）', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ① 行号增减即时修补：change 钩子算 delta 并调修补（250ms 防抖窗口内灰盒不得按陈旧范围走）
  assert.match(wys, /const delta = c\.text\.length - 1 - \(c\.to\.line - c\.from\.line\);[\s\S]{0,200}?_wysiwygPatchBlockTableForChange\(c, delta\)/,
    'change 钩子缺行号 delta 计算与块表修补（防抖窗口内灰盒按陈旧范围走 → 闭围栏闪出盒）');
  // 2026-10-24 钳位修复在 start/end 位移后追加了越界钳回与说明注释（~500 字符），
  // start→extendEnd 的窗口从 300 放宽到 900
  assert.match(wys, /_wysiwygPatchBlockTableForChange\(c, delta\) \{[\s\S]{0,900}?blk\.start \+= delta;[\s\S]{0,900}?extendEnd/,
    '缺 _wysiwygPatchBlockTableForChange（块表行号修补：后续块位移 + 围栏块 end 扩展）');
  // ② 围栏块 end 扩展边界：变更点在闭围栏行之前、或恰在闭围栏行行首（行首回车的新行属
  // 围栏内容）才扩 end；闭围栏行行尾/行内的新行属块外（含尾部 ``` 下方回车的新行）不扩
  assert.match(wys, /const extendEnd = c\.from\.line < blk\.end - 1 \|\| \(c\.from\.line === blk\.end - 1 && c\.from\.ch === 0\);/,
    '围栏块 end 扩展边界有误（闭围栏行行首回车的新行属围栏内容、行尾的属块外）');
  // ③ 回归接线：驱动 S79 ④（防抖窗口内即时采样闭围栏在盒内）
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  assert.match(driver, /250ms 防抖窗口内即时采样，闭围栏已在灰盒内（无闪出盒窗口）/, '驱动缺 S79 ④ 即时采样断言');
});

test('S77 定义列表编辑态冒号可见（次级色，同标题 # 前缀口径）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // 冒号 span 改可见：var(--text-secondary)，且旧透明规则不得残留
  assert.match(css, /\.editor-container\.wysiwyg-mode \.CodeMirror \.wysiwyg-dd-colon \{[\s\S]{0,400}?color: var\(--text-secondary\);\s*\}/,
    'wysiwyg-dd-colon 未改为 var(--text-secondary) 可见');
  assert.ok(!/wysiwyg-dd-colon \{[^}]*color: transparent/.test(css), 'wysiwyg-dd-colon 仍残留 transparent 规则');
  // span 宽度保持（不可 width:0——光标测量依赖真实宽度，S70 断言口径不动）
  assert.ok(!/wysiwyg-dd-colon[^{]*\{[^}]*width:\s*0/.test(css), 'wysiwyg-dd-colon 被设 width:0（光标测量会失真）');
  // 回归接线：S70 冒号断言改为次级色实测值（亮态 #666d79 = rgb(102,109,121)）
  assert.match(driver, /e\.colon\.color === 'rgb\(102, 109, 121\)'/, 'S70 冒号断言未更新为次级色实测值');
});

test('S78 相邻代码块：编辑态块底 16px 槽位（盒底↔下一块 ≡ 渲染态）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const harness = fs.readFileSync(path.join(ROOT, '_wysiwyg_compare.html'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 槽位行：末行（闭围栏行）16px 底内距
  assert.match(css, /\.editor-container\.wysiwyg-mode \.CodeMirror pre\.CodeMirror-line\.wysiwyg-code-slot-bottom \{\s*padding-bottom: 16px;\s*\}/,
    '缺 wysiwyg-code-slot-bottom 16px 底内距规则');
  // ② 灰盒 ::before 底缘上移 16px（盒底边/下圆角仍在文本底缘，槽位在盒外）
  assert.match(css, /cm-wysiwyg-code-box\.cm-wysiwyg-active-last::before \{\s*bottom: 16px;\s*\}/,
    '缺 ::before bottom:16px（灰盒底缘未上移，槽位在盒内则两态不等价）');
  // ①b 未闭合围栏：pad-bottom 与 slot 同行 → 叠加 29+16=45（否则 slot 覆盖 pad-bottom，
  // 盒内底内距比渲染态少 29px）
  assert.match(css, /wysiwyg-code-pad-bottom\.wysiwyg-code-slot-bottom \{\s*padding-bottom: 45px;\s*\}/,
    '缺未闭合围栏 pad-bottom+slot 叠加规则（45px）');
  // ③ JS：围栏分支挂槽位类（闭围栏行；未闭合围栏时末内容行同位）+ 两处先清后挂
  assert.match(wys, /const slotH = cm\.getLineHandle\(last\);[\s\S]{0,80}?cm\.addLineClass\(slotH, 'text', 'wysiwyg-code-slot-bottom'\)/,
    '围栏分支未挂 wysiwyg-code-slot-bottom');
  assert.ok((wys.match(/cm\.removeLineClass\(h, 'text', 'wysiwyg-code-slot-bottom'\);/g) || []).length >= 2,
    'wysiwyg-code-slot-bottom 清除不足（须装饰段 + 全量清除两处先清后挂）');
  // ④ harness：lineInfo 量槽位类与底内距
  assert.ok(harness.includes("slot: (pre.className || '').indexOf('wysiwyg-code-slot-bottom') >= 0"), 'harness lineInfo 缺 slot 字段');
  assert.ok(harness.includes('padB: cs.paddingBottom'), 'harness lineInfo 缺 padB 字段');
  // ⑤ 回归接线：驱动 S78 场景 + S67 口径更新
  assert.match(driver, /S78：相邻代码块 渲染态≡编辑态 间距（块底 16px 槽位）/, '驱动缺 S78 场景');
  assert.match(driver, /渲染态基准：两代码块遮罩间间距 = 16px/, '驱动缺渲染态 16px 基准断言');
  assert.match(driver, /编辑态灰盒底↔下一代码块 = 渲染态 16px/, '驱动缺编辑态盒底间距断言');
  assert.match(driver, /灰盒绘制高不变 = 渲染态 pre 高 \+ 2×代码行高/, '驱动缺灰盒绘制高不变断言');
  assert.match(driver, /Math\.abs\(cb\.boxDelta - 16\) < 0\.5/, 'S67 块总高口径未更新（含 16px 底槽）');
  assert.match(driver, /close\.slot === true && close\.padB === '16px'/, 'S67 缺闭围栏行槽位断言');
});

test('S83 引用/提示块活动态「渲染分段 + 光标行源码」：非光标行渲染态遮罩、光标行源码（2026-10-25 用户要求编辑态样式与渲染态一致）', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 核心挂载：分段遮罩（上段 [start, rawS) / 下段 (rawE, end]）、清退、幂等判定
  assert.match(wys, /_wysiwygApplyQuoteSegments\(\) \{/, '缺 _wysiwygApplyQuoteSegments（引用活动态分段遮罩挂载）');
  assert.match(wys, /_wysiwygClearQuoteSegments\(\) \{/, '缺 _wysiwygClearQuoteSegments（分段遮罩清退）');
  // 键含 curLvl（S91 演进：光标行层级变化——弹级/删 >——时 cur/段源未变但 open/deep 类须重挂）
  // 键含 rawS/rawE（S105 演进：多行结构整体保源码 —— 形变,m范围随编辑变化须重挂）
  assert.match(wys, /_wysiwygSegState\s*=\s*\{ idx, cur, curLvl, rawS, rawE, topSrc, botSrc \}/, '缺分段幂等状态（idx+cursor+层级+源码区+两段源文）');
  assert.match(wys, /st\.rawS === rawS && st\.rawE === rawE/, '缺分段幂等 no-op 的源码区判定（多行结构范围变化须重挂）');
  assert.match(wys, /st\.idx === idx && st\.cur === cur && st\.curLvl === curLvl/, '缺分段幂等 no-op 判定（范围/层级/源文未变不重挂）');
  // ② 分段组成与渲染：上段 [b.start, rawS)、下段 (rawE+1, b.end]；下段合成块首标记行
  //    ⚠️ 不再写死 rawS=cur —— 光标落在多行原子结构（围栏/缩进代码/表格/公式/HTML/列表）
  //    内时 raw 区扩到整个结构，否则分段从结构中间劈开 → 渲染破裂（2026-10-28）
  assert.match(wys, /mk\(b\.start, rawS, 'wysiwyg-quote-seg-top'\)/, '缺上段挂载（[start, rawS)）');
  assert.match(wys, /mk\(rawE \+ 1, b\.end, 'wysiwyg-quote-seg-bottom'\)/, '缺下段挂载（(rawE, end]）');
  assert.match(wys, /const ar = quoteAtomicRange\(rawLines, cur - b\.start\);/, '缺多行原子结构区间求解（光标行单点切分会撕裂结构）');
  assert.match(wys, /wysiwyg-quote-seg-bottom' \? markerLine : null/, '缺下段合成标记行（callout 下段渲染成完整 alert）');
  // ②b 分段点击纵比：span+1 半区归一（原 ratio*span 末行只在节点底缘可达，短段下半区
  //     点击全落倒数第二行）
  assert.match(wys, /const span = r\.to\.line - r\.from\.line;[\s\S]{0,120}?Math\.min\(span, Math\.floor\(ratio \* \(span \+ 1\)\)\)/, '分段点击纵比缺 span+1 半区归一（末行点击不可达）');
  // ③ 块类型收口：引用判定与渲染器 getAlertType 同口径（避免散写同义正则）
  assert.match(wys, /_wysiwygBlockIsQuote\(b\) \{[\s\S]{0,200}?return RE\.quote\.test\(line\);/, '缺 _wysiwygBlockIsQuote（引用判定未收口 RE.quote）');
  assert.match(wys, /_wysiwygBlockAlertType\(b\) \{[\s\S]{0,200}?line\.startsWith\('> \[!info\]'\)/, '缺 _wysiwygBlockAlertType（callout 类型判定，与渲染器 getAlertType 同口径）');
  assert.ok((wys.match(/startsWith\('> \[!\w+\]'\)/g) || []).length >= 5, 'callout 类型判定不足 5 类（note/tip/important/warning/caution）');
  // ④ 渲染收口：renderWysiwygBlockHtml 抽公共渲染方法，两处复用同一管线
  assert.match(wys, /renderWysiwygBlockHtml\(start, end\) \{[\s\S]{0,200}?this\._wysiwygRenderSource\(lines\.join\('\\n'\)\);/, 'renderWysiwygBlockHtml 未收口到 _wysiwygRenderSource');
  assert.match(wys, /_wysiwygRenderSource\(src\) \{/, '缺公共渲染方法 _wysiwygRenderSource');
  // ⑤ 集成点：活动块切换退/挂、光标移动同步、change 钩子、防抖重算 ×2、格编辑/模式清理
  //（第三窗口 160→260：2026-11-01 性能改造在「重渲旧块」语句中插入 b.finalHtml=false
  // 复位——现渲染的 HTML 是结构 HTML，重挂时须重跑同步后处理并回写最终缓存）
  assert.match(wys, /const hadPrev = prev >= 0;[\s\S]{0,200}?_wysiwygClearQuoteSegments\(\);[\s\S]{0,80}?const b = this\._wysiwygBlocks && this\._wysiwygBlocks\[prev\];[\s\S]{0,260}?this\.maskWysiwygBlock\(prev\);/, 'setWysiwygActiveBlock 退活未先清分段（须在重遮 prev 之前清分段）');
  assert.match(wys, /if \(hadIdx\) this\._wysiwygApplyQuoteSegments\(\);[\s\S]{0,60}?if \(hadPrev \|\| hadIdx\) this\._restoreWysiwygAnchor\(\);/, 'setWysiwygActiveBlock 新活动块未在锚点补偿前挂分段');
  assert.match(wys, /this\.setWysiwygActiveBlock\(activeIdx\);[\s\S]{0,200}?this\._wysiwygApplyQuoteSegments\(\);/, 'syncWysiwygActiveBlock 光标移动后未重挂分段');
  assert.match(wys, /if \(self\._wysiwygBlockIsQuote\(b\)\) self\._wysiwygApplyQuoteSegments\(\);/, 'change 钩子缺分段重挂');
  assert.match(wys, /if \(delta > 0 && self\._wysiwygBlockIsQuote\(b\) && c\.to\.line === b\.end - 1\)/, 'change 钩子缺引用块 end 同步（回车续行即时扩展，防闪出）');
  assert.ok(((wys.match(/(?:this|self)\._wysiwygApplyQuoteSegments\(\);/g) || [])).length >= 4, '分段重挂调用点不足（change + sync + 防抖 ×2 至少 4 处）');
  assert.match(wys, /_wysiwygReMaskActiveForCellEdit\(tableIdx\) \{[\s\S]{0,700}?_wysiwygClearQuoteSegments\(\);\s*\n\s*this\._wysiwygActiveIdx = -1;/, '格编辑重遮前未清分段');
  assert.match(wys, /this\._wysiwygClearQuoteSegments\(\);\s*\n\s*if \(this\._wysiwygMarks\) \{/, 'clearWysiwygMasks 未清分段遮罩');
  // ⑥ 选中着色纳入分段遮罩
  assert.match(wys, /const allMarks = Array\.from\(this\._wysiwygMarks\.values\(\)\);[\s\S]{0,120}?if \(this\._wysiwygSegMarks\) allMarks\.push/, '分段遮罩未纳入选中着色类');
  // ⑦ CSS：分段接缝（去朝向光标行一侧的 padding/边距/圆角/内环）+ callout 光标行五类配色
  // 接缝只命中段盒顶层块（子选择器）：段内嵌套 blockquote 的 12/12 padding 是嵌套盒自身
  // 样式（渲染态恒有），不得清零（2026-10-25 实测后代选择器误伤 → S59 B 残差漂移 12px）
  assert.match(css, /\.wysiwyg-quote-seg-top > blockquote \{\s*margin-bottom: 0;\s*padding-bottom: 0;\s*border-bottom-right-radius: 0;\s*\}/, '缺上段 blockquote 接缝（底边距/底内距清零，须子选择器）');
  assert.match(css, /\.wysiwyg-quote-seg-bottom > blockquote \{\s*margin-top: 0;\s*padding-top: 0;\s*border-top-right-radius: 0;\s*\}/, '缺下段 blockquote 接缝（顶边距/顶内距清零，须子选择器）');
  assert.match(css, /\.wysiwyg-quote-seg-bottom \.alert \.alert-title \{\s*display: none;\s*\}/, '缺下段 alert 重复标题隐藏');
  assert.match(css, /wysiwyg-quote-line\.wysiwyg-callout-cursor-line \.wysiwyg-quote-slot \{\s*width: 22px;\s*\}/, '缺 callout 光标行槽宽 22px');
  // 2026-10-25 用户「编辑态与渲染态完全一致、规则不要互相冲突」：
  // ⑦a 底色单一来源——渲染 .alert-* 盒与光标行背景盒同取 --alert-{type}-bg（原 135deg 渐变
  //     逐盒重新开始接缝出色带，收平为 0.06 亮/0.09 暗中点值，明暗各一套变量）
  assert.ok((css.match(/--alert-\w+-bg: rgba\(var\(--alert-\w+-rgb\), 0\.06\);/g) || []).length >= 5, '缺 --alert-{type}-bg 平色变量（亮色 5 类，渐变→平色单一来源）');
  assert.ok((css.match(/--alert-\w+-bg: rgba\(var\(--alert-\w+-rgb\), 0\.09\);/g) || []).length >= 5, '缺 --alert-{type}-bg 暗色值（5 类）');
  assert.match(css, /\.alert-note \{\s*background: var\(--alert-note-bg\);/, '渲染态 .alert-note 未走平色变量（仍为渐变）');
  assert.match(css, /\.alert-caution \{\s*background: var\(--alert-caution-bg\);/, '渲染态 .alert-caution 未走平色变量（仍为渐变）');
  assert.ok(!/\.alert-note \{\s*background: linear-gradient/.test(css), '渲染态 .alert-note 仍是渐变底色（编辑态无法与渲染态完全一致）');
  // ⑦b 光标行类型类改名 wysiwyg-callout-{type}（旧 alert-{type} 让 pre 直接命中 .alert-*
  //     渲染规则：1px inset 内环铺满整行 = 「灰色框」规则冲突根源）
  // 2026-10-30 类型色放宽到块内所有 raw 行（图1）：选择器不再要求 callout-cursor-line 前缀
  assert.ok((css.match(/wysiwyg-quote-line\.wysiwyg-callout-\w+ \{\s*--qc-bg: var\(--alert-\w+-bg\);\s*--qc-bar:/g) || []).length >= 5, 'callout 五色未收口 --qc-bg/--qc-bar 变量（须落到块内所有 raw 行）');
  assert.doesNotMatch(css, /wysiwyg-callout-cursor-line\.alert-\w+/, '光标行类型类仍是 alert-{type}（pre 会命中 .alert-* 渲染规则）');
  // 2026-10-30（图1 根因）：--qc-bg 是背景「色」、不受 background-size/position 约束，
  // 会铺满整个 pre（横向满编辑区宽）→ 必须经 gradient「图」承载，底色才收得进盒
  assert.match(css, /pre\.wysiwyg-quote-line \{[^}]*background-image: linear-gradient\(var\(--qc-bg, var\(--accent-subtle\)\), var\(--qc-bg, var\(--accent-subtle\)\)\);/, '光标行底色未走 --qc-bg 渐变图（背景色会无视 size/position 铺满全宽）');
  assert.ok(!/pre\.wysiwyg-quote-line \{[^}]*background:\s*var\(--qc-bg/.test(css), 'quote-line 底色不得用 background-color/短手（背景色不受 background-size 约束、铺满全宽）');
  // ⑦c 边缘行全高左竖条（pre::before）：顶缘行铺满 100%、末缘行收在盒底（100%-16px margin）
  assert.match(css, /pre\.wysiwyg-quote-line\.wysiwyg-block-edge-top::before \{[^}]*height: 100%;[^}]*var\(--qc-bar, var\(--accent-color\)\)/, '缺顶缘行全高竖条（pre::before）');
  assert.match(css, /pre\.wysiwyg-quote-line\.wysiwyg-block-edge-bottom::before \{[^}]*height: calc\(100% - 16px\);/, '缺末缘行竖条收盒底（100%-16px margin）');
  assert.match(css, /pre\.wysiwyg-quote-line\.wysiwyg-block-edge-bottom \{[^}]*background-size: calc\(100% - 2 \* var\(--wysiwyg-line-inset, 32px\)\) calc\(100% - 16px\);/, '末缘行底色未收盒底（margin 区不应铺色）');
  // ⑦d callout 边缘距按 alert 盒参数（14/30，blockquote 12/28）+ 嵌套边缘组合（26/42）
  assert.match(css, /wysiwyg-callout-cursor-line\.wysiwyg-block-edge-top \{\s*padding-top: 14px;\s*\}/, 'callout 顶缘行未补 alert padding-top 14px');
  assert.match(css, /wysiwyg-callout-cursor-line\.wysiwyg-block-edge-bottom \{\s*padding-bottom: 30px;\s*\}/, 'callout 末缘行未补 30px（alert padB 14 + mb 16）');
  assert.match(css, /wysiwyg-callout-cursor-line\.wysiwyg-quote-nested\.wysiwyg-block-edge-bottom \{\s*padding-bottom: 42px;\s*\}/, 'callout 嵌套末缘行未补 42px（30+12）');
  // ⑦e 下段盒底距补回（无按钮占 last-child 位，16px 被清零 → 编辑态矮 16px 块下内容上跳）
  assert.match(css, /\.wysiwyg-quote-seg-bottom > \*:last-child \{\s*margin-bottom: 16px;\s*\}/, '缺下段 16px 底距补回（编辑态比渲染态矮 16px）');
  // ⑦e2 分段载体行（含 seg widget 的 pre）零样式：自身背景与段盒双重叠加（色差带）、
  //     边缘 padding 把段盒推离块缘（色差带+角线浮起）、pre::before 与段盒 border-left 重叠
  assert.match(css, /pre\.wysiwyg-quote-line:has\(span\.CodeMirror-widget \.wysiwyg-block-mask\) \{[^}]*background: none;[^}]*padding-top: 0;[^}]*padding-bottom: 0;/, '缺分段载体行零样式规则（段盒背后双背景/边缘内距推盒）');
  assert.match(css, /pre\.wysiwyg-quote-line:has\(span\.CodeMirror-widget \.wysiwyg-block-mask\)::before \{[^}]*display: none;/, '缺分段载体行竖条撤除（与段盒 border-left 重叠）');
  // ⑦e3 引用/提示块光标行撤 CM active-line 底色（codemirror.css #e8f2ff 垫底 → 光标行
  //     比段盒/渲染盒深一截）。2026-10-25 收口为「WYSIWYG 下 active-line 底色一律不画」，
  //     引用光标行由这条通用规则覆盖（不再有单独的 :has(~ pre.wysiwyg-quote-line) 变体）
  assert.match(css, /\.editor-container\.wysiwyg-mode \.CodeMirror \.CodeMirror-linebackground\.CodeMirror-activeline-background \{[^}]*background: transparent;/, '缺 WYSIWYG active-line 底色透明规则（#e8f2ff 垫底：引用行色差 / 表格上一行变蓝）');
  // ⑦f 引用/提示块不挂「编辑」按钮（no-btn-qc 补回渲染 blockquote/.alert 16px 底距）
  assert.match(wys, /else if \(this\._wysiwygBlockIsQuote\(b\)\) node\.classList\.add\('wysiwyg-mask-no-btn-qc'\);/, '引用/提示块遮罩未挂 no-btn-qc（编辑按钮未去掉）');
  assert.match(css, /wysiwyg-mask-no-btn-qc > \*:last-child \{ margin-bottom: 16px; \}/, '缺 no-btn-qc 16px 底距补回');
  // ⑦g 活动态灰底（cm-wysiwyg-active-block）整块跳过引用/提示块——光标行自绘渲染盒本貌，
  //     整行灰底铺在 pre 背景两侧露出 = 「灰色代码框/背景太乱」根源
  const hlFn2 = wys.slice(wys.indexOf('_applyWysiwygActiveHighlight() {'), wys.indexOf('_applyWysiwygActiveHighlight() {') + 3000);
  assert.match(hlFn2, /if \(this\._wysiwygBlockIsQuote\(b\)\) return;/, '活动块高亮未跳过引用/提示块（灰底与渲染盒叠加）');
  // ⑧ 驱动回归接线
  assert.match(driver, /=== S83：引用\/提示块 编辑态「渲染分段 \+ 光标行源码」/, '驱动缺 S83 场景');
  assert.match(driver, /非光标行渲染态 \+ 光标行源码/, '驱动缺 S83 分段/光标行断言');
  assert.match(driver, /下段渲染 \.alert、标题隐藏/, '驱动缺 S83 callout 下段断言');
  assert.match(driver, /点下段上部：光标映射段内行/, '驱动缺 S83 分段点击断言');
  // 2026-10-25 用户「编辑按钮去掉 + 无灰色代码框 + 与渲染态完全一致」的驱动断言接线
  assert.match(driver, /引用块\/callout 整块掩码无「编辑」按钮/, '驱动缺 S83 无编辑按钮断言');
  assert.match(driver, /活动态无灰底行（cm-wysiwyg-active-block 不挂引用块）/, '驱动缺 S83 无灰底断言');
  assert.match(driver, /中间行：无灰底 \+ 渲染盒单层平色（右缘 668 inset）\+ 无 active-line 垫底 \+ 上下接缝无缝 \+ 下段盒底→下一盒顶 16px/, '驱动缺 S83 中间行接缝/间距断言');
  assert.match(driver, /光标行底色=渲染盒单层平色（2 层背景：竖条\+底色、右缘 668 inset/, '驱动缺 S83 光标行单层同构底色断言（S86：纯色通宽 → 2 层 inset 背景）');
  assert.match(driver, /引用块编辑态（首行光标）：光标行↔下段无缝 \+ 块盒底→下一盒顶 16px（渲染态同间距）/, '驱动缺 S83 首行光标接缝/间距断言');
  assert.match(driver, /末行光标：上段↔光标行无缝 \+ 行底→下一盒顶 16px（渲染态同间距）/, '驱动缺 S83 末行光标间距断言');
  assert.match(driver, /callout 光标行底色 = 渲染 \.alert 平色/, '驱动缺 S83 callout 平色底断言');
});

test('S84 在引用块内插入引用块 = 原位嵌套（嵌套引用块，2026-10-25 用户反馈：引用内 / 插入引用要嵌套而非独立盒）', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const fmt = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'format.js'), 'utf8');
  const cst = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'constants.js'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 引用行口径收口共享常量（单一来源：wysiwyg.js 切块判定 + format.js 嵌套判定同源）
  assert.match(cst, /BLOCKQUOTE_LINE_RE = \/\^\(\\s\*\)>\/;/, 'constants.js 缺共享常量 BLOCKQUOTE_LINE_RE');
  assert.match(wys, /quote: TMConst\.BLOCKQUOTE_LINE_RE,/, 'wysiwyg.js RE.quote 未收口共享常量（散写同义正则）');
  // ② format.js insertLinePrefix：光标行已是引用行 → 行首原位加一级（与选区分支同语义），
  //    不走「上一行非空 → 插无前缀空行」拆块路径（旧行为：独立嵌套盒 + 末次插入空盒）
  assert.match(fmt, /if \(prefix === '> ' && window\.TMConst\.BLOCKQUOTE_LINE_RE\.test\(line\)\) \{[\s\S]{0,220}?cm\.replaceRange\(prefix, \{ line: cursor\.line, ch: 0 \}, \{ line: cursor\.line, ch: 0 \}\);/, 'insertLinePrefix 缺引用行原位嵌套分支（引用内 / 插入引用拆成独立盒）');
  // ③ 驱动回归接线
  assert.match(driver, /=== S84：在引用块内插入引用块 = 原位嵌套/, '驱动缺 S84 场景');
  assert.match(driver, /S84 核心：插入引用 = 行 4 原位嵌套 `> > `/);
  assert.match(driver, /S84 核心：全文源码 = 单层引用块内含两级嵌套（无空行分裂）/);
  assert.match(driver, /块表：行 2-5 同一引用块/);
  assert.match(driver, /S84 渲染态：嵌套盒/);
});

test('S85 嵌套引用光标行 = 渲染嵌套盒同构 + IME 组合竖排修复（2026-10-28 用户反馈：编辑态保持跟渲染态一致 + 拼音竖排）', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 修复1：嵌套光标行逐层底色 + 全高竖条（styles.css lvl-2..6 规则，与渲染嵌套盒同构）
  for (const n of [2, 3, 4, 5, 6]) {
    assert.match(css, new RegExp(
      'wysiwyg-quote-line\\.wysiwyg-quote-cursor-line\\.wysiwyg-quote-lvl-' + n +
      ':not\\(\\.wysiwyg-callout-cursor-line\\):not\\(\\.wysiwyg-block-edge-top\\):not\\(\\.wysiwyg-block-edge-bottom\\) \\{'),
      'styles.css 缺 wysiwyg-quote-lvl-' + n + ' 光标行规则');
  }
  // lvl-3 规则 = 6 层背景（3 层 × 竖条 + 底色），层位 80/56/32（渲染盒 border 同位）
  const lvl3rule = css.match(/wysiwyg-quote-lvl-3:[\s\S]{0,1600}?\n\}/);
  assert.ok(lvl3rule, 'styles.css lvl-3 规则体未找到');
  assert.strictEqual((lvl3rule[0].match(/no-repeat/g) || []).length, 6, 'lvl-3 光标行须 6 层背景（3 层 × 竖条 + 底色）');
  for (const x of [32, 56, 80]) {
    assert.ok(lvl3rule[0].includes(x + 'px 0 / 4px 100%'), 'lvl-3 规则缺 ' + x + 'px 全高竖条层');
    assert.ok(lvl3rule[0].includes(x + 'px 0 / calc('), 'lvl-3 规则缺 ' + x + 'px 层底色');
  }
  // ② 修复2：IME 组合竖排 = 仅组合期槽 nowrap（wysiwyg-ime-quote 类挂 pre，
  //    与 2026-10-19 标题组合字号同一 wiring；不可常驻——行尾键入会丢槽内空格，S84 实测）
  const slotRule = css.match(/\.editor-container\.wysiwyg-mode \.CodeMirror \.wysiwyg-quote-slot \{[\s\S]{0,1200}?\n\}/);
  assert.ok(slotRule, 'styles.css .wysiwyg-quote-slot 规则未找到');
  assert.doesNotMatch(slotRule[0], /white-space:/, '引用槽不可常驻 nowrap（行尾键入 CM 差分丢槽内空格，2026-10-28 S84 实测）');
  assert.match(css, /pre\.wysiwyg-ime-quote \.wysiwyg-quote-slot \{ white-space: nowrap;/,
    'styles.css 缺组合期作用域 nowrap 规则（pre.wysiwyg-ime-quote .wysiwyg-quote-slot）');
  assert.match(css, /\.wysiwyg-ol-marker \{[\s\S]{0,2500}?white-space: nowrap;/, '同族先例 .wysiwyg-ol-marker nowrap 不得回退');
  assert.match(wys, /RE\.quote\.test\(text\) \? 'wysiwyg-ime-quote' : null/, 'wysiwyg.js _wysiwygImeCompositionStart 缺引用行组合期挂类');
  assert.match(wys, /_wysiwygImeCompositionEnd\(\) \{[\s\S]{0,300}?_wysiwygImeLineCls/, 'wysiwyg.js compositionend 未统一摘类');
  // ③ JS：lvl-N 行类挂/撤（decor 按 > 数挂、封顶 6；两处引用行类清算随 nested 同撤）。
  //    2026-10-30 变量 level → lvlCount（空引用行跳过 span 循环后行类仍需层级数）
  assert.match(wys, /wysiwyg-quote-lvl-' \+ Math\.min\(lvlCount, 6\)/, 'wysiwyg.js decor 缺 lvl-N 行类挂载');
  const lvlRmCount = (wys.match(/wysiwyg-quote-lvl-' \+ n/g) || []).length;
  assert.ok(lvlRmCount >= 3, 'wysiwyg.js lvl-N 先清后挂/清算不足 3 处（decor + 两处行类清算），实际 ' + lvlRmCount);
  // ④ 驱动回归接线
  assert.match(driver, /=== S85：嵌套引用光标行 = 渲染嵌套盒同构 \+ IME 组合竖排修复/, '驱动缺 S85 场景');
  assert.match(driver, /S85 核心：光标行背景 = 6 层（3 层 × 竖条 \+ 底色，渲染嵌套盒同构）/);
  assert.match(driver, /槽常态 white-space: pre-wrap（nowrap 仅限组合期挂类，防行尾键入丢空格）/);
  assert.match(driver, /S85 核心：组合期挂 wysiwyg-ime-quote → 槽 nowrap/);
  assert.match(driver, /S85 核心：组合期槽未被折行撑高/);
  assert.match(driver, /上屏模型干净：行 9 = `> > > 阿斯蒂芬`、光标 ch10（无需 JS 修复）/);
  assert.match(driver, /组合期结束摘类（wysiwyg-ime-quote 撤除、槽恢复 pre-wrap）/);
});

test('S86 嵌套续行末行 = 嵌套盒底缘延续 + 单层光标行右缘 inset（2026-10-28 用户反馈①嵌套换行中间空白 ②引用内 / 无响应 + 蓝底铺到最右）', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const slash = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'slash.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 用户②：单层（lvl-1）光标行右缘 inset（旧基规则纯色 background-size 不生效 → 通宽）
  assert.match(css, /pre\.wysiwyg-quote-line\.wysiwyg-quote-cursor-line:not\(\.wysiwyg-callout-cursor-line\):not\(\.wysiwyg-quote-nested\):not\(\.wysiwyg-block-edge-bottom\) \{[\s\S]{0,400}?calc\(100% - 64px\) 100% no-repeat[\s\S]{0,80}?\}/,
    'styles.css 缺 lvl-1 中间行/顶缘 2 层 inset 背景（右缘 668）');
  // S92（2026-10-29）：选择器由 :not(edge-top) 收窄为要求 edge-bottom——旧选择器同时命中
  // 中间行且文件序在后，覆盖上方全高规则 → lvl-1 中间位光标行底 16px 无底色（白缝）
  assert.match(css, /:not\(\.wysiwyg-quote-nested\)\.wysiwyg-block-edge-bottom:not\(\.wysiwyg-block-edge-top\) \{[\s\S]{0,400}?calc\(100% - 64px\) calc\(100% - 16px\) no-repeat[\s\S]{0,80}?\}/,
    'styles.css 缺 lvl-1 底缘行 inset 背景（盒底收 16px margin，S92 起要求 edge-bottom）');
  // ② 用户①：嵌套末行（edge-bottom + lvl-N）底缘阶梯 + 顶缘（盒 d 顶 = 12d）
  assert.match(css, /wysiwyg-quote-lvl-2:not\(\.wysiwyg-callout-cursor-line\)\.wysiwyg-block-edge-bottom:not\(\.wysiwyg-block-edge-top\) \{[\s\S]{0,600}?56px 0 \/ 4px calc\(100% - 44px\)[\s\S]{0,300}?calc\(100% - 108px\) calc\(100% - 44px\)[\s\S]{0,300}?32px 0 \/ 4px calc\(100% - 16px\)/,
    'styles.css 缺 lvl-2 底缘 2 层阶梯（外盒收 16 / 内盒收 44）');
  assert.match(css, /wysiwyg-quote-lvl-3:not\(\.wysiwyg-callout-cursor-line\)\.wysiwyg-block-edge-top:not\(\.wysiwyg-block-edge-bottom\) \{[\s\S]{0,900}?80px 24px \/ 4px calc\(100% - 24px\)[\s\S]{0,500}?56px 12px \/ 4px calc\(100% - 12px\)/,
    'styles.css 缺 lvl-3 顶缘阶梯（盒 d 顶 = 12d：80px 24px / 56px 12px）');
  // ③ 分级边缘距（顶 12N / 底 28N；旧通用 24/40 仅 lvl-2 顶缘恰好正确）
  for (const [n, px] of [[3, 36], [4, 48], [5, 60], [6, 72]]) {
    assert.match(css, new RegExp(`wysiwyg-block-edge-top\\.wysiwyg-quote-lvl-${n} \\{ padding-top: ${px}px; \\}`),
      'styles.css 缺 lvl-' + n + ' 顶缘距 ' + px + 'px（12N）');
  }
  for (const [n, px] of [[2, 56], [3, 84], [4, 112], [5, 140], [6, 168]]) {
    assert.match(css, new RegExp(`wysiwyg-block-edge-bottom\\.wysiwyg-quote-lvl-${n} \\{ padding-bottom: ${px}px; \\}`),
      'styles.css 缺 lvl-' + n + ' 底缘距 ' + px + 'px（28N）');
  }
  // ④ 分段嵌套开口（open-N：层级 2..N 盒朝光标行敞口，消盒↔带 16px 白缝）
  for (const n of [2, 3, 4, 5, 6]) {
    assert.ok(css.includes(`wysiwyg-quote-seg-top.wysiwyg-quote-seg-open-${n} > blockquote > blockquote { margin-bottom: 0; padding-bottom: 0;`),
      'styles.css 缺 seg-top open-' + n + ' 嵌套盒清底');
    assert.ok(css.includes(`wysiwyg-quote-seg-bottom.wysiwyg-quote-seg-open-${n} > blockquote > blockquote { margin-top: 0; padding-top: 0;`),
      'styles.css 缺 seg-bottom open-' + n + ' 嵌套盒清顶');
  }
  // ④b 接缝深侧（段末/首行比光标深 = 闭合盒紧邻接缝）：开口盒 16px 内距吸收闭合盒 margin
  assert.match(css, /wysiwyg-quote-seg-top\.wysiwyg-quote-seg-deep\.wysiwyg-quote-seg-open-2 > blockquote > blockquote \{ padding-bottom: 16px; \}/,
    'styles.css 缺 seg-top deep 开口盒补 16px 底距（闭合盒 margin 逸出 = 盒↔带白条）');
  assert.match(css, /wysiwyg-quote-seg-top\.wysiwyg-quote-seg-deep\.wysiwyg-quote-seg-open-2 > blockquote > blockquote > blockquote \{ margin-bottom: 0; \}/,
    'styles.css 缺 seg-top deep 闭合盒（N+1）底距清零');
  assert.match(css, /wysiwyg-quote-seg-bottom\.wysiwyg-quote-seg-deep\.wysiwyg-quote-seg-open-2 > blockquote > blockquote \{ padding-top: 16px; \}/,
    'styles.css 缺 seg-bottom deep 开口盒补 16px 顶距');
  assert.match(wys, /wysiwyg-quote-seg-open-' \+ Math\.min\(curLvl, 6\)/, 'wysiwyg.js 分段节点未挂 open-N 类（按光标行 > 数、封顶 6）');
  assert.match(wys, /wysiwyg-quote-seg-deep/, 'wysiwyg.js 分段节点未挂 deep 类（段末/首行层级 > 光标层级）');
  // ⑤ 用户②（slash）：引用前缀 = 行首等价触发（>/ 与 > > > / 可触发；正文斜杠不误触）。
  // 源里是正则字面量，用字符串断言避免转义歧义
  assert.ok(slash.includes('const inQuotePrefix = /^'), 'slash.js 缺引用前缀行首等价触发（引用内输 / 没反应）');
  assert.ok(slash.includes(')*$/.test(line.slice(0, pos.ch - 1))'), 'slash.js 引用前缀判定口径缺失（/ 前只有 > 前缀）');
  assert.ok(slash.includes('!inQuotePrefix) return;'), 'slash.js 触发条件未并入引用前缀分支');
  // ⑥ 驱动回归接线
  assert.match(driver, /=== S86：嵌套续行末行 = 嵌套盒底缘延续/);
  assert.match(driver, /S86 核心：seg-top 挂 wysiwyg-quote-seg-open-2（嵌套开口方向 = 光标层级）/);
  assert.match(driver, /S86 核心：上段无白条（seg-top 底 = lvl2 盒底；深侧开口盒 16px 内距吸收闭合 lvl3 盒 margin，底色连续到接缝）/);
  assert.match(driver, /S86 核心：末行背景 = 4 层底缘阶梯（2 层 × 竖条 \+ 底色，外盒收 16、内盒收 44）/);
  assert.match(driver, /S86 核心：末行底距 = 56px（28×2，替代旧通用 40px）/);
  assert.match(driver, /顶缘对照：内层（lvl2）层顶 = 12px（盒 d 顶 = 12d）、高度收 12px/);
});

test('S87 空嵌套引用行回车逐级退出（2026-10-28 用户反馈：最内层空行回车应到上级引用块新增一行，无上级才跳出）', () => {
  const addon = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'codemirror', 'addon', 'edit', 'continuelist.js'), 'utf8');
  const vendorScript = fs.readFileSync(path.join(ROOT, 'scripts', 'ensure-vendor.mjs'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // 修复点在内置 CM addon 的 emptyListRE 分支（空行项出口）：原实现一次删光前缀
  // （嵌套引用直接跳出所有层级）→ 现按 match[2] 里 > 数逐级弹（lvl-N → lvl-N-1、光标留本行）。
  // addon 是 vendor 再生文件（.gitignore 内）——持久化 = ensure-vendor.mjs 再生后自动重打的补丁
  // （与 CM5 不跳顶补丁同一口径），断言两个层面：补丁源（受跟踪）+ 再生产物（本机状态）
  assert.ok(vendorScript.includes('function applyTizuMarkContinuelistPatch() {'),
    'ensure-vendor.mjs 缺 continuelist 补丁重打步骤（npm install 再生会抹掉逐级退出修复）');
  assert.ok(vendorScript.includes("marker: 'var quoteLvl = (match[2].match(/>/g) || []).length;'"),
    'ensure-vendor.mjs continuelist 补丁缺幂等 marker（锚点丢失须 exit 1，不得静默）');
  assert.ok(addon.includes('var quoteLvl = (match[2].match(/>/g) || []).length;'),
    'continuelist.js 空行分支未按引用前缀 > 数判定层级（逐级退出缺失）');
  assert.ok(addon.includes('for (var k = 0; k < quoteLvl - 1; k++) newPrefix += "> ";'),
    'continuelist.js 缺弹级重建前缀（新前缀 = 原层级 - 1）');
  assert.ok(addon.includes('replacements[i] = "";  // 不另插新行：光标停在弹级后的本行'),
    'continuelist.js 弹级后未留在本行（应不另插新行）');
  // 原行为保留：无上级（空 lvl-1）/ 空列表项 = 清行 + 光标落下方新行
  assert.ok((addon.match(/replacements\[i\] = "\\n";/g) || []).length >= 2,
    'continuelist.js 空 lvl-1 行/空列表项完全跳出（清行+新行）原行为丢失');
  // 驱动回归接线
  assert.match(driver, /=== S87：空嵌套引用行回车逐级退出/);
  assert.match(driver, /空 lvl-3 行回车 = 弹到 lvl-2（本行变 `> > `、光标留本行 ch4、行数不变）/);
  assert.match(driver, /空 lvl-1 行回车 = 完全跳出引用（本行清空、光标落下方新行、行数 \+1 = 原行为）/);
});

test('S89 嵌套引用光标行只显一个 >（2026-10-28 用户反馈：只在当前编辑的引用块的当前行显示一个 >）', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // 修复点：最内层槽挂 slot-inner 标记（外层槽无标记）；光标行显色规则只认该标记
  assert.ok(wys.includes("const lvlCount = (qm[1].match(/>/g) || []).length;"),
    'wysiwyg.js 未按行前缀 > 数判定最内层槽');
  assert.ok(wys.includes("add(lineNo, gt, end, 'wysiwyg-quote-slot' + (level === lvlCount ? ' wysiwyg-quote-slot-inner' : ''));"),
    'wysiwyg.js 最内层槽未挂 wysiwyg-quote-slot-inner 标记');
  assert.match(css, /wysiwyg-quote-cursor-line span\[class\*="wysiwyg-quote-slot-inner"\] \{\s*color: var\(--text-secondary\);\s*\}/,
    'styles.css 光标行 > 显色未限定到 slot-inner（嵌套行外层 > 仍会全显）');
  // 旧的全槽显色规则不得残留（会盖过 slot-inner 口径）
  assert.ok(!css.includes('.wysiwyg-quote-cursor-line span[class*="wysiwyg-quote-slot"] {'),
    'styles.css 残留旧的全槽光标行显色规则（嵌套行每层 > 都显）');
  // 基线透明规则保持（非光标行、光标行外层槽都靠它透明）
  assert.ok(css.includes('.wysiwyg-plain-text span[class*="wysiwyg-quote-slot"] {'),
    'styles.css 缺槽 > 默认透明基线规则');
  // 驱动回归接线
  assert.match(driver, /=== S89：嵌套引用光标行只显一个 >/);
  assert.match(driver, /S89 核心：光标行只显最内层一个 >（外层两层 > 透明）/);
});

test('S90 引用块编辑三修复（块高稳定 / 光标行底色统一 / 输入延迟，2026-10-28 用户反馈）', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const edc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 光标行上下间隙动态类（渲染态口径：同级 0 / 嵌套盒顶 26=14+12 / <p> 距 14 / 嵌套盒末 28=12+16；
  //   顶缘 pt 12N 与底缘 pb 28N 静态恰为渲染值 → 顶缘 pb / 底缘 pt 亦按口径动态、单行块不挂类）
  assert.ok(wys.includes('_wysiwygQuoteCurPadKey'), 'wysiwyg.js 缺光标行上下间隙取值 _wysiwygQuoteCurPadKey');
  assert.ok(wys.includes('pt = (lvlOf(n - 1) === L - 1) ? 26 : 0;'),
    'wysiwyg.js 光标行顶隙口径缺失（上一行浅一层 = 嵌套盒顶 26，其余 0）');
  assert.ok(wys.includes('pb = (nl === L + 1) ? 14 : (nl === L - 1) ? 28 : 0;'),
    'wysiwyg.js 光标行底隙口径缺失（下一行深一层 14 / 浅一层 28=盒末 12+16 / 同级 0）');
  for (const [cls, pad] of [['wysiwyg-quote-cur-tp-0', 'padding-top: 0;'], ['wysiwyg-quote-cur-tp-26', 'padding-top: 26px;'],
    ['wysiwyg-quote-cur-bp-0', 'padding-bottom: 0;'], ['wysiwyg-quote-cur-bp-14', 'padding-bottom: 14px;'],
    ['wysiwyg-quote-cur-bp-28', 'padding-bottom: 28px;']]) {
    assert.match(css, new RegExp(
      'wysiwyg-quote-cursor-line\\.' + cls + ' \\{\\s*' + pad.replace(';', ';\\s*')),
      'styles.css 缺光标行动态 padding 规则 ' + cls);
  }
  // ② 光标行高亮 = S94 实色灰带（2026-10-29 用户截图：首/末行更高、有深有暗、宽度与盒不一致
  //   → 替代 2026-10-28 的 --qc-bg 18% accent tint 覆写设计；详见 S94 专项测试）。
  //   旧 tint 规则不得残留（半透明 tint 随底色合成出深浅差）。
  assert.ok(!css.includes('--qc-bg: color-mix(in srgb, var(--accent-color) 18%, transparent);'),
    'styles.css 残留 S90② 旧 tint 规则（--qc-bg = 18% accent）');
  // ③ 输入延迟：行内非结构编辑判定 + 安全标志累积 + 防抖 safeSkip；change 监听透传变更对象
  assert.ok(wys.includes('_wysiwygChangeIsBoundarySafe'), 'wysiwyg.js 缺行内非结构编辑判定 _wysiwygChangeIsBoundarySafe');
  assert.ok(wys.includes('_wysiwygSafeSinceParse'), 'wysiwyg.js 缺自上次解析以来的安全标志累积 _wysiwygSafeSinceParse');
  assert.ok(wys.includes('this._wysiwygLastChange = c || null;'), 'wysiwyg.js 未记录最近变更（IME 组合顺延重排需透传）');
  assert.ok(edc.includes('if (this.viewMode === \'wysiwyg\') this.refreshWysiwygBlocks(c);'),
    'editor-core.js change 监听未透传变更对象（防抖无法判定行内安全编辑）');
  // 驱动回归接线
  assert.match(driver, /=== S90：引用块编辑三修复/);
  assert.match(driver, /S90① 10 个光标行 band（seg-top\+pre\+seg-bottom）均 = 遮罩高（块高不随光标行跳变，容差 0\.5px）/);
  assert.match(driver, /S90② 光标行高亮 = 统一实色灰带（S94：10 行同值中性灰、不透明）/);
  assert.match(driver, /S90③ 行内输入 5 字 \+ 250ms 停顿 → 零整篇重解析/);
});

test('S91 引用长行换行留距 + 嵌套弹级渲染修复（2026-10-28 用户反馈：①长引用自动换行两侧要留距、与渲染态一致 ②嵌套弹级后输入渲染态展示不出来+输入中显示异常）', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const rend = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 光标行长引用自动换行（二版纯盒模型，2026-10-29）：光标行 pre padding-left=32+24N /
  //    padding-right=32+20N（N=--qtext-lvl）→ 内容盒 = 渲染 N 层文本域 [32+24N, 668−20N]；
  //    首个 > 槽负 margin(−24N) 回盒左缘 [32, 32+24N]。首行/续行文本均在此域内换行，
  //    与渲染态逐像素一致。⚠️ 一版（wysiwyg-quote-text span inline-block 限宽）已废：
  //    该 span 类挂在 CM5 按 wikilink 等装饰拆分的每个片段 span 上，逐 span 限宽使含
  //    wikilink 的长行布局爆炸（用户 2026-10-29 截图）。纯 padding 不改任何 display，
  //    行高/S90 band/S85 IME 槽不受影响；callout 光标行排除（另有 padding 口径）。
  assert.match(css, /\.editor-container\.wysiwyg-mode \.CodeMirror pre\.wysiwyg-quote-cursor-line \{ --qtext-lvl: 1; \}/,
    'styles.css 缺光标行 --qtext-lvl 基准（lvl-1）');
  for (const n of [2, 3, 4, 5, 6]) {
    assert.match(css, new RegExp(
      'pre\\.wysiwyg-quote-cursor-line\\.wysiwyg-quote-lvl-' + n + ' \\{ --qtext-lvl: ' + n + '; \\}'),
      'styles.css 缺 lvl-' + n + ' 光标行 --qtext-lvl');
  }
  assert.match(css, /pre\.wysiwyg-quote-cursor-line:not\(\.wysiwyg-callout-cursor-line\) \{\s*padding-left:\s*calc\(var\(--wysiwyg-line-inset, 32px\) \+ 24px \* var\(--qtext-lvl\)\);\s*padding-right:\s*calc\(var\(--wysiwyg-line-inset, 32px\) \+ 20px \* var\(--qtext-lvl\)\);\s*\}/,
    'styles.css 缺光标行换行留距规则（pre padding 32+24N / 32+20N）');
  assert.match(css, /span\.wysiwyg-quote-slot:first-of-type \{\s*margin-left:\s*calc\(-24px \* var\(--qtext-lvl\)\);\s*\}/,
    'styles.css 缺首个 > 槽负 margin（回盒左缘）');
  // 一版 inline-block 方案已废：光标行作用域内不得再有 display:inline-block 限宽规则
  assert.doesNotMatch(css, /wysiwyg-quote-cursor-line[^{]*\{[^}]*display:\s*inline-block/,
    'styles.css 残留光标行 inline-block 限宽规则（wikilink 片段 span 会逐块独占一行）');
  // 换行留距不得波及非光标行（渲染段/普通行）：既有 .wysiwyg-quote-text 基规则只设字体/颜色
  const baseTxt = css.match(/\.editor-container\.wysiwyg-mode \.CodeMirror \.wysiwyg-quote-text \{[^}]*\}/);
  assert.ok(baseTxt && !/inline-block/.test(baseTxt[0]), 'styles.css 非光标行 .wysiwyg-quote-text 不得 inline-block（会改渲染段几何）');
  // ② 弹级（S87）后 seg 缓存键含光标行层级：层级变化（> > → >）时不再早退留陈旧
  //    seg-open-N/deep 类（实测残留 open-2 → 嵌套盒该闭合处仍敞口、pb/mb/圆角全清、块高 −28px）
  //    （2026-10-28 起幂等键另含 rawS/rawE：多行结构整体保源码后，范围随编辑变化也须重建）
  assert.match(wys, /if \(st && st\.idx === idx && st\.cur === cur && st\.curLvl === curLvl && st\.rawS === rawS && st\.rawE === rawE/,
    'wysiwyg.js 分段幂等键未含 curLvl/rawS/rawE（弹级/层级变化早退留陈旧 open/deep 类）');
  assert.match(wys, /this\._wysiwygSegState = \{ idx, cur, curLvl, rawS, rawE, topSrc, botSrc \};/,
    'wysiwyg.js _wysiwygSegState 未记录 curLvl/rawS/rawE');
  // ③ 渲染器层级回退（> > c 后 > d）：CommonMark 惰性延续把回退行并进嵌套盒最内层 P
  //    （用户外层输入在渲染态「消失」进嵌套盒 = 反馈②「渲染态展示不出来」）。
  //    修法在 normalizeListIndentation（lineMap 基建所在）：回退行前插目标层级空引用行
  //    （'>'×L，不产生节点），渲染 = 层级感知分块（与 wysiwyg 块表/分段同口径）
  assert.ok(rend.includes('let prevQuoteLvl = 0;'), 'unified-renderer.js 缺引用层级跟踪 prevQuoteLvl');
  assert.ok(rend.includes("if (qLvl < prevQuoteLvl) emit('>'.repeat(qLvl), origLine);"),
    'unified-renderer.js 缺层级回退空引用行前插（惰性延续把外层行并进嵌套 P）');
  assert.ok(rend.includes('const qm = line.match(/^\\s{0,3}(?:>[ \\t]?)+/);'),
    'unified-renderer.js 缺引用行前缀判定（> 计数口径）');
  // 围栏行须重置引用上下文（围栏后的引用行不得误判回退）
  const fenceResetCount = (rend.match(/prevQuoteLvl = 0;/g) || []).length;
  assert.ok(fenceResetCount >= 3, 'unified-renderer.js prevQuoteLvl 重置不足（围栏进出 + 非引用行须重置），实际 ' + fenceResetCount);
  // 驱动回归接线
  assert.match(driver, /=== S91：引用长行换行留距 \+ 嵌套弹级渲染修复/);
  assert.match(driver, /S91① lvl-1 长行换行（wikilink 行）：pre pad 56\/52、槽左缘=32、正文各视觉行左=56、右缘≤648、行高=视觉行数×27\.2/);
  assert.match(driver, /S91① lvl-2 长行换行：pre pad 80\/72、槽左缘=32、正文各视觉行左=80、右缘≤628/);
  assert.match(driver, /S91② 弹级后 seg 重分类（seg-deep、无 seg-open-N、顶层盒 pb16 接缝上色、闭合嵌套盒 mb0\/pb12\/圆角6）/);
  assert.match(driver, /S91② 光标移开后弹级行内容进 seg 渲染（渲染态可见）/);
  assert.match(driver, /S91③ 渲染器层级回退：> x 独立成外层 P（P\(ABC\) \| BQ\(sdm\) \| P\(x\)）/);
  assert.match(driver, /S91③ 无回退对照不变（P\(ab\) \| BQ\(cd\)）/);
  assert.match(driver, /S91④ 弹级态（光标在末行层级回退行）band = 遮罩高（块高不跳变）/);
});

test('S92 嵌套空行弹级到最外层后接缝着色（2026-10-29 用户截图：弹级行与上方块之间 16px 白缝、弹级行看似独立成盒）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // A. seg-top 层级回退（seg-deep 且无 seg-open-N）接缝上色：顶层开口盒补 16px 内距把
  //    首层嵌套盒的 16px margin 收进自身背景（渲染态该 16px 在外层盒背景内），闭合盒
  //    margin 清零防双重计入（总高不变 → S90 band 不变式）。:not(seg-open-2..6) 排除
  //    deep+open-N 态（其顶层盒已有自身 pb16 收 margin，再补会双重计入）。
  const dropSel = '.editor-container.wysiwyg-mode .CodeMirror .wysiwyg-block-mask.wysiwyg-quote-seg-top'
    + '.wysiwyg-quote-seg-deep:not(.wysiwyg-quote-seg-open-2):not(.wysiwyg-quote-seg-open-3)'
    + ':not(.wysiwyg-quote-seg-open-4):not(.wysiwyg-quote-seg-open-5):not(.wysiwyg-quote-seg-open-6)';
  assert.ok(css.includes(dropSel + ' > blockquote { padding-bottom: 16px; }'),
    'styles.css 缺 seg-top 层级回退顶层盒 pb16 接缝上色规则');
  assert.ok(css.includes(dropSel + ' > blockquote > blockquote { margin-bottom: 0; }'),
    'styles.css 缺 seg-top 层级回退闭合嵌套盒 mb0 规则（防双重计入）');
  // 只命中链首层（子选择器），更深层闭合盒由自身 12px 内距挡住 margin 外逸
  assert.ok(!css.includes(dropSel + ' > blockquote > blockquote > blockquote { padding-bottom'),
    'styles.css seg-top 层级回退规则误命中深层盒（只应命中链首层）');
  // B. lvl-1（非嵌套）光标行底色规则收窄为仅底缘行：原 :not(edge-top) 选择器与全高规则
  //    同特异性、文件序在后 → 中间行被误扣 16px 白缝（S86 潜伏缺陷，S87 弹级暴露）。
  assert.ok(css.includes(
    'pre.wysiwyg-quote-line.wysiwyg-quote-cursor-line:not(.wysiwyg-callout-cursor-line):not(.wysiwyg-quote-nested).wysiwyg-block-edge-bottom:not(.wysiwyg-block-edge-top) {'),
    'styles.css 缺收窄后的 lvl-1 底缘行光标底色规则（要求 wysiwyg-block-edge-bottom）');
  assert.doesNotMatch(css,
    /pre\.wysiwyg-quote-line\.wysiwyg-quote-cursor-line:not\(\.wysiwyg-callout-cursor-line\):not\(\.wysiwyg-quote-nested\):not\(\.wysiwyg-block-edge-top\) \{/,
    'styles.css 残留旧 lvl-1 光标行底色选择器（:not(edge-top) 未要求 edge-bottom，会误扣中间行底 16px）');
  // 驱动回归接线（两形态：块中弹级 + 块末弹级）
  assert.match(driver, /=== S92：弹级到最外层后接缝着色（2026-10-29 用户截图两形态）===/);
  assert.match(driver, /S92⑤ 块中弹级：光标落弹级行（`> sdfsdfsadf`、lvl-1 中间行）/);
  assert.match(driver, /S92⑤ 块中弹级：中间行光标底色全高（无 calc\(100% - 16px\) 白缝层）/);
  assert.match(driver, /S92⑤ 块中弹级：seg-top 顶层盒 pb16 收 margin \+ 闭合嵌套盒 mb0（接缝无白条）/);
  assert.match(driver, /S92⑤ 块中弹级：band = 整块遮罩高（S90 不变式，块高不跳变）/);
  assert.match(driver, /S92⑥ 块末弹级：光标落弹级行（`> sdfsdfsadf`、edge-bottom）/);
  assert.match(driver, /S92⑥ 块末弹级：底缘行底色保留 16px 敞口（calc\(100% - 16px\)，S86 设计）/);
  assert.match(driver, /S92⑥ 块末弹级：seg-top 顶层盒 pb16 收 margin \+ 闭合嵌套盒 mb0（接缝无白条）/);
  assert.match(driver, /S92⑥ 块末弹级：band = 整块遮罩高（S90 不变式，块高不跳变）/);
});

test('S94 引用光标行高亮 = 统一实色灰带（2026-10-29 用户截图：首/末行更高、有深有暗、宽度与内容所在盒不一致）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // ① 灰带 = 光标行 pre::after 实色带（2026-10-25 用户要求引用/提示块统一：callout 不再
  //   排除——此前 callout 光标行整行盒铺 --qc-bg 平色含边缘 padding = 满宽色条）：
  //   色 --qc-cursor（14% 文字色×底色，不透明 → 不随底色合成出深浅差）、
  //   左/右 = 最内层盒缘（32+24×(N−1) / 32+20×(N−1)）、
  //   顶/高 = 文本行域（--qc-tp/--qc-pb 镜像行 padding → 首/末/中间行同高）、
  //   z-index:-1 + pre z-index:0（带在底色上、竖条/文本下）。
  assert.match(css, /pre\.wysiwyg-quote-line\.wysiwyg-quote-cursor-line \{\s*--qc-cursor: color-mix\(in srgb, var\(--text-primary\) 14%, var\(--bg-primary\)\);\s*z-index: 0;\s*\}/,
    'styles.css 缺光标行 --qc-cursor 实色灰定义 + z-index:0 层叠上下文');
  assert.match(css, /pre\.wysiwyg-quote-line\.wysiwyg-quote-cursor-line::after \{\s*content: '';\s*position: absolute;\s*left: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 24px \* \(var\(--qtext-lvl, 1\) - 1\)\);\s*right: calc\(var\(--wysiwyg-line-inset, 32px\) \+ 20px \* \(var\(--qtext-lvl, 1\) - 1\)\);\s*top: var\(--qc-tp, 0px\);\s*height: calc\(100% - var\(--qc-tp, 0px\) - var\(--qc-pb, 0px\)\);\s*background: var\(--qc-cursor\);\s*z-index: -1;\s*pointer-events: none;\s*\}/,
    'styles.css 缺灰带 ::after 规则（最内层盒宽 × 文本行域、带下层序、无事件穿透）');
  assert.ok(!/wysiwyg-quote-cursor-line:not\(\.wysiwyg-callout-cursor-line\)::after/.test(css),
    '灰带不得再排除 callout（提示块光标行统一灰带，回退 = 满宽平色条）');
  // ② --qc-tp/--qc-pb 镜像 = 行盒 padding 的逐条对应（选择器/值与 padding 规则一一对应；
  //   含 S90 动态 cur-tp/cur-bp 与 S86 分级边缘距 —— 缺任一条 → 该形态行灰带高 ≠ 27.2）
  const mirrorCases = [
    ['pre\\.wysiwyg-quote-line \\{ --qc-tp: 0px; --qc-pb: 0px; \\}', '基准 0/0'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-block-edge-top \\{ --qc-tp: 12px; \\}', '顶缘 tp12'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-block-edge-bottom \\{ --qc-pb: 28px; \\}', '底缘 pb28'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-quote-nested \\{ --qc-tp: 12px; --qc-pb: 12px; \\}', '嵌套 12/12'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-quote-nested\\.wysiwyg-block-edge-top \\{ --qc-tp: 24px; \\}', '嵌套顶缘 tp24'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-quote-nested\\.wysiwyg-block-edge-bottom \\{ --qc-pb: 40px; \\}', '嵌套底缘 pb40'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-quote-cursor-line\\.wysiwyg-quote-cur-tp-0 \\{ --qc-tp: 0px; \\}', '动态 tp0'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-quote-cursor-line\\.wysiwyg-quote-cur-tp-26 \\{ --qc-tp: 26px; \\}', '动态 tp26'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-quote-cursor-line\\.wysiwyg-quote-cur-bp-0 \\{ --qc-pb: 0px; \\}', '动态 pb0'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-quote-cursor-line\\.wysiwyg-quote-cur-bp-14 \\{ --qc-pb: 14px; \\}', '动态 pb14'],
    ['pre\\.wysiwyg-quote-line\\.wysiwyg-quote-cursor-line\\.wysiwyg-quote-cur-bp-28 \\{ --qc-pb: 28px; \\}', '动态 pb28'],
  ];
  for (const [re, name] of mirrorCases) {
    assert.match(css, new RegExp(re), 'styles.css 缺 --qc-tp/--qc-pb 镜像 ' + name);
  }
  // S86 分级边缘距镜像（嵌套顶缘 36/48/60/72、底缘 56/84/112/140/168；缺则嵌套末行带高失真）
  for (const [lvl, v] of [[3, '36px'], [4, '48px'], [5, '60px'], [6, '72px']]) {
    assert.match(css, new RegExp(
      'wysiwyg-quote-nested:not\\(\\.wysiwyg-callout-cursor-line\\)\\.wysiwyg-block-edge-top\\.wysiwyg-quote-lvl-' + lvl + ' \\{ --qc-tp: ' + v + '; \\}'),
      'styles.css 缺 S86 分级顶缘镜像 tp' + v + '（lvl-' + lvl + '）');
  }
  for (const [lvl, v] of [[2, '56px'], [3, '84px'], [4, '112px'], [5, '140px'], [6, '168px']]) {
    assert.match(css, new RegExp(
      'wysiwyg-quote-nested:not\\(\\.wysiwyg-callout-cursor-line\\)\\.wysiwyg-block-edge-bottom\\.wysiwyg-quote-lvl-' + lvl + ' \\{ --qc-pb: ' + v + '; \\}'),
      'styles.css 缺 S86 分级底缘镜像 pb' + v + '（lvl-' + lvl + '）');
  }
  // ③ 驱动回归接线（用户原文档 4 光标位：顶/中/嵌套/底缘；S90 十行口径同步换新）
  assert.match(driver, /=== S94：引用光标行高亮（首\/中\/末行同高 \/ 统一灰 \/ 宽 ≡ 内容所在盒） ===/);
  assert.match(driver, /S94① 高亮高度各行一致 = 27\.2（顶\/中间\/嵌套\/底缘行同高，带顶 ≡ 行 padding-top）/);
  assert.match(driver, /S94② 高亮 = 统一实色中性灰（4 位置同值、不透明，深浅主题自适应）/);
  assert.match(driver, /S94③ 高亮宽度 ≡ 内容所在引用块（4 位置带左右缘 = 渲染同级盒左右缘，Δ≤1px）/);
  assert.match(driver, /S94④ 块高 = 遮罩高（S90① 不变式：高亮改动不破坏块高稳定，容差 0\.5px）/);
  assert.match(driver, /S90② 高亮几何（S94：带顶\/底 ≡ 行 padding、带高 27\.2 各行一致、带左右 ≡ 最内层盒）/);
});

test('S98 行内语法 span 边界对齐：驱动回归接线（编辑态 span 序列 ≡ 渲染参照）', () => {
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'wysiwyg-browser-check.mjs'), 'utf8');
  // S98 场景：5 单行段落块（空行隔离 → 4 遮罩作渲染参照），逐条断言光标行 span 序列
  assert.match(driver, /=== S98：行内语法 span 边界对齐渲染态（编辑态 ≡ 渲染态） ===/);
  assert.match(driver, /S98① \*\*x\* 斜体精确落 x（首 \* 素文本，≡ 渲染 \*<em>x<\/em>）/);
  assert.match(driver, /S98② \[a \[b\]\(c\) 链接精确落 b（S98 前 a 着链接色）/);
  assert.match(driver, /S98③ `` `a` 尾巴 code 精确落 a（≡ 渲染 `` <code>a<\/code>）/);
  assert.match(driver, /S98④ ```a`` 全字面量（无 code span，≡ 渲染）/);
  assert.match(driver, /S98⑤ 回归行 \*\*粗体\*\* bold span 不变/);
});

test('S99 WYSIWYG 不画 active-line 蓝底 + 光标色恒定（2026-10-25 用户反馈接线）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const pure = strip(css);

  // ① 用户反馈「编辑表格时上面一行会变成蓝色」：格编辑期 _applyWysiwygActiveHighlight 按设计
  //    不给上一块挂灰底，addon 的 #e8f2ff 就独占该行、透在已渲染内容下。收口为「WYSIWYG 下
  //    active-line 底色一律不画」——编辑指示只由 cm-wysiwyg-active-block 系负责（特异性
  //    (0,5,1) 高于本条 (0,5,0)，灰底/代码盒不受影响）。
  assert.match(
    pure,
    /\.editor-container\.wysiwyg-mode \.CodeMirror \.CodeMirror-linebackground\.CodeMirror-activeline-background \{\s*background: transparent;\s*\}/,
    'styles.css 缺「WYSIWYG 撤 active-line 底色」规则（表格上一行会变蓝）',
  );
  // 反向约束：不再保留「按行判断才撤底」的 :has 变体（两种口径并存会漏掉新增场景）
  assert.doesNotMatch(
    pure,
    /CodeMirror-activeline-background:has\(/,
    '不应再有 :has() 条件的 active-line 撤底规则（口径已收口为整类撤掉）',
  );

  // ② 用户反馈「亮色主题下鼠标变白、白底上看不到」：caret-color 默认 auto → currentColor，
  //    活动行的隐藏标记 span 自身 color: transparent（列表圆点/任务框/引用槽），光标落进去
  //    就继承到透明。必须在编辑面写死具体色值（var 在此解析成实色后继承）。
  assert.match(
    pure,
    /\.editor-container\.wysiwyg-mode \.CodeMirror \{\s*caret-color: var\(--text-primary\);\s*\}/,
    'styles.css 缺 WYSIWYG 光标色规则（caret-color 会继承到隐藏标记的 transparent，光标不可见）',
  );
  // 反向约束：不允许再出现把光标显式设成透明的 WYSIWYG 规则
  assert.doesNotMatch(
    pure,
    /\.editor-container\.wysiwyg-mode[^{]*\{[^}]*caret-color: transparent/,
    'WYSIWYG 编辑面不得把 caret-color 设成 transparent',
  );
});

test('S106 引用块尾回车跳出（2026-10-25 用户反馈：块尾多次回车跳不出引用块、下方闪出一串 > 又自动消失）', () => {
  const addon = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'codemirror', 'addon', 'edit', 'continuelist.js'), 'utf8');
  const vendorScript = fs.readFileSync(path.join(ROOT, 'scripts', 'ensure-vendor.mjs'), 'utf8');
  // 根因：空引用行回车的「块中间续行」口径只看紧邻下一行是否引用行——用户块尾的空 >
  // 续行产物落在光标下方（WYSIWYG 底部遮罩吞掉不可见），下一行永远是引用行 → 续行
  // 死循环、永远跳不出。修复：光标行之下直到块尾全是空引用行 → 按块尾口径跳出，并
  // 把这批不可见的续行垃圾一并删掉；下方还有带内容的引用行才维持续行口径（不拆块）。
  // addon 是 vendor 再生文件——断言补丁源（受跟踪）+ 再生产物（本机状态）两层。
  assert.ok(vendorScript.includes('var onlyEmptyBelow = true;'),
    'ensure-vendor.mjs continuelist 补丁缺「块尾全空引用行判定」（onlyEmptyBelow 扫描缺失）');
  assert.ok(addon.includes('var onlyEmptyBelow = true;'),
    'continuelist.js 缺「块尾全空引用行判定」（onlyEmptyBelow 扫描缺失）');
  assert.ok(addon.includes('if (typeof ql !== "string" || !/^\\s*>/.test(ql)) break;'),
    'continuelist.js 缺块尾扫描终止条件（非引用行/EOF 即止）');
  assert.ok(addon.includes('if (ql.replace(/^\\s*>[> \\t]*/, "").trim() !== "") { onlyEmptyBelow = false; break; }'),
    'continuelist.js 缺「带内容的引用行 → 仍按块中间续行」判定（会拆块回归 S87 前的断块问题）');
  assert.ok(addon.includes('cm.replaceRange("", { line: pos.line + 1, ch: 0 }, { line: blockEnd + 1, ch: 0 });'),
    'continuelist.js 跳出前未删除光标行之下的空引用行垃圾（块底残留一排空行/裸源码）');
  // 续行口径保留：下方有内容行时仍续行（2026-10-25 上轮「块中间回车断成两块」的回归保护）
  assert.ok(addon.includes('replacements[i] = "\\n" + match[1] + match[2] + match[5];'),
    'continuelist.js 块中间续行口径丢失（空引用行回车会拆开引用块）');
});
