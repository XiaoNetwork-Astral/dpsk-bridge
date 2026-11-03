#!/usr/bin/env bash
# dpsk-bridge installer for Linux and macOS.
#
# Piped (no arguments are possible, choose options with environment variables):
#   curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | bash
#
# From a file:
#   ./installer.sh [install|upgrade|uninstall] [--target NAME]... [--skills-dir DIR] [--all] [--install-dir DIR]
#
# The Node core in scripts/installer-core.mjs performs the actual installation.
set -eu

repo_url='https://github.com/XiaoNetwork-Astral/dpsk-bridge.git'
official_slug='XiaoNetwork-Astral/dpsk-bridge'

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
    printf '    %s→ %s%s\n' "$dim" "$2" "$reset" >&2
  fi
  exit 1
}

usage() {
  cat <<'EOF'
dpsk-bridge installer (Linux and macOS)

Usage:
  Piped (no arguments are possible, choose with environment variables):
    curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | bash
    curl -fsSL .../installer.sh | DPSK_ACTION=upgrade bash
    curl -fsSL .../installer.sh | DPSK_ACTION=uninstall DPSK_UNINSTALL_ALL=1 bash
    curl -fsSL .../installer.sh | bash -s -- uninstall --target claude

  From a file:
    ./installer.sh [install|upgrade|uninstall] [--target NAME]... [--skills-dir DIR] [--all] [--install-dir DIR]

Actions:
  install      Install or repair dpsk-bridge (default)
  upgrade      Fast-forward the checkout to the latest GitHub Release, then reinstall
  uninstall    Remove one host's skills, or everything with --all

Options:
  --target NAME        Host to install or uninstall: Claude, Codex or Generic (repeatable)
  --skills-dir DIR     Absolute skills directory, only with --target Generic
  --all                Uninstall every host, the shared commands and the install record
  --install-dir DIR    Fresh-install location [default: ~/.dpsk-bridge/app]
  -h, --help           Show this help

Environment variables (arguments override them):
  DPSK_ACTION          install, upgrade or uninstall [default: install]
  DPSK_TARGET          Comma-separated hosts, for example Claude,Codex
  DPSK_SKILLS_DIR      Absolute skills directory for Generic
  DPSK_UNINSTALL_ALL   Set to 1 to uninstall everything
  DPSK_INSTALL_DIR     Fresh-install location

The checkout is located from this script's directory, ~/.dpsk-bridge/install.json
or the global npm dpsk-bridge link. With no checkout, install clones the latest
release into ~/.dpsk-bridge/app (or --install-dir).
EOF
}

action=''
targets=''
skills_dir=''
all='0'
install_dir=''
action_set='0'
target_set='0'
skills_set='0'
all_set='0'
install_set='0'

while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|uninstall)
      if [ "$action_set" = 1 ]; then fail "Unexpected action: $1" 'Use one action: install, upgrade or uninstall'; fi
      action="$1"; action_set='1'
      ;;
    --target)
      shift
      if [ $# -eq 0 ] || [ -z "$1" ]; then fail '--target requires a host name' 'Use --target Claude, --target Codex or --target Generic'; fi
      if [ "$target_set" = 1 ]; then targets="$targets,$1"; else targets="$1"; target_set='1'; fi
      ;;
    --target=*)
      value="${1#--target=}"
      if [ -z "$value" ]; then fail '--target requires a host name' 'Use --target Claude, --target Codex or --target Generic'; fi
      if [ "$target_set" = 1 ]; then targets="$targets,$value"; else targets="$value"; target_set='1'; fi
      ;;
    --skills-dir)
      shift
      if [ $# -eq 0 ] || [ -z "$1" ]; then fail '--skills-dir requires a directory' 'Use --skills-dir <absolute-directory>'; fi
      skills_dir="$1"; skills_set='1'
      ;;
    --skills-dir=*)
      value="${1#--skills-dir=}"
      if [ -z "$value" ]; then fail '--skills-dir requires a directory' 'Use --skills-dir <absolute-directory>'; fi
      skills_dir="$value"; skills_set='1'
      ;;
    --all)
      all='1'; all_set='1'
      ;;
    --install-dir)
      shift
      if [ $# -eq 0 ] || [ -z "$1" ]; then fail '--install-dir requires a directory' 'Use --install-dir <directory>'; fi
      install_dir="$1"; install_set='1'
      ;;
    --install-dir=*)
      value="${1#--install-dir=}"
      if [ -z "$value" ]; then fail '--install-dir requires a directory' 'Use --install-dir <directory>'; fi
      install_dir="$value"; install_set='1'
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1" 'Run: bash installer.sh --help'
      ;;
  esac
  shift
done

