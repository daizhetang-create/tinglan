param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Destination) { throw 'Archive already exists; refusing overwrite.' }
Compress-Archive -LiteralPath $Source -DestinationPath $Destination -CompressionLevel Optimal
