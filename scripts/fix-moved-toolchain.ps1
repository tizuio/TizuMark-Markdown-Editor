# ============================================================
# 修复「从旧电脑整目录搬来」的 VS BuildTools（零下载）
#
# 场景：把 C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools
# 整个目录（以及 C:\Program Files (x86)\Windows Kits\10）复制到新电脑。
# 文件都在，但 vswhere 查不到任何 VS 实例（安装未注册），
# 新终端里 rustc/cargo 找不到 link.exe → 编译报错。
#
# 本脚本：跑一遍搬来的 vcvars64.bat，把生成的 MSVC/SDK 环境变量
# 持久化到当前用户的系统环境变量（PATH/INCLUDE/LIB/LIBPATH 做合并，
# 不覆盖已有条目）。
#
# 用法（新电脑，先确保 BuildTools 目录已复制到位）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\fix-moved-toolchain.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\fix-moved-toolchain.ps1 -VcVars 'D:\Toolchain\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
#
# 跑完后重开终端，用 scripts/setup-dev.ps1 -VerifyOnly 验证。
# 详见 docs/DEV_SETUP.md「路径 B」。
# ============================================================
param(
  [string]$VcVars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $VcVars)) {
  throw "找不到 vcvars64.bat：$VcVars（用 -VcVars 参数传实际路径）"
}

Write-Host "=== 1) 运行 vcvars64.bat 并抓取环境变量 ==="
$lines = & cmd /c "`"$VcVars`" >nul 2>&1 && set"
if ($LASTEXITCODE -ne 0) { throw 'vcvars64.bat 执行失败（搬来的工具链可能不完整）' }
$vc = @{}
foreach ($l in $lines) { if ($l -match '^([^=]+)=(.*)$') { $vc[$Matches[1]] = $Matches[2] } }
if (-not $vc.ContainsKey('VCToolsInstallDir')) { throw 'vcvars 输出里没有 VCToolsInstallDir，环境变量抓取失败' }
Write-Host "VCToolsInstallDir = $($vc['VCToolsInstallDir'])"

Write-Host ''
Write-Host '=== 2) 写入用户环境变量（PATH/INCLUDE/LIB/LIBPATH 合并，不覆盖已有条目）==='
foreach ($t in @('VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion','WindowsSDKExecutablePath','WindowsSdkVersion','UCRTVersion')) {
  if ($vc.ContainsKey($t)) {
    [Environment]::SetEnvironmentVariable($t, $vc[$t], 'User')
    "set  $t = $($vc[$t])"
  }
}
foreach ($t in @('PATH','INCLUDE','LIB','LIBPATH')) {
  if (-not $vc.ContainsKey($t)) { continue }
  $current = [Environment]::GetEnvironmentVariable($t, 'User')
  $newEntries = @($vc[$t] -split ';' | Where-Object { $_ })
  $curEntries = @()
  if ($current) { $curEntries = @($current -split ';' | Where-Object { $_ }) }
  $merged = @($newEntries) + @($curEntries | Where-Object { $newEntries -notcontains $_ })
  [Environment]::SetEnvironmentVariable($t, ($merged -join ';'), 'User')
  "merged $t (+$($newEntries.Count) 条新条目)"
}

Write-Host ''
Write-Host '============================================'
Write-Host ' 完成。【重开终端】后验证：'
Write-Host '   powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1 -VerifyOnly'
Write-Host '============================================'
