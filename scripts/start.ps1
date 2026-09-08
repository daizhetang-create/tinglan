[CmdletBinding()]
param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$tinglanLauncher = Join-Path $PSScriptRoot 'start.mjs'
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$tinglanArguments = @($tinglanLauncher)
if ($NoOpen) { $tinglanArguments += '--no-open' }
& $nodeExecutable @tinglanArguments
exit $LASTEXITCODE
