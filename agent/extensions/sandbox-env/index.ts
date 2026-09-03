// Tells the model about the sandbox environment — only when actually running in it.
// Gated on PI_SANDBOX=1, which is baked into the localhost/pi-sandbox image.
// Unsandboxed sessions (pi-unsandboxed) get nothing from this extension.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NOTE = `
## Execution environment: podman sandbox (pi-sandbox)

You are running inside a disposable rootless container, not on the host.
- Persistent: only the current working directory (bind-mounted at its real path) and your pi state under ~/.pi/agent (sessions, settings, audit log). Everything else — /tmp, the rest of $HOME, system dirs, anything you add under ~/.pi/agent/npm — is discarded when the session exits.
- You may freely install things: \`npm install\`, and \`pip install\` if pip is present (use a venv, e.g. /tmp/venv). \`apt\` is NOT available (no root). Nothing you install leaks to the host.
- Available tools: git, rg, fd, jq, python3, ImageMagick 6 (convert/identify/mogrify — there is no \`magick\` binary), curl, tmux, node 22, xxd, tree, sha256sum/md5sum. pip/venv/Pillow/ffmpeg exist only if the image was built with the expanded toolchain — check with \`command -v\` before relying on them.
- Archives: \`unzip\`, \`7zz\` (7-Zip), and \`bsdtar\`. There is NO \`unrar\`, and this 7zz cannot open RARs (Debian strips the RAR codec) — extract RAR with \`bsdtar -xf foo.rar\` (handles RAR4/RAR5, plus zip/7z/iso/tar). If bsdtar fails on an exotic RAR, fall back to downloading the RARLAB static build.
- Network: outbound internet works. Host services are reachable only on the loopback ports the wrapper forwards (by default 127.0.0.1:8080 and 127.0.0.1:11434, typically a local model server); other host ports and LAN addresses are not.
- Not available: ~/.ssh, credentials, git push, sudo. Host clipboard only if started with PI_SANDBOX_CLIPBOARD=1; the VS Code bridge (\`/ide\`) only if started with PI_SANDBOX_IDE=1 — otherwise don't retry \`/ide\` or probe for it.
- pi-subagents run state under /tmp/pi-subagents-uid-*/ (status.json, results, leases, model exclusions) vanishes when the container exits; child session files persist under ~/.pi/agent/sessions/<cwd-key>/<parent-session>/<runId>/ and transcripts under .../subagent-artifacts/. If children were lost to a died turn, server outage or restart, use the \`subagent-resume\` skill (revive from the session file) instead of relaunching.
- NOT persistent: ~/.pi/agent/skills, ~/.pi/agent/extensions, ~/.pi/agent/prompts, ~/.pi/agent/themes (they come from the image; writes succeed but are discarded at exit — the wrapper exports anything you wrote there to ~/.pi/agent/sandbox-exports/ on the host and tells the user how to install it, so say clearly what you wrote). To create a skill/extension that actually persists, write it under the project: <cwd>/.pi/skills/ or <cwd>/.pi/extensions/ (pi loads these after the user trusts the project, \`pi --approve\`). Never claim a global install succeeded.
- Images from the user arrive as attachments or as file paths (\`@file\`) inside the mounted project; there is no clipboard access unless the session was started with PI_SANDBOX_CLIPBOARD=1 (then \`wl-paste\` works). If the user mentions a screenshot you cannot see, ask them to save it into the project and reference its path.
- Images / binary files: use the host \`read\` tool (attaches the image). \`ctx_execute_file\` is text-only. This is the intended exception to the context-mode hierarchy.
- context-mode may read files outside the project under ~/.pi/** and /tmp/** (permissions.allow is pre-configured); elsewhere it will refuse.
- Long tasks: call \`context_alert\` early (see skill context-alert) so you are pinged before auto-compaction and can write results to disk; a default 75% alert fires anyway.
- Config reload: \`models.json\` is re-read when you open \`/model\`; \`settings.json\` changes (compaction, packages, etc.) need a fresh session. Don't expect a mid-session reload.
- Subagent wake messages are hard-capped (~1000 chars) and may cut the child's answer mid-sentence. Prefer \`async: false\` + an output file when the answer must come back intact; the full last answer is recoverable with the \`subagent-resume\` skill's \`show <runId>\` (reads ~/.pi/agent/sessions/<cwd-key>/subagent-artifacts/<runId>_<agent>_0_transcript.jsonl).
- Python gotcha (measured failure): \`pathlib.Path.is_dir()\`/\`is_file()\` do NOT accept \`follow_symlinks=\` here — that kwarg belongs to \`os.DirEntry\` and \`os.path\`/\`stat\`. Use \`p.is_symlink()\` checks or \`os.scandir\` entries when symlink behavior matters.
- context-mode gotcha: \`ctx_batch_execute\` / \`ctx_execute_file\` shell commands get a literal \`NODE_OPTIONS='…' \` prefix, which is only valid before a *simple* command. Compound commands (\`for\`, \`while\`, \`if … fi\`, \`case\`, \`{ }\`, \`( )\`, functions) fail with "syntax error near unexpected token", and in lists/pipelines (\`a && b\`, \`a | b\`) only \`a\` gets the prefix. Use a single simple command, wrap logic in \`bash -c '…'\` or \`python3 -c '…'\`, or use the plain \`bash\` tool instead.
`;

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SANDBOX !== "1") return;
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + "\n" + NOTE,
  }));
}
