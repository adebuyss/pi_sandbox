// Tells the model about the sandbox environment — only when actually running in it.
// Gated on PI_SANDBOX=1, which is baked into the localhost/pi-sandbox image.
// Unsandboxed sessions (pi-unsandboxed) get nothing from this extension.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NOTE = `
## Execution environment: podman sandbox (pi-sandbox)

You are running inside a disposable rootless container, not on the host.
- Persistent: only the current working directory (bind-mounted at its real path) and your pi state under ~/.pi/agent (sessions, settings, audit log). Everything else — /tmp, the rest of $HOME, system dirs, anything you add under ~/.pi/agent/npm — is discarded when the session exits.
- You may freely install things: \`npm install\`, and \`pip install\` if pip is present (use a venv, e.g. /tmp/venv). \`apt\` is NOT available (no root). Nothing you install leaks to the host.
- Available tools: git, rg, fdfind (alias fd), jq, python3, ImageMagick 6 (convert/identify/mogrify — there is no \`magick\` binary), curl, tmux, node 22. pip/venv/Pillow/ffmpeg exist only if the image was built with the expanded toolchain — check with \`command -v\` before relying on them.
- Network: outbound internet works. Host services are reachable only on the loopback ports the wrapper forwards (by default 127.0.0.1:8080 and 127.0.0.1:11434, typically a local model server); other host ports and LAN addresses are not.
- Not available: ~/.ssh, credentials, git push, sudo. Host clipboard only if started with PI_SANDBOX_CLIPBOARD=1; the VS Code bridge (\`/ide\`) only if started with PI_SANDBOX_IDE=1 — otherwise don't retry \`/ide\` or probe for it.
- Subagent archives under /tmp/pi-subagents-* vanish at exit; child session logs under ~/.pi persist.
- NOT persistent: ~/.pi/agent/skills, ~/.pi/agent/extensions, ~/.pi/agent/prompts, ~/.pi/agent/themes (they come from the image; writes succeed but are discarded at exit — the wrapper exports anything you wrote there to ~/.pi/agent/sandbox-exports/ on the host and tells the user how to install it, so say clearly what you wrote). To create a skill/extension that actually persists, write it under the project: <cwd>/.pi/skills/ or <cwd>/.pi/extensions/ (pi loads these after the user trusts the project, \`pi --approve\`). Never claim a global install succeeded.
- Images from the user arrive as attachments or as file paths (\`@file\`) inside the mounted project; there is no clipboard access unless the session was started with PI_SANDBOX_CLIPBOARD=1 (then \`wl-paste\` works). If the user mentions a screenshot you cannot see, ask them to save it into the project and reference its path.
- Images / binary files: use the host \`read\` tool (attaches the image). \`ctx_execute_file\` is text-only. This is the intended exception to the context-mode hierarchy.
- context-mode may read files outside the project under ~/.pi/** and /tmp/** (permissions.allow is pre-configured); elsewhere it will refuse.
- Config reload: \`models.json\` is re-read when you open \`/model\`; \`settings.json\` changes (compaction, packages, etc.) need a fresh session. Don't expect a mid-session reload.
- Subagent wake messages are hard-capped (~1000 chars) and may cut the child's answer mid-sentence. Prefer \`async: false\` + an output file when the answer must come back intact; the full child transcript is under ~/.pi/agent/sessions/<cwd-key>/subagent-artifacts/<runId>_<agent>_0_transcript.jsonl.
- context-mode gotcha: \`ctx_batch_execute\` / \`ctx_execute_file\` shell commands get a literal \`NODE_OPTIONS='…' \` prefix, which is only valid before a *simple* command. Compound commands (\`for\`, \`while\`, \`if … fi\`, \`case\`, \`{ }\`, \`( )\`, functions) fail with "syntax error near unexpected token", and in lists/pipelines (\`a && b\`, \`a | b\`) only \`a\` gets the prefix. Use a single simple command, wrap logic in \`bash -c '…'\` or \`python3 -c '…'\`, or use the plain \`bash\` tool instead.
`;

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SANDBOX !== "1") return;
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + "\n" + NOTE,
  }));
}
