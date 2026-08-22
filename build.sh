#!/usr/bin/env bash
# Build (or rebuild) the pi sandbox image. PI_VERSION=x.y.z ./build.sh to bump pi.
# Extra args are passed to `podman build` (e.g. --no-cache).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

PI_VERSION="${PI_VERSION:-0.84.2}"
IMAGE="${PI_SANDBOX_IMAGE:-localhost/pi-sandbox}"

for tool in podman jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "build.sh: '$tool' is required on the host" >&2; exit 1; }
done

# Fingerprint of the package list; the wrapper compares it against the host's
# ~/.pi/agent/settings.json and warns when the image is stale.
sha="$(jq -cS '.packages' agent/settings.json | sha256sum | cut -c1-16)"

exec podman build \
  --build-arg "PI_VERSION=$PI_VERSION" \
  --build-arg "UID=$(id -u)" --build-arg "GID=$(id -g)" --build-arg "USER=$(id -un)" \
  --build-arg "PACKAGES_SHA=$sha" \
  -t "$IMAGE" "$@" .
