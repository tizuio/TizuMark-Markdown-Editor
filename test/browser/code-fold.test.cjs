/**
 * 真实 Chrome 回归：源码模式（viewMode='edit'）区块折叠的挂载、点击、批量与模式联动。
 *
 * 为什么必须用浏览器：jsdom 无 CodeMirror 排版/token 流，getTokenTypeAt 恒为 null、
 * foldgutter 依赖 viewportChange 与真实 gutter DOM，无法验证「点箭头真的把行折起来」。
 *
 * 运行：scripts/run-tests.cjs 的 browser/ 分支自动拉起 dev-server(1420) + NODE_PATH。
 * 缺 Chrome / puppeteer-core 时按本地范式优雅 SKIP。
 */
'use strict';
const fs = require('fs');

const CHROME_PATH = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:1420/';

try {
  require('puppeteer-core');
} catch (_) {
  console.log('SKIP: puppeteer-core 不可用（浏览器回归测试需系统 Chrome + puppeteer-core，属本地范式）。');
  process.exit(0);
}
if (!fs.existsSync(CHROME_PATH)) {
  console.log('SKIP: 未找到系统 Chrome：' + CHROME_PATH);
  process.exit(0);
}
const puppeteer = require('puppeteer-core');

const TauriMock = `
(function(){
  try { localStorage.setItem('tizumark-eula-accepted','true'); } catch(e){}
  window.__TAURI__ = { core: { invoke: async function(cmd){
      if (cmd === 'read_bundled_file') return { content: '# demo\\n' };
      if (cmd === 'get_version') return '0.0.0-test';
      if (String(cmd).includes('updater')) return null;
      return null; }, Channel: class {} },
    event: { listen: function(){ return Promise.resolve(function(){}); } },
    window: { getCurrentWindow: function(){ return { unminimize(){}, show(){}, setFocus(){}, close(){} }; } },
    app: { getVersion: function(){ return Promise.resolve('0.0.0-test'); } },
    path: { resourceDir: function(){ return Promise.resolve('C:\\\\fake'); } },
    shell: { open: function(){ return Promise.resolve(); } }, webview: {} };
})();
`;

const MD = [
  '# 第一章',
  '章节正文 A',
  '章节正文 B',
  '## 1.1 小节',
  '小节正文',
  '',
  '# 第二章',
  '```js',
  'const a = 1;',
  'const b = 2;',
  '```',
  '',
  '段落第 1 行',
  '段落第 2 行',
  '段落第 3 行',
  '段落第 4 行',
  '段落第 5 行',
  '段落第 6 行',
  '',
  '结尾',
].join('\n');

