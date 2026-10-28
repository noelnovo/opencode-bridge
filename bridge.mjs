#!/usr/bin/env node
/**
 * OpenCode DownOps bridge.
 *
 * Gives the owner's Windows OpenCode agent full management access to the whole
 * DownOps estate, without ever handing the Windows machine a credential that
 * this server accepts.
 *
 *   Windows agent --(Keycloak access token)--> this service :4780
 *   this service  --(Keycloak service-account bearer)--> 127.0.0.1:4096
 *
 * The answering session runs with FULL permissions (owner decision
 * 2026-10-27): shell, edit, write, webfetch and every other tool are allowed,
 * nothing is sandboxed. Its working directory is /srv (the live context repo
 * /srv/opencode plus source-only mirrors of every DownOps git repo in
 * /srv/downops/repos), but it may read, write and execute anywhere the
 * `opencode` user can — including the estate's SSH aliases (dev, proxmox,
 * malza, 103) and the local OpenCode server.
 *
 * Endpoints:
 *   GET  /health   liveness (no auth, no secrets)
 *   POST /ask      {question} -> {answer, session_id, elapsed_ms}
 *   POST /mcp      MCP streamable-HTTP (JSON-RPC): tools ask_downops,
 *                  read_downops_file, grep_downops, list_downops
 */

import { createServer } from 'node:http';
import { createPublicKey, createVerify } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.BRIDGE_PORT || 4780);
const BIND = process.env.BRIDGE_BIND || '0.0.0.0';
const API = process.env.BRIDGE_API_BASE || 'http://127.0.0.1:4096';
const KC_ID = process.env.KEYCLOAK_AUTOMATION_CLIENT_ID || '';
const KC_SECRET = process.env.KEYCLOAK_AUTOMATION_CLIENT_SECRET || '';
const ISSUER = process.env.OPENCODE_OIDC_ISSUER || '';
const WORKSPACE_DIR = path.resolve(process.env.BRIDGE_WORKSPACE_DIR || '/srv');
/* Root for the direct file tools (read_downops_file / grep_downops /
 * list_downops). Defaults to '/' because the bridge is a management channel:
 * the remote agent may read any file the `opencode` user can. */
const FILES_ROOT = path.resolve(process.env.BRIDGE_FILES_ROOT || '/');
const MODEL = {
  providerID: process.env.BRIDGE_MODEL_PROVIDER || 'deepseek',
  id: process.env.BRIDGE_MODEL_ID || 'deepseek-flash',
};
const STATE_DIR = process.env.BRIDGE_STATE_DIR || '/var/lib/opencode-bridge';
const LOG_DIR = process.env.BRIDGE_LOG_DIR || '/var/log/opencode-bridge';
const SESSION_FILE = path.join(STATE_DIR, 'session.json');
const AUDIT_FILE = path.join(LOG_DIR, 'audit.log');
const AUDIT_MAX_BYTES = 8 * 1024 * 1024;

const LIMITS = {
  questionBytes: 8192,
  answerBytes: 200000,
  askTimeoutMs: Number(process.env.BRIDGE_ASK_TIMEOUT_MS || 600000),
  perMinute: Number(process.env.BRIDGE_PER_MINUTE || 10),
  maxQueue: Number(process.env.BRIDGE_MAX_QUEUE || 3),
  fileBytes: 200000,
  grepResults: 100,
  grepFileBytes: 2 * 1024 * 1024,
};

/* Full access. Owner decision 2026-10-27: the bridge is a management channel,
 * not a read-only Q&A channel, so the session gets a single blanket allow.
 * permission.evaluate uses findLast, so one allow-* rule is sufficient and
 * there is deliberately no deny rule after it. */
const SESSION_RULES = [
  { action: '*', resource: '*', effect: 'allow' },
];

