// P0-1 全局导出守护（N4 相关）：扫 src/modules/*.js，统计 window.[A-Z]... 全局赋值。
//
// 目的：
//   1) 防止模块在 node / harness 下意外污染 global.window（见 harness 双导出陷阱：
//      漏写 typeof module==='undefined' 时，buildEnv 之后 require 会污染全局）。
//   2) 防止手滑在同一模块里多出第二个全局导出。
//
// 白名单 = 当前 6 个模块的既定命名空间。新增模块若需导出全局，【必须】同步更新下面
// 的 KNOWN_GLOBALS —— 这是刻意的设计：新增全局是 deliberate 动作，应让护栏显式知情，
// 而不是默默放行。
//
// 聚合进 `npm run check`（ADR-7：先本地可执行，CI 见 P1-8）。
//   node scripts/check-globals.cjs        # CLI 模式，违规即非零退出
//   const { checkGlobals } = require(...) # 单测模式

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULES_DIR = path.join(ROOT, 'src', 'modules');

// 既定命名空间白名单（每模块恰好一个）。新增模块须同步更新本集合。
const KNOWN_GLOBALS = new Set([
  'CodeBlock',
  'Dialogs',
  'Outline',
  'WordCount',
  'FindReplace',
  'PreviewPost',
  'PreviewWindow',
  'TauriApi',
  'ImageProcessor', // P1-1 新增：processImages 抽离为纯模块
  'Select', // 统一自绘下拉框组件（2026-08 引入）
  'FontPicker', // 字体选择器组件（2026-08 引入）
  'FileTypes', // 文件类型分类白名单（文件夹树 / 打开文件路由使用）
  // app.js 按职责域拆分出的功能模块（2026-09）：每模块一个命名空间，经 mixin 挂到 MarkdownEditor
  'TMConst', // 共享常量 / Tab 数据模型 / 对话框桥接（须最先加载）
  'TMI18nData', // 国际化字典数据（从 i18n.js 拆出，纯数据）
  'TMI18n', 'TMSettings', 'TMLayout', 'TMTheme', 'TMFont', 'TMShortcuts',
  'TMEditorCore', 'TMTabs', 'TMFind', 'TMMiscUI', 'TMFiles', 'TMExport',
  'TMPreviewSync', 'TMNotify', 'TMUpdater', 'TMFormat', 'TMCtxMenu', 'TMSlash',
  'TMLifecycle', 'TMToolbar',
]);

// 不锚行首：\bwindow\.[A-Z][A-Za-z0-9]*\s*=
// 注意：命名空间含数字（如 TMI18n / TMI18nData），故字符类须含 0-9，
// 否则此类全局会被正则漏匹配、既不告警也不进入白名单校验（静默失效）。
function globalAssignRe() {
  return /\bwindow\.[A-Z][A-Za-z0-9]*\s*=/g;
}

function moduleJsFiles(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.statSync(path.join(dir, f)).isFile());
}

// 纯函数核心：入参是 [{ file, source }]，输出检出结果。
// 抽出便于单测用内存数据做负向验证，无需触碰真实文件系统。
function analyzeModules(entries) {
  const perFile = {};
  const found = new Set();

  for (const { file, source } of entries) {
    const names = new Set();
    const re = globalAssignRe(); // 每文件新建，避免 lastIndex 跨文件串味
    let m;
    while ((m = re.exec(source)) !== null) {
      // m[0] 形如 "window.CodeBlock =" 或 "  window.Foo="
      const name = m[0].replace(/^\s*window\./, '').replace(/\s*=\s*$/, '').trim();
      names.add(name);
      found.add(name);
    }
    perFile[file] = [...names];
  }

  const violations = [];
  for (const g of found) {
    if (!KNOWN_GLOBALS.has(g)) {
      violations.push(`意外的全局导出 window.${g}（不在白名单，可能污染 global 或拼写错误）`);
    }
  }
  for (const [f, names] of Object.entries(perFile)) {
    if (names.length > 1) {
      violations.push(`${f} 导出了多个全局：${names.join(', ')}（每个模块应只导出一个命名空间）`);
    }
  }

  return { found: [...found].sort(), known: [...KNOWN_GLOBALS].sort(), perFile, violations };
}

function checkGlobals(dir = MODULES_DIR) {
  const entries = moduleJsFiles(dir).map((f) => ({
    file: f,
    source: fs.readFileSync(path.join(dir, f), 'utf8'),
  }));
  return analyzeModules(entries);
}

if (require.main === module) {
  const r = checkGlobals();
  if (r.violations.length) {
    console.error('❌ check-globals 失败：');
    for (const v of r.violations) console.error('  - ' + v);
    process.exit(1);
  }
  console.log('✅ check-globals 通过：全局导出均在白名单内（' + r.found.join(', ') + '）');
}

module.exports = { checkGlobals, analyzeModules, KNOWN_GLOBALS };
