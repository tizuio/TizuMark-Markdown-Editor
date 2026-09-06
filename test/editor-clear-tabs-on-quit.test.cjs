// 退出时自动关闭所有标签：clearTabsOnQuit=true 时退出不保存会话（下次空白启动）；
// =false 时保持现有 saveSession 行为；hideToTray（最小化托盘）不受影响。
// 注：首次启动会打开「使用说明」/demo.md 标签且可能处于已修改状态（isModified=true），
// 若直接退出，handleAppClose 会先走未保存确认（保存/丢弃/取消）。本测试聚焦 clearTabsOnQuit
// 对「保存会话」步骤的开关作用，故先把这些首启标签的 savedContent 对齐为 content，
// 使 modified 为空、跳过确认弹窗（确认弹窗行为本身不受本设置影响，属既有逻辑）。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('clearTabsOnQuit=true：退出时移除 session，不再 saveSession', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.clearTabsOnQuit = true;
    ed.settings.closeAction = 'quit';
    for (const t of ed.tabs) t.savedContent = t.content;
    let saved = false;
    ed.saveSession = () => { saved = true; };
    w.localStorage.setItem('tizumark-session', '{"version":2,"tabs":[{"name":"a","filePath":"/a.md"}]}');

    await ed.handleAppClose();

    assert.strictEqual(saved, false, 'clearTabsOnQuit 时不应调用 saveSession');
    assert.strictEqual(w.localStorage.getItem('tizumark-session'), null, '应移除 session');
  });
});

test('clearTabsOnQuit=false：退出时仍 saveSession', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.clearTabsOnQuit = false;
    ed.settings.closeAction = 'quit';
    for (const t of ed.tabs) t.savedContent = t.content;
    let saved = false;
    ed.saveSession = () => { saved = true; };

    await ed.handleAppClose();

    assert.strictEqual(saved, true, '默认（false）应调用 saveSession');
  });
});

test('hideToTray 不因 clearTabsOnQuit 而清 session', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.clearTabsOnQuit = true;
    let saved = false;
    ed.saveSession = () => { saved = true; };

    await ed.hideToTray();

    assert.strictEqual(saved, true, '托盘最小化仍应 saveSession');
  });
});
