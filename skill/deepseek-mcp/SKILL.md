---
name: deepseek-mcp
description: Install, import, inspect, update, or remove MCP server patches for DeepSeek Harness (dsh) from any host agent with local command execution, or diagnose missing connections and invalid configuration. Reuse working patches for delegation.
---

# Managing MCP for dsh

For any host agent that can run local commands; Claude Code and Codex are examples. Requires Node.js >=24.9, `@deepseek-ai/dsh` >=0.2.2-alpha.3, and the current dpsk-bridge. Each MCP server has one patch file, `<name>-mcp.yml`, in the patch directory `$DSH_HOME/patches` (`~/.dsh/patches` when `DSH_HOME` is unset). A job loads it on demand with `dsb run --patch <file>` (repeatable; any path works). MCP servers available to the host reach dsh only through these patches; load just the servers the task needs, since each one adds tool definitions and startup time.

## Listing and reuse

The first 4 lines of a patch give its name, purpose, prerequisites, and usage. In Bash: `head -n 4 "${DSH_HOME:-$HOME/.dsh}"/patches/*-mcp.yml`; in PowerShell: `$d = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$HOME/.dsh" }; Get-ChildItem -Path "$d/patches" -Filter '*-mcp.yml' | ForEach-Object { Get-Content -LiteralPath $_.FullName -TotalCount 4 }`. Use the command for the shell you actually have. Older patches may use the tag `dsh-mcp:` on the first line or the Chinese header keys `用途` (purpose), `前提` (requires), and `用法` (usage); they mean the same.

No matching file only means nothing is configured yet. When listing, read the header lines and leave the credential environment unread. A configuration that has not changed, whose verification result exists and whose prerequisites are met, is reused as it is for every delegation.

## Installing or importing

1. Determine the launch method and dependencies from the user's existing configuration or the server's official instructions. Import the requested server alone, leaving the rest of the client configuration where it is.
2. Write the configuration following [Patch template and field mapping](references/configuration.md); read that reference for installs, updates, or troubleshooting.
3. Check that the command, dependencies, target application or instance, and required environment variables are ready. Report variables by name and whether they are set. Keep project arguments that match this goal; when the target is unclear, ask first and keep the project bindings meanwhile.
4. Run the verification below and report the patch path, how to use it, its prerequisites, and the variables the user must set.

Fields that hold credentials use environment variable references. `?? ''` only keeps an undefined value from breaking config parsing; an empty credential still fails to authenticate. When a required credential is missing, report it before starting any model attempt.

## Verify with as few calls as possible

First check locally that the configuration composes with `dsh --profile sdk --patch <file> --dump-config`. Report whether it succeeded and any relevant error with credentials redacted; the full configuration stays out of the conversation.

Then verify the connection and tool registration. If an MCP client or probe that needs no model call already exists, reuse it. Otherwise use one `dsb run --patch <file>` with a bounded timeout, once the prerequisites are met. Have dsh confirm that tools with the expected `mcp__<serverName>__` prefix exist and call one read-only tool that matches the target and needs no further external action; it returns the tool name and short evidence of the result. A server that failed to start may leave the job running without its tools, so count the patch as verified only when that real call succeeded. The default route is `deepseek-official` / `deepseek-flash`; override with `--provider` / `--model` or `DPSK_PROVIDER` / `DPSK_MODEL`.

During verification, keep the host's process session and wait with `dsb wait` as the `deepseek-delegate` skill describes; after it returns, read `dsb events <ID>` and `pendingRequests` from `dsb status <ID>`. Answer questions or permission requests with `dsb answer`, approving what the user's existing authorization covers and asking the user about the rest. A queued answer counts once `input_delivered` or `input_rejected` arrives, as described in "Two-way messages and requests" of the `deepseek-delegate` skill (`input_forwarded` comes before delivery). Concurrent jobs that share one application or MCP instance use the same `--resource <name>`; read-only declarations and resource reservations coordinate jobs, while application permissions and the sandbox stay the actual protection.

One job covers both discovery and the read-only call. Report tool errors, missing tools, and missing permissions separately, and state plainly what a real call did not verify. Record the verification time, server or patch version, and a short result in an extra comment in the patch, below the first four lines; verify again when the configuration or dependencies change.

## Updating and removing

Before updating, read the existing patch, change the fields that need it, and keep the user's settings. Keep `serverName` where possible, since it sets the tool name prefix. Verify again after the update.

When the user asks to remove a specific MCP server, check that patch, back it up, delete it, and search the related projects for references with whatever the host offers (such as `rg`, `grep`, or the host's own code search), then point out briefs that need adjusting. Ask only when the target is unclear; a removal the user already asked for needs no second confirmation. Removal covers the patch file; npm or uv packages, credentials, and shared services stay as they are.

## Common problems

- `invalid config`: check field types, unset environment variables, and whether the patch loads only the servers this task needs.
- Startup failure: check the launch command, dependencies, whether the application is open, and the port or URL.
- Connected but no tools: read the server's error log to find the cause.
- A single tool call times out: query the outcome read-only first, especially for stateful editors, and repeat the operation only once it is clear it did not complete.

A custom profile can pin a fixed combination; usually reuse on-demand patches instead.
