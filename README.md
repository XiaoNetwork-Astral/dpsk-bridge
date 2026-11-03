# dpsk-bridge

English | [中文](README.zh.md)

`dpsk-bridge` lets a host agent (such as Claude Code, Codex, or another local coding assistant) delegate well-bounded subtasks to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to run in the background, while the host keeps working on other things

## Developer preview

Upstream `dsh` is still a developer preview, and versions may introduce breaking changes; see the [changelog](CHANGELOG.md)

This project requires **Node.js 24.9+**, **npm**, and **Git**, and reads v4 session logs only

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
```

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

### Common environment variables

Command-line options take precedence over environment variables, and `dsb retry` reuses the original job's settings by default:

| Variable             | Description                                       | Default             |
| -------------------- | ------------------------------------------------- | ------------------- |
| `DPSK_PROVIDER`      | Model provider route                              | `deepseek-official` |
| `DPSK_MODEL`         | Model name                                        | `deepseek-flash`    |
| `DPSK_CONCURRENCY`   | Shared concurrent job limit (1–256)               | `8`                 |
| `DPSK_CONTEXT_LIMIT` | Context reminder threshold (tokens)               | `200000`            |
| `DSH_HOME`           | `dsh` home directory (jobs in `$DSH_HOME/bridge`) | `~/.dsh`            |

## License

Copyright (C) 2026 AAAA9731 & BlueFunny, released under the [LGPL-2.1](LICENSE) license

This project is not affiliated with Anthropic, OpenAI, or DeepSeek
