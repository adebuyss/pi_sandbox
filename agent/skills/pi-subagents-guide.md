---
name: pi-subagents-guide
description: "Orchestrate pi-subagents: delegate to children, workflowScript fanouts (runs.run/runs.all), async runs, council/review/oracle patterns, merging child results, and recovering truncated workflow output (status.json). Use for any subagent delegation or multi-child workflow task."
---

# Pi-Subagents Guide (user overlay)

Single entry point for subagent work. The installed package is the source of truth; this file routes to it and adds the knowledge its skill lacks.

## Read first (once per task, ~2KB total)
- Package skill — router table + always-on constraints:
  `~/.pi/agent/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md`
  Its `references/*.md` live in the same directory; the router table picks the right one.
- Council work: `~/.pi/agent/npm/node_modules/pi-subagents/skills/council-mode/SKILL.md`

## Result recovery (package skill gap)
- Completion notifications show a truncated PREVIEW only. Never re-run a finished workflow to get output.
- Full workflow return value: `<asyncDir>/status.json` → `workflow.value` (asyncDir = the run's artifact dir, reported by `subagent({action:"status"})`).
- Per-child results: `<asyncDir>/workflow-receipt.json` maps child key → child run id → child's own asyncDir.
- If `view:"transcript"` is empty, that's normal — go straight to parsing `status.json`.

## Merging / sizing child results (package skill gap)
- Inline join (concatenate children into the workflow return value) is fine when the total is small — it gives deterministic ordering and lets one error aggregate cleanly.
- For large or uncertain outputs: each child writes its full result to a file (child has shell access); the workflow returns a small index (key → path + one-line summary). The parent reads files selectively.
- Budgets (version-dependent — verify against the package's `docs/observability.md`): ~64 KiB per-child archive result tails; ~1 MiB returned values. Keep the return value well under notification preview limits.
- Built-in agent output defaults: `scout` has `output: context.md` in its agent definition — it drops a handoff file in the run's cwd unless you pass an explicit output path (point it at a temp path, or clean up after). Other builtins declare no output default.
