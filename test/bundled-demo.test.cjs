// demo.md 打包资源与预览回归测试。
// 覆盖：根目录单一 demo、Tauri 资源配置、引用中的代码块、打包文档图片路径，
// 以及从「使用说明」打开 demo.md 的整条链接处理链路（dev/prod 兼容）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { renderMarkdown } = require('../src/unified-renderer.js');
const { withEditor } = require('./helpers/app-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('demo 资源：只保留根目录 demo.md，并随 Tauri 打包图片目录', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'demo.md')), '根目录 demo.md 必须存在');
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'demo.md')), 'src/demo.md 不应再保留重复副本');
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.deepEqual(conf.bundle.resources, {
    '../demo.md': 'demo.md',
    '../assets/icon.png': 'assets/icon.png',
  }, 'demo 与随包图标应作为资源打包（不再打包 4.4M 截图目录）');
  assert.match(read('scripts/bench-render.js'), /path\.resolve\(__dirname, '\.\.', 'demo\.md'\)/,
    '渲染基准应读取唯一的根目录 demo.md');
});

test('demo 引用中的代码：shell 围栏内容完整位于 blockquote 内', () => {
  const html = renderMarkdown(read('demo.md'));
  const start = html.indexOf('引用中的代码');
  assert.notEqual(start, -1, '应找到引用中的代码章节');
  const section = html.slice(start, start + 900);
  assert.match(section, /<blockquote[^>]*>[\s\S]*<pre><code class="language-shell"[^>]*>\s*npm run build\s*<\/code><\/pre>[\s\S]*构建产物位于/,
    'shell 代码和后续说明应保持在同一个引用块中');
  assert.doesNotMatch(section, /<\/blockquote>\s*<p[^>]*>npm run build<\/p>/,
    'npm run build 不应脱离引用块成为普通段落');
});

test('打包 demo 图片：dev 模式下 filePath 拼本地失败时回退到 read_bundled_image_as_base64', async () => {
  const calls = [];
  await withEditor({
    invokeImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      // fetch_image_as_base64 在 dev 模式对 prod filePath 拼出的路径读不到，模拟抛错
      if (cmd === 'fetch_image_as_base64') {
        throw new Error('Cannot resolve path ' + args.url);
      }
      if (cmd === 'read_bundled_image_as_base64') {
        return 'iVBORw0KGgo='; // 1x1 PNG
      }
      return undefined;
    },
  }, async (w, ed) => {
    // 模拟 dev 模式：filePath 是 prod 目录（C:\\Program Files\\TizuMark\\demo.md），
    // 本地根本不存在该目录，fetch_image_as_base64 必然失败，应回退到 read_bundled_image_as_base64。
    // isBundled: true 标记该 tab 为打包资源（使用说明/demo），只有这类 tab 才允许回退。
    ed.tabs = [{ filePath: 'C:\\Program Files\\TizuMark\\demo.md', name: 'demo.md', isBundled: true }];
    ed.activeTabIndex = 0;
    ed.preview.innerHTML = '<img src="assets/icon.png" width="400" alt="限制宽度展示">';
    await ed.processImages();
    const fetchCalls = calls.filter(c => c.cmd === 'fetch_image_as_base64');
    const bundledCalls = calls.filter(c => c.cmd === 'read_bundled_image_as_base64');
    assert.equal(fetchCalls.length, 1, 'filePath 拼路径应先尝试 fetch_image_as_base64');
    assert.equal(fetchCalls[0].args.url, 'C:\\Program Files\\TizuMark/assets/icon.png',
      '应按 dev 模式 tab.filePath 拼出图片绝对路径');
    assert.equal(bundledCalls.length, 1, 'fetch 失败后应回退到 read_bundled_image_as_base64');
    assert.equal(bundledCalls[0].args.filename, 'assets/icon.png',
      '回退时 filename 必须用原始相对路径，让 Rust 自己 dev/prod 定位');
    const img = ed.preview.querySelector('img');
    assert.ok(img.src.startsWith('data:image/png;base64,'), '回退应产出可显示的 data URI');
    assert.equal(img.getAttribute('width'), '400', 'HTML img 的 width 属性应保留');
  });
});

test('打包 demo 图片：prod 模拟 filePath 命中本地时不应回退', async () => {
  const calls = [];
  await withEditor({
    invokeImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'fetch_image_as_base64') return 'iVBORw0KGgo=';
      return undefined;
    },
  }, async (w, ed) => {
    // 模拟「demo 已保存在工作区某处」的场景：filePath 是工作区真实路径，
    // fetch_image_as_base64 读磁盘直接命中，不该再调 bundled 回退。
    ed.tabs = [{ filePath: 'D:\\workspace\\demo.md', name: 'demo.md' }];
    ed.activeTabIndex = 0;
    ed.preview.innerHTML = '<img src="assets/icon.png" alt="截图">';
    await ed.processImages();
    const bundledCalls = calls.filter(c => c.cmd === 'read_bundled_image_as_base64');
    assert.equal(bundledCalls.length, 0, '本地命中时不应回退');
    const img = ed.preview.querySelector('img');
    assert.ok(img.src.startsWith('data:image/png;base64,'), '应直接显示图片');
  });
});

