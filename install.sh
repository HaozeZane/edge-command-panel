#!/bin/sh
# Edge Command Agent installer.
#
# Intended to be served by the panel and run as root with a single copied
# command that exports the ECP_* variables (including the Access Service
# Token). Secrets are only read from the environment; they are never placed on
# a command line or printed.
#
# The service runs as the account that invoked the installation:
#   * plain root install            -> root
#   * sudo from Alice               -> Alice (when SUDO_USER/SUDO_UID are
#                                      complete and agree with NSS)
# The target UID/GID/home always come from the NSS passwd/group database;
# inherited HOME and SUDO_GID are not trusted. The systemd sandbox directives
# are kept unchanged.
set -eu
umask 077

CONFIG_DIR=/etc/edge-command-agent
CONFIG_PATH=$CONFIG_DIR/config.json
STATE_DIR=/var/lib/edge-command-agent
BIN_PATH=/usr/local/bin/edge-command-agent
UNIT_PATH=/etc/systemd/system/edge-command-agent.service
SERVICE_NAME=edge-command-agent.service
START=1
TARGET_USER=
TARGET_UID=
TARGET_GID=
TARGET_GROUP=
TARGET_HOME=
TMP_DIR=
BIN_STAGE=
UNIT_STAGE=

usage() {
    cat <<'EOF'
Usage: install.sh [--no-start]

Required environment:
  ECP_URL            panel base URL (https://...)
  ECP_CLIENT_ID      Cloudflare Access Service Token client id
  ECP_CLIENT_SECRET  Cloudflare Access Service Token secret
  ECP_MODE           direct | enroll (inferred from ECP_AGENT_ID if unset)
  ECP_AGENT_ID       required for direct mode

The agent service runs as the account that invoked this installer:
plain root installs use root; sudo installs use SUDO_USER after verifying
SUDO_USER/SUDO_UID against the NSS account database.

--no-start installs and validates the unit but does not enable/start it.
An existing service is stopped first and is left stopped.
EOF
}

fail() {
    echo "error: $*" >&2
    exit 1
}

for arg in "$@"; do
    case "$arg" in
        --no-start) START=0 ;;
        -h|--help) usage; exit 0 ;;
        *) fail "unknown argument: $arg" ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    fail "install.sh must run as root"
fi

if [ "${ECP_URL:-}" = "" ] || [ "${ECP_CLIENT_ID:-}" = "" ] || [ "${ECP_CLIENT_SECRET:-}" = "" ]; then
    fail "ECP_URL, ECP_CLIENT_ID and ECP_CLIENT_SECRET are required"
fi
case "$ECP_URL" in
    https://*) ;;
    *) fail "ECP_URL must use https" ;;
esac
case "${ECP_CLIENT_ID:-}" in *'
'*) fail "ECP_CLIENT_ID contains a newline" ;; esac
case "${ECP_CLIENT_SECRET:-}" in *'
'*) fail "ECP_CLIENT_SECRET contains a newline" ;; esac

MODE=${ECP_MODE:-}
if [ "$MODE" = "" ]; then
    if [ "${ECP_AGENT_ID:-}" != "" ]; then MODE=direct; else MODE=enroll; fi
fi
case "$MODE" in
    direct)
        if [ "${ECP_AGENT_ID:-}" = "" ]; then
            fail "ECP_AGENT_ID is required for direct mode"
        fi
        DOWNLOAD_PATH=agent
        ;;
    enroll) DOWNLOAD_PATH=enroll ;;
    *) fail "ECP_MODE must be direct or enroll" ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) fail "unsupported architecture: $ARCH" ;;
esac

validate_account_name() {
    case "$1" in
        ''|-*|*[!A-Za-z0-9_.@+-]*) return 1 ;;
    esac
    return 0
}

