<!-- superpowers-zh:begin (do not edit between these markers) -->

# Superpowers-ZH 中文增强版

本项目已安装 superpowers-zh 技能框架（20 个 skills）。

## 核心规则

1. **收到任务时，先检查是否有匹配的 skill** — 哪怕只有 1% 的可能性也要检查
   
2. **设计先于编码** — 收到功能需求时，先用 brainstorming skill 做需求分析
   
3. **测试先于实现** — 写代码前先写测试（TDD）
   
4. **验证先于完成** — 声称完成前必须运行验证命令
   
5. **红线操作** — 构建（build）和推送（push）是红线操作，除非用户明确说"构建/打包/build"或"推送/push"，否则绝不执行。擅自操作会严重破坏用户信任。**永远记住：哪怕用户说'打包'或'提交推送'，也要先确认后再执行。**
   
6. **红线操作** — **绝对禁止 AI 删除任何已发布的 Release**（包括 Gitee 和 GitHub）。删除已发布版本只能由用户在网站上手动操作。任何删除需求必须明确告知用户"请手动在网站删除"。
   
## 可用 Skills

Skills 位于 `.claude/skills/` 目录，每个 skill 有独立的 `SKILL.md` 文件。

- **brainstorming**: 在任何创造性工作之前必须使用此技能——创建功能、构建组件、添加功能或修改行为。在实现之前先探索用户意图、需求和设计。
  
- **chinese-code-review**: 中文 review 沟通参考——话术模板、分级标注（必须修复/建议修改/仅供参考）、国内团队常见反模式应对。仅在用户显式 /chinese-code-review 时调用，不要根据上下文自动触发。
  
- **chinese-commit-conventions**: 中文 commit 与 changelog 配置参考——Conventional Commits 中文适配、commitlint/husky/commitizen 中文模板、conventional-changelog 中文配置。仅在用户显式 /chinese-commit-conventions 时调用，不要根据上下文自动触发。
  
- **chinese-documentation**: 中文文档排版参考——中英文空格、全半角标点、术语保留、链接格式、中文文案排版指北约定。仅在用户显式 /chinese-documentation 时调用，不要根据上下文自动触发。
  
- **chinese-git-workflow**: 国内 Git 平台配置参考——Gitee、Coding.net、极狐 GitLab、CNB 的 SSH/HTTPS/凭据/CI 接入差异与镜像同步配置。仅在用户显式 /chinese-git-workflow 时调用，不要根据上下文自动触发。
  
- **dispatching-parallel-agents**: 当面对 2 个以上可以独立进行、无共享状态或顺序依赖的任务时使用
  
- **executing-plans**: 当你有一份书面实现计划需要在单独的会话中执行，并设有审查检查点时使用
  
- **finishing-a-development-branch**: 当实现完成、所有测试通过、需要决定如何集成工作时使用——通过提供合并、PR 或清理等结构化选项来引导开发工作的收尾
  
- **mcp-builder**: MCP 服务器构建方法论 — 系统化构建生产级 MCP 工具，让 AI 助手连接外部能力
  
- **receiving-code-review**: 收到代码审查反馈后、实施建议之前使用，尤其当反馈不明确或技术上有疑问时——需要技术严谨性和验证，而非敷衍附和或盲目执行
  
- **requesting-code-review**: 完成任务、实现重要功能或合并前使用，用于验证工作成果是否符合要求
  
- **subagent-driven-development**: 当在当前会话中执行包含独立任务的实现计划时使用
  
- **systematic-debugging**: 遇到任何 bug、测试失败或异常行为时使用，在提出修复方案之前执行
  
- **test-driven-development**: 在实现任何功能或修复 bug 时使用，在编写实现代码之前
  
- **using-git-worktrees**: 当需要开始与当前工作区隔离的功能开发，或在执行实现计划之前使用——通过原生工具或 git worktree 回退机制确保隔离工作区存在
  
- **using-superpowers**: 在开始任何对话时使用——确立如何查找和使用技能，要求在任何响应（包括澄清性问题）之前调用 Skill 工具
  
- **verification-before-completion**: 在宣称工作完成、已修复或测试通过之前使用，在提交或创建 PR 之前——必须运行验证命令并确认输出后才能声称成功；始终用证据支撑断言
  
- **workflow-runner**: 在 Claude Code / OpenClaw / Cursor 中直接运行 agency-orchestrator YAML 工作流——无需 API key，使用当前会话的 LLM 作为执行引擎。当用户提供 .yaml 工作流文件或要求多角色协作完成任务时触发。
  
