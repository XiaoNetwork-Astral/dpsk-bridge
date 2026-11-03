# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- One-line installers for every platform: `installer.ps1` (Windows) and `installer.sh` (Linux and macOS), published as release assets. Each installs, upgrades, and uninstalls; piped runs take `DPSK_ACTION`, `DPSK_TARGET`, `DPSK_SKILLS_DIR`, `DPSK_UNINSTALL_ALL`, and `DPSK_INSTALL_DIR`.
- Hosts are detected automatically (Claude from `~/.claude`, Codex from `~/.agents` or `~/.codex`) when none is chosen.

### Changed

- All install logic lives in one Node script, `scripts/installer-core.mjs`, so Windows, Linux, and macOS behave the same; skill sync after `dsv update` now works on Linux and macOS too.
- Upgrading from 0.4.x upgrades the existing checkout in place; upgrades wait for running bridge jobs like `dsv update`.
- The minimum dsh version is defined once, in `package.json` (`dshVersion`).
- The usage reference is merged into `README.md` / `README.zh.md`.

### Removed

- `scripts/install.ps1`; use `installer.ps1`.
- `docs/usage.md`; see the README.

## [0.5.0] - 2026-11-03

### Breaking

- Requires `@deepseek-ai/dsh` 0.2.2-alpha.3 or newer.
- Options renamed, with an error that names the replacement when the old spelling is used:
  - `dsb run --timeout` is now `--time-limit`
  - `dsb run --max-concurrent` is now `--concurrency`
  - `dsb send --message-file` is now `--message`
  - `dsb events --after` is now `--cursor`
  - `--confirmed-stopped` is now `--confirm-stopped` (`dsb unlock`, `dsv update --recover`)
- The `input_forwarded` event and the `forwardedQuestions` field are gone. Pending questions and permission requests appear in `status.pendingRequests` instead.

### Added

- Short aliases `-C`, `-b`, `-f`, `-m`, `-a`, `-r`, `-t`, `-p`, `-i`, `-s`, and `-u`, plus `--name=value` syntax.
- Renamed options now point to their replacement instead of failing with a generic unknown-option error.
- A cap of 3 answered questions per job and 1 rework per task. `--user-ok` lifts the cap after the user agrees.
- `dsb retry --resume` retries work interrupted by a timeout or an unanswered question without counting as a rework.
- A context reminder: `--context-limit`, `DPSK_CONTEXT_LIMIT`, default 200000 tokens.
- A `request_cancelled` event when a pending question is withdrawn while the job runs.

### Changed

- Questions and permission requests now use dsh's native SDK requests (`user-question/ask`, `approval/request`) instead of the bridge's host plugin and file mailbox.
- Host presets are defined once in `scripts/host-presets.json` and shared by the installer and the skill sync.
- The `RESULT:` line is read from the first 10 lines of dsh's final reply.

### Fixed

- Reused process IDs no longer keep dead jobs running: liveness also checks the heartbeat.
- `dsb unlock --confirm-stopped` proceeds past a leftover child process with a warning.
- dsv shows the same tool-call count in every view and notes merged plan updates.
- Earlier in this release cycle: a scheduler ticket race, answers lost on cleanup errors, skill sync leaving removed files behind, dsv read errors, and split escape sequences.

### Removed

- The experimental `--notify-cmd` option.
- `install.cmd`; use `scripts/install.ps1`.

Earlier versions are recorded in the Git history.
