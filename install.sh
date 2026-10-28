#!/bin/sh
# Edge Command Agent installer.
#
# Intended to be served by the panel and run as root with a single copied
# command that exports the ECP_* variables (including the Access Service
# Token). Secrets are only read from the environment; they are never placed on
# a command line or printed.
set -eu
umask 077

CONFIG_DIR=/etc/edge-command-agent
CONFIG_PATH=$CONFIG_DIR/config.json
STATE_DIR=/var/lib/edge-command-agent
BIN_PATH=/usr/local/bin/edge-command-agent
UNIT_PATH=/etc/systemd/system/edge-command-agent.service
SERVICE_NAME=edge-command-agent.service
SERVICE_USER=edge-command
START=1

usage() {
    cat <<'EOF'
Usage: install.sh [--no-start]

Required environment:
  ECP_URL            panel base URL (https://...)
  ECP_CLIENT_ID      Cloudflare Access Service Token client id
  ECP_CLIENT_SECRET  Cloudflare Access Service Token secret
  ECP_MODE           direct | enroll (inferred from ECP_AGENT_ID if unset)
  ECP_AGENT_ID       required for direct mode

--no-start installs and validates the unit but does not enable/start it.
EOF
}

for arg in "$@"; do
    case "$arg" in
        --no-start) START=0 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "error: install.sh must run as root" >&2
    exit 1
fi

if [ "${ECP_URL:-}" = "" ] || [ "${ECP_CLIENT_ID:-}" = "" ] || [ "${ECP_CLIENT_SECRET:-}" = "" ]; then
    echo "error: ECP_URL, ECP_CLIENT_ID and ECP_CLIENT_SECRET are required" >&2
    exit 1
fi
case "$ECP_URL" in
    https://*) ;;
    *) echo "error: ECP_URL must use https" >&2; exit 1 ;;
esac
case "${ECP_CLIENT_ID:-}" in *'
'*) echo "error: ECP_CLIENT_ID contains a newline" >&2; exit 1 ;; esac
case "${ECP_CLIENT_SECRET:-}" in *'
'*) echo "error: ECP_CLIENT_SECRET contains a newline" >&2; exit 1 ;; esac

MODE=${ECP_MODE:-}
if [ "$MODE" = "" ]; then
    if [ "${ECP_AGENT_ID:-}" != "" ]; then MODE=direct; else MODE=enroll; fi
fi
case "$MODE" in
    direct)
        if [ "${ECP_AGENT_ID:-}" = "" ]; then
            echo "error: ECP_AGENT_ID is required for direct mode" >&2
            exit 1
        fi
        DOWNLOAD_PATH=agent
        ;;
    enroll) DOWNLOAD_PATH=enroll ;;
    *) echo "error: ECP_MODE must be direct or enroll" >&2; exit 1 ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "error: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

TMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

HEADER_FILE=$TMP_DIR/headers
printf 'CF-Access-Client-Id: %s\n' "$ECP_CLIENT_ID" > "$HEADER_FILE"
printf 'CF-Access-Client-Secret: %s\n' "$ECP_CLIENT_SECRET" >> "$HEADER_FILE"
chmod 600 "$HEADER_FILE"

DOWNLOAD_URL="${ECP_URL%/}/$DOWNLOAD_PATH/download/$ARCH"
TMP_BIN=$TMP_DIR/agent
HTTP_CODE=$(curl -sS --proto '=https' --tlsv1.2 -H "@$HEADER_FILE" \
    -o "$TMP_BIN" -w '%{http_code}' "$DOWNLOAD_URL") || {
    echo "error: failed to download agent binary" >&2
    exit 1
}
if [ "$HTTP_CODE" != "200" ] || [ ! -s "$TMP_BIN" ]; then
    echo "error: agent download returned HTTP $HTTP_CODE" >&2
    exit 1
fi
chmod 700 "$TMP_BIN"
if ! "$TMP_BIN" version >/dev/null 2>&1; then
    echo "error: downloaded file is not a working agent binary" >&2
    exit 1
fi
install -o root -g root -m 0755 "$TMP_BIN" "$BIN_PATH"

if ! getent group "$SERVICE_USER" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_USER"
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    NOLOGIN=$(command -v nologin 2>/dev/null || true)
    if [ "$NOLOGIN" = "" ]; then NOLOGIN=/usr/sbin/nologin; fi
    useradd --system --gid "$SERVICE_USER" --home-dir "$STATE_DIR" \
        --no-create-home --shell "$NOLOGIN" "$SERVICE_USER"
fi

install -d -o root -g "$SERVICE_USER" -m 0750 "$CONFIG_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$STATE_DIR"

if [ "$MODE" = direct ]; then
    "$BIN_PATH" configure -config "$CONFIG_PATH" -state-dir "$STATE_DIR"
else
    "$BIN_PATH" enroll -config "$CONFIG_PATH" -state-dir "$STATE_DIR"
fi

# The agent runs as the dedicated unprivileged account. The config (which
# contains the long-lived token) is 0600 and owned by that account; the state
# directory keeps the enrollment key readable only by the same account.
chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
chmod 700 "$STATE_DIR"
if [ "$(stat -c '%a' "$CONFIG_PATH")" != "600" ]; then
    echo "error: failed to set config permissions" >&2
    exit 1
fi

UNIT_TMP=$TMP_DIR/unit
cat > "$UNIT_TMP" <<EOF
[Unit]
Description=Edge Command Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$STATE_DIR
Environment=HOME=$STATE_DIR
ExecStart=$BIN_PATH -config $CONFIG_PATH
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=30
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$UNIT_TMP" "$UNIT_PATH"

if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
else
    echo "error: systemctl is required" >&2
    exit 1
fi

if [ "$START" -eq 0 ]; then
    echo "installed edge-command-agent (not started; --no-start)"
    exit 0
fi

systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

i=0
while [ "$i" -lt 20 ]; do
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        echo "installed and started edge-command-agent"
        exit 0
    fi
    i=$((i + 1))
    sleep 1
done

echo "error: edge-command-agent did not become active" >&2
systemctl status --no-pager -l "$SERVICE_NAME" >&2 || true
exit 1