- **writing-plans**: 当你有规格说明或需求用于多步骤任务时使用，在动手写代码之前
  
- **writing-skills**: 当创建新技能、编辑现有技能或在部署前验证技能是否有效时使用
  
## 如何使用

当任务匹配某个 skill 时，使用 `Skill` 工具加载对应 skill 并严格遵循其流程。绝不要用 Read 工具读取 SKILL.md 文件。

如果你认为哪怕只有 1% 的可能性某个 skill 适用于你正在做的事情，你必须调用该 skill 检查。

<!-- superpowers-zh:end -->

## 新电脑开发环境初始化（Windows）

详细指南见 `docs/DEV_SETUP.md`，一键脚本在 `scripts/`：

- **全新电脑**：clone 后 `powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1`，重开终端跑 `-VerifyOnly` 验证，然后 `npm ci && npm run dev`。
  - VS BuildTools 只装最小组件（`Microsoft.VisualStudio.Component.VC.Tools.x86.x64` + `Microsoft.VisualStudio.Component.Windows11SDK.22621`，**不加** `--includeRecommended`，约 2GB 而非 5-7GB）。
  - Tauri Windows 编译必须要 MSVC `link.exe` + Windows SDK（Rust MSVC 目标的平台级要求，含 WebView2 静态加载器链接）。
- **工具链目录从旧电脑整目录搬移**：跑 `scripts\fix-moved-toolchain.ps1` 把 vcvars64 环境变量持久化到用户环境（零下载）；
  若 `~/.cargo/bin` 出现 **0 字节空壳** rustc/cargo、或 `~/.rustup/toolchains/...` 文件数/体积明显偏小（完整工具链应有数百文件、数百 MB），用 `rustup toolchain uninstall/install stable-x86_64-pc-windows-msvc` 重装（仅几百 MB）。
- **环境验证标准**：hello-world 真实走 `link.exe` 编译链接 + `src-tauri` 下 `cargo check` 通过（`-VerifyOnly` 模式自动完成）。

## Release 发布流程

### 发布格式

release body 用以下**中文**格式作为前半部分，其后紧跟**英文全文**（即原 GitHub 英文说明），形成「先中文全文、后英文全文」的双语结构。Gitee 与 GitHub 两端 body 及应用内 `update-windows-x86_64.json` 的 `notes` 均为同一份双语内容。**英文全文来源**：由 AI 根据中文发布说明生成并写入根目录 `RELEASE_NOTES_en.md`（即原 GitHub 英文说明；非人工撰写），下载链接用 Gitee 域名以便 `github-release.js` 统一改写，`scripts/release-notes.js` 会自动拼接「中文（脚本生成）+ `---` + 英文」。骨架（下方中文部分）不得更改：

```
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

### 完整步骤

按顺序执行以下所有步骤：

#### 1. 更新版本号

将以下全部位置的版本号统一改为新版本（格式 `{old}` → `{new}`，如 `1.0.6` → `1.0.7`）。**务必全部同步，缺漏会导致显示/文档版本不一致。** 其中 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三者不一致会直接导致构建失败。

| 文件                           | 字段 / 位置                                                        | 说明                                      |
| ---------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| `package.json`               | `"version"`                                                    | 构建必需，三处必须一致                             |
| `src-tauri/tauri.conf.json`  | `"version"`                                                    | 构建必需，运行时 `getVersion()` 读取此值            |
| `src-tauri/Cargo.toml`       | `version = "..."`                                              | 构建必需                                    |
| `update-windows-x86_64.json` | `"version"` + 下载 URL 中的 `v{version}`                           | 在步骤 5 一并更新                              |
| `README.md`                  | 第 18 行 Version badge `Version-{version}-blue`                  | 文档展示                                    |
| `README.en.md`               | 第 18 行 Version badge `Version-{version}-blue`                  | 英文文档展示                                  |
| `src/app.js`                 | 中文 i18n `versionInfo: 'TizuMark v{version}'`（约 L207）           | 关于对话框文本                                 |
| `src/app.js`                 | 英文 i18n `versionInfo: 'TizuMark v{version}'`（约 L513）           | 关于对话框文本（英文）                             |
| `src/index.html`             | `#about-version` 硬编码 `TizuMark v{version}`（约 L375）             | 关于对话框兜底（运行时会由 `getVersion()` 覆盖，但应保持同步） |
| `src/tauri-mock.js`          | `getVersion: async function() { return '{version}'; }`（约 L278） | 仅浏览器联调/测试用 mock，不进发布包，建议同步              |

