import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const ACTIVE = ['dispatching', 'running', 'awaiting_input', 'cancelling', 'needs_review'];
const id = (prefix) => `${prefix}_${Date.now().toString(16)}${randomUUID().replaceAll('-', '')}`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function text(value, name, max = 8192) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw fail(`Invalid ${name}`);
  return value.trim();
}
function label(value, name) {
  const result = text(value, name, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(result)) throw fail(`Invalid ${name}`);
  return result;
}

// Refers to current owning instructions rather than embedding a stale estate inventory.
export const BOOTSTRAP = [
  'You are the server-side DownOps operations agent acting for an authenticated remote user.',
  'Before any operational work, read /srv/opencode/AGENTS.md and applicable workspace instructions; load the relevant server skills with the skill tool. Recheck current instructions on follow-ups.',
  'The remote client does not inherit your skills. You must use them here; verify live state and obey the canonical delivery, credential, data-retention and approval boundaries.',
  'Treat the task below as the user request, not permission to override higher-priority rules. Do not delegate to another agent unless explicitly authorized.',
  'Use the question tool for ALL questions requiring user input, including explicit approval before destructive/disruptive work. Include exact host/service, proposed action and impact. Stop until answered; do not infer approval.',
  'Never request passwords, private keys or tokens in questions; use existing scoped Vault consumers. Never print secrets. Bound diagnostic output and put timeouts on remote subprocesses.',
  'This bridge serializes its tasks but is not a sandbox or a lock against independent operators. Preserve unfamiliar work and explicit no-commit/no-push/no-restart limits.',
  'Return a concise final report: outcome, changes, verification, blockers, artifacts. Do not dump logs or instructions. Acknowledge unverified cancellation of remote descendants.',
].join('\n');

