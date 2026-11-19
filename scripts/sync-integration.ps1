# sync-integration.ps1: inspect or rebuild the local OpenCodex integration branch atop upstream/dev.
# Modes:
#   -Check (default, read-only): compare current integration HEAD with upstream/dev, inspect PR statuses via gh,
#     and warn if tracked local hotfix branches have unmerged commits.
#   -Rebuild: create a fresh worktree from upstream/dev and replay all still-open PR branches + local patches
#     listed in scripts/integration-stack.json (stopping on any conflict so an operator or AI can resolve cleanly).
#     Pass -Deploy to run GUI build + scripts/deploy-local.ps1 after a conflict-free rebuild.
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
    [Parameter(ParameterSetName = 'Check')]
    [switch]$Check,

    [Parameter(ParameterSetName = 'Check')]
    [switch]$Json,

    [Parameter(ParameterSetName = 'Rebuild', Mandatory = $true)]
    [switch]$Rebuild,

    [Parameter(ParameterSetName = 'Rebuild')]
    [string]$BranchName = ('local/integration-' + (Get-Date -Format 'yyyyMMdd')),

    [Parameter(ParameterSetName = 'Rebuild')]
    [switch]$Deploy,

    [switch]$NoFetch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot     = Split-Path -Parent $PSScriptRoot
$CommonGitDir = (& git -C $RepoRoot rev-parse --git-common-dir 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $CommonGitDir) { throw "Cannot locate git common dir from $RepoRoot" }
$MainRepoRoot = Split-Path -Parent ([System.IO.Path]::GetFullPath((Join-Path $RepoRoot $CommonGitDir)))
if (-not (Test-Path -LiteralPath (Join-Path $MainRepoRoot '.git'))) {
    # Fallback when git-common-dir is already absolute
    $MainRepoRoot = Split-Path -Parent ([System.IO.Path]::GetFullPath($CommonGitDir))
}

$ManifestPath = Join-Path $PSScriptRoot 'integration-stack.json'
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Manifest not found: $ManifestPath"
}
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json

function Invoke-GitChecked {
    param([string]$Dir, [string[]]$Args)
    $out = & git -C $Dir @Args 2>&1
    if ($LASTEXITCODE -ne 0) {
        $text = ($out | Out-String).Trim()
        throw "git $($Args -join ' ') failed (exit $LASTEXITCODE): $text"
    }
    return $out
}

function Get-PrStatus {
    param([int]$Number, [string]$Repo)
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ number = $Number; state = 'UNKNOWN'; mergedAt = $null; mergeable = 'UNKNOWN'; headRefOid = $null; canRetire = $false; error = 'gh CLI missing' }
    }
    $raw = & gh pr view $Number -R $Repo --json number,state,mergedAt,mergeable,isDraft,headRefOid,headRefName 2>&1
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ number = $Number; state = 'ERROR'; mergedAt = $null; mergeable = 'UNKNOWN'; headRefOid = $null; canRetire = $false; error = ($raw | Out-String).Trim() }
    }
    $obj = $raw | ConvertFrom-Json
    $canRetire = ($obj.state -in @('MERGED', 'CLOSED'))
    return [pscustomobject]@{
        number     = $Number
        state      = $obj.state
        isDraft    = [bool]$obj.isDraft
        mergedAt   = $obj.mergedAt
        mergeable  = $obj.mergeable
        headRefOid = $obj.headRefOid
        canRetire  = $canRetire
        error      = $null
    }
}

if (-not $NoFetch) {
    Write-Host "[sync] Fetching upstream and origin..." -ForegroundColor Cyan
    Invoke-GitChecked -Dir $RepoRoot -Args @('fetch', 'upstream') | Out-Null
    Invoke-GitChecked -Dir $RepoRoot -Args @('fetch', 'origin') | Out-Null
}

