#!/usr/bin/env node
/** DownOps OAuth task-delegation bridge. No remote-shell or direct-file API. */
import { createServer } from 'node:http';
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeAuth, makeAPI } from './auth.mjs';
import { TaskBridge, fail } from './tasks.mjs';

const TASK_ID = { type: 'string', description: 'Task ID returned by submit/list. Never a raw OpenCode session ID.' };
const KEY = { type: 'string', description: 'Unique stable key for this submission. Reuse only when retrying the identical request.' };
const OBJECTIVE = { type: 'string', description: 'Specific server-side task, including relevant evidence; do not send credentials or the entire local conversation.' };
const BOUNDARIES = { type: 'string', description: 'Allowed actions and exclusions, especially commit/push/deploy/restart scope. Does not override standing approval rules.' };
const CHECKS = { type: 'string', description: 'Acceptance checks and expected result.' };
function tool(name, description, properties, required) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
export const TOOLS = [
  tool('submit_downops_task', 'Delegate infrastructure work to the server agent, which uses its own AGENTS.md and relevant skills. Returns a durable task ID immediately. Store it and retrieve status; never blindly resubmit mutations.', {
    objective: OBJECTIVE, project: { type: 'string', description: 'Project/service identifier, e.g. wallettracker.' },
    workflow: { type: 'string', description: 'Conversation scope, e.g. android-dev. Use a different workflow for unrelated work.' },
    idempotency_key: KEY, constraints: BOUNDARIES, acceptance_checks: CHECKS,
  }, ['objective', 'project', 'workflow', 'idempotency_key']),
  tool('get_downops_task', 'Read persisted task status without invoking a model. If awaiting_input, present pending_input to the user and answer that exact request. Output is byte-paginated; normal status calls are short.', {
    task_id: TASK_ID, offset: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 1, maximum: 16000 },
  }, ['task_id']),
  tool('answer_downops_question', 'Deliver the USER\'S answer to an existing pending server question, or reply once/reject to a permission request. Never invent user approval. Use field keys/values from pending_input, e.g. answer={q0:"dev"}; multiselect values are arrays. Does not start a new prompt.', {
    task_id: TASK_ID, question_id: { type: 'string' },
    answer: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }] } },
    reject: { type: 'boolean', description: 'Dismiss a question instead of answering it.' },
    decision: { type: 'string', enum: ['once', 'reject'], description: 'Only for pending_input.kind=permission; permanent grants are not supported.' },
  }, ['task_id', 'question_id']),
  tool('continue_downops_task', 'Submit a follow-up after a task finishes, reusing its server conversation. For an unfinished task use answer_downops_question or inspect status. A new idempotency key is required.', {
    task_id: TASK_ID, objective: OBJECTIVE, idempotency_key: KEY, constraints: BOUNDARIES, acceptance_checks: CHECKS,
  }, ['task_id', 'objective', 'idempotency_key']),
  tool('cancel_downops_task', 'Request interruption of the server execution and cancellation of its queued input. A cancelled status does not prove remote SSH/background descendants stopped; inspect cancellation metadata and verify before conflicting work.', { task_id: TASK_ID }, ['task_id']),
  tool('list_downops_tasks', 'Recover recent task IDs and statuses belonging to the authenticated user. Does not invoke the model or expose other users\' tasks.', { limit: { type: 'integer', minimum: 1, maximum: 20 } }, []),
];

export const CLIENT_INSTRUCTIONS = [
  'Use DownOps for server-side infrastructure tasks; keep Android SDK, USB/ADB and local code operations local.',
  'The server agent loads its own instructions/skills; do not copy them into your context.',
  'Submit precise objectives with project/workflow, a stable idempotency key, boundaries and acceptance checks. Keep task IDs for follow-up.',
  'Retrieve status with get_downops_task; it reads stored state without model generation. Pace status checks (about 5-10 seconds), not tight loops.',
  'When awaiting_input, show the complete pending question/options or permission request to the user, using your local question UI if available. Never answer approvals on the user\'s behalf.',
  'Send the actual user response through answer_downops_question using the task and question IDs; it resumes the existing pending server request. Dismissal uses reject=true (questions) or decision=reject (permissions).',
  'Do not use continue_downops_task to answer a pending question. Use it only for a completed task follow-up.',
  'Network errors do not prove task failure. Recover with list/get or retry the exact submission with its original idempotency key.',
  'needs_review means admission/monitoring is uncertain. Do not start replacement mutations. Report the blocker or cancel and inspect server-side execution.',
  'Cancellation only confirms OpenCode execution when reported; remote/background descendants may survive. Verify before conflicting operations.',
].join('\n');

