/**
 * 无头浏览器回归测试：大纲点击跳转的真实滚动定位
 *
 * 为什么用真实浏览器（而非 jsdom）：
 *   test/outline.test.cjs 只测 extractHeadings / buildOutlineTree / renderOutlineHtml
 *   这些【纯函数】（标题抽取、层级树、HTML 生成）——逻辑层，jsdom 完全够。
 *   但它**没有**测「点击大纲项 → 编辑器/预览滚到对应标题的真实像素位置」这一端到端行为，
 *   因为这依赖真实布局：标题在预览里的 offsetTop、编辑器里该行的 heightAtLine 都是
 *   真实排版引擎算出来的，jsdom 全为 0，无法验证「跳转后左右精准对齐到同一标题」。
 *   本测试用系统 Chrome 验证：点击大纲中间项，编辑器与预览都滚到该标题真实位置。
 *
 * 运行：由 scripts/run-tests.cjs 的 browser/ 分支自动拉起 dev-server(1420) + NODE_PATH 后执行。
 *   （也可手动：NODE_PATH=<managed node_modules> node test/browser/outline-jump.test.cjs，需 dev-server 在 1420）
 */
'use strict';
const fs = require('fs');

const CHROME_PATH = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:1420/';

// 浏览器测试是本地范式：依赖系统 Chrome + 本机 node_modules 中的 puppeteer-core。
// CI（ubuntu）或缺少该环境的机器上直接运行时应优雅跳过，而非崩溃。
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

// 足够长的多级标题文档，让标题能分布到不同滚动位置
function buildDemo() {
  const lines = [];
  lines.push('# TizuMark 大纲跳转回归测试');
  lines.push('');
  lines.push('这是文档简介，用于占位并制造顶部空白。');
  lines.push('');
  for (let i = 1; i <= 8; i++) {
    lines.push(`## 第 ${i} 章 示例内容`);
    lines.push('');
    lines.push('这是一段示例正文，用于占位。Markdown 预览会把每一行映射到对应的像素位置，');
    lines.push('滚动同步正是依赖逐行密集插值做到左右精准匹配。');
    lines.push('');
    lines.push('- 列表项 A');
    lines.push('- 列表项 B');
    lines.push('');
    lines.push('> 引用块：验证引用内行也能正确参与位置映射。');
    lines.push('');
    for (let j = 1; j <= 3; j++) {
      lines.push(`### ${i}.${j} 小节`);
      lines.push('');
      lines.push('小节正文，继续占位，确保文档足够长，标题能滚到明显非顶部的位置。');
      lines.push('');
    }
  }
  // 含行内公式的标题（大纲回归）：既验证大纲标签内的 KaTeX 渲染，
  // 也验证含公式标题的大纲点击跳转（占位注释曾导致预览侧 heading id 缺公式文本、跳转落空）。
  lines.push('## 公式标题 $E=mc^2$ 结尾');
  lines.push('');
  lines.push('这一章标题含行内公式，用于大纲公式渲染与跳转回归。');
  lines.push('');
  return lines.join('\n');
}
const DEMO = buildDemo();

