# pi-mcp

Expose the **pi** coding agent (headless) as **MCP tools** for any MCP client —
Claude Code, Claude Desktop, Cursor, or anything else that speaks MCP over stdio.

Zero dependencies. Node 18+. No build step. ~250 lines.

```
claude (MCP client)  --stdio-->  index.mjs  --spawns-->  pi -p "<task>" --mode json
```

The child `pi` process inherits this server's environment, so pi's normal auth
(`~/.pi/agent/auth.json`, env API keys, local providers) is used as-is. No extra
keys required.

## Setup

Requires `pi` on PATH (`npm i -g @earendil-works/pi-coding-agent`).

**With pi-sandbox:** when `pi` on PATH is the sandbox wrapper from this repo,
every `pi_run` / `pi_continue` runs inside the container, confined to its `cwd`
(the wrapper refuses `$HOME` and `/`). `pi_models` works from any directory
because the wrapper runs `--list-models` without mounting a project. The child
inherits `LLAMA_BASE_URL` etc. from the MCP server's environment, so local
models keep working.

### Claude Code (user scope — available in every project)

```bash
claude mcp add pi -s user -- node /path/to/pi-sandbox/mcp/index.mjs
claude mcp list          # verify connection
```

### Claude Code (project scope) — add to `.mcp.json` in the project root

```json
{
  "mcpServers": {
    "pi": {
      "command": "node",
      "args": ["/path/to/pi-sandbox/mcp/index.mjs"]
    }
  }
}
```

(adjust the path to wherever you keep this folder)

### Claude Desktop / Cursor

Add the same `{ "command": "node", "args": ["…/index.mjs"] }` entry to the
client's MCP server config.

## Tools

| Tool | What it does |
|---|---|
| `pi_run` | Start a **new** headless pi session in a directory, let it work, return final answer + model/tokens/session id |
| `pi_continue` | Resume the **most recent** saved pi session for a cwd (`pi --continue`) with a follow-up prompt |
| `pi_models` | List pi's configured models (`pi --list-models [search]`) |

Common `pi_run` / `pi_continue` parameters:

| Param | Default | Notes |
|---|---|---|
| `prompt` | — | required — the task for pi |
| `cwd` | server cwd | absolute path of the directory pi works in |
| `provider` / `model` | pi's defaults | e.g. `"provider":"anthropic","model":"sonnet"` |
| `thinking` | pi's default | `off\|minimal\|low\|medium\|high\|xhigh\|max` |
| `allow_bash` | **false** | false = pi only reads/writes/edits files, no shell (safe for analysis) |
| `approve` | false | trust project-local files (`pi --approve`) |
| `save_session` | true | persist so `pi_continue` can resume (run-only: set false to skip) |
| `timeout_minutes` | 10 | hard kill, 1–60 |
| `append_system_prompt` | — | extra system prompt for this run |

## Notes & limits

- **Long runs:** if your client has an MCP tool-call timeout shorter than a
  typical pi run, raise it. Claude Code: `MCP_TOOL_TIMEOUT=600000` (ms) env var.
- **Safety:** `bash` is excluded by default. Only pass `allow_bash: true` when
  you want pi to run commands in that directory.
- **Sessions:** saved under pi's normal session dir (`~/.pi/agent/sessions`).
- **Output cap:** responses are truncated at 100 KB; the full text stays in pi's
  saved session if you need it.
- **One call = one answer:** the client waits for pi to finish; there is no
  streaming of intermediate steps back to the client.
- **Not a proxy for everything:** this wraps pi's *headless CLI*. For richer
  control (fork sessions, RPC-level steering) look at
  [Baseline-Systems/pi-mcp](https://github.com/Baseline-Systems/pi-mcp) (uses
  `pi --mode rpc`, requires an OpenRouter key) or
  [sotola122/pi-delegate-mcp](https://github.com/sotola122/pi-delegate-mcp)
  (subagent manager, GitHub Packages distribution).

## Test

```bash
node test.mjs
```

Speaks real MCP JSON-RPC over stdio: initialize → tools/list → pi_models →
pi_run ("Reply with exactly: PONG") → pi_continue (asks pi to repeat the first
prompt). Takes ~20 s with a local model.
