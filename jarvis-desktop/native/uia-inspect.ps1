# Input: {hwnd, pid, maxNodes, maxDepth}. Reads a bounded list of the approved window's own UI Automation elements
# (control view, same process only). Never acts, never reads password values. One JSON line out.
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'uia-common.ps1')
try {
    $in = Read-JarvisInput
    Add-JarvisWin32
    $err = Test-JarvisTarget $in.hwnd $in.pid
    if ($err) { Write-JarvisResult ([ordered]@{ ok = $false; error = $err }); exit 0 }
    if ([Jarvis.Win32]::Elevated([int]$in.pid) -ne 0) { Write-JarvisResult ([ordered]@{ ok = $false; error = 'Target is elevated or protected' }); exit 0 }
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $max = [Math]::Max(1, [Math]::Min([int]$in.maxNodes, 200))
    $maxDepth = [Math]::Max(1, [Math]::Min([int]$in.maxDepth, 16))
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$in.hwnd)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $nodes = New-Object System.Collections.ArrayList
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($root, '', 0))
    $truncated = $false
    while ($stack.Count -gt 0) {
        if ($nodes.Count -ge $max -or [DateTime]::UtcNow -gt $deadline) { $truncated = $true; break }
        $item = $stack.Pop()
        $el = $item[0]; $prid = [string]$item[1]; $depth = [int]$item[2]
        $node = $null
        try { $node = Get-JarvisUiaNode $el $prid ([int]$in.pid) } catch { $node = $null }
        if ($node -eq $null) { continue }
        [void]$nodes.Add($node)
        if ($depth -ge $maxDepth) { $truncated = $true; continue }
        $kids = New-Object System.Collections.ArrayList
        try {
            $c = $walker.GetFirstChild($el)
            while ($c -ne $null -and $kids.Count -lt 200) { [void]$kids.Add($c); $c = $walker.GetNextSibling($c) }
        } catch { }
        for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], $node.rid, ($depth + 1))) }
    }
    Write-JarvisResult ([ordered]@{ ok = $true; nodes = @($nodes); truncated = $truncated })
} catch { Write-JarvisResult ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
