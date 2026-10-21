# Shared UI Automation helpers for uia-inspect.ps1 and uia-act.ps1. Original code. Windows PowerShell 5.1 compatible.
# Reads element properties only; password values are never read.

function Get-JarvisUiaPatterns($el) {
    $found = [ordered]@{}
    $pairs = @(
        @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
        @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern),
        @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
        @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern),
        @('ScrollItem', [System.Windows.Automation.ScrollItemPattern]::Pattern),
        @('Scroll', [System.Windows.Automation.ScrollPattern]::Pattern),
        @('Value', [System.Windows.Automation.ValuePattern]::Pattern)
    )
    foreach ($p in $pairs) {
        $o = $null
        try { if ($el.TryGetCurrentPattern($p[1], [ref]$o) -and $o -ne $null) { $found[$p[0]] = $o } } catch { }
    }
    return $found
}

function Get-JarvisUiaNode($el, [string]$prid, [int]$procId) {
    $c = $el.Current
    if ([int]$c.ProcessId -ne $procId) { return $null }
    $rid = (@($el.GetRuntimeId()) -join '.')
    if ([string]::IsNullOrEmpty($rid)) { return $null }
    $type = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
    $pat = Get-JarvisUiaPatterns $el
    $node = [ordered]@{
        rid = $rid; prid = $prid; type = $type; pid = [int]$c.ProcessId
        name = [string]$c.Name; aid = [string]$c.AutomationId; cls = [string]$c.ClassName
        enabled = [bool]$c.IsEnabled; offscreen = [bool]$c.IsOffscreen; password = [bool]$c.IsPassword
        focusable = [bool]$c.IsKeyboardFocusable; focused = [bool]$c.HasKeyboardFocus
        patterns = @($pat.Keys)
    }
    if ($pat.Contains('Toggle')) { $node.toggle = [string]$pat['Toggle'].Current.ToggleState }
    if ($pat.Contains('ExpandCollapse')) { $node.expand = [string]$pat['ExpandCollapse'].Current.ExpandCollapseState }
    if ($pat.Contains('SelectionItem')) { $node.selected = [bool]$pat['SelectionItem'].Current.IsSelected }
    if ($pat.Contains('Value') -and -not $c.IsPassword) {
        $v = [string]$pat['Value'].Current.Value
        if ($v.Length -gt 200) { $v = $v.Substring(0, 200) }
        $node.value = $v
        $node.readOnly = [bool]$pat['Value'].Current.IsReadOnly
    }
    return $node
}

# Finds the one element with this runtime id under the window. Returns @(element, count); count > 1 is ambiguous.
function Find-JarvisUiaElement($root, [string]$rid) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($root)
    $seen = 0; $hit = $null; $count = 0
    while ($queue.Count -gt 0 -and $seen -lt 3000 -and [DateTime]::UtcNow -lt $deadline) {
        $el = $queue.Dequeue(); $seen++
        try {
            if ((@($el.GetRuntimeId()) -join '.') -eq $rid) { $count++; if ($hit -eq $null) { $hit = $el } }
            $c = $walker.GetFirstChild($el); $n = 0
            while ($c -ne $null -and $n -lt 200) { $queue.Enqueue($c); $n++; $c = $walker.GetNextSibling($c) }
        } catch { }
    }
    return @($hit, $count)
}
