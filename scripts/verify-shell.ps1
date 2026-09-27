# 自动验证「点击穿透」是否按设计工作。
#
# 原理：真正移动系统指针到桌宠上 / 空白处，然后读应用暴露的 /__shell/state，
# 看交互状态有没有跟着切换。跑完会把指针还原到原位置。
#
# 封闭性：用独立端口 + --standalone 启动自己的实例。
# 否则若用户已经开着一只常驻桌宠，新实例会被单实例锁顶掉，
# 脚本就会误测到那只旧的（我们踩过这个坑）。
#
# 断言方式：**轮询等待到达期望状态**，而不是"睡固定时长后读一次"。
# 后者在机器繁忙时会读到上一步的旧值 —— 失败模式表现为"错位一拍"
# （该接管时说没接管、回到空白时反而说接管了），是脚本脆弱而不是功能坏。
#
# 用法: powershell -File scripts/verify-shell.ps1

param([int]$Port = 38977, [int]$BootTimeoutSec = 40, [int]$WaitTimeoutMs = 5000)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Add-Type -Namespace Win -Name Cursor -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
'@

function Get-State {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__shell/state" -TimeoutSec 5 } catch { return $null }
}

# 轮询到满足条件为止；返回 @{ ok; state }
function Wait-State {
  param([scriptblock]$Predicate)
  $deadline = (Get-Date).AddMilliseconds($WaitTimeoutMs)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    $last = Get-State
    if ($last -and (& $Predicate $last)) { return @{ ok = $true; state = $last } }
    Start-Sleep -Milliseconds 250
  }
  return @{ ok = $false; state = $last }
}

function Describe($state) {
  if (-not $state) { return '(无响应)' }
  return "interactive=$($state.interactive) ignore=$($state.ignoreMouseEvents)"
}

# ---- 记住原指针位置，最后还原 ----
$origin = New-Object 'Win.Cursor+POINT'
[void][Win.Cursor]::GetCursorPos([ref]$origin)
Write-Host "原指针位置: $($origin.X),$($origin.Y)"

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "找不到 electron.exe，先跑 npm install" }

Write-Host "启动应用（独立实例，端口 $Port）..."
$proc = Start-Process -FilePath $electron -ArgumentList '.', '--standalone', "--port=$Port" -WorkingDirectory $root -PassThru

$results = [ordered]@{}
$lines = [ordered]@{}
try {
  # ---- 等待启动 ----
  $state = $null
  $deadline = (Get-Date).AddSeconds($BootTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $state = Get-State
    if ($state -and $state.petRect) { break }
  }
  if (-not $state -or -not $state.petRect) { throw "应用未在 $BootTimeoutSec 秒内就绪（拿不到 petRect）" }
  Write-Host "就绪。桌宠矩形: x=$($state.petRect.x) y=$($state.petRect.y) w=$($state.petRect.w) h=$($state.petRect.h)"
  Write-Host "工作区: $($state.workArea.width)x$($state.workArea.height)"

  $cx = [int]($state.petRect.x + $state.petRect.w / 2)
  $cy = [int]($state.petRect.y + $state.petRect.h / 2)
  $emptyX = [int]($state.workArea.width / 2)
  $emptyY = [int]($state.workArea.height / 4)

  # ---- 1) 指针移到空白处，应该保持穿透 ----
  [void][Win.Cursor]::SetCursorPos($emptyX, $emptyY)
  $r1 = Wait-State { param($s) (-not $s.interactive) -and $s.ignoreMouseEvents }
  $results['空白处应穿透'] = $r1.ok
  $lines['空白处应穿透'] = Describe $r1.state

  # ---- 2) 指针移到桌宠身上，应该接管鼠标 ----
  [void][Win.Cursor]::SetCursorPos($cx, $cy)
  $r2 = Wait-State { param($s) $s.interactive -and (-not $s.ignoreMouseEvents) }
  $results['桌宠上应接管'] = $r2.ok
  $lines['桌宠上应接管'] = Describe $r2.state

  # ---- 3) 再移回空白处，应该恢复穿透 ----
  [void][Win.Cursor]::SetCursorPos($emptyX, $emptyY)
  $r3 = Wait-State { param($s) (-not $s.interactive) -and $s.ignoreMouseEvents }
  $results['离开后应恢复穿透'] = $r3.ok
  $lines['离开后应恢复穿透'] = Describe $r3.state
}
finally {
  [void][Win.Cursor]::SetCursorPos($origin.X, $origin.Y)
  if ($proc -and -not $proc.HasExited) {
    & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
  }
}

Write-Host ''
$failed = 0
foreach ($k in $results.Keys) {
  $ok = $results[$k]
  if (-not $ok) { $failed++ }
  Write-Host ("{0}  {1}   <- {2}" -f $(if ($ok) { '[PASS]' } else { '[FAIL]' }), $k, $lines[$k])
}
if ($failed -gt 0) { Write-Host "`n$failed 项未通过"; exit 1 }
Write-Host "`n点击穿透验证全部通过"
