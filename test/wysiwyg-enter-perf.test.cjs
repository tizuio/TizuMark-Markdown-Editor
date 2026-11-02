// WYSIWYG 进入性能改造回归（2026-11-01）：
// ① 块最终 HTML 缓存（跨进入复用）：renderMarkdownBlocks htmlCache 命中打 finalHtml 标记；
//    wysiwyg 侧 LRU + 指纹失效；挂遮罩命中跳过同步后处理、现渲染回写缓存。
// ② 视口优先挂载：_enterWysiwygFullView 先挂视口 ±15 块、其余分批补挂（时间片预算）。
// ③ 渲染管线：unified processor 单例复用；options.skipHtml 真正生效；
//    异步 pass 刷新合帧（16ms setTimeout，禁 rAF）；TOC 同步注入保持直调刷新。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const WYS = path.join(ROOT, 'src', 'modules', 'wysiwyg.js');
const UR = path.join(ROOT, 'src', 'unified-renderer.js');
const THEME = path.join(ROOT, 'src', 'modules', 'theme.js');

// ---------- renderMarkdownBlocks：htmlCache 命中 / finalHtml 标记 / skipHtml ----------

test('renderMarkdownBlocks: htmlCache 命中跳过渲染管线并打 finalHtml 标记', () => {
  const { renderMarkdownBlocks } = require(UR);
  const md = '# 标题\n\n第一段内容。\n\n第二段内容。';
  const cache = new Map();
  const first = renderMarkdownBlocks(md, { htmlCache: cache });
  assert.strictEqual(first.filter(b => b.finalHtml).length, 0, '首渲（缓存空）不得标记 finalHtml');
  // 模拟 wysiwyg 侧回写（挂遮罩同步后处理后写缓存）：以块 slice 为键写入「最终 HTML」
  for (const b of first) {
    const slice = md.replace(/\r\n/g, '\n').split('\n').slice(b.start, b.end).join('\n');
    cache.set(slice, b.html + '<!--cached-->');
  }
  const second = renderMarkdownBlocks(md, { htmlCache: cache });
  assert.strictEqual(second.length, first.length, '缓存命中不得改变切块');
  for (let i = 0; i < second.length; i++) {
    assert.strictEqual(second[i].finalHtml, true, `块 ${i} 命中缓存应标记 finalHtml`);
    assert.ok(second[i].html.endsWith('<!--cached-->'), `块 ${i} 应使用缓存 HTML`);
  }
  // 无 cache 选项时不打标记（向后兼容）
  const plain = renderMarkdownBlocks(md, {});
  assert.strictEqual(plain.filter(b => b.finalHtml).length, 0, '未传 htmlCache 不得标记 finalHtml');
});

test('renderMarkdownBlocks: options.skipHtml 真正生效（只切边界不渲染）', () => {
  const { renderMarkdownBlocks } = require(UR);
  const md = '# 标题\n\n段落内容。';
  const blocks = renderMarkdownBlocks(md, { skipHtml: true });
  assert.ok(blocks.length >= 2, '应切出多个块');
  for (const b of blocks) {
    assert.strictEqual(b.skipped, true, 'skipHtml 时块应置 skipped');
    assert.strictEqual(b.html, '', 'skipHtml 时不得渲染 html');
  }
});

