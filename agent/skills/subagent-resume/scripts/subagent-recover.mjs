#!/usr/bin/env node
// subagent-recover: find pi-subagents children whose run state is gone (the
// sandbox's /tmp is a tmpfs) but whose session files survived, and make them
// resumable again with the package's own `subagent({ action: "resume" })`.
//
//   list    [--all-parents] [--json] [--session-file F]
//   show    <runId-or-prefix> [--max-chars N]
//   rebuild <runId-or-prefix> [--index N] [--agent NAME] [--session-id ID]
//           [--force] [--dry-run]
//
// Read-only except `rebuild`, which writes <tempRoot>/async-subagent-runs/<runId>/status.json
// plus the .terminal-runs marker that makes `status` / `children.list` see it.
// Mirrors pi-subagents 0.54/0.62 internals: TEMP_ROOT_DIR / resolveTempScopeId
// (src/shared/types.ts), encodeIndexSegment (src/runs/background/index-segment.ts),
// AsyncStatus (types.ts) as consumed by resolveAsyncResumeTarget (async-resume.ts).
// Re-check those when the package is bumped.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const VERIFIED_PKG_MAJOR_MINOR = ["0.54", "0.62"]; // pi-subagents versions the status.json shape was checked against
const TAIL_BYTES = 512 * 1024;      // how much of a transcript/session we read for the last answer
const HEAD_BYTES = 16 * 1024;       // enough for the session header + first model_change

// ---------- paths (kept identical to pi / pi-subagents) ----------
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");

function sanitizeTempScopeSegment(value) {
  const s = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "unknown";
}
function resolveTempScopeId() {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"]) if (process.env[key]) return `user-${sanitizeTempScopeSegment(process.env[key])}`;
  try { const u = os.userInfo().username; if (u) return `user-${sanitizeTempScopeSegment(u)}`; } catch {}
  const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  return home ? `home-${sanitizeTempScopeSegment(home)}` : "shared";
}
const TEMP_ROOT = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim()
  ? path.resolve(process.env.PI_SUBAGENTS_TEMP_ROOT.trim())
  : path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
const ASYNC_ROOT = path.join(TEMP_ROOT, "async-subagent-runs");
const EXCLUSIONS_FILE = process.env.PI_MODEL_EXCLUSIONS_PATH?.trim() || path.join(TEMP_ROOT, "model-exclusions.json");

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
function encodeIndexSegment(value) {
  let enc;
  try { enc = encodeURIComponent(value); } catch { return `~sha256-${createHash("sha256").update(value).digest("hex")}`; }
  const portable = enc.length > 0 && enc !== "." && enc !== ".." && !enc.endsWith(".")
    && !WINDOWS_RESERVED.test(enc) && !/%5C/i.test(enc) && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(enc);
  if (Buffer.byteLength(enc, "utf-8") <= 255 && portable) return enc;
  return `~sha256-${createHash("sha256").update(value).digest("hex")}`;
}

