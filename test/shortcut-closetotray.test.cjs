// 回归测试：快捷键设置新增「关闭到托盘」(closeToTray)
// 覆盖关键改动点：默认无快捷键、归属文件组、globalMap 注册、hideToTray 方法定义。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const src = require('./helpers/app-bundle.cjs').readBundle();

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { console.log('ok - ' + name); pass++; }
  else { console.log('not ok - ' + name); fail++; }
}

// 1. getDefaultShortcuts 包含 closeToTray 且默认 key 为空（无快捷键）
function extractMethod(code, name) {
  const start = code.indexOf('  ' + name + '(');
  if (start === -1) throw new Error('method not found: ' + name);
  let i = code.indexOf('{', start);
  let depth = 0, end = -1;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return code.slice(start, end + 1);
}
try {
  const methodSrc = extractMethod(src, 'getDefaultShortcuts');
  const Cls = new Function('return class { ' + methodSrc + ' };')();
  const def = new Cls().getDefaultShortcuts();
  ok(def.closeToTray, 'getDefaultShortcuts 包含 closeToTray');
  ok(def.closeToTray.key === '', 'closeToTray 默认 key 为空（无快捷键）');
  ok(def.closeToTray.label === '关闭到托盘', 'closeToTray 默认 label 为「关闭到托盘」');
} catch (e) {
  ok(false, '提取/调用 getDefaultShortcuts 失败: ' + e.message);
}

// 2. 渲染列表的文件组 ids 包含 closeToTray
const fileGroup = src.match(/\{ key: 'file', ids: \[([^\]]*)\] \}/);
ok(fileGroup && fileGroup[1].includes("'closeToTray'"), '快捷键列表「文件」组包含 closeToTray');

// 3. globalMap 注册了 closeToTray -> hideToTray
ok(src.includes("closeToTray: () => this.hideToTray(),"), 'globalMap 注册 closeToTray 指向 hideToTray');

// 4. hideToTray 方法已定义
ok(/async hideToTray\(\)\s*\{/.test(src), 'hideToTray 方法已定义');

// 5. 中英文 shortcutLabel 均包含 closeToTray
ok(src.includes("closeToTray: '关闭到托盘'"), '中文 shortcutLabel 含 closeToTray');
ok(src.includes("closeToTray: 'Hide to tray'"), '英文 shortcutLabel 含 closeToTray');

// 6. 切换方案逻辑会对未列出的 action 回落为空（源码层面确认）
ok(src.includes("next[aid] = { key: (k != null ? k : ''), label: def.label };"),
  'applyShortcutScheme/preview 对预设缺失项回落为空键');

console.log('# tests ' + (pass + fail));
console.log('# pass ' + pass);
console.log('# fail ' + fail);
process.exit(fail ? 1 : 0);
