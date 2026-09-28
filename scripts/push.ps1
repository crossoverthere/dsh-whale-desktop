# 推送助手：自动判断要不要走代理。
#
# 背景：这台机器上 github.com 的 API 与 codeload 都直连正常，
# 但 git 的 push 端点（git-receive-pack）会被重置，表现为
#   fatal: unable to access '...': Recv failure: Connection was reset
# 而走本机 Clash 代理（mixed-port 7890）即可正常推送。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/push.ps1                 # 推到 origin/main
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/push.ps1 -Branch dev
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/push.ps1 -NoProxy        # 强制直连
#
# 注意：**退出码不可信**。git 的进度输出走 stderr，PowerShell 会把它当错误，
# 于是推成功了也可能 exit 1。以 `git ls-remote origin refs/heads/main` 的 SHA 为准。

param(
  [string]$Remote = 'origin',
  [string]$Branch = 'main',
  [int]$ProxyPort = 7890,
  [switch]$NoProxy
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$useProxy = $false
if (-not $NoProxy) {
  $listening = & netstat -ano | Select-String ":$ProxyPort" | Select-String 'LISTENING'
  if ($listening) { $useProxy = $true }
}

if ($useProxy) {
  $px = "http://127.0.0.1:$ProxyPort"
  Write-Host "[push] 检测到本机代理 $px，经代理推送（只对本次命令生效，不写进 git 配置）"
  & git -C $root -c "http.proxy=$px" -c "https.proxy=$px" push $Remote $Branch
} else {
  Write-Host '[push] 未检测到代理，直连推送'
  & git -C $root push $Remote $Branch
}

if ($LASTEXITCODE -ne 0 -and $useProxy) {
  Write-Host '[push] 经代理仍失败，尝试改用 HTTP/1.1 直连 ...'
  & git -C $root -c http.version=HTTP/1.1 push $Remote $Branch
}

exit $LASTEXITCODE