validate_home() {
    [ -n "$TARGET_HOME" ] || fail "target home is empty"
    case "$TARGET_HOME" in
        /*) ;;
        *) fail "target home is not absolute: $TARGET_HOME" ;;
    esac
    case "$TARGET_HOME" in
        *[[:cntrl:]]*) fail "target home contains control characters" ;;
    esac
    case "$TARGET_HOME" in
        /|*/|*//*|*/.|*/..|*/./*|*/../*)
            fail "target home is abnormal: $TARGET_HOME"
            ;;
    esac
    [ ! -L "$TARGET_HOME" ] || fail "target home is a symlink: $TARGET_HOME"
    [ -d "$TARGET_HOME" ] || fail "target home is not a directory: $TARGET_HOME"
}

resolve_identity() {
    if [ "${SUDO_USER+x}" = x ] || [ "${SUDO_UID+x}" = x ]; then
        if [ -z "${SUDO_USER:-}" ] || [ -z "${SUDO_UID:-}" ]; then
            fail "incomplete sudo identity metadata: SUDO_USER and SUDO_UID must both be set"
        fi
        TARGET_USER=$SUDO_USER
        WANT_UID=$SUDO_UID
    else
        TARGET_USER=root
        WANT_UID=0
    fi

    validate_account_name "$TARGET_USER" || fail "refusing abnormal account name: $TARGET_USER"
    case "$WANT_UID" in
        ''|*[!0-9]*) fail "refusing abnormal sudo uid: $WANT_UID" ;;
    esac

    PASSWD_ENTRY=$(getent passwd "$TARGET_USER") || fail "cannot resolve account $TARGET_USER via NSS"
    case "$PASSWD_ENTRY" in
        *'
'*) fail "ambiguous NSS passwd entry for $TARGET_USER" ;;
    esac
    PASSWD_NAME=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f1)
    PASSWD_UID=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f3)
    PASSWD_GID=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f4)
    PASSWD_HOME=$(printf '%s\n' "$PASSWD_ENTRY" | cut -d: -f6)
    [ "$PASSWD_NAME" = "$TARGET_USER" ] || fail "NSS passwd name mismatch for $TARGET_USER"
    [ "$PASSWD_UID" = "$WANT_UID" ] || fail "NSS uid for $TARGET_USER does not match SUDO_UID"
    case "$PASSWD_UID" in
        ''|*[!0-9]*) fail "NSS uid for $TARGET_USER is abnormal" ;;
    esac
    case "$PASSWD_GID" in
        ''|*[!0-9]*) fail "NSS primary gid for $TARGET_USER is abnormal" ;;
    esac

    ID_UID=$(id -u "$TARGET_USER") || fail "id -u failed for $TARGET_USER"
    [ "$ID_UID" = "$PASSWD_UID" ] || fail "id/NSS uid mismatch for $TARGET_USER"
    ID_GID=$(id -g "$TARGET_USER") || fail "id -g failed for $TARGET_USER"
    [ "$ID_GID" = "$PASSWD_GID" ] || fail "id/NSS primary gid mismatch for $TARGET_USER"

    GROUP_ENTRY=$(getent group "$PASSWD_GID") || fail "cannot resolve primary group $PASSWD_GID via NSS"
    case "$GROUP_ENTRY" in
        *'
'*) fail "ambiguous NSS group entry for $PASSWD_GID" ;;
    esac
    GROUP_NAME=$(printf '%s\n' "$GROUP_ENTRY" | cut -d: -f1)
    GROUP_GID=$(printf '%s\n' "$GROUP_ENTRY" | cut -d: -f3)
    [ "$GROUP_GID" = "$PASSWD_GID" ] || fail "NSS group id mismatch for $PASSWD_GID"
    validate_account_name "$GROUP_NAME" || fail "refusing abnormal primary group name: $GROUP_NAME"

    TARGET_UID=$PASSWD_UID
    TARGET_GID=$PASSWD_GID
    TARGET_GROUP=$GROUP_NAME
    TARGET_HOME=$PASSWD_HOME
    validate_home
}

