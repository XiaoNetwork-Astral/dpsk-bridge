# MCP patches and importing

Every patch keeps the four comment lines below so the delegation skill can discover it cheaply. Patches live in `$DSH_HOME/patches` (`~/.dsh/patches` when `DSH_HOME` is unset). The template shows stdio and HTTP; use one of them, and check optional fields against `@deepseek-ai/dsh-mcp-client/README.md` of the installed dsh version.

```yaml
# deepseek-mcp: <name>
# Purpose: <what this MCP server provides>
# Requires: <application, service, project, or instance requirements; none if nothing>
# Usage: dsb run --cwd <project> --brief <file> --patch <patch directory>/<name>-mcp.yml
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

`serverName` matches `[A-Za-z0-9_-]{1,32}` and must be unique among installed patches; tool names are prefixed with `mcp__<serverName>__`. Set `toolCallTimeoutMs` to the real tool duration, so connection errors surface promptly. `failOnStartupError: true` makes the MCP client report a failed startup, but dsh treats the MCP entry as optional and may continue the job without its tools; confirm the `mcp__<serverName>__` tools in the run result before relying on the patch.

Patches written by earlier versions of this skill use the first-line tag `dsh-mcp:` and Chinese header keys (`用途`, `前提`, `用法`) for Purpose, Requires, and Usage. They keep working; switch to the current tag and English keys when you next edit such a patch.

## Credentials

The current dsh MCP client withholds variables whose names contain `KEY` / `PASSWORD` / `SECRET` / `TOKEN`, and `DSH_*` variables; forward them explicitly in `env`. Write the reference as `!!js process.env.NAME ?? ''` and confirm that required variables are set before running.

When another client's configuration contains a plain-text secret, turn it into an environment variable reference and name the variable that must be set. Secrets belong only in the user's environment: command examples, reports, patch header comments, and version control carry variable names, and verification reports results with the expanded configuration kept out of the output.

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
- `type: http` or `url`: map to `transport: streamable-http`, keeping the URL and needed headers. Other transports need a compatibility check first; map them only to an equivalent dsh transport.
- `env_vars = ["X"]`: map to `env: { X: !!js process.env.X ?? '' }`. The object form with `source: remote` reads from a remote environment, which a local variable cannot replace; first confirm that the original execution environment and dependencies can be configured equivalently in dsh.
- Codex `http_headers` / `env_http_headers`: map to `headers`; turn credentials in the former into environment references, and read the latter from the variables they name. Map `bearer_token_env_var = "X"` to `Authorization: !!js '"Bearer " + (process.env.X ?? "")'`, keeping a single Authorization header.
- `tool_timeout_sec`: multiply by 1000 for `toolCallTimeoutMs`; `startup_timeout_sec` has no direct equivalent.

Keep the source configuration's enabled state and tool restrictions. The current dsh MCP client has no equivalent for Codex `enabled_tools` / `disabled_tools`, host approval rules, `http_headers_helper`, or OAuth/ChatGPT sign-in state, and copying a URL or prompt cannot carry those capabilities over. When the original tool restrictions, resource/prompt capabilities, or non-transferable authentication are needed, leave that operation to the host agent or first configure a server with equivalent constraints; an import is complete only when it keeps the original restrictions.

For Codex fields and configuration layers, the official [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-advanced) are authoritative.

Installing dependencies or changing target applications or external services stays within the user's authorization for this task. Ordinary reuse of a configuration needs no repeated import or verification.
