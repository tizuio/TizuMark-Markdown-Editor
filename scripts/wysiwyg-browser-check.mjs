// 无头浏览器对比测试：阅读模式 vs 所见即所得（真实 Chromium + 真实 CM5 + 真实渲染管线）。
// 用法：node scripts/wysiwyg-browser-check.mjs
// 依赖：playwright（全局 npm 包）+ 项目根下 _wysiwyg_compare.html harness。
// 结果非 0 退出码 = 存在不一致。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// playwright 装在全局 npm 目录（本机未做本地依赖），直接按绝对路径引入
const pw = require('C:/Users/admin/AppData/Roaming/npm/node_modules/playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const url = pathToFileURL(path.join(root, '_wysiwyg_compare.html')).href;

const browser = await pw.chromium.launch({ headless: true });
let fail = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('页面异常: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  // ---------- 场景 1：渲染一致性 ----------
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => window.__runCompare());
  const r = await page.evaluate(() => window.__RESULT);
  console.log('=== 场景 1：所见即所得 vs 阅读模式（渲染一致性） ===');
  console.log(`遮罩块数: ${r.maskCount}  remark 块数: ${r.blockCount}`);
  const checks = [
    [`遮罩 white-space = ${r.ws}（应为 normal，否则标签间换行会显示为真实换行）`, r.ws === 'normal'],
    [`逐块渲染与整篇渲染标签序列同构（与阅读模式一致的核心判据）`, r.structureEqual],
    [`列表序号与内容同行（li↔p 顶部差 ${r.listInlineGap}px，应 < 8）`, r.listInlineGap != null && r.listInlineGap < 8],
    [`无空列表项（「只剩序号的空行」）: ${r.emptyLi} 个`, r.emptyLi === 0],
    [`空行塌缩生效: ${r.blankCollapsed} 行`, r.blankCollapsed > 0],
    [`空行提示类已挂: ${r.hintClass}`, r.hintClass],
    [`空行提示文案 = ${r.hintText}（应为 "emptyLineHint"）`, typeof r.hintText === 'string' && r.hintText.includes('emptyLineHint')],
    // 短文档遮罩后不足一屏，scrollTop 恒为 0，锚定被浏览器钳制 → 此处只做「不产生结构性跳动」宽松判定；
    // 严格锚定验证放场景 3（长文档，顶部/底部都有滚动余量）。
    [`点击不产生结构性跳动（短文档钳制偏差 ${r.clickAnchorGap}px，应 < 视口 600）${r.clickDiag ? ' ' + JSON.stringify(r.clickDiag) : ''}`,
      r.clickAnchorGap != null && r.clickAnchorGap < 600],
    [`表格单元格点击定位到源码行: ${r.tableCellLine}（应 = 25）`, r.tableCellLine === 25],
    [`渲染态点击任务复选框可切换源码: ${r.checkboxToggled}`, r.checkboxToggled],
    [`遮罩内公式已转 KaTeX（不补跑预览后处理会露 $$ 源码）: ${r.mathRendered}`, r.mathRendered],
    [`遮罩内代码块已高亮包裹（code-scroll）: ${r.codeHighlighted}`, r.codeHighlighted],
    [`遮罩内复选框已移除 disabled（否则渲染态点不动）: ${r.checkboxEnabled}`, r.checkboxEnabled],
    [`遮罩数与 remark 块数一致（活动块除外）: ${r.maskCount} === ${r.blockCount} - 1`,
      r.maskCount === r.blockCount - (r.activeIdx >= 0 ? 1 : 0)],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }
  if (!r.structureEqual) {
    console.log('  --- 标签序列差异 ---');
    console.log('  整篇: ' + r.wholeTagsSample);
    console.log('  逐块: ' + r.maskTagsSample);
  }

  // ---------- 场景 2：大文档虚拟遮罩 + IME ----------
  await page.evaluate(() => window.__runVirtual());
  const v = await page.evaluate(() => window.__RESULT2);
  console.log('\n=== 场景 2：大文档虚拟遮罩 + IME 守卫 ===');
  console.log(`块数: ${v.blockCount}  全量重建耗时: ${v.elapsed}ms`);
  const checks2 = [
    [`虚拟模式已启用（${v.blockCount} 块 > 80）: ${v.virtual}`, v.virtual],
    [`初始只挂视口附近遮罩: ${v.maskCount} 个（应远小于块数）`, v.virtual && v.maskCount < v.blockCount],
    [`滚动后遮罩跟随视口: ${v.maskCountAfterScroll} 个`, v.maskCountAfterScroll > 0 && v.maskCountAfterScroll < v.blockCount],
    [`IME 组合期间防抖补齐被顺延: ${v.imeDeferred}`, v.imeDeferred],
  ];
  for (const [label, ok] of checks2) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- 场景 3：长文档严格点击锚定 ----------
  await page.evaluate(() => window.__runAnchor());
  const a = await page.evaluate(() => window.__RESULT3);
  console.log('\n=== 场景 3：长文档点击锚定（用户反馈「点击屏幕乱跳」的主场景）===');
  for (const s of a.samples) console.log('  ' + (s ? JSON.stringify(s) : '无可见遮罩（跳过）'));
  const inView = a.samples.filter(Boolean).every(s => s.top >= 0 && s.top < 600);
  const checks3 = [
    // 硬底线：被点中的源码行必须留在视口内——这才是「不乱跳」；像素级回到点击点只是锦上添花
    [`每次点击后目标源码行都在视口内（0 ≤ top < 600）: ${inView}`, inView],
    [`点击锚定精确到亚像素（最大偏差 ${a.maxGap}px，应 < 8）`, a.maxGap < 8],
    [`点击锚点已消费、无残留（残留会污染后续光标移动导致乱跳）: ${a.residualClean}`, a.residualClean],
  ];
  for (const [label, ok] of checks3) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- 场景 4：虚拟模式滚动锚定 ----------
  await page.evaluate(() => window.__runScrollAnchor());
  const sa = await page.evaluate(() => window.__RESULT5);
  console.log('\n=== 场景 4：虚拟模式滚动锚定（遮罩更新不冲走视口内容）===');
  console.log('  漂移样本: ' + JSON.stringify(sa.drifts));
  const checks4 = [
    [`遮罩更新前后视口顶行位置不漂移（最大 ${sa.maxDrift}px，应 < 20）`, sa.maxDrift < 20],
  ];
  for (const [label, ok] of checks4) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  if (errors.length) {
    console.log('\n页面错误:');
    for (const e of errors) console.log('  ' + e);
    fail++;
  }
  console.log(fail === 0 ? '\n全部一致 ✓' : `\n${fail} 项不一致 ✗`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  await browser.close();
}