test('renderMarkdown: unified processor 单例复用（同参数不重建管线）', () => {
  const src = fs.readFileSync(UR, 'utf8');
  assert.match(src, /function getUnifiedProcessor\(softBreaks\) \{/, '缺少 processor 复用函数');
  assert.match(src, /if \(_unifiedProcCache && _unifiedProcKey === key\) return _unifiedProcCache;/,
    'processor 复用未命中单例（每次重建整条 remark→rehype 管线）');
  assert.match(src, /getUnifiedProcessor\(softBreaks\)\.processSync\(processed\)/, 'renderMarkdown 未走复用 processor');
});

// ---------- wysiwyg 侧最终缓存：指纹失效 / LRU / 挂遮罩读写 ----------

// 最小 fake this：只需 settings/preview/isDark（指纹）与缓存方法（来自 mixin）。
// wysiwyg.js 加载期引用裸全局 TMConst（constants.js IIFE 写 window.TMConst）——
// Node require 前先补 window + 加载 constants（同 wysiwyg-quote-atomic-seg.test.cjs 先例）。
function makeHost() {
  global.window = global.window || globalThis;
  require(path.join(ROOT, 'src', 'modules', 'constants.js'));
  const { mixin } = require(WYS);
  return {
    settings: { softBreaks: false, tabSize: 4, extendedSyntax: true },
    preview: { classList: { contains: () => false } },
    isDark: false,
    _wysiwygFinalHtmlFingerprint: mixin._wysiwygFinalHtmlFingerprint,
    _wysiwygFinalHtmlCacheMap: mixin._wysiwygFinalHtmlCacheMap,
    _wysiwygCacheFinalHtml: mixin._wysiwygCacheFinalHtml,
  };
}

test('最终 HTML 缓存：写入/命中/LRU 上限/指纹失效', () => {
  const host = makeHost();
  host._wysiwygCacheFinalHtml('src-a', '<p>a</p>');
  host._wysiwygCacheFinalHtml('src-b', '<p>b</p>');
  const map = host._wysiwygFinalHtmlCacheMap();
  assert.strictEqual(map.get('src-a'), '<p>a</p>', '写入后应可读');
  // LRU：灌满后旧条目淘汰；最近重写/访问的条目保住
  for (let i = 0; i < 3000; i++) host._wysiwygCacheFinalHtml('fill-' + i, '<p>' + i + '</p>');
  assert.strictEqual(map.has('src-a'), false, '灌满后最早条目应被淘汰');
  assert.ok(map.size <= 3000, '缓存不得超上限');
  host._wysiwygCacheFinalHtml('src-a', '<p>a2</p>'); // 重新写入（=最近使用）
  for (let i = 0; i < 10; i++) host._wysiwygCacheFinalHtml('more-' + i, '<p>' + i + '</p>');
  assert.strictEqual(map.has('src-a'), true, '最近重写的条目应保留（LRU）');
  assert.strictEqual(map.get('src-a'), '<p>a2</p>', '重写应更新值');
  // 指纹失效：设置变化 → 整体清空
  host.settings.softBreaks = true;
  const map2 = host._wysiwygFinalHtmlCacheMap();
  assert.notStrictEqual(map2, map, '指纹变化应换新缓存 Map');
  assert.strictEqual(map2.size, 0, '新缓存应为空');
  // 超大 HTML 不缓存
  host._wysiwygCacheFinalHtml('big', 'x'.repeat(262145));
  assert.strictEqual(map2.has('big'), false, '超 256KB 的 HTML 不应入缓存');
  // 行号开关进指纹
  host.settings.softBreaks = false;
  const map3 = host._wysiwygFinalHtmlCacheMap();
  map3.set('k', 'v');
  host.preview = { classList: { contains: (c) => c === 'code-line-numbers' } };
  const map4 = host._wysiwygFinalHtmlCacheMap();
  assert.notStrictEqual(map4, map3, '代码行号开关变化应失效缓存');
});

test('挂遮罩读写缓存：命中跳过同步后处理，现渲染回写缓存（静态接线）', () => {
  const wsrc = fs.readFileSync(WYS, 'utf8');
  const mIdx = wsrc.indexOf('maskWysiwygBlock(idx) {');
  assert.ok(mIdx > 0, '缺少 maskWysiwygBlock');
  const mblk = wsrc.slice(mIdx, mIdx + 3000);
  assert.match(mblk, /if \(b\.finalHtml\) \{[\s\S]{0,400}?\} else \{\s*\n\s*this\._postProcessWysiwygNode\(node\);[\s\S]{0,200}?this\._wysiwygCacheFinalHtml\(b\.src, node\.innerHTML\);/,
    '挂遮罩未按 finalHtml 分流（命中须跳过同步后处理；现渲染须回写最终缓存）');
  assert.match(wsrc, /htmlCache: this\._wysiwygFinalHtmlCacheMap\(\), [\s\S]{0,80}?\}\);\s*\}\s*$/m, '') // 弱断言占位
  assert.match(wsrc, /precomputeWysiwygBlocksFull[\s\S]{0,900}htmlCache: this\._wysiwygFinalHtmlCacheMap\(\)/,
    '全量预渲染未传最终缓存（命中块无法跳过渲染管线）');
  assert.match(wsrc, /computeWysiwygBlocks\(parseOnly\) \{[\s\S]{0,700}htmlCache: this\._wysiwygFinalHtmlCacheMap\(\)/,
    'computeWysiwygBlocks 未传最终缓存');
  // 重键传递 finalHtml（否则重挂时误跑/漏跑后处理）
  assert.match(wsrc, /nb\.html = \(ob\.html !== undefined\) \? ob\.html : nb\.html; \/\/ 复用缓存 html\s*\n\s*if \(ob\.html !== undefined\) nb\.finalHtml = !!ob\.finalHtml;/,
    '块重键未传递 finalHtml 标记');
  // 现渲染点复位 finalHtml（4 处：任务勾选/退活/格编辑提交/活动块切换）
  assert.strictEqual((wsrc.match(/b\.finalHtml = false;/g) || []).length, 4,
    '现渲染结构 HTML 后未复位 finalHtml（应为 4 处）');
});

