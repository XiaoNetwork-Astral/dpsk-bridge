# dpsk-bridge cleanup for Windows PowerShell 5.1 and PowerShell 7.
# This file is intentionally ASCII-only, like installer.ps1.
#
# Standalone: no Node.js and no checkout are required. It removes the dsb / dsv
# launchers that belong to dpsk-bridge and this project's skill folders, then
# leaves everything else alone.
#
# Usage:
#   .\cleanup.ps1 -h | --help

# Windows PowerShell 5.1 consoles default to the OEM code page, which turns
# the step markers into '?'. UTF-8 output also matches installer.ps1.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}

$InstallCommand = 'irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex'
$UsageHint = 'Usage: cleanup.ps1 [-h | --help]'

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
dpsk-bridge cleanup (Windows)

Remove the dsb / dsv launchers and this project's skill folders. No Node.js
and no checkout are required.

Usage:
  cleanup.ps1 -h | --help

What it removes:
  - dsb and dsv found on PATH or in the global npm prefix, after confirming
    they launch a dpsk-bridge bin/dsb.mjs or bin/dsv.mjs. When npm owns them,
    npm uninstall -g dpsk-bridge is used; otherwise the launcher files are
    deleted directly.
  - Skill folders in ~/.claude/skills and ~/.agents/skills that are listed in
    a dpsk-bridge manifest under ~/.dpsk-bridge, or named deepseek-delegate,
    deepseek-mcp or dsh-mcp with a SKILL.md whose front-matter name matches.
  - The install record (install.json) and the Claude and Codex harness records
    in ~/.dpsk-bridge, so the next installer run starts a fresh install.

Every removed skill folder is backed up under ~/.dpsk-bridge/backups first.
Other skills and other harness directories, the rest of ~/.dpsk-bridge, dsh
and ~/.dsh are left alone. Finish by running the installer.
'@
}

# ---------------------------------------------------------------------------
# Positional command line
# ---------------------------------------------------------------------------

$arguments = @($args)
if ($arguments.Count -gt 0) {
    $first = ([string]$arguments[0]).ToLowerInvariant()
    if ($first -eq '-h' -or $first -eq '--help') {
        if ($arguments.Count -gt 1) { Fail 'Help takes no arguments' $UsageHint }
        Show-Help
        exit 0
    }
    Fail "Unknown argument: $($arguments[0])" $UsageHint
}

Write-Output 'dpsk-bridge cleanup'

$HomeDir = $HOME
if ([string]::IsNullOrWhiteSpace($HomeDir)) { Fail 'Cannot determine the user home directory' 'Set the USERPROFILE environment variable and retry' }
$stateDir = Join-Path $HomeDir '.dpsk-bridge'
$backupDir = Join-Path $stateDir 'backups'
$script:removed = 0
$script:kept = 0

$ownedNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$manifestFiles = @(Get-ChildItem -LiteralPath $stateDir -Filter 'installed-skills*.txt' -File -ErrorAction SilentlyContinue)
foreach ($manifest in $manifestFiles) {
    foreach ($line in @(Get-Content -LiteralPath $manifest.FullName -ErrorAction SilentlyContinue)) {
        $name = ([string]$line).Trim()
        if (-not [string]::IsNullOrWhiteSpace($name)) { [void]$ownedNames.Add($name) }
    }
}

# ---------------------------------------------------------------------------
# Ownership evidence
# ---------------------------------------------------------------------------

function Test-Allowlisted {
    param([string]$Name)
    return (@('deepseek-delegate', 'deepseek-mcp', 'dsh-mcp') -contains $Name)
}

function Get-FrontMatterName {
    param([string]$Dir)
    $file = Join-Path $Dir 'SKILL.md'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return '' }
    $lines = @(Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)
    if ($lines.Count -eq 0) { return '' }
    if (([string]$lines[0]).Trim() -ne '---') { return '' }
    for ($index = 1; $index -lt $lines.Count; $index++) {
        $line = ([string]$lines[$index]).TrimEnd()
        if ($line.Trim() -eq '---') { break }
        if ($line -match '^name:\s*(.*)$') {
            $value = $Matches[1].Trim()
            $value = $value.Trim('"').Trim("'")
            return $value
        }
    }
    return ''
}

