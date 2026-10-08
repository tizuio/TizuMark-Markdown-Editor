// 回归测试：scripts/check-globals.cjs 的全局导出守护。
// 正向确认当前 6 个模块的命名空间均在白名单内；负向用内存数据确认意外全局会被检出
// （不写真实文件，规避 safe-delete 垫片对 rm 的拦截）。

const test = require('node:test');
const assert = require('node:assert');
const { checkGlobals, analyzeModules, KNOWN_GLOBALS } = require('../scripts/check-globals.cjs');

test('当前所有模块全局导出均在白名单内，无违规', () => {
  const r = checkGlobals(); // 读真实 src/modules/，只读不写
  assert.deepStrictEqual(r.violations, [], 'check-globals 不应有违规：' + r.violations.join('; '));
  for (const g of ['CodeBlock', 'Dialogs', 'Outline', 'WordCount', 'FindReplace', 'PreviewPost', 'RenderPost']) {
    assert.ok(KNOWN_GLOBALS.has(g), `白名单应包含 ${g}`);
    assert.ok(r.found.includes(g), `应检出全局 window.${g}`);
  }
});

test('检出意外全局导出（负向，纯内存）', () => {
  const r = analyzeModules([{ file: 'x.js', source: 'if (typeof window !== "undefined") window.ZombieExport = 1;' }]);
  assert.ok(
    r.violations.some((v) => v.includes('ZombieExport')),
    '应检出意外全局导出 ZombieExport，实际：' + r.violations.join('; '),
  );
});

test('检出单模块多全局导出（负向，纯内存）', () => {
  const r = analyzeModules([{ file: 'x.js', source: 'window.One = 1; window.Two = 2;' }]);
  assert.ok(
    r.violations.some((v) => v.includes('x.js') && v.includes('多个全局')),
    '应检出单模块多全局，实际：' + r.violations.join('; '),
  );
});

test('白名单内单全局不报违规（纯内存）', () => {
  const r = analyzeModules([
    { file: 'code-block.js', source: 'if (typeof window !== "undefined" && typeof module === "undefined") window.CodeBlock = {};' },
    { file: 'dialogs.js', source: 'window.Dialogs = {};' },
  ]);
  assert.deepStrictEqual(r.violations, [], '白名单内不应有违规：' + r.violations.join('; '));
});
