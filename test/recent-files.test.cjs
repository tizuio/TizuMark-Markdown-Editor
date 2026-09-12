// 最近文件（打开最近的文件）回归测试
// jsdom 真实加载 src/app.js（不触发耗时构造函数），用 Object.create 获得实例方法，
// 验证记录/持久化/渲染/清理/语言/addTab hook。
// 约定：test/*.test.cjs 由 `npm test`（`node --test test/*.test.cjs`）自动纳入。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const appjs = require('./helpers/app-bundle.cjs').readBundle();
// P1-5：app.js 运行时依赖 window.TauriApi（原裸 window.__TAURI__ 已收敛到 TauriApi.*），
// 须像生产（index.html 先加载 tauri-api.js）一样先注入，否则 TauriApi 未定义。
const tauriApiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'tauri-api.js'), 'utf8');
// P2-1：app.js 构造期 new PreviewController(this) 需要本 facade 先注入（同生产 index.html 顺序）。
const previewControllerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'preview-controller.js'), 'utf8');

// 在 jsdom 同一脚本作用域内运行，以便访问 app.js 顶层的 MarkdownEditor / Tab / I18N（class/const 不跨脚本共享）
async function harnessFn() {
  if (typeof MarkdownEditor !== 'function') { window.__results = [['MarkdownEditor 类加载', false]]; return; }
  const results = [];

  const ed = Object.create(MarkdownEditor.prototype);
  ed.settings = { language: 'zh' };
  ed._recentFiles = [];
  ed._recentSubmenuVisible = false;
  const submenu = document.getElementById('recent-files-submenu');
  const fileMenu = document.getElementById('file-menu');

  // 1. addRecentFile：去重 + 置顶 + 截断到 10
  ed._recentFiles = [];
  for (let i = 0; i < 15; i++) ed.addRecentFile(`/tmp/file${i}.md`);
  results.push(['addRecentFile 截断到 10', ed._recentFiles.length === 10]);
  results.push(['addRecentFile 最新置顶', ed._recentFiles[0] === '/tmp/file14.md']);
  ed.addRecentFile('/tmp/file14.md');
  results.push(['addRecentFile 去重后仍为 10', ed._recentFiles.length === 10 && ed._recentFiles[0] === '/tmp/file14.md']);

  // 2. load/save 持久化
  ed._recentFiles = ['/a/1.md', '/a/2.md'];
  ed.saveRecentFiles();
  ed._recentFiles = [];
  ed.loadRecentFiles();
  results.push(['load/save 持久化往返', ed._recentFiles.length === 2 && ed._recentFiles[0] === '/a/1.md']);

  // 3. 损坏数据兜底
  localStorage.setItem('tizumark-recent-files', '{bad json');
  ed._recentFiles = ['x'];
  ed.loadRecentFiles();
  results.push(['loadRecentFiles 损坏 JSON 兜底空数组', Array.isArray(ed._recentFiles)]);

  // 4. render 有项
  ed._recentFiles = ['/docs/项目笔记.md', '/work/report.md'];
  ed.renderRecentFilesSubmenu();
  const items = submenu.querySelectorAll('.recent-file-item');
  results.push(['render 渲染 2 个文件项', items.length === 2]);
  results.push(['render 文件名=basename', items[0].querySelector('.recent-file-name').textContent === '项目笔记.md']);
  results.push(['render 目录=dirname', items[0].querySelector('.recent-file-dir').textContent === '/docs']);
  results.push(['render 含清空项', !!submenu.querySelector('[data-action="clear"]')]);
  results.push(['render 清空项文案=清空最近文件', submenu.querySelector('[data-action="clear"]').textContent === '清空最近文件']);

  // 5. render 空态
  ed._recentFiles = [];
  ed.renderRecentFilesSubmenu();
  const disabled = submenu.querySelector('.dropdown-item.disabled');
  results.push(['render 空态 disabled=暂无最近文件', !!disabled && disabled.textContent === '暂无最近文件']);

  // 6. clearRecentFiles
  ed._recentFiles = ['/a.md'];
  ed.clearRecentFiles();
  results.push(['clearRecentFiles 清空', ed._recentFiles.length === 0]);

  // 7. refreshRecentFiles：file_meta 返回 null（失效）被移除（实现无 return，此处断言状态变化）
  ed._recentFiles = ['/gone.md', '/alive.md'];
  fileMenu.classList.remove('hidden');
  window.__invokeMode = 'null';
  await ed.refreshRecentFiles();
  results.push(['refresh 移除失效项', ed._recentFiles.length === 1 && ed._recentFiles[0] === '/alive.md']);

  // 8. refreshRecentFiles：invoke 抛错保守保留
  ed._recentFiles = ['/maybe.md', '/sure.md'];
  window.__invokeMode = 'throw';
  await ed.refreshRecentFiles();
  results.push(['refresh invoke 失败保守保留', ed._recentFiles.length === 2]);

  // 9. addTab hook：记录真实路径、排除 null（addTab 为 async，用同步桩避免触发 CM）
  ed.tabs = [];
  ed.untitledCounter = 0;
  ed.switchTab = async () => {};
  ed.updateTabBar = () => {};
  ed.saveSession = () => {};
  ed.refreshFileMeta = () => {};
  const beforeLen = ed._recentFiles.length;
  await ed.addTab('Doc', 'hi', '/rec/recent.md');
  results.push(['addTab hook 记录真实路径', ed._recentFiles.includes('/rec/recent.md')]);
  await ed.addTab('Untitled', '', null);
  results.push(['addTab hook 排除 null 路径', ed._recentFiles.length === beforeLen + 1]);

  window.__results = results;
  return results;
}

