#!/usr/bin/env node
// Read-only activation gate. No credentials or session payloads are emitted.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { makeAuth, makeAPI } from '../auth.mjs';

try {
  const health = await fetch('http://127.0.0.1:4780/health', { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error('Bridge health unavailable');
  const status = await health.json();
  if (status.queued > 0) throw new Error('Existing Bridge requests are unfinished');
  const pids = readdirSync('/proc').filter((entry) => {
    if (!/^\d+$/.test(entry)) return false;
    try { return readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').includes('/opt/opencode-bridge/bridge.mjs'); } catch { return false; }
  });
  if (pids.length !== 1) throw new Error('Expected exactly one serving Bridge process');
  const env = Object.fromEntries(readFileSync(`/proc/${pids[0]}/environ`, 'utf8').split('\0').filter(Boolean).map((entry) => {
    const equal = entry.indexOf('='); return [entry.slice(0, equal), entry.slice(equal + 1)];
  }));
  const auth = makeAuth({ issuer: env.OPENCODE_OIDC_ISSUER, clientID: env.KEYCLOAK_AUTOMATION_CLIENT_ID, clientSecret: env.KEYCLOAK_AUTOMATION_CLIENT_SECRET });
  const api = makeAPI('http://127.0.0.1:4096', auth);
  const active = await api('GET', '/api/session/active');
  if (!active.ok) throw new Error('Cannot verify server execution state');
  const stateDir = env.BRIDGE_STATE_DIR || '/var/lib/opencode-bridge';
  if (existsSync(`${stateDir}/session.json`)) {
    if (statSync(`${stateDir}/session.json`).size > 8192) throw new Error('Unexpected legacy session metadata');
    const session = JSON.parse(readFileSync(`${stateDir}/session.json`, 'utf8')).id;
    if (active.payload.data?.[session]) throw new Error('Legacy Bridge session is still running; wait for completion');
  }
  if (existsSync(`${stateDir}/tasks.sqlite`)) {
    const db = new DatabaseSync(`${stateDir}/tasks.sqlite`, { readOnly: true });
    try {
      if (db.prepare("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('queued','succeeded','failed','cancelled')").get().n > 0) throw new Error('Bridge has unfinished tasks; review before activation');
    } finally { db.close(); }
  }
  console.log('Activation gate passed: existing Bridge work is idle.');
} catch (error) {
  // Only errors created above are useful; avoid upstream payloads/stacks.
  console.error('Activation gate refused; verify Bridge health and unfinished work before maintenance.');
  process.exitCode = 1;
}
