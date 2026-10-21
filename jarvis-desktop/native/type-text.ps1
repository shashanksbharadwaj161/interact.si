# Input: {hwnd, pid, text}. Types into the approved window ONLY while it is the foreground window of the approved PID.
# Refuses elevated/unknown-integrity targets and password fields. Unicode SendInput, never SendKeys. Text is never echoed back.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $in = Read-JarvisInput
    Add-JarvisWin32
    $err = Test-JarvisTarget $in.hwnd $in.pid
    if ($err) { Write-JarvisResult ([ordered]@{ ok = $false; typed = 0; error = $err }); exit 0 }
    if ([Jarvis.Win32]::Foreground() -ne [long]$in.hwnd -or [Jarvis.Win32]::ForegroundPid() -ne [int]$in.pid) {
        Write-JarvisResult ([ordered]@{ ok = $false; typed = 0; error = 'Target window is not the foreground window; nothing was typed' }); exit 0
    }
    if ([Jarvis.Win32]::Elevated([int]$in.pid) -ne 0) { Write-JarvisResult ([ordered]@{ ok = $false; typed = 0; error = 'Target is elevated or protected' }); exit 0 }
    try {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $el = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($el -eq $null) { Write-JarvisResult ([ordered]@{ ok = $false; typed = 0; error = 'The focused field could not be verified; nothing was typed' }); exit 0 }
        if ($el -ne $null -and $el.Current.IsPassword) { Write-JarvisResult ([ordered]@{ ok = $false; typed = 0; error = 'The focused field is a password field' }); exit 0 }
    } catch {
        Write-JarvisResult ([ordered]@{ ok = $false; typed = 0; error = 'Could not verify that the focused field is not a password field' }); exit 0
    }
    $text = [string]$in.text
    if ($text.Length -gt 2000) { Write-JarvisResult ([ordered]@{ ok = $false; typed = 0; error = 'Text is too long' }); exit 0 }
    $typed = [Jarvis.Win32]::TypeText([long]$in.hwnd, [int]$in.pid, $text)
    if ($typed -lt $text.Replace("`r`n", "`n").Length) {
        Write-JarvisResult ([ordered]@{ ok = $false; typed = $typed; error = 'Focus left the approved window; typing stopped' }); exit 0
    }
    Write-JarvisResult ([ordered]@{ ok = $true; typed = $typed })
} catch { Write-JarvisResult ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
