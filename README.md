# dpsk-bridge

English | [中文](README.zh.md)

dpsk-bridge lets a host agent hand a bounded task to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) and keep working while it runs. A host agent is any coding agent that can run local commands — Claude Code, Codex, or your own: it writes the brief, answers questions and approvals, and accepts the result, while dsh does the work in its own SDK session. The package provides the task bridge `dsb`, the session viewer `dsv`, and the `deepseek-delegate` and `deepseek-mcp` skills; it is not an MCP server and is not tied to one host or model.

## How it works

1. The host agent writes a brief: the goal, what is already decided, and how to check the result.
2. `dsb run --brief <FILE>` starts a dsh SDK session for the job and stays attached.
3. dsh sends questions and permission requests back over the same SDK connection.
4. The host answers with `dsb answer` and waits with `dsb wait`.
5. At the end the host reads `dsb result` and records acceptance with `dsb review`.

`dsb wait` only reads local files, so waiting costs no model tokens; only `run` and `retry` call the model.

## Requirements

- Node.js 24.9 or newer, npm, and Git.
- The installer installs `dsh` when it is missing and upgrades it when it is older than the minimum in `package.json` (`dshVersion`, currently 0.2.2-alpha.3); newer versions are kept.
- dsh is a developer preview, so expect breaking changes; the [changelog](CHANGELOG.md) records them. The bridge reads v4 session logs and is tested on Windows and Linux.

## Install

Windows (PowerShell):

```powershell
irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

Linux and macOS:

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | bash
```

With no target and no host installed yet, the installer detects Claude from `~/.claude` and Codex from `~/.agents` or `~/.codex`. Choose hosts explicitly with the comma-separated `DPSK_TARGET`; for any other host use `Generic` and an absolute `DPSK_SKILLS_DIR`:

```powershell
$env:DPSK_TARGET = 'Claude,Codex'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
$env:DPSK_TARGET = 'Generic'; $env:DPSK_SKILLS_DIR = 'C:\agent\skills'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_TARGET=Claude,Codex bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_TARGET=Generic DPSK_SKILLS_DIR=/agent/skills bash
```

The one-liners choose hosts with environment variables. From a clone, pass arguments to the script instead:

```powershell
.\installer.ps1 -Target Claude
```

```bash
./installer.sh install --target Claude
```

The installer installs the locked dependencies, installs or upgrades `dsh`, syncs the skills into each host, and links `dsb` and `dsv` globally. With no checkout it clones the latest release into `~/.dpsk-bridge/app`; override that with `DPSK_INSTALL_DIR`, `-InstallDir` on Windows, or `--install-dir` on Linux/macOS. Keep the checkout in place and reopen the host session so it loads the skills.

## Upgrade

Run the installer with the upgrade action. Piped:

```powershell
$env:DPSK_ACTION = 'upgrade'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_ACTION=upgrade bash
```

From a clone:

```powershell
.\installer.ps1 -Action upgrade
```

```bash
./installer.sh upgrade
```

The upgrade fast-forwards the checkout to the latest GitHub Release and reinstalls; it also upgrades `dsh` when needed. It needs the official checkout with no local changes. For later releases, `dsv update` updates from the terminal, and `u` in the viewer installs an available update.

Coming from 0.4.x: run the upgrade one-liner above once. It finds your existing checkout through the `dsb`/`dsv` link, fast-forwards it in place, upgrades `dsh`, and resyncs the skills; your hosts and skill backups carry over. Command options were renamed in 0.5.0; the [changelog](CHANGELOG.md) lists the replacements.

## Uninstall

Remove one host, or every host and the shared commands.

```powershell
$env:DPSK_ACTION = 'uninstall'; $env:DPSK_TARGET = 'Claude'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
$env:DPSK_ACTION = 'uninstall'; $env:DPSK_UNINSTALL_ALL = '1'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_ACTION=uninstall DPSK_TARGET=Claude bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_ACTION=uninstall DPSK_UNINSTALL_ALL=1 bash
```

From a clone, use `.\installer.ps1 -Action uninstall -Target Claude`, `.\installer.ps1 -Action uninstall -All`, `./installer.sh uninstall --target Claude`, or `./installer.sh uninstall --all`. Removing the last host also removes the `dsb`/`dsv` links and the install record; while another host remains, the links and record are kept.

Uninstall removes only the skills that dpsk-bridge installed and backs them up under `~/.dpsk-bridge/backups/`. `dsh`, credentials, MCP patches, job history, and state files are kept. The checkout is kept too: delete `~/.dpsk-bridge/app` (or the directory you cloned into) when you no longer need it.

## Using dsb

A minimal brief:

```markdown
# Task

Add a JSON output option to `src/report.mjs` and a test for it.
Do not change the default output.
Done when `npm test` passes.
```

Start `run` in the background, then wait, answer if asked, read the result, and record acceptance:

```text
dsb run --cwd <PROJECT_DIR> --brief brief.md
dsb wait <ID> --timeout 600
dsb status <ID>
dsb answer <ID> --request <REQUEST_ID> --answer answer.json
dsb result <ID>
dsb review <ID> --verdict accepted --note "npm test passes"
```

`dsb run` prints the job ID on its first line and stays attached until the job ends. Put it in the background and use `dsb wait` instead of polling. `dsb status` shows the process state, acceptance, and pending requests; `dsb events` pages the event log. Every command prints JSON objects, one per line (help and version excepted), and errors are `{"error":"..."}` with exit code 1. `dsb run` and `dsb retry` exit 0 only when the job completed and its report says `RESULT: OK`.

### Waiting

`dsb wait <ID>` returns one JSON object with a `reason`, the job state fields, and `actionableRequests`.