test('视口优先挂载：先挂视口 ±15 块，其余分批补挂（时间片预算 + 滚动优先）', () => {
  const wsrc = fs.readFileSync(WYS, 'utf8');
  const eIdx = wsrc.indexOf('_enterWysiwygFullView() {');
  const eblk = wsrc.slice(eIdx, wsrc.indexOf('_wysiwygPumpIdleMount() {', eIdx));
  assert.match(eblk, /getScrollInfo\(\)/, '未取当前视口（无法视口优先）');
  assert.match(eblk, /const MARGIN = 15;/, '缺少视口预取边距');
  assert.match(eblk, /this\._wysiwygIdleMountJob = rest\.length \? \{ blocks, list: rest, pos: 0 \} : null;/, '剩余块未登记补挂队列');
  // 泵：时间片预算 + 让帧 + 完成后冲刷异步 pass
  const pIdx = wsrc.indexOf('_wysiwygPumpIdleMount() {');
  const pblk = wsrc.slice(pIdx, wsrc.indexOf('_wysiwygFullMountVisible() {', pIdx));
  assert.match(pblk, /Date\.now\(\) - t0 > 12/, '补挂缺时间片预算（退化为单长任务）');
  assert.match(pblk, /setTimeout\(\(\) => \{ self\._wysiwygIdleMountTimer = null; self\._wysiwygPumpIdleMount\(\); \}, 16\)/, '补批未让帧');
  assert.match(pblk, /this\._wysiwygBlocks !== job\.blocks/, '块表换代未重建剩余队列（增量刷新后索引失效）');
  assert.match(pblk, /this\.flushWysiwygAsyncPasses\(\);/, '补挂完成未冲刷异步 pass');
  // 滚动优先：补挂期间滚动到未挂区域立即挂视口块
  const vIdx = wsrc.indexOf('_wysiwygFullMountVisible() {');
  const vblk = wsrc.slice(vIdx, wsrc.indexOf('// 分批补挂剩余块', vIdx));
  assert.match(vblk, /cm\.operation\(\(\) => \{ for \(const k of need\) this\.maskWysiwygBlock\(k\); \}\)/, '滚动优先未同步挂视口块');
  assert.match(vblk, /job\.list = near\.concat\(far\);/, '剩余队列未按视口邻近重排');
  // scroll 钩子全量分支
  const hIdx = wsrc.indexOf('_ensureWysiwygScrollHook() {');
  const hblk = wsrc.slice(hIdx, wsrc.indexOf('// ---------------- 全量预渲染', hIdx));
  assert.match(hblk, /else if \(self\._wysiwygFull && self\._wysiwygIdleMountJob\) \{[\s\S]{0,300}_wysiwygFullMountVisible/, 'scroll 钩子缺全量补挂优先分支');
  // 清理：离开模式/重建时取消队列与合帧刷新
  const cIdx = wsrc.indexOf('clearWysiwygMasks() {');
  const cblk = wsrc.slice(cIdx, cIdx + 8200);
  assert.match(cblk, /this\._wysiwygIdleMountJob = null;/, '清理未作废补挂队列（离开模式后泵会继续挂旧块）');
  assert.match(cblk, /clearTimeout\(this\._wysiwygIdleMountTimer\)/, '清理未取消补挂定时器');
  assert.match(cblk, /this\._wysiwygRefreshPending = false;/, '清理未复位合帧刷新标志');
});

test('异步 pass 刷新合帧：16ms setTimeout（禁 rAF），TOC 同步注入保持直调刷新', () => {
  const wsrc = fs.readFileSync(WYS, 'utf8');
  const rIdx = wsrc.indexOf('_wysiwygRefreshAfterMaskChange() {');
  assert.ok(rIdx > 0, '缺少刷新合帧入口');
  const rblk = wsrc.slice(rIdx, wsrc.indexOf('_wysiwygDoRefreshAfterMaskChange() {', rIdx));
  assert.match(rblk, /if \(this\._wysiwygRefreshPending\) return;/, '未合帧（同帧多 pass 各自全量 refresh=刷新风暴）');
  assert.match(rblk, /setTimeout\(/, '合帧未让出（应 16ms setTimeout）');
  assert.doesNotMatch(wsrc, /requestAnimationFrame/, 'wysiwyg.js 禁用 rAF（全局约束）');
  // TOC 同步注入：直调 do 版本（同任务内刷新，不跳顶修复③ 契约）
  const tIdx = wsrc.indexOf('this._wysiwygApplyTocHtml(node, tocCache.html);');
  assert.ok(tIdx > 0, '缺 TOC 同步注入');
  assert.match(wsrc.slice(tIdx, tIdx + 600), /this\._wysiwygDoRefreshAfterMaskChange\(\);/,
    'TOC 同步注入未直调刷新本体（合帧会露出「占位→全高」阶跃一帧）');
  // 合帧本体仍含探针→refresh→补偿链（不跳顶修复④ 契约）
  assert.match(wsrc, /const probe = this\._wysiwygDomProbe\(cm\);[\s\S]{0,120}cm\.refresh\(\);[\s\S]{0,500}after\.top - probe\.top/,
    '刷新补偿丢失 DOM 探针基准');
});

test('主题切换清最终 HTML 缓存（mermaid 缓存同点失效）', () => {
  const tsrc = fs.readFileSync(THEME, 'utf8');
  const mIdx = tsrc.indexOf('this._mermaidCache.clear();');
  assert.ok(mIdx > 0, '缺 mermaid 缓存清理点');
  assert.match(tsrc.slice(mIdx, mIdx + 300), /if \(this\._wysiwygFinalHtmlCache\) this\._wysiwygFinalHtmlCache\.clear\(\);/,
    '主题切换未清 WYSIWYG 最终 HTML 缓存（高亮类名/图表配色随主题变化）');
});
