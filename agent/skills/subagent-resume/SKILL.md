---
name: subagent-resume
description: "Recover pi-subagents children after a turn, the parent pi, the container, or the model server died: revive failed/lost/paused children from their persisted session files instead of relaunching, recover a child's full (untruncated) answer, and handle model-availability traps (server restart, 24h model exclusions). Use whenever a subagent run failed, went missing, 'we died', a workflow needs restarting, or a completion notification was cut off."
---

# Subagent resume

Children almost never need to be relaunched. Every native pi child keeps a full session file
(`~/.pi/agent/sessions/<cwd-key>/<parent-session>/<runId>/run-N/session.jsonl`) that survives
everything, including a sandbox container restart. `subagent({ action: "resume" })` starts a new
child *from that file*, so it keeps every image it viewed and every conclusion it reached.
What does not survive a container restart is pi-subagents' run bookkeeping under
`/tmp/pi-subagents-uid-*/` — this skill's script rebuilds it.

Helper (zero deps, read-only except `rebuild`):

```
node ~/.pi/agent/skills/subagent-resume/scripts/subagent-recover.mjs list [--all-parents] [--json]
node ~/.pi/agent/skills/subagent-resume/scripts/subagent-recover.mjs show <runId|prefix>
node ~/.pi/agent/skills/subagent-resume/scripts/subagent-recover.mjs rebuild <runId|prefix> [--index N] [--agent NAME] [--force]
node ~/.pi/agent/skills/subagent-resume/scripts/subagent-recover.mjs repair <runId|prefix> [--index N] [--file F] [--dry-run]
```

Run it from the `bash` tool: pi exports `PI_SESSION_ID` and `PI_SESSION_FILE` there, which the
script uses to find the current session's children and to tag rebuilt runs. `--all-parents` also
lists children of *earlier* sessions in this project (needed when the user started a fresh session).

`repair`: a child severed mid-turn (model server crash/restart) leaves its session ending in
records pi cannot continue from — an empty assistant turn with stopReason "error" (the raw 500),
a thinking-only fragment, or toolCalls whose results never arrived. The symptom on continue or
revive is `Cannot continue from message role: assistant`. `repair` trims the tail back to the
last user/toolResult message (backup written first; `--dry-run` previews) so the model simply
re-generates the severed turn on resume. It refuses a transcript whose final assistant turn looks
complete — that one resumes fine as-is. Run `repair` before `rebuild` when a child died to a
server crash.

## Step 0 — the model must be reachable before any revive

The children died for a reason; reviving into the same outage just repeats it.

1. **Server up?** `curl -sf http://127.0.0.1:8080/v1/models | jq -r '.data[].id'` (use the host/port
   from `LLAMA_BASE_URL` / the model id, e.g. `llama-server=http://127.0.0.1:8080/...`). If it fails, stop
   and tell the user; nothing below will work.
2. **Parent registry has the model?** `pi-llama-cpp` registers the `llama-server=<url>` provider only
   if the server answered when *this* pi process started. If the parent was started while the server
   was down, launches fail with `Model "…" not found`. You cannot run slash commands: ask the user to
   run `/models` (re-probes the server) and then continue.
3. **Model exclusions.** When a child fails with an error matching pi-subagents' retryable patterns
   (`model … not found`, `connection refused`, `timeout`, `503`, `fetch failed`, …) the package
   excludes that model for **24 h** in `<tempRoot>/model-exclusions.json` *and in the parent's memory*.
   Later launches silently drop it (the child falls back to its default model or the run fails).
   `Request timed out.` and a child launched while the server was down (`Model … not found`) both
   trigger this; a plain `Connection error.` does not. `list` prints active exclusions. Nothing clears them except restarting pi:
   in the sandbox exit and `pi -c` (tmpfs wipes the file); on the host delete the file, then restart.
4. Children are fresh pi processes and probe the server at their own startup — so the server must be
   up at the moment you call `resume`, not just when the original run was launched.

## Step 1 — find out which of the three situations you are in

| Situation | How you can tell | Go to |
|---|---|---|
| A. Same pi process, children failed/paused/finished | `subagent({ action: "status" })` lists the runs (failed/paused/complete) | Step 2 |
| B. pi was restarted on the host (unsandboxed) | `status` still lists runs; some may be `running` with a dead PID | Step 3 |
| C. Sandbox container restarted | `status` shows nothing, `list` shows an `async root … (missing)` | Step 4 |

## Step 2 — A: revive in place (this is the common case)

- `subagent({ action: "status" })` — failed runs carry a *Resume-first* line with the exact command.
- Workflow children (`runs.run` / `runs.all`): `subagent({ action: "children.list" })` → rows marked
  `resumable`.
- Revive: `subagent({ action: "resume", id: "<runId>", message: "<see template>" })`; add `index: N`
  for multi-child runs. Revive a few at a time (`maxActiveAsyncRunsPerSession`), not all 9 at once.
- Never launch a replacement before `resume` has been tried. Stopped runs are the one exception
  (`stop` makes a run non-resumable).
- The revived child gets a **new run id**; keep working with the id the resume returns.

Message template (the child keeps its context, so be specific about what to persist):

> Your previous process died at <time> (<error>). Before anything else, append every result you
> already have to <file> in the agreed format. Then continue from where you were. Do not redo work
> that is already in the file.

## Step 3 — B: parent restarted on the host

`/tmp` survived, so pi-subagents' own recovery applies once you call `subagent({ action: "status" })`:
runs whose runner PID is gone are marked failed (stale-run reconciliation), finished ones deliver
their completion on the next turn, and detached async children may **still be running** — do not
relaunch; `subagent_wait({ id })` on them. Then treat failed ones as in Step 2.

## Step 4 — C: container restarted (run state gone, sessions kept)

1. `list` (add `--all-parents` if the user started a new session). Each row: runId, agent, exit
   code / error, session size, whether a native `status.json` exists, and the child's last words.
2. For each child you actually need:
   - Finished but its answer was truncated in the notification → `show <runId>` and use the text.
     No revival needed.
   - Died mid-task → `rebuild <runId>` (prints the exact `resume` call), then
     `subagent({ action: "resume", id: "<runId>", message: "…" })`. The rebuilt run is tagged with
     *your* session id, so the completion notification comes to you even if the child belonged to an
     earlier session.
3. `rebuild` refuses when a `status.json` already exists (native resume works — use it), when the
   child cwd is missing, or when it cannot tell the agent (`--agent worker`). It writes only under
   `/tmp/pi-subagents-uid-*/async-subagent-runs/<runId>/`.

## Escape hatch

If `resume` refuses (schema drift after a pi-subagents upgrade, lease held by another revival):

```
pi --session "<child session.jsonl>" -p "<message>" --mode json > /tmp/revive-<runId>.json
```

This keeps the child's context but loses the agent's system prompt, tool allowlist, budgets and
completion notification. Prefer it only when the native path is broken, and say so.

## Things that bite

- Fork-context children (`worker`, `oracle`) carry the parent's context up to the fork; their session
  files are 30–45 MB when images were viewed and will compact soon after revival — hence "write to
  disk first" in the template.
- The revived child uses the agent definition's *current* tools/model (no launch descriptor after a
  restart). Pass `--agent` if `meta.json` is missing.
- `status.json` is package-internal; the script is verified against pi-subagents 0.54 and 0.62 and warns on
  other versions. Re-check `AsyncStatus` / `resolveAsyncResumeTarget` when bumping the package.
- A child whose work only ever lived in its context and that was then *relaunched* fresh is gone;
  revival is the only way to get that context back, which is why this skill exists.