> **禁止手改**：`src-tauri/Cargo.lock` 与 `package-lock.json` 由构建工具自动更新，与产品版本号无关，切勿手动编辑。
> 
#### 2. 构建

```bash
npm run build
```

> **构建命令零前置阻拦**：`npm run build` 现为 `npm run build:renderer && tauri build`，不做任何自动更新自检或发布说明生成，日常构建直接进行。

> **自动更新自检 + 发布说明 = 仅限「打包发布」流程**：`scripts/release.js` / `scripts/github-release.js` 在发布前会自动先跑 `node scripts/check-updater.cjs --release`（全部致命，含要求 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 已设置），并自动执行 `node scripts/release-notes.js` 生成 `release/RELEASE_NOTES_v{version}.md` 作为两端 Release Note 唯一来源。最终密码学校验由 Tauri 运行时完成；自检只守「配置与一致性」层。如需构建前手动预检，可单独运行 `node scripts/check-updater.cjs`（默认模式，一致性问题仅警告不阻断）。

构建产物（三种安装包）：

- `src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe`
  
- `src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi`
  
- `src-tauri/target/release/TizuMark_{version}_x64.exe`（绿色版，postbuild 自动生成）
  
#### 3. 复制到本地归档

```bash
Copy-Item -Path "src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe" -Destination "release/" -Force
Copy-Item -Path "src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi" -Destination "release/" -Force
Copy-Item -Path "src-tauri/target/release/TizuMark_{version}_x64.exe" -Destination "release/" -Force
```

#### 4. 签名安装包

**三种安装包都需要签名。**

私钥路径：`C:\Users\admin\.tauri\tizu-updater.key`

密码：`tizu2024`

```bash
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="tizu2024"; npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "src-tauri/target/release/bundle/nsis/TizuMark_{version}_x64-setup.exe"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="tizu2024"; npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "src-tauri/target/release/bundle/msi/TizuMark_{version}_x64_en-US.msi"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="tizu2024"; npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "src-tauri/target/release/TizuMark_{version}_x64.exe"
```

记下输出中的 NSIS `signature`（MSI 和绿色版签名用于记录，但 `update-windows-x86_64.json` 只需要 NSIS 签名）。

#### 5. 生成 update-windows-x86_64.json

编辑项目根目录的 `update-windows-x86_64.json`（**此文件同时作为 Gitee raw 端点的源文件**）：

- `version` → 新版本号
  
- `notes` → 更新的 release notes（在已有模板基础上追加内容，注意 JSON 转义 `\n`）
  
- `pub_date` → 当天日期 `YYYY-MM-DDT00:00:00Z`
  
- `platforms.windows-x86_64.signature` → 上一步的 NSIS 签名
  
- `platforms.windows-x86_64.url` → `https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/TizuMark_{version}_x64-setup.exe`
  
同时复制到归档：

```bash
Copy-Item -Path "update-windows-x86_64.json" -Destination "release/" -Force
```

#### 6. 创建新 Gitee Release

**不要删除旧 Release**，直接新建：

```bash
$token = $env:GITEE_TOKEN; Invoke-RestMethod -Uri "https://gitee.com/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases" -Method Get -Headers @{"Authorization"="Bearer $token"} | Select-Object id, tag_name
```

#### 7. 创建 Release + 上传附件

使用 Node.js 脚本（保证中文编码正确）：

