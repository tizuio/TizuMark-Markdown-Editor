// 统一的源码装载 helper。
//
// 背景：app.js 按职责域拆分到 src/modules/*.js 之后，任何「自建 JSDOM 并 eval app.js」的测试
// 都必须先把全部业务模块按生产顺序注入，否则 app.js 顶部 `const { ... } = TMConst;` 就会
// ReferenceError。同理，「从 app.js 源码文本做静态断言」的测试也必须覆盖拆分后的全部源码，
// 否则方法签名搬走后就断言不到。
//
// 本模块从 src/index.html 解析 <script src> 清单（与真实的加载顺序唯一真相源保持一致），
// 只取业务脚本（modules/、controllers/、app.js），跳过 lib/ 下的 vendor。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'src', 'index.html');

function scriptSrcs(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function isBusiness(src) {
  return /^modules\//.test(src) || /^controllers\//.test(src) || src === 'app.js';
}

// 按生产顺序返回业务脚本的相对路径清单
function businessScripts() {
  return scriptSrcs(fs.readFileSync(INDEX, 'utf8')).filter(isBusiness);
}

// 读取并拼接业务源码。
//   includeApp=true  是否包含 app.js（默认包含）
//   exclude=['xxx.js'] 按文件名排除
function readBundle(options = {}) {
  const { includeApp = true, exclude = [] } = options;
  const parts = [];
  for (const rel of businessScripts()) {
    const base = path.basename(rel);
    if (exclude.includes(base)) continue;
    if (!includeApp && rel === 'app.js') continue;
    const full = path.join(ROOT, 'src', rel);
    if (!fs.existsSync(full)) continue;
    parts.push(fs.readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}

module.exports = { readBundle, businessScripts, ROOT };