if [ "$action_set" = 0 ]; then action="${DPSK_ACTION:-install}"; fi
if [ "$target_set" = 0 ]; then targets="${DPSK_TARGET:-}"; fi
if [ "$skills_set" = 0 ]; then skills_dir="${DPSK_SKILLS_DIR:-}"; fi
if [ "$all_set" = 0 ] && [ "${DPSK_UNINSTALL_ALL:-0}" = 1 ]; then all='1'; fi
if [ "$install_set" = 0 ]; then install_dir="${DPSK_INSTALL_DIR:-}"; fi

action="$(printf '%s' "$action" | tr '[:upper:]' '[:lower:]')"
case "$action" in
  install|upgrade|uninstall) ;;
  *) fail "Unknown action: $action" 'Use install, upgrade or uninstall; run: bash installer.sh --help' ;;
esac
if [ "$all" = 1 ] && [ "$action" != uninstall ]; then
  fail '--all / DPSK_UNINSTALL_ALL is only valid with uninstall' "Use: bash installer.sh uninstall --all"
fi

printf '%s\n' "${bold}dpsk-bridge installer${reset}"

# ---------------------------------------------------------------------------
# Fatal prerequisites, checked before anything is downloaded or changed
# ---------------------------------------------------------------------------

if ! command -v git >/dev/null 2>&1; then
  fail 'Git is required' 'Install Git from https://git-scm.com/downloads, then reopen the terminal'
fi
git_version="$(git --version 2>/dev/null | head -n 1)" || true
if [ -z "$git_version" ]; then
  fail 'Git is required but did not run' 'Reinstall Git from https://git-scm.com/downloads, then reopen the terminal'
fi
step_ok "$git_version"

if ! command -v node >/dev/null 2>&1; then
  fail 'Node.js 24.9 or newer is required' 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal'
fi
node_version="$(node --version 2>/dev/null)" || true
case "$node_version" in
  v[0-9]*) ;;
  *) fail "Cannot read the Node.js version (found: ${node_version:-nothing})" 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal' ;;
esac
node_number="${node_version#v}"
node_major="${node_number%%.*}"
node_rest="${node_number#*.}"
node_minor="${node_rest%%.*}"
case "$node_major" in ''|*[!0-9]*) fail "Cannot parse the Node.js version: $node_version" 'Install the current Node.js LTS from https://nodejs.org' ;; esac
case "$node_minor" in ''|*[!0-9]*) fail "Cannot parse the Node.js version: $node_version" 'Install the current Node.js LTS from https://nodejs.org' ;; esac
if [ "$node_major" -lt 24 ] || { [ "$node_major" -eq 24 ] && [ "$node_minor" -lt 9 ]; }; then
  fail "Node.js 24.9 or newer is required; found $node_version" 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal'
fi
step_ok "Node.js $node_version"

if ! command -v npm >/dev/null 2>&1; then
  fail 'npm is required' 'Reinstall Node.js with npm from https://nodejs.org, then reopen the terminal'
fi
npm_version="$(npm --version 2>/dev/null)" || true
if [ -z "$npm_version" ]; then
  fail 'npm is required but did not run' 'Reinstall Node.js with npm from https://nodejs.org, then reopen the terminal'
fi
step_ok "npm $npm_version"

# ---------------------------------------------------------------------------
# Checkout discovery helpers
# ---------------------------------------------------------------------------

read_bridge_name() {
  node --input-type=module -e 'import fs from "node:fs"; try { const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (pkg && pkg.name === "dpsk-bridge") process.stdout.write("1"); } catch {}' "$1" 2>/dev/null || true
}

is_bridge_checkout() {
  if [ -z "${1:-}" ] || [ ! -d "$1" ] || [ ! -f "$1/package.json" ]; then return 1; fi
  if [ "$(read_bridge_name "$1/package.json")" = 1 ]; then return 0; fi
  return 1
}

is_usable_checkout() {
  if ! is_bridge_checkout "${1:-}"; then return 1; fi
  if [ -f "$1/scripts/installer-core.mjs" ]; then return 0; fi
  return 1
}

resolve_real_path() {
  node --input-type=module -e 'import fs from "node:fs"; try { process.stdout.write(fs.realpathSync.native(process.argv[1])); } catch { process.exit(1); }' "$1" 2>/dev/null || true
}

is_stable_tag() {
  printf '%s\n' "${1:-}" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$'
}

is_official_origin() {
  case "${1:-}" in
    "https://github.com/$official_slug.git"|"https://github.com/$official_slug"|\
    "git@github.com:$official_slug.git"|"git@github.com:$official_slug"|\
    "ssh://git@github.com/$official_slug.git"|"ssh://git@github.com/$official_slug")
      return 0 ;;
  esac
  return 1
}

