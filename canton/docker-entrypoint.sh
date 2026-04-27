#!/bin/bash
set -e

LEDGER_PORT=${LEDGER_PORT:-6865}
JSON_API_INTERNAL=17575
EXTERNAL_PORT=${PORT:-7575}

echo "[canton] Starting proxy on 0.0.0.0:$EXTERNAL_PORT -> 127.0.0.1:$JSON_API_INTERNAL (socat starts first so Railway health check passes)"
socat TCP-LISTEN:"$EXTERNAL_PORT",fork,reuseaddr TCP:127.0.0.1:"$JSON_API_INTERNAL" &

echo "[canton] Starting daml sandbox (ledger: $LEDGER_PORT, json-api: $JSON_API_INTERNAL)..."
daml start \
  --sandbox-port "$LEDGER_PORT" \
  --json-api-port "$JSON_API_INTERNAL" \
  --wait-for-signal yes &
DAML_PID=$!

echo "[canton] Waiting for JSON API to be ready..."
until curl -sf "http://127.0.0.1:$JSON_API_INTERNAL/v2/state/ledger-end" > /dev/null 2>&1; do
  sleep 3
  echo "[canton] Still waiting..."
done
echo "[canton] Canton is fully ready."

wait $DAML_PID
