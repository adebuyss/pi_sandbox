/**
 * purge-thinking: /purge-think — strip thinking/reasoning blocks from all
 * assistant messages up to the current point, while keeping thinking for
 * new turns. Reclaims context window without compaction.
 *
 * How it works:
 * - /purge-think records a timestamp marker (the current session leaf) and
 *   persists it as a custom session entry, so it survives /resume.
 * - Before every LLM call (the `context` event), `thinking` blocks are
 *   removed from assistant messages stamped at or before the marker and
 *   replaced with a single `[think(d)]` text marker, so the model can tell
 *   which turns had reasoning removed. Messages after the marker keep their
 *   thinking, so new turns behave normally.
 * - A short custom message is queued with the NEXT user prompt telling the
 *   agent that prior reasoning was purged, what the `[think(d)]` marker means,
 *   and to re-derive (not recall) reasoning for a specific marked message.
 *
 * Properties / trade-offs:
 * - Non-destructive: the session JSONL keeps the thinking; only outgoing
 *   LLM requests are trimmed while the marker is active. There is no
 *   "un-purge" other than a new session.
 * - The purge is permanent for the lifetime of this session (and resumes of
 *   it): once the marker is set, all pre-marker thinking is always hidden.
 * - Assistant messages that contained ONLY thinking keep their `[think(d)]`
 *   marker (a text block), so they remain a valid, non-empty turn instead of
 *   being dropped — the marker itself records that the turn happened.
 * - Works across compaction: the marker is a timestamp, and retained
 *   messages carry their original timestamps.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER_TYPE = "purge-thinking-marker";

/** Tombstone left in place of a purged turn's reasoning; explained in the note below. */
const MARKER = "[think(d)]";

/** Unix ms of the newest purge marker in this session, or null. */
let markerTs: number | null = null;

/**
 * The note delivered with the next user prompt. Explains the purge, the
 * `[think(d)]` marker, and how to answer questions about purged reasoning.
 * Sent when /purge-think runs AND re-sent on resume of an already-purged
 * session (so the guidance is present whenever markers are — testing showed
 * the model follows it when present and confabulates confidently when absent).
 */
const NOTE =
	"The user ran /purge-think: your internal thinking/reasoning from earlier turns has been removed " +
	"from context to save tokens. Every assistant turn whose reasoning was removed now shows a " +
	"`[think(d)]` marker where that reasoning used to be; a turn WITHOUT the marker either had no " +
	"hidden reasoning or comes after the purge point (its thinking is intact). Your visible replies " +
	"and the full conversation text are unchanged — only hidden reasoning was purged.\n" +
	"**IMPORTANT** When you are asked to recall or explain the reasoning behind a specific earlier " +
	"`[think(d)]`-marked message (e.g. \"how did you conclude X\", \"why did you say Y\"): do NOT claim " +
	"to remember it — that reasoning is gone. Re-derive it from the visible conversation, re-verify the " +
	"result against what you actually said in that message, and state explicitly that it is a " +
	"reconstruction, not your original reasoning. Continue normally.";

function sendNote(pi: ExtensionAPI): void {
	pi.sendMessage(
		{ customType: "purge-thinking-note", content: NOTE, display: true },
		{ deliverAs: "nextTurn" },
	);
}

interface EntryLike {
	type: string;
	customType?: string;
	timestamp?: string;
}

function readMarker(entries: EntryLike[]): number | null {
	let ts: number | null = null;
	for (const e of entries) {
		if (e.type === "custom" && e.customType === MARKER_TYPE && e.timestamp) {
			const t = Date.parse(e.timestamp);
			if (Number.isFinite(t) && (ts === null || t > ts)) ts = t;
		}
	}
	return ts;
}

export default function purgeThinkingExtension(pi: ExtensionAPI) {
	// (Re)compute the marker from the session's own entries on every
	// session start/resume/fork. This is self-healing: it works even if the
	// extension module instance is reused across session switches.
	pi.on("session_start", async (_event, ctx) => {
		markerTs = readMarker(ctx.sessionManager.getEntries() as unknown as EntryLike[]);
		// Resuming an already-purged session: the note was only queued in the
		// session where /purge-think was pressed, so re-send it here — otherwise
		// the agent sees [think(d)] markers with no explanation and confabulates.
		if (markerTs !== null) sendNote(pi);
	});

	// Strip thinking from pre-marker assistant messages on every LLM call, and
	// leave a `[think(d)]` tombstone in its place so the model can see WHICH turns
	// had reasoning removed (vs. turns that never had any, or post-marker turns
	// whose thinking is intact). event.messages is a fresh deep clone per call, so
	// in-place mutation is safe and the marker never accumulates across calls.
	// The marker is a text block (not a thinking block): universally valid and free
	// of the thinking-signature requirements some providers enforce on real thinking.
	pi.on("context", (event) => {
		if (markerTs === null) return;
		for (const m of event.messages) {
			if (m.role !== "assistant") continue;
			const am = m as { timestamp?: number; content?: unknown[] };
			if (typeof am.timestamp === "number" && am.timestamp > markerTs) continue;
			if (!Array.isArray(am.content)) continue;
			if (!am.content.some((b) => (b as { type?: string })?.type === "thinking")) continue;
			const kept = (am.content as { type?: string }[]).filter((b) => b?.type !== "thinking");
			kept.unshift({ type: "text", text: MARKER } as { type?: string });
			am.content = kept;
		}
	});

	pi.registerCommand("purge-think", {
		description:
			"Purge thinking/reasoning blocks from all prior turns (frees context tokens; new turns keep thinking)",
		handler: async (_args, ctx) => {
			const leaf = ctx.sessionManager.getLeafEntry();
			const leafTs = leaf?.timestamp ? Date.parse(leaf.timestamp) : NaN;
			if (!leaf || !Number.isFinite(leafTs)) {
				ctx.ui.notify("No session entries yet — nothing to purge.", "warn");
				return;
			}

			markerTs = markerTs !== null ? Math.max(markerTs, leafTs) : leafTs;
			pi.appendEntry(MARKER_TYPE, { at: leaf.timestamp, note: "thinking purged up to this point" });

			// Estimate the reclaim by scanning the current (compaction-aware)
			// context for thinking blocks at or before the marker.
			let blocks = 0;
			let chars = 0;
			for (const entry of ctx.sessionManager.buildContextEntries() as {
				type: string;
				timestamp?: string;
				message?: { role?: string; content?: { type?: string; thinking?: string }[] };
			}[]) {
				if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.timestamp) continue;
				const ts = Date.parse(entry.timestamp);
				if (!Number.isFinite(ts) || ts > leafTs) continue;
				for (const block of entry.message.content ?? []) {
					if (block?.type === "thinking") {
						blocks += 1;
						chars += block.thinking?.length ?? 0;
					}
				}
			}
			const tokens = Math.round(chars / 4);

			// Note to the agent, delivered with the next prompt (see NOTE above).
			sendNote(pi);

			ctx.ui.notify(
				`Purged ~${(tokens / 1000).toFixed(1)}k tokens of thinking (${blocks} blocks) from prior turns. ` +
					"Each purged turn now shows a [think(d)] marker; new turns keep thinking. " +
					"The purge persists across /resume of this session.",
				"info",
			);
		},
	});
}
