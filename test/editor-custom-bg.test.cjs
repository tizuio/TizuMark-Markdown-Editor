// 自定义页面底色：编辑+预览区用用户 RGB，按亮度自动反色；关闭恢复主题默认。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('defaultSettings 含自定义底色字段', async () => {
  await withEditor({}, async (w, ed) => {
    const d = ed.defaultSettings();
    assert.strictEqual(d.customBgEnabled, false, '默认关闭自定义底色');
    assert.strictEqual(typeof d.customBgColor, 'string', '默认底色为字符串');
  });
});

test('亮度计算：深色底色反白字，浅色底色反深字', async () => {
  await withEditor({}, async (w, ed) => {
    assert.ok(typeof ed._bgLuminance === 'function', '_bgLuminance 应存在');
    assert.ok(ed._bgLuminance('#000000') < 128, '黑底亮度低于阈值');
    assert.ok(ed._bgLuminance('#ffffff') >= 128, '白底亮度达到阈值');
  });
});

test('applyCustomBg：开启时设置 --custom-bg/--custom-fg，关闭时清除', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.customBgEnabled = true;
    ed.settings.customBgColor = '#000000';
    ed.applyCustomBg();
    const html = w.document.documentElement;
    assert.strictEqual(html.style.getPropertyValue('--custom-bg').trim(), '#000000', '应设置底色变量');
    assert.ok(html.style.getPropertyValue('--custom-fg').trim(), '应设置前景变量');
    assert.ok(w.document.body.classList.contains('custom-bg-active'), 'body 应加 custom-bg-active 类');

    ed.settings.customBgEnabled = false;
    ed.applyCustomBg();
    assert.strictEqual(html.style.getPropertyValue('--custom-bg').trim(), '', '关闭后应清除底色变量');
    assert.ok(!w.document.body.classList.contains('custom-bg-active'), '关闭后应移除类名');
  });
});