function json(response, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...extra });
  response.end(body);
}
async function body(request, max = 32768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw fail('Request body too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('Invalid JSON', 400); }
}

export function makeServer({ auth, tasks, resource, audit = () => {}, perMinute = 10 }) {
  const hits = new Map();
  function limited(owner) {
    const now = Date.now();
    const previous = (hits.get(owner) || []).filter((at) => now - at < 60000);
    if (previous.length >= perMinute) return true;
    hits.set(owner, [...previous, now]);
    if (hits.size > 1000) for (const [key, values] of hits) if (now - values.at(-1) > 60000) hits.delete(key);
    return false;
  }
  async function handle(message, identity) {
    const response = (result) => ({ jsonrpc: '2.0', id: message.id, result });
    const error = (code, text) => ({ jsonrpc: '2.0', id: message?.id ?? null, error: { code, message: text } });
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request');
    if (message.id === undefined) return null;
    switch (message.method) {
      case 'initialize': {
        const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
        return response({ protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-11-25',
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'downops', version: '4.0.0', title: 'DownOps task delegation' }, instructions: CLIENT_INSTRUCTIONS });
      }
      case 'ping': return response({});
      case 'tools/list': return response({ tools: TOOLS });
      case 'resources/list': return response({ resources: [] });
      case 'resources/templates/list': return response({ resourceTemplates: [] });
      case 'prompts/list': return response({ prompts: [] });
      case 'tools/call': {
        try {
          const { name, arguments: args = {}, _meta } = message.params || {};
          const definition = TOOLS.find((item) => item.name === name);
          if (!definition) throw fail('Unknown tool', 404);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('Invalid tool arguments');
          if (Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key))) throw fail('Unknown tool argument');
          if (['submit_downops_task', 'continue_downops_task', 'answer_downops_question'].includes(name) && limited(identity.owner)) throw fail('Mutation rate limit exceeded', 429);
          const session = _meta?.['ai.opencode/sessionID'];
          if (session !== undefined && (typeof session !== 'string' || session.length > 200)) throw fail('Invalid caller session metadata');
          const result = await tasks.call(name, args, { ...identity, clientSession: session || '' });
          return response({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
        } catch (cause) {
          // Errors are our own bounded messages, never upstream bodies/stacks/prompts.
          return response({ content: [{ type: 'text', text: JSON.stringify({ error: cause.status ? cause.message : 'Bridge operation unavailable; inspect task status before retrying', status: cause.status || 503 }) }], isError: true });
        }
      }
      default: return error(-32601, 'Method not found');
    }
  }
  return createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://bridge.local');
    try {
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, service: 'opencode-bridge', version: '4.0.0', architecture: 'durable-agent-tasks' });
      if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) return json(response, 200, auth.metadata);
      const identity = await auth.authenticate(request);
      if (!identity) {
        audit({ event: 'unauthorized' });
        return json(response, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource"` });
      }
      if (url.pathname !== '/mcp') return json(response, 404, { error: 'not found' });
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        return response.end();
      }
      const message = await body(request);
      // JSON-RPC batches are intentionally unsupported (removed in modern MCP).
      if (Array.isArray(message)) return json(response, 400, { error: 'Batch requests are not supported' });
      const reply = await handle(message, identity);
      if (!reply) { response.writeHead(202); return response.end(); }
      return json(response, 200, reply);
    } catch (cause) {
      if (!response.headersSent) json(response, cause.status || 500, { error: cause.status ? cause.message : 'Bridge unavailable' });
    }
  });
}

export function start() {
  const issuer = process.env.OPENCODE_OIDC_ISSUER;
  const clientID = process.env.KEYCLOAK_AUTOMATION_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_AUTOMATION_CLIENT_SECRET;
  if (!issuer || !clientID || !clientSecret) throw new Error('OIDC configuration incomplete');
  const resource = process.env.BRIDGE_RESOURCE_URL || 'https://ask.int.downops.win';
  const logDir = process.env.BRIDGE_LOG_DIR || '/var/log/opencode-bridge';
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const auditFile = path.join(logDir, 'audit.log');
  if (existsSync(auditFile)) chmodSync(auditFile, 0o600);
  const audit = (entry) => {
    try {
      if (existsSync(auditFile) && statSync(auditFile).size > 8 * 1024 * 1024) renameSync(auditFile, `${auditFile}.1`);
      appendFileSync(auditFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch { console.error('Bridge audit write unavailable'); }
  };
  const workspace = path.resolve(process.env.BRIDGE_WORKSPACE_DIR || '/srv/opencode');
  if (!existsSync(workspace)) throw new Error('Bridge workspace unavailable');
  const auth = makeAuth({ issuer, clientID, clientSecret, resource, requiredGroup: process.env.BRIDGE_REQUIRED_GROUP || 'admin', oauthClientID: process.env.BRIDGE_OAUTH_CLIENT_ID || 'downops-mcp' });
  const tasks = new TaskBridge({ stateDir: process.env.BRIDGE_STATE_DIR || '/var/lib/opencode-bridge',
    api: makeAPI(process.env.BRIDGE_API_BASE || 'http://127.0.0.1:4096', auth), workspace,
    model: { providerID: process.env.BRIDGE_MODEL_PROVIDER || 'github-copilot', id: process.env.BRIDGE_MODEL_ID || 'gpt-6.1-sol' }, audit,
    maxQueue: Number(process.env.BRIDGE_MAX_QUEUE || 3) });
  const server = makeServer({ auth, tasks, resource, audit, perMinute: Number(process.env.BRIDGE_PER_MINUTE || 10) });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.BRIDGE_PORT || 4780), process.env.BRIDGE_BIND || '0.0.0.0', () => {
    console.log('DownOps task bridge v4 listening');
    tasks.start();
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    clearInterval(tasks.timer);
    // Do not interrupt the OpenCode server or delete task/session history.
    server.close(async () => { await tasks.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
  return { server, tasks };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { start(); } catch { console.error('Bridge startup failed; check configuration and protected state permissions'); process.exitCode = 1; }
}
