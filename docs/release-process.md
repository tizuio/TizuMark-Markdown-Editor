# TizuMark 发布流程手册

> 本文档是独立于任何 AI 工具的纯人工操作手册。发布者只需按照步骤顺序执行，即可完成一次完整的 TizuMark 版本发布。

---

## 目录

1. [前置条件](#1-前置条件)
2. [发布步骤概览](#2-发布步骤概览)
3. [步骤详解](#3-步骤详解)
   - [3.1 更新版本号](#31-更新版本号)
   - [3.2 构建](#32-构建)
   - [3.3 复制到本地归档](#33-复制到本地归档)
   - [3.4 签名安装包](#34-签名安装包)
   - [3.5 生成 update JSON](#35-生成-update-json)
   - [3.6 创建 Gitee Release](#36-创建-gitee-release)
   - [3.7 上传附件](#37-上传附件)
   - [3.8 验证](#38-验证)
   - [3.9 GitHub 发布（可选）](#39-github-发布可选)
   - [3.10 提交推送代码](#310-提交推送代码)
4. [Release Note 模板](#4-release-note-模板)
5. [update JSON 格式与生成规则](#5-update-json-格式与生成规则)
6. [API 端点参考](#6-api-端点参考)
7. [常见问题](#7-常见问题)

---

## 1. 前置条件

### 1.1 环境要求

| 工具 | 说明 |
|------|------|
| Node.js 22+ | 构建与测试 |
| Rust + Cargo | Tauri 编译 |
| Windows SDK（signtool.exe） | Authenticode 签名 |
| Tauri CLI（通过 npm） | `npm run build` 包含 |

> **自动更新自检（重要，仅限「打包发布」流程）**：发布脚本（`scripts/release.js`、`scripts/github-release.js`）在**发布前**会自动执行 `node scripts/check-updater.cjs --release`，逐项核验自动更新端到端可用的前置条件——pubkey 与私钥 keyId 一致、`.sig` 由对应私钥签名（keyId 一致）、update JSON 的 version/signature/url 正确、更新端点可达、签名密码已就绪等，专为防范两类历史故障：**老版本升不上来**（用错密钥 / `.sig` 损坏 / update JSON 的 signature 不一致 / 端点 404）与**本版本升不到后续**（endpoints 指错或不可达）。
>
> **严重度（发布模式全部致命）**：任一检查项不通过都会立即中断发布，避免产出「装了却无法更新」的包；此外要求 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 已设置（环境变量或项目根 `.env`），否则产物未签名，用户更新必失败。若流程被中断，请按脚本输出逐项修复后再继续。最终密码学校验由 Tauri 运行时完成，自检脚本只守「配置与一致性」层。
>
> **`npm run build` 零前置阻拦**：日常构建命令现为 `npm run build:renderer && tauri build`，不在其中插入任何自检或生成步骤，构建直接进行。如需在构建前手动预检，可单独运行 `node scripts/check-updater.cjs`（默认模式，一致性类问题仅警告、不阻断）。

> **发布说明自动生成（重要，仅限「打包发布」流程）**：`release.js` / `github-release.js` 在发布前会自动执行 `node scripts/release-notes.js`（落盘 `release/RELEASE_NOTES_v{version}.md`）——它检查 `git` 中「自上次发布标签（`git describe --tags --abbrev=0`）至今」的**所有提交**，把每条改动/需求归纳成一句话，并作为两者的**唯一 Release Note 来源**（保证 Gitee 与 GitHub 两端一致）。发布前请人工复核该文件，按需增删分类。

### 1.2 凭据

- **Gitee Token（`GITEE_TOKEN`）**：用于通过 API 创建 Release 和上传附件
- **GitHub Token（`GITHUB_TOKEN`）**：用于 GitHub Release（可选）
- **Tauri Updater 私钥**：`C:\Users\admin\.tauri\tizu-updater.key`，密码 `tizu2024`
- **代码签名证书**：已安装于 Windows 证书存储区（EV Code Signing Certificate）

### 1.3 工作目录

项目根目录：`D:\project\tizu-mark`

---

## 2. 发布步骤概览

```
① 更新版本号（10 处同步修改）
       ↓
② npm run build（纯构建，无前置阻拦）
       ↓
③ 复制到 release/ 目录
       ↓
④ 签名三种安装包（Tauri Updater + Authenticode）
       ↓
⑤ 生成 update-windows-x86_64.json
       ↓
⑥ 创建 Gitee Release
       ↓
⑦ 上传 4 个附件到 Gitee Release
       ↓
⑧ 验证 Release body 中文显示
       ↓
⑨ 提交推送代码（含版本号改动）
```

---

## 3. 步骤详解

### 3.1 更新版本号

将以下所有位置的版本号统一改为新版本（格式 `1.0.6` → `1.0.7`）。**务必全部同步，缺漏会导致构建失败或文档版本不一致。**

| 文件 | 修改内容 | 说明 |
|------|----------|------|
| `package.json` | `"version"` 字段 | 构建必需，三处必须一致 |
| `src-tauri/tauri.conf.json` | `"version"` 字段 | 构建必需，运行时 `getVersion()` 读取此值 |
| `src-tauri/Cargo.toml` | `version = "..."` | 构建必需 |
| `update-windows-x86_64.json` | `"version"` + 下载 URL 中的 `v{version}` | 在步骤 5 一并更新 |
| `README.md` | Version badge `Version-{version}-blue` | 文档展示 |
| `README.en.md` | Version badge `Version-{version}-blue` | 英文文档展示 |
| `README.es.md` | Version badge `Version-{version}-blue`（约 L20） | 西语文档展示（2026-11-20 补入流程） |
| `src/modules/i18n-data.js` | 三语各 2 处：`versionInfo: 'TizuMark v{version}'` + `appVersion: '{version}'`（共 6 处） | 关于对话框文本（zh/en/es） |
| `src/index.html` | `#about-version` 硬编码 `TizuMark v{version}`（约 L602） | 关于对话框兜底 |

> **禁止手改**：`src-tauri/Cargo.lock` 与 `package-lock.json` 由构建工具自动更新，切勿手动编辑。
>
> 旧版流程中的 `src/app.js` versionInfo 与 `src/tauri-mock.js` 已不存在（i18n 词条迁至 `i18n-data.js`，mock 已移除），勿再找这两处。

### 3.1.1 文档内容同步（每版必做，2026-11-20 起纳入流程）

版本号之外，随版本内容变化的文档必须逐份复查同步，否则发布页与仓库文档脱节：

| 文档 | 同步内容 | 说明 |
|------|----------|------|
| `README.md` / `README.en.md` / `README.es.md` | 徽章之外，功能清单/特色段落补入本版新功能 | 三语结构对应，新功能一处补、三语同步 |
| `promotion.md` / `promotion.en.md` | 复查营销文案是否覆盖本版新卖点，过时描述修正 | v1.2.5 起每次发布后按现状复查重写过时段落 |
| `demo.md` | 复查功能演示文档：本版新增的用户可感知能力（设置项、语法行为）是否需要补演示段 | demo 为语法/功能演示主文档 |
| `RELEASE_NOTES.md` | 重新生成为本版中文发布说明（与 `release/RELEASE_NOTES_v{version}.md` 同源） | 根目录这份是仓库内可见的最新版说明 |
| `RELEASE_NOTES_en.md` | 按中文说明重写英文版 | `release-notes.js` 的 `englishSection()` 直接读取此文件拼进 Gitee/GitHub 双端 body——**不更新则两端英文说明仍是旧版** |
| `scripts/release-notes.js` | `CURATED_NOTES` 增加本版本号的精选条目 | 单版本提交量大时逐条归纳会产生内部编号噪声，v1.2.5 起用精选覆盖 |

> 校验：发布前 `grep -rn "旧版本号" README*.md RELEASE_NOTES*.md promotion*.md demo.md` 应无残留（除历史对照语境）。

### 3.2 构建

```bash
# 构建 renderer bundle + Tauri 桌面应用
npm run build
```

该命令等同于：
1. `node scripts/build-renderer.mjs` — 从 `src/unified-renderer.js` 打包 `src/lib/unified-bundle.js`
2. `node scripts/check-updater.cjs` — 自动更新功能自检（见 1.1 分级严重度；打包模式下仅源码/配置类问题会中断）
3. `node scripts/release-notes.js` — 自动生成 `release/RELEASE_NOTES_v{version}.md`（自上次发布标签至今的全部提交归纳）
4. `tauri build` — Tauri 构建，自动触发 `postbuild` 脚本生成绿色版

**构建产物（三种安装包）：**

| 产物 | 路径 |
|------|------|
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe` |
| MSI 安装包 | `src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi` |
| 绿色版（免安装） | `src-tauri/target/release/TizuMark_{version}_x64.exe`（postbuild 自动生成） |

> **rendered bundle 说明**：`src/unified-renderer.js` 是渲染管的唯一真相源。任何对 Markdown 渲染逻辑、HTML 清理规则、sanitize schema 的修改，都必须修改此文件后执行 `npm run build:renderer` 重新打包。**切勿直接修改 `src/lib/unified-bundle.js`。** 详见 `scripts/build-renderer.mjs`。

### 3.3 复制到本地归档

```powershell
Copy-Item -Path "src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe" -Destination "release/" -Force
Copy-Item -Path "src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi" -Destination "release/" -Force
Copy-Item -Path "src-tauri/target/release/TizuMark_{version}_x64.exe" -Destination "release/" -Force
```

### 3.4 签名安装包

**三种安装包都需要两种签名：**

#### 步骤 A：Tauri Updater 签名（增量更新用）

私钥路径：`C:\Users\admin\.tauri\tizu-updater.key`
密码：`tizu2024`

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="tizu2024"
npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe"
npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi"
npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "src-tauri/target/release/TizuMark_{version}_x64.exe"
```

记下 NSIS 安装包的 `signature` 输出（用于 update JSON）。MSI 和绿色版的签名仅用于记录，update JSON 只需要 NSIS 签名。

> **关于签名文件**：每条命令会产生一个 `.sig` 文件（如 `TizuMark_{version}_x64-setup.exe.sig`），与安装包在同一目录。这些 `.sig` 文件不会被上传到 Release，仅作为本地备份。

#### 步骤 B：Authenticode 签名（Windows 信任链用）

```powershell
.\scripts\sign.ps1 "src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe"
.\scripts\sign.ps1 "src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi"
.\scripts\sign.ps1 "src-tauri/target/release/TizuMark_{version}_x64.exe"
```

> 签名脚本会自动选择证书存储中的代码签名证书，时间戳服务器默认使用 `http://timestamp.sectigo.com`。可通过环境变量 `CODE_SIGN_CERT_SUBJECT` 指定证书主题，`CODE_SIGN_TIMESTAMP_URL` 指定时间戳服务器。

### 3.5 生成 update JSON

编辑项目根目录的 `update-windows-x86_64.json`。

**字段说明：**

```json
{
  "version": "1.0.7",
  "notes": "Release notes 全文（JSON 转义后的字符串，\\n 换行）",
  "pub_date": "2026-07-28T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "（步骤 4 输出的 NSIS 签名 base64 字符串）",
      "url": "https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.0.7/TizuMark_1.0.7_x64-setup.exe"
    }
  }
}
```

- **`version`**：新版本号，与其它文件一致
- **`notes`**：Release notes 内容（与 Release body 的更新内容部分一致），注意 JSON 中换行符转义为 `\n`，双引号转义为 `\"`
- **`pub_date`**：当天日期，格式 `YYYY-MM-DDTHH:mm:ssZ`（末尾固定 `Z` 表示 UTC）
- **`signature`**：步骤 4 中 `tauri signer sign` 命令输出的 NSIS 安装包 signature（不带换行的一整段 base64）
- **`url`**：指向 Gitee Release 上 NSIS 安装包的下载 URL

完成后复制到归档：

```powershell
Copy-Item -Path "update-windows-x86_64.json" -Destination "release/" -Force
```

### 3.6 创建 Gitee Release

#### 6.1 确认已有 Release 列表

```powershell
$token = $env:GITEE_TOKEN
Invoke-RestMethod -Uri "https://gitee.com/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases" `
  -Method Get -Headers @{"Authorization"="Bearer $token"} | Select-Object id, tag_name
```

#### 6.2 创建 Release + 上传附件（一步完成）

使用 Node.js 脚本来保证中文编码正确（PowerShell 的 `Invoke-RestMethod` 在 PS5.1 中发送中文会乱码）。

将以下脚本保存到项目根目录的临时文件（如 `scripts/release.js`），替换 `{version}` 后执行：

```javascript
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GITEE_TOKEN;
const VERSION = '1.0.7'; // ← 替换为实际版本号

// 构建 Release body
const releaseBody = {
  tag_name: 'v' + VERSION,
  name: 'v' + VERSION,
  target_commitish: 'master',
  body: `## ⬇️ 下载

> **🏆 推荐大多数用户选择：** [⬇ TizuMark_${VERSION}_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v${VERSION}/TizuMark_${VERSION}_x64-setup.exe)
>
> **🛠 企业/批量部署：** [⬇ TizuMark_${VERSION}_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v${VERSION}/TizuMark_${VERSION}_x64_en-US.msi)
>
> **📦 绿色版（免安装）：** [⬇ TizuMark_${VERSION}_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v${VERSION}/TizuMark_${VERSION}_x64.exe)

### 三种安装包说明

| 安装包 | 适用人群 | 特点 |
|--------|---------|------|
| ⭐ **NSIS 安装包 (.exe)** — **推荐** | 绝大多数 Windows 用户 | 传统的 setup 向导安装，支持自定义安装路径、创建桌面快捷方式、自动注册文件关联。双击即装，即装即用。 |
| **MSI 安装包 (.msi)** | 企业 IT 管理员、需要批量部署的用户 | 标准的 Windows Installer 格式，支持组策略推送、静默安装（msiexec /i TizuMark_${VERSION}_x64_en-US.msi /qn）、适合企业环境集中管理。 |
| **绿色版 (.exe)** | 追求便携的用户 | 单文件免安装，解压即用，适合 U 盘携带、临时使用，不写注册表。 |

---

## ✨ v${VERSION} 更新内容

### 新增
- ...

### 改进
- ...

### 修复
- ...

> 使用中遇到问题欢迎加 QQ 群：1035294939`,
  prerelease: false,
};

// === 通用 API 请求函数 ===
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

// === 上传附件函数（multipart/form-data） ===
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

// === 主流程 ===
(async () => {
  const release = await apiRequest('POST', '', releaseBody);
  console.log('Created release #' + release.id);
  const files = [
    `D:\\project\\tizu-mark\\release\\TizuMark_${VERSION}_x64-setup.exe`,
    `D:\\project\\tizu-mark\\release\\TizuMark_${VERSION}_x64_en-US.msi`,
    `D:\\project\\tizu-mark\\release\\TizuMark_${VERSION}_x64.exe`,
    `D:\\project\\tizu-mark\\release\\update-windows-x86_64.json`,
  ];
  for (const f of files) {
    const r = await uploadFile(release.id, f);
    console.log('Uploaded: ' + path.basename(f));
  }
  console.log('All done!');
})();
```

执行脚本：

```bash
node scripts/release.js
```

完成后删除临时脚本（或保留在 `scripts/` 目录供下次使用）。

### 3.8 验证

确认 Gitee Release body 中文显示正常：

```bash
node -e "
const https=require('https');
https.get('https://gitee.com/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases/{Release_ID}',
  {headers:{'Authorization':'Bearer ' + process.env.GITEE_TOKEN}},
  r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{
    const j=JSON.parse(d);
    console.log('name:',j.name);
    console.log('body contains 下载:',j.body.includes('下载'))
  })
})"
```

### 3.9 GitHub 发布（可选）

如果需要在 GitHub 同步发布，使用 GitHub API 创建 Release 并上传附件。Token 从 `GITHUB_TOKEN` 环境变量读取。

基础路径：`https://api.github.com/repos/tizuio/TizuMark-Markdown-Editor`
上传路径：`uploads.github.com`

GitHub Release 需上传与 Gitee Release **相同的 4 个文件**（NSIS + MSI + 绿色版 + update JSON）。Release body 使用英文。

### 3.10 提交推送代码

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/src/lib.rs src/app.js src/index.html src/styles.css update-windows-x86_64.json README.md README.en.md
git commit -m "chore: bump version to {version}"
git push
```

> **注意**：Gitee 端 Release 发布后，即使 `update-windows-x86_64.json` 已作为 Release 附件上传，项目根目录的文件也需要提交推送（作为 master 分支上的源文件，用于 Gitee raw 端点读取）。

---

## 4. Release Note 模板

### 4.1 Gitee / GitHub Release Body（中英文双语）

```markdown
## ⬇️ 下载

> **🏆 推荐大多数用户选择：** [⬇ TizuMark_{version}_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/TizuMark_{version}_x64-setup.exe)
>
> **🛠 企业/批量部署：** [⬇ TizuMark_{version}_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/TizuMark_{version}_x64_en-US.msi)
>
> **📦 绿色版（免安装）：** [⬇ TizuMark_{version}_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/TizuMark_{version}_x64.exe)

### 三种安装包说明

| 安装包 | 适用人群 | 特点 |
|--------|---------|------|
| ⭐ **NSIS 安装包 (.exe)** — **推荐** | 绝大多数 Windows 用户 | 传统的 setup 向导安装，支持自定义安装路径、创建桌面快捷方式、自动注册文件关联。双击即装，即装即用。 |
| **MSI 安装包 (.msi)** | 企业 IT 管理员、需要批量部署的用户 | 标准的 Windows Installer 格式，支持组策略推送、静默安装（msiexec /i TizuMark_{version}_x64_en-US.msi /qn）、适合企业环境集中管理。 |
| **绿色版 (.exe)** | 追求便携的用户 | 单文件免安装，解压即用，适合 U 盘携带、临时使用，不写注册表。 |

---

## ✨ v{version} 更新内容

### 新增
- ...

### 改进
- ...

### 修复
- ...

> 使用中遇到问题欢迎加 QQ 群：1035294939
```

> **双语规则**：上方为中文全文（脚本自动生成，骨架不变）。其后紧跟 `---` 分隔线，再附**英文全文**（即原 GitHub 英文说明，来源根目录 `RELEASE_NOTES_en.md`，由 AI 根据中文发布说明生成、非人工撰写）。Gitee 与 GitHub 两端 body、以及 `update-windows-x86_64.json` 的 `notes` 均为同一份双语内容；`github-release.js` 仅把下载链接改写为 GitHub 域名。

### 4.2 格式规则

1. **版本号占位符 `{version}`**：全部替换为实际版本号（如 `1.0.7`）
2. **下载区**：三个下载链接、安装包说明表固定不变，**每版本不需要修改**
3. **更新内容**：按「新增」「改进」「修复」三栏分类，每栏列出具体条目
4. **分类原则**：
   - **新增**：全新的功能或能力（如"文件夹工作区"、"自定义字体"）
   - **改进**：对已有功能的优化（如"中英文使用说明完全重写"、"默认字体方案改为简约风格"）
   - **修复**：Bug 修复（如"修复了已知 Bug（快捷键持久化……）"）
5. **QQ 群**：固定行，每版本保留

---

## 5. update JSON 格式与生成规则

### 5.1 文件位置

项目根目录 `update-windows-x86_64.json`，同时在 Gitee Release 中作为附件上传。

### 5.2 完整格式示例

```json
{
  "version": "1.0.6",
  "notes": "## ⬇️ 下载\n\n...（Release notes 完整内容，\\n 换行）...",
  "pub_date": "2026-07-19T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK...",
      "url": "https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v1.0.6/TizuMark_1.0.6_x64-setup.exe"
    }
  }
}
```

### 5.3 字段规则

| 字段 | 类型 | 生成规则 |
|------|------|----------|
| `version` | string | 当前版本号，与 `package.json` 等文件一致 |
| `notes` | string | Release notes 全部内容（含下载区和更新内容），**JSON 字符串转义**：`\n` 表示换行，`\"` 表示双引号，`\\` 表示反斜线 |
| `pub_date` | string | ISO 8601 格式：`YYYY-MM-DDTHH:mm:ssZ`，末尾 `Z` 表示 UTC 时间 |
| `platforms.windows-x86_64.signature` | string | `tauri signer sign` 命令输出的 NSIS 安装包 signature（base64 字符串，不换行） |
| `platforms.windows-x86_64.url` | string | NSIS 安装包的 Gitee Release 下载 URL |

### 5.4 signature 获取方式

执行签名命令后，终端输出类似：

```
Signature: dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVS...
```

将这段 base64 字符串（不含"Signature: "前缀）完整复制到 JSON 的 `signature` 字段。

### 5.5 notes 字段转义规则

将 Release body 的更新内容部分（不含下载区）转为一行，规则：

| 原字符 | 转义后 |
|--------|--------|
| 换行符 | `\n` |
| 双引号 `"` | `\"` |
| 反斜线 `\` | `\\` |

示例：原始的
```
### 新增
- 功能 A
```
转义为
`### 新增\n\n- 功能 A`

### 5.6 更新系统端点

Tauri 应用配置了两个更新端点（在 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints` 中）：

| 端点 | URL |
|------|-----|
| Gitee raw（新版） | `https://gitee.com/tizu/TizuMark-Markdown-Editor/raw/master/update-windows-x86_64.json` |
| GitHub latest | `https://github.com/tizuio/TizuMark-Markdown-Editor/releases/latest/download/update-windows-x86_64.json` |

---

## 6. API 端点参考

### 6.1 Gitee API（v5）

基础路径：`https://gitee.com/api/v5/repos/tizu/TizuMark-Markdown-Editor`

| 操作 | 方法 | 路径 | 备注 |
|------|------|------|------|
| 列出 releases | GET | `/releases` | 返回所有 Release，取 `.id` 和 `.tag_name` |
| 创建 release | POST | `/releases` | body 含 `tag_name`, `name`, `body`（JSON） |
| 查看 release | GET | `/releases/{release_id}` | 验证 body 中文 |
| 列出附件 | GET | `/releases/{release_id}/attach_files` | 返回 `[{id, name, size}]` |
| 上传附件 | POST | `/releases/{release_id}/attach_files` | multipart/form-data, `name="file"` |
| 删除附件 | DELETE | `/releases/{release_id}/attach_files/{file_id}` | 返回 204 |
| 更新 release | PATCH | `/releases/{release_id}` | body 必须包含全部字段 |

Token：从环境变量 `GITEE_TOKEN` 读取。

### 6.2 GitHub API

基础路径：`https://api.github.com/repos/tizuio/TizuMark-Markdown-Editor`

| 操作 | 方法 | 路径 | 备注 |
|------|------|------|------|
| 创建 release | POST | `/releases` | body 含 `tag_name`, `name`, `body`（JSON） |
| 上传附件 | POST | `/releases/{release_id}/assets?name={filename}` | uploads.github.com, Content-Type: application/octet-stream |

Token：从环境变量 `GITHUB_TOKEN` 读取。

### 6.3 下载与静态文件 URL

| 用途 | URL 格式 |
|------|----------|
| Release 附件下载 | `https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/{filename}` |
| Raw 文件（master 分支） | `https://gitee.com/tizu/TizuMark-Markdown-Editor/raw/master/{path}` |
| GitHub 最新 Release | `https://github.com/tizuio/TizuMark-Markdown-Editor/releases/latest/download/{filename}` |

### 6.4 已知 Release ID（历史参考）

| 版本 | Release ID |
|------|-----------|
| v1.0.0 | 733947 |
| v1.0.1 | 734660 |
| v1.0.2 | 736985 |
| v1.0.3 | 740254 |
| v1.0.4 | 740255 |
| v1.0.5 | 744855 |
| v1.0.6 | 752289 |

---

## 7. 常见问题

### Q：构建失败 "version mismatch"

确保 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处的版本号完全一致。不一致会导致 Tauri 构建失败。

### Q：Gitee Release body 显示乱码

不要在 PowerShell 中使用 `Invoke-RestMethod` 直接发送含中文的 release body。必须使用 Node.js 脚本（如步骤 6.2 所示）发送 HTTP 请求，并显式设置 `charset=utf-8`。

### Q：签名命令报错 "no valid signing key"

确认：
1. 私钥文件存在于 `C:\Users\admin\.tauri\tizu-updater.key`
2. 密码正确（`tizu2024`）
3. 环境变量 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 已设置

### Q：Authenticode 签名失败

确认：
1. 代码签名证书已安装到 Windows 证书存储区（当前用户 / 个人）
2. Windows SDK（含 `signtool.exe`）已安装并在 `PATH` 中
3. 网络可访问时间戳服务器 `http://timestamp.sectigo.com`

### Q：`npm run build` 耗时太长

首次构建需要下载 Rust crate 依赖（~500MB），后续构建只需增量编译。如果只有前端改动（如 app.js），可以只跑 `npm run build:renderer` + `tauri build` 跳过 renderer bundle 构建（前提 bundle 已经是最新）。

### Q：如何删掉已发布的 Release？

**不要通过 API 或脚本删除已发布的 Release。** 删除已发布版本只能由用户在 Gitee/GitHub 网站上手动操作（进入 Release 页面 → 编辑 → 删除）。
