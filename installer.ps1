param(
    [string]$Action,
    [string[]]$Target,
    [string]$SkillsDir,
    [switch]$All,
    [string]$InstallDir,
    [switch]$Help
)

# dpsk-bridge installer for Windows PowerShell 5.1 and PowerShell 7.
# This file is intentionally ASCII-only: Windows PowerShell 5.1 and
# "irm ... | iex" mishandle non-ASCII source and byte-order marks.
# Piped (no arguments are possible, choose options with environment variables):
#   irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
# From a file:
#   .\installer.ps1 [-Action install|upgrade|uninstall] [-Target NAME[,NAME]] [-SkillsDir DIR] [-All] [-InstallDir DIR]
# The Node core in scripts/installer-core.mjs performs the actual installation.

# Windows PowerShell 5.1 consoles default to the OEM code page, which turns
# the step markers into '?'. UTF-8 output also matches what the Node core writes.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}

$RepoUrl = 'https://github.com/XiaoNetwork-Astral/dpsk-bridge.git'
$OfficialSlug = 'XiaoNetwork-Astral/dpsk-bridge'

function Write-Step {
    param([string]$Kind, [string]$Message, [string]$Detail)
    $symbol = switch ($Kind) {
        'ok' { [char]0x2713 }
        'warn' { '!' }
        default { [char]0x2717 }
    }
    $line = "  $symbol $Message"
    if (-not [string]::IsNullOrWhiteSpace($Detail)) { $line = "$line $Detail" }
    Write-Output $line
}

function Fail {
    param([string]$Message, [string]$Hint)
    [Console]::Error.WriteLine("  $([char]0x2717) $Message")
    if (-not [string]::IsNullOrWhiteSpace($Hint)) {
        [Console]::Error.WriteLine("    -> $Hint")
    }
    exit 1
}

function Show-Help {
    Write-Output @'
dpsk-bridge installer (Windows)

Usage:
  Piped (no arguments are possible, choose with environment variables):
    irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
    $env:DPSK_ACTION = 'upgrade'; irm .../installer.ps1 | iex
    $env:DPSK_ACTION = 'uninstall'; $env:DPSK_UNINSTALL_ALL = '1'; irm .../installer.ps1 | iex

  From a file:
    .\installer.ps1 [-Action install|upgrade|uninstall] [-Target NAME[,NAME]] [-SkillsDir DIR] [-All] [-InstallDir DIR]

Actions:
  install      Install or repair dpsk-bridge (default)
  upgrade      Fast-forward the checkout to the latest GitHub Release, then reinstall
  uninstall    Remove one host's skills, or everything with -All

Options:
  -Action NAME       install, upgrade or uninstall
  -Target NAME       Host to install or uninstall: Claude, Codex or Generic (comma-separated)
  -SkillsDir DIR     Absolute skills directory, only with -Target Generic
  -All               Uninstall every host, the shared commands and the install record
  -InstallDir DIR    Fresh-install location (default: ~/.dpsk-bridge/app)
  -Help              Show this help

Environment variables (arguments override them):
  DPSK_ACTION          install, upgrade or uninstall (default: install)
  DPSK_TARGET          Comma-separated hosts, for example Claude,Codex
  DPSK_SKILLS_DIR      Absolute skills directory for Generic
  DPSK_UNINSTALL_ALL   Set to 1 to uninstall everything
  DPSK_INSTALL_DIR     Fresh-install location

The checkout is located from this script's directory, ~/.dpsk-bridge/install.json
or the global npm dpsk-bridge link. With no checkout, install clones the latest
release into ~/.dpsk-bridge/app (or -InstallDir).
'@
}

if ($Help.IsPresent) {
    Show-Help
    exit 0
}

# ---------------------------------------------------------------------------
# Arguments and environment variables
# ---------------------------------------------------------------------------

