---
name: pi-subagents-guide
description: "Orchestrate pi-subagents: delegate to children, workflowScript fanouts (runs.run/runs.all), async runs, council/review/oracle patterns, merging child results, and recovering truncated workflow output. Use for any subagent delegation or multi-child workflow task. For failed, lost, or died children see the subagent-resume skill."
---

# Pi-Subagents Guide (user overlay)

Single entry point for subagent work. The installed package is the source of truth; this file routes to it and adds the knowledge its skill lacks.

## Model-server concurrency budget (HARD RULES — local vLLM)

The model server decodes at most 2 requests at once (MAX_SEQS=2); two streams whose contexts
together exceed the ~195k-token KV pool put the engine into a preempt/resume livelock (~40x
slowdown, orphaned requests that survive aborts). Budget accordingly:

1. **Never more than 2 children running concurrently.** If the main thread keeps working
   while children run, spawn at most **1** child — total concurrent streams ≤ 2, always.
2. **Image work: at most 1 image-carrying stream at a time.** A preempted image request can
   kill the engine outright (mm-embeds resume crash). Serialize image-heavy children; do not
   run your own image turns while an image-carrying child is active.
3. **Every stream stays under ~50% of the context window** (~96k tokens) so two streams can
   never outgrow the pool. When spawning a child, include in its prompt: "register a
   context_alert at 50% with holdCompaction; when it fires, checkpoint your mission to
   ~/.pi/agent/missions/ and hand off for respawn" — the context-alert skill documents the
   checkpoint/respawn protocol. When a child returns asking for respawn, launch a FRESH child
   whose prompt is its mission file (do not resume the full-context session).

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
- `asyncDir` lives under `/tmp/pi-subagents-uid-*/` and does NOT survive a sandbox restart. Afterwards the only durable copies are the child session files and `subagent-artifacts/` — use the `subagent-resume` skill's `show <runId>` to read a child's full last answer.

## Recovery: a child failed, went missing, or "we died" (→ skill `subagent-resume`)
- Do not relaunch. Every native child has a persisted session file and `subagent({action:"resume", id})` revives it with its full context (images viewed, conclusions reached).
- Same pi process: `subagent({action:"status"})` → follow its Resume-first lines. After a sandbox restart: the skill's script rebuilds the run record first.
- Check the model server is up and the model is not on pi-subagents' 24h exclusion list before reviving; the skill explains both.

## Merging / sizing child results (package skill gap)
- Inline join (concatenate children into the workflow return value) is fine when the total is small — it gives deterministic ordering and lets one error aggregate cleanly.
- For large or uncertain outputs: each child writes its full result to a file (child has shell access); the workflow returns a small index (key → path + one-line summary). The parent reads files selectively.
- Budgets (version-dependent — verify against the package's `docs/observability.md`): ~64 KiB per-child archive result tails; ~1 MiB returned values. Keep the return value well under notification preview limits.
- Built-in agent output defaults: `scout` has `output: context.md` in its agent definition — it drops a handoff file in the run's cwd unless you pass an explicit output path (point it at a temp path, or clean up after). Other builtins declare no output default.
