# TizuMark Windows Code Signing Script
# 用法: .\scripts\sign.ps1 <要签名的文件路径>
# Tauri 构建时会自动调用此脚本，传入二进制文件路径
#
# 前置条件：
#   1. 已购买 EV Code Signing Certificate（推荐 DigiCert / Sectigo）
#   2. 证书已安装到 Windows 证书存储区
#   3. Windows SDK (signtool.exe) 已安装
#
# 环境变量配置（可选，用于自动获取证书信息）：
#   CODE_SIGN_CERT_SUBJECT - 证书主题名称（如 "Open Source Developer, TizuMark"）
#   CODE_SIGN_TIMESTAMP_URL - 时间戳服务器 URL（默认使用 Sectigo）

param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath
)

# ---- 配置区 ----
# 时间戳服务器（使用 RFC 3161 标准以提高安全性）
$TimestampUrl = if ($env:CODE_SIGN_TIMESTAMP_URL) {
    $env:CODE_SIGN_TIMESTAMP_URL
} else {
    "http://timestamp.sectigo.com"
}

# signtool.exe 路径（自动在 Windows Kits 中搜索绝对路径，避免依赖 PATH）
$SignTool = @(Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue)[0]
if ($SignTool) { $SignTool = $SignTool.FullName } else { $SignTool = "signtool.exe" }

# 如果证书主题名称未配置，尝试使用默认方式签名
$CertSubject = if ($env:CODE_SIGN_CERT_SUBJECT) {
    $env:CODE_SIGN_CERT_SUBJECT
} else {
    $null
}

# ---- 检查文件 ----
if (-not (Test-Path $FilePath)) {
    Write-Error "文件不存在: $FilePath"
    exit 1
}

Write-Host "=== TizuMark Code Signing ===" -ForegroundColor Cyan
Write-Host "目标文件: $FilePath" -ForegroundColor White

# ---- 执行签名 ----
try {
    if ($CertSubject) {
        # 使用指定的证书主题
        Write-Host "证书主题: $CertSubject" -ForegroundColor White
        Write-Host "时间戳服务器: $TimestampUrl" -ForegroundColor White

        & $SignTool sign /fd SHA256 `
            /s My `
            /n "$CertSubject" `
            /tr $TimestampUrl `
            /td SHA256 `
            /v `
            $FilePath
    } else {
        # 自动选择最佳证书（使用证书存储中的第一个有效代码签名证书）
        Write-Host "证书: 自动选择" -ForegroundColor White
        Write-Host "时间戳服务器: $TimestampUrl" -ForegroundColor White

        & $SignTool sign /fd SHA256 `
            /a `
            /tr $TimestampUrl `
            /td SHA256 `
            /v `
            $FilePath
    }

    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ 签名成功: $FilePath" -ForegroundColor Green
        exit 0
    } else {
        Write-Error "签名失败 (exit code: $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
} catch {
    Write-Error "签名过程出错: $_"
    exit 1
}
