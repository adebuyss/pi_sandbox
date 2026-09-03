/**
 * preserve-thinking: independent on/off control of Qwen's preserve_thinking
 * chat-template kwarg, decoupled from the thinking level.
 *
 * Why: pi's qwen-chat-template compat hardcodes preserve_thinking: true, and
 * measured sessions carry 31-53% of their content as thinking blocks -- so
 * preserving prior-turn thinking roughly halves usable conversation depth.
 * Qwen's own multi-turn convention strips prior thinking (the model's training
 * distribution), making OFF the better default for long agent sessions; ON
 * remains available when mid-plan reasoning continuity matters more than
 * context depth.
 *
 * - `/preserve on|off|status` -- switch at any time; the choice is persisted as
 *   a custom session entry (survives `pi -c` and subagent revival), and a
 *   PI_PRESERVE_THINKING env (on|off) sets the starting default.
 * - Mechanism: before_provider_request rewrites payload.chat_template_kwargs
 *   .preserve_thinking when that object is present (i.e. qwen-chat-template /
 *   chat-template providers). Providers without template kwargs are untouched.
 * - Switching mid-session re-renders history on the next request (one-time
 *   prefix-cache miss; lmcache absorbs most of the refill).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "preserve-thinking";
const envDefault = (process.env.PI_PRESERVE_THINKING ?? "on").toLowerCase() !== "off";

export default function (pi: ExtensionAPI) {
  let preserve = envDefault;

  const paint = (ctx: ExtensionContext) => {
    // Footer indicator: muted when preserving (the long-standing default), accent when
    // stripping so the changed behavior stays visible.
    ctx.ui.setStatus("preserve-thinking",
      preserve ? ctx.ui.theme.fg("muted", "🧠 keep") : ctx.ui.theme.fg("accent", "🧠 strip"));
  };

  const apply = (value: boolean, ctx: ExtensionContext, announce = true) => {
    preserve = value;
    pi.appendEntry(ENTRY_TYPE, { preserve });
    paint(ctx);
    if (announce) {
      ctx.ui.notify(
        `preserve_thinking -> ${preserve ? "on" : "off"}. History re-renders on the next request` +
        (preserve ? "" : " (prior-turn thinking stripped: ~halves context spend per turn)."),
        "info",
      );
    }
  };

  const restore = (ctx: ExtensionContext) => {
    for (const entry of ctx.sessionManager.getBranch() as any[]) {
      if (entry?.customType === ENTRY_TYPE && typeof entry?.data?.preserve === "boolean") {
        preserve = entry.data.preserve;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => { restore(ctx); paint(ctx); });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Toggle preserve_thinking (keep/strip prior-turn thinking in rendered history)",
    handler: async (ctx: ExtensionContext) => { apply(!preserve, ctx); },
  });

  pi.on("before_provider_request", async (event) => {
    const p = event.payload as any;
    if (p && typeof p === "object" && p.chat_template_kwargs && typeof p.chat_template_kwargs === "object") {
      p.chat_template_kwargs.preserve_thinking = preserve;
    }
    return undefined; // payload mutated in place; no replacement needed
  });

  pi.registerCommand("preserve", {
    description: "Preserve prior-turn thinking in rendered history: /preserve on|off|status",
    getArgumentCompletions: (prefix: string) => {
      const p = (prefix || "").trim().toLowerCase();
      const items = ["on", "off", "status"].filter((v) => v.startsWith(p)).map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        apply(arg === "on", ctx);
        return;
      }
      ctx.ui.notify(
        `preserve_thinking is ${preserve ? "on" : "off"} (default from PI_PRESERVE_THINKING: ${envDefault ? "on" : "off"}). Use /preserve on|off.`,
        "info",
      );
    },
  });
}
