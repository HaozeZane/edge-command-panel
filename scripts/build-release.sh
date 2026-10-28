#!/bin/sh
# Build the Linux agent release attachments for this branch.
#
# Usage:
#   scripts/build-release.sh [VERSION]
#
# VERSION defaults to 0.1.0. The form "agent-v0.1.0" (and "v0.1.0") is
# normalized to 0.1.0. Output goes to .release/agent-v<VERSION> by default;
# set RELEASE_OUTPUT_DIR to override it.
#
# This script only builds locally. It never calls gh, Wrangler, or GitHub
# Actions, and it does not require the repository to have a commit yet.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

usage() {
    cat <<'EOF'
Usage: scripts/build-release.sh [VERSION]

VERSION        release version (default: 0.1.0); "agent-v0.1.0" is accepted
GO             Go executable to use (default: go)
RELEASE_OUTPUT_DIR
               output directory (default: .release/agent-v<VERSION>)

Produces:
  edge-agent-linux-amd64
  edge-agent-linux-arm64
  install.sh
  SHA256SUMS
EOF
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac
if [ "$#" -gt 1 ]; then
    usage >&2
    exit 2
fi

RAW_VERSION=${1:-0.1.0}
case "$RAW_VERSION" in
    agent-v*) VERSION=${RAW_VERSION#agent-v} ;;
    v*) VERSION=${RAW_VERSION#v} ;;
    *) VERSION=$RAW_VERSION ;;
esac

case "$VERSION" in
    ""|.|..|*..*|.*|*.|*[!0-9A-Za-z.+-]*)
        echo "error: invalid version: $RAW_VERSION" >&2
        exit 2
        ;;
esac
case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *)
        echo "error: version must look like 0.1.0 or agent-v0.1.0" >&2
        exit 2
        ;;
esac

GO=${GO:-go}
if ! command -v "$GO" >/dev/null 2>&1; then
    echo "error: Go executable not found: $GO (set GO=/path/to/go)" >&2
    exit 1
fi
if [ ! -f "$ROOT/go.mod" ] || [ ! -d "$ROOT/cmd/edge-command-agent" ]; then
    echo "error: $ROOT is not the agent module root" >&2
    exit 1
fi

if [ -n "${RELEASE_OUTPUT_DIR:-}" ]; then
    case "$RELEASE_OUTPUT_DIR" in
        /*) OUT=$RELEASE_OUTPUT_DIR ;;
        *) OUT=$ROOT/$RELEASE_OUTPUT_DIR ;;
    esac
else
    OUT=$ROOT/.release/agent-v$VERSION
fi

cd "$ROOT"
mkdir -p "$OUT"

# Remove only known outputs so a stale file cannot end up in SHA256SUMS.
rm -f "$OUT/edge-agent-linux-amd64" "$OUT/edge-agent-linux-arm64" \
    "$OUT/install.sh" "$OUT/SHA256SUMS"

LDFLAGS="-s -w -X main.Version=$VERSION"

echo "building edge-command-agent $VERSION"
echo "go: $("$GO" version)"

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "$GO" build -trimpath \
    -ldflags "$LDFLAGS" \
    -o "$OUT/edge-agent-linux-amd64" ./cmd/edge-command-agent

CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO" build -trimpath \
    -ldflags "$LDFLAGS" \
    -o "$OUT/edge-agent-linux-arm64" ./cmd/edge-command-agent

cp "$ROOT/install.sh" "$OUT/install.sh"
chmod 0755 "$OUT/install.sh"

(
    cd "$OUT"
    sha256sum edge-agent-linux-amd64 edge-agent-linux-arm64 install.sh \
        > SHA256SUMS
)

# Local-only receipt; deliberately outside the release directory so the four
# fixed attachments stay unchanged. A missing HEAD is recorded as UNKNOWN.
COMMIT=UNKNOWN
if command -v git >/dev/null 2>&1; then
    COMMIT=$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null || echo UNKNOWN)
fi
RECEIPT=$OUT.receipt.txt
{
    echo "version=$VERSION"
    echo "go=$("$GO" version)"
    echo "builtAtUtc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "sourceCommit=$COMMIT"
} > "$RECEIPT"

echo "output: $OUT"
echo "receipt: $RECEIPT"
cat "$OUT/SHA256SUMS"
