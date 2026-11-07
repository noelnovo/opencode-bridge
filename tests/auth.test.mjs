import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { makeAuth, makeAPI, boundedJSON } from '../auth.mjs';

test('OAuth verifies signature/issuer/client/group/expiry and stable owner', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test' };
  const auth = makeAuth({ issuer: 'https://issuer.test', oauthClientID: 'downops-mcp', requiredGroup: 'admin', fetcher: async () => Response.json({ keys: [jwk] }) });
  const jwt = (overrides = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: 'https://issuer.test', azp: 'downops-mcp', sub: 'immutable-user-id', preferred_username: 'mutable-name', groups: ['admin'], exp: Date.now() / 1000 + 300, ...overrides })).toString('base64url');
    const value = `${header}.${claims}`;
    return `${value}.${sign('RSA-SHA256', Buffer.from(value), privateKey).toString('base64url')}`;
  };
  const request = (token) => ({ headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await auth.authenticate(request(jwt())), { owner: 'https://issuer.test|immutable-user-id' });
  for (const invalid of [{ azp: 'opencode-automation' }, { groups: [] }, { iss: 'wrong' }, { exp: 0 }, { sub: '' }, { nbf: Date.now() / 1000 + 500 }]) assert.equal(await auth.authenticate(request(jwt(invalid))), null);
  assert.equal(await auth.authenticate(request(`${jwt()}tampered`)), null);
  assert.equal(await auth.authenticate({ headers: {} }), null);
});

test('bounded upstream JSON refuses oversized payload', async () => {
  await assert.rejects(boundedJSON(new Response('x'.repeat(101)), 100), /safety budget/);
  assert.deepEqual(await boundedJSON(Response.json({ ok: true }), 100), { ok: true });
});

test('API never retries an uncertain mutation', async () => {
  let calls = 0;
  const api = makeAPI('http://test', { token: async () => 'synthetic' }, async () => { calls++; throw new Error('network timeout'); });
  await assert.rejects(api('POST', '/prompt', { text: 'synthetic' }));
  assert.equal(calls, 1);
});
