---
name: deepseek-mcp
description: Install, import, inspect, update, or remove MCP server patches for DeepSeek Harness (dsh) from any host agent with local command execution, or diagnose missing connections and invalid configuration. Reuse working patches for delegation.
---

# Managing MCP for dsh

For any host agent that can run local commands; Claude Code and Codex are examples. Requires Node.js >=24.9, `@deepseek-ai/dsh` >=0.2.1-rc.3, and the current dpsk-bridge. Each MCP server has one file, `~/.dsh/patches/<name>-mcp.yml`, loaded on demand into a bidirectional SDK session with `dsb run --patch <file>` (repeatable). MCP servers available to the host do not appear in dsh automatically; load only the servers this task needs to avoid extra tool definitions and startup cost.

## Listing and reuse

The first 4 lines of a patch give its name, purpose, prerequisites, and usage. In Bash: `head -n 4 ~/.dsh/patches/*-mcp.yml`; in PowerShell: `Get-ChildItem -Path ~/.dsh/patches -Filter '*-mcp.yml' | ForEach-Object { Get-Content -LiteralPath $_.FullName -TotalCount 4 }`. Pick the command for the shell you actually have. Older patches may use the Chinese header keys `用途` (purpose), `前提` (requires), and `用法` (usage); they mean the same.

No matching file only means nothing is configured yet. When listing configurations, never read or print the whole credential environment. When a configuration has not changed, its verification result is still valid, and its prerequisites are met, reuse it directly instead of reinstalling or retesting for every delegation.

## Installing or importing

1. Determine the launch method and dependencies from the user's existing configuration or the server's official instructions. Import only the requested server; do not copy the whole client configuration.
2. Write the configuration following [Patch template and field mapping](references/configuration.md); read that reference only for installs, updates, or troubleshooting.
3. Check that the command, dependencies, target application/instance, and required environment variables are ready. Report only the names of variables and whether they are set, never their values. Keep project arguments that match this goal; when the target is unclear, ask first instead of removing project bindings.
4. Run the verification below and report the patch path, how to use it, its prerequisites, and the variables the user must set.

Fields that hold credentials use environment variable references, never plain text. `?? ''` only keeps an undefined value from breaking config parsing; it does not mean an empty credential will authenticate. When a required credential is missing, report it first instead of starting model attempts over and over.

## Verify with as few calls as possible

First check locally that the configuration composes with `dsh --profile sdk --patch <file> --dump-config`. Report only whether it succeeded and any relevant redacted error; never put the full configuration into the conversation.

Then verify the connection and tool registration. If an MCP client or probe that needs no model call already exists, reuse it. Otherwise use one `dsb run --patch <file>` with a bounded timeout and have dsh confirm the tools with the expected prefix exist and call one read-only tool that matches the target and needs no further external action; it returns the tool name and short evidence of the result. The default route is `deepseek-official` / `deepseek-flash`; override with `--provider` / `--model` or `DPSK_PROVIDER` / `DPSK_MODEL`. Do not call when the prerequisites are not met, and never accept tool names listed by the model in place of a real call.

During verification, keep the host's process session and wait with `dsb wait` as the `deepseek-delegate` skill describes; after it returns, read `dsb events <ID>` and `pendingRequests` from `dsb status <ID>`. Answer questions or permission requests with `dsb answer`, and approve only operations covered by the user's existing authorization; when you cannot decide, ask the user. Queued is not delivered: check `input_delivered` / `input_rejected` as described in "Two-way messages and requests" of the `deepseek-delegate` skill (`input_forwarded` is not delivery). Concurrent jobs that share one application or MCP instance should use the same `--resource <name>`; read-only declarations and resource reservations do not replace application permissions or a sandbox.

One verification covers both discovery and the read-only call; do not split it into two paid model calls. Report tool errors, missing tools, and missing permissions separately; when something was not verified by a real call, say so and never mark it verified. Record the verification time, server/patch version, and a short result in an extra comment in the patch (without changing the first four lines); verify again when the configuration or dependencies change later.

## Updating and removing

Before updating, read the existing patch; change only the fields that need it and keep the user's settings. Keep `serverName` where possible, since it sets the tool name prefix. Verify again after the update.

When the user explicitly asks to remove a specific MCP server, check that patch, back it up, delete it, and search the related projects for references with whatever the host offers (such as `rg`, `grep`, or the host's own code search), then point out briefs that need adjusting. Ask only when the target is unclear, and do not ask again for removal permission already given. Do not also uninstall npm/uv packages, delete credentials, or stop shared services.

## Common problems

- `invalid config`: check field types, unset environment variables, and whether the patch loads only the servers this task needs.
- Startup failure: check the launch command, dependencies, whether the application is open, and the port or URL.
- Connected but no tools: read the server's relevant error log instead of letting the model guess tool names.
- A single tool call times out: check the outcome read-only first, especially for stateful editors; do not blindly repeat an operation that may already have completed.

A custom profile can pin a fixed combination; usually prefer reusing on-demand patches.