$upstreamRef = [string]$Manifest.upstreamBase
$upstreamSha = (& git -C $RepoRoot rev-parse $upstreamRef).Trim()
$headBranch  = (& git -C $RepoRoot rev-parse --abbrev-ref HEAD).Trim()
$headSha     = (& git -C $RepoRoot rev-parse HEAD).Trim()
$behindCount = [int](& git -C $RepoRoot rev-list --count "HEAD..$upstreamRef")
$aheadCount  = [int](& git -C $RepoRoot rev-list --count "$upstreamRef..HEAD")

$prResults = @()
foreach ($pr in $Manifest.upstreamPrs) {
    $st = Get-PrStatus -Number ([int]$pr.number) -Repo ([string]$Manifest.upstreamRepo)
    $localMatchesRemote = $false
    if ($st.headRefOid) {
        & git -C $RepoRoot merge-base --is-ancestor $st.headRefOid HEAD 2>$null
        $localMatchesRemote = ($LASTEXITCODE -eq 0)
    }
    $prResults += [pscustomobject]@{
        number            = [int]$pr.number
        branch            = [string]$pr.branch
        manifestStatus    = [string]$pr.status
        upstreamState     = $st.state
        isDraft           = $st.isDraft
        mergeable         = $st.mergeable
        upstreamHead      = if ($st.headRefOid) { $st.headRefOid.Substring(0, 9) } else { $null }
        includedInHead    = $localMatchesRemote
        readyToRetire     = $st.canRetire
        error             = $st.error
    }
}

$branchLatestTip = @{}
foreach ($patch in $Manifest.localPatches) {
    $br = [string]$patch.sourceBranch
    if ($br -eq 'local/integration-20261113') { continue }
    if ($patch.PSObject.Properties['sourceTipSha'] -and $patch.sourceTipSha) {
        $branchLatestTip[$br] = @{ patchId = [string]$patch.id; tip = [string]$patch.sourceTipSha }
    }
}

$branchWarnings = @()
foreach ($br in $branchLatestTip.Keys) {
    $info = $branchLatestTip[$br]
    $liveTip = (& git -C $RepoRoot rev-parse --verify $br 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $liveTip) { continue }
    $liveTip = $liveTip.Trim()
    $recorded = $info.tip
    if (-not $liveTip.StartsWith($recorded)) {
        $newCommits = @(& git -C $RepoRoot log --oneline --no-merges "$recorded..$liveTip" 2>$null | Where-Object { $_ })
        if ($newCommits.Count -gt 0) {
            $branchWarnings += [pscustomobject]@{
                branch  = $br
                patchId = $info.patchId
                missing = $newCommits
            }
        }
    }
}

if (-not $Rebuild) {
    $report = [pscustomobject]@{
        checkedAt          = (Get-Date).ToString('o')
        currentBranch      = $headBranch
        headSha            = $headSha.Substring(0, 9)
        upstreamRef        = $upstreamRef
        upstreamSha        = $upstreamSha.Substring(0, 9)
        aheadOfUpstream    = $aheadCount
        behindUpstream     = $behindCount
        upstreamPrs        = $prResults
        localBranchWarnings = $branchWarnings
        needsRebuild       = ($behindCount -gt 0 -or @($prResults | Where-Object { $_.readyToRetire }).Count -gt 0 -or @($prResults | Where-Object { -not $_.includedInHead -and -not $_.readyToRetire }).Count -gt 0)
    }

    if ($Json) {
        $report | ConvertTo-Json -Depth 6
        exit 0
    }

    Write-Host "=== OpenCodex Integration Sync Check ===" -ForegroundColor Cyan
    Write-Host "Current: $headBranch @ $($report.headSha)"
    Write-Host "Upstream: $upstreamRef @ $($report.upstreamSha) (ahead=$($report.aheadOfUpstream), behind=$($report.behindUpstream))"
    Write-Host ""
    Write-Host "--- Tracked Upstream PRs ---" -ForegroundColor Cyan
    foreach ($p in $prResults) {
        $flag = if ($p.readyToRetire) { 'RETIRE(upstream done)' } elseif (-not $p.includedInHead) { 'UPDATE(new remote commits)' } else { 'IN-HEAD' }
        Write-Host ("  #{0,-5} {1,-32} state={2,-7} mergeable={3,-11} head={4} -> {5}" -f $p.number, $p.branch, $p.upstreamState, $p.mergeable, $p.upstreamHead, $flag)
    }
    if ($branchWarnings.Count -gt 0) {
        Write-Host ""
        Write-Host "--- Local Branch Patch Warnings (commits in branch not matched by HEAD) ---" -ForegroundColor Yellow
        foreach ($w in $branchWarnings) {
            Write-Host "  $($w.branch) [$($w.patchId)]: $($w.missing.Count) unmatched commit(s)" -ForegroundColor Yellow
            $w.missing | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" }
        }
    } else {
        Write-Host ""
        Write-Host "--- Tracked Local Hotfix Branches: all accounted for ---" -ForegroundColor Green
    }
    if ($report.needsRebuild) {
        Write-Host ""
        Write-Host "Recommendation: run sync-integration.ps1 -Rebuild [-Deploy] to rebase onto latest $upstreamRef." -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "Status: up to date with $upstreamRef and all tracked PR heads." -ForegroundColor Green
    }
    exit 0
}