check_managed_paths() {
    for dir in "$CONFIG_DIR" "$STATE_DIR"; do
        [ ! -L "$dir" ] || fail "managed directory is a symlink: $dir"
        if [ -e "$dir" ] && [ ! -d "$dir" ]; then
            fail "managed path is not a directory: $dir"
        fi
    done

    [ ! -L "$CONFIG_PATH" ] || fail "config path is a symlink: $CONFIG_PATH"
    if [ -e "$CONFIG_PATH" ] && [ ! -f "$CONFIG_PATH" ]; then
        fail "config path is not a regular file: $CONFIG_PATH"
    fi

    [ ! -L "$UNIT_PATH" ] || fail "unit path is a symlink: $UNIT_PATH"
    if [ -e "$UNIT_PATH" ] && [ ! -f "$UNIT_PATH" ]; then
        fail "unit path is not a regular file: $UNIT_PATH"
    fi

    [ ! -L "$BIN_PATH" ] || fail "binary path is a symlink: $BIN_PATH"
    if [ -e "$BIN_PATH" ] && [ ! -f "$BIN_PATH" ]; then
        fail "binary path is not a regular file: $BIN_PATH"
    fi

    BIN_DIR=${BIN_PATH%/*}
    [ -d "$BIN_DIR" ] || fail "binary directory does not exist: $BIN_DIR"
    UNIT_DIR=${UNIT_PATH%/*}
    [ -d "$UNIT_DIR" ] || fail "unit directory does not exist: $UNIT_DIR"

    if [ -d "$STATE_DIR" ]; then
        if ! BAD_STATE=$(find "$STATE_DIR" -xdev \( ! -type d ! -type f \) -print); then
            fail "cannot inspect state directory: $STATE_DIR"
        fi
        [ -z "$BAD_STATE" ] || fail "state directory contains a symlink or special file: $BAD_STATE"
    fi
}

unit_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'
}

cleanup() {
    [ -z "${TMP_DIR:-}" ] || rm -rf "$TMP_DIR"
    [ -z "${BIN_STAGE:-}" ] || rm -f "$BIN_STAGE"
    [ -z "${UNIT_STAGE:-}" ] || rm -f "$UNIT_STAGE"
}

stop_existing_service() {
    if [ ! -e "$UNIT_PATH" ]; then
        return 0
    fi
    # Stop unconditionally. Any non-zero exit (including an unreachable
    # manager) is fatal: never migrate while the old service might be running.
    if ! systemctl stop "$SERVICE_NAME"; then
        fail "failed to stop $SERVICE_NAME; no installer changes were made"
    fi
    # Accept only an explicitly inactive/failed state. Unknown output, an
    # active/deactivating service, or a query error is not "stopped".
    if ! ACTIVE_STATE=$(systemctl show --property=ActiveState --value "$SERVICE_NAME"); then
        fail "cannot query $SERVICE_NAME state; no installer changes were made"
    fi
    case "$ACTIVE_STATE" in
        inactive|failed) ;;
        *) fail "failed to confirm $SERVICE_NAME stopped (ActiveState=$ACTIVE_STATE); no installer changes were made" ;;
    esac
}

resolve_identity
check_managed_paths
command -v systemctl >/dev/null 2>&1 || fail "systemctl is required"

TMP_DIR=$(mktemp -d)
trap cleanup EXIT INT TERM

HEADER_FILE=$TMP_DIR/headers
printf 'CF-Access-Client-Id: %s\n' "$ECP_CLIENT_ID" > "$HEADER_FILE"
printf 'CF-Access-Client-Secret: %s\n' "$ECP_CLIENT_SECRET" >> "$HEADER_FILE"
chmod 600 "$HEADER_FILE"

DOWNLOAD_URL="${ECP_URL%/}/$DOWNLOAD_PATH/download/$ARCH"
TMP_BIN=$TMP_DIR/agent
HTTP_CODE=$(curl -sS --proto '=https' --tlsv1.2 -H "@$HEADER_FILE" \
    -o "$TMP_BIN" -w '%{http_code}' "$DOWNLOAD_URL") || {
    fail "failed to download agent binary"
}
if [ "$HTTP_CODE" != "200" ] || [ ! -s "$TMP_BIN" ]; then
    fail "agent download returned HTTP $HTTP_CODE"
fi
chmod 700 "$TMP_BIN"
if ! "$TMP_BIN" version >/dev/null 2>&1; then
    fail "downloaded file is not a working agent binary"
fi

# The old service has to be fully stopped before the binary, configuration or
# state ownership is replaced. Without --no-start it is started again below.
stop_existing_service

install -d -o root -g "$TARGET_GID" -m 0750 "$CONFIG_DIR" || fail "failed to prepare $CONFIG_DIR"
install -d -o "$TARGET_UID" -g "$TARGET_GID" -m 0700 "$STATE_DIR" || fail "failed to prepare $STATE_DIR"
chmod 00750 "$CONFIG_DIR" || fail "failed to set config directory permissions"
chmod 00700 "$STATE_DIR" || fail "failed to set state directory permissions"

BIN_STAGE=${BIN_PATH}.new.$$
install -o root -g root -m 0755 "$TMP_BIN" "$BIN_STAGE" || fail "failed to stage agent binary"
mv -f "$BIN_STAGE" "$BIN_PATH" || fail "failed to replace agent binary"
BIN_STAGE=

if [ "$MODE" = direct ]; then
    "$BIN_PATH" configure -config "$CONFIG_PATH" -state-dir "$STATE_DIR" || fail "configure failed"
else
    "$BIN_PATH" enroll -config "$CONFIG_PATH" -state-dir "$STATE_DIR" || fail "enroll failed"
fi

[ -f "$CONFIG_PATH" ] || fail "agent did not write $CONFIG_PATH"
chown "$TARGET_UID:$TARGET_GID" "$CONFIG_PATH" || fail "failed to set config ownership"
chmod 00600 "$CONFIG_PATH" || fail "failed to set config permissions"

# Do not use recursive chown: reject symlinks/special files and change only
# the explicitly managed state tree, without following links.
if ! BAD_STATE=$(find "$STATE_DIR" -xdev \( ! -type d ! -type f \) -print); then
    fail "cannot inspect state directory after enrollment"
fi
[ -z "$BAD_STATE" ] || fail "state directory contains a symlink or special file: $BAD_STATE"
if ! find "$STATE_DIR" -xdev -exec chown -h "$TARGET_UID:$TARGET_GID" {} +; then
    fail "failed to set state ownership"
fi
chmod 00700 "$STATE_DIR" || fail "failed to set state directory permissions"
if [ -f "$STATE_DIR/installation.json" ]; then
    chmod 00600 "$STATE_DIR/installation.json" || fail "failed to set installation identity permissions"
fi

CONFIG_MODE=$(stat -c '%a' "$CONFIG_PATH") || fail "cannot stat config permissions"
[ "$CONFIG_MODE" = "600" ] || fail "config permissions are $CONFIG_MODE, want 600"
STATE_MODE=$(stat -c '%a' "$STATE_DIR") || fail "cannot stat state directory permissions"
[ "$STATE_MODE" = "700" ] || fail "state directory permissions are $STATE_MODE, want 700"

HOME_ESCAPED=$(unit_escape "$TARGET_HOME")
UNIT_TMP=$TMP_DIR/unit
cat > "$UNIT_TMP" <<EOF
[Unit]
Description=Edge Command Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
WorkingDirectory="$HOME_ESCAPED"
Environment="HOME=$HOME_ESCAPED"
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
UNIT_STAGE=${UNIT_PATH}.new.$$
install -o root -g root -m 0644 "$UNIT_TMP" "$UNIT_STAGE" || fail "failed to stage systemd unit"
mv -f "$UNIT_STAGE" "$UNIT_PATH" || fail "failed to replace systemd unit"
UNIT_STAGE=

systemctl daemon-reload || fail "systemctl daemon-reload failed"

if [ "$START" -eq 0 ]; then
    echo "installed edge-command-agent (not started; --no-start)"
    exit 0
fi

systemctl enable "$SERVICE_NAME" >/dev/null || fail "failed to enable $SERVICE_NAME"
systemctl restart "$SERVICE_NAME" || fail "failed to restart $SERVICE_NAME"

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
