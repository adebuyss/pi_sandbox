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
