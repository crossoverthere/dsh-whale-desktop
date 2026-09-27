# 自动验证「点击穿透」是否按设计工作。
#
# 原理：真正移动系统指针到桌宠上 / 空白处，然后读应用暴露的 /__shell/state，
# 看交互状态有没有跟着切换。跑完会把指针还原到原位置。
#
# 用法: pwsh -File scripts/verify-shell.ps1

param([int]$Port = 38911, [int]$BootTimeoutSec = 40)

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

# ---- 记住原指针位置，最后还原 ----
$origin = New-Object 'Win.Cursor+POINT'
[void][Win.Cursor]::GetCursorPos([ref]$origin)
Write-Host "原指针位置: $($origin.X),$($origin.Y)"

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "找不到 electron.exe，先跑 npm install" }

Write-Host '启动应用 ...'
$proc = Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $root -PassThru

$results = [ordered]@{}
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
  Start-Sleep -Milliseconds 1200
  $s1 = Get-State
  $results['空白处应穿透'] = ($s1.interactive -eq $false) -and ($s1.ignoreMouseEvents -eq $true)
  Write-Host "  空白处 -> interactive=$($s1.interactive) ignore=$($s1.ignoreMouseEvents) 期望 False/True"

  # ---- 2) 指针移到桌宠身上，应该接管鼠标 ----
  [void][Win.Cursor]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 1200
  $s2 = Get-State
  $results['桌宠上应接管'] = ($s2.interactive -eq $true) -and ($s2.ignoreMouseEvents -eq $false)
  Write-Host "  桌宠上 -> interactive=$($s2.interactive) ignore=$($s2.ignoreMouseEvents) 期望 True/False"

  # ---- 3) 再移回空白处，应该恢复穿透 ----
  [void][Win.Cursor]::SetCursorPos($emptyX, $emptyY)
  Start-Sleep -Milliseconds 1200
  $s3 = Get-State
  $results['离开后应恢复穿透'] = ($s3.interactive -eq $false) -and ($s3.ignoreMouseEvents -eq $true)
  Write-Host "  再回空白 -> interactive=$($s3.interactive) ignore=$($s3.ignoreMouseEvents) 期望 False/True"
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
  Write-Host ("{0}  {1}" -f $(if ($ok) { '[PASS]' } else { '[FAIL]' }), $k)
}
if ($failed -gt 0) { Write-Host "`n$failed 项未通过"; exit 1 }
Write-Host "`n点击穿透验证全部通过"
