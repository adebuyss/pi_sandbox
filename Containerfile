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
# wl-clipboard is inert unless the wrapper is started with PI_SANDBOX_CLIPBOARD=1.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ripgrep fd-find tmux curl ca-certificates procps less jq \
      python3 imagemagick wl-clipboard \
 && rm -rf /var/lib/apt/lists/*

# Expanded toolchain (optional): pip/venv/Pillow for scripted image work, ffmpeg
# for video. Uncomment to include; the sandbox-env note tells the agent what exists.
# RUN apt-get update \
#  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
#       python3-pip python3-venv python3-pil ffmpeg \
#  && rm -rf /var/lib/apt/lists/*

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
LABEL pi-sandbox.packages-sha=${PACKAGES_SHA}

USER $USER
WORKDIR /home/${USER}

# 2. Install every package listed in agent/settings.json into the image
#    (~/.pi/agent/npm for npm sources, ~/.pi/agent/git for git/https sources).
#    `pi install` rewrites settings.json with plain string entries; the repo copy
#    is restored in step 3 so object entries (skill filters) survive.
COPY --chown=${UID}:${GID} agent/settings.json /home/${USER}/.pi/agent/settings.json
RUN set -e; \
    for src in $(jq -r '.packages[] | if type=="object" then .source else . end' \
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