$actionValue = $Action
if ([string]::IsNullOrWhiteSpace($actionValue)) { $actionValue = $env:DPSK_ACTION }
if ([string]::IsNullOrWhiteSpace($actionValue)) { $actionValue = 'install' }
$actionValue = $actionValue.Trim().ToLowerInvariant()
if (@('install', 'upgrade', 'uninstall') -notcontains $actionValue) {
    Fail "Unknown action: $actionValue" 'Use install, upgrade or uninstall; run .\installer.ps1 -Help for details'
}

$targetValues = @()
$rawTargets = @()
if ($null -ne $Target -and $Target.Count -gt 0) {
    $rawTargets += $Target
} elseif (-not [string]::IsNullOrWhiteSpace($env:DPSK_TARGET)) {
    $rawTargets += ($env:DPSK_TARGET -split ',')
}
foreach ($rawTarget in $rawTargets) {
    foreach ($part in ([string]$rawTarget -split ',')) {
        $trimmed = $part.Trim()
        if ($trimmed.Length -gt 0) { $targetValues += $trimmed }
    }
}

$skillsValue = $null
if (-not [string]::IsNullOrWhiteSpace($SkillsDir)) { $skillsValue = $SkillsDir }
elseif (-not [string]::IsNullOrWhiteSpace($env:DPSK_SKILLS_DIR)) { $skillsValue = $env:DPSK_SKILLS_DIR }

$allValue = $All.IsPresent
if (-not $allValue -and $env:DPSK_UNINSTALL_ALL -eq '1') { $allValue = $true }
if ($allValue -and $actionValue -ne 'uninstall') {
    Fail '-All / DPSK_UNINSTALL_ALL is only valid with uninstall' 'Use: .\installer.ps1 -Action uninstall -All'
}

$installDirValue = $null
if (-not [string]::IsNullOrWhiteSpace($InstallDir)) { $installDirValue = $InstallDir }
elseif (-not [string]::IsNullOrWhiteSpace($env:DPSK_INSTALL_DIR)) { $installDirValue = $env:DPSK_INSTALL_DIR }

Write-Output 'dpsk-bridge installer'

# ---------------------------------------------------------------------------
# Fatal prerequisites, checked before anything is downloaded or changed
# ---------------------------------------------------------------------------

$gitCommand = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $gitCommand) {
    Fail 'Git is required' 'Install Git from https://git-scm.com/downloads, then reopen the terminal'
}
$gitVersion = @(& $gitCommand.Source --version 2>$null)
if ($LASTEXITCODE -ne 0 -or $gitVersion.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$gitVersion[0])) {
    Fail 'Git is required but did not run' 'Reinstall Git from https://git-scm.com/downloads, then reopen the terminal'
}
Write-Step 'ok' ([string]$gitVersion[0])

$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand) {
    Fail 'Node.js 24.9 or newer is required' 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal'
}
$nodeVersion = @(& $nodeCommand.Source --version 2>$null)
$nodeText = ''
if ($nodeVersion.Count -gt 0) { $nodeText = ([string]$nodeVersion[0]).Trim() }
if ($LASTEXITCODE -ne 0 -or $nodeText -notmatch '^v?(\d+)\.(\d+)') {
    Fail "Cannot read the Node.js version (found: $nodeText)" 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal'
}
$nodeMajor = [int]$Matches[1]
$nodeMinor = [int]$Matches[2]
if ($nodeMajor -lt 24 -or ($nodeMajor -eq 24 -and $nodeMinor -lt 9)) {
    Fail "Node.js 24.9 or newer is required; found $nodeText" 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal'
}
Write-Step 'ok' "Node.js $nodeText"

$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $npmCommand) { $npmCommand = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
if ($null -eq $npmCommand) {
    Fail 'npm is required' 'Reinstall Node.js with npm from https://nodejs.org, then reopen the terminal'
}
$npmVersion = @(& $npmCommand.Source --version 2>$null)
$npmText = ''
if ($npmVersion.Count -gt 0) { $npmText = ([string]$npmVersion[$npmVersion.Count - 1]).Trim() }
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmText)) {
    Fail 'npm is required but did not run' 'Reinstall Node.js with npm from https://nodejs.org, then reopen the terminal'
}
Write-Step 'ok' "npm $npmText"

