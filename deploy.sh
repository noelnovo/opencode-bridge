#!/bin/sh
# LXC103: stage source only by default. Activation requires explicit owner approval.
# NEVER installs an env loader or replaces the official Vault Agent/OpenRC wiring.
set -eu
MODE=${1:---stage}
EXPECTED=${2:-}
case "$MODE" in
  --stage) ;;
  --activate-with-owner-approval) [ -n "$EXPECTED" ] || { echo 'Supply the inspected current bridge SHA256' >&2; exit 1; } ;;
  *) echo 'Usage: ./deploy.sh [--stage | --activate-with-owner-approval CURRENT_SHA256]' >&2; exit 1 ;;
esac
[ "$(id -u)" = 0 ] || { echo 'Run on LXC103 as root' >&2; exit 1; }
[ -f bridge.mjs ] && [ -f auth.mjs ] && [ -f tasks.mjs ] || { echo 'Run from the source directory' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
node --check bridge.mjs
node --check auth.mjs
node --check tasks.mjs
node --test tests/*.test.mjs
# Require the existing official supervision rather than reviving the retired loader.
grep -q 'clean-exec.py agent-bridge' /etc/init.d/opencode-bridge
test -f /etc/vault-agent/native-opencode-bridge/config/agent.hcl
ROOT=/opt/opencode-bridge
VERSION=$(sha256sum bridge.mjs auth.mjs tasks.mjs | sha256sum | cut -c1-16)
RELEASE="$ROOT/releases/$VERSION"
mkdir -p "$RELEASE"
chmod 755 "$ROOT/releases" "$RELEASE"
for file in bridge.mjs auth.mjs tasks.mjs; do
  if [ -f "$RELEASE/$file" ]; then
    cmp "$file" "$RELEASE/$file"
  else
    install -o root -g root -m 644 "$file" "$RELEASE/$file"
  fi
done
printf 'Staged release: %s\n' "$VERSION"
[ "$MODE" = --activate-with-owner-approval ] || exit 0
node scripts/check-activation.mjs
CURRENT=$(sha256sum "$ROOT/bridge.mjs" | cut -d ' ' -f 1)
[ "$CURRENT" = "$EXPECTED" ] || { echo 'Bridge changed since inspection; refusing activation' >&2; exit 1; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="/var/backups/opencode-bridge-task-upgrade/$STAMP"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
cp -pL "$ROOT/bridge.mjs" "$BACKUP/bridge.mjs"
if [ -L "$ROOT/bridge.mjs" ]; then readlink "$ROOT/bridge.mjs" > "$BACKUP/previous-target"; fi
for file in auth.mjs tasks.mjs; do
  if [ -f "$ROOT/$file" ]; then cp -pL "$ROOT/$file" "$BACKUP/$file"; fi
done
ln -s "releases/$VERSION/bridge.mjs" "$ROOT/bridge-next.mjs"
mv -f "$ROOT/bridge-next.mjs" "$ROOT/bridge.mjs"
printf 'Activated source; restarting only opencode-bridge. Backup: %s\n' "$BACKUP"
rollback() {
  [ "$(readlink "$ROOT/bridge.mjs")" = "releases/$VERSION/bridge.mjs" ] || { echo 'Entrypoint changed concurrently; refusing automatic rollback' >&2; return 1; }
  rc-service opencode-bridge stop
  if [ -f "$BACKUP/previous-target" ]; then
    ln -s "$(cat "$BACKUP/previous-target")" "$ROOT/bridge-rollback.mjs"
  else
    cp -p "$BACKUP/bridge.mjs" "$ROOT/bridge-rollback.mjs"
  fi
  mv -f "$ROOT/bridge-rollback.mjs" "$ROOT/bridge.mjs"
  rc-service opencode-bridge start
  echo 'Previous entrypoint restored; task/session history preserved.' >&2
}
if ! rc-service opencode-bridge restart; then rollback; exit 1; fi
if ! curl --max-time 10 -fsS http://127.0.0.1:4780/health >/dev/null; then rollback; exit 1; fi
if [ "$(curl --max-time 10 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4780/mcp)" != 401 ]; then
  echo 'Unexpected authentication result; owner review required' >&2
  exit 1
fi
echo 'Bridge healthy; anonymous MCP rejected. Reconnect clients to refresh tools.'
