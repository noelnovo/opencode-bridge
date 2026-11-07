import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskBridge, BOOTSTRAP } from '../tasks.mjs';
import { makeServer, TOOLS } from '../bridge.mjs';

function fixture(stateDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'))) {
  let counter = 0;
  const sessions = new Map();
  const calls = [];
  const audit = [];
  let uncertain = false;
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    const parts = route.split('?')[0].split('/');
    if (route === '/api/session/active') return { ok: true, status: 200, payload: { data: Object.fromEntries([...sessions].filter(([, session]) => session.active).map(([id]) => [id, {}])) } };
    if (route === '/api/session' && method === 'POST') {
      const session = { id: `ses_${++counter}`, time: { created: Date.now(), idle: 0 }, outcome: undefined, forms: [], permissions: [], messages: [], active: false };
      sessions.set(session.id, session);
      return { ok: true, status: 200, payload: { data: session } };
    }
    const session = sessions.get(parts[3]);
    if (!session) return { ok: false, status: 404, payload: null };
    if (parts.length === 4) return { ok: true, status: 200, payload: { data: session } };
    const kind = parts[4];
    if (kind === 'prompt') {
      const created = Date.now();
      session.messages.push({ id: body.id, type: 'user', time: { created } });
      session.active = true;
      if (uncertain) { uncertain = false; throw new Error('synthetic response lost'); }
      return { ok: true, status: 200, payload: { data: { id: body.id, time: { created } } } };
    }
    if (kind === 'message' && parts[5]) {
      const message = session.messages.find((item) => item.id === parts[5]);
      return { ok: !!message, status: message ? 200 : 404, payload: { data: message } };
    }
    if (kind === 'message') return { ok: true, status: 200, payload: { data: [...session.messages].reverse(), cursor: {} } };
    if (kind === 'inbox') return { ok: true, status: 200, payload: { data: [] } };
    if (kind === 'interrupt') { session.active = false; session.forms = []; return { ok: true, status: 200, payload: { interrupted: true } }; }
    if (kind === 'form') {
      if (parts.length === 5) return { ok: true, status: 200, payload: { data: session.forms } };
      if (!session.forms.some((form) => form.id === parts[5])) return { ok: false, status: 404, payload: null };
      session.forms = session.forms.filter((form) => form.id !== parts[5]);
      return { ok: true, status: 204, payload: null };
    }
    if (kind === 'permission') {
      if (parts.length === 5) return { ok: true, status: 200, payload: { data: session.permissions } };
      session.permissions = [];
      return { ok: true, status: 204, payload: null };
    }
    throw new Error(`Unexpected test route ${route}`);
  };
  const bridge = new TaskBridge({ stateDir, api, model: { providerID: 'test', id: 'test' }, audit: (event) => audit.push(event) });
  const owner = { owner: 'issuer|alice', clientSession: 'local_1' };
  const args = { objective: 'Inspect development readiness', project: 'wallettracker', workflow: 'android-dev', idempotency_key: 'request-1' };
  const submit = (changes = {}, context = owner) => bridge.call('submit_downops_task', { ...args, ...changes }, context);
  const get = (task) => bridge.call('get_downops_task', { task_id: task.task_id }, owner);
  const form = (task) => ({ id: 'frm_1', sessionID: task.session_id, title: 'Questions', metadata: { kind: 'question' }, fields: [
    { key: 'q0', type: 'string', title: 'Environment', description: 'Which environment?', options: [{ value: 'dev', label: 'dev' }, { value: 'prod', label: 'prod' }], custom: true },
    { key: 'q1', type: 'multiselect', description: 'Which checks?', options: [{ value: 'health', label: 'Health' }], custom: true },
  ] });
  const finish = (task, outcome = 'succeeded', report = 'Verified dev readiness.') => {
    const session = sessions.get(task.session_id);
    session.forms = [];
    session.permissions = [];
    session.active = false;
    session.outcome = outcome;
    session.time.idle = Date.now() + 5;
    session.messages.push({ id: 'msg_report', type: 'assistant', content: [
      { type: 'tool', name: 'read', state: { status: 'completed', input: { path: '/srv/opencode/AGENTS.md' }, content: [] } },
      { type: 'tool', name: 'skill', state: { status: 'completed', input: { id: 'gitops-argocd' }, content: [] } },
      { type: 'text', text: report }, { type: 'reasoning', text: 'Not forwarded' },
    ] });
  };
  return { bridge, owner, args, calls, audit, sessions, submit, get, form, finish, stateDir, loseResponse: () => { uncertain = true; } };
}

