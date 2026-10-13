$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html'))) { throw 'Run npm ci and npm run build first.' }
try {
  $response = Invoke-WebRequest 'http://127.0.0.1:4317/' -TimeoutSec 2
  if ($response.StatusCode -eq 200) { Write-Output 'Already running: http://127.0.0.1:4317'; return }
} catch {}
$taskNode = (Get-Command node.exe).Source
$taskState = Join-Path $taskRoot '.controlroom'
New-Item -ItemType Directory -Path $taskState -Force | Out-Null
Start-Process -FilePath $taskNode -ArgumentList @(('"' + (Join-Path $taskRoot 'server/index.mjs') + '"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskState 'service.log') -RedirectStandardError (Join-Path $taskState 'service-error.log') | Out-Null
Write-Output 'Starting: http://127.0.0.1:4317'
