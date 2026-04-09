#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBGRAPH_DIR="$ROOT/subgraph"

log() { echo "▶  $*"; }
ok()  { echo "✔  $*"; }

kill_port() {
  local port=$1 name=$2
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null) || true
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill -15 2>/dev/null || true
    sleep 1
    # force-kill anything still alive
    pids=$(lsof -ti:"$port" 2>/dev/null) || true
    [[ -n "$pids" ]] && echo "$pids" | xargs kill -9 2>/dev/null || true
    ok "Killed $name (port $port)"
  else
    echo "   $name (port $port) — nothing running"
  fi
}

# ─── 1. stop docker stack ─────────────────────────────────────────────────────
if [[ -f "$SUBGRAPH_DIR/docker-compose.yml" ]]; then
  log "Stopping graph-node Docker stack..."
  docker compose -f "$SUBGRAPH_DIR/docker-compose.yml" down 2>/dev/null && ok "Docker stack stopped" || true
fi

# ─── 1b. stop relayer postgres ────────────────────────────────────────────────
log "Stopping relayer PostgreSQL..."
docker rm -f relayer-postgres 2>/dev/null && ok "relayer-postgres removed" || true

# ─── 2. kill nest (relayer) ───────────────────────────────────────────────────
log "Stopping NestJS relayer..."
pkill -f "nest start" 2>/dev/null && ok "NestJS stopped" || true
kill_port 3000 "NestJS (relayer)"

# ─── 3. kill anvil ────────────────────────────────────────────────────────────
log "Killing Anvil..."
kill_port 8545 "Anvil"

# ─── 4. kill any leftover port stragglers ─────────────────────────────────────
log "Cleaning up remaining ports..."
kill_port 8000 "graph-node GraphQL HTTP"
kill_port 8001 "graph-node GraphQL WS"
kill_port 8020 "graph-node admin"
kill_port 8030 "graph-node indexing status"
kill_port 8040 "graph-node metrics"
kill_port 5001 "IPFS"
kill_port 5432 "PostgreSQL (subgraph)"
kill_port 5433 "PostgreSQL (relayer)"

echo ""
ok "All done — stack is torn down."
