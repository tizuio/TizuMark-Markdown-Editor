// P1-4 成功度量脚本（ADR-7）：耦合度报告，作为 `npm run check` 的一环。
//
// 度量项：
//   1) 模块全局导出 == 白名单（复用 check-globals 的 checkGlobals：不锚行首的正则，
//      每个模块恰好一个命名空间）。违规即硬失败。
//   2) src/app.js 中 `invoke(` 残留 == 0（P0-2b IPC 收敛的唯一边界是 tauri-api；
//      任何残留 invoke( 都是回归，硬失败）。
//   3) `window.__TAURI__` 残留数：按文件统计。P1-5 之前【信息性】（仅报告，不卡构建）；
//      传 --strict 时转为硬卡（P1-5 收敛完成后默认应开启）。
//   4) updatePreview fan-in：统计该方法体内 `this.` 引用数（容忍 4 空格缩进），作为趋势基线。
//   5) PR 破测预算（信息性）：`--changed <file>` 模式下，按文件名启发式列出受波及的测试文件，
//      若单文件改动会连坐 > 3 个无关模块测试则告警（不阻断）。
//
// 退出码：任一硬门失败即非零；纯信息项不阻断。
//
// 设计原则：纯文本扫描，不加载 app.js / 不需要构建产物，保证 `npm run check` 快且零依赖前端 bundle。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const APP_JS = path.join(SRC, 'app.js');
const MODULES_DIR = path.join(SRC, 'modules');

// 复用 P0-1 的全局导出守护核心，避免两套正则漂移。
const { checkGlobals } = require('./check-globals.cjs');

let hadHardFail = false;
const fail = (msg) => { hadHardFail = true; console.error('  ❌ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);
const info = (msg) => console.log('  • ' + msg);

// ---------- 2) app.js 中 invoke( 残留 ----------
function countInvokeResidual() {
  const src = fs.readFileSync(APP_JS, 'utf8');
  const re = /(^|[^.A-Za-z0-9_])invoke\s*\(/g; // 不误伤 invokeImpl / window.__TAURI__.core.invoke
  let n = 0; const hits = [];
  let m;
  while ((m = re.exec(src)) !== null) { n++; if (hits.length < 5) hits.push(m.index); }
  return { n, hits };
}

// ---------- 3) window.__TAURI__ 残留统计 ----------
function countTauriGlobal() {
  const result = {};
  const scan = (file) => {
    let s;
    try { s = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
    const re = /window\.__TAURI__/g;
    let n = 0; while (re.exec(s) !== null) n++;
    if (n) result[path.relative(ROOT, file)] = n;
  };
  // app.js
  scan(APP_JS);
  // 所有 src 下的 js（不含 lib 目录的生成产物 / node_modules）
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'lib') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.js')) scan(full);
    }
  };
  walk(SRC);
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  return { total, perFile: result };
}

// ---------- 4) updatePreview fan-in（this. 计数，容忍缩进） ----------
function updatePreviewFanIn() {
  // app.js 拆分后 updatePreview 位于 src/modules/preview-sync.js：扫描全量业务源码，
  // 用 index.html 的清单保证与生产加载顺序一致（与 test/helpers/app-bundle.cjs 同源）。
  const { readBundle } = require(path.join(ROOT, 'test', 'helpers', 'app-bundle.cjs'));
  const lines = readBundle().split('\n');
  const startRe = /^\s*async\s+updatePreview\s*\(/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return { found: false, count: 0 };
  // 从方法起始大括号开始按括号深度收束，方法体末尾 } 即 depth 回 0
  let depth = 0, seenOpen = false, count = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!seenOpen) {
      if (line.includes('{')) { seenOpen = true; depth += (line.split('{').length - 1); }
      continue;
    }
    depth += (line.split('{').length - 1);
    depth -= (line.split('}').length - 1);
    count += (line.match(/this\./g) || []).length;
    if (depth <= 0) break;
  }
  return { found: true, count };
}

