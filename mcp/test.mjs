#!/usr/bin/env node
// End-to-end test client for pi-mcp: speaks MCP JSON-RPC over stdio.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, "index.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== undefined) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));

let nextId = 1;
function req(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, res);
    const t = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`timeout waiting for ${method}`));
      }
    }, 9 * 60_000);
    t.unref?.();
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const init = await req("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "pi-mcp-test", version: "0.0.0" },
});
console.log(`${ts()} initialize ->`, JSON.stringify(init.result?.serverInfo), "proto:", init.result?.protocolVersion);
notify("notifications/initialized");

const list = await req("tools/list", {});
console.log(`${ts()} tools ->`, list.result.tools.map((t) => t.name).join(", "));

const models = await req("tools/call", { name: "pi_models", arguments: {} });
const mtxt = models.result.content[0].text;
console.log(`${ts()} pi_models -> isError=${models.result.isError ?? false}, first 200 chars:\n${mtxt.slice(0, 200)}`);

const run = await req("tools/call", {
  name: "pi_run",
  arguments: { prompt: "Reply with exactly: PONG", timeout_minutes: 5 },
});
const r1 = JSON.parse(run.result.content[0].text);
console.log(`${ts()} pi_run -> ok=${r1.ok} model=${r1.model}/${r1.provider} tokens=${r1.total_tokens} session=${r1.session_id}`);
console.log(`   text: ${JSON.stringify(r1.text)}`);

const cont = await req("tools/call", {
  name: "pi_continue",
  arguments: { prompt: "What was my first prompt to you? Reply with it verbatim, nothing else.", timeout_minutes: 5 },
});
const r2 = JSON.parse(cont.result.content[0].text);
console.log(`${ts()} pi_continue -> ok=${r2.ok} stop=${r2.stop_reason}`);
console.log(`   text: ${JSON.stringify(r2.text)}`);

child.kill();
console.log(`${ts()} DONE`);
