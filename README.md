# opencode-bridge

The **DownOps MCP bridge**: an HTTP + MCP service that exposes the DownOps estate
(repositories, hosts, k3s, Vault) to a *remote* OpenCode agent — the owner's Windows
client — **without ever handing that machine a credential the OpenCode server accepts**.

It runs on **LXC 103** (`10.2.0.9`), next to the OpenCode server it drives, and is
published as `https://ask.int.downops.win/mcp` through the NPM reverse proxy on LXC 113.

```
Windows OpenCode client
  └─ MCP remote server "downops"        Authorization: Bearer <Keycloak user access token>
        │  HTTPS via NPM: ask.int.downops.win -> 10.2.0.9:4780
        ▼
opencode-bridge   (LXC 103, /opt/opencode-bridge/bridge.mjs, user opencode, :4780)
  • Keycloak bearer validation (RS256, JWKS), rate limit, size caps, timeouts, audit log
  • mint its own Keycloak service-account token (client opencode-automation)
        │  http://127.0.0.1:4096
        ▼
OpenCode server (custom OIDC build)
  └─ one persistent session, agent build, location /srv, permissions = allow *
     sees /srv/opencode (live context) + /srv/downops/repos (source mirrors of every repo)
     and can ssh dev | proxmox | malza
```

## Access model — read this before you hand out a token

Authentication is **Keycloak OAuth only**. There is no static key, no query-string token,
no anonymous path. Every request must carry an access token minted for the **public client
`downops-mcp`** by a user in the **`admin`** group.

Since 2026-10-27 the answering session is **full-power** (`permissions: allow *`): the remote
agent can run shell commands, write files, `ssh dev|proxmox|malza`, run `kubectl`, deploy and
read Vault. A valid `downops-mcp` token is therefore an **estate-admin credential**:

- revoke a user by removing them from the Keycloak `admin` group or ending their SSO session;
- every question is recorded in `/var/log/opencode-bridge/audit.log` with the Keycloak
  `preferred_username`, so actions are attributable after the fact;
- the destructive-operation rules still apply: the primed session is told to act on clear
  instructions and to ask when a request is ambiguous.

> Historical: the first deployment (2026-10-27, Raju-only) was read-only. A couple of comments
> in `init/opencode-bridge` and `scripts/opencode-downops-sync` still say "read-only"; that is
> stale wording, not the current behaviour. They are kept byte-identical to the deployed files.

## HTTP surface

| Method / path | Auth | Behaviour |
|---|---|---|
| `GET /health` | none | `{ok, service, workspace_dir, repos, synced_at, auth, session, queued, uptime_s}` |
| `GET /.well-known/oauth-protected-resource` (+ `/mcp`) | none | RFC 9728 metadata for MCP clients |
| `POST /ask` | Keycloak token | `{question, reset?}` → `{answer, session_id, elapsed_ms}` |
| `POST /mcp` | Keycloak token | MCP streamable-HTTP JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `prompts/list`; notifications get `202` |
| anything else | Keycloak token | `401` with the `resource_metadata` challenge, otherwise `404` |

Status codes: `400` invalid input / path escape, `413` too large, `415` binary file,
`429` rate or queue limit, `502` prompt/agent failure, `504` answer timeout.

## MCP tools

| Tool | Purpose |
|---|---|
| `ask_downops` | Ask the DownOps agent to inspect, change, deploy, debug or verify anything on the estate. It acts (shell, file write, ssh, kubectl) and reports what it did. |
| `read_downops_file` | Read any file on the OpenCode host (root `/`). |
| `grep_downops` | Regex/literal search under a path (default `/srv`), `path:line: text` output. |
| `list_downops` | List a directory (default `/srv`). |

Tools appear namespaced in the client (`downops_ask_downops`, …).

## Configuration (environment)

Loaded by `init/opencode-bridge-env` at service start, as root, from Vault KV v2
`downops/data/opencode`. **No secret is stored in this repository.**

