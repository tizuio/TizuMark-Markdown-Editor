# 编辑器三项小改进 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现三项独立小改进——①会话级记住 Markdown 展示模式；②自定义页面底色（编辑+预览区，按亮度反色）；③退出时自动关闭所有标签。

**架构：** 三项改动全部落在 `src/app.js`（数据模型 + 行为），辅以 `src/index.html`（设置面板行）与 `src/styles.css`（底色变量覆盖）。遵循现有 `defaultSettings()` / 设置面板 `Select` / `syncSettingsControls()` / `applySettings()` 的既有模式，不做抽象重构（YAGNI）。

**技术栈：** 原生 JS（无新依赖），测试用 `node:test` + `test/helpers/app-env.cjs` 的 `withEditor` harness。

---

## 文件结构

- 修改：`src/app.js` — 三项需求的行为与设置字段
- 修改：`src/index.html` — 需求 2、3 的设置面板行
- 修改：`src/styles.css` — 需求 2 的编辑/预览区底色覆盖
- 新增：`test/editor-session-viewmode.test.cjs` — 需求 1 测试
- 新增：`test/editor-custom-bg.test.cjs` — 需求 2 测试
- 新增：`test/editor-clear-tabs-on-quit.test.cjs` — 需求 3 测试

---

## 任务 1：会话级记住 Markdown 展示模式

**文件：**
- 修改：`src/app.js`（构造函数字段、`setViewMode` 10727-10768、`syncViewModeToTab` 10706-10725）
- 测试：`test/editor-session-viewmode.test.cjs`

### 步骤 1：编写失败测试

创建 `test/editor-session-viewmode.test.cjs`：

```js
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
```

### 步骤 2：运行测试验证失败

运行：`node scripts/run-tests.cjs editor-session-viewmode`
预期：三用例均 FAIL（`ed._sessionMdViewMode` 为 undefined；`setViewMode` 不记录；md 分支仍用 defaultView）

### 步骤 3：编写最少实现代码

在 `src/app.js` 构造函数中 `this.viewMode = 'preview';`（约 1122 行）之后新增一行：

```js
    this.viewMode = 'preview';
    this._sessionMdViewMode = null;  // 会话级 md 展示模式记忆：仅内存，不落盘；null=未记录（用 settings.defaultView）
```

在 `setViewMode(mode)` 中，找到 `if (this.viewMode === mode) return;`（约 10737 行）之后、`this.viewMode = mode;`（约 10766 行）之前，在守卫通过后记录。更精确位置：把 `this.viewMode = mode;` 这一行替换为：

```js
    this.viewMode = mode;
    // 会话级 md 模式记忆：仅当当前 tab 有 filePath 且为 markdown 时记录，
    // 无路径的新建文档（kind 兜底 markdown）不记录；图片/txt 不触碰记忆，
    // 这样「其他格式按特殊展示 → 再切回 md」仍沿用之前的 md 记忆。
    if (_tab && _tab.filePath && window.FileTypes && window.FileTypes.classifyFile) {
      if (window.FileTypes.classifyFile(_tab.filePath) === 'markdown') {
        this._sessionMdViewMode = mode;
      }
    }
```

> 说明：`setViewMode` 开头已声明 `_tab` 与 `_kind`（10730-10733），此处复用。

在 `syncViewModeToTab()` 中（约 10706 行），把 md 分支：

```js
    else target = this.settings.defaultView || 'preview'; // 有路径的 markdown 跟随设置默认视图
```

替换为：

```js
    else target = this._sessionMdViewMode || this.settings.defaultView || 'preview'; // md：会话记忆优先，其次默认视图
```

### 步骤 4：运行测试验证通过

运行：`node scripts/run-tests.cjs editor-session-viewmode`
预期：全部 PASS

再确认无回归：`node scripts/run-tests.cjs app-tabs`

### 步骤 5：Commit

```bash
git add src/app.js test/editor-session-viewmode.test.cjs
git commit -m "feat: 会话级记住 Markdown 展示模式（图片/txt 特殊类型优先，启动用默认视图）"
```

---

## 任务 2：自定义页面底色（编辑+预览区，按亮度反色）

**文件：**
- 修改：`src/app.js`（`defaultSettings` 1773、`syncSettingsControls` 1881、`initSettings` 1942、`applyCustomBg` 新方法、`applySettings` 3026 接线）
- 修改：`src/index.html`（「预览」分区新增设置行，约 1044-1051 行号范围）
- 修改：`src/styles.css`（编辑/预览区底色变量覆盖规则）
- 测试：`test/editor-custom-bg.test.cjs`

