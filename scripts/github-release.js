// 发布前先自检自动更新功能（致命问题中断发布）
const { run: runUpdaterCheck } = require('./check-updater.cjs');
if (!runUpdaterCheck(['--release'])) process.exit(1);

// 创建 GitHub Release（tizuio/TizuMark-Markdown-Editor）并上传安装包附件。
// 复用 scripts/release-notes.js 作为唯一 Release Note 来源，仅把下载链接改写为 GitHub。
const https = require('https');
const fs = require('fs');
const path = require('path');
const { VERSION, notesLines, writeNotes } = require('./release-notes.js');
// 打包发布流程：生成（落盘）发布说明，作为本次 Release 的内容来源
writeNotes();

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'tizuio';
const REPO = 'TizuMark-Markdown-Editor';

if (!TOKEN) { console.error('GITHUB_TOKEN 未设置'); process.exit(1); }

const RELEASE_DIR = path.join(__dirname, '..', 'release');
const ASSETS = [
  `TizuMark_${VERSION}_x64-setup.exe`,
  `TizuMark_${VERSION}_x64_en-US.msi`,
  `TizuMark_${VERSION}_x64.exe`,
  'update-windows-x86_64.json',
];

// 把 notes 中的 Gitee 下载链接改写为 GitHub release 下载链接
function buildBody() {
  return notesLines
    .map((l) => l    .replace(/https:\/\/gitee\.com\/tizu\/TizuMark-Markdown-Editor\/releases\/download\/v[\d.]+\//g,
      `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/`))
    .join('\n');
}

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function apiPost(p, payload) {
  const data = JSON.stringify(payload);
  return req({
    hostname: 'api.github.com',
    path: p,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tizu-release',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  }, data);
}

function uploadAsset(uploadUrl, filePath) {
  const name = path.basename(filePath);
  const buf = fs.readFileSync(filePath);
  const url = uploadUrl.replace(/\{\?name,label\}$/, '') + `?name=${encodeURIComponent(name)}`;
  return req({
    hostname: 'uploads.github.com',
    path: url.replace('https://uploads.github.com', ''),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tizu-release',
      'Content-Type': 'application/octet-stream',
      'Content-Length': buf.length,
    },
  }, buf).then((r) => {
    if (r.status >= 200 && r.status < 300) {
      const j = JSON.parse(r.body);
      console.log(`  ✓ uploaded ${name} (${j.size} bytes)`);
    } else {
      console.error(`  ✗ upload ${name} failed: ${r.status} ${r.body.slice(0, 200)}`);
      process.exitCode = 1;
    }
  });
}

(async () => {
  const body = buildBody();
  console.log(`=== creating GitHub release v${VERSION} ===`);
  const created = await apiPost(`/repos/${OWNER}/${REPO}/releases`, {
    tag_name: `v${VERSION}`,
    name: `v${VERSION}`,
    body,
    draft: false,
    prerelease: false,
  });
  if (created.status < 200 || created.status >= 300) {
    console.error(`创建 Release 失败: ${created.status} ${created.body.slice(0, 300)}`);
    process.exit(1);
  }
  const rel = JSON.parse(created.body);
  console.log(`  release id ${rel.id}, upload_url: ${rel.upload_url}`);

  for (const a of ASSETS) {
    const fp = path.join(RELEASE_DIR, a);
    if (!fs.existsSync(fp)) { console.error(`  ✗ 缺失附件: ${fp}`); process.exitCode = 1; continue; }
    console.log(`  uploading ${a} ...`);
    await uploadAsset(rel.upload_url, fp);
  }
  console.log('=== done ===');
})();
