/**
 * 大文档提示条「不再提醒」——接线回归测试（node 级，随处可跑，不依赖浏览器）
 *
 * 为什么有这个测试：
 *   app.js 是经典脚本，无法在 jsdom 里实例化（会拉起 CodeMirror/Tauri），
 *   端到端交互由 test/browser/large-file-banner.test.cjs（需真实 Chrome）覆盖，
 *   而 CI（ubuntu）与缺少浏览器环境时会被跳过。本测试作为「接线守卫」，用静态
 *   文本 + index.html DOM 解析确认三个易回归点仍在：
 *     ① index.html 的按钮存在且 class 正确；
 *     ② styles.css 有对应样式规则；
 *     ③ app.js 里 I18N 双语文案、会话级拦截逻辑、点击绑定都还在。
 *
 * 它不是行为测试，但能保证「有人误删按钮/拦截行/I18N」时在 CI 立即变红。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
// 拆分后业务代码分布在 src/modules/，静态断言需覆盖全部源码（按 index.html 顺序拼接）
const appJs = require('./helpers/app-bundle.cjs').readBundle();

let failed = 0;
function check(name, cond) {
  if (cond) { console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name); failed++; }
}

// ① index.html 按钮存在且 class 正确
const btnTag = /<button\s+id="large-file-banner-dont-remind"\s+class="large-file-banner-dont-remind"[^>]*>/.test(indexHtml);
check('index.html 含 #large-file-banner-dont-remind 按钮且 class 正确', btnTag);
check('「不再提醒」在「关闭」左边、「关闭」在最右侧',
  indexHtml.indexOf('large-file-banner-dont-remind') < indexHtml.indexOf('large-file-banner-close'));
// 关闭按钮改为与「不再提醒」同款文字按钮（样式一致，不再用 × 图标）
const closeBtn = indexHtml.match(/<button\s+id="large-file-banner-close"[^>]*>([\s\S]*?)<\/button>/);
check('关闭按钮复用 large-file-banner-dont-remind 样式（与不再提醒同款）',
  /<button\s+id="large-file-banner-close"\s+class="large-file-banner-dont-remind"/.test(indexHtml));
check('关闭按钮可见文字为「关闭」（非 × 图标）',
  closeBtn && closeBtn[1].trim() === '关闭');
check('旧 .large-file-banner-close 样式已移除（统一为 dont-remind 样式）',
  !/\.large-file-banner-close\s*\{/.test(stylesCss) && !/\.large-file-banner-close:hover/.test(stylesCss));

// ② styles.css 有对应样式规则（含伪类 hover）
check('styles.css 定义 .large-file-banner-dont-remind 基础样式', /\.large-file-banner-dont-remind\s*\{/.test(stylesCss));
check('styles.css 定义 .large-file-banner-dont-remind:hover', /\.large-file-banner-dont-remind:hover\s*\{/.test(stylesCss));

// ③ app.js I18N 双语文案
check('app.js zh 含 dontRemind: 不再提醒', /dontRemind:\s*'不再提醒'/.test(appJs));
check("app.js en 含 dontRemind: Don't remind", /dontRemind:\s*"Don't remind"/.test(appJs));
check('app.js 通过 setTitle 绑定 dontRemind 文案',
  /setTitle\('large-file-banner-dont-remind',\s*t\('dontRemind'\)\)/.test(appJs));

// ④ 会话级拦截逻辑：showLargeFileNotice 开头拦截
const showFn = appJs.match(/showLargeFileNotice\([^)]*\)\s*\{([\s\S]*?)\n  \}/);
check('showLargeFileNotice 内存在会话级拦截 `if (this._largeFileNoticeSessionSuppressed) return;`',
  /if\s*\(this\._largeFileNoticeSessionSuppressed\)\s*return;/.test(appJs));

// ⑤ 点击绑定：按钮 click 置会话标志并隐藏横幅
const clickBind = /getElementById\('large-file-banner-dont-remind'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*this\._largeFileNoticeSessionSuppressed\s*=\s*true;/.test(appJs);
check('点击「不再提醒」绑定置 _largeFileNoticeSessionSuppressed = true', clickBind);
check('点击「不再提醒」后调用 hideLargeFileNotice()',
  /getElementById\('large-file-banner-dont-remind'\)[\s\S]*?this\._largeFileNoticeSessionSuppressed\s*=\s*true;[\s\S]*?this\.hideLargeFileNotice\(\)/.test(appJs));

// ⑥ 构造函数初始化会话标志（仅此处，不在 switchTab/openFile 重置 —— 保证会话级）
// 稳健做法：全文 `_largeFileNoticeSessionSuppressed = false` 必须恰好出现一次（构造函数），
// 即没有任何其他方法（含 switchTab/openFile）把它复位成 false。
const falseAssignCount = (appJs.match(/_largeFileNoticeSessionSuppressed\s*=\s*false/g) || []).length;
check('会话标志 _largeFileNoticeSessionSuppressed = false 全文仅初始化一次（构造函数，不被 switchTab/openFile 复位）',
  falseAssignCount === 1);
check('构造函数初始化 _largeFileNoticeSessionSuppressed = false',
  /this\._largeFileNoticeSessionSuppressed\s*=\s*false;/.test(appJs));

try {
  assert.ok(failed === 0, `large-file-banner 接线测试失败 ${failed} 项`);
  console.log('\nlarge-file-banner 接线回归测试全部通过 ✓');
  process.exit(0);
} catch (e) {
  console.error('\n' + e.message);
  process.exit(1);
}
