/**
 * mcp-lazy: keep heavyweight tool groups out of the prompt (and the request
 * tools array) until they are needed, to save context (~15k tokens across all
 * default groups). Instead of shipping the full schemas, each hidden group is
 * advertised as ONE cheap "door" tool — load_web, load_exa, load_mcp,
 * load_ide, load_preview (plus load_all, and load_ctx if ctx is hidden) — that the
 * model can see and call. On call, the door swaps itself out for the group's real tools.
 *
 * Why doors instead of a single mcp_load + a skill: models trust their tool
 * list over prose, so a visible per-group tool is far more likely to be used
 * than an instruction to call a generic loader (verified: a model with the
 * group merely described in a skill routed around the missing tool instead).
 *
 * pi has no API to run a tool on the model's behalf, so loading is still a
 * two-step "open the door, then use what's inside" — but the door makes step
 * one reliably happen.
 *
 * To keep a group ALWAYS active (never hidden, no door), remove it from
 * DEFAULT_HIDDEN below.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// group -> matcher for that group's REAL tools, and a capability one-liner that
// carries the routing (a need must map to exactly one group from this text).
const GROUPS: Record<string, { match: (n: string) => boolean; blurb: string }> = {
	web: {
		match: (n) => ["web_search", "source_check", "fetch_content", "get_search_content"].includes(n),
		blurb: "search the web, fetch & read URLs, verify claims",
	},
	exa: {
		match: (n) => n.startsWith("exa_"),
		blurb: "semantic/neural web search, find similar pages, clean content extraction",
	},
	ctx: {
		match: (n) => n.startsWith("ctx_"),
		blurb: "run code in the sandbox over large files; index & search a knowledge base",
	},
	mcp: {
		match: (n) => n === "mcp" || n === "mcpScript",
		blurb: "call external MCP servers (single call or multi-call script)",
	},
	ide: {
		match: (n) => n === "get_ide_diagnostics",
		blurb: "read VS Code errors/warnings (needs the IDE bridge)",
	},
	preview: {
		match: (n) => n === "preview_export",
		blurb: "export Markdown/LaTeX to PDF/HTML/PNG",
	},
};

// NOTE: ctx is intentionally NOT hidden. context-mode registers its ctx_* tools
// via an async MCP server that activates them AFTER this extension's hooks run, so
// hiding ctx is unreliable (the tools leak back in mid-turn) and it fights
// context-mode's own guidance. Add "ctx" back only if that changes upstream.
const DEFAULT_HIDDEN: string[] = ["web", "exa", "mcp", "ide", "preview"];
const stubName = (g: string): string => `load_${g}`;

export default function mcpLazyExtension(pi: ExtensionAPI) {
	const hidden = new Set(DEFAULT_HIDDEN);

	const groupOf = (n: string): string | undefined =>
		Object.keys(GROUPS).find((g) => GROUPS[g].match(n));
	const isRealManaged = (n: string): boolean => groupOf(n) !== undefined;
	const isRealHidden = (n: string): boolean => {
		const g = groupOf(n);
		return g !== undefined && hidden.has(g);
	};
	const isStub = (n: string): boolean =>
		n === "load_all" || (n.startsWith("load_") && GROUPS[n.slice(5)] !== undefined);
	// A door shows only while there is something behind it to open.
	const stubShouldShow = (n: string): boolean =>
		n === "load_all" ? hidden.size > 0 : hidden.has(n.slice(5));

	/**
	 * Reconcile the active tool set: hide real tools of hidden groups, show real
	 * tools of loaded groups, show a group's door only while it is still hidden.
	 * Non-managed tools are left untouched.
	 */
	const apply = (): void => {
		const active = new Set(pi.getActiveTools());
		const before = active.size;
		let mutated = false;
		for (const name of pi.getAllTools().map((t) => t.name)) {
			let want: boolean | undefined;
			if (isStub(name)) want = stubShouldShow(name);
			else if (isRealManaged(name)) want = !isRealHidden(name);
			else continue;
			const has = active.has(name);
			if (want && !has) { active.add(name); mutated = true; }
			else if (!want && has) { active.delete(name); mutated = true; }
		}
		if (mutated || active.size !== before) pi.setActiveTools([...active]);
	};

	pi.on("session_start", () => apply());

	// Safety net each turn: package extensions (re-)register tools on their own
	// lifecycle, so re-assert the hidden set right before the agent loop and keep
	// the prompt's selectedTools list consistent (drop hidden real tools; doors stay).
	pi.on("before_agent_start", (event) => {
		apply();
		const sel = event.systemPromptOptions?.selectedTools;
		if (sel && sel.some(isRealHidden)) {
			event.systemPromptOptions.selectedTools = sel.filter((n) => !isRealHidden(n));
		}
	});

	const load = (groups: string[]): string => {
		for (const g of groups) hidden.delete(g);
		apply();
		const active = new Set(pi.getActiveTools());
		const opened = groups.flatMap((g) =>
			pi.getAllTools().map((t) => t.name).filter((n) => GROUPS[g].match(n)),
		);
		const enabled = opened.filter((n) => active.has(n));
		const missing = opened.filter((n) => !active.has(n));
		if (!enabled.length)
			return `No matching tools are registered in this session${missing.length ? ` (expected: ${missing.join(", ")})` : ""}.`;
		let msg = `Enabled: ${enabled.join(", ")}. These are available now — call the one you need in your next step (same turn).`;
		if (missing.length) msg += ` Not registered in this session: ${missing.join(", ")}.`;
		return msg;
	};

	const register = (name: string, blurb: string, groups: () => string[]) =>
		pi.registerTool({
			name,
			label: `Enable: ${name.slice(5)}`,
			description: `Enable on-demand tools — ${blurb}. Their full schemas are kept out of context to save tokens; call this first, then use the tools it unlocks (they go live the same turn).`,
			promptSnippet: `${name} — enable ${name.slice(5)} tools (${blurb})`,
			parameters: Type.Object({}),
			async execute() {
				const todo = groups().filter((g) => hidden.has(g));
				const text = todo.length ? load(todo) : `Already active.`;
				return { content: [{ type: "text", text }] };
			},
		});

	for (const g of Object.keys(GROUPS)) register(stubName(g), GROUPS[g].blurb, () => [g]);
	register("load_all", "every hidden group at once (big research sessions)", () => Object.keys(GROUPS));
}