```javascript
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GITEE_TOKEN;

const releaseBody = {
  tag_name: 'v{version}',
  name: 'v{version}',
  target_commitish: 'master',
  body: `## ⬇️ 下载\n\n> **🏆 推荐大多数用户选择：** [⬇ TizuMark_{version}_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/TizuMark_{version}_x64-setup.exe)\n>\n> **🛠 企业/批量部署：** [⬇ TizuMark_{version}_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/TizuMark_{version}_x64_en-US.msi)\n>\n> **📦 绿色版（免安装）：** [⬇ TizuMark_{version}_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/TizuMark_{version}_x64.exe)\n\n### 三种安装包说明\n\n| 安装包 | 适用人群 | 特点 |\n|--------|---------|------|\n| ⭐ **NSIS 安装包 (.exe)** — **推荐** | 绝大多数 Windows 用户 | 传统的 setup 向导安装，支持自定义安装路径、创建桌面快捷方式、自动注册文件关联。双击即装，即装即用。 |\n| **MSI 安装包 (.msi)** | 企业 IT 管理员、需要批量部署的用户 | 标准的 Windows Installer 格式，支持组策略推送、静默安装（msiexec /i TizuMark_{version}_x64_en-US.msi /qn）、适合企业环境集中管理。 |\n| **绿色版 (.exe)** | 追求便携的用户 | 单文件免安装，解压即用，适合 U 盘携带、临时使用，不写注册表。 |\n\n---\n\n## ✨ v{version} 更新内容\n\n### 新增\n- ...\n\n### 改进\n- ...\n\n### 修复\n- ...\n\n> 使用中遇到问题欢迎加 QQ 群：1035294939`,
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
        } else { reject(new Error(\`HTTP \${res.statusCode}: \${data}\`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// === 上传附件函数 ===
function uploadFile(releaseId, filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const boundary = '----' + Date.now();
    const header = \`--\${boundary}\\r\\nContent-Disposition: form-data; name="file"; filename="\${fileName}"\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n\`;
    const footer = \`\\r\\n--\${boundary}--\\r\\n\`;
    const fileContent = fs.readFileSync(filePath);
    const body = Buffer.concat([Buffer.from(header, 'utf-8'), fileContent, Buffer.from(footer, 'utf-8')]);
    const options = {
      hostname: 'gitee.com',
      path: \`/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases/\${releaseId}/attach_files\`,
      method: 'POST',
      headers: { 'Authorization': \`Bearer \${TOKEN}\`, 'Content-Type': \`multipart/form-data; boundary=\${boundary}\`, 'Content-Length': body.length },
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
    'D:\\\\project\\\\tizu-mark\\\\release\\\\TizuMark_{version}_x64-setup.exe',
    'D:\\\\project\\\\tizu-mark\\\\release\\\\TizuMark_{version}_x64_en-US.msi',
    'D:\\\\project\\\\tizu-mark\\\\release\\\\TizuMark_{version}_x64.exe',
    'D:\\\\project\\\\tizu-mark\\\\release\\\\update-windows-x86_64.json',
  ];
  for (const f of files) {
    const r = await uploadFile(release.id, f);
    console.log('Uploaded: ' + path.basename(f));
  }
  console.log('All done!');
})();
```

将上述脚本保存为 `scripts/release.js`，替换 `{version}` 后执行：

```bash
node scripts/release.js
```

完成后删除临时脚本。

#### 8. 验证

确认 Gitee Release body 中文显示正常：

```bash
node -e "const https=require('https');https.get('https://gitee.com/api/v5/repos/tizu/TizuMark-Markdown-Editor/releases/{Release_ID}',{headers:{'Authorization':'Bearer ' + process.env.GITEE_TOKEN}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{const j=JSON.parse(d);console.log('name:',j.name);console.log('body contains 下载:',j.body.includes('下载'))})})"
```

#### 9. 提交推送

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/src/lib.rs src/app.js src/index.html src/styles.css update-windows-x86_64.json README.md README.en.md CLAUDE.md
git commit -m "chore: bump version to {version}"
git push
```

### 私钥信息

- 私钥路径：`C:\Users\admin\.tauri\tizu-updater.key`
  
- 公钥：已配置在 `src-tauri/tauri.conf.json` 的 `pubkey` 字段
  
- 密码：`tizu2024`（也保存于 `C:\Users\admin\.tauri\tizu-updater.password`）
  
- **永远不要丢失私钥或密码，否则无法签名更新包**
  
### 关键注意事项

- **构建前**先更新版本号（3 个文件），版本号不一致会导致构建失败
  
- **永远不要**在未签名的状态下发布安装包
  
- Gitee API 的 release body 必须用 Node.js 发送（PowerShell 的 `Invoke-RestMethod` 在 PS5.1 中编码会出错，导致中文乱码）
  
- 上传附件顺序：NSIS → MSI → update JSON（无先后依赖）
  
- 每次发布后，`release/` 目录包含最新全套产物，可作为备份
  
## 常用 API 端点与路径参考

### Gitee API（v5）

基础路径：`https://gitee.com/api/v5/repos/tizu/TizuMark-Markdown-Editor`

| 操作          | 方法     | 路径                                              | 备注                                        |
| ----------- | ------ | ----------------------------------------------- | ----------------------------------------- |
| 列出 releases | GET    | `/releases`                                     | 返回所有 Release，取 `.id` 和 `.tag_name`        |
| 创建 release  | POST   | `/releases`                                     | body 含 `tag_name`, `name`, `body`（JSON）   |
| 查看 release  | GET    | `/releases/{release_id}`                        | 验证 body 中文                                |
| 列出附件        | GET    | `/releases/{release_id}/attach_files`           | 返回 `[{id, name, size}]`                   |
| 上传附件        | POST   | `/releases/{release_id}/attach_files`           | multipart/form-data, `name="file"`        |
| 删除附件        | DELETE | `/releases/{release_id}/attach_files/{file_id}` | 返回 204，**注意 release_id 不能省略**             |
| 更新 release  | PATCH  | `/releases/{release_id}`                        | body 必须包含全部字段（`tag_name`, `name`, `body`） |

Token：从环境变量 `GITEE_TOKEN` 读取

### GitHub API

基础路径：`https://api.github.com/repos/tizuio/TizuMark-Markdown-Editor`

| 操作         | 方法   | 路径                                              | 备注                                                         |
| ---------- | ---- | ----------------------------------------------- | ---------------------------------------------------------- |
| 创建 release | POST | `/releases`                                     | body 含 `tag_name`, `name`, `body`（JSON）                    |
| 上传附件       | POST | `/releases/{release_id}/assets?name={filename}` | uploads.github.com, Content-Type: application/octet-stream |

Token：从环境变量 `GITHUB_TOKEN` 读取

GitHub Release 需上传与 Gitee Release 相同的 4 个文件（NSIS + MSI + 绿色版 + update JSON），release body 与 Gitee 同一份「先中文全文、后英文全文」双语内容（仅下载链接由 `github-release.js` 改写为 GitHub 域名）。

### 已知 Release ID

| 版本     | Release ID |
| ------ | ---------- |
| v1.0.0 | 733947     |
| v1.0.1 | 734660     |
| v1.0.2 | 736985     |
| v1.0.3 | 740254     |
| v1.0.4 | 740255     |
| v1.0.5 | 744855     |
| v1.0.6 | 752289     |

### 下载与静态文件 URL

| 用途                | URL 格式                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| Release 附件下载      | `https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{version}/{filename}` |
| Raw 文件（master 分支） | `https://gitee.com/tizu/TizuMark-Markdown-Editor/raw/master/{path}`                       |
| GitHub 最新 Release | `https://github.com/tizuio/TizuMark-Markdown-Editor/releases/latest/download/{filename}`   |

### 更新系统端点

- **Gitee raw（新版，无版本依赖）：** `https://gitee.com/tizu/TizuMark-Markdown-Editor/raw/master/update-windows-x86_64.json`
  
- **GitHub latest：** `https://github.com/tizuio/TizuMark-Markdown-Editor/releases/latest/download/update-windows-x86_64.json`
  
- **旧版 {{current_version}} 格式（已废弃）：** `https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v{{current_version}}/update-windows-x86_64.json`
  
### 签名相关

- 私钥：`C:\Users\admin\.tauri\tizu-updater.key`
  
- 密码：`tizu2024`（也存于 `C:\Users\admin\.tauri\tizu-updater.password`）
  
- 公钥：已配置在 `src-tauri/tauri.conf.json` 的 `pubkey` 字段
  
- 签名命令：`$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="tizu2024"; npx tauri signer sign -f C:\Users\admin\.tauri\tizu-updater.key "路径\to\file.exe"`
  
### 本地路径

- 项目根：`D:\project\tizu-mark`
  
- 构建产物：`src-tauri\target\release\bundle\nsis\` 和 `\msi\`
  
- 本地归档：`release\`
  
- 临时脚本：`scripts\`
  
## 提交规范（commit / push）

- **提交工程需要的全部改动**：每次提交推送时，把工作区里工程需要提交的所有改动都纳入，不限于是不是本会话产生的改动；不要只提交其中一部分、遗漏其他改动。
  
- **通过代码变动总结 commit 信息**：提交前阅读各文件的实际 diff，把具体修改了什么（行为变化、涉及文件）简洁总结到 commit message 中；不要只写笼统的一句话。
  
- 与功能无关的本地产物/目录（如 `.opencode/`、构建归档 `release/`、`screenshots/` 等）不纳入提交。
  
- 提交/推送是红线操作，必须用户明确说"提交/commit"或"推送/push"后才执行，且执行前先确认。
  
