#!/usr/bin/env node
/**
 * pi-mcp — expose the pi coding agent (headless) as MCP tools for any MCP
 * client (Claude Code, Cursor, Claude Desktop, ...).
 *
 * Zero dependencies. Node 18+. Stdio transport. No build step.
 *
 * Requires the `pi` CLI on PATH (npm i -g @earendil-works/pi-coding-agent).
 * The child pi process inherits the server's environment, so pi's normal
 * auth (~/.pi/agent/auth.json or env API keys) is used as-is.
 *
 * Tools:
 *   pi_run       — start a fresh headless pi session, return final answer
 *   pi_continue  — resume the most recent pi session for the given cwd
 *   pi_models    — list pi's configured models
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const SERVER_NAME = "pi-mcp";
const SERVER_VERSION = "1.0.0";
const MAX_OUTPUT_CHARS = 100_000; // cap on text returned to the client
const MAX_CHILD_STDOUT = 2_000_000; // hard cap on raw child output buffered
const KNOWN_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-09-01"];

// Resolve the pi binary deterministically so the MCP always uses the SANDBOX
// wrapper regardless of the PATH the server happened to inherit at launch.
// Override with PI_MCP_BIN; otherwise prefer ~/pi-sandbox/pi, else fall back to PATH.
function resolvePiBin() {
  if (process.env.PI_MCP_BIN) return process.env.PI_MCP_BIN;
  const wrapper = path.join(process.env.HOME || "", "pi-sandbox", "pi");
  try {
    fs.accessSync(wrapper, fs.constants.X_OK);
    return wrapper;
  } catch {
    return "pi";
  }
}
const PI_BIN = resolvePiBin();

// ---------------- JSON-RPC over stdio (stdout reserved for protocol) ------

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore malformed lines
    }
    handleMessage(msg).catch((e) => {
      if (msg && msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message || e) } });
      }
    });
  }
});
process.stdin.on("end", () => process.exit(0));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function log(...args) {
  process.stderr.write(`[pi-mcp] ${args.join(" ")}\n`);
}

async function handleMessage(msg) {
  const { id, method, params = {} } = msg;
  const isRequest = id !== undefined;
  switch (method) {
    case "initialize": {
      const proto = KNOWN_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : "2024-11-05";
      if (isRequest)
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: proto,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return;
    case "ping":
      if (isRequest) send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      if (isRequest) send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      if (!isRequest) return;
      const result = await dispatchTool(params.name, params.arguments || {});
      send({ jsonrpc: "2.0", id, result });
      return;
    }
    case "resources/list":
      if (isRequest) send({ jsonrpc: "2.0", id, result: { resources: [] } });
      return;
    case "prompts/list":
      if (isRequest) send({ jsonrpc: "2.0", id, result: { prompts: [] } });
      return;
    default:
      if (isRequest)
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// ---------------- Tools -----------------------------------------------------

const RUN_PROPS = {
  prompt: { type: "string", description: "Task or question for pi" },
  cwd: { type: "string", description: "Absolute working directory for the run (default: server cwd)" },
  provider: { type: "string", description: "pi provider override (e.g. anthropic, openrouter)" },
  model: { type: "string", description: "pi model pattern or id override" },
  thinking: { type: "string", description: "Thinking level: off|minimal|low|medium|high|xhigh|max" },
  allow_bash: { type: "boolean", description: "Enable pi's bash tool (default false — read/analyze only)" },
  approve: { type: "boolean", description: "Trust project-local files (pi --approve, default false)" },
  append_system_prompt: { type: "string", description: "Extra system prompt text for this run" },
  save_session: { type: "boolean", description: "Persist the session so pi_continue can resume it (default true)" },
  timeout_minutes: { type: "number", description: "Hard timeout in minutes, 1-60 (default 10)" },
  include_message_ends: {
    type: "boolean",
    description:
      "Keep intermediate messages (tool results, prior turns) and return them in `messages`. Default false: only the final message is kept. Either way, individual events over ~1 MB (e.g. a huge tool result) are dropped as they stream, so bulky output never trips the size cap.",
  },
};

const TOOLS = [
  {
    name: "pi_run",
    description:
      "Start a NEW headless pi coding-agent session in a directory, let it work on the task, and return its final answer plus model/usage info. Pi has read/write/edit tools; bash is disabled unless allow_bash=true.",
    inputSchema: { type: "object", properties: RUN_PROPS, required: ["prompt"] },
  },
  {
    name: "pi_continue",
    description:
      "Resume the most recent saved pi session for the given cwd (pi --continue) and send a follow-up prompt. Requires a previous run with save_session=true in that directory.",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(Object.entries(RUN_PROPS).filter(([k]) => k !== "save_session")),
      required: ["prompt"],
    },
  },
  {
    name: "pi_models",
    description: "List pi's configured/available models (optionally filtered with a search term).",
    inputSchema: { type: "object", properties: { search: { type: "string" } } },
  },
];

async function dispatchTool(name, args) {
  try {
    switch (name) {
      case "pi_run":
        return await runPi(args, { fresh: true });
      case "pi_continue":
        return await runPi(args, { fresh: false });
      case "pi_models":
        return await runModels(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
}

// ---------------- pi execution ---------------------------------------------

function resolveCwd(cwd) {
  if (!cwd) return fs.realpathSync(process.cwd());
  const abs = path.resolve(cwd);
  if (!path.isAbsolute(abs)) throw new Error("cwd must be an absolute path");
  return fs.realpathSync(abs); // throws if the directory doesn't exist
}

function cap(s) {
  return s.length > MAX_OUTPUT_CHARS
    ? s.slice(0, MAX_OUTPUT_CHARS) + `\n…[truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
    : s;
}

function textResult(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text: cap(text) }] };
}

// `filter` null -> accumulate the raw stream (used by --list-models).
// `filter` set  -> process the NDJSON stream line-by-line and retain only what
// parsePiStream needs: the `session` event, any `error` events, `agent_end`
// (with its .messages trimmed to just the final assistant message), and
// `message_end` events. By default only the LAST message_end is kept; with
// filter.keepAllMessageEnds every message_end is kept. Everything else
// (deltas, message_start, turn_*, tool_execution_*) is dropped as it arrives,
// and any single event line larger than LINE_CAP (e.g. a multi-MB tool result
// or an untrimmed agent_end) is abandoned mid-stream — so bulky tool output can
// never accumulate toward the 2 MB cap the way it did before.
function spawnCapture(argv, { cwd, timeoutMs, filter = null }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    let child;
    try {
      child = spawn(PI_BIN, argv, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (e) {
      finish(() => reject(e));
      return;
    }
    let err = "";
    const killLater = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 5000);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`pi run timed out after ${Math.round(timeoutMs / 1000)}s (killed)`)));
    }, timeoutMs);
    child.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      clearTimeout(killLater);
      finish(() => reject(new Error(`Failed to start pi CLI: ${e.message}`)));
    });

    if (!filter) {
      let out = "";
      child.stdout.on("data", (d) => {
        out += d.toString("utf8");
        if (out.length > MAX_CHILD_STDOUT) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          finish(() => reject(new Error("pi output exceeded 2 MB, killed")));
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killLater);
        finish(() => resolve({ code, out, err }));
      });
      return;
    }

    const keepAll = !!filter.keepAllMessageEnds;
    const LINE_CAP = 1_000_000; // a single event line larger than this is dropped as bulk
    let carry = "";
    let dropping = false; // skipping the remainder of an oversized line
    let sessionLine = null;
    let agentEndLine = null;
    const errorLines = [];
    const ends = []; // retained message_end lines
    let endsBytes = 0;
    const pushEnd = (line) => {
      ends.push(line);
      endsBytes += line.length + 1;
      // keepAll: drop oldest only if the retained set exceeds the byte cap.
      // default: keep only the last message_end.
      while (ends.length > 1 && (keepAll ? endsBytes > MAX_CHILD_STDOUT : true)) {
        endsBytes -= ends.shift().length + 1;
      }
    };
    const onLine = (line) => {
      if (!line) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      switch (ev.type) {
        case "session":
          sessionLine = line;
          break;
        case "error":
          errorLines.push(line);
          break;
        case "agent_end":
          if (Array.isArray(ev.messages))
            ev.messages = ev.messages.filter((m) => m?.role === "assistant").slice(-1);
          agentEndLine = JSON.stringify(ev);
          break;
        case "message_end":
          pushEnd(line);
          break;
        default:
          break; // dropped
      }
    };
    child.stdout.on("data", (d) => {
      carry += d.toString("utf8");
      let idx;
      while ((idx = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        if (dropping) {
          dropping = false;
          continue;
        } // this newline ends a dropped oversized line
        onLine(line);
      }
      if (carry.length > LINE_CAP) {
        dropping = true;
        carry = "";
      } // abandon an oversized, still-unterminated line
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killLater);
      const lines = [];
      if (sessionLine) lines.push(sessionLine);
      lines.push(...errorLines);
      if (agentEndLine) lines.push(agentEndLine);
      lines.push(...ends);
      finish(() => resolve({ code, out: lines.join("\n"), err }));
    });
  });
}

function buildArgs(args, { fresh }) {
  const a = [];
  if (!fresh) a.push("--continue");
  a.push("--print", String(args.prompt), "--mode", "json");
  if (args.save_session === false) a.push("--no-session");
  if (args.provider) a.push("--provider", String(args.provider));
  if (args.model) a.push("--model", String(args.model));
  if (args.thinking) a.push("--thinking", String(args.thinking));
  if (args.approve) a.push("--approve");
  if (args.append_system_prompt) a.push("--append-system-prompt", String(args.append_system_prompt));
  if (!args.allow_bash) a.push("--exclude-tools", "bash");
  return a;
}

function parsePiStream(out) {
  const lines = out.split("\n").filter(Boolean);
  let session = null;
  let agentEnd = null;
  let lastAssistant = null;
  let error = null;
  const messages = [];
  const textOf = (msg) =>
    (msg?.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "session") session = ev;
    if (ev.type === "agent_end") agentEnd = ev;
    if (ev.type === "message_end" && ev.message) {
      if (ev.message.role === "assistant") lastAssistant = ev.message;
      messages.push({ role: ev.message.role, text: textOf(ev.message) });
    }
    if (ev.type === "error") error = ev;
  }
  const finalMsg =
    (agentEnd?.messages || []).filter((m) => m.role === "assistant").pop() || lastAssistant;
  const text = textOf(finalMsg) || "";
  return { session, finalMsg, text, error, messages };
}

async function runPi(args, { fresh }) {
  if (!args.prompt || typeof args.prompt !== "string") throw new Error("prompt is required");
  const cwd = resolveCwd(args.cwd);
  const minutes = Math.min(Math.max(Number(args.timeout_minutes ?? 10) || 10, 1), 60);
  const timeoutMs = minutes * 60_000;
  const argv = buildArgs(args, { fresh });
  const keepAll = args.include_message_ends === true;
  log(`${fresh ? "pi_run" : "pi_continue"} pi=${PI_BIN} cwd=${cwd} bash=${!!args.allow_bash} timeout=${minutes}m keepAll=${keepAll}`);
  const { code, out, err } = await spawnCapture(argv, {
    cwd,
    timeoutMs,
    filter: { keepAllMessageEnds: keepAll },
  });
  const { session, finalMsg, text, error, messages } = parsePiStream(out);
  const result = {
    ok: code === 0 && !error,
    cwd,
    session_id: session?.id ?? null,
    provider: finalMsg?.provider ?? null,
    model: finalMsg?.model ?? null,
    stop_reason: finalMsg?.stopReason ?? (code !== 0 ? `exit ${code}` : null),
    total_tokens: finalMsg?.usage?.totalTokens ?? null,
    output_tokens: finalMsg?.usage?.output ?? null,
    thinking: args.thinking ?? "default",
    text,
  };
  if (keepAll) result.messages = messages.map((m) => ({ role: m.role, text: cap(m.text) }));
  if (error) result.pi_error = typeof error === "string" ? error : JSON.stringify(error);
  if (code !== 0 && err) result.stderr = err.slice(-2000);
  return textResult(result);
}

async function runModels(args) {
  const argv = ["--list-models"];
  if (args.search) argv.push(String(args.search));
  const { code, out, err } = await spawnCapture(argv, {
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  const text = out || err || `pi exited with code ${code} and no output`;
  return textResult(text);
}