function Test-BridgePackage {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { return $false }
    if (-not (Test-Path -LiteralPath $Dir)) { return $false }
    $file = Join-Path $Dir 'package.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
    try { $package = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json }
    catch { return $false }
    return ($null -ne $package -and $package.name -eq 'dpsk-bridge')
}

function Test-OurShim {
    param([string]$File)
    $item = Get-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $false }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $target = $item.Target
        if ($target -is [array]) { $target = [string]$target[0] }
        $target = [string]$target
        if ([string]::IsNullOrWhiteSpace($target)) { return $false }
        if ($target -match 'dpsk-bridge[\\/]+bin[\\/]+ds[bv]\.mjs') { return $true }
        if ($target -match 'bin[\\/]+ds[bv]\.mjs$') {
            $root = Split-Path -Parent (Split-Path -Parent $target)
            return (Test-BridgePackage $root)
        }
        return $false
    }
    if ($item.PSIsContainer) { return $false }
    try { $text = Get-Content -LiteralPath $File -Raw -ErrorAction Stop } catch { return $false }
    return ($text -match 'dpsk-bridge[\\/]+bin[\\/]+ds[bv]\.mjs')
}

function Backup-Skill {
    param([string]$Source, [string]$Label)
    if (-not (Test-Path -LiteralPath $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }
    $safe = $Label -replace '[\\/:~]', '_'
    $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $destination = Join-Path $backupDir "$safe.$suffix.bak"
    Copy-Item -LiteralPath $Source -Destination $destination -Recurse -Force
    return $destination
}

# ---------------------------------------------------------------------------
# Skill folders
# ---------------------------------------------------------------------------

function Clean-SkillDirectory {
    param([string]$Base, [string]$Label)
    if (-not (Test-Path -LiteralPath $Base -PathType Container)) {
        Write-Step 'warn' "No $Label skills directory; nothing to clean" $Base
        return
    }
    foreach ($entry in @(Get-ChildItem -LiteralPath $Base -Force -ErrorAction SilentlyContinue)) {
        $name = $entry.Name
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Write-Step 'warn' "Kept $Label skill $name" 'symbolic link, not a managed skill folder'
            $script:kept++
            continue
        }
        if (-not $entry.PSIsContainer) {
            Write-Step 'warn' "Kept $Label item $name" 'not a skill folder'
            $script:kept++
            continue
        }
        $confirmed = $false
        if ($ownedNames.Contains($name)) {
            $confirmed = $true
        } elseif (Test-Allowlisted $name) {
            if ((Get-FrontMatterName $entry.FullName) -eq $name) { $confirmed = $true }
        }
        if ($confirmed) {
            $destination = Backup-Skill $entry.FullName "cleanup-$Label-$name"
            Remove-Item -LiteralPath $entry.FullName -Recurse -Force
            Write-Step 'ok' "Removed $Label skill $name" "backup: $destination"
            $script:removed++
        } else {
            if (Test-Allowlisted $name) {
                Write-Step 'warn' "Kept $Label skill $name" 'SKILL.md name does not match the folder'
            } else {
                Write-Step 'warn' "Kept $Label skill $name" 'not listed in a dpsk-bridge manifest'
            }
            $script:kept++
        }
    }
}

Clean-SkillDirectory (Join-Path $HomeDir '.claude/skills') 'Claude'
Clean-SkillDirectory (Join-Path $HomeDir '.agents/skills') 'Codex'

# ---------------------------------------------------------------------------
# Launchers
# ---------------------------------------------------------------------------

$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $npmCommand) { $npmCommand = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }

