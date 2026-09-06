// exportHTML 图片内联回归测试
// 根因：预览里 img.src 已被 processImages 经 getCachedImageURL 缓存成 blob: URL，
// 而旧 exportHTML 对 data:/http(s):/file:///blob: 一律跳过、只处理「纯相对路径」，
// 导致导出的 HTML 保留了打开即失效的 blob: URL → 图片空白。
// 修复：blob: 用 fetch 还原为内联 base64；file:// 走 Rust 读磁盘；纯相对路径按文档目录读；
// data:/http(s): 保留。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('exportHTML: 相对路径图片内联为 base64，data:/http(s): 保留', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'fetch_image_as_base64') return 'BASE64DATA';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML =
      '<p>文本</p>' +
      '<img src="images/a.png">' +
      '<img src="data:image/png;base64,EXISTING">' +
      '<img src="https://example.com/b.png">';

    await ed.exportHTML();

    assert.ok(captured.content, '应调用 write_file 写入 HTML');
    const c = captured.content;
    assert.ok(c.includes('data:image/png;base64,BASE64DATA'), '相对路径图片应内联为 base64');
    assert.ok(c.includes('data:image/png;base64,EXISTING'), 'data: 图片应保留');
    assert.ok(c.includes('https://example.com/b.png'), 'http(s): 图片应保留');
    assert.ok(!c.includes('src="images/a.png"'), '原相对路径不应再保留');
  });
});

test('exportHTML: file:// 图片也内联为 base64（不再被跳过）', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'fetch_image_as_base64') return 'FILEB64';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<img src="file:///C:/docs/assets/c.png">';

    await ed.exportHTML();

    const c = captured.content;
    assert.ok(c.includes('data:image/png;base64,FILEB64'), 'file:// 图片应内联为 base64');
    assert.ok(!c.includes('file:///C:/docs/assets/c.png'), '原 file:// 路径不应保留');
  });
});

test('exportHTML: 无 filePath 时不解析相对路径，但不报错', async () => {
  // 未保存文档（无 filePath）时，相对路径无法解析，应保留原 src 且不抛错。
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed.activeTab.filePath = null; // 未保存
    w.editor.preview.innerHTML = '<img src="images/a.png">';

    await ed.exportHTML(); // 不应抛错

    assert.ok(captured.content, '无 filePath 也应写出 HTML');
    assert.ok(captured.content.includes('src="images/a.png"'), '无 filePath 时保留原相对路径 src');
  });
});

test('exportHTML: blob: 图片还原为内联 base64（processImages 缓存场景）', async () => {
  // 模拟真实预览：img.src 是 processImages 经 getCachedImageURL 生成的 blob: URL。
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<img src="blob:http://localhost/abc-123">';
    // 拦截 fetch，让 blob: 拉取返回可转 data URI 的 blob 响应
    w.fetch = async (url) => {
      assert.ok(String(url).startsWith('blob:'), '应按 blob: 拉取');
      return {
        ok: true,
        blob: async () => new w.Blob(['hello'], { type: 'image/png' }),
      };
    };

    await ed.exportHTML();

    const c = captured.content;
    assert.ok(c.includes('data:image/png;base64,'), 'blob: 应被还原为内联 data URI');
    assert.ok(!c.includes('blob:http'), 'blob: 不应再出现在导出 HTML 中');
  });
});

test('exportHTML: blob: fetch 失败（CSP 拦截）时从缓存反查 data URI 兜底', async () => {
  // 发行版曾因 CSP connect-src 缺 blob: 导致 fetch(blob:) 被拦截 → 导出保留失效 blob → 破图。
  // 兜底：fetch 失败时遍历 _imageURLCache（dataUri→blobUrl）反查原始 data URI。
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    ed.activeTab.filePath = '/docs/note.md';
    // 模拟真实预览缓存：data URI → blob URL（getCachedImageURL 的正向映射）
    const dataUri = 'data:image/png;base64,REALB64';
    ed._imageURLCache = new Map([[dataUri, 'blob:http://tauri.localhost/xyz-999']]);
    w.editor.preview.innerHTML = '<img src="blob:http://tauri.localhost/xyz-999">';
    // 模拟 CSP 拦截 fetch(blob:)：抛错（与发行版 CSP 缺失时行为一致）
    w.fetch = async () => { throw new Error('Failed to fetch (CSP)'); };

    await ed.exportHTML();

    const c = captured.content;
    assert.ok(c.includes('data:image/png;base64,REALB64'), 'fetch 失败时应从缓存反查内联 data URI');
    assert.ok(!c.includes('blob:http'), 'blob: 不应再出现在导出 HTML 中');
  });
});
