#!/usr/bin/env bash
# dpsk-bridge cleanup for Linux and macOS.
#
# Standalone: no Node.js and no checkout are required. It removes the dsb / dsv
# launchers that belong to dpsk-bridge and this project's skill folders, then
# leaves everything else alone.
#
# Usage:
#   ./cleanup.sh -h | --help
set -eu

official_slug='https://github.com/XiaoNetwork-Astral/dpsk-bridge'
install_command='curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | bash'
usage_hint='Usage: cleanup.sh [-h | --help]'

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  bold=$'\033[1m'; dim=$'\033[2m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
else
  bold=''; dim=''; green=''; yellow=''; red=''; reset=''
fi

step_ok() {
  if [ $# -gt 1 ] && [ -n "$2" ]; then
    printf '  %s%s%s %s %s%s%s\n' "$green" '✓' "$reset" "$1" "$dim" "$2" "$reset"
  else
    printf '  %s%s%s %s\n' "$green" '✓' "$reset" "$1"
  fi
}

step_warn() {
  if [ $# -gt 1 ] && [ -n "$2" ]; then
    printf '  %s!%s %s %s%s%s\n' "$yellow" "$reset" "$1" "$dim" "$2" "$reset"
  else
    printf '  %s!%s %s\n' "$yellow" "$reset" "$1"
  fi
}

fail() {
  printf '  %s%s%s %s\n' "$red" '✗' "$reset" "$1" >&2
  if [ $# -gt 1 ] && [ -n "$2" ]; then
    printf '    %s-> %s%s\n' "$dim" "$2" "$reset" >&2
  fi
  exit 1
}

usage() {
  cat <<'EOF'
dpsk-bridge cleanup (Linux and macOS)

Remove the dsb / dsv launchers and this project's skill folders. No Node.js
and no checkout are required.

Usage:
  cleanup.sh -h | --help

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
EOF
}

case "${1:-}" in
  '') ;;
  -h|--help)
    if [ $# -gt 1 ]; then fail "Help takes no arguments" "$usage_hint"; fi
    usage
    exit 0
    ;;
  *)
    fail "Unknown argument: $1" "$usage_hint"
    ;;
esac

printf '%s\n' "${bold}dpsk-bridge cleanup${reset}"

state_dir="${HOME:?HOME is not set}/.dpsk-bridge"
backup_dir="$state_dir/backups"
removed=0
kept=0
backup_serial=0
owned=''
handled=''

# ---------------------------------------------------------------------------
# Ownership evidence
# ---------------------------------------------------------------------------

load_manifests() {
  local manifest name
  for manifest in "$state_dir"/installed-skills*.txt; do
    [ -f "$manifest" ] || continue
    while IFS= read -r name || [ -n "$name" ]; do
      name="${name%$'\r'}"
      name="$(printf '%s' "$name" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      [ -n "$name" ] || continue
      owned="$owned$name"$'\n'
    done < "$manifest"
  done
}

is_owned() {
  [ -n "$owned" ] || return 1
  printf '%s' "$owned" | grep -Fxq -- "$1"
}

is_allowlisted() {
  case "$1" in
    deepseek-delegate|deepseek-mcp|dsh-mcp) return 0 ;;
  esac
  return 1
}

# Front-matter "name:" value of <dir>/SKILL.md, using shell built-ins only.
front_matter_name() {
  local file="$1/SKILL.md"
  local first='1'
  local inside='0'
  local name=''
  local line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [ "$first" = 1 ]; then
      [ "$line" = '---' ] || return 0
      first='0'
      inside='1'
      continue
    fi
    [ "$inside" = 1 ] || break
    [ "$line" = '---' ] && break
    case "$line" in
      name:*)
        name="${line#name:}"
        name="${name#"${name%%[![:space:]]*}"}"
        name="${name%"${name##*[![:space:]]}"}"
        name="${name#\"}"; name="${name%\"}"
        name="${name#\'}"; name="${name%\'}"
        ;;
    esac
  done < "$file"
  printf '%s' "$name"
}

is_bridge_package() {
  local dir="$1"
  local file
  if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then return 1; fi
  file="$dir/package.json"
  [ -f "$file" ] || return 1
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"dpsk-bridge"' "$file"
}

# A launcher is ours when it is a symlink into a dpsk-bridge bin/dsb.mjs or
# bin/dsv.mjs file, or when its text mentions that path.
is_our_shim() {
  local file="$1"
  local target root text
  if [ -L "$file" ]; then
    target="$(readlink "$file" 2>/dev/null || true)"
    [ -n "$target" ] || return 1
    case "$target" in
      /*) ;;
      *) target="$(dirname "$file")/$target" ;;
    esac
    case "$target" in
      */bin/ds[bv].mjs)
        root="$(cd "$(dirname "$target")/.." 2>/dev/null && pwd || true)"
        if [ -n "$root" ] && is_bridge_package "$root"; then return 0; fi
        ;;
    esac
    case "$target" in
      *dpsk-bridge/bin/ds[bv].mjs) return 0 ;;
    esac
    return 1
  fi
  [ -f "$file" ] || return 1
  text="$(cat -- "$file" 2>/dev/null || true)"
  case "$text" in
    *dpsk-bridge/bin/ds[bv].mjs*|*dpsk-bridge\\bin\\ds[bv].mjs*) return 0 ;;
  esac
  return 1
}

backup_skill() {
  local source="$1"
  local label="$2"
  local suffix destination
  mkdir -p "$backup_dir"
  backup_serial=$((backup_serial + 1))
  suffix="$(date '+%Y%m%d-%H%M%S')-$$-$RANDOM-$backup_serial"
  destination="$backup_dir/$(printf '%s' "$label" | sed 's#[/\\:~]#_#g').$suffix.bak"
  cp -R "$source" "$destination"
  printf '%s' "$destination"
}

