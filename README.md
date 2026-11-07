# dpsk-bridge

English | [中文](README.zh.md)

`dpsk-bridge` lets a host agent (such as Claude Code, Codex, or another local coding assistant) delegate well-bounded subtasks to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to run in the background, while the host keeps working on other things

## Developer preview

Upstream `dsh` is still a developer preview, and versions may introduce breaking changes; see the [changelog](CHANGELOG.md)

The installer requires **Node.js 24.9+**, **npm**, and **Git**. Running a job does not require a Git repository: Git only sets the workspace root (the repository root when there is one, otherwise the working directory) and whether `dsb run` can record its `git status` inventory for review. This project reads v4 session logs only

## Install

Run the following command to install the project into every supported harness:

**Linux / macOS:**

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

## Uninstall

Run the following command to uninstall the project from every supported harness:

**Linux / macOS:**

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | bash -s -- uninstall
```

**Windows (PowerShell):**

```powershell
& ([scriptblock]::Create((irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1))) uninstall
```

## Cleanup (for special cases only)

The cleanup script finds and removes `dsb` and `dsv` automatically, and deletes this project's skills from the supported harness directories:

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/cleanup.sh | bash
```

```powershell
irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/cleanup.ps1 | iex
```

## Usage

In normal use, the host agent calls `dsb` automatically through the bundled skills to delegate work:

- [deepseek-delegate](skill/deepseek-delegate/SKILL.md): how to write a task brief, wait for progress, answer questions and approvals, and accept the result
- [deepseek-mcp](skill/deepseek-mcp/SKILL.md): how to install and reuse MCP patches

### Command-line workflow (`dsb`)

For manual debugging or integration into a custom agent, the basic flow is:

```bash
dsb run --cwd <PROJECT_DIR> --brief brief.md   # start a background session; the first line prints the job ID
dsb wait <ID> --timeout 600                    # block until local state changes (no model tokens used)
dsb answer <ID> --request <REQ_ID> --answer answer.json  # answer a question or permission request
dsb result <ID>                                # read the final report
dsb review <ID> --verdict accepted --note "npm test passes" # record the acceptance result
dsb stats [--all]                              # summarize this session's jobs (--all: every session's)
dsb adopt <ID> [--user-ok]                     # take over a job another session started
```

Each job belongs to the host session that started it, because every workspace shares one `DSH_HOME`. Commands that change a job (`cancel`, `unlock`, `send`, `answer`, `retry`, `review`) refuse a job another session started; `status`, `result`, `events`, and `wait` still read it. If the owner is gone, inspect the job and run `dsb adopt <ID>`; `dsb adopt <ID> --user-ok` is only for a job whose owner is still running, after the user has decided. Adopting changes the owner, not the job's state, so check the state first. The owner is derived from the process tree, or set explicitly with `DPSK_OWNER`; like `--scope`, this is cooperative, not a sandbox, and anything that can read `DSH_HOME` can still reach every job record

For every option, the JSON formats, and short aliases, see `dsb <command> --help`

### Session viewer (`dsv`)

`dsv` provides a full-screen terminal interface for watching and replaying session logs:

```bash
dsv ls [N]             # list recent sessions
dsv show [ID|latest]   # show a session's result
dsv watch [ID]         # follow a running session live
dsv update             # check for and install updates
```

Press `?` in the viewer for the key bindings (common ones: `d` switches between the short and full view, `u` installs an update, `q` quits)

`dsv` shows every session, because it is the human's view, and marks each session's owner; press `o` to filter the list to one owner

### Common environment variables

Command-line options take precedence over environment variables, and `dsb retry` reuses the original job's settings by default:

| Variable                   | Description                                         | Default             |
| -------------------------- | --------------------------------------------------- | ------------------- |
| `DPSK_PROVIDER`            | Model provider route                                | `deepseek-official` |
| `DPSK_MODEL`               | Model name                                          | `deepseek-flash`    |
| `DPSK_CONCURRENCY`         | Shared concurrent job limit (1–256)                 | `8`                 |
| `DPSK_START_CONCURRENCY`   | Jobs that may start at once (1–64); smallest wins   | `1`                 |
| `DPSK_INITIALIZE_TIMEOUT`  | dsh startup budget (ms), plus 60000 per `--patch`   | `120000`            |
| `DPSK_PROMPT_TIMEOUT`      | Session creation budget (ms)                        | `90000`             |
| `DPSK_OWNER`               | Explicit host session id instead of process lookup  | derived             |
| `DPSK_CONTEXT_LIMIT`       | Context reminder threshold (tokens)                 | `200000`            |
| `DSH_HOME`                 | `dsh` home directory (jobs in `$DSH_HOME/bridge`)   | `~/.dsh`            |

Jobs take turns starting: one starts at a time by default, and they run concurrently once up. `DPSK_START_CONCURRENCY` changes how many may start at once; the smallest value among participating launchers applies, like `DPSK_CONCURRENCY`. A timeout names the phase that stalled, so raise `DPSK_INITIALIZE_TIMEOUT` or `DPSK_PROMPT_TIMEOUT` only when that extra time is expected. Waiting costs a job nothing: `--time-limit` is counted from the moment the job starts, not from when it was queued, and `dsb status` reports both `startedAt` (queued) and `runningAt` (started)

## License

Copyright (C) 2026 AAAA9731 & BlueFunny, released under the [LGPL-2.1](LICENSE) license

This project is not affiliated with Anthropic, OpenAI, or DeepSeek