test('submission is durable, deduplicated and returns before model execution', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  const first = await f.submit();
  assert.equal(first.status, 'queued');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.submit()).task_id, first.task_id);
  await assert.rejects(f.submit({ objective: 'Different mutation' }), /Idempotency/);
  assert.equal(statSync(path.join(f.stateDir, 'tasks.sqlite')).mode & 0o777, 0o600);
  assert.equal(statSync(f.stateDir).mode & 0o777, 0o700);
});

test('dispatch uses build, canonical workspace, current instructions and original model', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  const task = await f.submit(); await f.bridge.tick();
  const created = f.calls.find((call) => call.route === '/api/session');
  assert.equal(created.body.location.directory, '/srv/opencode');
  assert.equal(created.body.agent, 'build');
  assert.deepEqual(created.body.model, { providerID: 'test', id: 'test' });
  assert.match(f.calls.find((call) => call.route.endsWith('/prompt')).body.text, /read \/srv\/opencode\/AGENTS.md/);
  assert.match(BOOTSTRAP, /question tool for ALL/);
  assert.doesNotMatch(BOOTSTRAP, /dummy-api|deepseek/);
  assert.equal((await f.get(task)).status, 'running');
});

test('status calls are persisted reads and do not invoke the API or model', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  const task = await f.submit();
  const before = f.calls.length;
  await f.get(task); await f.get(task);
  assert.equal(f.calls.length, before);
});

test('pending multi-question form is forwarded and answered in the same run', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  let task = await f.submit(); await f.bridge.tick(); task = await f.get(task);
  f.sessions.get(task.session_id).forms = [f.form(task)];
  await f.bridge.tick(); task = await f.get(task);
  assert.equal(task.status, 'awaiting_input');
  assert.equal(task.pending_input.fields[1].type, 'multiselect');
  const result = await f.bridge.call('answer_downops_question', { task_id: task.task_id, question_id: 'frm_1', answer: { q0: 'dev', q1: ['health', 'custom check'] } }, f.owner);
  assert.equal(result.status, 'running');
  assert.deepEqual(f.calls.find((call) => call.route.endsWith('/frm_1/reply')).body, { answer: { q0: 'dev', q1: ['health', 'custom check'] } });
  assert.equal(f.calls.filter((call) => call.route.endsWith('/prompt')).length, 1);
  f.finish(task); await f.bridge.tick();
  const done = await f.get(task);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.context_evidence, { canonical_instructions_read: true, skills_loaded: ['gitops-argocd'] });
  assert.equal(done.output.text, 'Verified dev readiness.');
});

test('stale, unknown-field, foreign-owner answers and unfinished followups fail closed', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  let task = await f.submit(); await f.bridge.tick(); task = await f.get(task);
  f.sessions.get(task.session_id).forms = [f.form(task)]; await f.bridge.tick();
  const args = { task_id: task.task_id, question_id: 'frm_1', answer: { q0: 'dev' } };
  await assert.rejects(f.bridge.call('answer_downops_question', { ...args, question_id: 'frm_other' }, f.owner), /stale/);
  await assert.rejects(f.bridge.call('answer_downops_question', { ...args, answer: { unknown: 'value' } }, f.owner), /Unknown/);
  await assert.rejects(f.bridge.call('answer_downops_question', args, { owner: 'issuer|bob' }), /not found/);
  await assert.rejects(f.bridge.call('continue_downops_task', { task_id: task.task_id, objective: 'answer', idempotency_key: 'followup' }, f.owner), /unfinished/);
});

test('questions can be dismissed; credential/external forms are not exposed', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  let task = await f.submit(); await f.bridge.tick(); task = await f.get(task);
  f.sessions.get(task.session_id).forms = [f.form(task)]; await f.bridge.tick();
  await f.bridge.call('answer_downops_question', { task_id: task.task_id, question_id: 'frm_1', reject: true }, f.owner);
  assert.ok(f.calls.some((call) => call.method === 'DELETE' && call.route.endsWith('/form/frm_1')));
  f.sessions.get(task.session_id).forms = [{ id: 'frm_secret', sessionID: task.session_id, metadata: { kind: 'auth' }, fields: [{ default: 'synthetic-private-value' }] }];
  await f.bridge.tick();
  const status = await f.get(task);
  assert.equal(status.pending_input.kind, 'unsupported_form');
  assert.doesNotMatch(JSON.stringify(status), /synthetic-private-value/);
});

