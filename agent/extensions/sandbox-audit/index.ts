// Audit log of every tool call, with a heuristic "flag" for commands/reads that
// look like data exfiltration or secret access. Logs ONLY; never blocks.
// Log: ~/.pi/agent/audit/tool-calls.jsonl (host-visible even from the sandbox).
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const LOG_DIR = join(AGENT_DIR, "audit");
const LOG = join(LOG_DIR, "tool-calls.jsonl");

// Network senders / tunnels / encoders-to-network
const EXFIL_CMD = [
  /\bcurl\b[^|\n]*\s(-d|--data\S*|-F|--form|-T|--upload-file|-X\s*(POST|PUT|PATCH))\b/i,
  /\bwget\b[^|\n]*\s(--post-data|--post-file|--body-file|--method=(POST|PUT))/i,
  /\b(nc|ncat|netcat|socat|telnet)\b/,
  /\b(ssh|scp|sftp|rsync)\b.*\S+@\S+/,
  /\b(python3?|node|ruby|perl|php)\b.*\b(requests\.(post|put)|urlopen|http\.client|fetch\(|XMLHttpRequest|net\.connect|socket\.socket|Net::HTTP)/i,
  /\bbase64\b.*\|\s*(curl|wget|nc|ncat)\b/,
  /\b(git\s+push|gh\s+(gist|release)\s+create|npm\s+publish|pip\s+upload|twine)\b/,
  /\b(dig|nslookup|host)\b.*\$\(/, // DNS exfil via command substitution
  /\/dev\/(tcp|udp)\//,
];
// Secret-ish paths (as read targets or in commands)
const SECRET_PATH = /(^|[\s/'"])(\.env(\.\w+)?|\.netrc|\.npmrc|\.pypirc|id_(rsa|ed25519|ecdsa)|\.pem|\.p12|\.pfx|\.aws|\.gnupg|\.ssh|auth\.json|credentials(\.json)?|\.kube\/config|\.docker\/config\.json|secrets?\.ya?ml|\.git-credentials|token)\b/i;

// Collect every shell-command-like string a tool call carries, across tools.
function commandsOf(tool: string, input: any): string[] {
  if (tool === "bash") return [String(input?.command ?? "")];
  if (tool === "ctx_batch_execute") return (input?.commands ?? []).map((c: any) => String(c?.command ?? c ?? ""));
  if (tool === "ctx_execute" || tool === "ctx_execute_file") return [String(input?.code ?? "")];
  if (tool === "subagent") return [String(input?.task ?? "")];
  return [];
}
function pathsOf(tool: string, input: any): string[] {
  const p: string[] = [];
  if (input?.path) p.push(String(input.path));
  if (tool === "ctx_batch_execute") for (const c of input?.commands ?? []) if (c?.path) p.push(String(c.path));
  return p;
}
function flags(tool: string, input: any): string[] {
  const out = new Set<string>();
  for (const cmd of commandsOf(tool, input)) {
    if (EXFIL_CMD.some((re) => re.test(cmd))) out.add("network-send");
    if (SECRET_PATH.test(cmd)) out.add("secret-path");
  }
  for (const p of pathsOf(tool, input)) if (SECRET_PATH.test(p)) out.add("secret-path");
  return [...out];
}

function summarize(tool: string, input: any): string {
  if (tool === "bash") return String(input?.command ?? "").slice(0, 2000);
  if (tool === "ctx_batch_execute") return commandsOf(tool, input).join(" ;; ").slice(0, 2000);
  if (input?.path) return String(input.path);
  return JSON.stringify(input ?? {}).slice(0, 500);
}

export default function (pi: ExtensionAPI) {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  pi.on("tool_call", async (event, ctx) => {
    const f = flags(event.toolName, event.input);
    const rec = {
      ts: new Date().toISOString(),
      cwd: process.cwd(),
      sandbox: process.env.PI_SANDBOX === "1",
      tool: event.toolName,
      flags: f,
      input: summarize(event.toolName, event.input),
    };
    try { appendFileSync(LOG, JSON.stringify(rec) + "\n"); } catch {}
    if (f.length) ctx.ui.notify(`audit: ${event.toolName} flagged [${f.join(", ")}]`, "warning");
    return undefined; // never block
  });
  pi.registerCommand("audit", {
    description: "Show path of the tool-call audit log",
    handler: async (_args, ctx) => { ctx.ui.notify(`audit log: ${LOG}`, "info"); },
  });
}