# ---------------------------------------------------------------------------
# Checkout discovery helpers
# ---------------------------------------------------------------------------

$HomeDir = $HOME
if ([string]::IsNullOrWhiteSpace($HomeDir)) { Fail 'Cannot determine the user home directory' 'Set the USERPROFILE environment variable and retry' }

function Get-FullPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
    if ($Path -eq '~') { return $HomeDir }
    if ($Path.StartsWith('~/') -or $Path.StartsWith('~\')) {
        return [System.IO.Path]::GetFullPath((Join-Path $HomeDir $Path.Substring(2)))
    }
    return [System.IO.Path]::GetFullPath($Path)
}

function Get-BridgePackage {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { return $null }
    $file = Join-Path $Dir 'package.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    try { $package = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
    catch { return $null }
    if ($null -ne $package -and $package.name -eq 'dpsk-bridge') { return $package }
    return $null
}

function Test-UsableCheckout {
    param([string]$Dir)
    if ($null -eq (Get-BridgePackage $Dir)) { return $false }
    return (Test-Path -LiteralPath (Join-Path (Join-Path $Dir 'scripts') 'installer-core.mjs') -PathType Leaf)
}

function Resolve-RealPath {
    param([string]$Path)
    # Use single quotes only: Windows PowerShell 5.1 mangles embedded double
    # quotes when it passes -e scripts to a native command.
    $script = 'import fs from ''node:fs''; try { process.stdout.write(fs.realpathSync.native(process.argv[1])) } catch { process.exit(1) }'
    $output = @(& $nodeCommand.Source --input-type=module -e $script $Path 2>$null)
    if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { return $null }
    return ($output -join '')
}

function Test-OfficialOrigin {
    param([string]$Origin)
    $value = $Origin.Trim()
    if ($value -eq "https://github.com/$OfficialSlug.git" -or $value -eq "https://github.com/$OfficialSlug") { return $true }
    if ($value -eq "git@github.com:$OfficialSlug.git" -or $value -eq "git@github.com:$OfficialSlug") { return $true }
    if ($value -eq "ssh://git@github.com/$OfficialSlug.git" -or $value -eq "ssh://git@github.com/$OfficialSlug") { return $true }
    return $false
}

# Latest published release tag; the test seam wins, the GitHub API is primary
# and the remote tag list is the offline fallback.
function Get-LatestTag {
    if (-not [string]::IsNullOrWhiteSpace($env:DPSK_INSTALLER_UPGRADE_TAG)) {
        return $env:DPSK_INSTALLER_UPGRADE_TAG.Trim()
    }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
    try {
        $headers = @{ 'User-Agent' = 'dpsk-bridge-installer'; 'Accept' = 'application/vnd.github+json' }
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$OfficialSlug/releases/latest" -Headers $headers -TimeoutSec 10 -ErrorAction Stop
        if ($release.tag_name -match '^v?\d+\.\d+\.\d+$') { return [string]$release.tag_name }
    } catch { }
    try {
        $listing = @(& $gitCommand.Source ls-remote --tags --refs --sort=-version:refname $RepoUrl 2>$null)
        foreach ($line in $listing) {
            if ($line -match 'refs/tags/(v?\d+\.\d+\.\d+)$') { return $Matches[1] }
        }
    } catch { }
    return $null
}

# ---------------------------------------------------------------------------
# Locate, migrate or clone the checkout
# ---------------------------------------------------------------------------

$stateFile = Join-Path (Join-Path $HomeDir '.dpsk-bridge') 'install.json'
$recordRoot = $null
if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
    try {
        $record = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        if ($record -and $record.root -is [string]) { $recordRoot = $record.root }
    } catch { }
}

