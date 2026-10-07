# ============================================================
# TizuMark Windows 开发环境一键初始化（方案 B：最小安装）
#
# 背景：Tauri v2 在 Windows 上编译需要 MSVC 链接器(link.exe) + Windows SDK，
# 这是 Rust MSVC 目标的平台级要求，绕不开。但只装「C++ Build Tools 最小组件」
# 就够了，不需要完整 VS IDE，不需要 --includeRecommended。
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
#  - 如果工具链是「从旧电脑整目录搬过来」的（vswhere 查不到 VS 实例），
#    需要先跑 scripts/fix-moved-toolchain.ps1 固化环境变量。
#  - 装完的体积：VS BuildTools 最小 ≈ 2GB（磁盘），远小于完整 VS 的 5-7GB。
# ============================================================
param(
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

function Test-Installed([string]$id) {
  $out = & winget list --id $id -e 2>$null
  return $null -ne ($out | Where-Object { $_ -match [regex]::Escape($id) } | Select-Object -First 1)
}

if (-not $VerifyOnly) {
  # ---- 1. VS 2022 BuildTools：只装 MSVC v143 (x64/x86) + 一个 Win11 SDK ----
  # 不装 IDE、不装 MFC/ATL/CMake/测试工具（--includeRecommended 会带入 3GB+ 无用品）
  if (Test-Installed 'Microsoft.VisualStudio.2022.BuildTools') {
    Write-Host '[skip] VS 2022 BuildTools 已安装'
  } else {
    Write-Host '[install] VS 2022 C++ Build Tools（最小组件，下载约 1-2GB）...'
    & winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
      --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.22621" `
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
& "$env:USERPROFILE\.cargo\bin\rustup.exe" toolchain list
& "$env:USERPROFILE\.cargo\bin\rustc.exe" --version

Write-Host ''
Write-Host '=== 2) MSVC 链接器就位确认 ==='
$lx = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\HostX64\x64\link.exe'
if (Test-Path $lx) {
  Write-Host "link.exe 存在: $lx"
} else {
  # 版本目录可能不同（MSVC 升级后），在 VC\Tools\MSVC 下动态找
  $found = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC' -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'bin\HostX64\x64\link.exe' } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $found) { throw '找不到 link.exe：MSVC 环境未就位。若是搬来的工具链，先跑 scripts\fix-moved-toolchain.ps1' }
  Write-Host "link.exe 存在: $found"
}

Write-Host ''
Write-Host '=== 3) 真实编译+链接冒烟测试（hello world，走 link.exe）==='
$dir = Join-Path $env:TEMP 'tizumark-vscheck'
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Content -Path (Join-Path $dir 'hello.rs') -Value 'fn main() { println!("MSVC toolchain OK: link.exe works"); }'
& "$env:USERPROFILE\.cargo\bin\rustc.exe" --edition 2021 (Join-Path $dir 'hello.rs') -o (Join-Path $dir 'hello.exe')
if ($LASTEXITCODE -ne 0) { throw 'hello world 编译失败（rustc 找不到/无法调用 link.exe）' }
& (Join-Path $dir 'hello.exe')

Write-Host ''
Write-Host '=== 4) 项目级验证：npm ci + cargo check（首次拉依赖需几分钟）==='
Set-Location $RepoPath
npm ci
Push-Location src-tauri
& "$env:USERPROFILE\.cargo\bin\cargo.exe" check
$rc = $LASTEXITCODE
Pop-Location
if ($rc -ne 0) { throw 'cargo check 失败' }

Write-Host ''
Write-Host '============================================'
Write-Host ' 全部通过。日常开发：npm run dev'
Write-Host ' 打包发布：  npm run build（红线操作，见 CLAUDE.md 发布流程）'
Write-Host '============================================'
