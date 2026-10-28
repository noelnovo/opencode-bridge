const ISSUER = process.env.OPENCODE_OIDC_ISSUER;
const ID = process.env.KEYCLOAK_AUTOMATION_CLIENT_ID;
const SECRET = process.env.KEYCLOAK_AUTOMATION_CLIENT_SECRET;
const API = 'http://127.0.0.1:4096';

const tokenResponse = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ID, client_secret: SECRET }),
});
const token = (await tokenResponse.json()).access_token;

async function call(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  return { status: res.status, payload };
}

const created = await call('POST', '/api/session', {
  title: 'full-access check',
  location: { directory: '/srv' },
  model: { providerID: 'deepseek', id: 'deepseek-flash' },
  permissions: [{ action: '*', resource: '*', effect: 'allow' }],
});
console.log('create:', created.status, JSON.stringify(created.payload).slice(0, 200));
const id = created.payload?.data?.id;
if (!id) process.exit(1);

const prompted = await call('POST', `/api/session/${id}/prompt`, {
  text: 'Use your shell tool to run exactly: hostname; id -un; touch /tmp/mcp-fullaccess-check && echo WROTE. Reply with the raw command output only, no commentary.',
});
console.log('prompt:', prompted.status);

let answer = '';
let outcome = '(timeout)';
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const list = await call('GET', `/api/session/${id}/message`);
  const messages = Array.isArray(list.payload?.data) ? list.payload.data : [];
  const idle = messages.find((m) => m.type === 'idle');
  if (idle) {
    outcome = idle.outcome || 'completed';
    answer = messages
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => m.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();
    break;
  }
}
console.log('outcome:', outcome);
console.log('answer:', answer.slice(0, 800));
await call('DELETE', `/api/session/${id}`);