$npmPrefix = $env:npm_config_prefix
if ([string]::IsNullOrWhiteSpace($npmPrefix)) { $npmPrefix = $env:NPM_CONFIG_PREFIX }
if ([string]::IsNullOrWhiteSpace($npmPrefix)) {
    try {
        $prefixOutput = @(& $npmCommand.Source prefix -g 2>$null)
        if ($LASTEXITCODE -eq 0 -and $prefixOutput.Count -gt 0) { $npmPrefix = [string]$prefixOutput[$prefixOutput.Count - 1] }
    } catch { $npmPrefix = $null }
}
$globalRoot = $null
if (-not [string]::IsNullOrWhiteSpace($npmPrefix)) {
    $globalLink = Join-Path (Join-Path $npmPrefix 'node_modules') 'dpsk-bridge'
    if (Test-Path -LiteralPath $globalLink) { $globalRoot = Resolve-RealPath $globalLink }
}

$scriptDir = $null
if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $scriptDir = $PSScriptRoot }
elseif (-not [string]::IsNullOrWhiteSpace($PSCommandPath)) { $scriptDir = Split-Path -Parent $PSCommandPath }

$candidates = @()
foreach ($candidate in @($scriptDir, $recordRoot, $globalRoot)) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    $candidates += (Get-FullPath $candidate)
}
$checkout = $null
$legacy = $null
foreach ($candidate in $candidates) {
    if (Test-UsableCheckout $candidate) { $checkout = $candidate; break }
    if ($null -ne (Get-BridgePackage $candidate)) { $legacy = $candidate; break }
}