// 在页面任何脚本运行前注入：预设 EULA 已接受 + 完整的 Tauri IPC mock
const TauriMock = `
(function(){
  try { localStorage.setItem('tizumark-eula-accepted','true'); } catch(e){}
  window.__TAURI__ = {
    core: {
      invoke: async function(cmd, args){
        args = args || {};
        switch(cmd){
          case 'read_bundled_file':
            if (args.filename === 'demo.md') return { content: window.__DEMO__ };
            if (args.filename === 'guide.md') return { content: '# 使用说明\\n\\n' };
            return { content: '' };
          case 'read_file': return '';
          case 'app_data_dir': return 'C:\\\\fake\\\\appdata';
          case 'resource_dir': return 'C:\\\\fake\\\\resource';
          case 'list_dir': return [];
          case 'is_directory': return false;
          case 'file_meta': return { size:0, isDir:false, modified:0 };
          case 'write_file': case 'write_binary_file': case 'ensure_dir':
          case 'save_image_to_assets': case 'watch_folder': case 'stop_watch':
          case 'set_window_behavior': case 'generate_toc': case 'get_cli_args':
          case 'quit_app': case 'open_devtools': return null;
          case 'search_in_files': return [];
          case 'get_version': return '0.0.0-test';
          case 'plugin:dialog|open': case 'plugin:dialog|save':
          case 'plugin:webview|internal_toggle_devtools': return null;
          default: return null;
        }
      },
      Channel: class { constructor(){} }
    },
    event: { listen: function(){ return Promise.resolve(function(){}); } },
    window: { getCurrentWindow: function(){ return { unminimize(){}, show(){}, setFocus(){}, close(){} }; } },
    app: { getVersion: function(){ return Promise.resolve('0.0.0-test'); } },
    path: { resourceDir: function(){ return Promise.resolve('C:\\\\fake\\\\resource'); } },
    shell: { open: function(){ return Promise.resolve(); } },
    webview: {}
  };
})();
`;

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
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      if (/favicon\.ico|404/.test(t)) return;
      pageErrors.push('console.error: ' + t);
    }
  });

  await page.evaluateOnNewDocument((demo) => { window.__DEMO__ = demo; }, DEMO);
  await page.evaluateOnNewDocument(TauriMock);

  console.log('\n[启动] 打开 ' + URL + ' 并等待 app 初始化…');
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

  try {
    await page.waitForFunction(
      "window.editor && window.editor.cm && window.editor.preview && document.querySelectorAll('#preview [data-source-line]').length > 5",
      { timeout: 20000 }
    );
  } catch (e) {
    console.log('  ❌ FAIL  应用未在预期时间内初始化（预览未渲染）');
    console.log('  页面错误:', pageErrors.slice(0, 10).join(' | ') || '(无)');
    await browser.close();
    process.exit(1);
  }

  console.log('  ✅ PASS  应用启动且预览已渲染（初始 demo.md）');
  bump(true);

  // 切到「编辑+预览」双栏模式（默认 viewMode='preview' 会隐藏编辑器面板，宽度塌成 0）
  await page.evaluate(() => { window.editor.setViewMode('edit'); });
  await page.waitForFunction(
    "(() => { const e = document.querySelector('.CodeMirror'); if (!e) return false; return e.getBoundingClientRect().width > 50; })()",
    { timeout: 8000 }
  );
  const edLayout = await page.evaluate(() => {
    const e = document.querySelector('.CodeMirror');
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  bump(assert('切到双栏后编辑器面板有可见宽度', edLayout.w > 50 && edLayout.h > 50,
    `${edLayout.w}×${edLayout.h}`));

  // 等待大纲渲染（app 在预览渲染后应生成 .outline-item，含 data-line 属性）
  let outlineReady = true;
  try {
    await page.waitForFunction(
      "document.querySelectorAll('.outline-item').length > 3",
      { timeout: 8000 }
    );
  } catch (e) {
    outlineReady = false;
  }
  if (!outlineReady) {
    console.log('  ⚠️  大纲项未渲染（.outline-item 缺失），尝试诊断结构');
    const diag = await page.evaluate(() => {
      const ids = ['outline', 'outline-panel', 'outline-container', 'toc'];
      const found = ids.filter((id) => document.getElementById(id)).concat(
        [...document.querySelectorAll('[class*="outline"]')].slice(0, 5).map((e) => e.className)
      );
      return { found, hasEditor: !!window.editor, hasRenderOutline: typeof (window.editor && window.editor.renderOutline) };
    });
    console.log('  诊断:', JSON.stringify(diag));
    bump(assert('大纲项渲染（.outline-item > 3）', false, '未渲染'));
    await browser.close();
    console.log(`\n========== 结果：✅ ${pass} 通过 / ❌ ${fail} 失败 ==========`);
    process.exit(fail === 0 ? 0 : 1);
  }
  bump(true); // 大纲渲染通过

  // 点击大纲中间项，验证编辑器/预览滚到对应标题真实位置
  console.log('\n[测试] 点击大纲中间项 → 真实滚动定位');
  const t = await page.evaluate(async () => {
    const ed = window.editor;
    const items = [...document.querySelectorAll('.outline-item')];
    // 选一个中间项（非首项，确保有滚动空间）
    const k = Math.floor(items.length * 0.6);
    const item = items[k];
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const itemText = norm(item.textContent);
    const line = parseInt(item.dataset.line, 10);
    item.click();
    await new Promise((r) => setTimeout(r, 400)); // 等滚动同步抑制窗口(120ms) + 落定
    const pv = ed.preview;
    const pvRect = pv.getBoundingClientRect();
    // 在预览里用【标题文本】匹配定位目标标题（大纲 data-line 与预览 data-source-line 行号体系不同，不能反查）
    const headingEls = [...pv.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const key = itemText.slice(0, 10);
    const headingEl = headingEls.find((h) => {
      const ht = norm(h.textContent);
      return ht.includes(key) || key.includes(ht.slice(0, 10));
    });
    // 期望：预览把该标题顶部对齐（与 app 的 top 公式一致：offsetInContent，余量 0）
    let expectedPv = null, headingOffset = null;
    if (headingEl) {
      const hRect = headingEl.getBoundingClientRect();
      headingOffset = hRect.top - pvRect.top + pv.scrollTop; // 标题在预览内容中的真实偏移
      expectedPv = headingOffset;
    }
    const actualPv = pv.scrollTop;
    const actualEd = ed.cm.getScrollInfo().top;
    // 编辑器：标题行应在可视区内（setCursor + scrollIntoView 后）
    let edHeadingVisible = false, hLineTop = null, hLineBot = null;
    if (!isNaN(line)) {
      hLineTop = ed.cm.heightAtLine(line, 'local');
      hLineBot = ed.cm.heightAtLine(line + 1, 'local');
      const info = ed.cm.getScrollInfo();
      edHeadingVisible = hLineTop >= info.top - 5 && hLineBot <= info.top + info.clientHeight + 5;
    }
    const id = item.dataset.id;
    const targetExists = !!(id && pv.querySelector('#' + (window.CSS ? CSS.escape(id) : id)));
    return {
      k, itemText, outlineCount: items.length, line,
      expectedPv, actualPv, actualEd, headingOffset, edHeadingVisible, hLineTop,
      targetExists, cursorLine: ed.cm.getCursor().line,
    };
  });

  console.log(`  点击大纲第 ${t.k} 项「${t.itemText}」，共 ${t.outlineCount} 项 (data-line=${t.line})`);
  console.log(`  预览 scrollTop=${t.actualPv|0}, 标题顶部期望 scrollTop=${t.expectedPv != null ? t.expectedPv|0 : 'n/a'}`);
  console.log(`  编辑器 top=${t.actualEd|0}, 标题行像素 ${t.hLineTop != null ? t.hLineTop|0 : 'n/a'}, 光标行=${t.cursorLine}`);
  console.log(`  [诊断] 预览#id存在=${t.targetExists}`);

  bump(assert('点击大纲项后预览发生滚动', t.actualPv > 5, `scrollTop=${t.actualPv|0}`));
  bump(assert('预览滚到对应标题顶部位置（±30px）',
    t.expectedPv != null && Math.abs(t.actualPv - t.expectedPv) <= 30,
    `预览scrollTop=${t.actualPv|0}, 期望≈${t.expectedPv != null ? t.expectedPv|0 : 'n/a'}`));
  bump(assert('编辑器滚动到标题行可见（不在顶部卡死）',
    t.edHeadingVisible,
    `光标行=${t.cursorLine}, 标题行像素=${t.hLineTop != null ? t.hLineTop|0 : 'n/a'}, 编辑器top=${t.actualEd|0}`));
  bump(assert('编辑区光标跳到标题行',
    t.cursorLine === t.line, `光标行=${t.cursorLine}, 期望=${t.line}`));

  // 含行内公式标题的大纲回归：标签内 KaTeX 渲染 + 点击跳转（id 含公式文本，曾因占位注释丢失而落空）。
  // 不依赖启动时加载的文档（demo 注入可能被应用启动流程绕过），直接 setValue 写入公式文档，
  // 等 300ms 防抖 + 大纲重建后再断言。
  console.log('\n[测试] 含行内公式标题：大纲 KaTeX 渲染 + 点击跳转');
  const m = await page.evaluate(async () => {
    const ed = window.editor;
    // 标题后接足量填充段落，保证预览内容高于视口（短文档无可滚动空间，scrollTop 恒 0）
    const filler = Array.from({ length: 60 }, (_, i) => `填充段落 ${i + 1}，确保预览可滚动。`).join('\n\n');
    ed.cm.setValue('# 公式文档\n\n## 公式标题 $E=mc^2$ 结尾\n\n' + filler + '\n');
    await new Promise((r) => setTimeout(r, 700));
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const item = [...document.querySelectorAll('.outline-item')]
      .find((el) => norm(el.textContent).includes('公式标题'));
    if (!item) return { found: false };
    const label = item.querySelector('.outline-label');
    const hasKatex = !!(label && label.querySelector('.katex'));
    const labelHasRawDollar = !!(label && label.textContent.includes('$'));
    const id = item.dataset.id;
    const line = parseInt(item.dataset.line, 10);
    item.click();
    await new Promise((r) => setTimeout(r, 400));
    const pv = ed.preview;
    const target = id ? pv.querySelector('#' + (window.CSS ? CSS.escape(id) : id)) : null;
    const pvRect = pv.getBoundingClientRect();
    let expectedPv = null;
    if (target) {
      expectedPv = target.getBoundingClientRect().top - pvRect.top + pv.scrollTop;
    }
    // 预览中的公式标题同样应被 KaTeX 渲染（且 id 与大纲一致才能命中 target）
    return {
      found: true, hasKatex, labelHasRawDollar, id, line,
      targetExists: !!target,
      actualPv: pv.scrollTop, expectedPv,
      maxScroll: Math.max(0, pv.scrollHeight - pv.clientHeight),
      cursorLine: ed.cm.getCursor().line,
    };
  });
  if (!m.found) {
    bump(assert('找到含公式的标题大纲项', false, '未找到「公式标题」项'));
  } else {
    console.log(`  大纲项 id="${m.id}" (data-line=${m.line})`);
    bump(assert('大纲标签内公式被 KaTeX 渲染（.katex 存在）', m.hasKatex, `id=${m.id}`));
    bump(assert('大纲标签不再显示原始 $ 定界符', !m.labelHasRawDollar, `label 含 $: ${m.labelHasRawDollar}`));
    bump(assert('预览中存在同 id 标题（大纲点击可命中）', m.targetExists, `id=${m.id}`));
    bump(assert('点击后预览滚到公式标题顶部（±30px，按最大可滚动量钳制）',
      m.expectedPv != null && Math.abs(m.actualPv - Math.min(m.expectedPv, m.maxScroll)) <= 30,
      `scrollTop=${m.actualPv|0}, 期望≈${m.expectedPv != null ? Math.min(m.expectedPv, m.maxScroll)|0 : 'n/a'}, maxScroll=${m.maxScroll|0}`));
    bump(assert('编辑区光标跳到公式标题行', m.cursorLine === m.line, `光标行=${m.cursorLine}, 期望=${m.line}`));
  }

  if (pageErrors.length) {
    console.log('\n[页面运行时错误] ' + pageErrors.slice(0, 8).join(' | '));
  }

  await browser.close();
  console.log(`\n========== 结果：✅ ${pass} 通过 / ❌ ${fail} 失败 ==========`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试运行异常:', e);
  process.exit(2);
});
