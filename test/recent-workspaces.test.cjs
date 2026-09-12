// 最近工作区（打开最近的工作区）回归测试
// jsdom 真实加载 src/app.js（不触发耗时构造函数），用 Object.create 获得实例方法，
// 验证记录/持久化/渲染/清理。
// 约定：test/*.test.cjs 由 `npm test`（`node --test test/*.test.cjs`）自动纳入。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const appjs = require('./helpers/app-bundle.cjs').readBundle();
const tauriApiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'tauri-api.js'), 'utf8');
const previewControllerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'preview-controller.js'), 'utf8');

async function harnessFn() {
  if (typeof MarkdownEditor !== 'function') { window.__results = [['MarkdownEditor 类加载', false]]; return; }
  const results = [];

  const ed = Object.create(MarkdownEditor.prototype);
  ed.settings = { language: 'zh' };
  ed._recentFiles = [];
  ed._recentWorkspaces = [];
  const submenu = document.getElementById('recent-workspaces-submenu');

  // 1. addRecentWorkspace：去重 + 置顶 + 截断到 10
  ed._recentWorkspaces = [];
  for (let i = 0; i < 15; i++) ed.addRecentWorkspace(`/ws/dir${i}`);
  results.push(['addRecentWorkspace 截断到 10', ed._recentWorkspaces.length === 10]);
  results.push(['addRecentWorkspace 最新置顶', ed._recentWorkspaces[0] === '/ws/dir14']);
  ed.addRecentWorkspace('/ws/dir14');
  results.push(['addRecentWorkspace 去重后仍为 10', ed._recentWorkspaces.length === 10 && ed._recentWorkspaces[0] === '/ws/dir14']);

  // 2. load/save 持久化
  ed._recentWorkspaces = ['/a', '/b'];
  ed.saveRecentWorkspaces();
  ed._recentWorkspaces = [];
  ed.loadRecentWorkspaces();
  results.push(['load/save 持久化往返', ed._recentWorkspaces.length === 2 && ed._recentWorkspaces[0] === '/a']);

  // 3. 损坏数据兜底
  localStorage.setItem('tizumark-recent-workspaces', '{bad json');
  ed._recentWorkspaces = ['x'];
  ed.loadRecentWorkspaces();
  results.push(['loadRecentWorkspaces 损坏 JSON 兜底空数组', Array.isArray(ed._recentWorkspaces)]);

  // 4. render 有项
  ed._recentWorkspaces = ['/docs/项目笔记', '/work/report'];
  ed.renderRecentWorkspacesSubmenu();
  const items = submenu.querySelectorAll('.recent-workspace-item');
  results.push(['render 渲染 2 个工作区项', items.length === 2]);
  results.push(['render 目录名=basename', items[0].querySelector('.recent-workspace-name').textContent === '项目笔记']);
  results.push(['render 父路径=dirname', items[0].querySelector('.recent-workspace-dir').textContent === '/docs']);
  results.push(['render 含清空项', !!submenu.querySelector('[data-action="clear"]')]);
  results.push(['render 清空项文案=清空最近工作区', submenu.querySelector('[data-action="clear"]').textContent === '清空最近工作区']);

  // 5. render 空态
  ed._recentWorkspaces = [];
  ed.renderRecentWorkspacesSubmenu();
  const disabled = submenu.querySelector('.dropdown-item.disabled');
  results.push(['render 空态 disabled=暂无最近工作区', !!disabled && disabled.textContent === '暂无最近工作区']);

  // 6. clearRecentWorkspaces
  ed._recentWorkspaces = ['/a'];
  ed.clearRecentWorkspaces();
  results.push(['clearRecentWorkspaces 清空', ed._recentWorkspaces.length === 0]);

  window.__results = results;
  return results;
}

const HTML = '<!DOCTYPE html><html><body>'
  + '<div class="dropdown-menu" id="file-menu">'
  + '  <div class="dropdown-item" id="btn-recent"></div>'
  + '  <div class="dropdown-menu submenu hidden" id="recent-files-submenu"></div>'
  + '  <div class="dropdown-item" id="btn-recent-workspaces"></div>'
  + '  <div class="dropdown-menu submenu hidden" id="recent-workspaces-submenu"></div>'
  + '</div></body></html>';

const dom = new JSDOM(HTML, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
window.console.error = () => {};
window.__TAURI__ = {
  core: {
    invoke: () => ({ mtime: 1, size: 1 })
  },
  path: {}, app: {}, event: {}, shell: {}
};

const combined = tauriApiSrc + '\n;\n' + previewControllerSrc + '\n;\n' + appjs + '\n;\nwindow.__harnessPromise = (' + harnessFn.toString() + ')();';
const s = window.document.createElement('script');
s.textContent = combined;
window.document.body.appendChild(s);

const NAMES = [
  'addRecentWorkspace 截断到 10',
  'addRecentWorkspace 最新置顶',
  'addRecentWorkspace 去重后仍为 10',
  'load/save 持久化往返',
  'loadRecentWorkspaces 损坏 JSON 兜底空数组',
  'render 渲染 2 个工作区项',
  'render 目录名=basename',
  'render 父路径=dirname',
  'render 含清空项',
  'render 清空项文案=清空最近工作区',
  'render 空态 disabled=暂无最近工作区',
  'clearRecentWorkspaces 清空'
];
for (const name of NAMES) {
  test(name, async () => {
    const results = await window.__harnessPromise;
    const item = results.find(r => r[0] === name);
    assert.ok(item && item[1] === true, name + (item ? '' : ' (结果缺失)'));
  });
}