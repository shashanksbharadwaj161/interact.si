$ErrorActionPreference = 'Stop'
$taskConnection = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.controlroom/connection.json') -Raw | ConvertFrom-Json
$taskUrl = 'http://127.0.0.1:' + [int]$taskConnection.port + '/api/shutdown'
Invoke-RestMethod -Uri $taskUrl -Method Post -Headers @{ Authorization = ('Bearer ' + $taskConnection.token) } -ContentType 'application/json' -Body '{}' | Out-Null
Write-Output 'Stopped Control Room and its dedicated daemon. Real worker access revoked.'