// pi's getDefaultSessionDirPath(): "--" + cwd minus leading "/" with [/\:] -> "-" + "--"
function cwdKeyDir(cwd) {
  return path.join(SESSIONS_DIR, `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
}

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {}; const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { positional.push(a); continue; }
  const name = a.slice(2);
  if (["all-parents", "json", "force", "dry-run", "help"].includes(name)) flags[name] = true;
  else flags[name] = argv[++i];
}
if (!cmd || cmd === "help" || flags.help) { usage(); process.exit(cmd ? 0 : 2); }

function usage() {
  console.log(`subagent-recover — recover pi-subagents children after a turn or container died

  list    [--all-parents] [--json] [--session-file F]   children with surviving session files
  show    <runId|prefix> [--max-chars N]                 paths + the child's last answer
  rebuild <runId|prefix> [--index N] [--agent NAME] [--session-id ID] [--force] [--dry-run]
          write status.json so subagent({ action: "resume", id }) can revive the child
  repair  <runId|prefix> [--index N] [--file F] [--force] [--dry-run]
          trim a severed tail (empty/error assistant turns, dangling tool calls) off the
          session file so pi can continue/revive it; backs up the original first

Env used: PI_SESSION_FILE / PI_SESSION_ID (pi's bash tool sets them), PI_CODING_AGENT_DIR,
          PI_SUBAGENTS_TEMP_ROOT, PI_MODEL_EXCLUSIONS_PATH.`);
}

// ---------- discovery ----------
const sessionFileArg = flags["session-file"] ?? process.env.PI_SESSION_FILE;
const keyDir = sessionFileArg ? path.dirname(path.resolve(sessionFileArg)) : cwdKeyDir(process.cwd());
const currentParent = sessionFileArg ? path.basename(sessionFileArg, ".jsonl") : undefined;

function parentDirs(all) {
  let entries = [];
  try { entries = fs.readdirSync(keyDir, { withFileTypes: true }); } catch { return []; }
  const dirs = entries.filter((e) => e.isDirectory() && e.name !== "subagent-artifacts").map((e) => path.join(keyDir, e.name));
  if (!all && currentParent) return dirs.filter((d) => path.basename(d) === currentParent);
  return dirs.map((d) => ({ d, m: safeStat(d)?.mtimeMs ?? 0 })).sort((a, b) => b.m - a.m).map((x) => x.d);
}
function safeStat(p) { try { return fs.statSync(p); } catch { return undefined; } }

function walkJsonl(dir, depth = 0, out = []) {
  if (depth > 5) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function readHead(file) {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(HEAD_BYTES); const n = fs.readSync(fd, b, 0, HEAD_BYTES, 0); return b.toString("utf-8", 0, n); }
  finally { fs.closeSync(fd); }
}
function readTailLines(file, bytes = TAIL_BYTES) {
  const st = safeStat(file); if (!st) return [];
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, "r");
  let text;
  try { const b = Buffer.alloc(st.size - start); fs.readSync(fd, b, 0, b.length, start); text = b.toString("utf-8"); }
  finally { fs.closeSync(fd); }
  const lines = text.split("\n");
  if (start > 0) lines.shift(); // partial first line
  return lines;
}
function parseJsonLines(lines) {
  const out = [];
  for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
const oneLine = (s, n) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  return "";
}
function lastAssistantFromTranscript(file) {
  let last;
  for (const r of parseJsonLines(readTailLines(file))) {
    if (r?.recordType !== "message") continue;
    const role = r.role ?? r.message?.role;
    if (role !== "assistant") continue;
    const t = typeof r.text === "string" ? r.text : textOf(r.message?.content);
    if (t?.trim()) last = t;
  }
  return last;
}
function lastAssistantFromSession(file) {
  let last;
  for (const r of parseJsonLines(readTailLines(file))) {
    if (r?.type !== "message" || r.message?.role !== "assistant") continue;
    const t = textOf(r.message.content);
    if (t?.trim()) { last = t; continue; }
    // no prose: describe the tool call(s) the child was making instead
    const calls = Array.isArray(r.message.content) ? r.message.content.filter((c) => c?.type === "toolCall") : [];
    if (calls.length) last = calls.map((c) => `[tool ${c.name}: ${oneLine(JSON.stringify(c.arguments ?? {}), 200)}]`).join("\n");
  }
  return last;
}
function sessionHeader(file) {
  const out = {};
  for (const r of parseJsonLines(readHead(file).split("\n").slice(0, -1))) {
    if (r?.type === "session") { out.id = r.id; out.cwd = r.cwd; out.timestamp = r.timestamp; out.parentSession = r.parentSession; }
    if (r?.type === "model_change" && !out.model) out.model = `${r.provider}/${r.modelId}`;
    if (out.id && out.model) break;
  }
  return out;
}
// pi-subagents names every child session "subagent-<agent>-<runId>-<n>" (session_info entry).
// In fork-context children it sits after the copied parent history, so scan in chunks until found.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_INFO_NAME = new RegExp(`"name":"subagent-(.+?)-(${UUID})-(\\d+)"`);
function sessionInfoIdentity(file) {
  const fd = fs.openSync(file, "r");
  try {
    const chunk = 1024 * 1024; const b = Buffer.alloc(chunk); let pos = 0; let carry = "";
    for (;;) {
      const n = fs.readSync(fd, b, 0, chunk, pos);
      if (n <= 0) return undefined;
      const text = carry + b.toString("utf-8", 0, n);
      const m = text.match(SESSION_INFO_NAME);
      if (m) return { agent: m[1], runId: m[2], index: Number(m[3]) - 1 };
      carry = text.slice(-300); pos += n;
    }
  } finally { fs.closeSync(fd); }
}

function artifactsFor(runId) {
  const dir = path.join(keyDir, "subagent-artifacts");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(`${runId}_`)); } catch {}
  const byIndex = new Map();
  for (const n of names) {
    // {runId}_{agent}[_{index}]_{kind} — the index is omitted for single runs
    const rest = n.slice(runId.length + 1);
    const m = rest.match(/^(.*?)(?:_(\d+))?_(meta\.json|transcript\.jsonl|output\.md|input\.md)$/) ?? rest.match(/^(.*?)(?:_(\d+))?\.jsonl$/);
    if (!m) continue;
    const [, agent, idx = "0", kind = "events.jsonl"] = m;
    const entry = byIndex.get(Number(idx)) ?? { agent };
    entry[kind] = path.join(dir, n);
    byIndex.set(Number(idx), entry);
  }
  return byIndex;
}

function discover(all) {
  const runs = [];
  for (const parent of parentDirs(all)) {
    for (const file of walkJsonl(parent)) {
      const rel = path.relative(parent, file).split(path.sep);
      if (rel.length < 2) continue;
      // Layouts: <runId>/run-N/session.jsonl (workflow children), <runId>/async-<id>/<ts>_<uuid>.jsonl
      // (top-level async), forks/<ts>_<uuid>.jsonl (fork-context children; run id only inside the file).
      const uuidRe = new RegExp(`^${UUID}$`);
      let runId = uuidRe.test(rel[0]) ? rel[0] : undefined;
      const idxSeg = rel.find((s) => /^run-\d+$/.test(s));
      let index = idxSeg ? Number(idxSeg.slice(4)) : 0;
      const hdr = sessionHeader(file);
      let art = runId ? artifactsFor(runId).get(index) ?? {} : {};
      let meta;
      if (art["meta.json"]) { try { meta = JSON.parse(fs.readFileSync(art["meta.json"], "utf-8")); } catch {} }
      let agent = meta?.agent ?? art.agent;
      if (!runId || !agent) {
        const ident = sessionInfoIdentity(file);
        if (ident) {
          runId ??= ident.runId; agent ??= ident.agent; if (!idxSeg) index = ident.index;
          if (!art["meta.json"]) {
            art = artifactsFor(runId).get(index) ?? {};
            if (art["meta.json"]) { try { meta = JSON.parse(fs.readFileSync(art["meta.json"], "utf-8")); } catch {} }
            agent = meta?.agent ?? art.agent ?? agent;
          }
        }
      }
      runId ??= hdr.id; // last resort: the child's own session id works as a run id too
      if (!runId) continue;
      const st = safeStat(file);
      const live = safeStat(path.join(ASYNC_ROOT, runId, "status.json"))
        ? (() => { try { return JSON.parse(fs.readFileSync(path.join(ASYNC_ROOT, runId, "status.json"), "utf-8")).state; } catch { return "unreadable"; } })()
        : undefined;
      runs.push({
        runId, index, parent: path.basename(parent), sessionFile: file,
        sizeBytes: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0,
        startedAt: hdr.timestamp ? Date.parse(hdr.timestamp) : (st?.birthtimeMs || st?.mtimeMs),
        cwd: hdr.cwd, model: hdr.model, childSessionId: hdr.id,
        agent, exitCode: meta?.exitCode, error: meta?.error, durationMs: meta?.durationMs,
        transcript: art["transcript.jsonl"], meta: art["meta.json"], output: art["output.md"], input: art["input.md"],
        liveStatus: live,
      });
    }
  }
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function lastAnswer(run) {
  return (run.transcript && lastAssistantFromTranscript(run.transcript)) || lastAssistantFromSession(run.sessionFile) || "";
}
function findRun(runs, needle) {
  const hits = runs.filter((r) => r.runId === needle || r.runId.startsWith(needle));
  const ids = [...new Set(hits.map((r) => r.runId))];
  if (ids.length === 0) fail(`no child session found for '${needle}' (try --all-parents via list to see what exists)`);
  if (ids.length > 1) fail(`ambiguous prefix '${needle}': ${ids.join(", ")}`);
  return hits;
}
function fail(msg) { console.error(`subagent-recover: ${msg}`); process.exit(1); }
function activeExclusions() {
  try {
    const data = JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, "utf-8"));
    const now = Date.now();
    return (data.exclusions ?? []).filter((e) => e.expiresAt > now);
  } catch { return []; }
}
function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "npm", "node_modules", "pi-subagents", "package.json"), "utf-8")).version; } catch { return undefined; }
}
const iso = (ms) => (ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : "-");
const mb = (b) => `${(b / 1048576).toFixed(1)}M`;

// ---------- commands ----------
// Note: never process.exit() after printing — a piped stdout would be truncated.
function cmdList() {
  const all = Boolean(flags["all-parents"]);
  const runs = discover(all).map((r) => ({ ...r, lastAnswer: oneLine(lastAnswer(r), 90) }));
  const excl = activeExclusions();
  if (flags.json) {
    console.log(JSON.stringify({ keyDir, asyncRoot: ASYNC_ROOT, exclusions: excl, runs }, null, 2));
    return;
  }
  console.log(`session dir : ${keyDir}`);
  console.log(`parents     : ${all ? "all" : currentParent ?? "(none — no PI_SESSION_FILE; pass --session-file or --all-parents)"}`);
  console.log(`async root  : ${ASYNC_ROOT}${safeStat(ASYNC_ROOT) ? "" : "  (missing — run state did not survive; use rebuild)"}`);
  if (excl.length) {
    console.log("MODEL EXCLUSIONS (pi-subagents silently skips these until they expire; only a pi restart clears them):");
    for (const e of excl) console.log(`  - ${e.provider ? `${e.provider}/` : ""}${e.modelId ?? "*"}  until ${iso(e.expiresAt)}  (${oneLine(e.reason, 70)})`);
  }
  if (!runs.length) { console.log("no child sessions found"); return; }
  console.log("\nrunId    idx agent      ended                 size   exit  native   last answer / error");
  for (const r of runs) {
    const state = r.liveStatus ? `live:${r.liveStatus}` : "none";
    const exit = r.exitCode === undefined ? "?" : String(r.exitCode);
    const tail = r.error ? `ERR ${oneLine(r.error, 60)}` : r.lastAnswer;
    console.log(`${r.runId.slice(0, 8)} ${String(r.index).padEnd(3)} ${(r.agent ?? "?").padEnd(10).slice(0, 10)} ${iso(r.mtimeMs).padEnd(21)} ${mb(r.sizeBytes).padStart(6)} ${exit.padEnd(5)} ${state.padEnd(8)} ${tail}`);
  }
  console.log(`\n${runs.length} child session(s). Next: show <runId> for the full last answer, rebuild <runId> to make it resumable.`);
}

function cmdShow() {
  const needle = positional[0] ?? fail("show needs a runId or prefix");
  const hits = findRun(discover(true), needle);
  const max = Number(flags["max-chars"] ?? 16000);
  for (const r of hits) {
    console.log(`runId      : ${r.runId}  (index ${r.index}, agent ${r.agent ?? "?"}, parent ${r.parent})`);
    console.log(`session    : ${r.sessionFile}  ${mb(r.sizeBytes)}  ended ${iso(r.mtimeMs)}`);
    if (r.transcript) console.log(`transcript : ${r.transcript}`);
    if (r.output) console.log(`output     : ${r.output}`);
    if (r.meta) console.log(`meta       : ${r.meta}`);
    console.log(`model      : ${r.model ?? "?"}   exit ${r.exitCode ?? "?"}${r.error ? `   error: ${r.error}` : ""}`);
    console.log(`native run : ${r.liveStatus ? `status.json present, state ${r.liveStatus} — use subagent resume directly` : "no status.json — rebuild first"}`);
    const ans = lastAnswer(r);
    console.log(`\n── last assistant message (${ans.length} chars${ans.length > max ? `, showing ${max}` : ""}) ──\n${ans.slice(0, max)}\n`);
  }
}

function cmdRebuild() {
  const needle = positional[0] ?? fail("rebuild needs a runId or prefix");
  let hits = findRun(discover(true), needle);
  if (flags.index !== undefined) hits = hits.filter((r) => r.index === Number(flags.index));
  if (hits.length === 0) fail(`no child with index ${flags.index}`);
  if (hits.length > 1) fail(`run has ${hits.length} children (indexes ${hits.map((r) => r.index).join(", ")}); pass --index`);
  const r = hits[0];
  // pi-subagents' session identity is the session FILE PATH when the session is persisted
  // (resolveCurrentSessionId: getSessionFile() ?? getSessionId()), so prefer PI_SESSION_FILE.
  const sessionId = flags["session-id"] ?? process.env.PI_SESSION_FILE ?? process.env.PI_SESSION_ID;
  if (!sessionId) fail("PI_SESSION_FILE / PI_SESSION_ID are not set (run this from pi's bash tool) — or pass --session-id <session file path>");
  const agent = flags.agent ?? r.agent;
  if (!agent) fail("could not determine the agent (no meta.json) — pass --agent NAME");
  const v = pkgVersion();
  if (v && !VERIFIED_PKG_MAJOR_MINOR.some((mm) => v.startsWith(`${mm}.`))) console.error(`warning: pi-subagents ${v} installed; status.json shape verified against ${VERIFIED_PKG_MAJOR_MINOR.join("/")} only`);
  const asyncDir = path.join(ASYNC_ROOT, r.runId);
  const statusPath = path.join(asyncDir, "status.json");
  if (safeStat(statusPath) && !flags.force) fail(`${statusPath} already exists — native resume should work; use --force to overwrite`);
  const cwd = r.cwd ?? process.cwd();
  if (!safeStat(cwd)) fail(`child cwd '${cwd}' does not exist here; resume would refuse it`);
  const startedAt = Math.floor(r.startedAt ?? r.mtimeMs);
  const endedAt = Math.floor(r.mtimeMs);
  const status = {
    runId: r.runId, sessionId, mode: "workflow", state: "failed",
    error: `rebuilt by subagent-recover: original run state was lost (container/turn died); child session file persisted${r.error ? ` — last recorded error: ${r.error}` : ""}`,
    startedAt, endedAt, lastUpdate: endedAt, cwd,
    sessionRoot: path.dirname(path.join(keyDir, r.parent, r.runId)),
    sessionFile: r.sessionFile,
    steps: [{ agent, status: "failed", sessionFile: r.sessionFile, startedAt, endedAt, ...(r.error ? { error: r.error } : {}) }],
  };
  const marker = path.join(ASYNC_ROOT, ".terminal-runs", encodeIndexSegment(sessionId), `${String(endedAt).padStart(16, "0")}-${encodeIndexSegment(r.runId)}.json`);
  const markerBody = { version: 1, runId: r.runId, sessionId, endedAt };
  const resumeCall = `subagent({ action: "resume", id: "${r.runId}", message: "Your previous process died at ${iso(endedAt)}${r.error ? ` (${oneLine(r.error, 60)})` : ""}. First write every result you already have to disk, then continue from where you were." })`;
  if (flags["dry-run"]) {
    console.log(`would write ${statusPath}\n${JSON.stringify(status, null, 2)}\nand ${marker}\n${JSON.stringify(markerBody)}\nthen: ${resumeCall}`);
    return;
  }
  for (const [file, body] of [[statusPath, status], [marker, markerBody]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  console.log(`rebuilt ${statusPath}`);
  console.log(`session  ${r.sessionFile} (${mb(r.sizeBytes)}, agent ${agent})`);
  console.log(`\nNow revive it (the child continues with its full previous context):\n  ${resumeCall}`);
}

// ---------- repair ----------
// A child severed mid-turn (model server crash, kill) leaves its session ending in records pi
// cannot continue from: an assistant message with empty content and stopReason "error" (the 500),
// a thinking-only fragment, or toolCalls whose toolResults never arrived. pi's continue refuses
// assistant-last transcripts ("Cannot continue from message role: assistant"), and replaying an
// empty assistant or a dangling toolCall breaks revives at the API level too. Trimming back to the
// last user/toolResult message loses only the severed turn — the model re-generates it on resume.
function tailDiagnosis(records) {
  let anchor = -1;
  for (let i = 0; i < records.length; i++) {
    const role = records[i]?.message?.role;
    if (role === "user" || role === "toolResult") anchor = i;
  }
  const tail = records.slice(anchor + 1);
  const assistants = tail.filter((r) => r?.message?.role === "assistant");
  const damaged = assistants.filter((r) => {
    const m = r.message; const c = Array.isArray(m.content) ? m.content : [];
    const types = c.map((p) => p?.type);
    if (c.length === 0) return true;                                  // severed: nothing came back
    if (m.stopReason === "error") return true;                        // severed: engine died mid-turn
    if (types.includes("toolCall")) return true;                      // dangling: results never arrived
    if (types.every((t) => t === "thinking")) return true;            // fragment: no visible output
    return false;
  });
  return { anchor, tail, assistants, damaged };
}

function cmdRepair() {
  let file = flags.file;
  let label = file;
  if (!file) {
    const needle = positional[0] ?? fail("repair needs a runId or prefix (or --file F)");
    let hits = findRun(discover(true), needle);
    if (flags.index !== undefined) hits = hits.filter((r) => r.index === Number(flags.index));
    if (hits.length === 0) fail(`no child with index ${flags.index}`);
    if (hits.length > 1) fail(`run has ${hits.length} children (indexes ${hits.map((r) => r.index).join(", ")}); pass --index`);
    file = hits[0].sessionFile; label = `${hits[0].runId.slice(0, 8)} (${file})`;
  }
  if (!safeStat(file)) fail(`no such file: ${file}`);
  const rawLines = fs.readFileSync(file, "utf-8").split("\n");
  while (rawLines.length && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();
  const records = rawLines.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const { anchor, tail, damaged } = tailDiagnosis(records);
  if (anchor < 0) fail("no user/toolResult message found — refusing to trim the whole session");
  if (tail.length === 0) { console.log(`${label}: already ends on user/toolResult — nothing to repair`); return; }
  if (damaged.length === 0 && !flags.force) {
    console.log(`${label}: tail after the last user/toolResult is ${tail.length} record(s) but the assistant turn(s) look complete — a normal resume should work. Use --force to trim anyway.`);
    return;
  }
  const dropped = tail.map((r) => r?.message?.role ?? r?.type ?? r?.recordType ?? "?");
  console.log(`${label}:`);
  console.log(`  keep ${anchor + 1} record(s); drop ${tail.length}: ${dropped.join(", ")}`);
  console.log(`  damaged assistant turn(s): ${damaged.length} (${damaged.map((r) => r.message.stopReason ?? "?").join(", ")})`);
  if (flags["dry-run"]) { console.log("  (dry-run: no changes written)"); return; }
  const bak = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, bak);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rawLines.slice(0, anchor + 1).join("\n") + "\n");
  fs.renameSync(tmp, file);
  console.log(`  backup: ${bak}`);
  console.log(`  trimmed. Next: rebuild ${positional[0] ?? ""} (if its run state is gone) then subagent({ action: "resume", ... })`);
}

if (cmd === "list") cmdList();
else if (cmd === "show") cmdShow();
else if (cmd === "rebuild") cmdRebuild();
else if (cmd === "repair") cmdRepair();
else { usage(); fail(`unknown command '${cmd}'`); }
