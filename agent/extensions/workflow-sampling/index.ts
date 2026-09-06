/**
 * workflow-sampling: pick a sampling profile per workload, instead of one global setting.
 *
 * Qwen ships ONE generation_config (thinking-mode sampling: temp 1.0 / top_p 0.95 / top_k 20, and
 * notably NO repetition penalty). vLLM applies it to every request that does not override it, and
 * pi sends no sampling params at all -- so every workload gets identical sampling whether it is
 * translating a manga page or writing a regex. Each preset below overrides only what its workload
 * measurably needs, and only when the client has not set that field itself.
 *
 * Presets are grounded in measurements on this box (2026-09-04), not vibes:
 *
 *  translate  presence_penalty 1.0
 *      Pages dense in repeated punctuation (!!!, ……, ーーー) drive token-level loops: one live
 *      session degenerated into an unbounded "!!! - !!! - !!!" tail and had to be aborted, and a
 *      227-page batch run lost 59 pages the same way until presence_penalty was added. 1.0 rather
 *      than the batch driver's 1.5 because Qwen warns higher values can cause language mixing --
 *      the one failure mode a JA->EN job can least afford.
 *
 *  code       (no overrides yet)
 *      Warm sampling flips ~1-2% of generated code into a syntax error (measured across FP8 and
 *      every 4-bit build alike -- model-inherent, not quantization damage). min_p 0.05 is the
 *      candidate fix, but Qwen recommends min_p 0.0 for both modes and the idea is untested here,
 *      so the preset ships empty rather than shipping an unmeasured deviation.
 *
 *  default    nothing -- the model's own generation_config, untouched.
 *
 * Independently of the chosen preset, a presence_penalty floor of 0.5 is applied to any request
 * with thinking explicitly on that has not set one (see THINKING_PRESENCE_FLOOR). Loop risk
 * tracks the MODE, not the workload, so protection cannot depend on remembering to pick a preset.
 *
 * Explicit client parameters always win: a request that already sets presence_penalty keeps it.
 * The choice persists as a session entry (survives `pi -c` and subagent revival) and can be
 * preselected with PI_WORKFLOW.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "workflow-sampling";

interface Preset {
  params: Record<string, number>;
  badge: string;
  why: string;
}

const PRESETS: Record<string, Preset> = {
  default: { params: {}, badge: "", why: "model defaults (no overrides)" },
  translate: {
    params: { presence_penalty: 1.0 },
    badge: "🈯 translate",
    why: "presence_penalty 1.0 — breaks the !!!/…… token loops that repeated punctuation induces",
  },
  // No overrides yet, on purpose. min_p 0.05 is the obvious candidate -- it would discard the
  // sub-5%-of-leader band where the measured ~1-2% warm-sampling bracket flips live -- but Qwen
  // recommends min_p 0.0 for BOTH modes, and the idea has never been measured on this box. The
  // translate preset deviates from the official set to fix an OBSERVED failure; deviating here
  // would be fixing a hypothesised one. Test first: quality-battery.py --light --runs 100 with
  // and without min_p, against the recorded 1.2% baseline (q5-orig, n=500), then fill this in.
  code: { params: {}, badge: "⌨ code", why: "no overrides (min_p candidate pending measurement)" },
};

// Applied on top of ANY preset when the request has thinking explicitly on and the caller set no
// presence_penalty. Loop risk is a property of the MODE, not the workload -- Qwen's non-thinking
// preset carries presence_penalty 1.5 but its thinking preset carries 0.0, and the proxy injects
// the non-thinking set only when enable_thinking is false (app.py:667). A thinking request
// therefore arrives with no repetition protection whatever, which is the configuration that
// degenerated into an unbounded "!!! - !!!" tail on a live high-effort session. Qwen's documented
// remedy -- "adjust presence_penalty between 0 and 2 to reduce endless repetition" -- is not
// scoped to a mode, so this sits inside the sanctioned range. 0.5, not 1.5: enough to break
// token-level loops, well under where Qwen warns of language mixing (fatal for a JA->EN job).
const THINKING_PRESENCE_FLOOR = 0.5;

// Only an EXPLICIT true. An absent flag is model-dependent -- stock Qwen's template reads
// undefined as thinking-off, both abliterated builds read it as thinking-on -- so guessing would
// silently apply a penalty to non-thinking traffic on one model and not the other. pi always
// sends the flag, so nothing is lost by being strict.
const thinkingOn = (p: any): boolean =>
  p?.chat_template_kwargs?.enable_thinking === true;

const envDefault = (() => {
  const v = (process.env.PI_WORKFLOW ?? "default").toLowerCase();
  return v in PRESETS ? v : "default";
})();

export default function (pi: ExtensionAPI) {
  let current = envDefault;

  const paint = (ctx: ExtensionContext) => {
    const badge = PRESETS[current]?.badge;
    ctx.ui.setStatus("workflow-sampling", badge ? ctx.ui.theme.fg("accent", badge) : undefined);
  };

  const apply = (name: string, ctx: ExtensionContext, announce = true) => {
    current = name;
    pi.appendEntry(ENTRY_TYPE, { workflow: current });
    paint(ctx);
    if (announce) {
      ctx.ui.notify(`workflow -> ${current}: ${PRESETS[current].why}`, "info");
    }
  };

  const restore = (ctx: ExtensionContext) => {
    for (const entry of ctx.sessionManager.getBranch() as any[]) {
      const w = entry?.data?.workflow;
      if (entry?.customType === ENTRY_TYPE && typeof w === "string" && w in PRESETS) {
        current = w;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => { restore(ctx); paint(ctx); });

  pi.on("before_provider_request", async (event) => {
    const p = event.payload as any;
    const preset = PRESETS[current];
    if (!p || typeof p !== "object" || !preset) return undefined;
    for (const [k, v] of Object.entries(preset.params)) {
      if (p[k] === undefined) p[k] = v;   // never override what the caller set deliberately
    }
    // After the preset, so translate's explicit 1.0 stands and only an unset field is filled.
    if (thinkingOn(p) && p.presence_penalty === undefined) {
      p.presence_penalty = THINKING_PRESENCE_FLOOR;
    }
    return undefined;                      // payload mutated in place
  });

  pi.registerShortcut(Key.ctrlAlt("w"), {
    description: "Cycle the sampling workflow (default -> translate -> code)",
    handler: async (ctx: ExtensionContext) => {
      const names = Object.keys(PRESETS);
      apply(names[(names.indexOf(current) + 1) % names.length], ctx);
    },
  });

  pi.registerCommand("workflow", {
    description: `Sampling profile for this workload: /workflow ${Object.keys(PRESETS).join("|")}|status`,
    getArgumentCompletions: (prefix: string) => {
      const q = (prefix || "").trim().toLowerCase();
      const items = [...Object.keys(PRESETS), "status"]
        .filter((v) => v.startsWith(q)).map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg in PRESETS) {
        apply(arg, ctx);
        return;
      }
      const lines = Object.entries(PRESETS).map(([n, p]) =>
        `${n === current ? "*" : " "} ${n.padEnd(10)} ${JSON.stringify(p.params)}  ${p.why}`);
      ctx.ui.notify(`workflow: ${current} (default from PI_WORKFLOW: ${envDefault})\n${lines.join("\n")}`, "info");
    },
  });
}