const PRIMER = [
  'You are the DownOps operations agent, answering a remote OpenCode agent that builds and runs the DownOps estate.',
  'You have FULL access: shell, read, write, edit, grep, glob, webfetch. Nothing is sandboxed — use them.',
  'Hosts reachable from this box via ssh (config in /var/lib/opencode/.ssh/config): `dev` (LXC 110, /home/dev/<repo> clones, Docker, builds),',
  '`proxmox` (PVE 10.2.0.2, use pct exec 103/104/105/109/110/112/113/114/115), `malza` (k3s + Vault + Harbor host), and locally this OpenCode server on 127.0.0.1:4096.',
  'Layout: /srv/opencode is the live context repo (AGENTS.md, skills/, customers/<name>/); /srv/downops/repos/<repo> holds source-only mirrors of every DownOps git repository',
  '(awesome-design-md, dependency-track-plugin, dev-blog, docs-wiki, dummy-api, mail-gateway, minecraft, nn-PortFolio, obsidian_notes, opencode, opencode-config,',
  'prompt-gateway, raju-doner-kebab, raju-doner-kebab-gitops, sms-gateway, tools, vault-env-agent, wallet-backend). Mirrors exclude node_modules, .git, .venv, dist, .next and',
  'secret-bearing files; read live files on the target host instead of trusting a mirror for secrets or git history.',
  'Conventions: every change lands in three places (dev clone, GitLab, GitHub) per the repo-dual-push skill; secrets come from Vault (never hardcode, never print a secret value);',
  'k3s is managed with `k3s kubectl` on malza and deploys through ArgoCD from GitLab; LXCs use OpenRC (103) or Docker (109/112/114).',
  'Act instead of describing: run the commands, make the change, then verify and report the concrete result. Ask before anything destructive (deleting data, stopping production services,',
  'firewall/network changes, revoking tokens) when the request is ambiguous. Never print secret values; show key names, lengths or hashes instead.',
  'Keep answers compact and factual. Reply with exactly: READY',
].join(' ');

// OAuth is the only accepted authentication. There is deliberately no static
// key: every caller must present a Keycloak access token minted for the
// downops-mcp client by a user in the required group.
if (!ISSUER || !KC_ID || !KC_SECRET) {
  console.error('bridge: OIDC configuration is incomplete (issuer / client id / client secret); refusing to start');
  process.exit(1);
}
if (process.env.OPENCODE_BRIDGE_KEY) {
  log('OPENCODE_BRIDGE_KEY is set but ignored: the bridge only accepts Keycloak OAuth tokens');
}

/* ---------------------------------------------------- OAuth resource server */
/* MCP clients discover this via /.well-known/oauth-protected-resource (and the
 * 401 WWW-Authenticate header), authenticate against Keycloak with PKCE, and
 * come back with a Keycloak access token. The static bridge key still works as
 * a fallback for curl/CI. */

const RESOURCE_URL = process.env.BRIDGE_RESOURCE_URL || 'https://ask.int.downops.win';
const OAUTH_CLIENT_ID = process.env.BRIDGE_OAUTH_CLIENT_ID || 'downops-mcp';
const REQUIRED_GROUP = process.env.BRIDGE_REQUIRED_GROUP || 'admin';
const WELL_KNOWN = '/.well-known/oauth-protected-resource';

let jwksCache = { keys: [], at: 0 };

async function jwks(force = false) {
  if (!force && jwksCache.keys.length && Date.now() - jwksCache.at < 300000) return jwksCache.keys;
  const response = await fetch(`${ISSUER}/protocol/openid-connect/certs`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`jwks request failed: HTTP ${response.status}`);
  const body = await response.json();
  jwksCache = { keys: (body.keys || []).filter((key) => key.kty === 'RSA'), at: Date.now() };
  return jwksCache.keys;
}

async function verifyAccessToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not-a-jwt' };
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'unparsable' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: `alg-${header.alg}` };
  let keys = await jwks();
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    keys = await jwks(true);
    jwk = keys.find((key) => key.kid === header.kid);
  }
  if (!jwk) return { ok: false, reason: 'unknown-kid' };
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  if (!verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'))) {
    return { ok: false, reason: 'bad-signature' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) return { ok: false, reason: 'issuer-mismatch', claims };
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) return { ok: false, reason: 'expired', claims };
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return { ok: false, reason: 'not-yet-valid', claims };
  if (claims.azp !== OAUTH_CLIENT_ID) return { ok: false, reason: `azp-${claims.azp ?? 'none'}`, claims };
  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  if (!groups.includes(REQUIRED_GROUP)) return { ok: false, reason: `missing-group-${REQUIRED_GROUP}`, claims };
  return { ok: true, claims };
}

