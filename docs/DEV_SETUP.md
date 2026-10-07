# Windows 开发环境快速上手

> 目标：换一台新电脑后，**最快**把 TizuMark 跑起来开发。
> 本文是「clone 仓库后」的完整指引，配套两个一键脚本（在 `scripts/` 下）。

## 前置要求（为什么需要这些）

| 组件 | 版本要求 | 用途 | 必装？ |
|------|---------|------|--------|
| Node.js | ≥ 22（CI 用 22，实测 24 可用） | 前端构建（esbuild）、npm 依赖 | ✅ |
| Rust (rustup) | stable，**默认 MSVC 目标** | 编译 Tauri 后端（`src-tauri/`） | ✅ |
| **VS C++ Build Tools** | 2022，**最小组件**即可 | 提供 MSVC 链接器 `link.exe` + Windows SDK | ✅ |
| WebView2 Runtime | Evergreen | 运行时渲染 | Win10/11 一般自带，缺失再装 |

**为什么必须要 C++ Build Tools？** Tauri v2 在 Windows 上编译走 Rust 的 MSVC 目标：
任何 MSVC 目标的 Rust 程序都需要 MSVC 的 `link.exe` + Windows SDK 完成链接；
Tauri 还要额外链接 WebView2 静态加载器（`webview2-com-sys` 自带的
`WebView2LoaderStatic.lib`）。这是 Rust/Tauri 的平台级要求，不是本项目的选择。
但注意：**只装命令行 Build Tools 的最小组件就够，不需要完整 VS IDE**。

## 路径 A：全新电脑（推荐，脚本一键）

```powershell
git clone https://gitee.com/tizu/TizuMark-Markdown-Editor.git   # 或 GitHub 镜像
cd TizuMark-Markdown-Editor
powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1
# → 重开一个终端（PATH 生效）→
powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1 -VerifyOnly
# → 验证通过后：
npm run dev
```

`setup-dev.ps1` 做的全部事情（可跳过脚本手动执行）：

```powershell
# 1) VS 2022 BuildTools 最小组件（MSVC v143 x64/x86 + 一个 Win11 SDK）
#    磁盘占用约 2GB；不要加 --includeRecommended（会多装 3GB+ 用不到的 MFC/ATL/CMake/测试工具）
winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.22621"

# 2) Rust（rustup 默认装 stable-x86_64-pc-windows-msvc，几百 MB）
winget install -e --id Rustlang.Rustup

# 3) Node.js
winget install -e --id OpenJS.NodeJS.LTS

# 4) 进仓库装依赖
cd <仓库目录>
npm ci
```

## 路径 B：从旧电脑搬工具链目录（零下载，但容易搬坏）

把旧电脑的 `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`
（以及 `C:\Program Files (x86)\Windows Kits\10`）整个复制到新电脑同路径后：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fix-moved-toolchain.ps1
# → 重开终端 →
powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1 -VerifyOnly
```

搬目录的两个已知坑（脚本/本文已覆盖）：

1. **VS 未注册**：整目录搬过来的 BuildTools 没有安装注册信息，`vswhere` 查不到实例，
   新终端里 `rustc` 找不到 `link.exe`。`fix-moved-toolchain.ps1` 通过跑搬来的
   `vcvars64.bat` 把 MSVC/SDK 环境变量持久化到用户环境来解决（零下载）。
2. **Rust 拷贝不完整**：`~/.cargo/bin` 下出现 **0 字节空壳**的 rustc/cargo，
   或 `~/.rustup/toolchains/...` 文件数/体积明显偏小 → 直接重装（几百 MB）：
   ```powershell
   & "$env:USERPROFILE\.cargo\bin\rustup.exe" toolchain uninstall stable-x86_64-pc-windows-msvc
   & "$env:USERPROFILE\.cargo\bin\rustup.exe" toolchain install stable-x86_64-pc-windows-msvc
   ```
   判断工具链是否完整：`~/.rustup/toolchains/stable-x86_64-pc-windows-msvc`
   应有数百个文件、几百 MB；若只有几十个文件（如 ~155MB）即为拷贝中断。

## 验证清单（`setup-dev.ps1 -VerifyOnly` 自动做）

| # | 验证项 | 通过标志 |
|---|--------|---------|
| 1 | node / rustup / rustc 版本 | 能打印版本 |
| 2 | MSVC 链接器定位 | `link.exe` 存在且可被 rustc 找到 |
| 3 | hello-world 编译+运行 | 打印 `MSVC toolchain OK` |
| 4 | 项目级 `npm ci` + `cargo check` | `Finished dev profile`，无 error |

首次 `cargo check` 冷启动约 2~20 分钟（取决于机器）；若旧电脑复制了
`src-tauri/target/` 且 rustc 版本一致，缓存可复用，仅需 1~2 分钟。
`target/` 是纯构建缓存，可随时 `cargo clean` 删除（几 GB）。

## 日常开发命令

```bash
npm run dev      # 开发模式：前端 dev-server（端口 1420，SSE 热加载）+ tauri dev 编译后端
npm run test     # 前端逻辑测试（jsdom）
npm run check    # 静态检查：全局变量/耦合度/版本号一致性/入口脚本
npm run build    # ⚠️ 发布构建（红线操作，见 CLAUDE.md 发布流程，勿随手执行）
```

- 开发模式首次会编译 Rust 后端（慢，属正常），之后增量编译很快。
- 只改前端时，dev-server 改完即热刷，无需重编译后端。
- 端口 1420 被残留旧 dev-server 占用时会自动 taskkill 自愈；被其他进程占用需手动 `taskkill /F /PID <pid>`。

## 发布构建前置（红线提醒）

打包（`npm run build`）前**必须**先同步 3 处版本号
（`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`），
不一致会构建失败。完整发布流程（签名、Gitee/GitHub Release、更新 JSON）
见 [CLAUDE.md「Release 发布流程」](../CLAUDE.md) 与 [docs/release-process.md](./release-process.md)。
