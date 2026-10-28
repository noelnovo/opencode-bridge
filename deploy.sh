#!/bin/sh
# Install / update the DownOps MCP bridge on LXC 103 (Alpine, OpenRC).
# Run as root from a checkout of this repository: ./deploy.sh
#
# Copies the files to their runtime paths, fixes ownership and modes, restarts
# the service and verifies the unauthenticated health endpoint.
set -eu

BRIDGE_DIR=/opt/opencode-bridge
INIT=/etc/init.d/opencode-bridge
ENV_LOADER=/usr/local/sbin/opencode-bridge-env
SYNC=/usr/local/bin/opencode-downops-sync
SELFTEST=/usr/local/bin/opencode-bridge-selftest.mjs
STAMP=$(date -u +%Y%m%d-%H%M%S)

[ "$(id -u)" = "0" ] || { echo "deploy.sh must run as root" >&2; exit 1; }
[ -f ./bridge.mjs ] || { echo "run deploy.sh from the repository root" >&2; exit 1; }
command -v node >/dev/null || { echo "node is missing" >&2; exit 1; }

echo "==> installing $BRIDGE_DIR/bridge.mjs"
mkdir -p "$BRIDGE_DIR"
[ -f "$BRIDGE_DIR/bridge.mjs" ] && cp -p "$BRIDGE_DIR/bridge.mjs" "$BRIDGE_DIR/bridge.mjs.bak.$STAMP"
install -o opencode -g opencode -m 644 bridge.mjs "$BRIDGE_DIR/bridge.mjs.new"
mv "$BRIDGE_DIR/bridge.mjs.new" "$BRIDGE_DIR/bridge.mjs"

echo "==> installing init script, env loader, helper scripts"
[ -f "$INIT" ] && cp -p "$INIT" "$INIT.bak.$STAMP"
install -o root -g root -m 755 init/opencode-bridge "$INIT"
install -o root -g root -m 750 init/opencode-bridge-env "$ENV_LOADER"
install -o root -g root -m 755 scripts/opencode-downops-sync "$SYNC"
install -o root -g root -m 755 scripts/opencode-bridge-selftest.mjs "$SELFTEST"

echo "==> syntax checks"
node --check bridge.mjs
sh -n "$ENV_LOADER"
sh -n "$SYNC"

echo "==> restarting opencode-bridge"
rc-service opencode-bridge restart
sleep 2
rc-service opencode-bridge status || { tail -n 30 /var/log/opencode-bridge/bridge.err; exit 1; }

echo "==> health"
curl -fsS http://127.0.0.1:4780/health >/dev/null || { tail -n 30 /var/log/opencode-bridge/bridge.err; exit 1; }
curl -s http://127.0.0.1:4780/health | head -c 400; echo
curl -s -o /dev/null -w 'unauthenticated /mcp -> %{http_code}\n' http://127.0.0.1:4780/mcp
echo "done"
