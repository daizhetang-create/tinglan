[CmdletBinding()]
param(
  [switch]$KeepTemp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$sourceRepo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$container = Join-Path $tempRoot "tinglan-coord-forward-test-$([guid]::NewGuid().ToString('N'))"
$mainWorktree = Join-Path $container 'main'
$coreWorktree = Join-Path $container 'core'
$uiWorktree = Join-Path $container 'ui'
$qaWorktree = Join-Path $container 'qa'

function Invoke-Native {
  param(
    [Parameter(Mandatory)] [string]$Command,
    [Parameter(Mandatory)] [string[]]$Arguments,
    [Parameter(Mandatory)] [string]$WorkingDirectory,
    [switch]$Quiet
  )
  Push-Location $WorkingDirectory
  try {
    $output = @(& $Command @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "$Command $($Arguments -join ' ') failed ($exitCode):`n$($output -join "`n")"
  }
  if (-not $Quiet -and $output.Count) { $output | ForEach-Object { Write-Host $_ } }
  return @($output)
}

function Invoke-Coord {
  param(
    [Parameter(Mandatory)] [string]$WorkingDirectory,
    [Parameter(Mandatory)] [string[]]$Arguments,
    [switch]$Quiet
  )
  $scriptPath = Join-Path $WorkingDirectory '.agents\skills\project-coordination\scripts\coord.ps1'
  return @(Invoke-Native -Command 'pwsh' -Arguments (@('-NoProfile', '-File', $scriptPath) + $Arguments) -WorkingDirectory $WorkingDirectory -Quiet:$Quiet)
}

function Assert-ExpectedFailure {
  param(
    [Parameter(Mandatory)] [scriptblock]$Action,
    [Parameter(Mandatory)] [string]$Label
  )
  try {
    & $Action
  } catch {
    Write-Host "PASS expected failure: $Label" -ForegroundColor DarkGreen
    return
  }
  throw "Expected failure did not occur: $Label"
}

function Remove-TestContainer {
  $resolvedContainer = [System.IO.Path]::GetFullPath($container).TrimEnd('\', '/')
  $resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $resolvedContainer)).TrimEnd('\', '/')
  $leaf = Split-Path -Leaf $resolvedContainer
  if ($resolvedParent -ne $tempRoot -or -not $leaf.StartsWith('tinglan-coord-forward-test-', [System.StringComparison]::Ordinal)) {
    throw "Refusing to remove unverified test path: $resolvedContainer"
  }
  if (Test-Path -LiteralPath $resolvedContainer) {
    Remove-Item -LiteralPath $resolvedContainer -Recurse -Force
  }
}

$sourceStatus = @(& git -C $sourceRepo status --porcelain 2>&1)
if ($LASTEXITCODE -ne 0) { throw "Cannot read source repository status: $($sourceStatus -join "`n")" }
if ($sourceStatus.Count -gt 0) { throw 'Source repository must be clean before forward testing.' }

try {
  New-Item -ItemType Directory -Path $container | Out-Null
  $null = Invoke-Native -Command 'git' -Arguments @('clone', '--no-hardlinks', $sourceRepo, $mainWorktree) -WorkingDirectory $container -Quiet
  # Test the current source HEAD, even when the test is launched from an integration worktree.
  $testBranch = (Invoke-Native -Command 'git' -Arguments @('branch', '--show-current') -WorkingDirectory $mainWorktree -Quiet) -join ''
  if ($testBranch.Trim() -ne 'main') {
    $null = Invoke-Native -Command 'git' -Arguments @('checkout', '-b', 'main', 'HEAD') -WorkingDirectory $mainWorktree -Quiet
  }
  $null = Invoke-Native -Command 'git' -Arguments @('config', 'user.name', 'Tinglan Coordination Test') -WorkingDirectory $mainWorktree -Quiet
  $null = Invoke-Native -Command 'git' -Arguments @('config', 'user.email', 'coord-test@localhost') -WorkingDirectory $mainWorktree -Quiet
  $null = Invoke-Native -Command 'git' -Arguments @('config', 'core.hooksPath', '.githooks') -WorkingDirectory $mainWorktree -Quiet
  $null = Invoke-Native -Command 'npm' -Arguments @('ci', '--ignore-scripts', '--silent') -WorkingDirectory $mainWorktree -Quiet

  $null = Invoke-Native -Command 'git' -Arguments @('worktree', 'add', '-b', 'codex/core-001', $coreWorktree, 'main') -WorkingDirectory $mainWorktree -Quiet
  $null = Invoke-Native -Command 'git' -Arguments @('worktree', 'add', '-b', 'codex/ui-001', $uiWorktree, 'main') -WorkingDirectory $mainWorktree -Quiet
  $null = Invoke-Native -Command 'git' -Arguments @('worktree', 'add', '-b', 'codex/qa-001', $qaWorktree, 'main') -WorkingDirectory $mainWorktree -Quiet
  $null = Invoke-Native -Command 'npm' -Arguments @('ci', '--ignore-scripts', '--silent') -WorkingDirectory $coreWorktree -Quiet

  $null = Invoke-Coord -WorkingDirectory $coreWorktree -Arguments @('doctor')
  $null = Invoke-Coord -WorkingDirectory $coreWorktree -Arguments @('claim', '-TaskId', 'CORE-001', '-Owner', 'forward-core')
  $null = Invoke-Native -Command 'git' -Arguments @('add', '--', 'docs/coordination/tasks/CORE-001.json') -WorkingDirectory $coreWorktree -Quiet
  $null = Invoke-Native -Command 'git' -Arguments @('commit', '-m', 'test: claim CORE-001') -WorkingDirectory $coreWorktree -Quiet
  Assert-ExpectedFailure -Label 'renew rejects invalid TTL' -Action {
    $null = Invoke-Coord -WorkingDirectory $coreWorktree -Arguments @('renew', '-TaskId', 'CORE-001', '-TtlMinutes', '1') -Quiet
  }
  $testLeasePath = Join-Path $mainWorktree '.git/codex-coordination/leases/CORE-001.json'
  $testLease = Get-Content -LiteralPath $testLeasePath -Raw | ConvertFrom-Json
  $testLease.expiresAt = [datetimeoffset]::UtcNow.AddMinutes(-1).ToString('o')
  [IO.File]::WriteAllText($testLeasePath,($testLease | ConvertTo-Json -Depth 12))
  Assert-ExpectedFailure -Label 'expired renew rejects other owner' -Action {
    $null = Invoke-Coord -WorkingDirectory $coreWorktree -Arguments @('renew', '-TaskId', 'CORE-001', '-Owner', 'someone-else', '-Reason', 'test') -Quiet
  }
  $null = Invoke-Coord -WorkingDirectory $qaWorktree -Arguments @('claim', '-TaskId', 'QA-001', '-Owner', 'test-conflicting-owner') -Quiet
  Assert-ExpectedFailure -Label 'expired renew cannot resurrect overlapping active scope' -Action {
    $null = Invoke-Coord -WorkingDirectory $coreWorktree -Arguments @('renew', '-TaskId', 'CORE-001', '-Owner', 'forward-core', '-Reason', 'test recovery') -Quiet
  }
  $null = Invoke-Coord -WorkingDirectory $qaWorktree -Arguments @('release', '-TaskId', 'QA-001') -Quiet
  $null = Invoke-Coord -WorkingDirectory $coreWorktree -Arguments @('renew', '-TaskId', 'CORE-001', '-Owner', 'forward-core', '-Reason', 'test recovery')
  $null = Invoke-Coord -WorkingDirectory $coreWorktree -Arguments @('checkpoint', '-TaskId', 'CORE-001')
  $null = Invoke-Coord -WorkingDirectory $coreWorktree -Arguments @('publish', '-TaskId', 'CORE-001', '-Summary', 'Forward-test artifact; no product changes.')

  $null = Invoke-Coord -WorkingDirectory $uiWorktree -Arguments @('claim', '-TaskId', 'UI-001', '-Owner', 'forward-ui')
  Assert-ExpectedFailure -Label 'dirty task worktree cannot synchronize' -Action {
    $null = Invoke-Coord -WorkingDirectory $uiWorktree -Arguments @('sync', '-TaskId', 'UI-001', '-Apply') -Quiet
  }
  Assert-ExpectedFailure -Label 'overlapping QA scope cannot be claimed beside runtime/UI work' -Action {
    $null = Invoke-Coord -WorkingDirectory $qaWorktree -Arguments @('claim', '-TaskId', 'QA-001', '-Owner', 'forward-qa') -Quiet
  }
  Assert-ExpectedFailure -Label 'direct main commits are blocked without integration lease' -Action {
    $null = Invoke-Coord -WorkingDirectory $mainWorktree -Arguments @('hook-pre-commit') -Quiet
  }

  $queue = Invoke-Coord -WorkingDirectory $mainWorktree -Arguments @('queue') -Quiet
  if (($queue -join "`n") -notmatch 'codex/ready/CORE-001') { throw 'CORE-001 was not published to the ready queue.' }
  $null = Invoke-Coord -WorkingDirectory $mainWorktree -Arguments @('integrate', '-TaskId', 'CORE-001', '-Owner', 'forward-integrator')
  $null = Invoke-Coord -WorkingDirectory $uiWorktree -Arguments @('release', '-TaskId', 'UI-001')

  $statusJson = (Invoke-Coord -WorkingDirectory $mainWorktree -Arguments @('status', '-Json') -Quiet) -join "`n"
  $status = $statusJson | ConvertFrom-Json
  if (@($status.ready).Count -ne 0) { throw 'Ready queue should be empty after integration.' }
  if (@($status.leases).Count -ne 0) { throw 'All forward-test leases should be released.' }
  $coreTask = @($status.tasks | Where-Object id -eq 'CORE-001')
  if ($coreTask.Count -ne 1 -or $coreTask[0].status -ne 'integrated') { throw 'CORE-001 did not reach integrated status.' }

  Write-Host 'FORWARD_TEST_PASS: claim, isolation, publish, queue, integration, and lease cleanup all passed.' -ForegroundColor Green
} finally {
  Set-Location $sourceRepo
  if ($KeepTemp) {
    Write-Host "Forward-test files kept at $container" -ForegroundColor Yellow
  } else {
    Remove-TestContainer
  }
}
