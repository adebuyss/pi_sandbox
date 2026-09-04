/**
 * context-alert: let the model ask to be pinged at a chosen context-usage
 * percentage so it can checkpoint (write results to disk, summarize state)
 * BEFORE auto-compaction summarizes its history away.
 *
 * - Tool `context_alert`: set / status / clear alerts, and read current usage.
 *   Alerts are persisted as custom session entries, so they survive `pi -c`
 *   and subagent revival (`subagent({ action: "resume" })`).
 * - A default alert (PI_CONTEXT_ALERT_DEFAULT_PERCENT, default 75; 0 disables)
 *   exists in every session, so builtin subagents get the ping even when they
 *   never call the tool.
 * - Firing: after every turn the extension reads ctx.getContextUsage() (the
 *   same number pi's footer shows). A crossed threshold delivers a custom
 *   message as "steer": it lands after the current tool calls and before the
 *   next LLM call. If the agent is idle it triggers a turn so the model can act.
 * - holdCompaction: when an alert asks for it, the first *threshold* compaction
 *   is cancelled once and the alert is delivered instead, giving the model one
 *   turn to checkpoint. Overflow and manual compactions are never held.
 * - Tool-registered alerts are ONE-SHOT: they deregister on firing (persisted, so they
 * stay gone across pi -c and revival). The default alert re-arms after every compaction.
 *
 * Cost: one getContextUsage() call per turn; no file I/O in hot paths.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY_TYPE = "context-alert";
const MESSAGE_TYPE = "context-alert";
const DEFAULT_ID = "default";
const DEFAULT_PERCENT = Number(process.env.PI_CONTEXT_ALERT_DEFAULT_PERCENT ?? 75);
const DEFAULT_MESSAGE = process.env.PI_CONTEXT_ALERT_DEFAULT_MESSAGE
  ?? "Auto-compaction will soon replace your older messages with a summary; anything that exists only in your context (images you viewed, partial conclusions, lists you were building) may be lost. Write your results so far to disk now, in the format the task expects, then continue.";

interface Alert {
  id: string;
  percent: number;
  message: string;
  holdCompaction: boolean;
  source: "default" | "tool";
  fired: boolean;
}

let alerts: Alert[] = [];
let holdUsed = false;
let seq = 0;

function defaultAlert(): Alert | undefined {
  if (!(DEFAULT_PERCENT > 0 && DEFAULT_PERCENT < 100)) return undefined;
  return { id: DEFAULT_ID, percent: DEFAULT_PERCENT, message: DEFAULT_MESSAGE, holdCompaction: false, source: "default", fired: false };
}

/** Rebuild alerts from persisted entries on the current branch (tool-set ones), plus the default. */
function restore(ctx: ExtensionContext): void {
  const restored: Alert[] = [];
  const d = defaultAlert();
  if (d) restored.push(d);
  for (const entry of ctx.sessionManager.getBranch() as any[]) {
    if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data ?? {};
    if (data.op === "set" && data.alert) {
      const a = data.alert as Alert;
      const idx = restored.findIndex((x) => x.id === a.id);
      const fresh = { ...a, fired: false };
      if (idx >= 0) restored[idx] = fresh; else restored.push(fresh);
    } else if (data.op === "clear") {
      if (data.id) { const i = restored.findIndex((x) => x.id === data.id); if (i >= 0) restored.splice(i, 1); }
      else for (let i = restored.length - 1; i >= 0; i--) if (restored[i].source === "tool") restored.splice(i, 1);
    }
  }
  alerts = restored;
  holdUsed = false;
}

function usageLine(ctx: ExtensionContext): { text: string; percent: number | null } {
  const u = ctx.getContextUsage();
  if (!u || u.tokens == null || u.percent == null) return { text: "context usage: unknown (no assistant usage yet, or just compacted)", percent: null };
  return { text: `context usage: ${u.tokens.toLocaleString()} of ${u.contextWindow.toLocaleString()} tokens (${u.percent.toFixed(0)}%)`, percent: u.percent };
}

function describe(a: Alert): string {
  return `- ${a.id}: at ${a.percent}%${a.holdCompaction ? ", holds first compaction" : ""}${a.fired ? " (fired)" : ""}${a.source === "tool" ? " [one-shot]" : " [re-arms after compaction]"} — ${a.message.length > 120 ? `${a.message.slice(0, 117)}…` : a.message}`;
}

