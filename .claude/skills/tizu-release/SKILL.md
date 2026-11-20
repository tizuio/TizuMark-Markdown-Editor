---
name: tizu-release
description: "TizuMark 发布流程：版本号更新、构建三种安装包、签名、生成 update JSON、创建 Gitee/GitHub Release、上传附件、验证、提交推送。当用户说'发布/release/新版本'时使用此技能。"
---

# TizuMark 发布流程

按顺序执行以下所有步骤。每步完成后标记 ✅，遇到错误立即停止并报告。

<HARD-GATE>
发布是红线操作。必须用户明确说"发布"后才开始执行。构建（build）和推送（push）也是红线操作，执行前先确认。
</HARD-GATE>

## 前置检查

1. 确认当前工作目录是 `D:\project\tizu-mark`
2. 确认用户已告知新版本号（格式 `x.y.z`，如 `1.0.7`）
3. 读取当前版本号：检查 `package.json` 的 `version` 字段
4. 向用户确认："即将从 v{当前版本} 发布到 v{新版本}，确认开始？"

## 步骤 1：更新版本号

将以下 **全部位置** 的版本号统一改为新版本。**务必全部同步，缺漏会导致显示/文档版本不一致。**

| 文件 | 字段 / 位置 | 说明 |
|------|------------|------|
| `package.json` | `"version"` | 构建必需 |
| `src-tauri/tauri.conf.json` | `"version"` | 构建必需，`getVersion()` 读取此值 |
| `src-tauri/Cargo.toml` | `version = "..."` | 构建必需 |
| `update-windows-x86_64.json` | `"version"` + 下载 URL | 在步骤 5 一并更新 |
| `README.md` | Version badge `Version-{version}-blue` | 文档展示 |
| `README.en.md` | Version badge `Version-{version}-blue` | 英文文档展示 |
| `README.es.md` | Version badge `Version-{version}-blue`（约 L20） | 西语文档展示 |
| `src/modules/i18n-data.js` | 三语各 2 处：`versionInfo: 'TizuMark v{version}'` + `appVersion: '{version}'`（共 6 处） | 关于对话框 |
| `src/index.html` | `#about-version` 硬编码 `TizuMark v{version}`（约 L602） | 兜底文本 |

> **禁止手改** `src-tauri/Cargo.lock` 与 `package-lock.json`，由构建工具自动更新。
> 旧版流程中的 `src/app.js` versionInfo 与 `src/tauri-mock.js` 已不存在，勿再找这两处。

## 步骤 1.1：文档内容同步（每版必做，2026-11-20 起纳入流程）

| 文档 | 同步内容 |
|------|----------|
| `README.md` / `README.en.md` / `README.es.md` | 徽章之外，功能清单补入本版新功能（三语同步） |
| `promotion.md` / `promotion.en.md` | 复查营销文案是否覆盖本版新卖点、修正过时描述 |
| `demo.md` | 复查功能演示是否需要补本版新能力段 |
| `RELEASE_NOTES.md` | 重新生成为本版中文发布说明（与 release/ 落盘文件同源） |
| `RELEASE_NOTES_en.md` | 按中文说明重写英文版（release-notes.js 的 englishSection() 直接读取，不更新则 Gitee/GitHub 两端英文说明仍旧） |
| `scripts/release-notes.js` | `CURATED_NOTES` 增加本版本号精选条目 |

校验：`grep -rn "旧版本号" README*.md RELEASE_NOTES*.md promotion*.md demo.md` 应无残留。

## 步骤 2：构建

```powershell
npm run build
```

构建产物（三种安装包）：
- `src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi`
- `src-tauri/target/release/TizuMark_{version}_x64.exe`（绿色版）

构建失败？检查版本号三处（package.json / tauri.conf.json / Cargo.toml）是否一致。

## 步骤 3：复制到本地归档

```powershell
Copy-Item -Path "src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe" -Destination "release/" -Force
Copy-Item -Path "src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi" -Destination "release/" -Force
Copy-Item -Path "src-tauri/target/release/TizuMark_{version}_x64.exe" -Destination "release/" -Force
```

## 步骤 4：签名安装包

**三种安装包都需要签名。**

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="tizu2024"; npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="tizu2024"; npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="tizu2024"; npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "src-tauri/target/release/TizuMark_{version}_x64.exe"
```

记下输出中的 NSIS `signature`（update JSON 需要此值）。

## 步骤 5：生成 update-windows-x86_64.json

编辑项目根目录的 `update-windows-x86_64.json`：

- `version` → 新版本号
- `notes` → 更新的 release notes（JSON 转义 `\n`）
- `pub_date` → 当天日期 `YYYY-MM-DDT00:00:00Z`
- `platforms.windows-x86_64.signature` → 步骤 4 的 NSIS 签名
- `platforms.windows-x86_64.url` → `https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/TizuMark_{version}_x64-setup.exe`

同时复制到归档：
```powershell
Copy-Item -Path "update-windows-x86_64.json" -Destination "release/" -Force
```

## 步骤 6：创建 Gitee Release

**不要删除旧 Release**，直接新建。使用 Node.js 脚本（保证中文编码正确）：

```javascript
// scripts/release.js — 生成后执行，完成后删除
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GITEE_TOKEN;
const VERSION = '{version}'; // ← 替换为实际版本号