# Latest published release tag; the test seam wins, the GitHub API is primary
# and the remote tag list is the offline fallback.
latest_release_tag() {
  override="${DPSK_INSTALLER_UPGRADE_TAG:-}"
  if [ -n "$override" ]; then printf '%s' "$override"; return 0; fi
  release=''
  if command -v curl >/dev/null 2>&1; then
    release="$(curl -fsSL --max-time 10 -H 'User-Agent: dpsk-bridge-installer' -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$official_slug/releases/latest" 2>/dev/null || true)"
  fi
  if [ -n "$release" ]; then
    tag="$(printf '%s' "$release" | node --input-type=module -e 'let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { text += chunk; }); process.stdin.on("end", () => { try { const release = JSON.parse(text); if (release && typeof release.tag_name === "string") process.stdout.write(release.tag_name); } catch {} });' 2>/dev/null || true)"
    if is_stable_tag "$tag"; then printf '%s' "$tag"; return 0; fi
  fi
  listing="$(git ls-remote --tags --refs --sort=-version:refname "$repo_url" < /dev/null 2>/dev/null || true)"
  tag="$(printf '%s\n' "$listing" | sed -n 's#.*refs/tags/##p' | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
  printf '%s' "$tag"
}

# ---------------------------------------------------------------------------
# Locate, migrate or clone the checkout
# ---------------------------------------------------------------------------

install_record="${HOME:?HOME is not set}/.dpsk-bridge/install.json"
record_root=''
if [ -f "$install_record" ]; then
  record_root="$(node --input-type=module -e 'import fs from "node:fs"; try { const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (record && typeof record.root === "string") process.stdout.write(record.root); } catch {}' "$install_record" 2>/dev/null || true)"
fi

npm_prefix="${npm_config_prefix:-${NPM_CONFIG_PREFIX:-}}"
if [ -z "$npm_prefix" ]; then
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
fi
global_root=''
if [ -n "$npm_prefix" ]; then
  global_link="$npm_prefix/node_modules/dpsk-bridge"
  if [ -e "$global_link" ] || [ -L "$global_link" ]; then
    global_root="$(resolve_real_path "$global_link")"
  fi
fi

script_source="${BASH_SOURCE[0]:-}"
script_dir=''
if [ -n "$script_source" ] && [ -f "$script_source" ]; then
  script_dir="$(cd -P -- "$(dirname "$script_source")" && pwd)"
fi

checkout=''
legacy=''
for candidate in "$script_dir" "$record_root" "$global_root"; do
  [ -n "$candidate" ] || continue
  if is_usable_checkout "$candidate"; then checkout="$candidate"; break; fi
  if is_bridge_checkout "$candidate"; then legacy="$candidate"; break; fi
done

# A 0.4.x checkout has no Node core yet. Migration happens in place at the
# location the user chose, first fetching the latest release tag and then
# letting the merge's fast-forward check reject divergent history.
bootstrap_checkout() {
  dir="$1"
  step_warn 'Found an older dpsk-bridge checkout' "$dir"
  if ! top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)"; then
    fail "This checkout is not a Git checkout: $dir" 'Move it away, then run the installer again to install the latest release'
  fi
  top_real="$(resolve_real_path "$top")"
  dir_real="$(resolve_real_path "$dir")"
  if [ -z "$top_real" ] || [ -z "$dir_real" ] || [ "$top_real" != "$dir_real" ]; then
    fail "The dpsk-bridge checkout must be the Git root: $dir" "git -C \"$dir\" rev-parse --show-toplevel"
  fi
  if ! origins="$(git -C "$dir" config --get-all remote.origin.url 2>/dev/null)"; then
    fail "origin must point to the official $official_slug repository" "git -C \"$dir\" remote set-url origin $repo_url"
  fi
  origin_count="$(printf '%s\n' "$origins" | grep -c . || true)"
  first_origin="$(printf '%s\n' "$origins" | sed -n '1p')"
  if [ "$origin_count" != 1 ] || ! is_official_origin "$first_origin"; then
    fail "origin must point to the official $official_slug repository" "git -C \"$dir\" remote set-url origin $repo_url"
  fi
  if ! status="$(git -C "$dir" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
    fail "Cannot inspect the checkout: $dir" "git -C \"$dir\" status --short"
  fi
  if [ -n "$status" ]; then
    fail 'Checkout has local changes or untracked files; commit or move them before upgrading' "git -C \"$dir\" status --short"
  fi
  tag="$(latest_release_tag)"
  if [ -z "$tag" ]; then
    fail 'Cannot determine the latest dpsk-bridge release' 'Check network access, or update the checkout manually with git'
  fi
  if ! is_stable_tag "$tag"; then
    fail "Not a stable release tag: $tag" 'Only v<major>.<minor>.<patch> releases can be installed'
  fi
  step_ok "Latest release is $tag"
  if ! git -C "$dir" fetch --tags origin >/dev/null 2>&1 < /dev/null; then
    fail 'Cannot fetch release tags from origin' "git -C \"$dir\" fetch --tags origin"
  fi
  if ! git -C "$dir" rev-parse --verify --quiet "refs/tags/$tag^{commit}" >/dev/null; then
    fail "Release tag $tag is not available in the checkout" "git -C \"$dir\" fetch --tags origin"
  fi
  if ! git -C "$dir" merge --ff-only "refs/tags/$tag" >/dev/null 2>&1; then
    fail "Cannot fast-forward the checkout to $tag; the history may have diverged" "Inspect: git -C \"$dir\" log --oneline --graph --all"
  fi
  step_ok "Updated checkout to $tag" "$dir"
}