| Variable | Source | Meaning |
|---|---|---|
| `KEYCLOAK_AUTOMATION_CLIENT_ID` | Vault `downops/data/opencode` | confidential client the bridge uses to call the OpenCode API |
| `KEYCLOAK_AUTOMATION_CLIENT_SECRET` | Vault `downops/data/opencode` | secret of that client |
| `OPENCODE_OIDC_ISSUER` | Vault `downops/data/opencode` | Keycloak realm issuer URL |
| `BRIDGE_RESOURCE_URL` | optional | public resource URL, default `https://ask.int.downops.win` |
| `BRIDGE_OAUTH_CLIENT_ID` | optional | client id accepted as `azp`, default `downops-mcp` |
| `BRIDGE_REQUIRED_GROUP` | optional | required Keycloak group, default `admin` |
| `BRIDGE_WORKSPACE_DIR` | optional | agent working directory, default `/srv` |
| `BRIDGE_FILES_ROOT` | optional | root for the file tools, default `/` |
| `BRIDGE_MODEL_PROVIDER` / `BRIDGE_MODEL_ID` | optional | session model, default `deepseek` / `deepseek-flash` |
| `BRIDGE_PORT` / `BRIDGE_BIND` / `BRIDGE_API_BASE` | optional | `4780` / `0.0.0.0` / `http://127.0.0.1:4096` |
| `BRIDGE_PER_MINUTE` / `BRIDGE_MAX_QUEUE` / `BRIDGE_ASK_TIMEOUT_MS` | optional | `10` / `3` / `600000` |
| `BRIDGE_STATE_DIR` / `BRIDGE_LOG_DIR` | optional | `/var/lib/opencode-bridge` / `/var/log/opencode-bridge` |

The loader reads `/etc/opencode/vault.env` (mode `600`, root) for `VAULT_ADDR` /
`VAULT_TOKEN` only. `OPENCODE_BRIDGE_KEY` is **retired**: the bridge logs it and ignores it.

## Deployed file map

| Repo path | Target on LXC 103 | Owner / mode |
|---|---|---|
| `bridge.mjs` | `/opt/opencode-bridge/bridge.mjs` | `opencode:opencode`, `644` |
| `init/opencode-bridge` | `/etc/init.d/opencode-bridge` | `root:root`, `755` |
| `init/opencode-bridge-env` | `/usr/local/sbin/opencode-bridge-env` | `root:root`, `750` |
| `scripts/opencode-downops-sync` | `/usr/local/bin/opencode-downops-sync` | `root:root`, `755` |
| `scripts/opencode-bridge-selftest.mjs` | `/usr/local/bin/opencode-bridge-selftest.mjs` | `root:root`, `755` |

Runtime state/logs (not in the repo): `/var/lib/opencode-bridge/session.json` (mode `600`),
`/var/log/opencode-bridge/{bridge.log,bridge.err,audit.log}`, mirror stamp
`/srv/downops/repos/.synced-at`.

## Install / update

On LXC 103, as root, from a checkout of this repo:

```sh
./deploy.sh            # copies the files, fixes modes, restarts the service, checks /health
```

Notes:

- Node 24 from Alpine is enough — `bridge.mjs` uses only the Node standard library, no npm deps.
- The mirror sync needs `rsync` on **both** 103 and the dev container (110): `apk add rsync`,
  `apt-get install rsync`.