function deliver(pi: ExtensionAPI, ctx: ExtensionContext, a: Alert, why: string): void {
  a.fired = true;
  const { text } = usageLine(ctx);
  const who = a.source === "tool"
    ? `You registered this alert (${a.id}); it has now deregistered itself — re-register if you want another ping.`
    : "This is the default context alert.";
  pi.sendMessage(
    { customType: MESSAGE_TYPE, content: `[context-alert] ${text}. ${why} ${who}\n\n${a.message}`, display: true },
    { deliverAs: "steer", triggerTurn: true },
  );
  if (a.source === "tool") {
    // One-shot: tool alerts deregister on firing (and the persisted clear keeps them gone
    // across pi -c / revival — stale checkpoint reminders from finished work were refiring
    // in successor sessions). The default alert still re-arms after every compaction.
    alerts = alerts.filter((x) => x.id !== a.id);
    pi.appendEntry(ENTRY_TYPE, { op: "clear", id: a.id });
  }
}

export default function (pi: ExtensionAPI) {
  const d = defaultAlert();
  if (d) alerts = [d];

  pi.on("session_start", async (_event, ctx) => { restore(ctx); });

  pi.on("turn_end", async (_event, ctx) => {
    const { percent } = usageLine(ctx);
    if (percent == null) return;
    for (const a of alerts) {
      if (a.fired || percent < a.percent) continue;
      deliver(pi, ctx, a, `Threshold ${a.percent}% reached.`);
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.reason !== "threshold" || holdUsed) return undefined;
    const holder = alerts.find((a) => a.holdCompaction);
    if (!holder) return undefined;
    holdUsed = true;
    deliver(pi, ctx, holder, "Auto-compaction is about to run; it is held for ONE turn so you can checkpoint.");
    return { cancel: true };
  });

  pi.on("session_compact", async () => {
    holdUsed = false;
    for (const a of alerts) a.fired = false;
  });

  pi.registerTool({
    name: "context_alert",
    label: "Context alert",
    description: [
      "Read current context-window usage and register alerts that ping you when usage crosses a percentage, so you can checkpoint before auto-compaction.",
      "action 'status' (default): usage + registered alerts. action 'set': add/replace an alert (percent, message, optional id, optional holdCompaction to delay the first threshold compaction by one turn).",
      "action 'clear': remove one alert by id, or all tool-registered alerts.",
    ].join(" "),
    promptSnippet: "Check context usage / get pinged at a chosen % before auto-compaction",
    promptGuidelines: [
      "Use context_alert early in long tasks (many file reads, images, or search results) to register a checkpoint reminder, e.g. { action: \"set\", percent: 70, message: \"append finished blocks to REPORT.md\" }; when the alert arrives, do that before anything else.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "status | set | clear" })),
      percent: Type.Optional(Type.Number({ description: "1-99: fire when context usage reaches this percent of the window" })),
      message: Type.Optional(Type.String({ description: "what to remind yourself to do when it fires" })),
      id: Type.Optional(Type.String({ description: "alert id (default: auto); 'default' addresses the built-in alert" })),
      holdCompaction: Type.Optional(Type.Boolean({ description: "cancel the first threshold compaction once and deliver this alert instead" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = (params.action ?? "status").toLowerCase();
      const { text } = usageLine(ctx);
      if (action === "set") {
        const percent = Number(params.percent);
        if (!(percent >= 1 && percent <= 99)) return { content: [{ type: "text", text: "percent must be between 1 and 99" }], isError: true };
        const alert: Alert = {
          id: params.id?.trim() || `alert-${++seq}`,
          percent,
          message: params.message?.trim() || DEFAULT_MESSAGE,
          holdCompaction: params.holdCompaction === true,
          source: "tool",
          fired: false,
        };
        const idx = alerts.findIndex((a) => a.id === alert.id);
        if (idx >= 0) alerts[idx] = alert; else alerts.push(alert);
        pi.appendEntry(ENTRY_TYPE, { op: "set", alert });
        return { content: [{ type: "text", text: `registered ${alert.id}: ping at ${alert.percent}%${alert.holdCompaction ? " and hold the first compaction one turn" : ""}.\n${text}` }] };
      }
      if (action === "clear") {
        const id = params.id?.trim();
        if (id) alerts = alerts.filter((a) => a.id !== id); else alerts = alerts.filter((a) => a.source !== "tool");
        pi.appendEntry(ENTRY_TYPE, { op: "clear", ...(id ? { id } : {}) });
        return { content: [{ type: "text", text: `cleared ${id ?? "all tool-registered alerts"}.\n${text}` }] };
      }
      const list = alerts.length ? alerts.map(describe).join("\n") : "- none";
      return { content: [{ type: "text", text: `${text}\nalerts:\n${list}` }] };
    },
  });

  pi.registerCommand("context-alert", {
    description: "Show context usage and registered context alerts",
    handler: async (_args, ctx) => {
      const { text } = usageLine(ctx);
      ctx.ui.notify(`${text}\n${alerts.map(describe).join("\n") || "no alerts"}`, "info");
    },
  });
}
