# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Jobs belong to the host session that started them. Commands that change a job (`cancel`, `unlock`, `send`, `answer`, `retry`, `review`) refuse a job another session started, while `status`, `result`, `events`, and `wait` still read it, so an abandoned job can be inspected before it is taken over. `dsb adopt <ID>` takes over a job whose owner is gone, and `dsb adopt <ID> --user-ok` one whose owner is still running. `dsb stats` now counts only this session's jobs, with `dsb stats --all` for every session's. Jobs recorded before this have no owner and stay operable by any session.
- The owner is derived from the process tree: dsb walks up past shells and past the Node processes that only run dsb itself or a package manager, so a host that is a Node program, such as Codex, is recognized by the script it runs rather than mistaken for a wrapper. A host that can expose its own session id can set `DPSK_OWNER` instead, which is exact and skips reading the process table. Like `--scope`, this is cooperative rather than a sandbox.
- `dsv` marks the owner of each session with a stable two-character badge, dimmed and marked `×` when that session is gone, and `o` filters the list to one owner. The viewer still shows every session, because it is the human's view.
- `dsb status` reports `workspace` and `workspaceKind` (`git` or `directory`), so an agent can check how the workspace root was decided instead of guessing.

### Fixed

- Concurrent jobs no longer time out together on startup. dsh has no startup lock of its own and repeats its whole cold start in every process, so simultaneous starts multiplied the same disk, CPU, and network work until they all exceeded the request budget. Jobs now take turns starting — one at a time by default, `DPSK_START_CONCURRENCY` (1..64) to raise it — and still run concurrently once up.
- `--time-limit` no longer counts the time a job spends waiting. It previously ran from the moment the job was queued, so a job that waited behind the concurrency limit arrived with part of its budget already spent; serialized startup made that waiting routine. The limit now runs from the moment the job starts, and `dsb status` reports both `startedAt` (queued) and `runningAt` (started).
- The SDK request budgets were a hardcoded 30 seconds, which is shorter than a cold dsh start, especially with MCP patches. They are now `DPSK_INITIALIZE_TIMEOUT` (default 120000 ms, plus 60000 per `--patch`, matching the MCP handshake default) and `DPSK_PROMPT_TIMEOUT` (default 90000 ms), and a timeout now names the phase that stalled instead of only the request. The budget also covers delivery of queued follow-up messages, which used the same hardcoded value.
- Documentation no longer reads as though a Git repository were required. Neither dsb nor dsh needs one: jobs start, edit files, and run commands normally in a plain directory. Git decides only the workspace root — the repository root when there is one, the working directory otherwise — and whether the `git status` inventory around a run can be recorded. The skill now says outright that an agent must not run `git init` in a user's workspace in order to run a job.

## [0.5.1] - 2026-11-05

### Fixed

- The `deepseek-delegate` skill no longer sends every host into a blocking foreground `dsb wait`. Hosts that can notify the agent when a command returns now run the wait in the background or through a monitor, so the agent keeps working and stays available to the user while still receiving dsh's questions during the run.

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