- The mirror sync is driven from **root's** crontab (`/etc/crontabs/root`) every 10 minutes via
  `su -s /bin/sh opencode -c '/usr/local/bin/opencode-downops-sync'`. User crontabs do not fire
  on 103 (the `opencode` user's shell is `/sbin/nologin`).

## Keycloak prerequisites

1. **`downops-mcp`** — public client, standard flow + PKCE (`S256`), no secret.
   Redirect URIs: `http://127.0.0.1:38765/callback`, `http://localhost:38765/callback` (V2
   `callback_port`), and `http://127.0.0.1:19876/mcp/oauth/callback`,
   `http://localhost:19876/mcp/oauth/callback` (V1 default). Exact match — register both families.
   Mappers: `groups` (access-token claim, `full.path=false`) and an audience mapper for
   `https://ask.int.downops.win`.
2. **`opencode-automation`** — confidential client used by the bridge: service account in group
   `admin`, plus an audience mapper adding `opencode` so the OpenCode server accepts its token
   (`OPENCODE_AUTH_SERVICE_ACCOUNT=true`, `OPENCODE_OIDC_REQUIRED_GROUP=admin`).
3. Validation gate is `azp === "downops-mcp"` **and** group `admin`. Service-account tokens
   (`azp=opencode-automation`), expired/tampered tokens and tokens without the group all get `401`.

Keycloak caches group membership: after changing the service account's groups, restart the
`keycloak` container (twice in practice) until its token carries `groups=["admin"]`.

## Client setup (Windows)

```jsonc
{
  "mcp": {
    "servers": {
      "downops": {
        "type": "remote",
        "url": "https://ask.int.downops.win/mcp",
        "oauth": { "client_id": "downops-mcp", "scope": "openid profile email", "callback_port": 38765 }
      }
    }
  }
}
```

```sh
opencode mcp auth downops   # browser login, stores + refreshes the tokens
opencode mcp list           # downops -> connected
```

There is **no WAN port-forward to 443**: the bridge is LAN/VPN-only, and
`ask.int.downops.win` resolves through the AdGuard rewrite `*.int.downops.win -> 10.2.0.10`.

## Verification (no secrets printed)

```sh
rc-service opencode-bridge status
curl -s http://127.0.0.1:4780/health          # expect a repo count, recent synced_at, auth.mode=oidc
curl -sI http://127.0.0.1:4780/health          # 200
curl -s  http://127.0.0.1:4780/mcp             # 401 + WWW-Authenticate resource_metadata
. /usr/local/sbin/opencode-bridge-env && node /usr/local/bin/opencode-bridge-selftest.mjs
# selftest mints its own service-account token, creates a full-access session, asks the agent to
# run `hostname; id -un; touch /tmp/mcp-fullaccess-check`, prints the outcome, deletes the session.
```

A warm ask returns in 2–10 s; a task that changes something can take minutes (600 s cap).
The session is reused between questions; `reset: true` starts a fresh one.

## Gotchas

- **`session.wait` races.** It returns when the session *is* idle, which can be before a
  just-admitted prompt starts. `waitForRun` loops wait → look for a fresh `idle` message →
  sleep 300 ms. Do not "simplify" it back to a single wait.
- **A stored session keeps its old permissions.** The ruleset is applied at `POST /api/session`;
  after editing `SESSION_RULES`, delete `/var/lib/opencode-bridge/session.json` and restart,
  otherwise the bridge keeps answering inside the old session.
- **The MCP client caches `initialize` / `tools/list`.** Reconnect the client after changing tool
  descriptions or permissions.
- **Model choice matters.** An OpenRouter model failed with `provider.quota`; the bridge pins
  `deepseek/deepseek-flash`.
- **Do not hand-roll JWK/DER import** — `createPublicKey({ key: jwk, format: 'jwk' })` is the
  supported, dependency-free route.
- **Rate limiting runs before input validation**, so malformed floods are limited too.
- **`/health` is unauthenticated** and must never include secrets (it reports only mode/resource/
  client id/group).

## Related repositories

- `downops/opencode` + `noelnovo/opencode` — the OpenCode fork served on 103 (OIDC + service-account auth).
- `downops/opencode-config` — the server's `AGENTS.md`, skills and `opencode.jsonc`.
- Operational skill on the OpenCode server: `opencode-agent-bridge`.
