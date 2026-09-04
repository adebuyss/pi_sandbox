# pi coding agent, sandboxed. Build with ./build.sh (it supplies the build args).
#
# Layers, slow → fast:
#   1. toolchain + pi itself
#   2. pi packages from agent/settings.json  (rebuilt only when that file changes)
#   3. extensions + skills from agent/        (seconds)
FROM docker.io/library/node:22-bookworm-slim

# build.sh supplies these from the host user; the defaults only matter for a bare `podman build`.
ARG PI_VERSION=0.84.2
ARG USER=pi
ARG UID=1000
ARG GID=1000
ARG PACKAGES_SHA=unknown

# Base toolchain: coding basics + ImageMagick so pasted/attached images can be
# inspected and converted out of the box. jq is used by the build itself.
# Archive tools: unzip + 7zip + bsdtar (libarchive-tools). Debian's 7zip is a
# +dfsg repack with the RAR codec stripped and unrar is non-free-only, so
# bsdtar is the RAR extractor here (reads RAR4/RAR5/zip/7z/iso).
# fd-find installs the binary as fdfind; symlink it to the name everyone types.
# wl-clipboard is inert unless the wrapper is started with PI_SANDBOX_CLIPBOARD=1.
# fonts-urw-base35 is a Recommends of imagemagick that --no-install-recommends
# drops; without it ImageMagick's default font (Helvetica, mapped to the URW
# Nimbus fonts in type-ghostscript.xml) is missing and every text-rendering
# path -- montage, label:, -annotate -- aborts with SIGABRT unless -font is given.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ripgrep fd-find tmux curl ca-certificates procps less jq \
      unzip 7zip libarchive-tools xxd tree \
      python3 imagemagick fonts-urw-base35 wl-clipboard \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# Expanded toolchain (optional): pip/venv/Pillow for scripted image work, ffmpeg
# for video. Comment out to omit; the sandbox-env note tells the agent what exists.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3-pip python3-venv python3-pil ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g npm@12.0.2

# pi itself goes to the image's default global prefix (/usr/local).
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" && npm cache clean --force

# Re-home the image's "node" user as $USER with the host's uid/gid so files in
# bind mounts keep their ownership under --userns=keep-id.
RUN groupmod -g "$GID" -n "$USER" node \
 && usermod -u "$UID" -l "$USER" -d "/home/$USER" -m node

ENV HOME=/home/${USER}
ENV PI_CODING_AGENT_DIR=/home/${USER}/.pi/agent
ENV PATH=/home/${USER}/.pi/agent/bin:$PATH
ENV PI_SKIP_VERSION_CHECK=1
ENV PI_SANDBOX=1
ENV PI_REPL_FORCE=1
LABEL pi-sandbox.packages-sha=${PACKAGES_SHA}

USER $USER
WORKDIR /home/${USER}

# 2. Install every package listed in agent/settings.json into the image
#    (~/.pi/agent/npm for npm sources, ~/.pi/agent/git for git/https sources).
#    npm: sources go in ONE `npm install --prefix ~/.pi/agent/npm --legacy-peer-deps`
#    (the exact args pi 0.84's own installNpmBatch uses; registration is settings.json,
#    restored in step 3, plus node_modules presence). git/https sources still use
#    `pi install` per source. `pi install` rewrites settings.json with plain string entries; the repo copy
#    is restored in step 3 so object entries (skill filters) survive.
#
#    allowScripts: npm 12 blocks dependency install scripts (preinstall/install/
#    postinstall) by default and only warns about what it skipped. The policy is the
#    `allowScripts` object in the package.json at the install prefix -- a flat map of
#    npm-package-arg spec -> boolean (true allows, false denies). `--allow-scripts` is a
#    hard error in a project-scoped install (it exists only for `npm i -g`/npx), so the
#    generated package.json below carries the policy. Three packages here need their
#    scripts and are named explicitly rather than blanket-approved, because what gets
#    baked into the image is security-reviewed per package:
#      context-mode    postinstall -- writes its .claude-plugin/.codex-plugin trees
#      pi-repl-py      postinstall -- builds the ipykernel venv at ~/.pi/agent/pi-repl/venv
#      better-sqlite3  install     -- native build (transitive dep of context-mode)
#    Keys are bare names, not `pkg@version` pins: better-sqlite3 is transitive and its
#    version floats, and a stale pin fails *silently* (script skipped, native module
#    missing, breakage only at runtime). The version gate is the spec list in
#    settings.json (e.g. pi-repl-py@0.6.14), not this policy.
#    The package.json is written unconditionally so the policy is always present.
COPY --chown=${UID}:${GID} agent/settings.json /home/${USER}/.pi/agent/settings.json
RUN set -e; \
    npm_specs=$(jq -r '.packages[] | if type=="object" then .source else . end | select(startswith("npm:")) | sub("^npm:";"")' \
                "$PI_CODING_AGENT_DIR/settings.json" | tr '\n' ' '); \
    if [ -n "$npm_specs" ]; then \
      mkdir -p "$PI_CODING_AGENT_DIR/npm"; \
      printf '%s\n' '{"name":"pi-packages","private":true,"allowScripts":{"context-mode":true,"pi-repl-py":true,"better-sqlite3":true}}' > "$PI_CODING_AGENT_DIR/npm/package.json"; \
      echo "==> npm install (single batch): $npm_specs"; \
      npm install $npm_specs --prefix "$PI_CODING_AGENT_DIR/npm" --legacy-peer-deps --no-audit --no-fund; \
    fi; \
    for src in $(jq -r '.packages[] | if type=="object" then .source else . end | select(startswith("npm:") | not)' \
                 "$PI_CODING_AGENT_DIR/settings.json"); do \
      echo "==> pi install $src"; pi install "$src"; \
    done; \
    pi list 2>/dev/null > "$PI_CODING_AGENT_DIR/installed-packages.txt"; \
    cat "$PI_CODING_AGENT_DIR/installed-packages.txt"; \
    mkdir -p "$PI_CODING_AGENT_DIR"/{sessions,audit,missions,powerline-footer,web-search-cache}

# 3. Extensions, skills, and the canonical settings.json.
COPY --chown=${UID}:${GID} agent/extensions /home/${USER}/.pi/agent/extensions
COPY --chown=${UID}:${GID} agent/skills     /home/${USER}/.pi/agent/skills
COPY --chown=${UID}:${GID} agent/settings.json /home/${USER}/.pi/agent/settings.json

ENTRYPOINT ["pi"]
