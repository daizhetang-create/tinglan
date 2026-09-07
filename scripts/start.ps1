[CmdletBinding()]
param([switch]$NoOpen)
$ErrorActionPreference='Stop'
$tinglanRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $tinglanRoot
$nodeExecutable=(Get-Command node -ErrorAction Stop).Source
$serviceScript=Join-Path $PSScriptRoot 'serve.mjs'
$existing=$null
try{$existing=Invoke-RestMethod 'http://127.0.0.1:4318/__health' -TimeoutSec 2}catch{}
if($existing -and $existing.product -eq 'tinglan'){
  Write-Host "听澜正在运行：$($existing.version) $($existing.commit)"
  if(-not $NoOpen){Start-Process 'http://127.0.0.1:4318/'}
  exit 0
}
if(Get-NetTCPConnection -LocalPort 4318,4319 -State Listen -ErrorAction SilentlyContinue){throw '4318 或 4319 端口被其他程序占用。为保护正在使用的程序，未自动结束进程。'}
if(-not (Test-Path -LiteralPath (Join-Path $tinglanRoot 'node_modules'))){npm ci;if($LASTEXITCODE -ne 0){throw '安装依赖失败'}}
if(-not (Test-Path -LiteralPath (Join-Path $tinglanRoot 'dist/release.json'))){npm run build;if($LASTEXITCODE -ne 0){throw '构建失败'}}
$runtimeDirectory=Join-Path $tinglanRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$process=Start-Process -FilePath $nodeExecutable -ArgumentList @('"'+$serviceScript+'"') -WorkingDirectory $tinglanRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDirectory 'website.log') -RedirectStandardError (Join-Path $runtimeDirectory 'website-error.log')
$ready=$false
for($attempt=0;$attempt -lt 40;$attempt++){
  try{$health=Invoke-RestMethod 'http://127.0.0.1:4318/__health' -TimeoutSec 1;if($health.product -eq 'tinglan'){$ready=$true;break}}catch{}
  Start-Sleep -Milliseconds 250
}
if(-not $ready){throw "启动失败，请查看 $runtimeDirectory\website-error.log"}
Write-Host "听澜已启动：http://127.0.0.1:4318/ (PID $($process.Id))"
if(-not $NoOpen){Start-Process 'http://127.0.0.1:4318/'}