| `reason` | Meaning | What to do |
|---|---|---|
| `finished` | The job reached a terminal state, including `cleanup_failed`. | Read `dsb result` and review. |
| `request` | A question or approval is waiting. | Answer the requests whose IDs are in `actionableRequests`; `pendingRequests` has the details. |
| `escalate` | Only questions remain and the 3-question cap is reached. | Tell the user; after they agree, answer with `--user-ok`. |
| `context` | Context reached the reminder threshold; returned once per job. | Check progress, narrow the work with `dsb send`, or cancel with `dsb cancel`. |
| `timeout` | The wait timed out; the job is still running or queued. | Wait again. |
| `unknown` | The launcher is gone or its heartbeat is stale. | Check `dsb status` and the process before using `dsb unlock`. |

### Answering questions and approvals

Answer every question exactly once; `selected` is a string array (empty for free text), and `custom` is optional:

```json
{"answers":[{"id":"question-id","selected":["Option A"],"custom":"extra context"}]}
```

An approval answer is one of three outcomes:

```json
{"outcome":"allowed-once"}
```

Use `{"outcome":"rejected"}` or `{"outcome":"cancelled"}` instead when that is the decision. The bridge forwards answers as given; `dsb` never grants permissions on its own.

### Limits

- A job can have at most 3 questions answered. A fourth answer is refused; `dsb wait` returns `escalate`. After the user agrees to continue, rerun `dsb answer` with `--user-ok`, which lifts the cap for that job. Approvals do not count.
- A task can be reworked once. A second `dsb retry` is refused unless the user agrees and you pass `--user-ok`. If work was interrupted by a timeout or an unanswered question, `dsb retry --resume` retries it without counting as a rework.
- The context reminder fires once when the context reaches 200000 tokens. Change it with `dsb run --context-limit <TOKENS>` or `DPSK_CONTEXT_LIMIT`; `retry` keeps the original job's value.

### Concurrency and scopes

Up to 8 jobs run at once by default; launchers sharing one `DSH_HOME` share the limit, and the effective value is the smallest configured one. Set it with `--concurrency` or `DPSK_CONCURRENCY` (1–256); `retry` keeps the original value.

`--scope` is a repeatable, workspace-relative write range. Overlapping or parent/child ranges queue; disjoint ranges can run together. It is a cooperative convention, not a sandbox. `--read-only` marks a task that changes nothing and lets read-only tasks run together; it conflicts with an overlapping writer unless you give it a disjoint `--scope`. `--resource` takes a named lock across workspaces, for a shared editor, service, or MCP instance.

### Environment variables

| Variable | Use | Default |
|---|---|---|
| `DPSK_PROVIDER` | Model route for `dsb run` | `deepseek-official` |
| `DPSK_MODEL` | Model name for `dsb run` | `deepseek-flash` |
| `DPSK_CONCURRENCY` | Concurrent job limit shared by launchers | `8` |
| `DPSK_CONTEXT_LIMIT` | Context reminder threshold in tokens | `200000` |
| `DSH_HOME` | dsh home; bridge jobs live in `$DSH_HOME/bridge` | `~/.dsh` |

Command-line options win over the corresponding `DPSK_*` variables, and `dsb retry` reuses the original job's values. Run `dsb <command> --help` for every option, default, and short alias (for example `-C`, `-b`, `-t`).

The detailed delegation workflow lives in the skills: [deepseek-delegate](skill/deepseek-delegate/SKILL.md) covers writing briefs, waiting, answering, and review; [deepseek-mcp](skill/deepseek-mcp/SKILL.md) covers installing and reusing MCP patches.

## dsv

`dsv` reads the same session logs in a full-screen viewer. `dsv ls [N]` lists recent sessions, `dsv show [ID|latest]` shows a session with the result first, `dsv watch [ID]` follows a live session, and `dsv update` installs a release. Without a terminal, plain `dsv` prints the list.

Press `?` for every key. Three worth knowing: `d` switches between the reading view and the full process, `u` installs an available update, and `q` quits.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The job stays `queued`. | Check the concurrency limit, overlapping `--scope` ranges, and holders of the same `--resource`. Queued time counts toward `--time-limit`. |
| `dsb wait` returns `unknown`, or the job is `cleanup_failed`. | Check the process and any partial changes. Once the old task and its children have stopped, release the reservation with `dsb unlock <ID> --confirm-stopped`. A `cleanup_failed` job cannot be retried or accepted; start a new `dsb run`. |
| `reportedResult` is `UNKNOWN`. | The final reply had no `RESULT: OK`, `RESULT: FAIL`, or `RESULT: BLOCKED` line in its first 10 lines. Read `report.txt` and record the verdict you actually verified. |
| dsh is missing or too old. | Run the installer's upgrade; it installs the minimum version from `package.json`. For a custom build, point `dsb run --dsh-entry` at its `lib/bin.js`. |
| `dsb` is not on PATH. | Open a new terminal. If it persists, add npm's global bin directory to PATH; the installer prints the directory. |

## Development

```text
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` syntax-checks the sources; `npm test` runs the full suite. The real-dsh integration test is skipped unless `DPSK_REAL_DSH_ENTRY` points at a dsh `lib/bin.js`:

```powershell
$env:DPSK_REAL_DSH_ENTRY = "C:\path\to\node_modules\@deepseek-ai\dsh\lib\bin.js"
node --test test/real-dsh.test.mjs
```

```bash
DPSK_REAL_DSH_ENTRY=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node --test test/real-dsh.test.mjs
```

Releasing means pushing a stable `v<version>` tag that matches `package.json`. The release workflow tests, packs, and publishes the tarball, `installer.ps1`, `installer.sh`, and checksums as release assets.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

Copyright (C) 2026 AAAA9731. Released under [LGPL-2.1](LICENSE). Not affiliated with Anthropic, OpenAI, or DeepSeek.