test('permission forwarding allows once/reject but never permanent grant', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  let task = await f.submit(); await f.bridge.tick(); task = await f.get(task);
  f.sessions.get(task.session_id).permissions = [{ id: 'per_1', sessionID: task.session_id, action: 'shell', resources: ['dev'] }];
  await f.bridge.tick();
  assert.equal((await f.get(task)).pending_input.kind, 'permission');
  await assert.rejects(f.bridge.call('answer_downops_question', { task_id: task.task_id, question_id: 'per_1', decision: 'always' }, f.owner), /once or reject/);
  await f.bridge.call('answer_downops_question', { task_id: task.task_id, question_id: 'per_1', decision: 'once' }, f.owner);
});

test('different client sessions, users and workflows have distinct server sessions', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  const one = await f.submit(); await f.bridge.tick(); const running = await f.get(one);
  const two = await f.submit({}, { ...f.owner, clientSession: 'local_2' });
  assert.notEqual(one.task_id, two.task_id);
  f.finish(running); await f.bridge.tick(); await f.bridge.tick();
  const other = await f.bridge.call('get_downops_task', { task_id: two.task_id }, f.owner);
  assert.notEqual(running.session_id, other.session_id);
  await assert.rejects(f.bridge.call('get_downops_task', { task_id: one.task_id }, { owner: 'issuer|bob' }), /not found/);
  assert.deepEqual((await f.bridge.call('list_downops_tasks', {}, { owner: 'issuer|bob' })).tasks, []);
});

test('followups reuse conversation without including prior task output', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  let task = await f.submit(); await f.bridge.tick(); task = await f.get(task);
  f.finish(task, 'succeeded', 'Prior result'); await f.bridge.tick();
  const next = await f.bridge.call('continue_downops_task', { task_id: task.task_id, objective: 'Follow up', idempotency_key: 'followup' }, f.owner);
  await f.bridge.tick(); const running = await f.get(next);
  assert.equal(running.session_id, task.session_id);
  f.finish(running, 'succeeded', 'New result'); await f.bridge.tick();
  assert.equal((await f.get(next)).output.text, 'New result');
  assert.equal(f.calls.filter((call) => call.route === '/api/session' && call.method === 'POST').length, 1);
});

test('lost admission response is reconciled without resubmitting work', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  f.loseResponse(); const task = await f.submit(); await f.bridge.tick();
  assert.equal((await f.get(task)).status, 'needs_review');
  await f.bridge.tick(); assert.equal((await f.get(task)).status, 'running');
  assert.equal(f.calls.filter((call) => call.route.endsWith('/prompt')).length, 1);
});

test('journal survives bridge restart and resumes monitoring pending questions', async () => {
  const f = fixture();
  let task = await f.submit(); await f.bridge.tick(); task = await f.get(task);
  f.sessions.get(task.session_id).forms = [f.form(task)]; await f.bridge.tick();
  await f.bridge.close();
  const resumed = new TaskBridge({ stateDir: f.stateDir, api: async (method, route) => {
    if (route.endsWith('/form')) return { ok: true, payload: { data: [f.form(task)] } };
    return { ok: true, payload: { data: f.sessions.get(task.session_id) } };
  } });
  await resumed.tick();
  assert.equal((await resumed.call('get_downops_task', { task_id: task.task_id }, f.owner)).status, 'awaiting_input');
  await resumed.close();
});

test('global serialization holds while a task is waiting for user input', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  let one = await f.submit(); await f.bridge.tick(); one = await f.get(one);
  f.sessions.get(one.session_id).forms = [f.form(one)]; await f.bridge.tick();
  const two = await f.submit({ workflow: 'another', idempotency_key: 'other' });
  await f.bridge.tick(); assert.equal((await f.get(two)).status, 'queued');
  assert.equal(f.calls.filter((call) => call.route.endsWith('/prompt')).length, 1);
});

test('cancellation distinguishes queued work from potentially surviving remote processes', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  const queued = await f.submit();
  const cancelled = await f.bridge.call('cancel_downops_task', { task_id: queued.task_id }, f.owner);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(f.calls.length, 0);
  let running = await f.submit({ idempotency_key: 'next' }); await f.bridge.tick(); running = await f.get(running);
  const stopped = await f.bridge.call('cancel_downops_task', { task_id: running.task_id }, f.owner);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.cancellation.server_execution_stopped, true);
  assert.equal(stopped.cancellation.remote_descendants_verified, false);
  assert.ok(!f.calls.some((call) => call.method === 'DELETE' && call.route === `/api/session/${running.session_id}`));
});