### 步骤 1：编写失败测试

创建 `test/editor-custom-bg.test.cjs`：

```js
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
    // 亮度 = 0.299R+0.587G+0.114B；阈值 128
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
```

### 步骤 2：运行测试验证失败

运行：`node scripts/run-tests.cjs editor-custom-bg`
预期：FAIL（`customBgEnabled` 未定义、`_bgLuminance`/`applyCustomBg` 不存在）

### 步骤 3：编写最少实现代码

#### 3a. `defaultSettings()` 新增字段（对象内 `codeFont` 行之后加逗号并追加）：

```js
      codeFont: '', // 预览代码块（行内代码 + 围栏代码块）字体，存自定义字体 id，空=跟随等宽默认
      customBgEnabled: false, // 自定义页面底色开关：开启时编辑+预览区用 customBgColor，文字按亮度反色
      customBgColor: '#f8f7f4', // 自定义底色（16 进制 RGB）
```

#### 3b. `syncSettingsControls()` 末尾（`settings-image-asset-path` 那一行之后）追加：

```js
    document.getElementById('set-custom-bg').checked = s.customBgEnabled === true;
    const cbg = document.getElementById('set-custom-bg-color');
    if (cbg) cbg.value = s.customBgColor || '#f8f7f4';
```

#### 3c. 新增方法 `applyCustomBg()` 与 `_bgLuminance()`（放在 `applySettings()` 之前，约 3026 行前）：

```js
  // 按 RGB 16 进制计算感知亮度（ITU-R BT.601），越接近 255 越亮。
  _bgLuminance(hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
    if (!m) return 255;
    const v = parseInt(m[1], 16);
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  // 自定义页面底色：编辑+预览区背景用 customBgColor，文字按亮度反色。
  // 实现：在 <html> 上设 --custom-bg/--custom-fg，styles.css 里这两变量优先覆盖编辑/预览区；
  // body 加 custom-bg-active 类作为开关标记。关闭时清除变量与类，恢复主题默认。
  applyCustomBg() {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;
    if (this.settings.customBgEnabled) {
      const bg = this.settings.customBgColor || '#f8f7f4';
      const lum = this._bgLuminance(bg);
      const fg = lum >= 128 ? '#2c2c2e' : '#d1d2d6';
      root.style.setProperty('--custom-bg', bg);
      root.style.setProperty('--custom-fg', fg);
      body.classList.add('custom-bg-active');
    } else {
      root.style.removeProperty('--custom-bg');
      root.style.removeProperty('--custom-fg');
      body.classList.remove('custom-bg-active');
    }
  }
```

#### 3d. `applySettings()` 在 `await this.applyThemeMode();` 之后加一行：

```js
    await this.applyThemeMode();
    this.applyCustomBg();
```

#### 3e. `initSettings()` 中新增控件接线（在 `retryBtn` 接线之后、`loadSystemFonts` 之前，约 2219 行附近）：

```js
    const cbgToggle = document.getElementById('set-custom-bg');
    if (cbgToggle) cbgToggle.addEventListener('change', (e) => {
      this.settings.customBgEnabled = e.target.checked;
    });
    const cbgColor = document.getElementById('set-custom-bg-color');
    if (cbgColor) cbgColor.addEventListener('input', (e) => {
      this.settings.customBgColor = e.target.value;
    });
```

#### 3f. `src/index.html`「预览」分区，在「代码块滚动条」设置行之后追加一行：

```html
          <div class="settings-row">
            <label>自定义底色</label>
            <div style="display:flex;align-items:center;gap:8px">
              <label class="toggle"><input type="checkbox" id="set-custom-bg"><span class="toggle-slider"></span></label>
              <input type="color" id="set-custom-bg-color" value="#f8f7f4" style="width:36px;height:26px;border:1px solid var(--border-color);border-radius:4px;padding:0;background:transparent;cursor:pointer">
            </div>
          </div>
```

#### 3g. `styles.css` 追加覆盖规则（文件末尾）：

```css
/* 自定义页面底色：仅覆盖编辑区与预览区，侧边栏/工具栏不变。--custom-bg/--custom-fg 由 JS 设置，缺省时回退主题变量。 */
body.custom-bg-active #editor-wrapper .CodeMirror,
body.custom-bg-active #editor-wrapper .CodeMirror .CodeMirror-gutters {
  background-color: var(--custom-bg, var(--bg-primary)) !important;
}
body.custom-bg-active #editor-wrapper .CodeMirror {
  color: var(--custom-fg, var(--text-primary));
}
body.custom-bg-active #preview,
body.custom-bg-active .preview-content {
  background-color: var(--custom-bg, var(--bg-primary)) !important;
  color: var(--custom-fg, var(--text-primary));
}
```

