$ErrorActionPreference='Stop'
$taskWorkspace=Split-Path $PSScriptRoot -Parent
$taskRuntime=Join-Path $PSScriptRoot 'tools/ollama/runtime'
$taskModels=Join-Path $PSScriptRoot 'tools/ollama/models'
New-Item -ItemType Directory -Path $taskModels -Force | Out-Null
$env:OLLAMA_HOST='127.0.0.1:11435'
$env:OLLAMA_MODELS=$taskModels
$env:OLLAMA_NO_CLOUD='1'
$env:OLLAMA_KEEP_ALIVE='0'
$env:OLLAMA_MAX_LOADED_MODELS='1'
$env:OLLAMA_NUM_PARALLEL='1'
$env:OLLAMA_CONTEXT_LENGTH='2048'
$env:OLLAMA_FLASH_ATTENTION='1'
$env:OLLAMA_KV_CACHE_TYPE='q8_0'
try { Invoke-RestMethod 'http://127.0.0.1:11435/api/version' -TimeoutSec 2 | Out-Null; Write-Output 'Dedicated local runtime already running.'; return } catch {}
Start-Process -FilePath (Join-Path $taskRuntime 'ollama.exe') -ArgumentList 'serve' -WorkingDirectory $taskRuntime -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'tools/ollama/server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'tools/ollama/server-error.log') | Out-Null
Write-Output 'Local-only Ollama started at 127.0.0.1:11435. Models unload after each request.'
