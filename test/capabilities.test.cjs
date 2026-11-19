// P0-2（2026-08-01 审查修复）：capabilities 权限面收敛契约测试。
// 覆盖：① default.json 不得含 fs 插件权限（fs:read-all/write-all 曾过度授权任意文件读写，
//        前端实际零调用 plugin:fs，文件读写全走自定义 read_file/write_file 命令）；
//        ② src/ 与 dist/ 产物不得出现 plugin:fs / @tauri-apps/plugin-fs 引用；
//        ③ 保留的核心权限（dialog/shell/updater/window-state）仍在位。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const capFile = path.join(ROOT, 'src-tauri', 'capabilities', 'default.json');

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'lib' || entry.name === 'node_modules') continue; // vendor/依赖跳过
      walkFiles(full, acc);
    } else if (/\.(js|html|json)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

test('capabilities: default.json 不含 fs 插件权限（读/写全盘授权已移除）', () => {
  const cap = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  const perms = cap.permissions || [];
  const fsPerms = perms.filter((p) => typeof p === 'string' && p.startsWith('fs:'));
  assert.deepEqual(fsPerms, [], `fs 插件权限应全部移除，实际仍有：${JSON.stringify(fsPerms)}`);
});

test('capabilities: 前端与构建产物零引用 plugin:fs', () => {
  const haystacks = [];
  for (const dir of ['src', 'dist']) {
    for (const f of walkFiles(path.join(ROOT, dir))) {
      haystacks.push([f, fs.readFileSync(f, 'utf8')]);
    }
  }
  const needle = /plugin:fs|@tauri-apps\/plugin-fs|readTextFile|writeTextFile/;
  const hits = haystacks
    .filter(([, content]) => needle.test(content))
    .map(([f]) => path.relative(ROOT, f));
  assert.deepEqual(hits, [], '不得引用 fs 插件 API（前端文件读写走自定义命令）');
});

test('capabilities: 核心权限仍在位（dialog/shell/updater/window-state）', () => {
  const cap = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  // 兼容字符串权限（如 "dialog:default"）和对象权限（如 {"identifier":"shell:allow-open",...}）
  const permIds = cap.permissions.map((p) => typeof p === 'string' ? p : p.identifier).join('\n');
  for (const expect of [
    'dialog:default', 'dialog:allow-open', 'dialog:allow-save',
    'shell:allow-open', 'updater:default', 'window-state:default',
  ]) {
    assert.ok(permIds.includes(expect), `应保留权限：${expect}`);
  }
  // dialog 全能力集：open/save/confirm/ask/message 必须齐（confirm/ask 缺一即
  // window.confirm / dialog.ask 调用报 "not allowed"，历史 bug；可用性优先）
  for (const expect of ['dialog:allow-confirm', 'dialog:allow-ask']) {
    assert.ok(permIds.includes(expect), `dialog 能力不可缺：${expect}`);
  }
  // 明确排除：不允许 shell:allow-execute / allow-spawn（任意命令执行）
  assert.ok(!permIds.includes('shell:allow-execute') && !permIds.includes('shell:allow-spawn'),
    '不得出现 shell 任意命令执行权限');
});

// 多窗口撕离（tab-tearoff-window）：分离窗口 label 授权 + JS 建窗权限。
// editor-* 必须显式在 windows 集合内——否则新窗口的 IPC 全被拒（白屏）；
// create-webview-window 是 JS 侧 WebviewWindowBuilder 的唯一建窗通道权限。
test('capabilities: 多窗口授权（editor-* 窗口集合 + create-webview-window）', () => {
  const cap = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  assert.ok(Array.isArray(cap.windows), 'capabilities 缺少 windows 数组');
  assert.ok(cap.windows.includes('main'), 'windows 应含 main');
  assert.ok(cap.windows.includes('editor-*'), 'windows 应含 editor-*（分离窗口授权）');
  const permIds = cap.permissions.map((p) => typeof p === 'string' ? p : p.identifier).join('\n');
  assert.ok(permIds.includes('core:webview:allow-create-webview-window'),
    '缺少建窗权限 core:webview:allow-create-webview-window');
});
