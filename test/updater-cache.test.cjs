// 更新安装包磁盘缓存（2026-10-21）：下载后未安装 → 下次检查更新命中本地缓存，
// 不再重复下载，直接提示「安装包已下载，是否立即安装」。
// 断言重点：
//   - checkUpdate：缓存命中 → 「已下载」态（版本/大小/立即安装按钮/可跳过），不触发下载命令
//   - checkUpdate：缓存未命中 / raw_json 缺失 → 「发现新版本」态（正常下载流程）
//   - downloadUpdate：走 download_update_to_file（url/signature/version 来自 raw_json），
//     进度事件驱动进度条，成功后切「已下载」态并记住缓存路径
//   - downloadUpdate 失败：toast + 关框，不进入「已下载」态
//   - installUpdate：走 install_cached_update（updateRid + 缓存路径）；无缓存路径则提示失败
//   - 与「跳过此版本」共存：跳过判定仍优先于缓存（见 updater-skip.test.cjs 回归）
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

const REMOTE = {
  version: '1.2.5',
  body: '',
  rid: 42,
  raw_json: {
    platforms: {
      'windows-x86-64': {
        url: 'https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.2.5/TizuMark_1.2.5_x64-setup.exe',
        signature: 'SIG-1.2.5',
      },
    },
  },
};
const CACHE_HIT = { path: 'C:\\appdata\\updates\\installer_1.2.5.exe', size: 52428800 }; // 50 MB

async function makeEditor({ cacheResult, onDownload, checkResult } = {}) {
  const calls = { find: 0, download: [], install: [] };
  const { w } = await buildEnv({
    invokeImpl: (cmd, args) => {
      if (cmd === 'plugin:updater|check') return checkResult !== undefined ? checkResult : REMOTE;
      if (cmd === 'find_cached_update') {
        calls.find++;
        return cacheResult;
      }
      if (cmd === 'download_update_to_file') {
        calls.download.push(args);
        if (onDownload) onDownload(args, calls);
        return Promise.resolve({ path: CACHE_HIT.path, size: CACHE_HIT.size });
      }
      if (cmd === 'install_cached_update') {
        calls.install.push(args);
        return Promise.resolve();
      }
      return undefined;
    },
  });
  await waitForEditor(w);
  return { w, ed: w.editor, calls };
}

const isDialogOpen = (w) => !w.document.getElementById('update-dialog').classList.contains('hidden');
const stateVisible = (w, s) => !w.document.getElementById('update-state-' + s).classList.contains('hidden');

test('cache: 检查更新命中本地缓存 → 「已下载」态，不触发下载', async () => {
  const { w, ed, calls } = await makeEditor({ cacheResult: CACHE_HIT });
  try {
    await ed.checkUpdate(true);
    assert.ok(isDialogOpen(w));
    assert.ok(stateVisible(w, 'downloaded'), '应展示「安装包已下载」态');
    assert.ok(!stateVisible(w, 'available'), '不应同时是「发现新版本」态');
    assert.strictEqual(w.document.getElementById('update-dl-version').textContent, '1.2.5');
    assert.ok(/50\.0 MB/.test(w.document.getElementById('update-dl-info').textContent),
      '应显示本地包大小', w.document.getElementById('update-dl-info').textContent);
    const btn = w.document.getElementById('update-action');
    assert.strictEqual(btn.dataset.state, 'install', '主按钮应为「立即安装」');
    assert.strictEqual(btn.textContent, ed.t('updateInstallNow'));
    assert.ok(!btn.disabled);
    assert.ok(!w.document.getElementById('update-skip-version').classList.contains('hidden'),
      '已下载态仍可「跳过此版本」');
    assert.strictEqual(calls.find, 1, '应查过一次缓存');
    assert.strictEqual(calls.download.length, 0, '命中缓存不应触发下载');
  } finally { cleanup(w); }
});

test('cache: 缓存未命中 → 「发现新版本」态（正常下载流程）', async () => {
  const { w, ed } = await makeEditor({ cacheResult: null });
  try {
    await ed.checkUpdate(true);
    assert.ok(stateVisible(w, 'available'));
    assert.strictEqual(w.document.getElementById('update-action').dataset.state, 'download');
    assert.strictEqual(w.document.getElementById('update-new-version').textContent, '1.2.5');
  } finally { cleanup(w); }
});

test('cache: raw_json 缺失（旧格式响应）→ 优雅降级为「发现新版本」态，不查缓存', async () => {
  const legacy = { version: '1.2.5', body: '', rid: 42 }; // 无 raw_json
  const { w, ed, calls } = await makeEditor({ checkResult: legacy });
  try {
    await ed.checkUpdate(true);
    assert.ok(stateVisible(w, 'available'));
    assert.strictEqual(calls.find, 0, '无 raw_json 不应查缓存');
  } finally { cleanup(w); }
});

