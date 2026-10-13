# Input: {hwnd, pid}. Brings the approved window to the foreground. Refuses elevated/unknown-integrity targets.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $in = Read-JarvisInput
    Add-JarvisWin32
    $err = Test-JarvisTarget $in.hwnd $in.pid
    if ($err) { Write-JarvisResult ([ordered]@{ ok = $false; error = $err }); exit 0 }
    if ([Jarvis.Win32]::Elevated([int]$in.pid) -ne 0) { Write-JarvisResult ([ordered]@{ ok = $false; error = 'Target is elevated or protected' }); exit 0 }
    $focused = [Jarvis.Win32]::Focus([long]$in.hwnd)
    Write-JarvisResult ([ordered]@{ ok = $true; focused = $focused })
} catch { Write-JarvisResult ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