# A 0.4.x checkout has no Node core yet. Migration happens in place at the
# location the user chose, first fetching the latest release tag and then
# letting the merge's fast-forward check reject divergent history.
function Update-LegacyCheckout {
    param([string]$Dir)
    Write-Step 'warn' 'Found an older dpsk-bridge checkout' $Dir
    $top = @(& $gitCommand.Source -C $Dir rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or $top.Count -eq 0) {
        Fail "This checkout is not a Git checkout: $Dir" 'Move it away, then run the installer again to install the latest release'
    }
    $topPath = Resolve-RealPath ([string]$top[0])
    $dirPath = Resolve-RealPath (Get-FullPath $Dir)
    if ([string]::IsNullOrWhiteSpace($topPath) -or [string]::IsNullOrWhiteSpace($dirPath) -or $topPath -ne $dirPath) {
        Fail "The dpsk-bridge checkout must be the Git root: $Dir" "git -C `"$Dir`" rev-parse --show-toplevel"
    }
    $origins = @(& $gitCommand.Source -C $Dir config --get-all remote.origin.url 2>$null)
    if ($LASTEXITCODE -ne 0 -or $origins.Count -ne 1 -or -not (Test-OfficialOrigin ([string]$origins[0]))) {
        Fail "origin must point to the official $OfficialSlug repository" "git -C `"$Dir`" remote set-url origin $RepoUrl"
    }
    $status = @(& $gitCommand.Source -C $Dir status --porcelain=v1 --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0) { Fail "Cannot inspect the checkout: $Dir" "git -C `"$Dir`" status --short" }
    if (($status -join '').Trim().Length -gt 0) {
        Fail 'Checkout has local changes or untracked files; commit or move them before upgrading' "git -C `"$Dir`" status --short"
    }
    $tag = Get-LatestTag
    if ([string]::IsNullOrWhiteSpace($tag)) {
        Fail 'Cannot determine the latest dpsk-bridge release' 'Check network access, or update the checkout manually with git'
    }
    if ($tag -notmatch '^v?\d+\.\d+\.\d+$') {
        Fail "Not a stable release tag: $tag" 'Only v<major>.<minor>.<patch> releases can be installed'
    }
    Write-Step 'ok' "Latest release is $tag"
    & $gitCommand.Source -C $Dir fetch --tags origin 2>$null
    if ($LASTEXITCODE -ne 0) { Fail 'Cannot fetch release tags from origin' "git -C `"$Dir`" fetch --tags origin" }
    & $gitCommand.Source -C $Dir rev-parse --verify --quiet "refs/tags/$tag^{commit}" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Release tag $tag is not available in the checkout" "git -C `"$Dir`" fetch --tags origin" }
    & $gitCommand.Source -C $Dir merge --ff-only "refs/tags/$tag" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "Cannot fast-forward the checkout to $tag; the history may have diverged" "Inspect: git -C `"$Dir`" log --oneline --graph --all"
    }
    Write-Step 'ok' "Updated checkout to $tag" $Dir
}

function Install-FreshCheckout {
    param([string]$Dir)
    $tag = Get-LatestTag
    if ([string]::IsNullOrWhiteSpace($tag)) {
        Fail 'Cannot determine the latest dpsk-bridge release' "Check network access, or clone manually: git clone $RepoUrl `"$Dir`""
    }
    if ($tag -notmatch '^v?\d+\.\d+\.\d+$') {
        Fail "Not a stable release tag: $tag" 'Only v<major>.<minor>.<patch> releases can be installed'
    }
    if (Test-Path -LiteralPath $Dir) {
        $entries = @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue)
        if ($entries.Count -gt 0) { Fail "Install directory is not empty: $Dir" 'Choose another -InstallDir or remove it' }
    } else {
        $parent = Split-Path -Parent $Dir
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
    }
    Write-Step 'warn' "Cloning dpsk-bridge $tag" $Dir
    & $gitCommand.Source -c advice.detachedHead=false clone --quiet --branch $tag $RepoUrl $Dir 2>$null
    if ($LASTEXITCODE -ne 0) { Fail "Cannot clone dpsk-bridge into $Dir" "git clone --branch $tag $RepoUrl `"$Dir`"" }
    Write-Step 'ok' "Cloned dpsk-bridge $tag" $Dir
}

if ($null -ne $checkout) {
    Write-Step 'ok' 'Using dpsk-bridge checkout' $checkout
} elseif ($null -ne $legacy) {
    if ($actionValue -eq 'uninstall') {
        Fail 'This checkout predates the 0.5.0 installer core and cannot be uninstalled directly' "Run the installer's upgrade first (.\installer.ps1 -Action upgrade), then run uninstall"
    }
    Update-LegacyCheckout $legacy
    $checkout = $legacy
} else {
    if ($actionValue -ne 'install') {
        Fail "No existing dpsk-bridge checkout was found for '$actionValue'" "Install it first: irm https://github.com/$OfficialSlug/releases/latest/download/installer.ps1 | iex"
    }
    $freshDir = $installDirValue
    if ([string]::IsNullOrWhiteSpace($freshDir)) { $freshDir = Join-Path $HomeDir '.dpsk-bridge/app' }
    $freshPath = Get-FullPath $freshDir
    Install-FreshCheckout $freshPath
    $checkout = $freshPath
}

$corePath = Join-Path (Join-Path $checkout 'scripts') 'installer-core.mjs'
if (-not (Test-Path -LiteralPath $corePath -PathType Leaf)) {
    Fail "The installer core is missing: $corePath" 'Update the checkout to a published dpsk-bridge release and retry'
}
Write-Step 'ok' 'Using installer core' $corePath

# ---------------------------------------------------------------------------
# Run the core and report its result
# ---------------------------------------------------------------------------

$coreArgs = @($actionValue)
foreach ($targetValue in $targetValues) { $coreArgs += @('--target', $targetValue) }
if (-not [string]::IsNullOrWhiteSpace($skillsValue)) { $coreArgs += @('--skills-dir', $skillsValue) }
if ($allValue) { $coreArgs += '--all' }

& $nodeCommand.Source $corePath @coreArgs
$coreStatus = $LASTEXITCODE
if ($coreStatus -ne 0) {
    [Console]::Error.WriteLine("  $([char]0x2717) dpsk-bridge $actionValue failed (exit $coreStatus)")
    exit $coreStatus
}

Write-Output ''
Write-Step 'ok' "dpsk-bridge $actionValue complete"
if ($actionValue -eq 'uninstall') {
    Write-Output "  Checkout kept at $checkout"
} else {
    Write-Output '  Next: dsv update keeps the checkout current; dsb --help lists job commands.'
}
