# End-to-end check of "open DSH when DSH is NOT running" -- the exact user scenario.
#
# What it does, and why it is safe to run on a machine that is using DSH right now:
#   * starts a --standalone pet instance (that mode is always dry-run -> no browser pops up)
#   * temporarily points config.dshUrl at a FREE port, so the pet really takes the
#     "not running" path and starts a DSH service there (the live 3080 is untouched)
#   * DSH_HOME is an isolated throwaway home under tmp/
#   * the click is done with the REAL mouse: right click the whale, then click the item
#   * config.json is backed up first and restored at the end; the service is stopped by port
#
# Exit code 0 = the pet started a service and reported it as started.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/open-dsh-e2e.ps1
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as GBK and would choke.

param(
  [int]$PetPort = 38916,
  [int]$DshPort = 3093
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$userData = Join-Path $env:APPDATA 'dsh-whale-desktop'
$configFile = Join-Path $userData 'config.json'
$backup = Join-Path $root 'tmp\config-backup.json'
$dshHome = Join-Path $root 'tmp\dsh-home-e2e'
$dshUrl = "http://127.0.0.1:$DshPort"

Add-Type -Namespace Win -Name Cursor -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
'@
$RIGHT_DOWN = 0x0008; $RIGHT_UP = 0x0010; $LEFT_DOWN = 0x0002; $LEFT_UP = 0x0004

function Get-State {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$PetPort/__shell/state" -TimeoutSec 5 } catch { return $null }
}

# Preflight: on a locked screen / session without an active input desktop,
# SetCursorPos is refused and this whole script would report a bogus FAIL.
$probe = New-Object 'Win.Cursor+POINT'
[void][Win.Cursor]::GetCursorPos([ref]$probe)
$drivable = [Win.Cursor]::SetCursorPos($probe.X, $probe.Y) -or [Win.Cursor]::SetCursorPos($probe.X + 1, $probe.Y)
[void][Win.Cursor]::SetCursorPos($probe.X, $probe.Y)
if (-not $drivable) {
  Write-Host 'SKIP: the pointer cannot be moved (locked screen / no active input desktop).'
  Write-Host '      Run scripts/check-desktop-input.ps1 for details; headless probes still work.'
  exit 3
}

# Kill by PORT, never by parent pid: taskkill /T on a parent that already exited
# happily orphans the real server (we lost three of them that way), and then the next
# run's readiness probe sees the *previous* service and looks "ready with an empty log".
function Stop-ByPort([int]$port) {
  foreach ($owner in (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess) {
    & taskkill /PID $owner /T /F 2>&1 | Out-Null
  }
}

if (-not (Test-Path $configFile)) { throw "config.json not found: $configFile (run the pet once first)" }
Copy-Item $configFile $backup -Force
$config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$config.dshUrl = $dshUrl
# Write without a BOM: Set-Content -Encoding UTF8 on PS 5.1 adds one, JSON.parse then
# fails and the pet silently falls back to defaults (i.e. keeps using 3080).
$json = $config | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($configFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "config.dshUrl patched to $((Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json).dshUrl)"

$origin = New-Object 'Win.Cursor+POINT'
[void][Win.Cursor]::GetCursorPos([ref]$origin)

Stop-ByPort $DshPort
New-Item -ItemType Directory -Force -Path $dshHome | Out-Null
$env:DSH_HOME = $dshHome
$env:DSH_SHELL = $null; $env:DSH_SESSION_ID = $null; $env:DSH_WEB_URL = $null
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "electron.exe not found - run npm install" }
$pet = Start-Process -FilePath $electron -ArgumentList '.', '--standalone', "--port=$PetPort" -WorkingDirectory $root -PassThru
Write-Host "standalone pet pid = $($pet.Id)   dshUrl = $dshUrl   DSH_HOME = $dshHome"

$passed = $false
try {
  # Readiness: petRect shows up while the page is still booting, and clicking then
  # does nothing at all (no menu, no log line) -- that cost us one confusing FAIL.
  # sayHook is only set once shell.js is alive, so wait for that too.
  $state = $null
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $state = Get-State
    if ($state -and $state.petRect -and $state.petRect.sayHook) { break }
  }
  if (-not $state -or -not $state.petRect -or -not $state.petRect.sayHook) { throw 'pet instance not ready (no sayHook)' }
  Write-Host "plan the pet would use = $($state.openDshPlan | ConvertTo-Json -Compress)"

  $cx = [int]($state.petRect.x + $state.petRect.w / 2)
  $cy = [int]($state.petRect.y + $state.petRect.h / 2)
  $w = $state.workArea.width; $h = $state.workArea.height

  # Menu geometry (measured by npm run menu:probe): 194x292 for 8 items, and
  # "open DSH" is item 7 -> index 6.
  $left = [Math]::Min([Math]::Max([Math]::Min($cx, $w - 180), 8), $w - 194 - 8)
  $top = [Math]::Min([Math]::Max([Math]::Min($cy, $h - 160), 8), $h - 292 - 8)
  $itemX = [int]($left + 194 / 2)
  $itemY = [int]($top + 292 * 6.5 / 8)
  Write-Host "pet center = $cx,$cy   item position = $itemX,$itemY"

  # The whale wanders (upstream idle behaviour), so never click at coordinates read a
  # while ago: re-read petRect each attempt, prove the pointer is on HER (the page
  # reports what is under the pointer in petRect.lastMouse.target), right click, then
  # prove the pointer is on the injected item before clicking it.
  $onItem = $false
  for ($attempt = 1; $attempt -le 6 -and -not $onItem; $attempt++) {
    $state = Get-State
    if (-not $state -or -not $state.petRect) { Start-Sleep -Milliseconds 500; continue }
    $cx = [int]($state.petRect.x + $state.petRect.w / 2)
    $cy = [int]($state.petRect.y + $state.petRect.h / 2)
    [void][Win.Cursor]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 500

    $hover = Get-State
    $target = if ($hover -and $hover.petRect -and $hover.petRect.lastMouse) { [string]$hover.petRect.lastMouse.target } else { '' }
    if ($target -notlike '*dsh-whale-frame*') {
      Write-Host "attempt $attempt : pointer is not on the whale yet (target=$target)"
      continue
    }

    [Win.Cursor]::mouse_event($RIGHT_DOWN, 0, 0, 0, [IntPtr]::Zero)
    [Win.Cursor]::mouse_event($RIGHT_UP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 900

    # menu geometry (measured by npm run menu:probe): 194x292 for 8 items,
    # "open DSH" is item 7 -> index 6
    $w = $state.workArea.width; $h = $state.workArea.height
    $left = [Math]::Min([Math]::Max([Math]::Min($cx, $w - 180), 8), $w - 194 - 8)
    $top = [Math]::Min([Math]::Max([Math]::Min($cy, $h - 160), 8), $h - 292 - 8)
    $itemX = [int]($left + 194 / 2)
    $itemY = [int]($top + 292 * 6.5 / 8)
    [void][Win.Cursor]::SetCursorPos($itemX, $itemY)

    $itemDeadline = (Get-Date).AddSeconds(4)
    while ((Get-Date) -lt $itemDeadline) {
      Start-Sleep -Milliseconds 300
      $hover2 = Get-State
      $target2 = if ($hover2 -and $hover2.petRect -and $hover2.petRect.lastMouse) { [string]$hover2.petRect.lastMouse.target } else { '' }
      if ($target2 -like '*data-dsh-open-dsh*') { $onItem = $true; break }
    }
    if (-not $onItem) {
      Write-Host "attempt $attempt : right click at $cx,$cy did not put the item under $itemX,$itemY (target=$target2)"
      [void][Win.Cursor]::SetCursorPos($cx, $cy)
      Start-Sleep -Milliseconds 300
      [Win.Cursor]::mouse_event($LEFT_DOWN, 0, 0, 0, [IntPtr]::Zero)
      [Win.Cursor]::mouse_event($LEFT_UP, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $onItem) {
    Write-Host 'WARN: could not confirm the pointer is on the item; clicking anyway and trusting the result'
    $state = Get-State
    $cx = [int]($state.petRect.x + $state.petRect.w / 2)
    $cy = [int]($state.petRect.y + $state.petRect.h / 2)
    $w = $state.workArea.width; $h = $state.workArea.height
    $left = [Math]::Min([Math]::Max([Math]::Min($cx, $w - 180), 8), $w - 194 - 8)
    $top = [Math]::Min([Math]::Max([Math]::Min($cy, $h - 160), 8), $h - 292 - 8)
    $itemX = [int]($left + 194 / 2)
    $itemY = [int]($top + 292 * 6.5 / 8)
    [void][Win.Cursor]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 600
    [Win.Cursor]::mouse_event($RIGHT_DOWN, 0, 0, 0, [IntPtr]::Zero)
    [Win.Cursor]::mouse_event($RIGHT_UP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 900
    [void][Win.Cursor]::SetCursorPos($itemX, $itemY)
    Start-Sleep -Milliseconds 500
  } else {
    Write-Host "cursor is on [data-dsh-open-dsh] at $itemX,$itemY -> clicking"
  }

  # The window only accepts the mouse while the pointer is on her; give that a beat.
  Start-Sleep -Milliseconds 500
  [Win.Cursor]::mouse_event($LEFT_DOWN, 0, 0, 0, [IntPtr]::Zero)
  [Win.Cursor]::mouse_event($LEFT_UP, 0, 0, 0, [IntPtr]::Zero)

  $result = $null
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 1000
    $after = Get-State
    if ($after -and $after.openDsh) { $result = $after.openDsh; break }
  }
  Write-Host "openDsh = $($result | ConvertTo-Json -Compress)"
  $owner = (Get-NetTCPConnection -LocalPort $DshPort -State Listen -ErrorAction SilentlyContinue).OwningProcess
  Write-Host "port $DshPort now owned by = $owner"
  $passed = [bool]($result -and $result.ok -and $result.started -and $owner -eq $result.pid)
}
finally {
  [void][Win.Cursor]::SetCursorPos($origin.X, $origin.Y)
  Stop-ByPort $DshPort
  if ($pet -and -not $pet.HasExited) { & taskkill /PID $pet.Id /T /F 2>&1 | Out-Null }
  Copy-Item $backup $configFile -Force
  Remove-Item $backup -Force -ErrorAction SilentlyContinue
  Write-Host 'config.json restored; test service stopped'
}

if ($passed) {
  Write-Host 'RESULT: PASS - a real click on a stopped DSH started the service and opened it'
  exit 0
}
Write-Host 'RESULT: FAIL'
exit 1
