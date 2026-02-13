#!/usr/bin/env bash
set -euo pipefail

LABEL="com.thunderai.server"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_VALUE="$(id -u)"
SERVICE_TARGET="gui/${UID_VALUE}/${LABEL}"

launchctl bootout "${SERVICE_TARGET}" >/dev/null 2>&1 || true
rm -f "${PLIST_PATH}"

echo "LaunchAgent removed: ${PLIST_PATH}"