function assert(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ PASS  ${name}` + (detail ? `  (${detail})` : ''));
    return true;
  }
  console.log(`  ❌ FAIL  ${name}` + (detail ? `  (${detail})` : ''));
  return false;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let pass = 0, fail = 0;
  const bump = (ok) => { ok ? pass++ : fail++; };

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH, headless: true, protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.evaluateOnNewDocument(TauriMock);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction('window.editor && window.editor.cm && window.editor.preview', { timeout: 20000 });

  const state = () => page.evaluate(() => {
    const cm = window.editor.cm;
    return {
      viewMode: window.editor.viewMode,
      hasFoldCode: typeof cm.foldCode === 'function',
      foldGutter: !!cm.getOption('foldGutter'),
      gutters: (cm.getOption('gutters') || []).slice(),
      openMarkers: document.querySelectorAll('.CodeMirror-foldgutter-open').length,
      foldedMarkers: document.querySelectorAll('.CodeMirror-foldgutter-folded').length,
      foldMarks: cm.getAllMarks().filter(m => m.__isFold).length,
      foldWidgets: document.querySelectorAll('.CodeMirror-foldmarker').length,
      headerToken: String(cm.getTokenTypeAt({ line: 0, ch: 0 })),
    };
  });

  bump(assert('fold addon 已加载（cm.foldCode 可用）', (await state()).hasFoldCode));

  // 默认启动是阅读模式：不应挂折叠槽
  const initial = await state();
  bump(assert('阅读模式不挂折叠槽', initial.foldGutter === false && initial.openMarkers === 0,
    `viewMode=${initial.viewMode}, gutter=${initial.foldGutter}`));

  // 切到源码模式 + 置入含标题/围栏/长段落的文档
  await page.evaluate((md) => {
    const ed = window.editor;
    ed.setViewMode('edit');
    ed.cm.setValue(md);
    ed.settings.codeFolding = true;
    ed._syncCodeFolding();
  }, MD);
  await sleep(900); // foldgutter 的 changes 事件有 600ms 防抖
  const inEdit = await state();
  bump(assert('源码模式挂上折叠槽与折叠箭头', inEdit.foldGutter && inEdit.openMarkers >= 2,
    `gutter=${inEdit.foldGutter}, 箭头=${inEdit.openMarkers}, token=${inEdit.headerToken}`));
  bump(assert('gfm mode 把 # 行标成 header（折叠范围判定前提）',
    /header/.test(inEdit.headerToken), `token=${inEdit.headerToken}`));

  // 点击第一个折叠箭头：应产生 __isFold mark + 折叠占位符
  const firstMarker = await page.$('.CodeMirror-foldgutter-open');
  if (firstMarker) await firstMarker.click();
  await sleep(250);
  const folded = await state();
  bump(assert('点击 gutter 箭头真的把区块折起来', folded.foldMarks >= 1 && folded.foldWidgets >= 1,
    `foldMarks=${folded.foldMarks}, widgets=${folded.foldWidgets}`));
  bump(assert('折叠后箭头切换为已折叠状态', folded.foldedMarkers >= 1,
    `foldedMarkers=${folded.foldedMarkers}`));

  // 折叠态视觉：主题色胶囊 + 行数 + chevron，整行淡底与左侧 accent 竖条
  const visual = await page.evaluate(() => {
    const el = document.querySelector('.CodeMirror-foldmarker');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const lineEl = el.closest('.CodeMirror-code > div');
    const lineCs = lineEl ? getComputedStyle(lineEl) : null;
    const gutter = document.querySelector('.CodeMirror-foldgutter-open')
      || document.querySelector('.CodeMirror-foldgutter-folded');
    const after = gutter ? getComputedStyle(gutter, '::after') : null;
    const plain = document.querySelector('.CodeMirror-line');
    return {
      text: el.textContent.trim(),
      hasChevron: !!el.querySelector('.tm-fold-chevron'),
      borderWidth: cs.borderTopWidth,
      borderColor: cs.borderTopColor,
      bg: cs.backgroundColor,
      color: cs.color,
      weight: cs.fontWeight,
      plainColor: plain ? getComputedStyle(plain).color : '',
      lineBg: lineCs ? lineCs.backgroundColor : '',
      lineShadow: lineCs ? lineCs.boxShadow : '',
      mask: after ? (after.maskImage || after.webkitMaskImage || '') : '',
      content: after ? after.content : '',
      transform: after ? after.transform : '',
    };
  });
  bump(assert('折叠占位是主题色醒目胶囊（描边+底色+加粗+chevron+行数）',
    !!visual && visual.hasChevron && /\d/.test(visual.text)
      && visual.borderWidth === '1px' && visual.bg !== 'rgba(0, 0, 0, 0)'
      && Number(visual.weight) >= 600 && visual.color !== visual.plainColor,
    visual ? `text=${visual.text}, bg=${visual.bg}, border=${visual.borderWidth} ${visual.borderColor}` : 'no widget'));
  bump(assert('折叠所在行有淡底与左侧主题色竖条',
    !!visual && visual.lineBg !== 'rgba(0, 0, 0, 0)' && /inset/.test(visual.lineShadow),
    visual ? `lineBg=${visual.lineBg}, shadow=${visual.lineShadow}` : 'no line'));
  bump(assert('折叠槽改用 chevron mask 并旋转展开方向，不再是字符小三角',
    !!visual && /svg\+xml/.test(visual.mask) && !/[▾▸]/.test(visual.content)
      && visual.transform !== 'none',
    visual ? `mask=${visual.mask.slice(0, 70)}, content=${visual.content}, transform=${visual.transform}` : 'no gutter'));

  // 大纲展开折叠符号：与文件目录同款线性 chevron，折叠态指向右
  const outlineVisual = await page.evaluate(() => {
    const ed = window.editor;
    if (typeof ed.updateOutline === 'function') ed.updateOutline();
    const svg = document.querySelector('#outline-content .outline-toggle svg');
    if (!svg) return null;
    const p = svg.querySelector('path');
    return {
      path: p ? p.getAttribute('d') : '',
      fill: svg.getAttribute('fill'),
      transform: getComputedStyle(svg).transform,
    };
  });
  bump(assert('大纲符号是文件目录同款线性 chevron（无实心小三角）',
    !!outlineVisual && outlineVisual.path === 'm9 18 6-6-6-6'
      && outlineVisual.fill === 'none' && outlineVisual.transform !== 'none',
    outlineVisual ? `path=${outlineVisual.path}, fill=${outlineVisual.fill}, transform=${outlineVisual.transform}` : 'no outline'));

  await page.evaluate(() => {
    const tg = document.querySelector('#outline-content .outline-toggle:not(.outline-toggle--hidden)');
    if (tg) tg.click();
  });
  await sleep(240);
  const outlineFoldedTransform = await page.evaluate(() => {
    const svg = document.querySelector('#outline-content .outline-toggle.collapsed svg');
    return svg ? getComputedStyle(svg).transform : null;
  });
  bump(assert('大纲折叠态箭头指向右（rotate 0），与文件目录折叠态一致',
    outlineFoldedTransform === 'matrix(1, 0, 0, 1, 0, 0)' || outlineFoldedTransform === 'none',
    `transform=${outlineFoldedTransform}`));

  // 再点一次展开（此时该行是 folded 箭头）
  const foldedMarker = await page.$('.CodeMirror-foldgutter-folded');
  if (foldedMarker) await foldedMarker.click();
  await sleep(250);
  bump(assert('再点已折叠箭头可展开', (await state()).foldMarks === 0));

  // 批量折叠 / 展开
  await page.evaluate(() => window.editor.foldAllBlocks());
  await sleep(250);
  const all = await state();
  bump(assert('折叠全部产生多个不重叠的折叠块', all.foldMarks >= 2, `foldMarks=${all.foldMarks}`));
  await page.evaluate(() => window.editor.unfoldAllBlocks());
  await sleep(250);
  bump(assert('展开全部清掉所有折叠 mark', (await state()).foldMarks === 0));

  // 自定义 widget 不能破坏 addon 的点击展开（makeWidget 会 cloneNode，事件绑在克隆体上）
  await page.evaluate(() => {
    const ed = window.editor;
    ed.cm.setCursor({ line: 0, ch: 0 });
    ed.toggleFoldAtCursor();
  });
  await sleep(220);
  const oneFold = await state();
  bump(assert('单块折叠用于胶囊点击验证', oneFold.foldMarks === 1, `foldMarks=${oneFold.foldMarks}`));
  const oneWidget = await page.$('.CodeMirror-foldmarker');
  if (oneWidget) await oneWidget.click();
  await sleep(220);
  bump(assert('点击折叠胶囊可展开（自定义 widget 不破坏 addon 事件）',
    (await state()).foldMarks === 0));

  // 快捷键：全局派发 + 方括号键按 e.code 归一化（Shift+[ 的 e.key 是花括号）
  await page.evaluate(() => {
    const cm = window.editor.cm;
    cm.focus();
    cm.setCursor({ line: 0, ch: 0 });
  });
  const pressFold = async (code) => {
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press(code);
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
  };
  await pressFold('BracketLeft');
  await sleep(220);
  const kbFold = await state();
  bump(assert('Ctrl+Shift+[ 折叠当前区块（方括号键归一化生效）', kbFold.foldMarks >= 1,
    `foldMarks=${kbFold.foldMarks}`));
  await pressFold('BracketRight');
  await sleep(220);
  bump(assert('Ctrl+Shift+] 展开当前区块，且不会反向折叠', (await state()).foldMarks === 0));

  // 设置关闭 → 折叠槽消失
  await page.evaluate(() => {
    window.editor.settings.codeFolding = false;
    window.editor._syncCodeFolding();
  });
  await sleep(150);
  const off = await state();
  bump(assert('设置关闭后卸掉折叠槽', off.foldGutter === false && off.gutters.indexOf('CodeMirror-foldgutter') === -1,
    `gutters=${off.gutters.join(',')}`));

  // 离开源码模式：必须自动展开所有折叠（防止 WYSIWYG 遮罩定位漂移）
  await page.evaluate(() => {
    const ed = window.editor;
    ed.settings.codeFolding = true;
    ed._syncCodeFolding();
    ed.foldAllBlocks();
    ed.setViewMode('preview');
  });
  await sleep(300);
  const left = await state();
  bump(assert('切回阅读模式自动展开全部并卸槽',
    left.foldMarks === 0 && left.foldGutter === false,
    `foldMarks=${left.foldMarks}, gutter=${left.foldGutter}`));

  bump(assert('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ')));

  await browser.close();
  console.log(`\n========== 结果：✅ ${pass} 通过 / ❌ ${fail} 失败 ==========`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('浏览器回归异常：', e);
  process.exit(1);
});
