# Input: {hwnd, pid, x, y, width, height}. Moves/resizes the approved window, clamped to the visible virtual screen.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $in = Read-JarvisInput
    Add-JarvisWin32
    $err = Test-JarvisTarget $in.hwnd $in.pid
    if ($err) { Write-JarvisResult ([ordered]@{ ok = $false; error = $err }); exit 0 }
    if ([Jarvis.Win32]::Elevated([int]$in.pid) -ne 0) { Write-JarvisResult ([ordered]@{ ok = $false; error = 'Target is elevated or protected' }); exit 0 }
    $after = New-Object Jarvis.RECT
    $clamped = [Jarvis.Win32]::Move([long]$in.hwnd, [int]$in.x, [int]$in.y, [int]$in.width, [int]$in.height, [ref]$after)
    Write-JarvisResult ([ordered]@{ ok = $true; clamped = $clamped; x = $after.Left; y = $after.Top; width = ($after.Right - $after.Left); height = ($after.Bottom - $after.Top) })
} catch { Write-JarvisResult ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
