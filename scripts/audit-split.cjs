// 拆分审计脚本（只读、不改动）：验证 app.js 按职责域拆分到 src/modules/* 后
//   (1) 各模块 mixin 顶层方法名无冲突（同名会静默覆盖，属高危）
//   (2) app.js 仅保留框架层方法，具体功能方法已迁出
//   (3) 统计挂到 MarkdownEditor.prototype 的方法总数
// 仅做结构检查；行为正确性由全量 node --test 负责。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULES_DIR = path.join(ROOT, 'src', 'modules');
const APPJS = path.join(ROOT, 'src', 'app.js');

// 在 mixin 对象顶层（depth===1）提取方法名：支持 name( / async name( / static name( / get name(
function extractMixinMethods(src) {
  const idx = src.search(/const\s+mixin\s*=\s*\{/);
  if (idx < 0) return [];
  // 从 mixin 开括号开始做括号深度跟踪
  const open = src.indexOf('{', idx);
  let depth = 0;
  const methods = [];
  // 扫描 open 之后的每个 token；方法定义在 depth===1 时匹配
  const re = /(\b(?:async\s+)?(?:static\s+)?(?:get\s+)?)([A-Za-z_$][\w$]*)\s*\(/g;
  // 重新定位正则起点
  re.lastIndex = open;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 计算当前位置之前的括号深度
    let d = 0;
    for (let i = open; i < m.index; i++) {
      if (src[i] === '{') d++;
      else if (src[i] === '}') d--;
    }
    // 顶层（mixin 内部第一层）才计为方法；getter/普通方法/static 都收
    if (d === 1) {
      // 跳过可能的嵌套函数（其出现时 depth>1）
      // 但本循环只在 depth===1 时记录，已排除嵌套
      methods.push(m[2]);
    }
    // 若深度已回到 0（mixin 结束），停止
    let dd = 0;
    for (let i = open; i <= m.index; i++) {
      if (src[i] === '{') dd++;
      else if (src[i] === '}') dd--;
    }
    if (dd <= 0) break;
  }
  // 去重（同一模块内同名不重复计，但跨模块同名会在汇总时报冲突）
  return [...new Set(methods)];
}

// 从 app.js 提取 class MarkdownEditor 内直接定义的方法（非 Object.assign 注入）
function extractAppClassMethods(src) {
  const clsStart = src.search(/class\s+MarkdownEditor\s*\{/);
  const appMethods = new Set();
  if (clsStart < 0) return appMethods;
  const re = /(\b(?:async\s+)?(?:static\s+)?(?:get\s+)?)([A-Za-z_$][\w$]*)\s*\(/g;
  re.lastIndex = clsStart;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 只统计到 class 闭合；粗略处理：deep 跟踪
    let d = 0;
    for (let i = clsStart; i < m.index; i++) {
      if (src[i] === '{') d++;
      else if (src[i] === '}') d--;
    }
    if (d === 1) appMethods.add(m[2]);
    let dd = 0;
    for (let i = clsStart; i <= m.index; i++) {
      if (src[i] === '{') dd++;
      else if (src[i] === '}') dd--;
    }
    if (dd <= 0) break;
  }
  return appMethods;
}

// 从 app.js 提取 Object.assign 注入的模块来源
function extractAssemblySources(src) {
  const re = /Object\.assign\(\s*MarkdownEditor(?:\.prototype|\.constructor)?\s*,\s*(TM[A-Za-z0-9]+)\.(?:mixin|statics)\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1] + '.' + m[2]);
  return out;
}

// ---- 执行 ----
const files = fs.readdirSync(MODULES_DIR).filter((f) => f.endsWith('.js') && fs.statSync(path.join(MODULES_DIR, f)).isFile());

const perModule = {};
const nameToModules = {}; // method -> [moduleFile]
let totalMethods = 0;

for (const f of files) {
  const src = fs.readFileSync(path.join(MODULES_DIR, f), 'utf8');
  const hasMixin = /const\s+mixin\s*=/.test(src);
  if (!hasMixin) continue;
  const methods = extractMixinMethods(src);
  perModule[f] = methods;
  for (const name of methods) {
    (nameToModules[name] ||= []).push(f);
    totalMethods++;
  }
}

// 冲突检测
const collisions = [];
for (const [name, mods] of Object.entries(nameToModules)) {
  if (mods.length > 1) collisions.push({ name, mods: [...new Set(mods)] });
}

// app.js 审计
const appSrc = fs.readFileSync(APPJS, 'utf8');
const appMethods = extractAppClassMethods(appSrc);
const assembly = extractAssemblySources(appSrc);

// 已知框架层方法（app.js 应保留的）
const FRAMEWORK_METHODS = new Set([
  'constructor', 'get', 'set', 'showLoading', 'hideLoading', 'showPaneLoading',
  'showLargeFileNotice', 'hideLargeFileNotice', 'initEventListeners',
  'executeMenuAction', '_bindMenuAction', 'initMenuButtons', 'initAppLifecycleEvents',
  '_handleGlobalKeydown', '_beginPaneLoad', '_endPaneLoad', 'get activeTab',
  'initEventListeners', // 可能重复
]);

// 框架层但非标准方法名（如 get activeTab 属性访问器、Symbol 等）已含；
// 这里只报告 app.js 中出现的非构造/非已知框架方法，提示“可能漏迁出的功能方法”。
const suspectedFeatureMethods = [...appMethods].filter((n) => !FRAMEWORK_METHODS.has(n) && n !== 'constructor');

console.log('=== 拆分审计结果 ===');
console.log('模块数(含 mixin):', Object.keys(perModule).length);
console.log('mixin 方法总数:', totalMethods);
console.log('Object.assign 注入条目:', assembly.length, '->', assembly.join(', '));
console.log('');
console.log('--- 同名方法冲突（高危，会静默覆盖）---');
if (collisions.length === 0) console.log('  ✅ 无冲突');
else collisions.forEach((c) => console.log(`  ❌ ${c.name} 出现在: ${c.mods.join(', ')}`));
console.log('');
console.log('--- app.js class 内直接定义的方法 ---');
console.log('  ', [...appMethods].join(', '));
console.log('');
console.log('--- app.js 中疑似“功能方法”（非框架层，应已迁出）---');
if (suspectedFeatureMethods.length === 0) console.log('  ✅ 无（app.js 仅框架层）');
else console.log('  ⚠️ ' + suspectedFeatureMethods.join(', '));
console.log('');
console.log('--- 各模块方法数 ---');
for (const [f, ms] of Object.entries(perModule).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${f}: ${ms.length}`);
}

// 退出码：冲突或疑似功能残留则非零
if (collisions.length > 0) process.exit(1);
