# Local OCR of ONE user-selected image through the Windows.Media.Ocr engine that ships with Windows 10/11. Original code.
# Windows PowerShell 5.1. No network, no download, no screen capture: it only decodes the bytes of the file it is given.
# Input (stdin JSON):
#   {op:'probe'}                                  read-only: which OCR languages the OS has installed
#   {op:'recognize', path, sha256, language?, maxBytes, maxDimension, maxPixels}
# Output: one JSON line. Failures carry a short code and a fixed message; the path and exception text are never echoed.
. (Join-Path $PSScriptRoot 'common.ps1')

function Fail($code, $reason) { Write-JarvisResult ([ordered]@{ ok = $false; code = $code; reason = $reason }); exit 0 }

# Resolve a WinRT async operation synchronously with a bounded wait.
function Wait-Op($op, [Type]$resultType, [int]$timeoutMs) {
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
        Select-Object -First 1
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($op))
    if (-not $task.Wait($timeoutMs)) { throw 'timeout' }
    return $task.Result
}

$engineType = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $engineType = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
} catch { $engineType = $null }

try {
    $in = Read-JarvisInput
    $op = [string]$in.op

    if ($op -eq 'probe') {
        if (-not $engineType) {
            Write-JarvisResult ([ordered]@{ ok = $true; available = $false; reason = 'The Windows OCR runtime is not available on this system'; languages = @(); profileLanguage = $null; maxImageDimension = 0 })
            exit 0
        }
        $langs = @()
        foreach ($l in $engineType::AvailableRecognizerLanguages) { $langs += [string]$l.LanguageTag }
        $profile = $null
        $pe = $engineType::TryCreateFromUserProfileLanguages()
        if ($pe) { $profile = [string]$pe.RecognizerLanguage.LanguageTag }
        $reason = $null
        if ($langs.Count -eq 0) { $reason = 'No Windows OCR language pack is installed. Add one in Windows language settings' }
        Write-JarvisResult ([ordered]@{ ok = $true; available = ($langs.Count -gt 0); reason = $reason; languages = $langs; profileLanguage = $profile; maxImageDimension = [int]$engineType::MaxImageDimension })
        exit 0
    }

    if ($op -ne 'recognize') { Fail 'invalid-request' 'Unknown OCR operation' }
    if (-not $engineType) { Fail 'unavailable' 'The Windows OCR runtime is not available on this system' }

    $path = [string]$in.path
    $maxBytes = [long]$in.maxBytes; $maxDim = [int]$in.maxDimension; $maxPixels = [long]$in.maxPixels
    $want = ([string]$in.sha256).ToLowerInvariant()
    if ($maxBytes -lt 1 -or $maxDim -lt 1 -or $maxPixels -lt 1) { Fail 'invalid-request' 'Missing image limits' }
    if ($want -notmatch '^[0-9a-f]{64}$') { Fail 'invalid-request' 'Missing image fingerprint' }
    if ($path -notmatch '^[A-Za-z]:\\' -or $path.Contains('..') -or $path.Substring(2).Contains(':')) { Fail 'invalid-image' 'The image must be on a local drive' }

    # Every component from the drive root down must be a real folder or file, never a link or junction.
    $cur = [System.IO.Path]::GetPathRoot($path)
    foreach ($part in @($path.Substring($cur.Length).Split('\') | Where-Object { $_ })) {
        $cur = [System.IO.Path]::Combine($cur, $part)
        if (-not (Test-Path -LiteralPath $cur)) { Fail 'invalid-image' 'The image no longer exists' }
        if (([System.IO.File]::GetAttributes($cur) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'invalid-image' 'The image location goes through a link or junction' }
    }
    if (([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::Directory) -ne 0) { Fail 'invalid-image' 'The chosen item is not a file' }

    # Read once with a hard cap, then require the same bytes the app already validated.
    $bytes = $null
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        if ($fs.Length -gt $maxBytes) { Fail 'too-large' 'The image file is too large' }
        $bytes = New-Object byte[] ([int]$fs.Length)
        $got = 0
        while ($got -lt $bytes.Length) { $n = $fs.Read($bytes, $got, $bytes.Length - $got); if ($n -le 0) { break }; $got += $n }
        if ($got -ne $bytes.Length) { Fail 'changed' 'The image changed while it was being read' }
    } finally { $fs.Dispose() }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $have = ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($have -ne $want) { Fail 'changed' 'The image changed after it was checked' }

    # Engine: the requested language only. No silent fallback to a different language.
    $lang = [string]$in.language
    $engine = $null
    if ($lang) {
        if ($lang -notmatch '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$') { Fail 'invalid-request' 'The OCR language tag is not valid' }
        $l = New-Object Windows.Globalization.Language($lang)
        if (-not $engineType::IsLanguageSupported($l)) { Fail 'language-unavailable' 'That OCR language is not installed in Windows' }
        $engine = $engineType::TryCreateFromLanguage($l)
    } else {
        $engine = $engineType::TryCreateFromUserProfileLanguages()
    }
    if (-not $engine) { Fail 'language-unavailable' 'No installed OCR language matches your Windows profile languages' }
    $limit = [Math]::Min($maxDim, [int]$engineType::MaxImageDimension)

    $ms = New-Object System.IO.MemoryStream(, $bytes)
    $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    try {
        try { $decoder = Wait-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder]) 20000 }
        catch { Fail 'invalid-image' 'Windows could not decode this image' }
        $w = [long]$decoder.PixelWidth; $h = [long]$decoder.PixelHeight
        if ($w -gt $limit -or $h -gt $limit -or ($w * $h) -gt $maxPixels) { Fail 'too-large' 'The image dimensions are too large for OCR' }
        if ($w -lt 16 -or $h -lt 16) { Fail 'invalid-image' 'The image is too small for OCR' }
        $bmp = Wait-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]) 20000
        try {
            $res = Wait-Op ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult]) 25000
        } finally { $bmp.Dispose() }
    } finally { $ras.Dispose(); $ms.Dispose() }

    $lines = @()
    foreach ($ln in $res.Lines) { if ($lines.Count -ge 5000) { break }; $t = [string]$ln.Text; if ($t.Length -gt 2000) { $t = $t.Substring(0, 2000) }; $lines += $t }
    Write-JarvisResult ([ordered]@{ ok = $true; lines = $lines; language = [string]$engine.RecognizerLanguage.LanguageTag; width = $w; height = $h })
} catch {
    if ($_.Exception.Message -eq 'timeout') { Fail 'failed' 'Windows OCR timed out' }
    Fail 'failed' 'Windows OCR failed'
}
