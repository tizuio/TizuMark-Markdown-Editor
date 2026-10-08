// 无头浏览器对比测试：阅读模式 vs 所见即所得（真实 Chromium + 真实 CM5 + 真实渲染管线）。
// 用法：node scripts/wysiwyg-browser-check.mjs
// 依赖：playwright（全局 npm 包）+ 项目根下 _wysiwyg_compare.html harness。
// 结果非 0 退出码 = 存在不一致。
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// playwright 解析：按序尝试 环境变量 → 本地依赖 → 各用户全局 npm 目录（跨设备可移植）。
// 找不到包但找到 ms-playwright 浏览器缓存时，可退到 playwright-core（若可用）。
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright'),
    'C:/Users/admin/AppData/Roaming/npm/node_modules/playwright',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* 试下一个 */ }
  }
  throw new Error('未找到 playwright：npm i -g playwright（或设 PLAYWRIGHT_MODULE 指向包目录）');
}
const pw = loadPlaywright();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const url = pathToFileURL(path.join(root, '_wysiwyg_compare.html')).href;

// 浏览器可执行文件：优先 playwright 自带；否则扫 ms-playwright 缓存（本机 chromium-1217）
function findChromium() {
  const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (fs.existsSync(cacheRoot)) {
    for (const dir of fs.readdirSync(cacheRoot).filter(d => d.startsWith('chromium-')).sort().reverse()) {
      const exe = path.join(cacheRoot, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}
// 启动：优先 playwright 自带浏览器；版本与本机 ms-playwright 缓存不匹配时退回缓存可执行文件
let browser;
try {
  browser = await pw.chromium.launch({ headless: true });
} catch (e) {
  const exe = findChromium();
  if (!exe) throw e;
  browser = await pw.chromium.launch({ headless: true, executablePath: exe });
}
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
    // ---- 显示效果与阅读模式完全一致（2026-10-08 需求）----
    [`所见即所得下编辑器行号已隐藏: ${r.gutterHidden}`, r.gutterHidden === true],
    [`遮罩字号与阅读模式一致: ${r.fontSizeParity}`, r.fontSizeParity === true],
    [`遮罩行高与阅读模式一致: ${r.lineHeightParity}`, r.lineHeightParity === true],
    [`遮罩字体族与阅读模式一致: ${r.fontFamilyParity}`, r.fontFamilyParity === true],
    [`遮罩无块级底色（与阅读模式同白底）: ${r.bgTransparent}`, r.bgTransparent === true],
    [`水平边距与阅读模式一致${r.paddingParity ? `（遮罩 ${r.paddingParity.mask}px / 阅读 ${r.paddingParity.reading}px）` : ''}: ${!!r.paddingParity && r.paddingParity.equal}`,
      !!r.paddingParity && r.paddingParity.equal === true],
    [`遮罩内 emoji 短码已还原: ${r.emojiRendered}`, r.emojiRendered === true],
    [`遮罩内缩写已还原为 <abbr>: ${r.abbrRendered}`, r.abbrRendered === true],
    [`遮罩内标题已生成锚点 id: ${r.headingIdSet}`, r.headingIdSet === true],
    [`遮罩内 details 已展开: ${r.detailsOpened}`, r.detailsOpened === true],
    [`遮罩内代码块有复制按钮: ${r.copyBtnPresent}`, r.copyBtnPresent === true],
    [`多行展示公式（含 setext 触发行 =）保持为完整单块: ${r.mathBlockIntact}`, r.mathBlockIntact === true],
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

  // ---------- 场景 5：整篇视觉比对（截图） ----------
  // 用 demo.md 同时渲染所见即所得与阅读模式，截图留档供肉眼/视觉模型比对。
  let demoText = null;
  try {
    demoText = fs.readFileSync(path.join(root, 'demo.md'), 'utf8');
  } catch (_) { demoText = null; }
  if (demoText) {
    await page.evaluate((t) => window.__runVisual(t), demoText);
    await new Promise(r => setTimeout(r, 1500)); // 等图片/布局稳定
    // ⚠️ 截图前把视口撑到整页高度（1280×1200 = 两个 600px 容器）：headless 下
    // fullPage 的 captureBeyondViewport 不绘制原 720px 视口以下的 overflow 区域
    //（阅读区 h1 下方整片空白，2026-10-09 截图诊断确认），改普通截图即完整
    await page.setViewportSize({ width: 1280, height: 1200 });
    await new Promise(r => setTimeout(r, 300)); // 等视口变化后的重排落定
    const shot = path.join(root, 'screenshots', 'wysiwyg-vs-reading.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot });
    console.log('\n=== 场景 5：整篇视觉比对（截图） ===');
    console.log('  截图: ' + path.relative(root, shot));
  }

  // ---------- 场景 6：全量模式快速滚动（≤10000 行：全量预渲染 + 全量视图驻留） ----------
  // 用户主诉：快速滚动闪源码 / 落点漂移。全量模式下所有行恒渲染 + 恒实测高度，
  // 任意位置首跳必须精确落位（≤1px），refresh 后几何自愈。
  await page.evaluate(() => window.__runFullFast(750));
  const ff = await page.evaluate(() => window.__RESULT6);
  console.log('\n=== 场景 6：全量模式快速滚动（' + ff.lineCount + ' 行） ===');
  console.log(`全量重建耗时: ${ff.renderMs}ms  视口驻留 margin: ${ff.margin}  遮罩: ${ff.maskCount}/${ff.blockCount} 块`);
  console.log('  首跳误差: ' + JSON.stringify(ff.jumps) + '  refresh 后误差: ' + ff.errAfterRefresh + 'px');
  const checks6 = [
    [`全量模式已启用（行数 ≤ 10000）: ${ff.full}`, ff.full === true],
    [`全量视图驻留（viewportMargin ≥ 行数 ${ff.lineCount}）: ${ff.margin}`, ff.margin >= ff.lineCount],
    [`遮罩全量挂载（活动块除外）: ${ff.maskCount} === ${ff.blockCount} - 1`, ff.maskCount === ff.blockCount - 1],
    [`滚动/跳转不增不删遮罩（全量模式无按需挂撤）: ${ff.maskCountAfter} === ${ff.maskCount}`, ff.maskCountAfter === ff.maskCount],
    [`任意位置首跳落点误差 ≤ 1px（最大 ${ff.maxJumpErr}px，几何自愈）`, ff.maxJumpErr <= 1],
    [`cm.refresh() 后几何自愈（落点误差 ${ff.errAfterRefresh}px ≤ 1）`, ff.errAfterRefresh <= 1],
  ];
  for (const [label, ok] of checks6) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- 场景 7：按钮点击预渲染流程（后台预计算 → 完成后切视图 → 消费块表） ----------
  await page.evaluate(() => window.__runPreRenderFlow());
  const pf = await page.evaluate(() => window.__RESULT7);
  console.log('\n=== 场景 7：按钮点击预渲染流程（时序验证） ===');
  const checks7 = [
    [`预渲染已启动（行数 ≤ 上限）: ${pf.started}`, pf.started === true],
    [`预渲染已完成、状态复位: ${pf.preRenderingDone}`, pf.preRenderingDone === true],
    [`完成后视图已切换到所见即所得: ${pf.mode}`, pf.mode === 'wysiwyg'],
    [`全量模式 + 视口驻留（margin ${pf.margin} ≥ 行数 ${pf.lineCount}）: ${pf.full}`, pf.full === true && pf.margin >= pf.lineCount],
    [`预渲染块表被 50ms 计时器消费（遮罩 ${pf.maskCount}/${pf.blocks}，活动块除外）: ${pf.masksConsumed}`, pf.masksConsumed === true],
  ];
  for (const [label, ok] of checks7) {
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
