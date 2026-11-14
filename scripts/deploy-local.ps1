# deploy-local.ps1: deploy the local OpenCodex build into the global npm install and verify the proxy came back healthy.
# Flow: pack the repo (or use -Tarball) -> back up the installed package to D:/Backups/<yyyyMMdd>-ocx-deploy-<n>/ -> npm i -g <tgz>
#   -> poll the Health URL from `ocx status` until status ok, a new pid and a fresh uptime -> at ~30s Start-ScheduledTask opencodex-proxy
#   (Stop first if Running) -> at ~60s `ocx service restart` -> GET 127.0.0.1:<port>/v1/models must be 200.
# Exit 0 = healthy, 1 = failed (prints the rollback command). 503 package_tree_changed on /healthz = "still restarting", not failure.
# -DryRun resolves the Health URL and probes the live service once; it packs, backs up, installs, stops and restarts nothing.
# Logs: D:/Logs/deploy-local/ (30-day retention). Scratch tarballs: D:/Temp/scratch/deploy-local/ (14-day retention).
param(
    [string]$Tarball,
    [ValidateRange(10, 900)]
    [int]$HealthTimeoutSec = 90,
    [string]$BackupRoot = 'D:/Backups',
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName         = 'opencodex-proxy'
$PkgDir           = 'D:/Caches/npm-global/node_modules/@bitkyc08/opencodex'
$RepoRoot         = Split-Path -Parent $PSScriptRoot
$ScratchRoot      = 'D:/Temp/scratch/deploy-local'
$LogRoot          = 'D:/Logs/deploy-local'
$BackupMaxBytes   = 500MB
$ProbeIntervalSec = 2
$TaskStageSec     = 30
$RestartStageSec  = 60

$script:LogFile        = $null
$script:BackupTgz      = $null
$script:LastHttpError  = $null
# UseProxy off: the Health URL (Tailscale IP) and the loopback companion never need the system proxy.
# With proxy auto-detection on, the first request after `ocx status` stalled for the full timeout.
$script:HttpHandler    = [System.Net.Http.HttpClientHandler]::new()
$script:HttpHandler.UseProxy = $false
$script:Http           = [System.Net.Http.HttpClient]::new($script:HttpHandler)
$script:Http.Timeout   = [TimeSpan]::FromSeconds(3)

function Write-Log {
    param(
        [ValidateSet('INFO', 'STEP', 'PLAN', 'OK', 'WARN', 'ERROR')]
        [string]$Level,
        [string]$Message
    )
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message
    $color = switch ($Level) { 'OK' { 'Green' } 'WARN' { 'Yellow' } 'ERROR' { 'Red' } 'PLAN' { 'Cyan' } default { 'Gray' } }
    Write-Host $line -ForegroundColor $color
    if ($script:LogFile) { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding utf8 }
}

function Exit-Deploy {
    param([string]$Reason)
    Write-Log 'ERROR' "FAILED: $Reason"
    if ($null -eq $script:BackupTgz) { Write-Log 'ERROR' 'rollback: not needed, no backup was made and nothing was installed by this run' }
    else {
        Write-Log 'ERROR' ('rollback: npm.cmd i -g "' + $script:BackupTgz + '" ; then ocx service restart')
    }
    exit 1
}

function Get-Prop {
    param($Obj, [string]$Name)
    if ($null -eq $Obj) { return $null }
    $prop = $Obj.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Format-Probe {
    param($P)
    $up = if ($null -ne $P.Uptime) { '{0:N0}s' -f [double]$P.Uptime } else { 'n/a' }
    $note = ''
    if ($P.Http -eq 503 -and $P.ErrorCode -eq 'package_tree_changed') { $note = ' (still restarting: package_tree_changed)' }
    elseif ($P.Error) { $note = " (error: $($P.Error))" }
    return "http=$($P.Http) status=$($P.Status) pid=$($P.Pid) uptime=$up$note"
}

# Reads only status/pid/uptime/version/error.code from /healthz. The body is never printed.
function Invoke-Probe {
    param([string]$Url)
    $probe = [pscustomobject]@{ Url = $Url; Http = 0; Status = $null; Pid = $null; Uptime = $null; Version = $null; ErrorCode = $null; Error = $null }
    try {
        $resp = $script:Http.GetAsync($Url).GetAwaiter().GetResult()
        try {
            $probe.Http = [int]$resp.StatusCode
            $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        } finally { $resp.Dispose() }
    } catch {
        $probe.Error = $_.Exception.GetBaseException().Message
        return $probe
    }
    $json = $null
    try { $json = $body | ConvertFrom-Json } catch { $json = $null }
    if ($null -ne $json) {
        $probe.Status = Get-Prop $json 'status'
        $probe.Pid = Get-Prop $json 'pid'
        $probe.Uptime = Get-Prop $json 'uptime'
        $probe.Version = Get-Prop $json 'version'
        $probe.ErrorCode = Get-Prop (Get-Prop $json 'error') 'code'
    }
    return $probe
}

function Get-HttpCode {
    param([string]$Url)
    $script:LastHttpError = $null
    try {
        $resp = $script:Http.GetAsync($Url).GetAwaiter().GetResult()
        try { return [int]$resp.StatusCode } finally { $resp.Dispose() }
    } catch {
        $script:LastHttpError = $_.Exception.GetBaseException().Message
        return 0
    }
}

# Uses only hostname, port and pid from runtime-port.json; the file also holds secrets, which are never used or printed.
function Get-RuntimeInfo {
    $file = Join-Path $HOME '.opencodex/runtime-port.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    try {
        $json = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        $port = Get-Prop $json 'port'
        $hostName = [string](Get-Prop $json 'hostname')
        if ($null -eq $port -or [string]::IsNullOrWhiteSpace($hostName)) { return $null }
        return [pscustomobject]@{ Url = "http://${hostName}:${port}/healthz"; Port = [int]$port; Pid = (Get-Prop $json 'pid') }
    } catch { return $null }
}

function Get-StatusHealthUrl {
    $ocx = Get-Command ocx.cmd -ErrorAction SilentlyContinue
    if ($null -eq $ocx) { return $null }
    try {
        $text = (& $ocx.Source status 2>&1 | Out-String) -replace "`e\[[0-9;]*m", ''
    } catch { return $null }
    $m = [regex]::Match($text, 'Health:\s+(https?://\S+?/healthz)')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Resolve-HealthTarget {
    $url = Get-StatusHealthUrl
    $source = 'ocx status'
    $info = Get-RuntimeInfo
    if ($null -ne $info) {
        if ($null -eq $url) { $url = $info.Url; $source = 'runtime-port.json' }
        elseif ($url -ne $info.Url) { Write-Log 'WARN' "ocx status Health URL ($url) differs from runtime-port.json ($($info.Url)); using ocx status" }
    }
    if ($null -eq $url) { return $null }
    return [pscustomobject]@{ Url = $url; Source = $source; Port = ([uri]$url).Port }
}

function Get-InstalledVersion {
    $pkg = Join-Path $PkgDir 'package.json'
    if (-not (Test-Path -LiteralPath $pkg -PathType Leaf)) { return $null }
    return [string](Get-Prop (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json) 'version')
}

# Healthy = HTTP 200, status ok, a pid different from the pre-install pid, and uptime no older than the install (+30s slack).
function Test-Healthy {
    param($P, $OldPid, [datetime]$InstallStart)
    if ($P.Http -ne 200 -or $P.Status -ne 'ok' -or $null -eq $P.Pid -or $null -eq $P.Uptime) { return $false }
    if ($null -ne $OldPid -and [int64]$P.Pid -eq [int64]$OldPid) { return $false }
    $maxUptime = ((Get-Date) - $InstallStart).TotalSeconds + 30
    return ([double]$P.Uptime -le $maxUptime)
}

function Invoke-TaskRecovery {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { Write-Log 'WARN' "scheduled task '$TaskName' not found; skipping task recovery"; return }
    Write-Log 'INFO' "scheduled task '$TaskName' state=$($task.State)"
    try {
        if ($task.State -eq 'Running') {
            Write-Log 'STEP' 'task is Running but unhealthy: Stop-ScheduledTask, then start again'
            Stop-ScheduledTask -TaskName $TaskName
            Start-Sleep -Seconds 3
        }
        Write-Log 'STEP' "Start-ScheduledTask $TaskName"
        Start-ScheduledTask -TaskName $TaskName
    } catch {
        Write-Log 'WARN' "scheduled task action failed: $($_.Exception.Message)"
    }
}

function Invoke-ServiceRestart {
    $ocx = Get-Command ocx.cmd -ErrorAction SilentlyContinue
    if ($null -eq $ocx) { Write-Log 'WARN' 'ocx.cmd not on PATH; cannot run ocx service restart'; return }
    Write-Log 'STEP' 'ocx service restart'
    & $ocx.Source service restart *> $null
    Write-Log 'INFO' "ocx service restart exit code $LASTEXITCODE"
}

function Wait-ForHealth {
    param([string]$Url, $OldPid, [datetime]$InstallStart, [int]$TimeoutSec)
    $start = Get-Date
    $deadline = $start.AddSeconds($TimeoutSec)
    $current = $Url
    $taskDone = $false
    $restartDone = $false
    $lastState = ''
    while ((Get-Date) -lt $deadline) {
        $elapsed = ((Get-Date) - $start).TotalSeconds
        $info = Get-RuntimeInfo
        if ($null -ne $info -and $info.Url -ne $current) {
            Write-Log 'INFO' "Health URL is now $($info.Url) (runtime-port.json)"
            $current = $info.Url
        }
        $probe = Invoke-Probe $current
        $state = Format-Probe $probe
        if ($state -ne $lastState) {
            Write-Log 'INFO' ('probe at t+{0:N0}s: {1}' -f $elapsed, $state)
            $lastState = $state
        }
        if (Test-Healthy -P $probe -OldPid $OldPid -InstallStart $InstallStart) { return $probe }
        # The old process answers 503 package_tree_changed while it restarts itself; do not cut that short (cap 75s).
        $selfRestarting = ($probe.Http -eq 503 -and $probe.ErrorCode -eq 'package_tree_changed' -and $elapsed -lt 75)
        if (-not $taskDone -and -not $selfRestarting -and $elapsed -ge $TaskStageSec) {
            $taskDone = $true
            Write-Log 'WARN' "not healthy after $TaskStageSec s; trying scheduled task '$TaskName'"
            Invoke-TaskRecovery
        }
        if (-not $restartDone -and -not $selfRestarting -and $elapsed -ge $RestartStageSec) {
            $restartDone = $true
            Write-Log 'WARN' "not healthy after $RestartStageSec s; running ocx service restart"
            Invoke-ServiceRestart
        }
        Start-Sleep -Seconds $ProbeIntervalSec
    }
    return $null
}

function Get-NextBackupDir {
    $day = Get-Date -Format 'yyyyMMdd'
    $n = 1
    while (Test-Path -LiteralPath (Join-Path $BackupRoot "$day-ocx-deploy-$n")) { $n++ }
    return (Join-Path $BackupRoot "$day-ocx-deploy-$n")
}

# Writes a gzip tar whose single top-level folder is "opencodex"; npm strips that folder on install.
function New-PackageTgz {
    param([string]$SourceDir, [string]$TgzPath)
    $fileStream = [System.IO.File]::Create($TgzPath)
    try {
        $gzip = [System.IO.Compression.GZipStream]::new($fileStream, [System.IO.Compression.CompressionLevel]::Optimal)
        try {
            [System.Formats.Tar.TarFile]::CreateFromDirectory($SourceDir, $gzip, $true)
        } finally { $gzip.Dispose() }
    } finally { $fileStream.Dispose() }
}

function New-InstalledBackup {
    param([string]$OldVersion, $OldPid)
    $dir = Get-NextBackupDir
    New-Item -ItemType Directory -Path $dir | Out-Null
    $bytes = [long](Get-ChildItem -LiteralPath $PkgDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
    $mode = 'full copy'
    if ($bytes -lt $BackupMaxBytes) {
        Copy-Item -LiteralPath $PkgDir -Destination (Join-Path $dir 'opencodex') -Recurse -Force
    } else {
        $mode = 'src + package.json only (over 500 MB)'
        $sub = Join-Path $dir 'opencodex'
        New-Item -ItemType Directory -Path $sub | Out-Null
        Copy-Item -LiteralPath (Join-Path $PkgDir 'src') -Destination $sub -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PkgDir 'package.json') -Destination $sub -Force
    }
    $tgz = Join-Path $dir "opencodex-$OldVersion.tgz"
    New-PackageTgz -SourceDir $PkgDir -TgzPath $tgz
    $created = Get-Date
    $pidText = if ($null -ne $OldPid) { [string]$OldPid } else { 'none (service was not running)' }
    $readme = @(
        '# OCX 部署前备份（deploy-local.ps1）',
        '',
        "创建日期：$($created.ToString('yyyy-MM-dd')) ｜ 最后更新：$($created.ToString('yyyy-MM-dd')) ｜ 版本：1",
        '',
        '## 备份了什么',
        "- 部署前全局安装的 @bitkyc08/opencodex，版本 $OldVersion。",
        "- opencodex/：安装目录副本（模式：$mode）。",
        "- opencodex-$OldVersion.tgz：同一版本的打包文件，回滚用它。",
        '',
        '## 为什么',
        '- 在 npm i -g 之前备份，部署失败或服务起不来时可以退回旧版。',
        '',
        '## 从哪来',
        "- 原安装目录：$PkgDir",
        "- 部署前服务 pid：$pidText",
        '',
        '## 回滚',
        "- npm.cmd i -g `"$tgz`"",
        '- 然后执行 ocx service restart，用 ocx status 确认 Health 行为 ok。',
        '',
        '## 几号之后可删',
        "- $($created.AddDays(30).ToString('yyyy-MM-dd'))（创建后 30 天）。删除前确认不再需要回滚。"
    ) -join "`n"
    Set-Content -LiteralPath (Join-Path $dir 'README.md') -Value $readme -Encoding utf8
    return [pscustomobject]@{ Dir = $dir; Tgz = $tgz; Bytes = $bytes; Mode = $mode }
}

function New-PackedTarball {
    $dest = Join-Path $ScratchRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Write-Log 'STEP' "npm pack in $RepoRoot -> $dest"
    Push-Location -LiteralPath $RepoRoot
    try {
        & npm.cmd pack --pack-destination $dest | Out-Null
        $code = $LASTEXITCODE
    } finally { Pop-Location }
    if ($code -ne 0) { Exit-Deploy "npm pack failed (exit $code)" }
    $found = @(Get-ChildItem -LiteralPath $dest -Filter '*.tgz' -File)
    if ($found.Count -ne 1) { Exit-Deploy "expected exactly one .tgz in $dest, found $($found.Count)" }
    Write-Log 'OK' "packed $($found[0].FullName)"
    return $found[0].FullName
}

# Deletes only items under the given root (path checked after GetFullPath); used for the script's own logs and scratch.
function Remove-Expired {
    param([string]$Root, [int]$Days, [switch]$Directories)
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $cutoff = (Get-Date).AddDays(-$Days)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if ($Directories) { $items = @(Get-ChildItem -LiteralPath $Root -Directory) }
    else { $items = @(Get-ChildItem -LiteralPath $Root -File -Filter 'deploy-local-*.log') }
    foreach ($item in $items) {
        if ($item.LastWriteTime -ge $cutoff) { continue }
        $full = [System.IO.Path]::GetFullPath($item.FullName)
        if (-not $full.StartsWith($rootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        Remove-Item -LiteralPath $full -Recurse -Force
    }
}

function Invoke-Deploy {
    New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
    $script:LogFile = Join-Path $LogRoot ('deploy-local-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    Write-Log 'INFO' "deploy-local start: DryRun=$([bool]$DryRun) HealthTimeoutSec=$HealthTimeoutSec BackupRoot=$BackupRoot"

    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Exit-Deploy 'npm.cmd not found on PATH' }
    if (-not (Test-Path -LiteralPath $PkgDir -PathType Container)) { Exit-Deploy "installed package not found: $PkgDir" }
    $oldVersion = Get-InstalledVersion
    Write-Log 'INFO' "installed package: version $oldVersion at $PkgDir"

    $tgz = $null
    if ($Tarball) {
        $tgz = [System.IO.Path]::GetFullPath($Tarball)
        if (-not (Test-Path -LiteralPath $tgz -PathType Leaf)) { Exit-Deploy "tarball not found: $tgz" }
    }

    $target = Resolve-HealthTarget
    if ($null -eq $target) { Exit-Deploy 'cannot resolve the Health URL (ocx status has no Health line and runtime-port.json is missing)' }
    Write-Log 'INFO' "Health URL $($target.Url) (from $($target.Source)); loopback companion port $($target.Port)"

    $pre = Invoke-Probe $target.Url
    Write-Log 'INFO' "before install: $(Format-Probe $pre)"
    $oldPid = $pre.Pid
    $runtime = Get-RuntimeInfo
    if ($null -eq $oldPid -and $null -ne $runtime) { $oldPid = $runtime.Pid }

    if ($DryRun) {
        $loopCode = Get-HttpCode "http://127.0.0.1:$($target.Port)/v1/models"
        $loopNote = if ($loopCode -eq 0) { " (error: $($script:LastHttpError))" } else { '' }
        Write-Log 'INFO' "loopback GET http://127.0.0.1:$($target.Port)/v1/models -> $loopCode$loopNote (deploy requires 200)"
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $taskText = if ($null -ne $task) { "found, state=$($task.State)" } else { 'not found' }
        Write-Log 'INFO' "scheduled task '$TaskName': $taskText"
        $backupDir = Get-NextBackupDir
        $tgzText = if ($tgz) { $tgz } else { "npm pack output in $ScratchRoot/<stamp>/" }
        $bytesText = [math]::Round(([long](Get-ChildItem -LiteralPath $PkgDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
        Write-Log 'PLAN' "1. tarball: $tgzText"
        Write-Log 'PLAN' "2. backup $PkgDir ($bytesText MB; full copy if under 500 MB) -> $backupDir (plus opencodex-$oldVersion.tgz for rollback)"
        Write-Log 'PLAN' '3. npm.cmd i -g --no-audit --no-fund <tgz>'
        Write-Log 'PLAN' "4. poll $($target.Url) every ${ProbeIntervalSec}s up to ${HealthTimeoutSec}s; pass = http 200 + status ok + pid differs from $oldPid + uptime since install"
        Write-Log 'PLAN' "5. not healthy at ${TaskStageSec}s: Start-ScheduledTask '$TaskName' (Stop first if Running); at ${RestartStageSec}s: ocx service restart"
        Write-Log 'PLAN' "6. healthy -> GET http://127.0.0.1:$($target.Port)/v1/models must be 200; failure -> rollback command, exit 1"
        Write-Log 'OK' 'DRY RUN complete: nothing packed, backed up, installed, stopped or restarted.'
        exit 0
    }

    Remove-Expired -Root $LogRoot -Days 30
    Remove-Expired -Root $ScratchRoot -Days 14 -Directories

    if ($null -eq $tgz) { $tgz = New-PackedTarball }

    $backup = New-InstalledBackup -OldVersion $oldVersion -OldPid $oldPid
    $script:BackupTgz = $backup.Tgz
    Write-Log 'OK' "backup: $($backup.Dir) ($($backup.Mode), $([math]::Round($backup.Bytes / 1MB, 1)) MB); rollback tgz: $($backup.Tgz)"

    Write-Log 'STEP' "npm.cmd i -g --no-audit --no-fund $tgz"
    $installStart = Get-Date
    & npm.cmd i -g --no-audit --no-fund $tgz
    $code = $LASTEXITCODE
    if ($code -ne 0) { Exit-Deploy "npm install failed (exit $code)" }
    $newVersion = Get-InstalledVersion
    Write-Log 'OK' "npm install finished; installed version $newVersion"

    $healthy = Wait-ForHealth -Url $target.Url -OldPid $oldPid -InstallStart $installStart -TimeoutSec $HealthTimeoutSec
    if ($null -eq $healthy) { Exit-Deploy "not healthy after ${HealthTimeoutSec}s" }

    $port = ([uri]$healthy.Url).Port
    $models = Get-HttpCode "http://127.0.0.1:$port/v1/models"
    if ($models -ne 200) { Exit-Deploy "GET http://127.0.0.1:$port/v1/models returned $models, expected 200" }
    Write-Log 'OK' "GET http://127.0.0.1:$port/v1/models -> 200"
    if ($healthy.Version -and $newVersion -and [string]$healthy.Version -ne [string]$newVersion) {
        Write-Log 'WARN' "healthz version $($healthy.Version) differs from installed package.json version $newVersion"
    }
    Write-Log 'OK' "HEALTHY: pid $oldPid -> $($healthy.Pid), uptime $([math]::Round([double]$healthy.Uptime, 1)) s, version $($healthy.Version)"
    Write-Log 'INFO' "log: $($script:LogFile)"
    exit 0
}

# Dot-sourcing (`. ./deploy-local.ps1`) loads the functions without running the deploy, for tests.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-Deploy
    } catch {
        Write-Log 'ERROR' "unexpected: $($_.Exception.Message)"
        Exit-Deploy 'unexpected error (see the line above)'
    }
}
