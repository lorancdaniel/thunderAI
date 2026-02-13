#!/usr/bin/env bash
set -euo pipefail

LABEL="com.thunderai.server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_PATH="${SCRIPT_DIR}/com.thunderai.server.plist.template"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"
STDOUT_LOG="${LOG_DIR}/thunderai-server.log"
STDERR_LOG="${LOG_DIR}/thunderai-server.error.log"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
HOST_VALUE="${HOST:-127.0.0.1}"
PORT_VALUE="${PORT:-8787}"
CODEX_WORKDIR_VALUE="${CODEX_WORKDIR:-${HOME}}"
PATH_VALUE="${PATH}"
UID_VALUE="$(id -u)"
SERVICE_TARGET="gui/${UID_VALUE}/${LABEL}"

if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  echo "Template not found: ${TEMPLATE_PATH}" >&2
  exit 1
fi

if [[ -z "${NODE_BIN}" ]]; then
  echo "Cannot find node binary. Set NODE_BIN=/absolute/path/to/node and retry." >&2
  exit 1
fi

if [[ -z "${CODEX_BIN}" ]]; then
  echo "Cannot find codex binary. Set CODEX_BIN=/absolute/path/to/codex and retry." >&2
  exit 1
fi

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

mkdir -p "$(dirname "${PLIST_PATH}")" "${LOG_DIR}"

tmp_plist="$(mktemp)"
trap 'rm -f "${tmp_plist}"' EXIT

sed \
  -e "s/{{NODE_BIN}}/$(escape_sed "${NODE_BIN}")/g" \
  -e "s/{{SERVER_INDEX_JS}}/$(escape_sed "${SERVER_DIR}/index.js")/g" \
  -e "s/{{SERVER_DIR}}/$(escape_sed "${SERVER_DIR}")/g" \
  -e "s/{{PATH_VALUE}}/$(escape_sed "${PATH_VALUE}")/g" \
  -e "s/{{HOST_VALUE}}/$(escape_sed "${HOST_VALUE}")/g" \
  -e "s/{{PORT_VALUE}}/$(escape_sed "${PORT_VALUE}")/g" \
  -e "s/{{CODEX_BIN}}/$(escape_sed "${CODEX_BIN}")/g" \
  -e "s/{{CODEX_WORKDIR}}/$(escape_sed "${CODEX_WORKDIR_VALUE}")/g" \
  -e "s/{{STDOUT_LOG}}/$(escape_sed "${STDOUT_LOG}")/g" \
  -e "s/{{STDERR_LOG}}/$(escape_sed "${STDERR_LOG}")/g" \
  "${TEMPLATE_PATH}" > "${tmp_plist}"

mv "${tmp_plist}" "${PLIST_PATH}"

launchctl bootout "${SERVICE_TARGET}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_VALUE}" "${PLIST_PATH}"
launchctl enable "${SERVICE_TARGET}" >/dev/null 2>&1 || true
launchctl kickstart -k "${SERVICE_TARGET}"

echo "LaunchAgent installed: ${PLIST_PATH}"
echo "Service: ${SERVICE_TARGET}"
echo "Server should now autostart at login and restart on crash."
echo "Logs:"
echo "  stdout: ${STDOUT_LOG}"
echo "  stderr: ${STDERR_LOG}"
