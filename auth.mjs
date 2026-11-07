import { createPublicKey, createVerify } from 'node:crypto';

// Credentials remain injected by the existing official Vault Agent.
export function makeAuth({ issuer, clientID, clientSecret, resource, requiredGroup, oauthClientID, fetcher = fetch }) {
  let jwksCache = { keys: [], at: 0 };
  let cachedToken;
  async function keys(force = false) {
    if (!force && jwksCache.keys.length && Date.now() - jwksCache.at < 300000) return jwksCache.keys;
    const response = await fetcher(`${issuer}/protocol/openid-connect/certs`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('JWKS unavailable');
    jwksCache = { keys: (await response.json()).keys.filter((key) => key.kty === 'RSA'), at: Date.now() };
    return jwksCache.keys;
  }
  async function authenticate(request) {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '');
    if (!match) return null;
    try {
      const parts = match[1].trim().split('.');
      if (parts.length !== 3) return null;
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (header.alg !== 'RS256') return null;
      let key = (await keys()).find((item) => item.kid === header.kid);
      if (!key) key = (await keys(true)).find((item) => item.kid === header.kid);
      if (!key) return null;
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${parts[0]}.${parts[1]}`);
      if (!verifier.verify(createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) return null;
      const now = Date.now() / 1000;
      if (claims.iss !== issuer || typeof claims.exp !== 'number' || claims.exp < now - 60) return null;
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now + 60)) return null;
      if (claims.azp !== oauthClientID || !Array.isArray(claims.groups) || !claims.groups.includes(requiredGroup)) return null;
      // Ownership uses stable issuer/sub, never a mutable username or client-supplied ID.
      if (typeof claims.sub !== 'string' || !claims.sub) return null;
      return { owner: `${issuer}|${claims.sub}` };
    } catch { return null; }
  }
  async function token(force = false) {
    if (!force && cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.value;
    const response = await fetcher(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientID, client_secret: clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Keycloak authentication unavailable (${response.status})`);
    const payload = await response.json();
    if (!payload.access_token) throw new Error('Keycloak authentication unavailable');
    cachedToken = { value: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 300) * 1000 };
    return cachedToken.value;
  }
  return {
    authenticate, token,
    metadata: { resource, resource_name: 'DownOps task bridge', authorization_servers: [issuer], scopes_supported: ['openid', 'profile', 'email'], bearer_methods_supported: ['header'] },
  };
}

export async function boundedJSON(response, maxBytes = 4 * 1024 * 1024) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Upstream response exceeds safety budget');
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : null;
  } finally { await reader.cancel().catch(() => {}); }
}

export function makeAPI(baseURL, auth, fetcher = fetch) {
  return async function api(method, route, body, retry = true) {
    const response = await fetcher(`${baseURL}${route}`, {
      method,
      headers: { authorization: `Bearer ${await auth.token()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    // Only a definitive authentication rejection is retried. Never retry an
    // uncertain POST after a network timeout: it may already have been admitted.
    if (response.status === 401 && retry) {
      await response.body?.cancel();
      await auth.token(true);
      return api(method, route, body, false);
    }
    return { ok: response.ok, status: response.status, payload: await boundedJSON(response) };
  };
}
