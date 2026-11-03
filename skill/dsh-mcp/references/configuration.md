# MCP patches and importing

Every file keeps the four comment lines below so the delegation skill can discover it cheaply. The template shows stdio and HTTP; use one of them, and check optional fields against `@deepseek-ai/dsh-mcp-client/README.md` of the installed dsh version.

```yaml
# dsh-mcp: <name>
# Purpose: <what this MCP server provides>
# Requires: <application, service, project, or instance requirements; none if nothing>
# Usage: dsb run --cwd <project> --brief <file> --patch ~/.dsh/patches/<name>-mcp.yml
- insert:
    - id: mcp-<name>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: <name>
        transport: stdio
        command: npx
        args: ['-y', '<package>@<version>']
        env:
          API_TOKEN: !!js process.env.API_TOKEN ?? ''
        # cwd: <working directory>
        # For HTTP, remove command / args and use:
        # transport: streamable-http
        # url: http://127.0.0.1:3000/mcp
        # headers: { Authorization: !!js '`Bearer ${process.env.MCP_TOKEN ?? ""}`' }
        toolCallTimeoutMs: 120000
        failOnStartupError: true
```

`serverName` matches `[A-Za-z0-9_-]{1,32}` and must be unique among installed patches; tool names are prefixed with `mcp__<serverName>__`. Set `toolCallTimeoutMs` to the real tool duration; do not hide connection errors behind a very long timeout. A failed startup should be an explicit error so a job does not quietly go astray without its tools.

Patches written by earlier versions of this skill use Chinese header keys (`用途`, `前提`, `用法`) for Purpose, Requires, and Usage. They keep working; switch to the English keys when you next edit such a patch.

## Credentials

The current dsh MCP client does not inherit variables whose names contain `KEY` / `PASSWORD` / `SECRET` / `TOKEN`, or `DSH_*` variables; forward them explicitly in `env`. Write the reference as `!!js process.env.NAME ?? ''` and confirm that required variables are set before running.

When another client's configuration contains a plain-text secret, turn it into an environment variable reference and name the variable that must be set. Never put secrets in command examples, reports, patch header comments, or version control, and never print the expanded full configuration to verify it.

## Where configurations come from

The table lists common clients as examples, not a complete list; for other clients, find the server definition in their official MCP documentation. The meaning is the same everywhere: the launch command uses command/args/cwd, environment variables use env, and remote services use a URL and request headers (transport mapping below).

| Source | Location |
|---|---|
| Claude Code | `claude mcp get <name>`; global and per-project `mcpServers` in `~/.claude.json`; the project's `.mcp.json` |
| Codex | `[mcp_servers.<name>]` in the effective configuration; the default user configuration is `~/.codex/config.toml`, or that directory when `CODEX_HOME` is set; also check `.codex/config.toml` files of trusted projects from the root down to the current directory, and overrides from enabled profiles |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, and per the official documentation on Linux; still the `mcpServers` field |

Field mapping (field names mostly come from the Codex configuration; map other clients by meaning):

- `command` / `args` / `cwd`: keep the confirmed launch semantics and make sure local paths exist.
- `env` / `headers`: keep variable names and the authentication method; turn credentials into the environment references above.
- `type: http` or `url`: map to `transport: streamable-http`, keeping the URL and needed headers; check compatibility for other transports first instead of forcing them into HTTP.
- `env_vars = ["X"]`: map to `env: { X: !!js process.env.X ?? '' }`. The object form with `source: remote` cannot be switched to reading the local environment; first confirm that the original execution environment and dependencies can be configured equivalently in dsh.
- Codex `http_headers` / `env_http_headers`: map to `headers`; turn credentials in the former into environment references, and read the latter from the variables they name. Map `bearer_token_env_var = "X"` to `Authorization: !!js '"Bearer " + (process.env.X ?? "")'`, avoiding a duplicate Authorization header.
- `tool_timeout_sec`: multiply by 1000 for `toolCallTimeoutMs`; `startup_timeout_sec` has no direct equivalent.

Keep the source configuration's enabled state and tool restrictions. The current dsh MCP client does not map Codex `enabled_tools` / `disabled_tools`, host approval rules, `http_headers_helper`, or OAuth/ChatGPT sign-in state, and copying a URL or prompt cannot carry those capabilities over. When the original tool restrictions, resource/prompt capabilities, or non-transferable authentication are needed, leave that operation to the host agent or first configure a server with equivalent constraints; never import while silently dropping restrictions.

For Codex fields and configuration layers, the official [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-advanced) are authoritative.

Installing dependencies or changing target applications or external services must stay within the user's authorization for this task. Ordinary reuse of a configuration needs no repeated import or verification.
