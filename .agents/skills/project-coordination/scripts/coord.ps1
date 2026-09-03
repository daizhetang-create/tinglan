[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('doctor', 'status', 'claim', 'renew', 'sync', 'checkpoint', 'publish', 'queue', 'integrate', 'release', 'break-lease', 'hook-pre-commit', 'hook-post-commit')]
  [string]$Command = 'status',

  [string]$TaskId,
  [string]$Scope,
  [string]$Owner,
  [string]$Summary,
  [string]$Checks,
  [string]$Reason,
  [int]$TtlMinutes = 0,
  [switch]$Json,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$script:ConfigPath = Join-Path $script:RepoRoot 'coordination.config.json'
if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
  throw "Missing coordination config: $script:ConfigPath"
}
$script:Config = Get-Content -LiteralPath $script:ConfigPath -Raw | ConvertFrom-Json

function Invoke-Git {
  param(
    [Parameter(Mandatory)] [string[]]$Arguments,
    [switch]$AllowFailure
  )
  $output = @(& git -C $script:RepoRoot @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "git $($Arguments -join ' ') failed ($exitCode):`n$($output -join "`n")"
  }
  [pscustomobject]@{
    ExitCode = $exitCode
    Output = $output
    Text = ($output -join "`n").Trim()
  }
}

function Get-GitCommonDirectory {
  $raw = (Invoke-Git -Arguments @('rev-parse', '--git-common-dir')).Text
  if ([System.IO.Path]::IsPathRooted($raw)) {
    return [System.IO.Path]::GetFullPath($raw)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $script:RepoRoot $raw))
}

$script:GitCommon = Get-GitCommonDirectory
$script:RuntimeRoot = Join-Path $script:GitCommon 'codex-coordination'
$script:LeaseDirectory = Join-Path $script:RuntimeRoot 'leases'
$script:EventDirectory = Join-Path $script:RuntimeRoot 'events'
$script:IntegrationLease = Join-Path $script:RuntimeRoot 'integration.json'
New-Item -ItemType Directory -Force -Path $script:LeaseDirectory, $script:EventDirectory | Out-Null