// body 须为双语：中文全文（下方模板）+ "\n\n---\n\n" + 英文全文（即原 GitHub 英文说明）。
// 推荐直接复用 scripts/release-notes.js 导出的 notesLines.join('\n')，保证中英双语且两端一致。
const releaseBody = {
  tag_name: `v${VERSION}`,
  name: `v${VERSION}`,
  target_commitish: 'master',
  body: `## ⬇️ 下载\n\n> **🏆 推荐大多数用户选择：** [⬇ TizuMark_${VERSION}_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v${VERSION}/TizuMark_${VERSION}_x64-setup.exe)\n>\n> **🛠 企业/批量部署：** [⬇ TizuMark_${VERSION}_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v${VERSION}/TizuMark_${VERSION}_x64_en-US.msi)\n>\n> **📦 绿色版（免安装）：** [⬇ TizuMark_${VERSION}_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v${VERSION}/TizuMark_${VERSION}_x64.exe)\n\n### 三种安装包说明\n\n| 安装包 | 适用人群 | 特点 |\n|--------|---------|------|\n| ⭐ **NSIS 安装包 (.exe)** — **推荐** | 绝大多数 Windows 用户 | 传统的 setup 向导安装，支持自定义安装路径、创建桌面快捷方式、自动注册文件关联。双击即装，即装即用。 |\n| **MSI 安装包 (.msi)** | 企业 IT 管理员、需要批量部署的用户 | 标准的 Windows Installer 格式，支持组策略推送、静默安装（msiexec /i TizuMark_${VERSION}_x64_en-US.msi /qn）、适合企业环境集中管理。 |\n| **绿色版 (.exe)** | 追求便携的用户 | 单文件免安装，解压即用，适合 U 盘携带、临时使用，不写注册表。 |\n\n---\n\n## ✨ v${VERSION} 更新内容\n\n### 新增\n- ...\n\n### 改进\n- ...\n\n### 修复\n- ...\n\n> 使用中遇到问题欢迎加 QQ 群：1035294939`,
  prerelease: false,
};

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'gitee.com',
      path: `/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases${path}`,
      method,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload, 'utf-8');
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else { reject(new Error(`HTTP ${res.statusCode}: ${data}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function uploadFile(releaseId, filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const boundary = '----' + Date.now();
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const fileContent = fs.readFileSync(filePath);
    const body = Buffer.concat([Buffer.from(header, 'utf-8'), fileContent, Buffer.from(footer, 'utf-8')]);
    const options = {
      hostname: 'gitee.com',
      path: `/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases/${releaseId}/attach_files`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const release = await apiRequest('POST', '', releaseBody);
  console.log('Created release #' + release.id);
  const files = [
    `D:\\project\\tizu-mark\\release\\TizuMark_${VERSION}_x64-setup.exe`,
    `D:\\project\\tizu-mark\\release\\TizuMark_${VERSION}_x64_en-US.msi`,
    `D:\\project\\tizu-mark\\release\\TizuMark_${VERSION}_x64.exe`,
    'D:\\project\\tizu-mark\\release\\update-windows-x86_64.json',
  ];
  for (const f of files) {
    const r = await uploadFile(release.id, f);
    console.log('Uploaded: ' + path.basename(f));
  }
  console.log('All done! Release ID: ' + release.id);
})();
```

将脚本保存为 `scripts/release.js`，替换 `{version}` 后执行：
```powershell
node scripts/release.js
```
完成后删除临时脚本。

## 步骤 7：创建 GitHub Release

```javascript
// 在同一脚本中追加，或单独执行
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function githubRequest(method, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const options = {
      hostname: 'api.github.com',
      path: `/repos/tizuio/TizuMark-Markdown-Editor${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': contentType,
        'User-Agent': 'TizuMark-Release',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload, 'utf-8');
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else { reject(new Error(`HTTP ${res.statusCode}: ${data}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function githubUpload(releaseId, filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    const options = {
      hostname: 'uploads.github.com',
      path: `/repos/tizuio/TizuMark-Markdown-Editor/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileContent.length,
        'User-Agent': 'TizuMark-Release',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(fileContent);
    req.end();
  });
}
```

GitHub Release body 用英文，内容与 Gitee 对应。

## 步骤 8：验证

```powershell
node -e "const https=require('https');https.get('https://gitee.com/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases/{Release_ID}',{headers:{'Authorization':'Bearer ' + process.env.GITEE_TOKEN}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{const j=JSON.parse(d);console.log('name:',j.name);console.log('body contains 下载:',j.body.includes('下载'))})})"
```

确认 Gitee Release body 中文显示正常。

## 步骤 9：提交推送

```powershell
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/src/lib.rs src/app.js src/index.html src/styles.css update-windows-x86_64.json README.md README.en.md CLAUDE.md
git commit -m "chore: bump version to {version}"
git push
```

## 关键注意事项

- **构建前**先更新版本号（3 个文件），版本号不一致会导致构建失败
- **永远不要**在未签名的状态下发布安装包
- Gitee API 的 release body 必须用 Node.js 发送（PowerShell 的 `Invoke-RestMethod` 在 PS5.1 中编码会出错，导致中文乱码）
- **永远不要删除旧 Release**，直接新建
- 每次发布后，`release/` 目录包含最新全套产物，可作为备份
- 私钥路径：`C:\Users\admin\.tauri\tizu-updater.key`，密码：`tizu2024`

## 停止条件

所有以下条件满足时，发布完成：

- [ ] 版本号已更新（10 个位置）
- [ ] 三种安装包已构建
- [ ] 三种安装包已签名
- [ ] update-windows-x86_64.json 已更新
- [ ] Gitee Release 已创建并上传 4 个附件
- [ ] GitHub Release 已创建并上传 4 个附件
- [ ] Gitee Release 中文验证通过
- [ ] 代码已提交推送