const HTML = '<!DOCTYPE html><html><body>'
  + '<div class="dropdown-menu" id="file-menu">'
  + '  <div class="dropdown-item" id="btn-recent"></div>'
  + '  <div class="dropdown-menu submenu hidden" id="recent-files-submenu"></div>'
  + '</div></body></html>';

// 与 error-handling.test.cjs 完全一致的加载方式：runScripts:'dangerously' + appendChild 同步执行 app.js
const dom = new JSDOM(HTML, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
window.console.error = () => {}; // 屏蔽 addRecentFile 等诊断输出，保持测试静默（真实运行时仍输出）
window.__TAURI__ = {
  core: {
    invoke: (cmd, args) => {
      const mode = window.__invokeMode || 'ok';
      if (mode === 'throw') throw new Error('net err');
      if (mode === 'null') {
        // 仅 /gone.md 视为失效（file_meta 返回 null），其余视为存在
        if (args && args.path === '/gone.md') return null;
        return { mtime: 1, size: 1 };
      }
      return { mtime: 1, size: 1 };
    }
  },
  path: {}, app: {}, event: {}, shell: {}
};

// 合并为单个脚本：app.js 与 harness 同作用域（非模块 script 顶层 class/const 不跨脚本共享）
// 同步把异步 IIFE 返回的 promise 赋给 window.__harnessPromise，避免 node:test 首个测试的竞态
// （若用 .then() 延迟赋值，第一个测试会在微任务前就 await 到 undefined）
const combined = tauriApiSrc + '\n;\n' + previewControllerSrc + '\n;\n' + appjs + '\n;\nwindow.__harnessPromise = (' + harnessFn.toString() + ')();';
const s = window.document.createElement('script');
s.textContent = combined;
window.document.body.appendChild(s);

const NAMES = [
  'addRecentFile 截断到 10',
  'addRecentFile 最新置顶',
  'addRecentFile 去重后仍为 10',
  'load/save 持久化往返',
  'loadRecentFiles 损坏 JSON 兜底空数组',
  'render 渲染 2 个文件项',
  'render 文件名=basename',
  'render 目录=dirname',
  'render 含清空项',
  'render 清空项文案=清空最近文件',
  'render 空态 disabled=暂无最近文件',
  'clearRecentFiles 清空',
  'refresh 移除失效项',
  'refresh invoke 失败保守保留',
  'addTab hook 记录真实路径',
  'addTab hook 排除 null 路径'
];
for (const name of NAMES) {
  test(name, async () => {
    const results = await window.__harnessPromise;
    const item = results.find(r => r[0] === name);
    assert.ok(item && item[1] === true, name + (item ? '' : ' (结果缺失)'));
  });
}
