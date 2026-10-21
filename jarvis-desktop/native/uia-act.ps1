# Input: {hwnd, pid, rid, expect: {type, name, aid}, action}. Runs ONE named UI Automation action on ONE element of the
# approved window, after finding it again by runtime id and checking it is still the same element (type, name,
# automation id), in the same process, enabled and not a password field. Then reads the element back. No coordinates,
# no keystrokes, no scripts. One JSON line out: {ok, performed, reason?, readback?}.
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'uia-common.ps1')
function Refuse([string]$why) { Write-JarvisResult ([ordered]@{ ok = $true; performed = $false; reason = $why }); exit 0 }
try {
    $in = Read-JarvisInput
    Add-JarvisWin32
    $err = Test-JarvisTarget $in.hwnd $in.pid
    if ($err) { Refuse $err }
    if ([Jarvis.Win32]::Elevated([int]$in.pid) -ne 0) { Refuse 'Target is elevated or protected' }
    $actions = @('invoke', 'toggle', 'expand', 'collapse', 'select', 'focus', 'scroll_into_view', 'scroll_up', 'scroll_down')
    $action = [string]$in.action
    if ($actions -notcontains $action) { Refuse 'Unknown action' }
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$in.hwnd)
    $found = Find-JarvisUiaElement $root ([string]$in.rid)
    if ($found[1] -eq 0) { Refuse 'The element is no longer in the app' }
    if ($found[1] -gt 1) { Refuse 'More than one element matches; nothing was done' }
    $el = $found[0]
    $node = Get-JarvisUiaNode $el '' ([int]$in.pid)
    if ($node -eq $null) { Refuse 'The element belongs to another program' }
    if ($node.password) { Refuse 'That is a password field' }
    if (-not $node.enabled) { Refuse 'The element is disabled' }
    if ($node.type -ne [string]$in.expect.type -or $node.name -ne [string]$in.expect.name -or $node.aid -ne [string]$in.expect.aid) { Refuse 'The element changed since the app was inspected' }
    $pat = Get-JarvisUiaPatterns $el
    switch ($action) {
        'invoke' { if (-not $pat.Contains('Invoke')) { Refuse 'Not supported by this element' }; $pat['Invoke'].Invoke() }
        'toggle' { if (-not $pat.Contains('Toggle')) { Refuse 'Not supported by this element' }; $pat['Toggle'].Toggle() }
        'expand' { if (-not $pat.Contains('ExpandCollapse')) { Refuse 'Not supported by this element' }; $pat['ExpandCollapse'].Expand() }
        'collapse' { if (-not $pat.Contains('ExpandCollapse')) { Refuse 'Not supported by this element' }; $pat['ExpandCollapse'].Collapse() }
        'select' { if (-not $pat.Contains('SelectionItem')) { Refuse 'Not supported by this element' }; $pat['SelectionItem'].Select() }
        'focus' { if (-not $node.focusable) { Refuse 'Not supported by this element' }; $el.SetFocus() }
        'scroll_into_view' { if (-not $pat.Contains('ScrollItem')) { Refuse 'Not supported by this element' }; $pat['ScrollItem'].ScrollIntoView() }
        'scroll_up' {
            if (-not $pat.Contains('Scroll') -or -not $pat['Scroll'].Current.VerticallyScrollable) { Refuse 'Not supported by this element' }
            $pat['Scroll'].ScrollVertical([System.Windows.Automation.ScrollAmount]::SmallDecrement)
        }
        'scroll_down' {
            if (-not $pat.Contains('Scroll') -or -not $pat['Scroll'].Current.VerticallyScrollable) { Refuse 'Not supported by this element' }
            $pat['Scroll'].ScrollVertical([System.Windows.Automation.ScrollAmount]::SmallIncrement)
        }
    }
    Start-Sleep -Milliseconds 200
    $rb = [ordered]@{ exists = $false }
    try {
        $again = Find-JarvisUiaElement $root ([string]$in.rid)
        if ($again[1] -eq 1) {
            $n2 = Get-JarvisUiaNode $again[0] '' ([int]$in.pid)
            if ($n2 -ne $null) {
                $rb = [ordered]@{ exists = $true; name = $n2.name; focused = $n2.focused; offscreen = $n2.offscreen }
                if ($n2.Contains('toggle')) { $rb.toggle = $n2.toggle }
                if ($n2.Contains('expand')) { $rb.expand = $n2.expand }
                if ($n2.Contains('selected')) { $rb.selected = $n2.selected }
            }
        }
    } catch { }
    Write-JarvisResult ([ordered]@{ ok = $true; performed = $true; readback = $rb })
} catch { Write-JarvisResult ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