# ---------------------------------------------------------------------------
# Skill folders
# ---------------------------------------------------------------------------

clean_skill_dir() {
  local base="$1"
  local label="$2"
  local entry name confirmed destination
  if [ ! -d "$base" ]; then
    step_warn "No $label skills directory; nothing to clean" "$base"
    return 0
  fi
  for entry in "$base"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="${entry##*/}"
    if [ -L "$entry" ]; then
      step_warn "Kept $label skill $name" 'symbolic link, not a managed skill folder'
      kept=$((kept + 1))
      continue
    fi
    if [ ! -d "$entry" ]; then
      step_warn "Kept $label item $name" 'not a skill folder'
      kept=$((kept + 1))
      continue
    fi
    confirmed='0'
    if is_owned "$name"; then
      confirmed='1'
    elif is_allowlisted "$name"; then
      if [ "$(front_matter_name "$entry")" = "$name" ]; then confirmed='1'; fi
    fi
    if [ "$confirmed" = 1 ]; then
      destination="$(backup_skill "$entry" "cleanup-$label-$name")"
      rm -rf -- "$entry"
      step_ok "Removed $label skill $name" "backup: $destination"
      removed=$((removed + 1))
    else
      if is_allowlisted "$name"; then
        step_warn "Kept $label skill $name" 'SKILL.md name does not match the folder'
      else
        step_warn "Kept $label skill $name" 'not listed in a dpsk-bridge manifest'
      fi
      kept=$((kept + 1))
    fi
  done
}

load_manifests
clean_skill_dir "$HOME/.claude/skills" 'Claude'
clean_skill_dir "$HOME/.agents/skills" 'Codex'

# ---------------------------------------------------------------------------
# Launchers
# ---------------------------------------------------------------------------

npm_prefix="${npm_config_prefix:-${NPM_CONFIG_PREFIX:-}}"
if [ -z "$npm_prefix" ] && command -v npm >/dev/null 2>&1; then
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
fi

# When npm owns the global package, let npm remove the package and its
# launchers together. If npm is unavailable the confirmed launcher files below
# are still removed.
if [ -n "$npm_prefix" ] && is_bridge_package "$npm_prefix/node_modules/dpsk-bridge"; then
  if command -v npm >/dev/null 2>&1; then
    npm uninstall -g dpsk-bridge --ignore-scripts --no-fund --no-audit >/dev/null 2>&1 || true
    if is_bridge_package "$npm_prefix/node_modules/dpsk-bridge"; then
      npm unlink -g dpsk-bridge --ignore-scripts --no-fund --no-audit >/dev/null 2>&1 || true
    fi
    if ! is_bridge_package "$npm_prefix/node_modules/dpsk-bridge"; then
      step_ok 'Removed the npm global dpsk-bridge package' "$npm_prefix"
      removed=$((removed + 1))
    fi
  fi
fi

mark_handled() { handled="$handled$1"$'\n'; }

was_handled() {
  [ -n "$handled" ] || return 1
  printf '%s' "$handled" | grep -Fxq -- "$1"
}

scan_shim() {
  local file="$1"
  if [ ! -e "$file" ] && [ ! -L "$file" ]; then return 0; fi
  if [ -d "$file" ] && [ ! -L "$file" ]; then return 0; fi
  if was_handled "$file"; then return 0; fi
  mark_handled "$file"
  if is_our_shim "$file"; then
    rm -f -- "$file"
    step_ok "Removed launcher ${file##*/}" "$file"
    removed=$((removed + 1))
  else
    step_warn "Kept launcher ${file##*/}" "not a dpsk-bridge launcher: $file"
    kept=$((kept + 1))
  fi
}

launcher_found='0'
for name in dsb dsv; do
  path_shims="$(type -aP "$name" 2>/dev/null || true)"
  if [ -n "$path_shims" ]; then
    while IFS= read -r found; do
      [ -n "$found" ] || continue
      launcher_found='1'
      scan_shim "$found"
    done <<< "$path_shims"
  fi
  if [ -n "$npm_prefix" ]; then
    if [ -e "$npm_prefix/bin/$name" ] || [ -L "$npm_prefix/bin/$name" ]; then
      launcher_found='1'
      scan_shim "$npm_prefix/bin/$name"
    fi
  fi
done
if [ "$launcher_found" = 0 ]; then
  step_warn 'No dsb or dsv launcher found on PATH or in the npm prefix'
fi

# ---------------------------------------------------------------------------
# Install records
# ---------------------------------------------------------------------------

# Without these, the next installer run would find the old install again
# instead of starting fresh. Records for "other" harnesses stay.
for file in install.json installed-skills.txt installed-skills.host.json \
  installed-skills-codex.txt installed-skills-codex.host.json; do
  if [ -f "$state_dir/$file" ]; then
    rm -f -- "$state_dir/$file"
    step_ok "Removed install record $file"
    removed=$((removed + 1))
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

printf '\n'
if [ "$removed" -eq 0 ]; then
  step_warn 'Nothing was removed'
else
  step_ok "Removed $removed item(s)"
fi
if [ "$kept" -gt 0 ]; then
  step_warn "Kept $kept item(s); the reasons are listed above"
fi
step_warn 'Left the rest of ~/.dpsk-bridge, dsh and ~/.dsh in place'
printf '\n'
printf 'Next: install dpsk-bridge:\n'
printf '  %s\n' "$install_command"
