// 会话级 md 展示模式记忆：用户在一个 md 切换视图后，后续切换到其他 md 沿用该模式；
// 图片强制预览、非 md 明文强制编辑不受影响；仅软件启动（记忆为空）时 md 用 settings.defaultView。
// 与现有测试惯例一致：tabs 用普通对象（{ name, filePath, kind, content, ... }），
// filePath 后缀决定 window.FileTypes.classifyFile 的结果（md→markdown / png→image / txt→text）。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('会话级 md 模式记忆：md 切成编辑后，其他 md 也保持编辑', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.defaultView = 'preview';
    ed.tabs = [
      { filePath: '/a.md', name: 'a.md', kind: 'markdown', content: 'a', _loaded: true },
      { filePath: '/b.md', name: 'b.md', kind: 'markdown', content: 'b', _loaded: true },
    ];
    ed.activeTabIndex = 0;

    ed.setViewMode('edit');
    assert.strictEqual(ed.viewMode, 'edit', '第一个 md 应切到编辑');
    assert.strictEqual(ed._sessionMdViewMode, 'edit', '会话记忆应记录为 edit');

    // 切到第二个 md：syncViewModeToTab 应沿用 edit，而非 defaultView(preview)
    ed.activeTabIndex = 1;
    ed.syncViewModeToTab();
    assert.strictEqual(ed.viewMode, 'edit', '第二个 md 应沿用会话记忆 edit');

    ed.setViewMode('preview');
    assert.strictEqual(ed._sessionMdViewMode, 'preview', '手动切 preview 后记忆应更新');
  });
});

test('会话级 md 模式记忆：图片强制预览、txt 强制编辑，不污染 md 记忆', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.defaultView = 'preview';
    ed.tabs = [
      { filePath: '/a.md', name: 'a.md', kind: 'markdown', content: 'a', _loaded: true },
      { filePath: '/x.png', name: 'x.png', kind: 'image', content: '', _loaded: true },
      { filePath: '/z.txt', name: 'z.txt', kind: 'text', content: 'z', _loaded: true },
    ];
    ed.activeTabIndex = 0;
    ed.setViewMode('edit'); // md 记忆 = edit

    ed.activeTabIndex = 1; ed.syncViewModeToTab(); // 图片
    assert.strictEqual(ed.viewMode, 'preview', '图片应强制预览');
    assert.strictEqual(ed._sessionMdViewMode, 'edit', '图片切换不应污染 md 记忆');

    ed.activeTabIndex = 2; ed.syncViewModeToTab(); // txt
    assert.strictEqual(ed.viewMode, 'edit', 'txt 应强制编辑');

    ed.activeTabIndex = 0; ed.syncViewModeToTab(); // 回到 md
    assert.strictEqual(ed.viewMode, 'edit', '回到 md 应恢复会话记忆 edit（而非 defaultView=preview）');
  });
});

test('会话级 md 模式记忆：初始为空时 md 用 settings.defaultView', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.defaultView = 'edit';
    ed.tabs = [{ filePath: '/a.md', name: 'a.md', kind: 'markdown', content: 'a', _loaded: true }];
    ed.activeTabIndex = 0;
    ed._sessionMdViewMode = null; // 模拟刚启动
    ed.syncViewModeToTab();
    assert.strictEqual(ed.viewMode, 'edit', '记忆为空时 md 应跟随 defaultView');
  });
});

test('会话级 md 模式记忆：md 预览态下新建文档（newFile）不应污染记忆', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.defaultView = 'preview';
    ed.tabs = [{ filePath: '/a.md', name: 'a.md', kind: 'markdown', content: 'a', _loaded: true }];
    ed.activeTabIndex = 0;
    ed._sessionMdViewMode = null; // 刚启动，尚未手动切换

    ed.newFile();

    assert.strictEqual(ed._sessionMdViewMode, null, 'newFile 不应把会话记忆写成 edit');
  });
});

test('会话级 md 模式记忆：openFilePath 打开新 md 也应沿用会话记忆（而非 defaultView）', async () => {
  await withEditor({ invokeImpl: async (cmd) => {
    if (cmd === 'read_file') return '# 新文件内容\n\n正文';
    if (cmd === 'file_meta') return { size: 10, mtime: 0 };
    return undefined;
  } }, async (w, ed) => {
    ed.settings.defaultView = 'preview';
    // 先让用户在一个 md 上切到编辑，产生会话记忆
    ed.tabs = [{ filePath: '/a.md', name: 'a.md', kind: 'markdown', content: 'a', _loaded: true }];
    ed.activeTabIndex = 0;
    ed.setViewMode('edit');
    assert.strictEqual(ed._sessionMdViewMode, 'edit', '前置：记忆应为 edit');

    // 通过 openFilePath 打开另一个 md（走真实读盘路径）
    await ed.openFilePath('/b.md');

    assert.strictEqual(ed._sessionMdViewMode, 'edit', 'openFilePath 不应清空记忆');
    assert.strictEqual(ed.viewMode, 'edit', 'openFilePath 打开的新 md 应沿用会话记忆 edit（而非 defaultView=preview）');
  });
});
