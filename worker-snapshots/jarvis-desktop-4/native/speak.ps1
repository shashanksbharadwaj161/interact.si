# Input: {text, voice}. Local System.Speech synthesis to the default audio device. No network.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $in = Read-JarvisInput
    Add-Type -AssemblyName System.Speech
    $text = [string]$in.text
    if ([string]::IsNullOrWhiteSpace($text)) { Write-JarvisResult ([ordered]@{ ok = $false; reason = 'Nothing to speak' }); exit 0 }
    if ($text.Length -gt 4000) { Write-JarvisResult ([ordered]@{ ok = $false; reason = 'Text is too long' }); exit 0 }
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $names = @(); foreach ($v in $s.GetInstalledVoices()) { if ($v.Enabled) { $names += $v.VoiceInfo.Name } }
        if ($names.Count -eq 0) { Write-JarvisResult ([ordered]@{ ok = $false; reason = 'No Windows voices are installed' }); exit 0 }
        $voice = [string]$in.voice
        if (-not [string]::IsNullOrWhiteSpace($voice)) {
            if ($names -notcontains $voice) { Write-JarvisResult ([ordered]@{ ok = $false; reason = "Voice '$voice' is not installed" }); exit 0 }
            $s.SelectVoice($voice)
        }
        $s.SetOutputToDefaultAudioDevice()
        $s.Speak($text)
    } finally { $s.Dispose() }
    Write-JarvisResult ([ordered]@{ ok = $true })
} catch { Write-JarvisResult ([ordered]@{ ok = $false; reason = $_.Exception.Message }) }
