# ============================================================
# TizuMark Windows 开发环境一键初始化（方案 B：最小安装）
#
# 背景：Tauri v2 在 Windows 上编译需要 MSVC 链接器(link.exe) + Windows SDK，
# 这是 Rust MSVC 目标的平台级要求，绕不开。但只要机器上已经有**任意**一个
# 带「MSVC C++ 生成工具」的 Visual Studio 实例，就直接复用，不必再装：
#   - VS 2022 BuildTools / VS 2022 社区版
#   - VS 2026 (Insiders) 社区版    ← 安装根目录与 2022 不同，用 vswhere 探测
# 只有全都探测不到时，才装「Build Tools 最小集」，不需要完整 VS IDE。
# 详见 docs/DEV_SETUP.md。
#
# 用法（新电脑，普通 PowerShell 即可，无需管理员）：
#   git clone <仓库> && cd TizuMark-Markdown-Editor
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1 -RepoPath 'D:\xxx\TizuMark-Markdown-Editor'
#
# 装完重开终端后跑验证：
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1 -VerifyOnly
#
# 注意：
#  - 本文件必须保存为 UTF-8 **带 BOM**。Windows PowerShell 5.1（powershell.exe）
#    读无 BOM 的脚本时按系统 ANSI 代码页（简中 = GBK）解码，中文变乱码，且
#    全角括号（的尾字节会吞掉紧随其后的引号，报「数组索引表达式丢失或无效」
#    之类的语法错误。PowerShell 7（pwsh）无此问题，但脚本要兼容 5.1。
#  - 如果工具链是「从旧电脑整目录搬过来」的（vswhere 查不到 VS 实例），
#    需要先跑 scripts/fix-moved-toolchain.ps1 固化环境变量。
# ============================================================
param(
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

$Vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$VcToolsComponent = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
$CargoBin = Join-Path $env:USERPROFILE '.cargo\bin'

function Test-Installed([string]$id) {
  $out = & winget list --id $id -e 2>$null
  return $null -ne ($out | Where-Object { $_ -match [regex]::Escape($id) } | Select-Object -First 1)
}

# 返回「装了 MSVC x64 生成工具」的 VS 实例；一个都没有则返回 $null。
# 用 vswhere 而非写死目录：VS 2022 在 Program Files (x86)\...\2022\，
# VS 2026 在 Program Files\...\18\，BuildTools 与 IDE 版路径又各不相同。
function Get-VsInstanceWithMsvc {
  if (-not (Test-Path $Vswhere)) { return $null }
  # 参数顺序与后缀都重要：-prerelease 才能看到 Insiders/Preview 实例
  $json = & $Vswhere -all -prerelease -products '*' -requires $VcToolsComponent -format json 2>$null
  if (-not $json) { return $null }
  $instances = @($json | ConvertFrom-Json)
  if ($instances.Count -eq 0) { return $null }
  # 多实例并存：非预览版优先，其次版本号高的
  return $instances |
    Sort-Object @{ Expression = { [bool]$_.isPrerelease } },
                @{ Expression = { [version]$_.installationVersion }; Descending = $true } |
    Select-Object -First 1
}

# 在给定 VS 安装目录下定位 x64 的 link.exe（MSVC 版本号会变，不能写死）
function Get-LinkExePath([string]$VsPath) {
  if (-not $VsPath) { return $null }
  $root = Join-Path $VsPath 'VC\Tools\MSVC'
  if (-not (Test-Path $root)) { return $null }
  return Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'bin\Hostx64\x64\link.exe' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}

if (-not $VerifyOnly) {
  # ---- 1. MSVC 工具链：已有带 C++ 生成工具的 VS 就直接复用 ----
  $vs = Get-VsInstanceWithMsvc
  if ($vs) {
    Write-Host "[skip] 已检测到 $($vs.displayName) $($vs.installationVersion)，复用其 MSVC 工具链"
    Write-Host "       $($vs.installationPath)"
  } else {
    # 只装 MSVC v143 (x64/x86) + 一个 Win11 SDK
    # 不装 IDE、不装 MFC/ATL/CMake/测试工具（--includeRecommended 会带入 3GB+ 无用品）
    Write-Host '[install] 未检测到带 C++ 生成工具的 Visual Studio，安装 VS 2022 C++ Build Tools（最小组件，下载约 1-2GB）...'
    & winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
      --override "--quiet --wait --norestart --add $VcToolsComponent --add Microsoft.VisualStudio.Component.Windows11SDK.22621" `
      --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw 'VS BuildTools 安装失败' }
  }

  # ---- 2. Rust（rustup 默认装 stable-x86_64-pc-windows-msvc）----
  if (Test-Installed 'Rustlang.Rustup') {
    Write-Host '[skip] Rust (rustup) 已安装'
  } else {
    Write-Host '[install] Rust 工具链 (rustup) ...'
    & winget install -e --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Rust 安装失败' }
  }

  # ---- 3. Node.js（前端构建需要）----
  if (Test-Installed 'OpenJS.NodeJS.LTS') {
    Write-Host '[skip] Node.js 已安装'
  } else {
    Write-Host '[install] Node.js LTS ...'
    & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 安装失败' }
  }

  Write-Host ''
  Write-Host '============================================'
  Write-Host ' 安装完成。请【重开一个终端】（PATH 才生效），然后执行:'
  Write-Host '   powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1 -VerifyOnly'
  Write-Host '============================================'
  return
}

# ============ 验证模式（需重开终端后运行） ============
Write-Host "仓库目录: $RepoPath"
if (-not (Test-Path $RepoPath)) { throw "仓库目录不存在: $RepoPath（-RepoPath 指定实际路径）" }

Write-Host ''
Write-Host '=== 1) 工具链版本 ==='
node --version
$rustc = Join-Path $CargoBin 'rustc.exe'
$rustup = Join-Path $CargoBin 'rustup.exe'
if (-not (Test-Path $rustc)) {
  throw "找不到 $rustc：Rust 未安装，或刚装完还没重开终端（PATH 未生效）"
}
& $rustup toolchain list
& $rustc --version

Write-Host ''
Write-Host '=== 2) MSVC 链接器就位确认 ==='
$vs = Get-VsInstanceWithMsvc
if (-not $vs) {
  throw 'vswhere 未找到带 C++ 生成工具的 VS 实例。若是搬来的工具链，先跑 scripts\fix-moved-toolchain.ps1；否则先跑不带 -VerifyOnly 的安装模式'
}
Write-Host "VS 实例: $($vs.displayName) $($vs.installationVersion)"
Write-Host "         $($vs.installationPath)"
$lx = Get-LinkExePath $vs.installationPath
if (-not $lx) { throw "VS 实例存在但缺 link.exe（C++ 生成工具未装全）：$($vs.installationPath)\VC\Tools\MSVC" }
Write-Host "link.exe 存在: $lx"

Write-Host ''
Write-Host '=== 3) 真实编译+链接冒烟测试（hello world，走 link.exe）==='
$dir = Join-Path $env:TEMP 'tizumark-vscheck'
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Content -Path (Join-Path $dir 'hello.rs') -Value 'fn main() { println!("MSVC toolchain OK: link.exe works"); }'
& $rustc --edition 2021 (Join-Path $dir 'hello.rs') -o (Join-Path $dir 'hello.exe')
if ($LASTEXITCODE -ne 0) { throw 'hello world 编译失败（rustc 找不到/无法调用 link.exe）' }
& (Join-Path $dir 'hello.exe')

Write-Host ''
Write-Host '=== 4) 项目级验证：npm ci + cargo check（首次拉依赖需几分钟）==='
Set-Location $RepoPath
npm ci
Push-Location src-tauri
& (Join-Path $CargoBin 'cargo.exe') check
$rc = $LASTEXITCODE
Pop-Location
if ($rc -ne 0) { throw 'cargo check 失败' }

Write-Host ''
Write-Host '============================================'
Write-Host ' 全部通过。日常开发：npm run dev'
Write-Host ' 打包发布：  npm run build（红线操作，见 CLAUDE.md 发布流程）'
Write-Host '============================================'