### 步骤 4：运行测试验证通过

运行：`node scripts/run-tests.cjs editor-custom-bg editor-theme-bg`
预期：全部 PASS（含既有主题契约测试不回归）

### 步骤 5：Commit

```bash
git add src/app.js src/index.html src/styles.css test/editor-custom-bg.test.cjs
git commit -m "feat: 设置增加自定义页面底色（编辑+预览区，按亮度自动反色）"
```

---

## 任务 3：退出时自动关闭所有标签（干净启动）

**文件：**
- 修改：`src/app.js`（`defaultSettings` 1773、`syncSettingsControls` 1881、`handleAppClose` 12559）
- 修改：`src/index.html`（「行为」分区「关闭窗口时」之后新增开关）
- 测试：`test/editor-clear-tabs-on-quit.test.cjs`

### 步骤 1：编写失败测试

创建 `test/editor-clear-tabs-on-quit.test.cjs`：

```js
// 退出时自动关闭所有标签：clearTabsOnQuit=true 时退出不保存会话（下次空白启动）；
// =false 时保持现有 saveSession 行为；hideToTray（最小化托盘）不受影响。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('clearTabsOnQuit=true：退出时移除 session，不再 saveSession', async () => {
  await withEditor({}, async (w, ed) => {
    ed.settings.clearTabsOnQuit = true;
    ed.settings.closeAction = 'quit';
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
```

### 步骤 2：运行测试验证失败

运行：`node scripts/run-tests.cjs editor-clear-tabs-on-quit`
预期：测试 1 FAIL（`clearTabsOnQuit` 未定义，走了 saveSession 分支）；测试 2 PASS（默认行为）；测试 3 PASS

### 步骤 3：编写最少实现代码

#### 3a. `defaultSettings()` 在 `closeAction: 'ask',` 之后追加：

```js
      closeAction: 'ask',
      clearTabsOnQuit: false, // 退出应用时不保存标签会话，下次打开总是空白
```

#### 3b. `syncSettingsControls()` 末尾追加：

```js
    document.getElementById('set-clear-tabs-on-quit').checked = s.clearTabsOnQuit === true;
```

#### 3c. `handleAppClose()` 中，找到 `// 2. 保存会话\n      this.saveSession();`（约 12594-12595），替换为：

```js
      // 2. 保存会话（除非开启「退出时关闭所有标签」）
      if (this.settings.clearTabsOnQuit) {
        try { localStorage.removeItem('tizumark-session'); } catch (_) {}
      } else {
        this.saveSession();
      }
```

#### 3d. `src/index.html`「行为」分区，「关闭窗口时」设置行之后追加：

```html
          <div class="settings-row">
            <label>退出时关闭所有标签</label>
            <label class="toggle"><input type="checkbox" id="set-clear-tabs-on-quit"><span class="toggle-slider"></span></label>
          </div>
```

> 控件接线无需新增 JavaScript：采用与现有 toggle（如 `set-scroll-sync`）一致的「applySnapshot 从 settings 读取」模式。`syncSettingsControls()` 负责读入已覆盖；写入 `this.settings.clearTabsOnQuit` 需在 `initSettings()` 增加一行事件绑定（参考既有 `set-line-wrap` 的绑定方式）。

在 `initSettings()` 中（遵循既有 toggle 绑定位置），追加：

```js
    const ctoq = document.getElementById('set-clear-tabs-on-quit');
    if (ctoq) ctoq.addEventListener('change', (e) => { this.settings.clearTabsOnQuit = e.target.checked; });
```

### 步骤 4：运行测试验证通过

运行：`node scripts/run-tests.cjs editor-clear-tabs-on-quit app-session`
预期：全部 PASS

### 步骤 5：Commit

```bash
git add src/app.js src/index.html test/editor-clear-tabs-on-quit.test.cjs
git commit -m "feat: 设置增加退出时关闭所有标签（干净启动，仍提示未保存）"
```

---

## 收尾验证

```bash
npm run check
node scripts/run-tests.cjs
```

预期：`check`（全局检查 + 版本一致性 + 入口脚本测试）与全部测试通过，无回归。
