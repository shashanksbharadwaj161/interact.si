# Read-only: enumerate visible top-level windows (title, process, pid, rect). No window contents.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $null = Read-JarvisInput
    Add-JarvisWin32
    $list = [Jarvis.Win32]::List()
    $out = @()
    foreach ($w in $list) {
        $out += [ordered]@{
            hwnd = $w.Hwnd; title = $w.Title; pid = $w.Pid; process = $w.Process
            x = $w.X; y = $w.Y; width = $w.Width; height = $w.Height
            minimized = $w.Minimized; maximized = $w.Maximized; foreground = $w.Foreground; elevated = $w.Elevated
        }
    }
    Write-JarvisResult ([ordered]@{ ok = $true; windows = $out })
} catch { Write-JarvisResult ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
