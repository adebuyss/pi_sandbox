---
name: mcp-on-demand
description: "Some capabilities are loaded on demand to save context. If you need one and its tools are not in your list, call its loader first (they go live the same turn): load_web (search the web, fetch URLs, verify claims), load_exa (semantic search, find similar pages, extract page content), load_mcp (call external MCP servers), load_ide (VS Code errors/warnings), load_preview (export Markdown/LaTeX to PDF/HTML/PNG), load_all (everything). Do not work around a missing capability with bash — open its door instead."
---

# On-Demand Capabilities

Heavy tool groups are not in your tool list at session start — their schemas cost
~15k tokens per request. Each is advertised as a single `load_*` "door" tool. Calling
the door swaps it for the group's real tools.

## Rule

When a task needs one of these, **call its `load_*` tool, then use what it unlocks** in
your next step (same turn). Don't fall back to `bash`/`curl` because a tool "isn't
there" — the capability is one call away.

| Loader | Unlocks | Use when |
|--------|---------|----------|
| `load_web` | web search + URL fetch | web research, look something up, fetch/read a URL, verify a claim |
| `load_exa` | Exa semantic search | neural/semantic search, find similar pages, clean content extraction |
| `load_mcp` | MCP gateway | talk to external MCP servers |
| `load_ide` | IDE diagnostics | check VS Code errors/warnings (needs the IDE bridge) |
| `load_preview` | export | render Markdown/LaTeX to PDF/HTML/PNG |
| `load_all` | all of the above | big research sessions that will touch several |

## Notes

- A door disappears once its group is loaded; the real tools take its place.
- Loaded groups stay active for the rest of the session.
- context-mode's `ctx_*` tools (sandboxed execution, knowledge base) are always on —
  they are not part of the on-demand set.
- The grouping lives in `~/.pi/agent/extensions/mcp-lazy.ts` (`DEFAULT_HIDDEN`);
  remove a group there to make it always-on.