test('cache: 点「下载」→ 走 download_update_to_file（参数来自 raw_json），完成后切「已下载」态', async () => {
  const { w, ed, calls } = await makeEditor({ cacheResult: null });
  try {
    await ed.checkUpdate(true);
    assert.ok(stateVisible(w, 'available'));
    w.document.getElementById('update-action').click(); // data-state=download → downloadUpdate
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(calls.download.length, 1, '应发起一次下载');
    const a = calls.download[0];
    assert.strictEqual(a.url, REMOTE.raw_json.platforms['windows-x86-64'].url);
    assert.strictEqual(a.signature, 'SIG-1.2.5');
    assert.strictEqual(a.version, '1.2.5');
    assert.ok(a.onEvent, '应带进度 channel');
    assert.ok(stateVisible(w, 'downloaded'), '下载完成应切「已下载」态');
    assert.strictEqual(ed.pendingCachePath.path, CACHE_HIT.path);
    assert.strictEqual(w.document.getElementById('update-action').dataset.state, 'install');
  } finally { cleanup(w); }
});

test('cache: 下载过程进度事件驱动进度条', async () => {
  const { w, ed } = await makeEditor({
    cacheResult: null,
    onDownload: (args) => {
      args.onEvent.onmessage({ event: 'Started', data: { contentLength: 1000 } });
      args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 500 } });
      assert.strictEqual(w.document.getElementById('update-progress-text').textContent, '50%');
      args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 500 } });
      args.onEvent.onmessage({ event: 'Finished' });
    },
  });
  try {
    await ed.checkUpdate(true);
    await ed.handleUpdateAction(); // download
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(stateVisible(w, 'downloaded'));
  } finally { cleanup(w); }
});

test('cache: 下载失败 → toast 提示 + 关框，不进入「已下载」态', async () => {
  const toasts = [];
  const { w, ed, calls } = await makeEditor({
    cacheResult: null,
    onDownload: () => { throw new Error('network down'); },
  });
  ed.showToast = (msg) => toasts.push(String(msg));
  try {
    await ed.checkUpdate(true);
    await ed.handleUpdateAction(); // download
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!stateVisible(w, 'downloaded'), '失败不应进入「已下载」态');
    assert.ok(!isDialogOpen(w), '应关闭弹框');
    assert.ok(toasts.includes(ed.t('updateFailed')), '应弹失败提示');
    assert.strictEqual(calls.install.length, 0);
  } finally { cleanup(w); }
});

test('cache: 点「立即安装」→ 走 install_cached_update（updateRid + 缓存路径）', async () => {
  const { w, ed, calls } = await makeEditor({ cacheResult: CACHE_HIT });
  try {
    await ed.checkUpdate(true);
    assert.ok(stateVisible(w, 'downloaded'));
    w.document.getElementById('update-action').click(); // data-state=install → installUpdate
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(calls.install.length, 1, '应发起一次缓存安装');
    // 逐字段比较（args 对象来自 jsdom realm，deepStrictEqual 会因原型不同误判）
    assert.strictEqual(calls.install[0].updateRid, 42);
    assert.strictEqual(calls.install[0].path, CACHE_HIT.path);
    assert.ok(!isDialogOpen(w), '安装启动后弹框应关闭');
  } finally { cleanup(w); }
});

test('cache: 无缓存路径时点「立即安装」→ 失败提示，不发起安装', async () => {
  const toasts = [];
  const { w, ed, calls } = await makeEditor({ cacheResult: CACHE_HIT });
  ed.showToast = (msg) => toasts.push(String(msg));
  try {
    await ed.checkUpdate(true);
    ed.pendingCachePath = null; // 人为制造无缓存
    await ed.handleUpdateAction(); // install
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(calls.install.length, 0);
    assert.ok(toasts.includes(ed.t('updateFailed')));
  } finally { cleanup(w); }
});

// 回归（2026-11-14，用户截图）：「已是最新版本」弹窗上方恒显「安装包已下载」。
// 根因：本应用无全局 .hidden 规则，styles.css 只给 checking/available/latest 三个
// 状态块定义了 .hidden{display:none}，唯独漏了 downloaded → classList 加了 hidden
// 类但 CSS 不认，该块从启动起恒可见。jsdom 只断言 classList 永远发现不了这类
// CSS 缺失，必须静态断言样式表本身。
test('cache: styles.css 必须给更新弹窗全部四个状态块 + 进度条定义 .hidden 显隐规则', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  const ids = [
    'update-state-checking', 'update-state-available', 'update-state-downloaded', 'update-state-latest',
    'update-progress-wrap', // .update-progress 是 display:flex，漏规则会让 available 态恒显 0% 进度条
  ];
  for (const id of ids) {
    const re = new RegExp('#' + id + '\\.hidden\\s*[,\\{]');
    assert.match(css, re, `#${id} 缺少 .hidden 显隐规则（会恒显示）`);
  }
  // 显隐规则组必须是 display:none（防止改成 visibility 等占位写法）
  assert.match(
    css,
    /#update-state-checking\.hidden,\s*#update-state-available\.hidden,\s*#update-state-downloaded\.hidden,\s*#update-state-latest\.hidden,\s*#update-progress-wrap\.hidden\s*\{\s*display:\s*none/i,
    '状态块与进度条的 .hidden 规则应合并为一组 display:none'
  );
});
