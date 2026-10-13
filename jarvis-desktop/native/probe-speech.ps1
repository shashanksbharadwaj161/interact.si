# Lists installed local System.Speech voices and recognizers. Read-only.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $null = Read-JarvisInput
    Add-Type -AssemblyName System.Speech
    $voices = @()
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try { foreach ($v in $s.GetInstalledVoices()) { if ($v.Enabled) { $voices += $v.VoiceInfo.Name } } } finally { $s.Dispose() }
    $recs = @()
    foreach ($r in [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) { $recs += ($r.Culture.Name) }
    Write-JarvisResult ([ordered]@{ ok = $true; voices = $voices; recognizers = $recs })
} catch { Write-JarvisResult ([ordered]@{ ok = $false; error = $_.Exception.Message }) }