# -Rebuild mode
$slug = ($BranchName -replace '^local/', '' -replace '[^A-Za-z0-9._-]', '-')
$newWorktree = Join-Path $MainRepoRoot ".worktrees\$slug"
if (Test-Path -LiteralPath $newWorktree) {
    throw "Target worktree already exists: $newWorktree (choose a fresh -BranchName or remove the old worktree first)"
}

Write-Host "[rebuild] Creating worktree $newWorktree on branch $BranchName from $upstreamRef ($($upstreamSha.Substring(0,9)))..." -ForegroundColor Cyan
Invoke-GitChecked -Dir $MainRepoRoot -Args @('worktree', 'add', '-b', $BranchName, $newWorktree, $upstreamRef) | Out-Null

# 1. Replay active Layer 1 + Layer 3 commits
foreach ($patch in $Manifest.localPatches) {
    Write-Host "[rebuild] Replaying local patch group: $($patch.id) ($($patch.commits.Count) commits)" -ForegroundColor Cyan
    foreach ($sha in $patch.commits) {
        $out = & git -C $newWorktree cherry-pick $sha 2>&1
        if ($LASTEXITCODE -ne 0) {
            $conflicts = (& git -C $newWorktree diff --name-only --diff-filter=U) -join ', '
            throw "Conflict while cherry-picking $sha ($($patch.id)) in $newWorktree. Conflicted files: [$conflicts]. Resolve and continue manually or via AI."
        }
    }
}

# 2. Merge still-open upstream PRs
foreach ($pr in $prResults) {
    if ($pr.readyToRetire) {
        Write-Host "[rebuild] Skipping retired/upstreamed PR #$($pr.number) ($($pr.upstreamState))" -ForegroundColor DarkGray
        continue
    }
    $ref = "origin/$($pr.branch)"
    Write-Host "[rebuild] Merging #$($pr.number) ($ref)..." -ForegroundColor Cyan
    $out = & git -C $newWorktree merge --no-edit $ref 2>&1
    if ($LASTEXITCODE -ne 0) {
        $conflicts = (& git -C $newWorktree diff --name-only --diff-filter=U) -join ', '
        throw "Merge conflict on PR #$($pr.number) ($ref) in $newWorktree. Conflicted files: [$conflicts]. Resolve and continue manually or via AI."
    }
}

Write-Host "[rebuild] Integration branch $BranchName assembled cleanly at $newWorktree" -ForegroundColor Green
if ($Deploy) {
    Write-Host "[rebuild] Running bun run build:gui..." -ForegroundColor Cyan
    Push-Location $newWorktree
    try {
        & bun run build:gui
        if ($LASTEXITCODE -ne 0) { throw "bun run build:gui failed with exit $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    $deployScript = Join-Path $newWorktree 'scripts\deploy-local.ps1'
    Write-Host "[rebuild] Running $deployScript -HealthTimeoutSec 150..." -ForegroundColor Cyan
    & pwsh -NoProfile -File $deployScript -HealthTimeoutSec 150
    exit $LASTEXITCODE
}
exit 0