test('普通本地 md 缺图：不应回退到 read_bundled_image_as_base64（isBundled 守卫）', async () => {
  const calls = [];
  await withEditor({
    invokeImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      // 本地图片缺失 → fetch_image_as_base64 抛错
      if (cmd === 'fetch_image_as_base64') {
        throw new Error('no such file ' + args.url);
      }
      // 若误回退到打包资源读取，应被本测试捕获
      if (cmd === 'read_bundled_image_as_base64') {
        return 'iVBORw0KGgo=';
      }
      return undefined;
    },
  }, async (w, ed) => {
    // 普通本地文档：有真实 filePath，但 NOT isBundled
    ed.tabs = [{ filePath: 'D:\\workspace\\note.md', name: 'note.md' }];
    ed.activeTabIndex = 0;
    ed.preview.innerHTML = '<img src="missing.png" alt="缺失图片">';
    await ed.processImages();
    const bundledCalls = calls.filter(c => c.cmd === 'read_bundled_image_as_base64');
    assert.equal(bundledCalls.length, 0, '普通本地文档缺图时绝不应回退到打包资源（避免误加载同名图标）');
    const img = ed.preview.querySelector('img');
    assert.ok(img.alt.includes('加载失败'), '缺图应标记加载失败而非误用打包资源');
  });
});

test('打包 demo 打开：应通过专用 read_bundled_file 命令读取，dev/prod 统一', () => {
  // 拆分后链接处理逻辑已移到 src/modules/misc-ui.js，静态断言需覆盖全量业务源码
  const app = require('./helpers/app-bundle.cjs').readBundle();
  // P0-2b 已将 IPC 收敛到 TauriApi.*（语义 no-op 透传），read_bundled_file 对应
  // TauriApi.readBundledFile（camelCase 包装 invoke('read_bundled_file', ...)）。
  // 这里断言链接处理走专用命令（Rust 端做 dev/prod 回退），不再手拼 resourceDir + path。
  assert.match(app, /TauriApi\.readBundledFile\(\{\s*filename:\s*normHref\s*\}\)/,
    '链接处理应调用 TauriApi.readBundledFile（read_bundled_file）而不是手拼 resourceDir + path');
  // 截取「无活动文件」分支（相对打包资源打开段）单独检查：不能在该段用 fetch(href)
  // （dev 模式 webview 根目录无 demo.md，fetch 必 404；http(s) 分支的 fetch 是另一段、不在此检查范围）
  const section = app.match(/无活动文件[\s\S]{0,1200}?\/\/ 相对打包资源[\s\S]{0,1500}?\}\s*catch \(err\)\s*\{[\s\S]{0,400}?\}\s*\}/);
  assert.ok(section, '应能定位「无活动文件」+「相对打包资源」整段代码');
  assert.doesNotMatch(section[0], /const resp = await fetch\(href\)/,
    '相对打包资源段不应再用 fetch(href) 读取 demo.md');
});

test('从使用说明打开 demo.md：click 经事件委托触发 read_bundled_file 拿到真实路径', async () => {
  const calls = [];
  await withEditor({
    invokeImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'read_bundled_file') {
        // 模拟 Rust 端 dev/prod 资源定位：返回结构化 { content, path }，path 是
        // 真实读取到的本地路径（dev = 项目根、生产 = 资源目录），供相对图片解析。
        const devRealPath = 'D:/project/tizu-mark/demo.md';
        return { content: '# 完整语法参考\n\ndev/prod 兼容测试\n', path: devRealPath };
      }
      return undefined;
    },
  }, async (w, ed) => {
    // 模拟「使用说明」bundle 资源 tab：无 filePath，走「无活动文件」分支
    ed.tabs = [{
      name: '使用说明.md',
      content: '# 使用说明\n\n[打开 Demo](demo.md)',
      savedContent: '',
      filePath: null,
      isGuide: true,
    }];
    ed.activeTabIndex = 0;
    // 桩化 _openBundledFile：仅记录被调用的参数
    let bundledArgs = null;
    ed._openBundledFile = async (href, content, filePath) => {
      bundledArgs = { href, content, filePath };
    };
    // 真实在 preview 里塞一个链接并派发 click 事件，触发 initExternalLinks 整条委托链路
    ed.preview.innerHTML = '<a href="demo.md">打开 Demo</a>';
    const a = ed.preview.querySelector('a');
    a.click();
    await new Promise(r => setTimeout(r, 50));
    // 校验 invoke 拦截：read_bundled_file 被以 filename='demo.md' 调用
    const bundledCall = calls.find(c => c.cmd === 'read_bundled_file');
    assert.ok(bundledCall, '应触发 read_bundled_file 命令');
    assert.equal(bundledCall.args.filename, 'demo.md', 'filename 必须是 demo.md');
    // 校验 _openBundledFile 被调用且 filePath 是 Rust 返回的真实路径（项目根），
    // 供 processImages 据此解析 demo.md 内相对图片。
    assert.ok(bundledArgs, '应调用 _openBundledFile');
    assert.equal(bundledArgs.href, 'demo.md', 'href 应为 demo.md');
    assert.match(bundledArgs.content, /完整语法参考/, 'content 来自 read_bundled_file 的 content 字段');
    assert.equal(bundledArgs.filePath, 'D:/project/tizu-mark/demo.md',
      'filePath 应来自 read_bundled_file 返回对象的 path 字段（dev 模式项目根）');
  });
});