test('output windows preserve UTF-8 and enforce size bounds', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  let task = await f.submit(); await f.bridge.tick(); task = await f.get(task);
  f.finish(task, 'succeeded', 'abé漢字done'); await f.bridge.tick();
  const window = await f.bridge.call('get_downops_task', { task_id: task.task_id, max_bytes: 4 }, f.owner);
  assert.equal(window.output.text, 'abé');
  assert.equal(window.output.next_offset, 4);
  await assert.rejects(f.bridge.call('get_downops_task', { task_id: task.task_id, max_bytes: 200000 }, f.owner), /Invalid/);
});

test('audit contains metadata, never objective, answer or token payload', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.submit({ objective: 'synthetic confidential prompt' });
  assert.doesNotMatch(JSON.stringify(f.audit), /synthetic confidential prompt|issuer\|alice/);
});

test('HTTP preserves OAuth challenge and removes legacy tools/endpoints', async (t) => {
  const f = fixture();
  const server = makeServer({ tasks: f.bridge, resource: 'https://ask.test', auth: { metadata: { resource: 'https://ask.test' }, authenticate: async (request) => request.headers.authorization === 'Bearer synthetic' ? f.owner : null } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await f.bridge.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const unauth = await fetch(`${base}/mcp`); assert.equal(unauth.status, 401); assert.match(unauth.headers.get('www-authenticate'), /resource_metadata/);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource`)).status, 200);
  assert.equal((await fetch(`${base}/ask`, { method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: '{}' })).status, 404);
  const call = async (method, params) => (await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const catalog = await call('tools/list');
  assert.equal(catalog.result.tools.length, 6);
  for (const legacy of ['ask_downops', 'read_downops_file', 'grep_downops', 'list_downops']) assert.ok(!TOOLS.some((tool) => tool.name === legacy));
  assert.equal((await call('tools/call', { name: 'ask_downops', arguments: { question: 'old' } })).result.isError, true);
  const submitted = await call('tools/call', { name: 'submit_downops_task', arguments: f.args, _meta: { 'ai.opencode/sessionID': 'local_2' } });
  assert.equal(submitted.result.structuredContent.status, 'queued');
  assert.match((await call('initialize', { protocolVersion: '2025-11-25' })).result.instructions, /Never answer approvals/);
});

test('status/submission remain responsive while upstream monitoring is blocked', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  const task = await f.submit();
  let unblock;
  const blocked = f.bridge.exclusive(() => new Promise((resolve) => { unblock = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.get(task)).status, 'queued');
  assert.equal((await f.submit({ workflow: 'other' })).status, 'queued');
  unblock(); await blocked;
});

test('legacy session execution blocks new tasks without adopting/deleting history', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  writeFileSync(path.join(stateDir, 'session.json'), JSON.stringify({ id: 'ses_legacy' }));
  let prompts = 0;
  const bridge = new TaskBridge({ stateDir, api: async (method, route) => {
    if (route === '/api/session/active') return { ok: true, payload: { data: { ses_legacy: {} } } };
    prompts++; throw new Error('Must not dispatch');
  } });
  const task = await bridge.call('submit_downops_task', { objective: 'Inspect', project: 'test', workflow: 'test', idempotency_key: 'one' }, { owner: 'alice' });
  await bridge.tick();
  assert.equal(prompts, 0);
  assert.equal((await bridge.call('get_downops_task', { task_id: task.task_id }, { owner: 'alice' })).status, 'queued');
  await bridge.close();
});

test('unconfirmed dispatch holds queue and never retries the prompt', async (t) => {
  const f = fixture(); t.after(() => f.bridge.close());
  const original = f.bridge.api;
  let attempts = 0;
  f.bridge.api = async (method, route, body) => {
    if (route.endsWith('/prompt')) { attempts++; throw new Error('Synthetic transport failure before admission'); }
    return original(method, route, body);
  };
  const task = await f.submit(); await f.bridge.tick(); await f.bridge.tick();
  assert.equal((await f.get(task)).status, 'needs_review');
  const queued = await f.submit({ workflow: 'other' }); await f.bridge.tick();
  assert.equal((await f.get(queued)).status, 'queued');
  assert.equal(attempts, 1);
});
