// 后端健康探测横幅测试：锁定「后端挂了前端仍显示」的可见化修复。
// 背景：dev 模式下页面与后端生命周期解耦（tauri-api 延迟求值防白屏的副作用），
// Rust 挂 / 浏览器直开 devUrl 时前端照常显示且无提示。本测试验证：
//   1) 后端正常 → 横幅隐藏
//   2) IPC reject（Rust 挂）→ 横幅显示，文案来自 i18n
//   3) 恢复后自动隐藏
//   4) 无 __TAURI__（浏览器模式）→ 横幅显示
//   5) zh/en 字典均有 backendDown 键
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

const bannerEl = (w) => w.document.getElementById('backend-banner');
const bannerText = (w) => w.document.getElementById('backend-banner-text');

async function makeEditor(invokeImpl) {
  const { w } = await buildEnv({ invokeImpl });
  const ed = await waitForEditor(w);
  return { w, ed };
}

// 仅让 get_cli_args 挂掉（模拟 Rust IPC 断），其余命令维持默认，避免破坏初始化
const cliDown = () => (cmd) => {
  if (cmd === 'get_cli_args') throw new Error('ipc closed');
  return undefined;
};

test('后端正常：横幅存在且隐藏', async () => {
  const { w, ed } = await makeEditor();
  try {
    await ed._probeBackendHealth();
    assert.ok(bannerEl(w), 'banner 节点应存在（index.html）');
    assert.ok(bannerEl(w).classList.contains('hidden'), '后端正常时应隐藏');
  } finally { cleanup(w); }
});

test('IPC reject（Rust 挂）：横幅显示且文案为 i18n', async () => {
  const { w, ed } = await makeEditor(cliDown());
  try {
    await ed._probeBackendHealth();
    assert.ok(!bannerEl(w).classList.contains('hidden'), '后端挂时应显示横幅');
    assert.strictEqual(bannerText(w).textContent, ed.t('backendDown'), '文案应取自 i18n');
  } finally { cleanup(w); }
});

test('后端恢复后横幅自动隐藏', async () => {
  let down = true;
  const { w, ed } = await makeEditor((cmd) => {
    if (cmd === 'get_cli_args' && down) throw new Error('ipc closed');
    return undefined;
  });
  try {
    await ed._probeBackendHealth();
    assert.ok(!bannerEl(w).classList.contains('hidden'), '挂起时应显示');
    down = false;
    await ed._probeBackendHealth();
    assert.ok(bannerEl(w).classList.contains('hidden'), '恢复后应自动隐藏');
  } finally { cleanup(w); }
});

test('浏览器模式（无 __TAURI__）：横幅显示', async () => {
  const { w, ed } = await makeEditor();
  try {
    delete w.__TAURI__; // 模拟浏览器直开 http://localhost:1420
    await ed._probeBackendHealth();
    assert.ok(!bannerEl(w).classList.contains('hidden'), '无 Tauri 运行时也应提示后端不可用');
  } finally { cleanup(w); }
});

test('i18n: backendDown zh/en 均有翻译且非空', async () => {
  // 字典数据已从 app.js → i18n.js → i18n-data.js 拆分（缩进 2 空格），正则需容忍前导空白
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'i18n-data.js'), 'utf8');
  const m = src.match(/(?:^|\n)[ \t]*const I18N = \{[\s\S]*?\n[ \t]*\};/);
  assert.ok(m, '应能从源码提取 I18N');
  const I18N = new Function('return ' + m[0].replace(/^[\s\S]*?const I18N = /, '').replace(/;\s*$/, ''))();
  assert.ok(I18N.zh.backendDown && I18N.zh.backendDown.length > 0, 'zh.backendDown 非空');
  assert.ok(I18N.en.backendDown && I18N.en.backendDown.length > 0, 'en.backendDown 非空');
});
