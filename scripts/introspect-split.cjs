// 运行时自省：在 jsdom 中加载完整 app.js + 所有模块，确认 mixin 方法真正挂到
// MarkdownEditor.prototype，且跨模块 this.xxx() 目标方法存在（避免“源码有、运行时漏挂”）。
const { buildEnv, cleanup, waitForEditor } = require('../test/helpers/app-env.cjs');

const CRITICAL = [
  // 来自各模块的招牌方法（每个模块至少一个，覆盖全部 20 模块 + 框架）。
  // 名称以源码中真实方法名为准（此前误用的名称已据 grep 核实更正）。
  't', 'applyLanguage',            // i18n
  'loadSettings',                  // settings
  'applySidebarState', 'toggleSidebar', 'showSidebar', // layout
  'loadTheme',                     // theme
  'applyCustomFonts',              // font
  'loadShortcuts',                 // shortcuts
  'initEditor',                    // editor-core
  'loadRecentFiles',               // tabs
  'toggleFindPanel',               // find
  'showInsertLinkDialog',          // misc-ui
  'newFile',                       // files
  'exportHTML', 'exportWord',      // export
  'debounceUpdatePreview',         // preview-sync
  'showToast',                     // notify
  'showUpdateDialog',              // updater
  'wrapSelection',                 // format
  'showContextMenu',               // context-menu
  'showSlashOrderDialog',          // slash
  'handleAppClose',                // lifecycle
  'initFormatToolbar',             // toolbar
  'initEventListeners',            // framework (app.js)
];

(async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  const proto = Object.getPrototypeOf(ed);
  const protoMethods = Object.getOwnPropertyNames(proto).filter((k) => {
    if (k === 'constructor') return false;
    const d = Object.getOwnPropertyDescriptor(proto, k);
    // 仅统计方法/访问器名称，不执行 getter（执行会触发 this.tabs 等未就绪状态报错）
    return !!(d && (typeof d.value === 'function' || d.get || d.set));
  });
  const set = new Set(protoMethods);

  const missing = CRITICAL.filter((m) => !set.has(m));
  console.log('原型方法总数:', protoMethods.length);
  console.log('自检关键方法数:', CRITICAL.length);
  if (missing.length === 0) {
    console.log('✅ 全部关键方法均已挂载到 MarkdownEditor.prototype');
  } else {
    console.log('❌ 缺失关键方法:', missing.join(', '));
  }

  // 跨模块调用探针：在编辑器实例上逐一调用“存在性 + 可 typeof”检查已在上面完成；
  // 再对几个只读/纯查询方法做实际调用，验证 this.xxx() 链路通畅。
  const calls = [];
  try {
    const r1 = ed.t('file'); // i18n 模块
    calls.push(`t('file') => ${JSON.stringify(r1)}`);
  } catch (e) { calls.push('t() threw: ' + e.message); }
  try {
    const r2 = typeof ed.getActiveTab === 'function' ? ed.getActiveTab() : (ed.activeTab);
    calls.push(`activeTab => ${JSON.stringify(r2 && r2.name !== undefined ? r2.name : r2)}`);
  } catch (e) { calls.push('activeTab threw: ' + e.message); }
  try {
    const r3 = ed.getTabCount ? ed.getTabCount() : (ed.tabs ? ed.tabs.length : 'n/a');
    calls.push(`tabCount => ${JSON.stringify(r3)}`);
  } catch (e) { calls.push('tabCount threw: ' + e.message); }

  console.log('跨模块调用探针:');
  calls.forEach((c) => console.log('  - ' + c));

  cleanup(w);
  process.exit(missing.length === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
