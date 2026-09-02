---
name: context-alert
description: "Checkpoint before auto-compaction: read current context-window usage and register alerts that ping you at a chosen percentage (context_alert tool). Use at the start of any long task that reads many files, views images, or accumulates results in context, and whenever a [context-alert] message arrives."
---

# Context alerts

Auto-compaction replaces your older messages with a summary once context passes the window
minus the reserve. Images you viewed and conclusions you never wrote down do not survive that.
The `context_alert` tool lets you get pinged before it happens.

- `context_alert()` or `{ action: "status" }` — current usage (`tokens of window, %`) and alerts.
- `{ action: "set", percent: 70, message: "append finished blocks to REPORT.md", holdCompaction: true }`
  — ping at 70%; `holdCompaction` also cancels the first threshold compaction once and delivers the
  alert instead, giving you exactly one turn to checkpoint.
- `{ action: "clear" }` / `{ action: "clear", id }` — remove alerts.

A default alert exists in every session (75%, generic "write your results to disk now"), so you
get one ping even without registering. Alerts persist across `pi -c` and subagent revival and
re-arm after every compaction.

When a `[context-alert]` message arrives: finish the current tool call, write everything you have
to disk in the task's format, then continue. Do not start new reads first.

Rules of thumb: register at 60–70% for image-heavy work (each image is thousands of tokens);
choose a message that names the file and format; use `holdCompaction` when the checkpoint itself
needs a turn. Usage lags by one turn after a very large tool result.

## 50% checkpoint-and-respawn protocol (local vLLM — follow on every substantial task)

The model server runs 2 concurrent streams against a ~195k-token KV pool: a session that grows
past ~50% of the window risks pool exhaustion the moment a second stream is active (engine
livelock, ~40x slowdown). So instead of compacting at the ceiling, hand off at the midpoint:

1. **At task start**, register:
   `context_alert({ action: "set", percent: 50, message: "mission checkpoint -> ~/.pi/agent/missions/", holdCompaction: true })`
2. **When it fires**, write your mission file to `~/.pi/agent/missions/<date>-<short-task-slug>.md`
   (this directory is writable in the sandbox and survives container restarts). Contents:
   the mission as given, what is DONE (with file paths of results already written), key facts
   and conclusions gathered so far, what REMAINS as a concrete plan, and the exact next step.
   Write it so a fresh session with zero context can continue from it alone.
3. **Then hand off or change gear — by role**:
   - A **subagent**: return now — final message "context at 50% — respawn me from
     missions/<file>". The orchestrator relaunches a fresh child from the file. If a tool or
     command exists to start a fresh session seeded with a prompt, that works too. Do not
     sail past 50% "to finish one more step" — the checkpoint turn is the step.
   - The **main thread** may keep working past 50% — its solo request always fits the pool.
     What changes at 50% is concurrency: from here on, do not take turns while subagents are
     running. Spawn children and block-wait on them, or work alone; never interleave. The
     checkpoint file is still worth writing (crash insurance and a ready `/new` seed if the
     session ever needs a fresh start), but handing off is optional for the main thread.
