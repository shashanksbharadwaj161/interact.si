# Input: {op: 'protect'|'unprotect'|'probe', data}. Windows DPAPI (CurrentUser scope). Secret arrives on stdin only.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $in = Read-JarvisInput
    Add-Type -AssemblyName System.Security
    $entropy = [System.Text.Encoding]::UTF8.GetBytes('jarvis-desktop/cloud-key/v1')
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    switch ([string]$in.op) {
        'probe' {
            $c = [System.Security.Cryptography.ProtectedData]::Protect([byte[]](1, 2, 3), $entropy, $scope)
            $p = [System.Security.Cryptography.ProtectedData]::Unprotect($c, $entropy, $scope)
            Write-JarvisResult ([ordered]@{ ok = ($p.Length -eq 3) })
        }
        'protect' {
            $c = [System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes([string]$in.data), $entropy, $scope)
            Write-JarvisResult ([ordered]@{ ok = $true; data = [Convert]::ToBase64String($c) })
        }
        'unprotect' {
            $p = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$in.data), $entropy, $scope)
            Write-JarvisResult ([ordered]@{ ok = $true; data = [System.Text.Encoding]::UTF8.GetString($p) })
        }
        default { Write-JarvisResult ([ordered]@{ ok = $false; error = 'Unknown operation' }) }
    }
} catch { Write-JarvisResult ([ordered]@{ ok = $false; error = 'DPAPI operation failed' }) }