clone_checkout() {
  dir="$1"
  case "$dir" in
    '~') dir="$HOME" ;;
    '~/'*) dir="$HOME${dir#\~}" ;;
  esac
  case "$dir" in
    /*) ;;
    *) dir="$PWD/$dir" ;;
  esac
  tag="$(latest_release_tag)"
  if [ -z "$tag" ]; then
    fail 'Cannot determine the latest dpsk-bridge release' "Check network access, or clone manually: git clone $repo_url \"$dir\""
  fi
  if ! is_stable_tag "$tag"; then
    fail "Not a stable release tag: $tag" 'Only v<major>.<minor>.<patch> releases can be installed'
  fi
  if [ -e "$dir" ]; then
    if [ -n "$(ls -A "$dir" 2>/dev/null || true)" ]; then
      fail "Install directory is not empty: $dir" 'Choose another --install-dir or remove it'
    fi
  fi
  mkdir -p "$(dirname "$dir")"
  step_warn "Cloning dpsk-bridge $tag" "$dir"
  if ! git -c advice.detachedHead=false clone --quiet --branch "$tag" "$repo_url" "$dir" < /dev/null; then
    fail "Cannot clone dpsk-bridge into $dir" "git clone --branch $tag $repo_url \"$dir\""
  fi
  step_ok "Cloned dpsk-bridge $tag" "$dir"
  checkout="$dir"
}

if [ -n "$checkout" ]; then
  step_ok 'Using dpsk-bridge checkout' "$checkout"
elif [ -n "$legacy" ]; then
  if [ "$action" = uninstall ]; then
    fail 'This checkout predates the 0.5.0 installer core and cannot be uninstalled directly' "Run the installer's upgrade first (curl -fsSL https://github.com/$official_slug/releases/latest/download/installer.sh | DPSK_ACTION=upgrade bash), then run uninstall"
  fi
  bootstrap_checkout "$legacy"
  checkout="$legacy"
else
  if [ "$action" != install ]; then
    fail "No existing dpsk-bridge checkout was found for '$action'" "Install it first: curl -fsSL https://github.com/$official_slug/releases/latest/download/installer.sh | bash"
  fi
  if [ -n "$install_dir" ]; then
    clone_checkout "$install_dir"
  else
    clone_checkout "$HOME/.dpsk-bridge/app"
  fi
fi

core="$checkout/scripts/installer-core.mjs"
if [ ! -f "$core" ]; then
  fail "The installer core is missing: $core" 'Update the checkout to a published dpsk-bridge release and retry'
fi
step_ok 'Using installer core' "$core"

# ---------------------------------------------------------------------------
# Run the core and report its result
# ---------------------------------------------------------------------------

core_args=("$core" "$action")
if [ -n "$targets" ]; then
  old_ifs="$IFS"
  IFS=','
  set -f
  for target in $targets; do
    target="$(printf '%s' "$target" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -n "$target" ]; then core_args+=(--target "$target"); fi
  done
  set +f
  IFS="$old_ifs"
fi
if [ -n "$skills_dir" ]; then core_args+=(--skills-dir "$skills_dir"); fi
if [ "$all" = 1 ]; then core_args+=(--all); fi

set +e
node "${core_args[@]}"
core_status=$?
set -e

if [ "$core_status" -ne 0 ]; then
  printf '  %s%s%s %s\n' "$red" '✗' "$reset" "dpsk-bridge $action failed (exit $core_status)" >&2
  exit "$core_status"
fi

printf '\n'
step_ok "dpsk-bridge $action complete"
if [ "$action" = uninstall ]; then
  printf '  %sCheckout kept at %s%s\n' "$dim" "$checkout" "$reset"
else
  printf '  %sNext: dsv update keeps the checkout current; dsb --help lists job commands.%s\n' "$dim" "$reset"
fi
