# pi-mcp

Expose the **pi** coding agent (headless) as **MCP tools** for any MCP client —
Claude Code, Claude Desktop, Cursor, or anything else that speaks MCP over stdio.

Zero dependencies. Node 22+ (pi itself needs ≥ 22.19). No build step. ~250 lines.

```
claude (MCP client)  --stdio-->  index.mjs  --spawns-->  pi -p "<task>" --mode json
```

The child `pi` process inherits this server's environment, so pi's normal auth
(`~/.pi/agent/auth.json`, env API keys, local providers) is used as-is. No extra
keys required.

## Setup

Requires a `pi` binary (`npm i -g @earendil-works/pi-coding-agent`, or the
sandbox wrapper from this repo).

**Which `pi` it runs.** The server resolves the binary deterministically so it
doesn't depend on the PATH it happened to be launched with:

```
$PI_MCP_BIN  →  ~/pi-sandbox/pi (if executable)  →  "pi" (from PATH)
```

So if this repo's wrapper is installed at `~/pi-sandbox/pi`, **every run is
sandboxed by default**, regardless of how the MCP client started this server.
Set `PI_MCP_BIN` to force a specific binary (e.g. an unsandboxed pi). The chosen
path is logged on each call (`pi=…`).

**With the sandbox wrapper:** every `pi_run` / `pi_continue` runs inside the
container, confined to its `cwd` — verified `PI_SANDBOX=1`, hostname
`pi-sandbox`, cwd mounted at its real path, minimal home. The wrapper **refuses
`$HOME` and `/`** (that would mount your whole home), so always pass an explicit
project `cwd`; use `PI_SANDBOX_ALLOW_HOME=1` to override. `pi_models` works from
any directory (it runs `--list-models` without mounting a project). The child
inherits `LLAMA_BASE_URL` etc. from the server's environment, so local models
keep working.

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
| `include_message_ends` | false | keep every intermediate message and return them in a `messages` array; default keeps only the final answer |

## Notes & limits

- **Long runs:** if your client has an MCP tool-call timeout shorter than a
  typical pi run, raise it. Claude Code: `MCP_TOOL_TIMEOUT=600000` (ms) env var.
- **Safety:** `bash` is excluded by default. Only pass `allow_bash: true` when
  you want pi to run commands in that directory.
- **Sessions:** saved under pi's normal session dir (`~/.pi/agent/sessions`);
  to watch a run live, `tail -f` the newest `.jsonl` there.
- **Message filtering:** pi's `--mode json` stream is parsed incrementally and
  only the **last** message is kept by default (with `session`/`error` and a
  trimmed `agent_end`). Intermediate messages, deltas, and any single event
  larger than ~1 MB (e.g. a huge tool result) are dropped as they stream, so
  bulky bash/grep output can't blow the buffer. Pass `include_message_ends:true`
  to keep them all in `messages`.
- **Output cap:** each returned message's text is truncated at 100 KB; the full
  text stays in pi's saved session if you need it.
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
