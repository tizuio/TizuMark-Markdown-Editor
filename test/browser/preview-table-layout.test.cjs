/**
 * 真实 Chrome 回归：阅读模式表格外框必须贴合可见网格。
 *
 * 为什么必须用浏览器：jsdom 无布局引擎，getBoundingClientRect 全为 0，
 * 量不出「display:block 的 table 外框 100% 宽 / 匿名表格盒按内容收缩」造成的右侧空白。
 * 2026-11-13 用户截图实测：外框 1092px、可见网格 593px、空白 498px。
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

// 窄表：内容宽远小于预览区宽，正是用户截图里出现大片空白的形态
const NARROW = `<table><thead><tr><th>情形</th><th>给付比例</th></tr></thead><tbody>
<tr><td>实测最长赔付情形描述文字，用于撑开第一列</td><td>100%</td></tr>
<tr><td>第二种情形，较短</td><td>60%</td></tr>
<tr><td>第三种情形</td><td>100%</td></tr>
<tr><td>第四种情形</td><td>100%</td></tr></tbody></table>`;

// 宽表：max-content 超过 100%，必须仍可横向滚动（不得撑破预览区 / 不得丢内容）
const WIDE = `<table><thead><tr>${Array.from({ length: 8 }, (_, i) => `<th>列标题${i + 1}</th>`).join('')}</tr></thead><tbody>
<tr>${Array.from({ length: 8 }, () => '<td>ABCDEFGHIJKLMNOPQRSTUVWXYZ-这一格内容很长</td>').join('')}</tr>
<tr>${Array.from({ length: 8 }, (_, i) => `<td>值 ${i + 1}</td>`).join('')}</tr></tbody></table>`;

const WRAP = `<div class="wysiwyg-table-wrap"><table><thead><tr><th>情形</th><th>给付比例</th></tr></thead><tbody>
<tr><td>实测最长赔付情形描述文字，用于撑开第一列</td><td>100%</td></tr>
<tr><td>较短情形</td><td>60%</td></tr></tbody></table></div>`;

function assert(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ PASS  ${name}` + (detail ? `  (${detail})` : ''));
    return true;
  }
  console.log(`  ❌ FAIL  ${name}` + (detail ? `  (${detail})` : ''));
  return false;
}

(async () => {
  let pass = 0, fail = 0;
  const bump = (ok) => { ok ? pass++ : fail++; };

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH, headless: true, protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluateOnNewDocument(TauriMock);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction('window.editor && window.editor.cm && window.editor.preview', { timeout: 20000 });
  bump(assert('应用启动且预览容器就绪', true));

  const setContent = (html) => page.evaluate((h) => {
    const ed = window.editor;
    ed.viewMode = 'preview';
    document.getElementById('preview').innerHTML = h;
  }, html);

  const metrics = () => page.evaluate(() => {
    const p = document.getElementById('preview');
    const t = p.querySelector('table');
    const cells = [...t.querySelectorAll('tbody tr:first-child td')];
    const cs = getComputedStyle(t);
    const box = t.getBoundingClientRect();
    const gridLeft = cells[0].getBoundingClientRect().left;
    const gridRight = cells[cells.length - 1].getBoundingClientRect().right;
    const wrap = p.querySelector('.wysiwyg-table-wrap');
    return {
      previewW: Math.round(p.getBoundingClientRect().width),
      tableW: Math.round(box.width),
      gridW: Math.round(gridRight - gridLeft),
      blank: Math.round(box.right - gridRight),
      clientW: t.clientWidth,
      scrollW: t.scrollWidth,
      display: cs.display,
      overflowX: cs.overflowX,
      wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : null,
    };
  });

  // ① 窄表：外框贴合网格，右侧空白归零
  await setContent(NARROW);
  await new Promise(r => setTimeout(r, 180));
  const narrow = await metrics();
  bump(assert('窄表：表格外框贴合可见网格（右侧空白 ≤ 2px）', narrow.blank <= 2,
    `外框 ${narrow.tableW}px / 网格 ${narrow.gridW}px / 空白 ${narrow.blank}px`));
  bump(assert('窄表：仍按内容宽度收缩，未拉满预览区', narrow.tableW < narrow.previewW * 0.9,
    `表 ${narrow.tableW}px < 预览区 ${narrow.previewW}px`));
  bump(assert('窄表：display:block + overflow-x:auto 保持（宽表滚动前提）',
    narrow.display === 'block' && narrow.overflowX === 'auto',
    `display=${narrow.display}, overflow-x=${narrow.overflowX}`));

  // ② 宽表：max-content 超过可用宽度时仍可横向滚动
  await setContent(WIDE);
  await new Promise(r => setTimeout(r, 180));
  const wide = await metrics();
  bump(assert('宽表：超出预览区时仍可横向滚动（不撑破、不丢内容）',
    wide.scrollW > wide.clientW + 2 && wide.tableW <= wide.previewW + 2,
    `scrollWidth ${wide.scrollW} / clientWidth ${wide.clientW} / 外框 ${wide.tableW}px`));

  // ③ WYSIWYG 包裹盒：表盒 = 网格宽，表格工具定位口径不变
  await setContent(WRAP);
  await new Promise(r => setTimeout(r, 180));
  const wrapped = await metrics();
  bump(assert('WYSIWYG wrap：表盒仍等于网格宽（工具条定位不回归）',
    wrapped.blank <= 2 && wrapped.wrapW === wrapped.tableW,
    `wrap ${wrapped.wrapW}px / 表盒 ${wrapped.tableW}px / 空白 ${wrapped.blank}px`));

  await browser.close();
  console.log(`\n========== 结果：✅ ${pass} 通过 / ❌ ${fail} 失败 ==========`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('浏览器回归异常：', e);
  process.exit(1);
});