function Get-NpmPrefix {
    foreach ($name in @('npm_config_prefix', 'NPM_CONFIG_PREFIX')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrWhiteSpace($value)) { return [IO.Path]::GetFullPath($value) }
    }
    if ($null -ne $npmCommand) {
        try {
            $output = @(& $npmCommand.Source prefix -g 2>$null)
            if ($LASTEXITCODE -eq 0 -and $output.Count -gt 0) {
                return [IO.Path]::GetFullPath(([string]$output[$output.Count - 1]).Trim())
            }
        } catch { }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) { return (Join-Path $env:APPDATA 'npm') }
    return $null
}

$npmPrefix = Get-NpmPrefix

# When npm owns the global package, let npm remove the package and its
# launchers together. If npm is unavailable the confirmed launcher files below
# are still removed.
if (-not [string]::IsNullOrWhiteSpace($npmPrefix)) {
    $npmPackage = Join-Path (Join-Path $npmPrefix 'node_modules') 'dpsk-bridge'
    if ((Test-BridgePackage $npmPackage) -and $null -ne $npmCommand) {
        & $npmCommand.Source uninstall -g dpsk-bridge --ignore-scripts --no-fund --no-audit 2>$null | Out-Null
        if (Test-BridgePackage $npmPackage) {
            & $npmCommand.Source unlink -g dpsk-bridge --ignore-scripts --no-fund --no-audit 2>$null | Out-Null
        }
        if (-not (Test-BridgePackage $npmPackage)) {
            Write-Step 'ok' 'Removed the npm global dpsk-bridge package' $npmPrefix
            $script:removed++
        }
    }
}

$handled = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

function Scan-Shim {
    param([string]$File)
    if ([string]::IsNullOrWhiteSpace($File)) { return }
    $item = Get-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if ($item.PSIsContainer) { return }
    if ($handled.Contains($File)) { return }
    [void]$handled.Add($File)
    if (Test-OurShim $File) {
        Remove-Item -LiteralPath $File -Force
        Write-Step 'ok' "Removed launcher $($item.Name)" $File
        $script:removed++
    } else {
        Write-Step 'warn' "Kept launcher $($item.Name)" "not a dpsk-bridge launcher: $File"
        $script:kept++
    }
}

$launcherFound = $false
foreach ($name in @('dsb', 'dsv')) {
    $commands = @(Get-Command $name -All -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandType -eq 'Application' -or $_.CommandType -eq 'ExternalScript'
    })
    foreach ($command in $commands) {
        $path = [string]$command.Path
        if ([string]::IsNullOrWhiteSpace($path)) { $path = [string]$command.Source }
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        $launcherFound = $true
        Scan-Shim $path
    }
    if (-not [string]::IsNullOrWhiteSpace($npmPrefix)) {
        foreach ($extension in @('', '.cmd', '.ps1')) {
            $candidate = Join-Path $npmPrefix ($name + $extension)
            $item = Get-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
            if ($null -ne $item -and -not $item.PSIsContainer) {
                $launcherFound = $true
                Scan-Shim $candidate
            }
        }
    }
}
if (-not $launcherFound) {
    Write-Step 'warn' 'No dsb or dsv launcher found on PATH or in the npm prefix'
}

# ---------------------------------------------------------------------------
# Install records
# ---------------------------------------------------------------------------

# Without these, the next installer run would find the old install again
# instead of starting fresh. Records for "other" harnesses stay.
foreach ($file in @('install.json', 'installed-skills.txt', 'installed-skills.host.json',
        'installed-skills-codex.txt', 'installed-skills-codex.host.json')) {
    $recordPath = Join-Path $stateDir $file
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        Remove-Item -LiteralPath $recordPath -Force
        Write-Step 'ok' "Removed install record $file"
        $script:removed++
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Output ''
if ($script:removed -eq 0) {
    Write-Step 'warn' 'Nothing was removed'
} else {
    Write-Step 'ok' "Removed $($script:removed) item(s)"
}
if ($script:kept -gt 0) {
    Write-Step 'warn' "Kept $($script:kept) item(s); the reasons are listed above"
}
Write-Step 'warn' 'Left the rest of ~/.dpsk-bridge, dsh and ~/.dsh in place'
Write-Output ''
Write-Output 'Next: install dpsk-bridge:'
Write-Output "  $InstallCommand"
