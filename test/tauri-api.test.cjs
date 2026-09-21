// P0-2a（C3/C5/C17 + N21/N27/N29）：tauri-api 模块 + 前后端契约测试。
// 覆盖：① 28 自定义命令方法由 COMMANDS 生成并透传；② plugin 命令（dialog/updater/webview）透传；
//       ③ __TAURI__ 缺失时抛明确错误（ADR-1 唯一守卫）；④ reject 原样抛出（N21 语义空操作，C16 前提）；
//       ⑤ Channel 构造器延迟可用；⑥ COMMANDS 集合 == lib.rs generate_handler! 注册集合（C17）；
//       ⑦ generate_handler! 解析失败显式抛错（N27）。

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const TauriApi = require('../src/modules/tauri-api.js');

// 反解析 lib.rs 的 generate_handler! 块，提取注册的命令名（N27：只认 handler 块，不认 #[tauri::command]）
function parseHandlerCommands(rs) {
  const start = rs.indexOf('generate_handler![');
  if (start < 0) throw new Error('未找到 generate_handler! 块');
  const open = rs.indexOf('[', start);
  let depth = 1, i = open + 1, end = -1;
  while (i < rs.length && depth > 0) {
    const ch = rs[i];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) end = i; }
    i++;
  }
  if (end < 0) throw new Error('generate_handler! 块未闭合');
  let body = rs.slice(open + 1, end);
  body = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // 去注释
  const names = [...body.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
  const keywords = new Set(['let', 'fn', 'use', 'pub', 'mod', 'self', 'super', 'if', 'else',
    'for', 'while', 'match', 'return', 'await', 'async', 'true', 'false']);
  return names.filter((n) => !keywords.has(n));
}

test('COMMANDS 集合 == lib.rs generate_handler! 注册集合（C17，前后端须同步）', () => {
  const rs = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const names = parseHandlerCommands(rs).sort();
  const expected = [...TauriApi.COMMANDS].sort();
  assert.deepEqual(names, expected,
    `前后端命令集合必须一致。差异：${JSON.stringify(names)} vs ${JSON.stringify(expected)}`);
  assert.equal(expected.length, 28, '应有 28 个自定义命令');
});

test('generate_handler! 解析失败必须显式抛错（N27）', () => {
  assert.throws(() => parseHandlerCommands('fn main() {}'), /未找到 generate_handler/);
  assert.throws(() => parseHandlerCommands('generate_handler![unclosed'), /未闭合/);
});

test('28 个自定义命令方法由 COMMANDS 生成并原样透传（C5/N29）', async () => {
  const calls = [];
  global.window = {
    __TAURI__: { core: { invoke: async (cmd, args) => { calls.push({ cmd, args }); return 'R:' + cmd; } } },
  };
  try {
    for (const cmd of TauriApi.COMMANDS) {
      const name = cmd.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      assert.equal(typeof TauriApi[name], 'function', `方法 ${name} 应由 COMMANDS 生成`);
      const ret = await TauriApi[name]({ sample: 1 });
      assert.equal(ret, 'R:' + cmd, `${name} 应透传命令 ${cmd}`);
      const last = calls[calls.length - 1];
      assert.equal(last.cmd, cmd, 'invoke 命令名必须精确匹配');
    }
  } finally {
    delete global.window;
  }
});

test('plugin 命令透传：dialog / webview / updater（N32，属 core.invoke 收敛）', async () => {
  const calls = [];
  global.window = {
    __TAURI__: { core: { invoke: async (cmd, args) => { calls.push({ cmd, args }); return 'ok'; } } },
  };
  try {
    await TauriApi.dialogOpen({ foo: 1 });
    assert.equal(calls[calls.length - 1].cmd, 'plugin:dialog|open');
    assert.deepEqual(calls[calls.length - 1].args, { options: { foo: 1 } });

    await TauriApi.toggleDevtools();
    assert.equal(calls[calls.length - 1].cmd, 'plugin:webview|internal_toggle_devtools');

    await TauriApi.updater.check();
    assert.equal(calls[calls.length - 1].cmd, 'plugin:updater|check');

    await TauriApi.updater.download({ rid: 1, onEvent: {} });
    assert.equal(calls[calls.length - 1].cmd, 'plugin:updater|download');

    await TauriApi.updater.install({ updateRid: 1, bytesRid: 2 });
    assert.equal(calls[calls.length - 1].cmd, 'plugin:updater|install');
  } finally {
    delete global.window;
  }
});

test('Channel 构造器延迟可用（P0-2b 接管 channel 绑定）', () => {
  global.window = {
    __TAURI__: { core: { invoke: async () => {}, Channel: function Channel() { this.onmessage = null; } } },
  };
  try {
    const ch = new TauriApi.Channel();
    assert.ok(ch && typeof ch === 'object', 'Channel 应可构造');
  } finally {
    delete global.window;
  }
});

test('__TAURI__ 缺失时抛明确错误（ADR-1 唯一守卫，根治白屏）', async () => {
  delete global.window;
  await assert.rejects(
    async () => TauriApi.readFile({ path: 'x' }),
    (err) => err && /Tauri 运行时不可用/.test(err.message || String(err)),
  );
});

test('语义空操作：reject 原样抛出（N21 硬约束，C16 验收门的前提）', async () => {
  const rustJson = '{"kind":"NotFound","path":"x"}';
  global.window = {
    __TAURI__: { core: { invoke: async () => { throw rustJson; } } },
  };
  try {
    await assert.rejects(
      () => TauriApi.readFile({ path: 'x' }),
      (err) => err === rustJson,
    );
  } finally {
    delete global.window;
  }
});
