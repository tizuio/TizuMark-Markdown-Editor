// P2-1（2026-08-01 审查修复）：版本号一致性校验。
// 以 package.json 的 version 为基准，校验其余 9 处发布相关版本号是否同步，
// 防止改版本时漏改导致（如）更新 JSON 与安装包 tag 不一致的发布事故。
// 接入 npm run check（npm run check 聚合脚本链）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const fail = [];

function checkVersion(file, pattern, { count = 1 } = {}) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) {
    fail.push(`${file}: 文件不存在`);
    return;
  }
  const content = fs.readFileSync(p, 'utf8');
  // matchAll 要求 global 标志，缺省补 g
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  const matches = [...content.matchAll(re)];
  if (matches.length !== count) {
    fail.push(`${file}: 期望 ${count} 处版本号，实际 ${matches.length} 处`);
    return;
  }
  for (const m of matches) {
    if (m[1] !== VERSION) fail.push(`${file}: 版本 ${m[1]} ≠ 基准 ${VERSION}`);
  }
}

checkVersion('src-tauri/Cargo.toml', /^version\s*=\s*"([^"]+)"/m, { label: 'Cargo.toml' });
checkVersion('src-tauri/tauri.conf.json', /"version"\s*:\s*"([^"]+)"/, { label: 'tauri.conf.json' });
// versionInfo 文案随 i18n 字典搬到 src/modules/i18n-data.js（zh/en 各一处）
checkVersion('src/modules/i18n-data.js', /versionInfo:\s*'TizuMark v([^']+)'/, { count: 2, label: 'i18n-data.js versionInfo(zh/en)' });
checkVersion('src/index.html', /id="about-version"[^>]*>TizuMark v([^<]+)</, { label: 'index.html about-version' });
checkVersion('README.md', /Version-([0-9.]+)-blue/, { label: 'README.md badge' });
checkVersion('README.en.md', /Version-([0-9.]+)-blue/, { label: 'README.en.md badge' });
// release-notes.js 运行时从 package.json 读取版本（const VERSION = readPkg().version），恒与基准一致，仅校验存在性
{
  const rnPath = path.join(ROOT, 'scripts/release-notes.js');
  const rnContent = fs.readFileSync(rnPath, 'utf8');
  if (!/const VERSION\s*=\s*readPkg\(\)\.version/.test(rnContent)) {
    fail.push('scripts/release-notes.js: 未从 package.json 读取 VERSION（应 const VERSION = readPkg().version）');
  }
}
checkVersion('update-windows-x86_64.json', /"version"\s*:\s*"([^"]+)"/, { label: 'update json' });

if (fail.length > 0) {
  console.error(`✗ 版本号一致性检查失败（基准 package.json version=${VERSION}）：`);
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ 版本号一致：v${VERSION}（${8} 处检查通过）`);
