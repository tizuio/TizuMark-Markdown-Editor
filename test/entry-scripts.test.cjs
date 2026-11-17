// 护栏（T9 / N15）：src/index.html 的模块脚本清单 必须 与 src/modules/ 目录 双向一致。
//
// 这是 P0-2a（建 tauri-api.js 并加 <script> 标签）的安全带 —— 漏加一个 <script> 标签时，
// 本测试立刻变红，而不是"54 个测试全绿 + 真机白屏"那种最难自查的失效。
//
// 实现严格按 N24/N25 四条规范，否则一写出来就是假的红：
//   ① 枚举必须 statSync().isFile() 过滤 —— src/lib/highlight.js 是目录但名字带 .js 后缀；
//   ② 双向相等【只对 src/modules/ 生效】（新增模块高频动作、N15 命中面）；
//   ③ src/lib/ 只做【单向包含】（unified-bundle.js / md-links.js 必须在清单内，绝不反向枚举
//      vendor 目录里那几百个 js）；
//   ④ 顺序断言【只限业务 8 条】（6 模块 + 2 lib + app.js）都在 app.js 之前，
//      不牵扯 367-393 的 27 条 vendor，且【不断言模块之间的相对顺序】
//      （生产 / 测试字典序今天就已不同，preview-post 生产第 2 / 测试第 5，N25）。
//
// 纯 node 静态解析，不依赖 harness / DOM。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'index.html');
const MODULES_DIR = path.join(ROOT, 'src', 'modules');
const LIB_DIR = path.join(ROOT, 'src', 'lib');

// 提取 index.html 中所有 <script src="..."> 的 src（单/双引号都兼容；不匹配无 src 的 inline 脚本）
function scriptSrcs(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// ① 目录侧：仅取 .js 且为【文件】的条目（排除 highlight.js 这种"名字带 .js 的目录"）
function moduleJsFiles() {
  return fs.readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.statSync(path.join(MODULES_DIR, f)).isFile())
    .map((f) => 'modules/' + f)
    .sort();
}

// ② 双向相等：src/modules/ 目录内容 == index.html 的 modules 脚本清单
test('src/modules 目录 与 index.html 的 modules 脚本清单 双向相等', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const srcs = scriptSrcs(html);

  const dirModules = moduleJsFiles();
  const htmlModules = srcs.filter((s) => s.startsWith('modules/')).sort();

  assert.deepStrictEqual(
    htmlModules,
    dirModules,
    'index.html 的 modules 脚本清单 与 src/modules/ 目录不一致：' +
      '可能新增模块漏加 <script>，或目录里有未被清单引用的残留 .js 文件',
  );
});

// ③ src/lib/ 只做单向包含：unified-bundle.js / md-links.js 必须在清单内
test('src/lib 关键文件（unified-bundle.js / md-links.js）必须在 index.html 清单内', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const srcs = scriptSrcs(html);
  for (const need of ['lib/unified-bundle.js', 'lib/md-links.js']) {
    assert.ok(srcs.includes(need), `index.html 缺少必须的 <script src="${need}">`);
  }
});

// ④ 业务 8 条（6 模块 + 2 lib）全部位于 app.js 之前；【不断言模块之间的相对顺序】（N25）
test('业务脚本（6 模块 + 2 lib）全部位于 app.js 之前', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const srcs = scriptSrcs(html);

  const appIdx = srcs.indexOf('app.js');
  assert.ok(appIdx !== -1, 'index.html 缺少 app.js，无法定位业务脚本顺序基准');

  const business = ['lib/unified-bundle.js', 'lib/md-links.js', ...moduleJsFiles()];
  for (const s of business) {
    const i = srcs.indexOf(s);
    assert.ok(i !== -1, `index.html 缺少业务脚本 ${s}`);
    assert.ok(i < appIdx, `业务脚本 ${s} 必须位于 app.js 之前（实际在 app.js 之后或同位置）`);
  }
  // 注意：此处故意只断言"都在 app.js 之前"，【不】断言 business 内部相对顺序。
  // 生产 index.html 与 harness readdirSync 的字典序今天就已不同（N25），
  // 顺序不敏感由"新模块一律延迟求值"的设计保证，写进 ARCHITECTURE.md，不靠测试。
});

// ⑤ 多窗口撕离入口（tab-tearoff-window）：multi-window.js 在 constants.js 之后加载
//    （TMMultiWindow 不依赖 TMConst，但保持"基础模块在前"的清单习惯），tab 右键菜单
//    必须含「在新窗口打开」动作项（T4 的 executeMenuAction 'tab-open-in-window' 与之对齐）。
test('多窗口: multi-window.js 在 constants.js 之后,tab 菜单含 tab-open-in-window', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const srcs = scriptSrcs(html);
  const mwIdx = srcs.indexOf('modules/multi-window.js');
  assert.ok(mwIdx !== -1, 'index.html 缺少 modules/multi-window.js <script>');
  const constIdx = srcs.indexOf('modules/constants.js');
  assert.ok(constIdx !== -1, 'index.html 缺少 modules/constants.js,顺序断言无基准');
  assert.ok(mwIdx > constIdx, 'multi-window.js 应位于 constants.js 之后（基础模块在前）');

  const menuStart = html.indexOf('id="context-menu-tab"');
  assert.ok(menuStart !== -1, 'index.html 缺少 #context-menu-tab');
  // 以下一个菜单/区块开头为界,取本菜单片段(避免全文匹配误伤其它 data-action)
  const menuEnd = html.indexOf('id="context-menu-', menuStart + 10);
  const menuHtml = html.slice(menuStart, menuEnd === -1 ? menuStart + 4000 : menuEnd);
  assert.ok(
    /data-action="tab-open-in-window"/.test(menuHtml),
    '#context-menu-tab 缺少 data-action="tab-open-in-window" 菜单项',
  );
});