// ---------- 5) PR 破测预算：受波及测试文件 ----------
function relatedTests(changedFile) {
  const base = path.basename(changedFile, '.js').replace(/^src[/\\]/, '');
  // 去掉常见前缀/后缀做模糊匹配
  const tokens = base.toLowerCase().split(/[-_/]/).filter(Boolean);
  const testDir = path.join(ROOT, 'test');
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (e.name !== 'helpers' && e.name !== 'node_modules') walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.test.cjs')) {
        const t = e.name.toLowerCase();
        if (tokens.some((tok) => t.includes(tok))) out.push(e.name);
      }
    }
  };
  walk(testDir);
  return [...new Set(out)].sort();
}

function runReport() {
  console.log('\n===耦合度报告（P1-4 coupling-report）===');

  // 1) 模块全局导出
  console.log('[1] 模块全局导出 == 白名单');
  const g = checkGlobals();
  if (g.violations.length) {
    g.violations.forEach((v) => fail(v));
  } else {
    ok('全局导出均在白名单内：' + g.found.join(', '));
  }

  // 2) invoke( 残留
  console.log('[2] src/app.js 中 invoke( 残留（硬卡：必须 == 0）');
  const inv = countInvokeResidual();
  if (inv.n === 0) ok('无直接 invoke( 调用，IPC 边界唯一收敛于 tauri-api');
  else fail(`app.js 仍有 ${inv.n} 处直接 invoke( 调用（应为 0，P0-2b 已收敛）`);

  // 3) window.__TAURI__ 残留
  console.log('[3] window.__TAURI__ 残留（P1-5 前信息性）');
  const tauri = countTauriGlobal();
  if (tauri.total === 0) ok('已无 window.__TAURI__ 直接引用');
  else {
    info(`window.__TAURI__ 共 ${tauri.total} 处：`);
    for (const [f, n] of Object.entries(tauri.perFile).sort()) info(`    ${f}: ${n}`);
    if (STRICT) {
      const inApp = tauri.perFile['src/app.js'] || 0;
      if (inApp > 0) fail(`P1-5 应已收敛，src/app.js 仍有 ${inApp} 处直接 window.__TAURI__（默认硬卡；--no-strict 可临时降级）`);
    } else {
      info('（--no-strict：本应已硬卡，当前为信息性）');
    }
  }

  // 4) updatePreview fan-in 趋势
  console.log('[4] updatePreview fan-in（this. 引用数，趋势基线）');
  const fan = updatePreviewFanIn();
  if (fan.found) info(`updatePreview 方法体内 this. 引用数 = ${fan.count}（作为后续重构的连坐面趋势基线）`);
  else fail('未找到 updatePreview 方法，无法统计 fan-in');

  console.log('===耦合度报告结束===\n');
  if (hadHardFail) {
    console.error('✗ coupling-report 存在硬门失败');
    process.exit(1);
  }
  console.log('✓ coupling-report 通过（信息项见上）');
}

// ---------- --changed 模式（信息性，不阻断） ----------
function runChangedMode(changedFile) {
  const abs = path.isAbsolute(changedFile) ? changedFile : path.join(ROOT, changedFile);
  if (!fs.existsSync(abs)) { console.error('文件不存在：' + abs); process.exit(2); }
  const rel = path.relative(ROOT, abs);
  const related = relatedTests(rel);
  console.log(`\n=== PR 破测预算：改动 ${rel} ===`);
  if (!related.length) {
    console.log('  • 未匹配到直接相关测试（可能只影响整链路集成测试）');
  } else {
    console.log(`  • 直接相关测试（${related.length}）：`);
    related.forEach((t) => console.log('    - ' + t));
    if (related.length > 3) {
      console.log(`  ⚠ 单文件改动连坐 ${related.length} 个测试（>3），建议拆分或下沉到纯模块单测以降低连坐面`);
    }
  }
  console.log('===结束===');
  process.exit(0);
}

// P1-5 完成：app.js 不再出现 window.__TAURI__.*，IPC 边界唯一收敛于 tauri-api。
// 故默认转为硬卡（--no-strict 可临时降级为信息性，便于过渡期调试）。
const STRICT = !process.argv.includes('--no-strict');
const changedIdx = process.argv.indexOf('--changed');
if (changedIdx >= 0 && process.argv[changedIdx + 1]) {
  runChangedMode(process.argv[changedIdx + 1]);
} else {
  runReport();
}