/** Keycloak access token only. No static key, no anonymous path. */
async function authenticate(request) {
  const header = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { ok: false };
  const result = await verifyAccessToken(match[1].trim())
    .catch((error) => ({ ok: false, reason: `error-${error.message}` }));
  if (!result.ok) {
    log(`oauth token rejected: ${result.reason}${result.claims?.azp ? ` (azp=${result.claims.azp})` : ''}`);
    return { ok: false, rejected: true };
  }
  return {
    ok: true,
    subject: result.claims.preferred_username || result.claims.email || result.claims.sub,
    scheme: 'oidc',
  };
}

function unauthorized(response) {
  const body = JSON.stringify({ error: 'unauthorized' });
  response.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'www-authenticate': `Bearer resource_metadata="${RESOURCE_URL}${WELL_KNOWN}"`,
  });
  response.end(body);
}

/* ---------------------------------------------------------------- utilities */

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function audit(entry) {
  try {
    if (existsSync(AUDIT_FILE) && statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES) {
      try { renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`); } catch { /* keep writing to the current file */ }
      try { writeFileSync(AUDIT_FILE, ''); } catch { /* ignore */ }
    }
    appendFileSync(AUDIT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (error) {
    log('audit write failed:', error.message);
  }
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', (error) => reject(error));
  });
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/* ------------------------------------------------------- Keycloak + API auth */

let cachedToken = null; // { value, expiresAt }

async function keycloakToken(force = false) {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.value;
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KC_ID,
      client_secret: KC_SECRET,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`keycloak token request failed: HTTP ${response.status}`);
  const payload = await response.json();
  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in || 300) - 30) * 1000,
  };
  return cachedToken.value;
}

async function api(method, route, body, { timeoutMs = 30000, retry = true } = {}) {
  const token = await keycloakToken();
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (response.status === 401 && retry) {
    await keycloakToken(true);
    return api(method, route, body, { timeoutMs, retry: false });
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  return { status: response.status, ok: response.ok, payload };
}

/* ------------------------------------------------------------- the session */

function readSessionId() {
  try {
    const stored = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    return typeof stored.id === 'string' ? stored.id : null;
  } catch {
    return null;
  }
}

function writeSessionId(id) {
  writeFileSync(SESSION_FILE, JSON.stringify({ id, contractDir: WORKSPACE_DIR, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

async function listMessages(sessionId) {
  const { ok, status, payload } = await api('GET', `/api/session/${sessionId}/message`);
  if (!ok) throw new Error(`message list failed: HTTP ${status}`);
  return Array.isArray(payload?.data) ? payload.data : [];
}

function answerFrom(messages, seen) {
  const fresh = messages
    .filter((message) => !seen.has(message.id) && message.type === 'assistant')
    .sort((left, right) => (left.time?.created || 0) - (right.time?.created || 0));
  const parts = [];
  for (const message of fresh) {
    for (const item of message.content || []) {
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    }
  }
  let answer = parts.join('\n\n').trim();
  if (answer.length > LIMITS.answerBytes) answer = `${answer.slice(0, LIMITS.answerBytes)}\n\n[truncated]`;
  return answer;
}

/** Provider/session failures surface as an `idle` message with an outcome. */
function failureFrom(messages, seen) {
  const failed = messages
    .filter((message) => !seen.has(message.id) && message.type === 'idle' && message.outcome
      && message.outcome !== 'completed' && message.outcome !== 'succeeded')
    .sort((left, right) => (right.time?.created || 0) - (left.time?.created || 0))[0];
  if (!failed) return null;
  const detail = failed.error?.message || failed.error?.type || failed.outcome;
  return `agent run failed: ${String(detail).slice(0, 300)}`;
}

async function primeSession(sessionId) {
  const seen = new Set((await listMessages(sessionId)).map((message) => message.id));
  await api('POST', `/api/session/${sessionId}/prompt`, { text: PRIMER });
  const outcome = await waitForRun(sessionId, seen, 180000);
  log(`primed session ${sessionId} (${outcome.timedOut ? 'timed out' : 'ok'})`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `session.wait` returns as soon as the session *is* idle, which can happen
 * before the just-admitted prompt starts running. So wait, then look for a
 * fresh `idle` message that marks the end of our own run, and retry until one
 * shows up or the deadline passes.
 */
async function waitForRun(sessionId, seen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { timedOut: true, messages: [], idle: null };
    try {
      await api('POST', `/api/experimental/session/${sessionId}/wait`, {}, { timeoutMs: Math.min(remaining, 120000) });
    } catch { /* timed out or aborted: check the message list anyway */ }
    const messages = await listMessages(sessionId);
    const idle = messages.find((message) => !seen.has(message.id) && message.type === 'idle');
    if (idle) return { timedOut: false, messages, idle };
    await sleep(300);
  }
}

async function ensureSession(reset) {
  if (reset) {
    const existing = readSessionId();
    if (existing) await api('DELETE', `/api/session/${existing}`).catch(() => {});
    try { unlinkSync(SESSION_FILE); } catch { /* already gone */ }
  }
  const existing = readSessionId();
  if (existing) {
    const probe = await api('GET', `/api/session/${existing}`);
    if (probe.ok) return existing;
    if (probe.status !== 404) {
      // Transient API trouble must not silently throw the conversation away.
      log(`session probe for ${existing} returned HTTP ${probe.status}; keeping the stored session`);
      return existing;
    }
    log(`stored session ${existing} is gone; creating a new one`);
    try { unlinkSync(SESSION_FILE); } catch { /* ignore */ }
  }
  const created = await api('POST', '/api/session', {
    title: 'DownOps workspace bridge',
    location: { directory: WORKSPACE_DIR },
    model: MODEL,
    permissions: SESSION_RULES,
  });
  if (!created.ok) {
    throw Object.assign(new Error(`session create failed: HTTP ${created.status} ${JSON.stringify(created.payload).slice(0, 300)}`), { status: 502 });
  }
  const id = created.payload.data.id;
  writeSessionId(id);
  log(`created full-access session ${id} in ${WORKSPACE_DIR}`);
  await primeSession(id);
  return id;
}

/* ---------------------------------------------------------- the ask pipeline */

let inflight = null;
let queueDepth = 0;
const hits = new Map();

/** Sliding window per Keycloak subject, plus a global ceiling. */
function rateLimited(subject) {
  const now = Date.now();
  const window = (list) => list.filter((at) => now - at < 60000);
  const mine = window(hits.get(subject) ?? []);
  const all = window(hits.get('*global*') ?? []);
  if (mine.length >= LIMITS.perMinute || all.length >= LIMITS.perMinute * 3) {
    hits.set(subject, mine);
    hits.set('*global*', all);
    return true;
  }
  mine.push(now);
  all.push(now);
  hits.set(subject, mine);
  hits.set('*global*', all);
  if (hits.size > 500) {
    for (const [key, list] of hits) if (key !== '*global*' && window(list).length === 0) hits.delete(key);
  }
  return false;
}

function serialized(task) {
  const run = (inflight || Promise.resolve()).then(task, task);
  inflight = run.catch(() => {});
  return run;
}

async function askBackend(question, { reset = false, source = 'http', subject = 'anonymous' } = {}) {
  if (rateLimited(subject)) {
    audit({ source, subject, event: 'rate_limited' });
    throw Object.assign(new Error(`rate limit: ${LIMITS.perMinute} questions per minute`), { status: 429 });
  }
  if (typeof question !== 'string' || !question.trim()) {
    throw Object.assign(new Error('question is required'), { status: 400 });
  }
  if (Buffer.byteLength(question) > LIMITS.questionBytes) {
    throw Object.assign(new Error(`question exceeds ${LIMITS.questionBytes} bytes`), { status: 413 });
  }
  if (queueDepth >= LIMITS.maxQueue) {
    throw Object.assign(new Error('bridge is busy; retry shortly'), { status: 429 });
  }
  queueDepth += 1;
  const started = Date.now();
  try {
    return await serialized(async () => {
      const sessionId = await ensureSession(reset);
      const before = new Set((await listMessages(sessionId)).map((message) => message.id));
      const admitted = await api('POST', `/api/session/${sessionId}/prompt`, { text: question.trim() });
      if (!admitted.ok) {
        throw Object.assign(new Error(`prompt rejected: HTTP ${admitted.status}`), { status: 502 });
      }
      const outcome = await waitForRun(sessionId, before, LIMITS.askTimeoutMs);
      if (outcome.timedOut) {
        audit({ source, subject, event: 'timeout', session: sessionId, question: question.slice(0, 2000) });
        throw Object.assign(new Error('answer timed out'), { status: 504 });
      }
      const answer = answerFrom(outcome.messages, before);
      const elapsed = Date.now() - started;
      audit({
        source, subject, event: 'ask', session: sessionId, chars: question.length,
        answerChars: answer.length, elapsed, question: question.slice(0, 2000),
      });
      if (!answer) {
        const failure = failureFrom(outcome.messages, before);
        throw Object.assign(new Error(failure || 'the agent returned no text'), { status: 502 });
      }
      return { answer, session_id: sessionId, elapsed_ms: elapsed };
    });
  } finally {
    queueDepth -= 1;
  }
}

/* ----------------------------------------------------------- file tools */

function resolveInside(root, requested = '.') {
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('path escapes the bridge workspace'), { status: 400 });
  }
  try {
    const real = realpathSync(absolute);
    const realRoot = realpathSync(root);
    const realRelative = path.relative(realRoot, real);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw Object.assign(new Error('path escapes the bridge workspace'), { status: 400 });
    }
    return real;
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error('no such file or directory'), { status: 404 });
  }
}

function looksBinary(buffer) {
  return buffer.subarray(0, 4096).includes(0);
}

function readBackendFile(requested, maxBytes) {
  const absolute = resolveInside(FILES_ROOT, requested);
  if (!statSync(absolute).isFile()) throw Object.assign(new Error('not a file'), { status: 400 });
  const limit = Math.min(Number(maxBytes) > 0 ? Number(maxBytes) : LIMITS.fileBytes, LIMITS.fileBytes);
  const descriptor = openSync(absolute, 'r');
  try {
    const size = statSync(absolute).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    readSync(descriptor, buffer, 0, buffer.length, 0);
    if (looksBinary(buffer)) throw Object.assign(new Error('binary file'), { status: 415 });
    const text = buffer.toString('utf8');
    if (!size) return `[empty file: ${path.relative(FILES_ROOT, absolute)}]`;
    return size > limit ? `${text}\n\n[truncated at ${limit} of ${size} bytes]` : text;
  } finally {
    closeSync(descriptor);
  }
}

function* walk(directory, depth = 0) {
  if (depth > 12) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.next', 'proc', 'sys', 'dev', '.cache', '.bun'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(absolute, depth + 1);
    else if (entry.isFile()) yield absolute;
  }
}

function globToRegExp(glob) {
  return new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function grepBackend({ pattern, path: subpath = '/srv', include, literal = false, case_sensitive = true, max_results } = {}) {
  if (typeof pattern !== 'string' || !pattern) throw Object.assign(new Error('pattern is required'), { status: 400 });
  const base = resolveInside(FILES_ROOT, subpath);
  const limit = Math.min(Number(max_results) > 0 ? Number(max_results) : LIMITS.grepResults, LIMITS.grepResults);
  const regex = literal ? null : new RegExp(pattern, case_sensitive ? '' : 'i');
  const needle = literal && case_sensitive ? pattern : pattern.toLowerCase();
  const includeMatcher = include ? globToRegExp(include) : null;
  const files = statSync(base).isDirectory() ? Array.from(walk(base)) : [base];
  const results = [];
  let scanned = 0;
  for (const file of files) {
    const relative = path.relative(FILES_ROOT, file);
    if (includeMatcher && !includeMatcher.test(path.basename(file))) continue;
    if (statSync(file).size > LIMITS.grepFileBytes) continue;
    scanned += 1;
    const buffer = readFileSync(file);
    if (looksBinary(buffer)) continue;
    const lines = buffer.toString('utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matched = regex ? regex.test(line) : (case_sensitive ? line.includes(needle) : line.toLowerCase().includes(needle));
      if (matched) {
        results.push(`${relative}:${index + 1}: ${line.trim().slice(0, 240)}`);
        if (results.length >= limit) return { results, truncated: true, files_scanned: scanned };
      }
    }
  }
  return { results, truncated: false, files_scanned: scanned };
}

function listBackend(requested = '/srv') {
  const absolute = resolveInside(FILES_ROOT, requested);
  if (!statSync(absolute).isDirectory()) {
    return { path: path.relative(FILES_ROOT, absolute), entries: [] };
  }
  const entries = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => !['.git', 'node_modules', '.next', '.cache', '.bun'].includes(entry.name))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      size: entry.isFile() ? statSync(path.join(absolute, entry.name)).size : undefined,
    }))
    .sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'dir' ? -1 : 1));
  return { path: path.relative(FILES_ROOT, absolute) || '.', entries };
}

/* ------------------------------------------------------------------- the MCP */

const TOOLS = [
  {
    name: 'ask_downops',
    description:
      'Ask the DownOps agent to do or answer anything on the DownOps estate. It runs with full permissions on the OpenCode host: shell, read/write/edit, ssh to dev/proxmox/malza, kubectl on the k3s cluster, Docker, GitLab/GitHub pushes, Vault reads. Use it to inspect, change, deploy, debug and verify — it acts, then reports what it did. Answers cite real paths, hosts and command output.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'A specific question about the backend contract.' },
        reset: { type: 'boolean', description: 'Start a fresh conversation (drops earlier context).' },
      },
      required: ['question'],
    },
  },
  {
    name: 'read_downops_file',
    description: 'Read any file on the OpenCode host (absolute path or host-relative, e.g. /srv/opencode/AGENTS.md, /srv/downops/repos/mail-gateway/app/main.py, /etc/rancher/k3s/registries.yaml). Defaults that omit a leading slash resolve from /.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, e.g. /srv/downops/repos/dummy-api/app/main.py or /etc/hosts' },
        max_bytes: { type: 'number', description: `Maximum bytes to return (default and cap ${LIMITS.fileBytes}).` },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep_downops',
    description: 'Search files on the OpenCode host (default root: /srv = context repo + all repo mirrors; pass any absolute path to search elsewhere). Returns "path:line: text" matches.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (or literal text when literal=true).' },
        path: { type: 'string', description: 'Directory or file to search, absolute or /-relative (default: /srv).' },
        include: { type: 'string', description: 'Filename glob filter, e.g. *.ts' },
        literal: { type: 'boolean', description: 'Treat pattern as literal text.' },
        case_sensitive: { type: 'boolean', description: 'Default true.' },
        max_results: { type: 'number', description: `Default and cap ${LIMITS.grepResults}.` },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_downops',
    description: 'List a directory on the OpenCode host (default: /srv).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default: /srv).' } },
    },
  },
];

function mcpText(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], isError };
}

async function mcpCall(name, args = {}, context = {}) {
  switch (name) {
    case 'ask_downops': {
      const result = await askBackend(args.question, {
        reset: args.reset === true,
        source: context.scheme === 'oidc' ? 'mcp-oidc' : 'mcp',
        subject: context.subject || 'anonymous',
      });
      return mcpText(result.answer);
    }
    case 'read_downops_file':
      return mcpText(readBackendFile(args.path, args.max_bytes));
    case 'grep_downops': {
      const result = grepBackend(args);
      return mcpText(result.results.length ? result.results.join('\n') : 'No matches.');
    }
    case 'list_downops':
      return mcpText(JSON.stringify(listBackend(args.path), null, 1));
    default:
      return mcpText(`Unknown tool: ${name}`, true);
  }
}

async function handleMcp(message, context = {}) {
  const { id, method, params } = message || {};
  if (method === undefined) return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  if (id === undefined) return null; // notification

  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'downops', version: '3.0.0', title: 'DownOps estate (full access)' },
        instructions: 'Full management access to the DownOps estate. ask_downops runs a DownOps agent with shell, file write, ssh to dev/proxmox/malza, kubectl and Vault access (it can change things, not just read). read_downops_file/grep_downops/list_downops read any file on the OpenCode host; defaults cover /srv (context repo + repo mirrors).',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      try {
        return ok(await mcpCall(params?.name, params?.arguments || {}, context));
      } catch (error) {
        return ok(mcpText(error.message, true));
      }
    }
    case 'resources/list':
      return ok({ resources: [] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

/* ------------------------------------------------------------------- HTTP layer */

const server = createServer(async (request, response) => {
  const started = Date.now();
  const url = new URL(request.url || '/', 'http://bridge.local');
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, {
        ok: true,
        service: 'opencode-bridge',
        workspace_dir: WORKSPACE_DIR,
        repos: (() => {
          try {
            return readdirSync(path.join(WORKSPACE_DIR, 'downops', 'repos'), { withFileTypes: true })
              .filter((entry) => entry.isDirectory()).length;
          } catch { return 0; }
        })(),
        synced_at: (() => {
          try {
            return readFileSync(path.join(WORKSPACE_DIR, 'downops', 'repos', '.synced-at'), 'utf8').trim();
          } catch { return null; }
        })(),
        auth: { mode: 'oidc', resource: RESOURCE_URL, client_id: OAUTH_CLIENT_ID, required_group: REQUIRED_GROUP },
        session: readSessionId(),
        queued: queueDepth,
        uptime_s: Math.round(process.uptime()),
      });
    }

    if (request.method === 'GET' && (url.pathname === WELL_KNOWN || url.pathname === `${WELL_KNOWN}/mcp`)) {
      return json(response, 200, {
        resource: RESOURCE_URL,
        resource_name: 'DownOps workspace bridge',
        authorization_servers: [ISSUER],
        scopes_supported: ['openid', 'profile', 'email'],
        bearer_methods_supported: ['header'],
      });
    }

    const identity = await authenticate(request);
    if (!identity.ok) {
      audit({
        event: identity.rejected ? 'rejected_token' : 'unauthorized',
        ip: request.socket.remoteAddress,
        path: url.pathname,
      });
      return unauthorized(response);
    }

    if (request.method === 'POST' && url.pathname === '/ask') {
      const body = JSON.parse((await readBody(request, LIMITS.questionBytes * 2)) || '{}');
      const result = await askBackend(body.question, {
        reset: body.reset === true,
        source: identity.scheme === 'oidc' ? 'http-oidc' : 'http',
        subject: identity.subject,
      });
      return json(response, 200, result);
    }

    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        return response.end();
      }
      const raw = await readBody(request, LIMITS.questionBytes * 4);
      let message;
      try { message = JSON.parse(raw); } catch {
        return json(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (Array.isArray(message)) {
        const replies = (await Promise.all(message.map((item) => handleMcp(item, identity)))).filter(Boolean);
        if (!replies.length) { response.writeHead(202); return response.end(); }
        return json(response, 200, replies);
      }
      const reply = await handleMcp(message, identity);
      if (!reply) { response.writeHead(202); return response.end(); }
      return json(response, 200, reply);
    }

    return json(response, 404, { error: 'not found' });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) log('request failed:', error.stack || error.message);
    if (!response.headersSent) json(response, status, { error: error.message || 'internal error' });
  } finally {
    log(`${request.method} ${url.pathname} ${response.statusCode || 0} ${Date.now() - started}ms`);
  }
});

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
if (!existsSync(AUDIT_FILE)) writeFileSync(AUDIT_FILE, '');
if (!existsSync(WORKSPACE_DIR)) {
  console.error(`bridge: workspace ${WORKSPACE_DIR} does not exist; refusing to start`);
  process.exit(1);
}

server.listen(PORT, BIND, () => {
  log(`bridge listening on ${BIND}:${PORT} -> ${API} (mirror ${WORKSPACE_DIR})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
