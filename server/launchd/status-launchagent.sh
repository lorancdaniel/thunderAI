#!/usr/bin/env bash
set -euo pipefail

LABEL="com.thunderai.server"
UID_VALUE="$(id -u)"
SERVICE_TARGET="gui/${UID_VALUE}/${LABEL}"

echo "Service target: ${SERVICE_TARGET}"
launchctl print "${SERVICE_TARGET}"
