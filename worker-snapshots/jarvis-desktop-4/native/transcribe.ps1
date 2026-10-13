# Input: {wavPath}. Local System.Speech dictation of a PCM WAV file. No cloud, no microphone access here.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $in = Read-JarvisInput
    Add-Type -AssemblyName System.Speech
    $path = [string]$in.wavPath
    if ([System.IO.Path]::GetFileName($path) -notmatch '^jarvis-[0-9a-f-]+\.wav$') { Write-JarvisResult ([ordered]@{ ok = $false; text = ''; reason = 'Unexpected audio file name' }); exit 0 }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Write-JarvisResult ([ordered]@{ ok = $false; text = ''; reason = 'Audio file not found' }); exit 0 }
    $infos = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
    if ($infos.Count -eq 0) { Write-JarvisResult ([ordered]@{ ok = $true; text = ''; reason = 'No Windows speech recognizer is installed' }); exit 0 }
    $ui = [System.Globalization.CultureInfo]::CurrentUICulture.Name
    $pick = $infos | Where-Object { $_.Culture.Name -eq $ui } | Select-Object -First 1
    if (-not $pick) { $pick = $infos | Where-Object { $_.Culture.Name -eq 'en-US' } | Select-Object -First 1 }
    if (-not $pick) { $pick = $infos[0] }
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($pick)
    try {
        $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
        $engine.SetInputToWaveFile($path)
        $parts = @()
        for ($i = 0; $i -lt 100; $i++) {
            $r = $engine.Recognize()
            if ($r -eq $null) { break }
            if ($r.Text) { $parts += $r.Text }
        }
    } finally { $engine.Dispose() }
    $joined = ($parts -join ' ').Trim()
    if (-not $joined) { Write-JarvisResult ([ordered]@{ ok = $true; text = ''; reason = 'No speech was recognized'; recognizer = $pick.Culture.Name }) }
    else { Write-JarvisResult ([ordered]@{ ok = $true; text = $joined; recognizer = $pick.Culture.Name }) }
} catch { Write-JarvisResult ([ordered]@{ ok = $false; text = ''; reason = $_.Exception.Message }) }
