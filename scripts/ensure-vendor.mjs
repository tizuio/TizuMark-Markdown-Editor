// P2-3 vendor 锁定（沿用 5f5b23e 范式）
//
// 从 node_modules 把 5 个运行时依赖（已在 dependencies）复制到 src/lib 的 vendor 子树，
// 使「vendor 文件」成为可由 node_modules 确定性再生的产物，而非手改的游离副本。
// 比「删 src/lib 改 npm 导入」更可逆：index.html 的 <script> 路径不变，只是内容改为由本脚本生成。
//
// 接入点：
//   - package.json "prepare"：npm install / npm ci 后自动重建 vendor（CI 用完整安装）。
//
// highlight.js 纳入再生（2026-08-01 升级 11.11.1）：
//   node_modules 的 highlight.js 包不发布浏览器 UMD 版 highlight.min.js（全局 hljs），
//   故用 esbuild 从 node_modules 现打包；入口必须【三路兼容】（window / globalThis /
//   module.exports）：浏览器 <script> 走 window.hljs，而测试 loadHljs 走
//   new Function('window','self','module','exports', code) 读 module.exports ——
//   历史 code-block「4 例退化」的根因即只设 globalThis.hljs 导致 loadHljs 拿到空对象，
//   并非 11.9.0→11.11.1 的高亮输出差异（已 A/B 验证）。styles/languages/common/core
//   从 node_modules 精确复制，版本与 package.json 声明（^11.10.0，实际 11.11.1）对齐。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib');
const NM = path.join(ROOT, 'node_modules');

// 复制：src 文件 -> dest 文件；src 目录 -> dest 目录（递归）。
function copyPath(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src)) {
      if (ent === 'node_modules' || ent === '.bin') continue;
      copyPath(path.join(src, ent), path.join(dest, ent));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 显式 manifest：node_modules 源 -> src/lib 目标。目录会被整体递归复制。
// 仅含「映射干净、版本与 package.json 完全一致」的 5 个库；highlight.js 见上说明，已排除。
const MANIFEST = [
  // codemirror（npm 包根有 mode/addon/theme，核心在 lib/）
  ['codemirror/lib/codemirror.js', 'codemirror/codemirror.js'],
  ['codemirror/lib/codemirror.css', 'codemirror/codemirror.css'],
  ['codemirror/mode', 'codemirror/mode'],
  ['codemirror/addon', 'codemirror/addon'],
  ['codemirror/theme', 'codemirror/theme'],
  // katex
  ['katex/dist/katex.min.js', 'katex/katex.min.js'],
  ['katex/dist/katex.min.css', 'katex/katex.min.css'],
  ['katex/dist/contrib/auto-render.min.js', 'katex/auto-render.min.js'],
  ['katex/dist/fonts', 'katex/fonts'],
  // mermaid
  ['mermaid/dist/mermaid.min.js', 'mermaid/mermaid.min.js'],
  // html2canvas（单文件）
  ['html2canvas/dist/html2canvas.min.js', 'html2canvas.min.js'],
  // markdown-it（单文件）
  ['markdown-it/dist/markdown-it.min.js', 'markdown-it.min.js'],
  // html-docx-js（单文件 UMD，自带 jszip；导出 Word .docx 用，挂 window.htmlDocx）
  ['html-docx-js/dist/html-docx.js', 'html-docx.min.js'],
  // highlight.js：highlight.min.js 用 esbuild 打包（见 buildHighlightMin），
  // 其余伴随文件从 node_modules 精确复制（styles/languages/common/core）
  ['highlight.js/styles/github.min.css', 'highlight.js/github.min.css'],
  ['highlight.js/styles/github.css', 'highlight.js/github.css'],
  ['highlight.js/styles/github-dark.min.css', 'highlight.js/github-dark.min.css'],
  ['highlight.js/styles/github-dark.css', 'highlight.js/github-dark.css'],
  // 注意：不复制 highlight.js/lib/common.js、lib/core.js —— node_modules 无包根 ESM shim，
  // 且全仓库无任何引用（index.html/app.js/测试均不用），避免生成错位内容。
  ['highlight.js/lib/languages', 'highlight.js/languages'],
];

// highlight.min.js：esbuild 现打包一个全局 hljs（三路兼容，见头部说明）。
async function buildHighlightMin() {
  const esbuild = await import('esbuild');
  const outfile = path.join(LIB, 'highlight.js', 'highlight.min.js');
  const contents = [
    "import hljs from 'highlight.js';",
    "if (typeof window !== 'undefined') window.hljs = hljs;",
    "if (typeof globalThis !== 'undefined') globalThis.hljs = hljs;",
    "if (typeof module !== 'undefined' && module.exports) module.exports = hljs;",
  ].join('\n');
  await esbuild.build({
    stdin: { contents, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    format: 'iife',
    minify: true,
    outfile,
    logLevel: 'silent',
  });
  console.log('[ensure-vendor] 打包 highlight.min.js（三路兼容 global hljs）完成');
}

// docx 库（v9.7.1，ESM，无浏览器 UMD）：esbuild 现打包为 IIFE 全局 DocxLib。
// docx 入口用 node_modules/docx/dist/index.mjs（package.json "module"），供 worker 的
// importScripts('./docx.min.js') 使用。无 Buffer/stream 报错，无需 shim。
async function buildDocxMin() {
  const esbuild = await import('esbuild');
  const outfile = path.join(LIB, 'docx.min.js');
  const contents = "export * from 'docx';";
  await esbuild.build({
    stdin: { contents, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    format: 'iife',
    globalName: 'DocxLib',
    minify: true,
    outfile,
    logLevel: 'silent',
  });
  console.log('[ensure-vendor] 打包 docx.min.js（全局 DocxLib）完成');
}

await buildHighlightMin();
await buildDocxMin();

let missing = 0;
for (const [relSrc, relDest] of MANIFEST) {
  const src = path.join(NM, relSrc);
  const dest = path.join(LIB, relDest);
  if (!fs.existsSync(src)) {
    console.error(`[ensure-vendor] 缺失源：${relSrc}（node_modules 未安装？）`);
    missing++;
    continue;
  }
  copyPath(src, dest);
}

if (missing > 0) {
  console.error(`[ensure-vendor] 有 ${missing} 个源缺失，vendor 不完整。请先 npm install。`);
  process.exit(1);
}

console.log('[ensure-vendor] vendor 同步完成：src/lib（codemirror/katex/mermaid/html2canvas/markdown-it/highlight.js）');
