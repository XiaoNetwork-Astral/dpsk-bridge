# dpsk-bridge

English | [中文](README.zh.md)

dpsk-bridge lets a coding agent that can run local commands (Claude Code, Codex, or any other agent) delegate tasks to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) and exchange questions, answers, and follow-ups while the task runs.

It ships the task bridge `dsb`, the session viewer `dsv`, and two skills. It is not an MCP server.

## Status

dpsk-bridge tracks the dsh developer preview and moves quickly. It requires dsh ≥ 0.2.2-alpha.3 and reads v4 session logs only. Expect breaking changes between versions.

## Install

Requires Node.js ≥ 24.9, Git, and npm. The install script targets Windows PowerShell; the core CLI is tested on Windows and Linux.

```powershell
git clone https://github.com/XiaoNetwork-Astral/dpsk-bridge.git
cd dpsk-bridge
.\scripts\install.ps1 -Target Claude   # or Codex, or Generic -SkillsDir <DIR>
```

The script installs dependencies and dsh, syncs the skills, and links the `dsb`/`dsv` commands. Do not move the directory afterwards, and reopen your host session.

Without PowerShell, install dsh with `npm install -g @deepseek-ai/dsh@0.2.2-alpha.3`, then run `npm ci --ignore-scripts && npm link`, and copy the two folders under `skill/` to wherever your host loads skills from.

## Usage

### Delegate a task: dsb

```text
dsb run --cwd <PROJECT> --brief brief.md    # stays attached until the job ends
dsb wait <JOB_ID>                           # returns on finish, request, or timeout
dsb events <JOB_ID> --after <CURSOR>        # read new progress and questions
dsb answer <JOB_ID> --request <ID> --answer reply.json
dsb review <JOB_ID> --verdict accepted --note "evidence"
```

Start `run` in the background and wait with `dsb wait` instead of polling: `wait` only reads local files and never calls the model. Only `run` and `retry` call the model. Every command prints one JSON object per line. See `dsb --help` and `dsb <COMMAND> --help` for all options.

### Read sessions: dsv

```text
dsv                     full-screen viewer
dsv ls                  recent sessions
dsv show latest         result of the latest session
dsv update              check for and install a release
```

The viewer lists sessions on the left, split into running and finished (by day), and shows the transcript on the right. Everything works from the keyboard; press `?` for all keys.

## Documentation

- [Usage reference](docs/usage.md) (Chinese): waiting, concurrency and scopes, images, experimental features, dsv keys, auto-update, releases
- [deepseek-delegate skill](skill/deepseek-delegate/SKILL.md): how a host should dispatch, wait, and review

## Development

```text
npm ci --ignore-scripts
npm run check
npm test
```

## License

Copyright (C) 2026 AAAA9731. Released under [LGPL-2.1](LICENSE). Not affiliated with Anthropic, OpenAI, or DeepSeek.
