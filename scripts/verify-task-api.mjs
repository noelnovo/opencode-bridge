#!/usr/bin/env node
// Explicit, non-mutating infrastructure smoke test. Creates an isolated OpenCode
// conversation, reads instructions/one skill, asks a question, and answers it.
// Uses the existing supervised Bridge credential in memory; never prints it.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeAuth, makeAPI } from '../auth.mjs';
import { TaskBridge } from '../tasks.mjs';

if (!process.argv.includes('--live-test')) {
  console.error('Use --live-test to authorize an isolated server-agent verification (no infrastructure changes).');
  process.exit(1);
}
try {
  const pid = readdirSync('/proc').find((entry) => {
    if (!/^\d+$/.test(entry)) return false;
    try { return readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').includes('/opt/opencode-bridge/bridge.mjs'); }
    catch { return false; }
  });
  if (!pid) throw new Error('Supervised Bridge process unavailable');
  const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((entry) => {
    const equal = entry.indexOf('='); return [entry.slice(0, equal), entry.slice(equal + 1)];
  }));
  const auth = makeAuth({ issuer: env.OPENCODE_OIDC_ISSUER, clientID: env.KEYCLOAK_AUTOMATION_CLIENT_ID, clientSecret: env.KEYCLOAK_AUTOMATION_CLIENT_SECRET });
  const api = makeAPI('http://127.0.0.1:4096', auth);
  const stateDir = path.join(process.env.HOME, '.cache/bridge-task-upgrade', `smoke-${Date.now()}`);
  const model = { providerID: env.BRIDGE_MODEL_PROVIDER || 'github-copilot', id: env.BRIDGE_MODEL_ID || 'gpt-6.1-sol' };
  let bridge = new TaskBridge({ stateDir, api, model });
  const context = { owner: 'operator-verification', clientSession: `smoke-${Date.now()}` };
  let task;
  try {
    task = await bridge.call('submit_downops_task', {
      project: 'bridge-verification', workflow: 'question-roundtrip', idempotency_key: 'smoke-1',
      objective: 'This is an isolated bridge verification. Read /srv/opencode/AGENTS.md, load the proxmox-safe-file-editing skill, then use the question tool to ask exactly "Choose the bridge test environment" with two options "dev" and "production", header "Environment". Wait for the answer. After receiving dev, reply exactly BRIDGE_QUESTION_ROUNDTRIP_OK. Do not run shell commands, delegate, edit any files, access Vault, or change infrastructure.',
      constraints: 'Read-only instructions/skill and one interactive question only. No commits, pushes, deploys or restarts.',
    }, context);
    const deadline = Date.now() + 240000;
    let replied = false;
    let restarted = false;
    while (Date.now() < deadline) {
      await bridge.tick();
      task = await bridge.call('get_downops_task', { task_id: task.task_id }, context);
      if (task.status === 'awaiting_input') {
        if (task.pending_input.kind !== 'question' || replied) throw new Error('Unexpected pending input');
        // Prove the journal survives a Bridge restart while the server waits.
        if (!restarted) {
          await bridge.close();
          bridge = new TaskBridge({ stateDir, api, model });
          await bridge.tick();
          task = await bridge.call('get_downops_task', { task_id: task.task_id }, context);
          if (task.status !== 'awaiting_input') throw new Error('Pending question not recovered');
          restarted = true;
        }
        const answer = Object.fromEntries(task.pending_input.fields.map((field) => [field.key, field.type === 'multiselect' ? ['dev'] : 'dev']));
        await bridge.call('answer_downops_question', { task_id: task.task_id, question_id: task.pending_input.id, answer }, context);
        replied = true;
      }
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const passed = task.status === 'succeeded' && replied && task.output.text.trim() === 'BRIDGE_QUESTION_ROUNDTRIP_OK'
      && task.context_evidence.canonical_instructions_read && task.context_evidence.skills_loaded.includes('proxmox-safe-file-editing');
    console.log(JSON.stringify({ passed, status: task.status, question_answered: replied, bridge_journal_recovered: restarted, context_evidence: task.context_evidence, test_session_id: task.session_id }));
    if (!passed) process.exitCode = 1;
  } finally {
    if (task && !['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      await bridge.call('cancel_downops_task', { task_id: task.task_id }, context).catch(() => {});
    }
    await bridge.close();
  }
} catch { console.error('Live verification failed; inspect its isolated test session without dumping credentials or logs.'); process.exitCode = 1; }
