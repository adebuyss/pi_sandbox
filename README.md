# pi-sandbox

Run the [pi coding agent](https://pi.dev) inside a rootless **podman** container so that
its `bash` / `read` / `write` / `edit` tools — and every third-party extension it loads —
can only touch:

* the **current project directory** (mounted read-write at the same absolute path), and
* a small, explicit set of **pi state files** under `~/.pi/agent` (sessions for this
  project, `settings.json`, read-only `auth.json` / `models.json`, audit log, …).

Everything else in `$HOME` (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude`, other projects,
other projects' pi sessions) does not exist inside the container. The pi **packages,
extensions and skills are baked into the image**, so a clone + build reproduces the
whole setup on another machine. Outbound network is unrestricted by design (see
[Hardening not done](#hardening-not-done)).

Also included: [`mcp/`](mcp/README.md), a zero-dependency MCP server that exposes
headless pi (`pi_run` / `pi_continue` / `pi_models`) to Claude Code or any MCP client —
and, with the wrapper on PATH, every such run is sandboxed too.

```
cd ~/some/project && pi        # sandboxed pi, same CLI, same sessions
```

## Contents

| path | purpose |
|---|---|
| `Containerfile` | `node:22-bookworm-slim` + toolchain + pi (pinned) + baked `agent/` |
| `build.sh` | `podman build`; passes your uid/gid/user and a package-list fingerprint |
| `pi` | the wrapper — symlink it to `~/.local/bin/pi` |
| `agent/settings.json` | **source of truth for which pi packages the image contains** + sane defaults |
| `agent/extensions/` | `sandbox-env`, `sandbox-audit`, `plan-mode` (baked into the image) |
| `agent/skills/` | `pi-subagents-guide` (baked into the image) |
| `templates/` | `gitconfig` and `claude-settings.json`, rendered per run |
| `mcp/` | the pi MCP server ([README](mcp/README.md)) |

## Requirements

* Linux host with rootless **podman ≥ 5** (uses `pasta` networking and `--userns=keep-id`).
* **`jq`** on the host — `build.sh` and the wrapper refuse to run without it.
* A pi-compatible model endpoint: either API keys in `~/.pi/agent/auth.json` / env, or a local
  server on the host loopback (see [Local models](#local-models)).

## Install

```bash
git clone <this repo> ~/pi-sandbox
cd ~/pi-sandbox && ./build.sh                     # ~2 GB image, first build takes a few minutes
ln -s ~/pi-sandbox/pi ~/.local/bin/pi             # shadow any host pi on PATH
# optional escape hatch if you also have pi installed on the host:
ln -s "$(command -v pi)" ~/.local/bin/pi-unsandboxed   # do this BEFORE the line above
```

`build.sh` passes `$(id -u)`, `$(id -g)` and `$(id -un)` so that the in-container user and
home directory match yours; the wrapper relies on `$HOME` being the same path inside and out.

On first run the wrapper seeds `~/.pi/agent/settings.json` from `agent/settings.json` if you
have none, so the baked packages are enabled. If you already use pi, your existing file is
used as-is — make sure its `packages` list matches the image (the wrapper warns if not).

## Day-to-day

```bash
cd ~/project && pi                  # interactive, sandboxed
pi -p "summarise this repo"         # every pi flag passes straight through
pi -c / pi -r                        # continue / resume this project's sessions
pi list                              # packages baked into the image
cd ~ && pi                           # refused (would mount all of $HOME)
PI_SANDBOX_EXTRA_ARGS="--entrypoint bash" pi         # a shell inside the sandbox
PI_SANDBOX_EXTRA_ARGS="-v $HOME/data:/data:ro" pi    # one-off extra mount
```

| env var | effect |
|---|---|
| `PI_SANDBOX_EXTRA_ARGS` | extra `podman run` args (mounts, ports, `--entrypoint`) |
| `PI_SANDBOX_PORTS` | host loopback ports forwarded inside (default `8080 11434`) |
| `PI_SANDBOX_ALL_SESSIONS=1` | mount every project's sessions, e.g. for cross-project `/resume` |
| `PI_SANDBOX_ALLOW_HOME=1` | permit running from `$HOME` — mounts your whole home directory |
| `PI_SANDBOX_DEV=1` | overlay this repo's `agent/extensions` + `agent/skills` (ro) over the image copies — edit extensions without rebuilding |
| `PI_SANDBOX_IDE=1` | VS Code integration via `pi-ide-bridge` — see [IDE integration](#ide-integration) |
| `PI_SANDBOX_CLIPBOARD=1` | pass your Wayland socket in so `Ctrl+V` image paste works — **read the warning in [Pasting images](#pasting-images)** |
| `PI_SANDBOX_GIT_NAME` / `_EMAIL` | git identity inside (default: host `git config`, then `$USER@localhost`) |
| `PI_SANDBOX_IMAGE` | image name (default `localhost/pi-sandbox`) |
| `LLAMA_BASE_URL`, `LLAMA_API_KEY`, `LLAMA_SERVER_URL` | passed through; the port in the URL is forwarded automatically |

`--version`, `--help`, `--list-models` and `list` run without mounting a project, from any
directory (this is what lets the MCP server's `pi_models` work).

## How it works

```
podman run --rm -it --userns=keep-id \
  --network=pasta:-T,8080,-T,11434 \                 # container 127.0.0.1:PORT → host loopback
  --cap-drop=ALL --security-opt=no-new-privileges --security-opt=label=disable \
  --tmpfs /tmp \
  -v "$PWD:$PWD" -w "$PWD" \                         # the project
  -v ~/.pi/agent/sessions/--home-you-project--:…  \  # only THIS project's sessions
  -v ~/.pi/agent/settings.json:…  (rw) \
  -v ~/.pi/agent/auth.json:…  -v …/models.json:…  (ro) \
  -v ~/.pi/agent/{audit,missions,powerline-footer,web-search-cache}:… \
  -v <rendered gitconfig>:~/.gitconfig:ro \
  -v <rendered claude-settings.json>:~/.claude/settings.json:ro \
  localhost/pi-sandbox "$@"
```

* **`--userns=keep-id`** — you are the same uid inside, so files in mounts keep ownership.
* **`pasta -T PORT`** — loopback connections inside the container to `127.0.0.1:PORT` reach
  the host's loopback. `models.json` entries like `http://127.0.0.1:8080/v1` keep working.
* **`label=disable`** — SELinux container confinement is off for this container; the
  alternative (`:Z`) relabels every project tree you run pi in. The user namespace plus the
  explicit mount list is the boundary.
* **Sessions are keyed by absolute cwd** (`~/.pi/agent/sessions/--home-you-project--`).
  Mounting the project at its real path keeps `/resume`, `-c`, `-r` working. Only that one
  session directory is mounted; a compromised session cannot read other projects' history.
* **Image vs. state.** `~/.pi/agent/{npm,git,extensions,skills,bin}` come from the image and
  are read-only in effect (writes land in the throwaway layer). The files/dirs in the table
  below are the only persistent state:

  | host path under `~/.pi/agent` | mode | what |
  |---|---|---|
  | `sessions/<this project>` | rw | session history (+ subagent artifacts) |
  | `settings.json` | rw | your prefs; pi writes it on `/model` |
  | `auth.json`, `models.json` | ro | credentials / custom providers — `/login` inside fails by design |
  | `models-store.json`, `run-history.jsonl` | rw | pi bookkeeping |
  | `audit/` | rw | `sandbox-audit` log |
  | `missions/`, `powerline-footer/`, `web-search-cache/` | rw | pi-subagents, powerline footer, web-access state |

* `/tmp` is a tmpfs: pi-subagents completion archives under `/tmp/pi-subagents-uid-*/`
  vanish at exit; child session logs live under `sessions/` and persist.
* **Agent-written skills/extensions are rescued, not kept.** `~/.pi/agent/{skills,extensions,
  prompts,themes}` are image-backed, so anything the agent writes there would vanish. On
  exit the wrapper diffs the container layer; if it finds files under those directories it
  copies them to `~/.pi/agent/sandbox-exports/<stamp>-<project>/` and prints how to install
  them — project-local (`<project>/.pi/`, then `pi --approve`), into the host pi, or into
  this repo's `agent/` + `./build.sh` for the image. The agent is told this in its prompt and
  pointed at `<project>/.pi/` for anything that should persist. (This is why the container is
  not run with `--rm`; it is removed right after the check.)

## Packages (plugins)

`agent/settings.json` lists the pi packages; `build.sh` installs each with `pi install`
into the image (`~/.pi/agent/npm/` for npm sources, `~/.pi/agent/git/` for git/https
sources) and records the result in `~/.pi/agent/installed-packages.txt` (`pi list` shows
the same). The package layer is only rebuilt when `agent/settings.json` changes; extension
edits rebuild in seconds.

Currently baked: `pi-subagents` (with the bundled `pi-subagents`/`council-mode` skills
filtered out), `pi-mcp-adapter`, `pi-web-access`, `pi-markdown-preview`,
`pi-powerline-footer`, `@joemccann/pi-exa`, `context-mode`, `@feniix/pi-statusline`,
`pi-thinking-level` (git), `@m4riok/pi-ide-bridge`, `pi-llama-cpp` (git).

**Adding / removing a package**

1. Edit the `packages` array in `agent/settings.json`.
2. `./build.sh`.
3. Make the same change in your `~/.pi/agent/settings.json` (pi's `pi install` / `pi remove`
   on the host do this, or edit by hand). pi does **not** auto-install packages that are
   listed but missing on disk, so the two lists must agree. The wrapper compares a
   fingerprint of both on every start and warns when they differ.

**Toolchain.** The image has git, ripgrep, fd, tmux, curl, jq, python3, ImageMagick 6
(`convert` / `identify` / `mogrify` — Debian bookworm has no `magick` binary) so pasted or
attached images can be inspected and converted out of the box, and `wl-clipboard` (inert
unless `PI_SANDBOX_CLIPBOARD=1`, see [Pasting images](#pasting-images)). A commented-out "expanded" line in the `Containerfile` adds
pip / venv / Pillow and ffmpeg — uncomment it if you want those. There is no `apt` at
runtime (no root), but `npm install` / `pip install` inside the container are fine and
disappear with it.

## Extensions and skills shipped

* **`sandbox-env`** — appends a short description of this environment to the system prompt
  (what persists, which tools exist, which host ports are reachable, known gotchas).
  Only active when `PI_SANDBOX=1`, which the image sets; unsandboxed pi is unaffected.
* **`sandbox-audit`** — logs every tool call (`bash`, context-mode `ctx_*` executes,
  subagent tasks, file paths) to `~/.pi/agent/audit/tool-calls.jsonl` with heuristic flags:
  `network-send` (curl/wget uploads, nc, ssh/scp, `git push`, script HTTP clients, …) and
  `secret-path` (`.env`, keys, `.aws`, `auth.json`, …). It **never blocks** — it is an
  observe-only layer. `/audit` prints the log path. Review with
  `jq -c 'select(.flags|length>0)' ~/.pi/agent/audit/tool-calls.jsonl`.
* **`plan-mode`** — read-only exploration mode (`/plan`), from pi's examples.
* **`pi-subagents-guide` skill** — short usage notes for pi-subagents.


## Local models

Anything listening on the host's loopback is reachable inside at the same `127.0.0.1:PORT`
as long as the port is forwarded (`PI_SANDBOX_PORTS`, default `8080 11434`; the port in
`LLAMA_BASE_URL` / `LLAMA_SERVER_URL` is added automatically). Typical setups:

* **vLLM / OpenAI-compatible** — add a provider to `~/.pi/agent/models.json` pointing at
  `http://127.0.0.1:8080/v1`.
* **llama.cpp (`pi-llama-cpp`, built in)** — `LLAMA_BASE_URL=http://127.0.0.1:8080 pi`. The
  package auto-discovers models via `/v1/models`, `/props` and `/health`; a proxy in front of
  vLLM must serve those endpoints (and accept `/chat/completions` at the root) for discovery
  to succeed — llama-server itself does all this natively.

## IDE integration

`pi-ide-bridge` (baked in) talks plain HTTP to its VS Code companion on the host loopback.
By default none of that reaches the sandbox: the bridge ports are not forwarded and the
`PI_IDE_BRIDGE_*` variables are scrubbed, so `/ide status` reports disconnected. To enable:

1. In VS Code install the companion: `ext install m4riok.pi-ide-bridge-vscode`
   (or `/ide install` from an unsandboxed pi).
2. Open the project in VS Code and start pi **from its integrated terminal** with
   `PI_SANDBOX_IDE=1 pi`. The companion puts `PI_IDE_BRIDGE_SERVER_PORT` and
   `PI_IDE_BRIDGE_AUTH_TOKEN` into that terminal's environment; the wrapper forwards that
   port (plus the bootstrap port 45721) and passes the variables through.
3. `/ide status` → connected. Diffs open natively because the project is mounted at its
   real path; `F8` toggles review / auto-accept as usual.

Started from any other terminal, only the bootstrap port is forwarded and the companion
has to match the session by `cwd` (container PIDs are meaningless to it) — it may or may
not succeed, and the per-workspace port it hands back is not forwarded, so treat the
integrated terminal as the supported route.

What this exposes: the bridge auth token enters the container, so the agent (and every
extension) can drive the same diff / editor-context / diagnostics API the bridge itself
uses — nothing beyond what the companion already grants pi. No other host ports open.

## Pasting images

pi's `Ctrl+V` image paste on Linux shells out to `wl-paste` (Wayland) or `xclip` (X11). By
default the sandbox has **no clipboard**: the wrapper strips `WAYLAND_DISPLAY`, `DISPLAY`,
`XDG_RUNTIME_DIR` and `XDG_SESSION_TYPE`, so `Ctrl+V` pastes text only. Two ways to get an
image in:

**1. By path (default, recommended).** Save the screenshot inside the project — or a
directory you mount read-only with `PI_SANDBOX_EXTRA_ARGS="-v $HOME/Pictures:$HOME/Pictures:ro"`
— and reference it:

```bash
pi -p @shot.png "what is wrong in this screenshot?"
# or, in the prompt:  @shot.png  (dragging a file into the terminal pastes its path)
```

The agent reads it with its `read` tool and can crop/convert with ImageMagick. Only the
files you hand over enter the container.

**2. Real clipboard paste (`PI_SANDBOX_CLIPBOARD=1`).** `wl-clipboard` is in the image; the
wrapper then bind-mounts `$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY` and passes `WAYLAND_DISPLAY`
/ `XDG_RUNTIME_DIR` through, so `Ctrl+V` works exactly as unsandboxed. Wayland only (the
wrapper refuses without a socket); X11 is not wired up.

> **Warning.** A Wayland socket is not just a clipboard. Any process in the container
> becomes a client of your desktop session: it can read the clipboard at any time (not
> only when you press `Ctrl+V`), write to it, open windows, and on some compositors
> observe input. Everything the agent runs — including every extension and anything it
> `npm install`s — gets that access for the life of the session. Use it for the session
> where you need it, not as a default, and never with untrusted project content.

## git inside the sandbox

Commits work (identity from the rendered `templates/gitconfig`, or a `gitconfig` file in the
repo root if you prefer a fixed one — it is gitignored). Pushing cannot: there is no SSH
agent, no token, no credential helper. Push from the host.

## Known limitations

* Extensions still run with pi's privileges — inside the container. That is the point.
* Host IDE only with `PI_SANDBOX_IDE=1`, clipboard only with `PI_SANDBOX_CLIPBOARD=1`;
  `/share` does not work.
* `/login` inside the sandbox fails (`auth.json` is read-only); configure providers from the host.
* Startup does some network work (package / version checks). `pi --offline` or
  `PI_OFFLINE=1` skips it.
* context-mode's `ctx_batch_execute` / `ctx_execute_file` prepend `NODE_OPTIONS=…` to shell
  commands, which breaks compound commands (`for`, `if`, `a && b`). The `sandbox-env` note
  tells the agent to use simple commands or the plain `bash` tool. Upstream bug.
* pi-subagents' async completion notification truncates the child's return value at ~1000
  chars (`subagent-executor.ts`, `slice(0, 1_000)`). Use `async: false` + an output file.

## Hardening not done

* **Egress allowlist** — the only measure that *prevents* exfiltration rather than logging
  it. `--network=none` is not an option (pasta needs a netns for the `-T` forwards); the
  practical route is an HTTP(S) proxy sidecar plus `-e HTTPS_PROXY`, or a podman network
  with firewall rules.
* Read-only project mount with a separate scratch dir for review-only sessions.
* pi's own bubblewrap sandbox (`examples/extensions/sandbox/`) nested inside the container
  would need `--cap-add=SYS_ADMIN` or `enableWeakerNestedSandbox`.

## Upgrading pi

`PI_VERSION=x.y.z ./build.sh` (the default lives at the top of `build.sh` and as the ARG
default in the `Containerfile`). Packages are reinstalled against the new pi; your state in
`~/.pi/agent` is untouched. If a package breaks on a new pi, pin or drop it in
`agent/settings.json`.

## License

GPL-3.0 — see [LICENSE](LICENSE).
