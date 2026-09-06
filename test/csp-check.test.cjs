// CSP + HTML 净化回归守卫（纯 node 运行，无需浏览器 / CDP / 私有依赖）。
//
// 背景：原 test/csp-check.cjs 是僵尸测试 —— 它 require 一个不存在的
// src/tauri-mock.js，硬编码私有 ws 路径，且需要 Chrome CDP，在任何机器 / CI
// 上都跑不起来，而且文件名不带 .test.cjs 后缀、根本不被 run-tests.cjs 扫描到。
// 本文件将其重建为**可运行的静态回归守卫**：
//   1) 读取 tauri.conf.json 中**真实出货的 CSP**（不再硬编码），断言它保留了
//      渲染器必需的放宽（data:/blob:/http: 图片、data: 字体、unsafe-inline 样式、
//      unsafe-eval 脚本供 Mermaid/KaTeX），同时**没有过度放宽** script-src
//      （不得出现 http:/https: 远程脚本白名单，否则是安全回归）。
//   2) 断言 src/unified-renderer.js 仍携带 HTML 净化块（dangerousTags 剔除
//      script/iframe、sanitizeTagAttributes 剥离 on* 事件 handler、sanitizeStyleValue
//      剔除 javascript:/expression/@import），使 ADR-4 的纵深防御不能被静默掏空。
//
// 运行：node test/csp-check.test.cjs
// 位置：test/ 顶层且带 .test.cjs 后缀 → 被 run-tests.cjs 纳入主套件。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const CONF = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const RENDERER = path.join(ROOT, 'src', 'unified-renderer.js');

// ---- 1. 真实出货的 CSP ----
assert.ok(fs.existsSync(CONF), 'tauri.conf.json 缺失：' + CONF);
const conf = JSON.parse(fs.readFileSync(CONF, 'utf8'));
const csp =
  conf && conf.app && conf.app.security && conf.app.security.csp ||
  conf && conf.security && conf.security.csp ||
  conf && conf.tauri && conf.tauri.security && conf.tauri.security.csp;
assert.ok(typeof csp === 'string' && csp.trim().length, 'tauri.conf.json 中未找到 CSP 字符串');

function directive(cspText, name) {
  const m = cspText.match(new RegExp('(?:^|;)\\s*' + name + '\\s+([^;]+)'));
  return m ? m[1].trim() : null;
}

const defaultSrc = directive(csp, 'default-src');
const scriptSrc = directive(csp, 'script-src');
const styleSrc = directive(csp, 'style-src');
const imgSrc = directive(csp, 'img-src');
const fontSrc = directive(csp, 'font-src');

assert.ok(defaultSrc && /'self'/.test(defaultSrc), "default-src 必须含 'self'");

assert.ok(scriptSrc, '缺失 script-src 指令');
assert.ok(/'unsafe-inline'/.test(scriptSrc), "script-src 必须保留 'unsafe-inline'（KaTeX/Mermaid 注入）");
assert.ok(/'unsafe-eval'/.test(scriptSrc), "script-src 必须保留 'unsafe-eval'（Mermaid）");
// 关键：script-src 不得放开远程脚本白名单，否则是安全回归
assert.ok(!/https?:/.test(scriptSrc), 'script-src 不得含 http:/https: 远程脚本白名单 —— CSP 安全回归！');

assert.ok(styleSrc && /'unsafe-inline'/.test(styleSrc), "style-src 必须保留 'unsafe-inline'");

assert.ok(
  imgSrc && /data:/.test(imgSrc) && /blob:/.test(imgSrc) && /https?:/.test(imgSrc),
  'img-src 必须允许 data:/blob:/http:（图片渲染所需的放宽）'
);

assert.ok(fontSrc && /data:/.test(fontSrc), 'font-src 必须允许 data:（自定义 @font-face）');

// connect-src 必须含 blob:：导出 HTML/DOCX 时 _inlineImagesForExport 用 fetch(blob:)
// 把预览中 processImages 生成的 blob: 图片还原为内联 base64。若缺失，发行版（严格 CSP）
// 下 fetch(blob:) 被拦截 → 导出产物保留失效 blob: URL → 破图（v1.2.2 线上 bug）。
const connectSrc = directive(csp, 'connect-src');
assert.ok(connectSrc, '缺失 connect-src 指令');
assert.ok(/blob:/.test(connectSrc), 'connect-src 必须允许 blob:（导出时还原预览 blob 图片）');

// ---- 2. unified-renderer.js 净化块仍在 ----
assert.ok(fs.existsSync(RENDERER), 'unified-renderer.js 缺失：' + RENDERER);
const srcText = fs.readFileSync(RENDERER, 'utf8');
assert.ok(/function sanitizeHTML\b/.test(srcText), 'sanitizeHTML 缺失 —— 净化被掏空');
assert.ok(/dangerousTags\s*=[\s\S]*?'script'[\s\S]*?'iframe'/.test(srcText), 'dangerousTags 必须仍剔除 script/iframe');
assert.ok(/function sanitizeTagAttributes\b/.test(srcText), 'sanitizeTagAttributes 缺失 —— on* 事件 handler 剥离被掏空');
assert.ok(
  /javascript:/i.test(srcText) && /expression\s*\(/i.test(srcText) && /@import/i.test(srcText),
  'sanitizeStyleValue 必须仍剔除 javascript:/expression/@import'
);

console.log('✅ CSP + HTML 净化回归守卫通过');