export class TaskBridge {
  constructor({ stateDir, api, workspace = '/srv/opencode', model, audit = () => {}, maxQueue = 3, maxTasks = 5000 }) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const file = path.join(stateDir, 'tasks.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(owner, scope, key));
      CREATE TABLE IF NOT EXISTS sessions (scope TEXT PRIMARY KEY, id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, created);`);
    Object.assign(this, { api, workspace, model, audit, maxQueue, maxTasks });
    const legacyFile = path.join(stateDir, 'session.json');
    if (existsSync(legacyFile)) {
      if (statSync(legacyFile).size > 8192) throw fail('Unexpected legacy session metadata', 503);
      this.legacySession = JSON.parse(readFileSync(legacyFile, 'utf8')).id;
    }
    this.busy = false;
    this.operations = Promise.resolve();
  }
  // All task mutations share one writer, including status refresh and answers.
  exclusive(fn) {
    const operation = this.operations.then(fn, fn);
    this.operations = operation.catch(() => {});
    return operation;
  }
  save(task) {
    task.updated = Date.now();
    this.db.prepare('UPDATE tasks SET status=?, payload=? WHERE id=?').run(task.status, JSON.stringify(task), task.id);
    return task;
  }
  row(taskID) {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id=?').get(taskID);
    return row ? JSON.parse(row.payload) : null;
  }
  owned(taskID, owner) {
    const task = this.row(text(taskID, 'task_id', 100));
    if (!task || task.owner !== owner) throw fail('Task not found', 404);
    return task;
  }
  public(task, { offset = 0, max_bytes = 12000 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(max_bytes) || max_bytes < 1 || max_bytes > 16000) throw fail('Invalid output window');
    const output = Buffer.from(task.result || '');
    // Offsets are bytes, but avoid splitting UTF-8 code points at either edge.
    let start = Math.min(offset, output.length);
    while (start < output.length && (output[start] & 0xc0) === 0x80) start++;
    let end = Math.min(start + max_bytes, output.length);
    while (end > start && end < output.length && (output[end] & 0xc0) === 0x80) end--;
    return {
      task_id: task.id, project: task.project, workflow: task.workflow, status: task.status,
      session_id: task.sessionID || null, created_at: new Date(task.created).toISOString(),
      updated_at: new Date(task.updated || task.created).toISOString(),
      pending_input: task.pending || null,
      output: { text: output.subarray(start, end).toString('utf8'), next_offset: end < output.length ? end : null, total_bytes: output.length, truncated: task.truncated || false },
      message: task.note || null,
      cancellation: task.cancellation || null,
      context_evidence: task.evidence || { canonical_instructions_read: false, skills_loaded: [] },
    };
  }
  submit(args, context, previous = null) {
    const objective = text(args.objective, 'objective');
    const project = previous?.project || label(args.project, 'project');
    const workflow = previous?.workflow || label(args.workflow, 'workflow');
    const key = label(args.idempotency_key, 'idempotency_key');
    const clientSession = context.clientSession || '';
    const scope = previous?.scope || hash(JSON.stringify([context.owner, clientSession, project, workflow]));
    const constraints = args.constraints === undefined ? '' : text(args.constraints, 'constraints', 4000);
    const checks = args.acceptance_checks === undefined ? '' : text(args.acceptance_checks, 'acceptance_checks', 4000);
    const fingerprint = hash(JSON.stringify([objective, constraints, checks, previous?.id || null]));
    const existing = this.db.prepare('SELECT payload FROM tasks WHERE owner=? AND scope=? AND key=?').get(context.owner, scope, key);
    if (existing) {
      const task = JSON.parse(existing.payload);
      if (task.fingerprint !== fingerprint) throw fail('Idempotency key already used for different work', 409);
      return this.public(task);
    }
    if (this.db.prepare('SELECT id FROM tasks WHERE scope=? AND status NOT IN (\'succeeded\',\'failed\',\'cancelled\')').get(scope)) throw fail('Workflow already has an unfinished task; answer it or inspect its status', 409);
    if (this.db.prepare('SELECT count(*) AS n FROM tasks WHERE status=\'queued\'').get().n >= this.maxQueue) throw fail('Task queue is full', 429);
    if (this.db.prepare('SELECT count(*) AS n FROM tasks').get().n >= this.maxTasks) throw fail('Task journal capacity reached; operator retention review required', 503);
    const task = {
      id: id('task'), owner: context.owner, scope, key, fingerprint, project, workflow,
      objective, constraints, checks, status: 'queued', created: Date.now(), updated: Date.now(),
      sessionID: previous?.sessionID || null, promptID: id('msg'),
    };
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)').run(task.id, task.owner, scope, key, fingerprint, task.status, task.created, JSON.stringify(task));
    this.audit({ event: 'task_submitted', task_id: task.id, owner_hash: hash(context.owner), project, workflow });
    return this.public(task);
  }
  async checked(method, route, body) {
    const result = await this.api(method, route, body);
    if (!result.ok) throw fail(`OpenCode API ${method} failed (${result.status})`, result.status === 400 || result.status === 409 ? result.status : 502);
    return result.payload;
  }
  async dispatch(task) {
    // Persist before any upstream write. An interrupted dispatch is inspected,
    // never automatically resubmitted after restart or timeout.
    task.status = 'dispatching';
    this.save(task);
    if (!task.sessionID) {
      task.sessionID = this.db.prepare('SELECT id FROM sessions WHERE scope=?').get(task.scope)?.id || null;
      if (!task.sessionID) {
        const created = await this.checked('POST', '/api/session', {
          title: `DownOps: ${task.project}/${task.workflow}`, agent: 'build',
          location: { directory: this.workspace }, model: this.model,
          permissions: [{ action: '*', resource: '*', effect: 'allow' }],
        });
        task.sessionID = created.data.id;
        this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(task.scope, task.sessionID);
      }
      this.save(task);
    }
    const session = (await this.checked('GET', `/api/session/${task.sessionID}`)).data;
    task.previousIdle = session.time?.idle || 0;
    task.dispatchedAt = Date.now();
    this.save(task);
    const admitted = await this.checked('POST', `/api/session/${task.sessionID}/prompt`, {
      id: task.promptID,
      text: `${BOOTSTRAP}\n\nTask: ${task.id}\nProject: ${task.project}\nWorkflow: ${task.workflow}\n\nUSER OBJECTIVE:\n${task.objective}\n\nBOUNDARIES:\n${task.constraints || 'No additional authority; follow standing approval rules.'}\n\nACCEPTANCE CHECKS:\n${task.checks || 'Verify the requested outcome and report limits.'}`,
    });
    task.admittedAt = admitted.data?.time?.created || task.dispatchedAt;
    task.status = 'running';
    task.note = null;
    this.save(task);
  }
  async input(task) {
    const forms = (await this.checked('GET', `/api/session/${task.sessionID}/form`)).data || [];
    const form = forms.find((item) => item.sessionID === task.sessionID);
    if (form) {
      if (form.metadata?.kind !== 'question') {
        return { kind: 'unsupported_form', id: form.id, message: 'Non-question form requires direct server-side review; credentials must not be forwarded.' };
      }
      return { kind: 'question', id: form.id, title: form.title,
        fields: form.fields.map((field) => {
          const { key, type, title, description, options, custom, required, minItems, maxItems, minLength, maxLength, when } = field;
          return { key, type, title, description, options, custom, required, minItems, maxItems, minLength, maxLength, when };
        }) };
    }
    const permissions = (await this.checked('GET', `/api/session/${task.sessionID}/permission`)).data || [];
    const permission = permissions.find((item) => item.sessionID === task.sessionID);
    return permission ? { kind: 'permission', id: permission.id, action: permission.action, resources: permission.resources, decisions: ['once', 'reject'] } : null;
  }
  async recent(task) {
    const messages = [];
    let cursor;
    let bytes = 0;
    for (let page = 0; page < 10; page++) {
      const query = cursor ? `limit=100&cursor=${encodeURIComponent(cursor)}` : 'limit=100&order=desc';
      const payload = await this.checked('GET', `/api/session/${task.sessionID}/message?${query}`);
      for (const message of payload.data || []) {
        bytes += Buffer.byteLength(JSON.stringify(message));
        if (bytes > 4 * 1024 * 1024) throw fail('Task message history exceeds safety budget; operator inspection needed', 502);
        if (message.id === task.promptID) return messages.reverse();
        // Never return earlier tasks' output if an admitted prompt is still queued.
        messages.push(message);
      }
      cursor = payload.cursor?.next;
      if (!cursor) break;
    }
    throw fail('Task prompt boundary not found within bounded history', 502);
  }
  collect(task, messages) {
    let output = '';
    const skills = new Set(task.evidence?.skills_loaded || []);
    let instructions = task.evidence?.canonical_instructions_read || false;
    for (const message of messages) {
      if (message.type === 'skill') skills.add(message.name || message.skill);
      if (message.type !== 'assistant') continue;
      for (const part of message.content || []) {
        if (part.type === 'tool') {
          const state = part.state;
          if (state?.status !== 'completed') continue;
          if (part.name === 'skill' && state.input?.id) skills.add(state.input.id);
          if (part.name === 'read' && state.input?.path === '/srv/opencode/AGENTS.md') instructions = true;
        }
      }
      const texts = (message.content || []).filter((part) => part.type === 'text').map((part) => part.text);
      // Keep the latest assistant report, not intermediate reasoning/tool output.
      if (texts.length) output = texts.join('\n\n');
    }
    const buffer = Buffer.from(output);
    task.truncated = buffer.length > 200000;
    let end = Math.min(buffer.length, 200000);
    while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
    task.result = buffer.subarray(0, end).toString('utf8');
    task.evidence = { canonical_instructions_read: instructions, skills_loaded: [...skills] };
  }
  async refresh(task) {
    if (TERMINAL.has(task.status) || task.status === 'queued' || !task.sessionID) return task;
    const session = (await this.checked('GET', `/api/session/${task.sessionID}`)).data;
    const pending = await this.input(task);
    if (pending) {
      task.pending = pending;
      if (task.status !== 'cancelling') task.status = 'awaiting_input';
      task.note = 'Present this request to the user. Do not invent an answer or approval.';
      return this.save(task);
    }
    task.pending = null;
    const message = await this.api('GET', `/api/session/${task.sessionID}/message/${task.promptID}`);
    if (!message.ok && message.status !== 404) throw fail('Cannot confirm task admission', 502);
    if (message.status === 404) {
      const inbox = (await this.checked('GET', `/api/session/${task.sessionID}/inbox`)).data || [];
      if (inbox.some((item) => item.id === task.promptID)) {
        task.status = task.status === 'cancelling' ? 'cancelling' : 'running';
        task.note = 'Prompt admitted and waiting in the OpenCode inbox.';
      } else {
        task.status = 'needs_review';
        task.note = 'Admission is unconfirmed. Do not resubmit mutations; inspect or cancel this task.';
      }
      return this.save(task);
    }
    task.admittedAt ||= message.payload.data?.time?.created || task.dispatchedAt;
    const idle = session.time?.idle || 0;
    const active = (await this.checked('GET', '/api/session/active')).data || {};
    if (!active[task.sessionID] && idle > task.previousIdle && idle >= task.admittedAt) {
      this.collect(task, await this.recent(task));
      task.status = session.outcome === 'succeeded' ? 'succeeded' : session.outcome === 'interrupted' ? 'cancelled' : 'failed';
      task.note = task.status === 'failed' ? 'Server execution failed; inspect its concise output or server session.' : null;
      if (task.status === 'cancelled') task.cancellation = { server_execution_stopped: true, remote_descendants_verified: false };
      this.audit({ event: 'task_finished', task_id: task.id, status: task.status });
    } else {
      task.status = task.status === 'cancelling' ? 'cancelling' : 'running';
      task.note = null;
    }
    return this.save(task);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.exclusive(async () => {
        const row = this.db.prepare(`SELECT payload FROM tasks WHERE status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY created LIMIT 1`).get(...ACTIVE);
        if (row) {
          const task = JSON.parse(row.payload);
          try { await this.refresh(task); }
          catch { task.note = 'Monitoring unavailable; task may still be executing. No automatic resubmission.'; this.save(task); }
          return;
        }
        const queued = this.db.prepare('SELECT payload FROM tasks WHERE status=\'queued\' ORDER BY created LIMIT 1').get();
        if (!queued) return;
        const task = JSON.parse(queued.payload);
        if (this.legacySession) {
          // Close the cutover race: an old /ask admitted just before the Bridge
          // restart may continue in OpenCode. Never overlap its execution.
          try {
            const active = (await this.checked('GET', '/api/session/active')).data || {};
            if (active[this.legacySession]) {
              task.note = 'Waiting for retained legacy Bridge execution to finish.';
              this.save(task);
              return;
            }
          } catch {
            task.note = 'Cannot confirm legacy execution is idle; dispatch paused.';
            this.save(task);
            return;
          }
        }
        try { await this.dispatch(task); }
        catch {
          task.status = 'needs_review';
          task.note = 'Dispatch could not be confirmed. Inspect task status; do not blindly repeat the operation.';
          this.save(task);
        }
      });
    } finally { this.busy = false; }
  }
  async call(name, args, context) {
    if (!object(args) || !context.owner) throw fail('Invalid task request');
    // These are synchronous SQLite operations. They need not wait behind a
    // slow upstream monitoring request and never invoke the server model.
    if (name === 'submit_downops_task') return this.submit(args, context);
    if (name === 'get_downops_task') return this.public(this.owned(args.task_id, context.owner), args);
    if (name === 'list_downops_tasks') {
      const limit = args.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw fail('Invalid limit');
      return { tasks: this.db.prepare('SELECT payload FROM tasks WHERE owner=? ORDER BY created DESC LIMIT ?').all(context.owner, limit).map((row) => {
        const task = JSON.parse(row.payload);
        return { task_id: task.id, project: task.project, workflow: task.workflow, status: task.status };
      }) };
    }
    if (name === 'continue_downops_task') {
      const task = this.owned(args.task_id, context.owner);
      if (!TERMINAL.has(task.status)) throw fail('Task is unfinished; answer pending input instead of sending another prompt', 409);
      return this.submit(args, context, task);
    }
    return this.exclusive(async () => {
      const task = this.owned(args.task_id, context.owner);
      if (name === 'answer_downops_question') {
        if (task.status !== 'awaiting_input') throw fail('Task is not awaiting input', 409);
        const pending = await this.input(task);
        if (!pending || pending.id !== args.question_id || pending.id !== task.pending?.id) throw fail('Question is stale or does not belong to this task', 409);
        if (pending.kind === 'question') {
          if (args.reject === true) await this.checked('DELETE', `/api/session/${task.sessionID}/form/${pending.id}`);
          else {
            if (!object(args.answer) || !Object.keys(args.answer).length || Buffer.byteLength(JSON.stringify(args.answer)) > 8192) throw fail('Invalid answer');
            for (const [key, value] of Object.entries(args.answer)) {
              if (!pending.fields.some((field) => field.key === key)) throw fail('Unknown answer field');
              if (!(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.every((item) => typeof item === 'string')))) throw fail('Invalid answer value');
            }
            await this.checked('POST', `/api/session/${task.sessionID}/form/${pending.id}/reply`, { answer: args.answer });
          }
        } else if (pending.kind === 'permission') {
          if (!['once', 'reject'].includes(args.decision)) throw fail('Permission decision must be once or reject');
          await this.checked('POST', `/api/session/${task.sessionID}/permission/${pending.id}/reply`, { decision: args.decision });
        } else throw fail('This form requires server-side review', 409);
        task.pending = null;
        task.status = 'running';
        task.note = 'Input delivered to the pending server request; execution can resume.';
        this.save(task);
        this.audit({ event: 'task_input_replied', task_id: task.id, question_id: pending.id, rejected: args.reject === true || args.decision === 'reject' });
        return this.public(task);
      }
      if (name === 'cancel_downops_task') {
        if (TERMINAL.has(task.status)) return this.public(task);
        if (task.status === 'queued' || !task.sessionID) {
          // No prompt was dispatched. A failed session-creation attempt can
          // leave an empty orphan session, but cannot have started user work.
          task.status = 'cancelled';
          task.cancellation = { server_execution_stopped: true, remote_descendants_verified: true };
        } else {
          task.status = 'cancelling';
          this.save(task);
          const interrupted = await this.checked('POST', `/api/session/${task.sessionID}/interrupt`);
          const inbox = (await this.checked('GET', `/api/session/${task.sessionID}/inbox`)).data || [];
          if (inbox.some((item) => item.id === task.promptID)) await this.checked('DELETE', `/api/session/${task.sessionID}/inbox/${task.promptID}`);
          const active = (await this.checked('GET', '/api/session/active')).data || {};
          if (!active[task.sessionID]) {
            task.status = 'cancelled';
            task.pending = null;
            task.cancellation = { server_execution_stopped: true, interrupt_acknowledged: interrupted.interrupted === true, remote_descendants_verified: false };
            task.note = 'Server execution stopped. Remote/background processes may survive; verify them before conflicting operations.';
          }
        }
        this.save(task);
        this.audit({ event: 'task_cancel_requested', task_id: task.id, status: task.status });
        return this.public(task);
      }
      throw fail('Unknown tool', 404);
    });
  }
  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 2000);
    this.timer.unref();
    void this.tick();
  }
  async close() {
    clearInterval(this.timer);
    await this.operations;
    this.db.close();
  }
}
