# Can this process actually drive the mouse? Run this BEFORE blaming the app.
#
# Why it exists: verify-shell.ps1 (click-through) and open-dsh-e2e.ps1 (real mouse
# click on the menu) both move the system pointer with SetCursorPos. On a locked
# screen / session without an active input desktop, SetCursorPos silently returns
# FALSE and the cursor never moves -- the scripts then report confusing assertion
# failures ("the pet did not take over the mouse") even though the app is fine.
# We hit exactly that: verify-shell passed, then failed ten minutes later with no
# code change, because the desktop stopped being drivable.
#
# Exit code: 0 = the pointer can be moved, 3 = it cannot (environment, not code).
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as GBK.

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Win -Name CursorCheck -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
[DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
'@

$p = New-Object 'Win.CursorCheck+POINT'
[void][Win.CursorCheck]::GetCursorPos([ref]$p)
Write-Host "cursor now = $($p.X),$($p.Y)"

$same = [Win.CursorCheck]::SetCursorPos($p.X, $p.Y)
$shift = [Win.CursorCheck]::SetCursorPos($p.X + 1, $p.Y)
[void][Win.CursorCheck]::SetCursorPos($p.X, $p.Y)
Write-Host "SetCursorPos(same) = $same   SetCursorPos(+1) = $shift"

$desktop = [Win.CursorCheck]::OpenInputDesktop(0, $false, 0x0100)
Write-Host "OpenInputDesktop = $desktop"
if ($desktop -ne [IntPtr]::Zero) { [void][Win.CursorCheck]::CloseDesktop($desktop) }

Write-Host ''
try { quser 2>&1 | Write-Host } catch { Write-Host '(quser unavailable)' }

Write-Host ''
if ($same -or $shift) {
  Write-Host 'RESULT: OK - the pointer can be moved, mouse-driven checks are usable'
  exit 0
}
Write-Host 'RESULT: NOT DRIVABLE - SetCursorPos is being refused.'
Write-Host '  Typical causes: the screen is locked, the session has no active input'
Write-Host '  desktop (RDP disconnected / fast user switching), or another process'
Write-Host '  holds the input desktop. Mouse-driven checks (verify:shell,'
Write-Host '  e2e:open-dsh) cannot run now; the headless probes still can:'
Write-Host '    npm run test:cost / open-dsh:probe / settings:probe / menu:probe'
Write-Host '  Unlock the screen (and keep it unlocked) and run it again.'
exit 3
