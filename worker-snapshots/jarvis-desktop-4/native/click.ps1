# Input: {hwnd, pid, x, y} in screen pixels. Single left click, only if the approved window is foreground and
# the point lies inside it and is not covered by another process's window.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $in = Read-JarvisInput
    Add-JarvisWin32
    $err = Test-JarvisTarget $in.hwnd $in.pid
    if ($err) { Write-JarvisResult ([ordered]@{ ok = $false; error = $err }); exit 0 }
    if ([Jarvis.Win32]::Foreground() -ne [long]$in.hwnd -or [Jarvis.Win32]::ForegroundPid() -ne [int]$in.pid) {
        Write-JarvisResult ([ordered]@{ ok = $false; error = 'Target window is not the foreground window; no click was sent' }); exit 0
    }
    if ([Jarvis.Win32]::Elevated([int]$in.pid) -ne 0) { Write-JarvisResult ([ordered]@{ ok = $false; error = 'Target is elevated or protected' }); exit 0 }
    $r = [Jarvis.Win32]::Rect([long]$in.hwnd)
    $x = [int]$in.x; $y = [int]$in.y
    if ($x -lt $r.Left -or $x -ge $r.Right -or $y -lt $r.Top -or $y -ge $r.Bottom) {
        Write-JarvisResult ([ordered]@{ ok = $false; error = 'The point is outside the approved window' }); exit 0
    }
    if (-not [Jarvis.Win32]::PointBelongsTo($x, $y, [int]$in.pid)) {
        Write-JarvisResult ([ordered]@{ ok = $false; error = 'Another window covers that point' }); exit 0
    }
    [Jarvis.Win32]::Click($x, $y)
    Write-JarvisResult ([ordered]@{ ok = $true })
} catch { Write-JarvisResult ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