function Write-CoordEvent {
  param(
    [Parameter(Mandatory)] [string]$Type,
    [hashtable]$Data = @{}
  )
  $event = [ordered]@{
    schemaVersion = 1
    type = $Type
    at = (Get-Date).ToUniversalTime().ToString('o')
    branch = Get-CurrentBranch
    worktree = $script:RepoRoot
    data = $Data
  }
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffffffZ')
  $name = "$stamp-$([guid]::NewGuid().ToString('N')).json"
  $target = Join-Path $script:EventDirectory $name
  $temp = "$target.tmp"
  [System.IO.File]::WriteAllText($temp, ($event | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $target
}

function Get-CurrentBranch {
  $result = Invoke-Git -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD') -AllowFailure
  if ($result.ExitCode -eq 0 -and $result.Text) { return $result.Text }
  return 'DETACHED'
}

function Get-HeadSha {
  $result = Invoke-Git -Arguments @('rev-parse', 'HEAD') -AllowFailure
  if ($result.ExitCode -eq 0) { return $result.Text }
  return $null
}

function Get-MainSha {
  $result = Invoke-Git -Arguments @('rev-parse', "refs/heads/$($script:Config.defaultBranch)") -AllowFailure
  if ($result.ExitCode -eq 0) { return $result.Text }
  return $null
}

function Get-DirtyPaths {
  $paths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($args in @(
      @('diff', '--name-only'),
      @('diff', '--cached', '--name-only'),
      @('ls-files', '--others', '--exclude-standard')
    )) {
    $result = Invoke-Git -Arguments $args -AllowFailure
    if ($result.ExitCode -eq 0) {
      foreach ($line in $result.Output) {
        $path = ([string]$line).Trim().Replace('\', '/')
        if ($path) { [void]$paths.Add($path) }
      }
    }
  }
  return @($paths | Sort-Object)
}

function Assert-CleanWorktree {
  $dirty = @(Get-DirtyPaths)
  if ($dirty.Count -gt 0) {
    throw "Worktree is dirty. Commit or intentionally restore it before this operation:`n$($dirty -join "`n")"
  }
}

function Assert-TaskId {
  if (-not $TaskId -or $TaskId -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{1,63}$') {
    throw 'TaskId is required and may contain only letters, digits, and hyphens.'
  }
  $script:TaskKey = $TaskId.ToUpperInvariant()
}

function Get-TaskPath {
  param([Parameter(Mandatory)] [string]$Id)
  Join-Path $script:RepoRoot "docs\coordination\tasks\$($Id.ToUpperInvariant()).json"
}

function Get-Task {
  param([Parameter(Mandatory)] [string]$Id)
  $path = Get-TaskPath -Id $Id
  if (-not (Test-Path -LiteralPath $path)) { throw "Unknown task: $Id ($path)" }
  return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Save-Task {
  param(
    [Parameter(Mandatory)] [string]$Id,
    [Parameter(Mandatory)] $Value
  )
  $path = Get-TaskPath -Id $Id
  [System.IO.File]::WriteAllText($path, (($Value | ConvertTo-Json -Depth 20) + "`n"), [System.Text.UTF8Encoding]::new($false))
}

function Get-ScopePaths {
  param([Parameter(Mandatory)] [string]$ScopeName)
  $property = $script:Config.scopes.PSObject.Properties[$ScopeName]
  if (-not $property) { throw "Unknown scope '$ScopeName'." }
  return @($property.Value | ForEach-Object { ([string]$_).Replace('\', '/') })
}

function Get-PatternRoot {
  param([Parameter(Mandatory)] [string]$Pattern)
  $normalized = $Pattern.Replace('\', '/')
  $wildcard = $normalized.IndexOfAny([char[]]'*?[')
  if ($wildcard -ge 0) { $normalized = $normalized.Substring(0, $wildcard) }
  return $normalized.TrimEnd('/')
}

function Test-PatternsOverlap {
  param([string[]]$Left, [string[]]$Right)
  foreach ($a in $Left) {
    $rootA = Get-PatternRoot $a
    foreach ($b in $Right) {
      $rootB = Get-PatternRoot $b
      if (-not $rootA -or -not $rootB) { return $true }
      if ($rootA.Equals($rootB, [System.StringComparison]::OrdinalIgnoreCase) -or
          $rootA.StartsWith("$rootB/", [System.StringComparison]::OrdinalIgnoreCase) -or
          $rootB.StartsWith("$rootA/", [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
  }
  return $false
}

function Test-PathPattern {
  param(
    [Parameter(Mandatory)] [string]$Path,
    [Parameter(Mandatory)] [string]$Pattern
  )
  $normalizedPath = $Path.Replace('\', '/')
  $normalizedPattern = $Pattern.Replace('\', '/')
  $escaped = [regex]::Escape($normalizedPattern)
  $escaped = $escaped.Replace('\*\*', '.*').Replace('\*', '[^/]*').Replace('\?', '[^/]')
  return $normalizedPath -match "(?i)^$escaped$"
}

function Test-PathAllowed {
  param([string]$Path, [string[]]$Patterns)
  foreach ($pattern in $Patterns) {
    if (Test-PathPattern -Path $Path -Pattern $pattern) { return $true }
  }
  return $false
}

function Get-LeasePath {
  param([Parameter(Mandatory)] [string]$Id)
  Join-Path $script:LeaseDirectory "$($Id.ToUpperInvariant()).json"
}

function Get-Leases {
  $leases = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $script:LeaseDirectory -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
    try {
      $lease = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
      $lease | Add-Member -NotePropertyName _path -NotePropertyValue $file.FullName -Force
      $leases += $lease
    } catch {
      throw "Invalid lease file $($file.FullName): $($_.Exception.Message)"
    }
  }
  return $leases
}

function Test-LeaseExpired {
  param([Parameter(Mandatory)] $Lease)
  return [datetimeoffset]::Parse([string]$Lease.expiresAt) -le [datetimeoffset]::UtcNow
}

function Get-BranchLease {
  param([Parameter(Mandatory)] [string]$Branch)
  foreach ($lease in @(Get-Leases)) {
    if (-not (Test-LeaseExpired $lease) -and [string]$lease.branch -eq $Branch) { return $lease }
  }
  return $null
}

function Assert-TaskLease {
  param([Parameter(Mandatory)] [string]$Id)
  $path = Get-LeasePath -Id $Id
  if (-not (Test-Path -LiteralPath $path)) { throw "Task $Id is not claimed." }
  $lease = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if (Test-LeaseExpired $lease) { throw "Task $Id lease expired at $($lease.expiresAt). Renew it before continuing." }
  $branch = Get-CurrentBranch
  if ([string]$lease.branch -ne $branch) { throw "Task $Id belongs to branch $($lease.branch), not $branch." }
  return $lease
}

function Get-CoordMutex {
  $path = Join-Path $script:RuntimeRoot 'coordination.lock'
  try {
    return [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    throw 'Another coordination operation is running. Retry after it finishes.'
  }
}

function Write-AtomicJson {
  param(
    [Parameter(Mandatory)] [string]$Path,
    [Parameter(Mandatory)] $Value,
    [switch]$CreateNew
  )
  $content = $Value | ConvertTo-Json -Depth 20
  if ($CreateNew) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($content)
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    return
  }
  $temp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  [System.IO.File]::WriteAllText($temp, $content, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Get-PortPair {
  param([Parameter(Mandatory)] [string]$Id)
  $bytes = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($Id.ToUpperInvariant()))
  $slot = [System.BitConverter]::ToUInt16($bytes, 0) % [int]$script:Config.ports.worktreeSlots
  $dev = [int]$script:Config.ports.worktreeBase + ($slot * 2)
  [pscustomobject]@{ dev = $dev; preview = $dev + 1 }
}

function Assert-BranchMatchesTask {
  param([Parameter(Mandatory)] $Task)
  $branch = Get-CurrentBranch
  if ($branch -eq 'DETACHED') { throw "Create task branch '$($Task.recommendedBranch)' before claiming work." }
  if ($branch -eq [string]$script:Config.defaultBranch) { throw 'Task work cannot run directly on main.' }
  if ($branch -ne [string]$Task.recommendedBranch) {
    throw "Task $($Task.id) requires branch '$($Task.recommendedBranch)'; current branch is '$branch'."
  }
}

function Assert-PathsAllowed {
  param(
    [Parameter(Mandatory)] $Lease,
    [string[]]$Paths
  )
  $allowed = @($Lease.paths)
  $integrationOnly = @($script:Config.integrationOnly)
  $taskRecord = "docs/coordination/tasks/$([string]$Lease.taskId).json"
  foreach ($path in @($Paths)) {
    $normalized = $path.Replace('\', '/')
    if ($normalized.Equals($taskRecord, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if (Test-PathAllowed -Path $normalized -Patterns $integrationOnly) {
      throw "Path '$normalized' is integration-only. Publish a contract request instead of editing it from $($Lease.scope)."
    }
    if (-not (Test-PathAllowed -Path $normalized -Patterns $allowed)) {
      throw "Path '$normalized' is outside task $($Lease.taskId) scope '$($Lease.scope)'."
    }
  }
}

function Invoke-ConfiguredChecks {
  $results = @()
  Push-Location $script:RepoRoot
  try {
    foreach ($check in @($script:Config.checks)) {
      $commandText = [string]$check
      if ($commandText -notmatch '^npm run ([A-Za-z0-9:_-]+)$') {
        throw "Unsupported coordination check '$commandText'. Only 'npm run <script>' is allowed."
      }
      $scriptName = $Matches[1]
      Write-Host "[check] npm run $scriptName" -ForegroundColor Cyan
      & npm run $scriptName
      if ($LASTEXITCODE -ne 0) { throw "Check failed: npm run $scriptName" }
      $results += "npm run ${scriptName}: pass"
    }
  } finally {
    Pop-Location
  }
  return $results
}

function Update-TaskStatus {
  param(
    [Parameter(Mandatory)] $Task,
    [Parameter(Mandatory)] [string]$Status,
    [string]$ResultSummary,
    [string[]]$Evidence
  )
  $Task.status = $Status
  $Task.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  if ($ResultSummary) {
    if ($Task.PSObject.Properties['resultSummary']) { $Task.resultSummary = $ResultSummary }
    else { $Task | Add-Member -NotePropertyName resultSummary -NotePropertyValue $ResultSummary }
  }
  if ($Evidence) {
    $existing = @($Task.evidence)
    $Task.evidence = @($existing + $Evidence)
  }
}

function Invoke-Doctor {
  $problems = [System.Collections.Generic.List[string]]::new()
  $top = (Invoke-Git -Arguments @('rev-parse', '--show-toplevel')).Text
  if ([System.IO.Path]::GetFullPath($top) -ne $script:RepoRoot) { $problems.Add("Git root is $top, expected $script:RepoRoot") }
  if (-not (Get-HeadSha)) { $problems.Add('Repository has no baseline commit.') }
  foreach ($path in @('AGENTS.md', 'coordination.config.json', '.agents/skills/project-coordination/SKILL.md', 'docs/coordination/PROJECT_STATUS.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot $path))) { $problems.Add("Missing $path") }
  }
  foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $script:RepoRoot 'docs\coordination\tasks') -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
    try { $null = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json } catch { $problems.Add("Invalid task JSON: $($file.Name)") }
  }
  $hookPath = (Invoke-Git -Arguments @('config', '--get', 'core.hooksPath') -AllowFailure).Text
  if ($hookPath -ne '.githooks') { $problems.Add("core.hooksPath is '$hookPath', expected '.githooks'.") }
  Write-Host "Repository : $script:RepoRoot"
  Write-Host "Branch     : $(Get-CurrentBranch)"
  Write-Host "HEAD       : $(Get-HeadSha)"
  Write-Host "Git common : $script:GitCommon"
  Write-Host "Node       : $(& node --version 2>$null)"
  Write-Host "npm        : $(& npm --version 2>$null)"
  Write-Host "Codex      : $(& codex --version 2>$null)"
  if ($problems.Count -gt 0) {
    throw "Coordination doctor found $($problems.Count) problem(s):`n- $($problems -join "`n- ")"
  }
  Write-Host 'Coordination doctor: healthy' -ForegroundColor Green
}

function Get-ReadyItems {
  $result = Invoke-Git -Arguments @('for-each-ref', '--format=%(refname:short)|%(objectname)', 'refs/codex/ready') -AllowFailure
  $items = @()
  foreach ($line in $result.Output) {
    $parts = ([string]$line).Split('|', 2)
    if ($parts.Count -eq 2 -and $parts[0]) {
      $items += [pscustomobject]@{ ref = $parts[0]; sha = $parts[1] }
    }
  }
  return $items
}

function Invoke-Status {
  $branch = Get-CurrentBranch
  $mainSha = Get-MainSha
  $headSha = Get-HeadSha
  $dirty = @(Get-DirtyPaths)
  $leases = @(Get-Leases | ForEach-Object {
      [pscustomobject]@{
        taskId = $_.taskId
        scope = $_.scope
        owner = $_.owner
        branch = $_.branch
        expiresAt = $_.expiresAt
        expired = Test-LeaseExpired $_
        devPort = $_.ports.dev
      }
    })
  $ready = @(Get-ReadyItems)
  $tasks = @()
  foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $script:RepoRoot 'docs\coordination\tasks') -Filter '*.json' -File)) {
    $task = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    $tasks += [pscustomobject]@{ id = $task.id; status = $task.status; priority = $task.priority; scope = $task.scope; branch = $task.recommendedBranch }
  }
  $status = [ordered]@{
    project = $script:Config.project
    mission = $script:Config.mission
    branch = $branch
    head = $headSha
    main = $mainSha
    dirty = $dirty
    leases = $leases
    ready = $ready
    tasks = $tasks
  }
  if ($Json) {
    $status | ConvertTo-Json -Depth 12
    return
  }
  Write-Host "$($script:Config.project): $($script:Config.mission)"
  Write-Host "Branch: $branch  HEAD: $headSha"
  Write-Host "Main:   $mainSha"
  Write-Host "Dirty paths: $($dirty.Count)  Active/expired leases: $($leases.Count)  Ready: $($ready.Count)"
  if ($dirty.Count) { $dirty | ForEach-Object { Write-Host "  dirty $_" -ForegroundColor Yellow } }
  foreach ($lease in $leases) {
    $state = if ($lease.expired) { 'expired' } else { 'active' }
    Write-Host "  lease $($lease.taskId) [$($lease.scope)] $state $($lease.branch) port=$($lease.devPort)"
  }
  foreach ($item in $ready) { Write-Host "  ready $($item.ref) $($item.sha)" -ForegroundColor Cyan }
  Write-Host 'Tasks:'
  foreach ($task in $tasks | Sort-Object priority, id) { Write-Host "  $($task.id) $($task.priority) $($task.status) [$($task.scope)] -> $($task.branch)" }
}

function Invoke-Claim {
  Assert-TaskId
  $task = Get-Task -Id $script:TaskKey
  Assert-BranchMatchesTask -Task $task
  if (-not $Scope) { $script:Scope = [string]$task.scope } else { $script:Scope = $Scope }
  if ($script:Scope -ne [string]$task.scope) { throw "Task $($task.id) declares scope '$($task.scope)', not '$script:Scope'." }
  $paths = @(Get-ScopePaths -ScopeName $script:Scope)
  $ttl = if ($TtlMinutes -gt 0) { $TtlMinutes } else { [int]$script:Config.leaseMinutes }
  if ($ttl -lt 15 -or $ttl -gt 1440) { throw 'TtlMinutes must be between 15 and 1440.' }
  if (-not $Owner) { $Owner = if ($env:USERNAME) { $env:USERNAME } else { 'codex-chat' } }
  $mutex = Get-CoordMutex
  try {
    $leasePath = Get-LeasePath -Id $script:TaskKey
    if (Test-Path -LiteralPath $leasePath) { throw "Task $script:TaskKey already has a lease. Use status or break-lease after expiry." }
    foreach ($existing in @(Get-Leases)) {
      if (Test-LeaseExpired $existing) { continue }
      if ([string]$existing.scope -eq 'integration' -or $script:Scope -eq 'integration') {
        throw "Integration work is exclusive; active lease $($existing.taskId) must finish first."
      }
      if ([string]$existing.scope -eq $script:Scope -or (Test-PatternsOverlap -Left $paths -Right @($existing.paths))) {
        throw "Scope/path conflict with active task $($existing.taskId) owned by $($existing.owner)."
      }
    }
    $ports = Get-PortPair -Id $script:TaskKey
    $lease = [ordered]@{
      schemaVersion = 1
      taskId = $script:TaskKey
      owner = $Owner
      scope = $script:Scope
      branch = Get-CurrentBranch
      worktree = $script:RepoRoot
      baseSha = Get-MainSha
      paths = $paths
      ports = $ports
      acquiredAt = [datetimeoffset]::UtcNow.ToString('o')
      expiresAt = [datetimeoffset]::UtcNow.AddMinutes($ttl).ToString('o')
    }
    Write-AtomicJson -Path $leasePath -Value $lease -CreateNew
    Update-TaskStatus -Task $task -Status 'active'
    Save-Task -Id $script:TaskKey -Value $task
    Write-CoordEvent -Type 'task.claimed' -Data @{ taskId = $script:TaskKey; scope = $script:Scope; owner = $Owner; devPort = $ports.dev }
    Write-Host "Claimed $script:TaskKey [$script:Scope] on $($lease.branch)" -ForegroundColor Green
    Write-Host "Dev command: npm run dev -- --port $($ports.dev)"
    Write-Host "Lease expires: $($lease.expiresAt)"
    Write-Host "Task record changed; include docs/coordination/tasks/$script:TaskKey.json in the first task commit."
  } finally {
    $mutex.Dispose()
  }
}

function Invoke-Renew {
  Assert-TaskId
  $lease = Assert-TaskLease -Id $script:TaskKey
  $ttl = if ($TtlMinutes -gt 0) { $TtlMinutes } else { [int]$script:Config.leaseMinutes }
  $lease.expiresAt = [datetimeoffset]::UtcNow.AddMinutes($ttl).ToString('o')
  Write-AtomicJson -Path (Get-LeasePath -Id $script:TaskKey) -Value $lease
  Write-CoordEvent -Type 'task.renewed' -Data @{ taskId = $script:TaskKey; expiresAt = $lease.expiresAt }
  Write-Host "Renewed $script:TaskKey until $($lease.expiresAt)" -ForegroundColor Green
}

function Invoke-Sync {
  Assert-TaskId
  $task = Get-Task -Id $script:TaskKey
  Assert-BranchMatchesTask -Task $task
  $null = Assert-TaskLease -Id $script:TaskKey
  Assert-CleanWorktree
  $mainSha = Get-MainSha
  if (-not $mainSha) { throw 'main has no baseline commit.' }
  $isAncestor = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $mainSha, 'HEAD') -AllowFailure
  if ($isAncestor.ExitCode -eq 0) {
    Write-Host "Task already contains main $mainSha" -ForegroundColor Green
    return
  }
  if (-not $Apply) {
    throw 'Task is behind/diverged from main. Re-run sync with -Apply at this clean boundary.'
  }
  $before = Get-HeadSha
  $merge = Invoke-Git -Arguments @('merge', '--no-edit', [string]$script:Config.defaultBranch) -AllowFailure
  if ($merge.ExitCode -ne 0) {
    $mergeHead = Join-Path $script:GitCommon 'MERGE_HEAD'
    if (Test-Path -LiteralPath $mergeHead) { $null = Invoke-Git -Arguments @('merge', '--abort') -AllowFailure }
    throw "Sync conflict; merge was aborted and HEAD remains $before.`n$($merge.Text)"
  }
  Write-CoordEvent -Type 'task.synced' -Data @{ taskId = $script:TaskKey; before = $before; after = Get-HeadSha; main = $mainSha }
  Write-Host "Synchronized $script:TaskKey with main." -ForegroundColor Green
}

function Invoke-Checkpoint {
  Assert-TaskId
  $lease = Assert-TaskLease -Id $script:TaskKey
  $dirty = @(Get-DirtyPaths)
  Assert-PathsAllowed -Lease $lease -Paths $dirty
  $results = @(Invoke-ConfiguredChecks)
  Write-CoordEvent -Type 'task.checkpointed' -Data @{ taskId = $script:TaskKey; checks = $results; dirtyPaths = $dirty }
  Write-Host "Checkpoint passed for $script:TaskKey" -ForegroundColor Green
  $results | ForEach-Object { Write-Host "  $_" }
}

function Invoke-Publish {
  Assert-TaskId
  if (-not $Summary) { throw 'Publish requires -Summary.' }
  $task = Get-Task -Id $script:TaskKey
  Assert-BranchMatchesTask -Task $task
  $null = Assert-TaskLease -Id $script:TaskKey
  Assert-CleanWorktree
  $mainSha = Get-MainSha
  $containsMain = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $mainSha, 'HEAD') -AllowFailure
  if ($containsMain.ExitCode -ne 0) { throw 'Task does not contain current main. Run sync -Apply first.' }
  $results = @(Invoke-ConfiguredChecks)
  if ($Checks) { $results += $Checks }
  Update-TaskStatus -Task $task -Status 'ready' -ResultSummary $Summary -Evidence $results
  Save-Task -Id $script:TaskKey -Value $task
  $taskRelative = "docs/coordination/tasks/$script:TaskKey.json"
  $null = Invoke-Git -Arguments @('add', '--', $taskRelative)
  $null = Invoke-Git -Arguments @('commit', '-m', "chore(coord): publish $script:TaskKey")
  $readySha = Get-HeadSha
  $refName = "refs/codex/ready/$script:TaskKey"
  $null = Invoke-Git -Arguments @('update-ref', $refName, $readySha)
  Write-CoordEvent -Type 'task.published' -Data @{ taskId = $script:TaskKey; sha = $readySha; summary = $Summary; checks = $results }
  Write-Host "Published $script:TaskKey -> $readySha" -ForegroundColor Green
  Write-Host "Ready ref: $refName"
}

function Invoke-Queue {
  $items = @(Get-ReadyItems)
  if (-not $items.Count) { Write-Host 'Ready queue is empty.'; return }
  foreach ($item in $items) { Write-Host "$($item.ref) $($item.sha)" }
}

function Invoke-Integrate {
  Assert-TaskId
  if ((Get-CurrentBranch) -ne [string]$script:Config.defaultBranch) { throw 'Integration must run from main.' }
  Assert-CleanWorktree
  $refName = "refs/codex/ready/$script:TaskKey"
  $ready = Invoke-Git -Arguments @('rev-parse', $refName) -AllowFailure
  if ($ready.ExitCode -ne 0) { throw "No ready ref for $script:TaskKey." }
  $integration = [ordered]@{
    taskId = $script:TaskKey
    owner = if ($Owner) { $Owner } else { 'integration-chat' }
    branch = Get-CurrentBranch
    worktree = $script:RepoRoot
    startedAt = [datetimeoffset]::UtcNow.ToString('o')
  }
  try {
    Write-AtomicJson -Path $script:IntegrationLease -Value $integration -CreateNew
  } catch {
    throw 'Another integration is active.'
  }
  $before = Get-HeadSha
  try {
    $merge = Invoke-Git -Arguments @('merge', '--no-ff', '--no-commit', $ready.Text) -AllowFailure
    if ($merge.ExitCode -ne 0) {
      $null = Invoke-Git -Arguments @('merge', '--abort') -AllowFailure
      throw "Integration conflict; merge was aborted.`n$($merge.Text)"
    }
    $results = @(Invoke-ConfiguredChecks)
    $task = Get-Task -Id $script:TaskKey
    Update-TaskStatus -Task $task -Status 'integrated' -Evidence @("integrated ready SHA $($ready.Text)")
    Save-Task -Id $script:TaskKey -Value $task
    $changelog = Join-Path $script:RepoRoot 'docs\coordination\CHANGELOG.md'
    $line = "`n- $((Get-Date).ToString('yyyy-MM-dd HH:mm')) integrated $script:TaskKey from $($ready.Text): $($task.resultSummary)"
    Add-Content -LiteralPath $changelog -Value $line -Encoding utf8NoBOM
    $null = Invoke-Git -Arguments @('add', '--', "docs/coordination/tasks/$script:TaskKey.json", 'docs/coordination/CHANGELOG.md')
    $null = Invoke-Git -Arguments @('commit', '-m', "merge: integrate $script:TaskKey")
    $integratedSha = Get-HeadSha
    $null = Invoke-Git -Arguments @('update-ref', '-d', $refName)
    $leasePath = Get-LeasePath -Id $script:TaskKey
    if (Test-Path -LiteralPath $leasePath) { Remove-Item -LiteralPath $leasePath }
    Write-CoordEvent -Type 'task.integrated' -Data @{ taskId = $script:TaskKey; readySha = $ready.Text; mainBefore = $before; mainAfter = $integratedSha; checks = $results }
    Write-Host "Integrated $script:TaskKey into main at $integratedSha" -ForegroundColor Green
  } catch {
    $mergeHead = Join-Path $script:GitCommon 'MERGE_HEAD'
    if (Test-Path -LiteralPath $mergeHead) { $null = Invoke-Git -Arguments @('merge', '--abort') -AllowFailure }
    throw
  } finally {
    if (Test-Path -LiteralPath $script:IntegrationLease) { Remove-Item -LiteralPath $script:IntegrationLease }
  }
}

function Invoke-Release {
  Assert-TaskId
  $lease = Assert-TaskLease -Id $script:TaskKey
  Remove-Item -LiteralPath (Get-LeasePath -Id $script:TaskKey)
  Write-CoordEvent -Type 'task.released' -Data @{ taskId = $script:TaskKey; owner = $lease.owner }
  Write-Host "Released $script:TaskKey" -ForegroundColor Green
}

function Invoke-BreakLease {
  Assert-TaskId
  if (-not $Reason) { throw 'break-lease requires -Reason.' }
  $path = Get-LeasePath -Id $script:TaskKey
  if (-not (Test-Path -LiteralPath $path)) { throw "No lease exists for $script:TaskKey." }
  $lease = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if (-not (Test-LeaseExpired $lease)) { throw "Lease is active until $($lease.expiresAt); it cannot be broken." }
  if (Test-Path -LiteralPath ([string]$lease.worktree)) {
    $output = @(& git -C ([string]$lease.worktree) status --porcelain 2>&1)
    if ($LASTEXITCODE -eq 0 -and $output.Count -gt 0) { throw 'Recorded worktree is dirty. Recover its work before breaking the lease.' }
  }
  Remove-Item -LiteralPath $path
  Write-CoordEvent -Type 'task.lease-broken' -Data @{ taskId = $script:TaskKey; reason = $Reason; previousOwner = $lease.owner }
  Write-Host "Broke expired lease $script:TaskKey" -ForegroundColor Yellow
}

function Invoke-HookPreCommit {
  $head = Get-HeadSha
  if (-not $head) { return }
  $branch = Get-CurrentBranch
  if ($branch -eq [string]$script:Config.defaultBranch) {
    if (-not (Test-Path -LiteralPath $script:IntegrationLease)) {
      throw 'Direct commits to main are blocked. Use a task branch and the integration workflow.'
    }
    return
  }
  $lease = Get-BranchLease -Branch $branch
  if (-not $lease) { throw "No active lease matches branch '$branch'. Run coord claim first." }
  $staged = (Invoke-Git -Arguments @('diff', '--cached', '--name-only', '--diff-filter=ACMR')).Output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ }
  Assert-PathsAllowed -Lease $lease -Paths @($staged)
}

function Invoke-HookPostCommit {
  Write-CoordEvent -Type 'git.committed' -Data @{ sha = Get-HeadSha; subject = (Invoke-Git -Arguments @('log', '-1', '--pretty=%s')).Text }
}

switch ($Command) {
  'doctor' { Invoke-Doctor }
  'status' { Invoke-Status }
  'claim' { Invoke-Claim }
  'renew' { Invoke-Renew }
  'sync' { Invoke-Sync }
  'checkpoint' { Invoke-Checkpoint }
  'publish' { Invoke-Publish }
  'queue' { Invoke-Queue }
  'integrate' { Invoke-Integrate }
  'release' { Invoke-Release }
  'break-lease' { Invoke-BreakLease }
  'hook-pre-commit' { Invoke-HookPreCommit }
  'hook-post-commit' { Invoke-HookPostCommit }
}
