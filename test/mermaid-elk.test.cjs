// Mermaid ELK 布局接入护栏：
// frontmatter `config: layout: elk` 需要独立包 @mermaid-js/layout-elk（mermaid 核心不含，
// 未注册时渲染抛「Unknown layout algorithm: elk」整图失败）。
// 链路：ensure-vendor 现打包全局 MermaidElkLayouts → index.html 在 mermaid 之后加载 →
// preview-post.js 顶部 registerLayoutLoaders 注册一次（预览/主题/导出共用 mermaid 单例）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test('mermaid-elk: index.html 应在 mermaid.min.js 之后加载 elk 布局 vendor', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const mermaidIdx = html.indexOf('src="lib/mermaid/mermaid.min.js"');
  const elkIdx = html.indexOf('src="lib/mermaid/mermaid-layout-elk.min.js"');
  assert.ok(mermaidIdx > 0, 'mermaid.min.js 脚本应存在于 index.html');
  assert.ok(elkIdx > mermaidIdx, 'elk 布局脚本应在 mermaid.min.js 之后加载');
});

test('mermaid-elk: preview-post.js 应注册 ELK 布局（含缺包守卫）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'preview-post.js'), 'utf8');
  assert.ok(src.includes('registerLayoutLoaders'), '应调用 mermaid.registerLayoutLoaders');
  assert.ok(src.includes('MermaidElkLayouts'), '应引用全局 MermaidElkLayouts');
  // 守卫：vendor 缺失 / 非 Tauri 环境下不抛错（jsdom harness 也 eval 本模块）
  assert.ok(/typeof window !== 'undefined'/.test(src), '注册前应有 window 存在性守卫');
});

test('mermaid-elk: vendor 产物存在且挂全局、含 elk 算法（ensure-vendor 生成）', () => {
  const f = path.join(ROOT, 'src', 'lib', 'mermaid', 'mermaid-layout-elk.min.js');
  assert.ok(fs.existsSync(f), 'mermaid-layout-elk.min.js 应存在（npm install 后 prepare/ensure-vendor 生成）');
  const src = fs.readFileSync(f, 'utf8');
  assert.ok(src.includes('MermaidElkLayouts'), '产物应挂全局 MermaidElkLayouts');
  assert.ok(/elk\.layered|elk\.stress/.test(src), '产物应含 elk 算法定义');
});

test('mermaid-elk: package.json 应声明 @mermaid-js/layout-elk 依赖（vendor 再生源）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(deps['@mermaid-js/layout-elk'], 'devDependencies/dependencies 应含 @mermaid-js/layout-elk');
});
