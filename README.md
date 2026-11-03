# dpsk-bridge

English | [中文](README.zh.md)

dpsk-bridge lets a host agent delegate bounded tasks to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) and keep working while they run. A host agent is any coding agent that can run local commands — Claude Code, Codex, or your own; it writes the brief, answers questions during the run, and accepts the result, while dsh does the work in its own SDK session. The package ships the task bridge `dsb`, the session viewer `dsv`, and two skills, `deepseek-delegate` and `deepseek-mcp`, and it is not an MCP server or tied to one host or one model.

## How it works

1. The host agent writes a brief: the goal, what is already decided, and how to check the result.
2. `dsb run --brief <FILE>` starts a dsh SDK session for that job and stays attached.
3. dsh asks questions or requests permissions back over the same SDK connection.
4. The host answers with `dsb answer` and waits with `dsb wait`.
5. At the end it reads `dsb result` and records acceptance with `dsb review`.

`dsb wait` only reads local files, so waiting costs no model tokens. Only `run` and `retry` call the model.

## Status and requirements

dpsk-bridge tracks the dsh developer preview and moves fast. It requires dsh 0.2.2-alpha.3 or newer and Node.js 24.9 or newer, reads v4 session logs only, and is tested on Windows and Linux. Expect breaking changes between versions; the [changelog](CHANGELOG.md) records them.

## Install

The install script targets Windows PowerShell. The core CLI is tested on Windows and Linux.

```powershell
git clone https://github.com/XiaoNetwork-Astral/dpsk-bridge.git
cd dpsk-bridge
.\scripts\install.ps1 -Target Claude    # or Codex, or Generic -SkillsDir <DIR>
```

The script installs the locked dependencies, installs or upgrades dsh when needed, syncs the skills into that host, and links the `dsb` and `dsv` commands. Run it once per host you use. Do not move the checkout afterwards, and reopen the host session so it picks up the skills. See the [usage reference](docs/usage.md) for updating and uninstalling.

Without PowerShell, install dsh with `npm install -g @deepseek-ai/dsh@0.2.2-alpha.3`, run `npm ci --ignore-scripts && npm link`, and copy `skill/deepseek-delegate` and `skill/deepseek-mcp` to wherever your host loads skills from.

## Quick start

Write a minimal brief:

```markdown
# Task

Add a JSON output option to `src/report.mjs` and a test for it.
Do not change the default output.
Done when `npm test` passes.
```

Then start the job in the background, wait for it, and answer if it asks:

```text
dsb run --cwd <PROJECT_DIR> --brief brief.md
dsb wait <ID> --timeout 600
dsb answer <ID> --request <REQUEST_ID> --answer answer.json
dsb result <ID>
```

The first line `dsb run` prints carries the job ID. Put `run` in the background and use `dsb wait` instead of polling. Every command prints one JSON object per line, and `dsb <command> --help` shows all options, including short aliases such as `-C` and `-b`.

## Using it from a host agent

Install the skills for your host once; after that the host can dispatch work on its own.

- `deepseek-delegate`, at `~/.claude/skills/deepseek-delegate` for Claude, `~/.agents/skills/deepseek-delegate` for Codex, or `<DIR>/deepseek-delegate` for Generic: when to delegate, what the brief must settle, how to wait, answer, and review.
- `deepseek-mcp`, in the same directory: installing, importing, verifying, and reusing MCP patches for dsh.

## dsv

`dsv` reads the same session logs in a full-screen viewer: sessions on the left, transcript on the right, all keys on `?`. Use `dsv ls` for recent sessions, `dsv show latest` for the newest result, `dsv watch` to follow a live one, and `dsv update` to install a release.

## Documentation

- [Usage reference](docs/usage.md) (Chinese): every command and option, waiting, concurrency and scopes, images, MCP patches, the dsv keyboard, updates.
- [deepseek-delegate skill](skill/deepseek-delegate/SKILL.md) and [deepseek-mcp skill](skill/deepseek-mcp/SKILL.md).

## Development

```text
npm ci --ignore-scripts
npm run check
npm test
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

Copyright (C) 2026 AAAA9731. Released under [LGPL-2.1](LICENSE). Not affiliated with Anthropic, OpenAI, or DeepSeek.
