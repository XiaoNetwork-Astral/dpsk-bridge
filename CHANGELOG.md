# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
- Installation moves to `installer.ps1` / `installer.sh`; installs made without Git must be removed with the cleanup script first. The `Generic` host preset is now called `other`.

### Added

- One-line installers for every platform: `installer.ps1` (Windows) and `installer.sh` (Linux and macOS), published as release assets. With no arguments they install into every detected harness (Claude from `~/.claude`, Codex from `~/.agents` or `~/.codex`) and upgrade an existing install; `install [claude|codex|other <SKILLS_DIR>]` and `uninstall [...]` pick one harness.
- Cleanup scripts `cleanup.ps1` / `cleanup.sh` remove the `dsb` and `dsv` launchers, this project's skills (backed up first), and the install records, for old or broken installs.
- Short aliases `-C`, `-b`, `-f`, `-m`, `-a`, `-r`, `-t`, `-p`, `-i`, `-s`, and `-u`, plus `--name=value` syntax.
- Renamed options now point to their replacement instead of failing with a generic unknown-option error.
- A cap of 3 answered questions per job and 1 rework per task. `--user-ok` lifts the cap after the user agrees.
- `dsb retry --resume` retries work interrupted by a timeout or an unanswered question without counting as a rework.
- A context reminder: `--context-limit`, `DPSK_CONTEXT_LIMIT`, default 200000 tokens.
- A `request_cancelled` event when a pending question is withdrawn while the job runs.
- dsv follows new output once the transcript is scrolled to the bottom, and stops when you scroll up.

### Changed

- Questions and permission requests now use dsh's native SDK requests (`user-question/ask`, `approval/request`) instead of the bridge's host plugin and file mailbox.
- All install logic lives in one Node script, `scripts/installer-core.mjs`, so Windows, Linux, and macOS behave the same; skill sync after `dsv update` now works on Linux and macOS too. Upgrades wait for running bridge jobs like `dsv update`, and a 0.4.x Git install is upgraded in place.
- Host presets are defined once in `scripts/host-presets.json`, and the minimum dsh version once in `package.json` (`dshVersion`).
- The `RESULT:` line is read from the first 10 lines of dsh's final reply.
- The usage reference is merged into `README.md` / `README.zh.md`.
- Sources are formatted with Prettier, checked in CI.

### Fixed

- Reused process IDs no longer keep dead jobs running: liveness also checks the heartbeat.
- The scheduler releases the reservation of a job whose launcher and dsh process are both gone, so overlapping jobs no longer wait for `dsb unlock`.
- `dsb unlock --confirm-stopped` proceeds past a leftover child process with a warning.
- dsv shows the same tool-call count in every view and notes merged plan updates.
- Earlier in this release cycle: a scheduler ticket race, answers lost on cleanup errors, skill sync leaving removed files behind, dsv read errors, and split escape sequences.

### Removed

- The experimental `--notify-cmd` option.
- `install.cmd`, `scripts/install.ps1`, and `docs/usage.md`.

Earlier versions are recorded in the Git history.
