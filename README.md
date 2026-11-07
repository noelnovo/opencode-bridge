# DownOps task bridge v4

The local OpenCode agent owns local source, Android SDK and USB/ADB work. It
delegates infrastructure tasks to a separate OpenCode agent on LXC103, which
reads the server's `AGENTS.md` and loads relevant server skills. Infrastructure
credentials remain on the server, injected by the existing official Vault Agent.

```text
Local OpenCode → Keycloak-authenticated MCP → durable task journal
                                             ↓
                                      Server OpenCode agent
                                      server instructions/skills
                                      SSH / infrastructure tools
```

This is still an estate-admin management channel, not a sandbox. Authentication
remains public Keycloak client `downops-mcp`, PKCE, required `admin` group. The
Bridge alone obtains the server-side automation token. No client secret, static
key or server private key is added to the workstation. Ownership uses immutable
issuer/subject; a caller session ID is correlation metadata, not authentication.

## Client configuration (OpenCode V2)

Merge this into your **local** global `~/.config/opencode/opencode.jsonc`, or the
project's `opencode.jsonc`. Preserve unrelated providers, models and MCP entries.
An existing `downops` entry should be updated, not duplicated.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "downops": {
        "type": "remote",
        "url": "https://ask.int.downops.win/mcp",
        "protocol": "legacy",
        "codemode": false,
        "oauth": {
          "client_id": "downops-mcp",
          "scope": "openid profile email",
          "callback_port": 38765
        },
        "timeout": { "execution": 60000 }
      }
    }
  }
}
```

The URL and login are unchanged. Disconnect/reconnect DownOps through `/mcps`
to refresh the cached catalog and instructions. If authentication is needed,
select DownOps in `/mcps` and sign in through Keycloak. Then check:

```sh
opencode mcp list
```

LAN/VPN access and trusted HTTPS are required. Do not disable certificate
verification or paste a token into configuration. No SSH tunnel is necessary.
`codemode: false` exposes the small task catalog directly; Code Mode also works.
The bridge uses the classic MCP handshake through protocol2025-11-25, not the
2026-07-28 discovery protocol.

## Tools

| Tool | Purpose |
|---|---|
| `submit_downops_task` | Persist a precise task and return its ID before execution |
| `get_downops_task` | Read persisted status, pending input and byte-paginated final output |
| `answer_downops_question` | Answer/dismiss the existing pending form, or reply once/reject to a permission request |
| `continue_downops_task` | Submit a follow-up in a finished task's server conversation |
| `cancel_downops_task` | Interrupt the server execution and cancel its admitted queued input |
| `list_downops_tasks` | Recover the authenticated user's recent task IDs |

Client tools appear as `downops_submit_downops_task`, etc. MCP initialization
provides workflow instructions to the local agent, not server skills or inventory.

Example task arguments:

```json
{
  "project": "wallettracker",
  "workflow": "android-dev",
  "idempotency_key": "verify-api-001",
  "objective": "Verify that the dev API is compatible with the attached contract summary.",
  "constraints": "Read-only. No commits, deployments, production changes or restarts.",
  "acceptance_checks": "Report compatibility, readiness and any mismatches."
}
```

Related work uses the same workflow; unrelated work uses another workflow. Server
sessions are separated by authenticated user, invoking local OpenCode session
metadata, project and workflow. Explicit task-ID follow-ups reuse the original
conversation. Neither starting another workflow nor cancelling deletes history.

## Questions and approvals

```text
queued → dispatching → running → awaiting_input → running → succeeded/failed
                              ↘ cancelling → cancelled
               ↘ needs_review (uncertain admission/monitoring; never auto-retry)
```

When status reports `awaiting_input`, the local agent must present the complete
question/options to the user, preferably using its local question UI. It then
calls `answer_downops_question` with the returned task/question IDs and exact field
keys. For example:

```json
{
  "task_id": "task_...",
  "question_id": "frm_...",
  "answer": { "q0": "dev", "q1": ["health", "contract"] }
}
```

Free text and multiple questions/multiselect are supported. Dismiss with
`reject: true`; permission requests use `decision: "once"` or `"reject"`.
Permanent permission grants are deliberately unavailable. Do not send another
prompt to answer a pending question. Never have the local agent invent user
approval, and never submit credentials through questions.

Question forwarding is a task-tool workflow, **not automatic cross-client UI
mirroring or MCP elicitation**. The local agent presents the returned question.
The server bootstrap requires question-tool use for user input. This is verified
agent behavior, not a technical enforcement layer for every possible command.

## Reliability, privacy and limits

- Status reads do not generate model output. Pace checks around5–10seconds.
- Retry the identical submission with the original idempotency key. Reusing that
  key with different work is rejected. A network timeout does not prove failure.
- Bridge tasks execute serially, including while awaiting input. This prevents
  concurrent Bridge writers, but does not lock out independent operators.
- SQLite persists tasks/sessions atomically in `/var/lib/opencode-bridge/tasks.sqlite`
  (0600; directory0700 at runtime). The old `session.json` and OpenCode history
  are retained, not imported into every user's new conversations.
- After Bridge restart, admitted work is monitored, not blindly resubmitted.
  Restarting the main OpenCode server is separate: forms can be ephemeral and
  require review if lost. Do not infer that a durable task journal makes every
  server-side tool or subprocess durable.
- `needs_review` blocks subsequent Bridge dispatch until resolved or cancelled.
- Cancellation confirms server execution only when reported. Remote SSH/background
  descendants may survive; verify before conflicting work. It is not rollback.
- Input/objectives and final results are stored in the protected task journal;
  never submit credentials. Audit records contain selected metadata, not prompt,
  answer, token or raw tool payloads. Existing historical audit files are retained.
- Queue cap3, journal cap5000tasks (explicit retention review required at cap),
  bounded upstream/history responses, final output cap200KB, result window16KB.
  Large final results have `output.next_offset`; server tool logs are not exported.

## HTTP surface and removed interfaces

Retained: `POST /mcp`, public `GET /health` (minimal liveness/version only), and
`GET /.well-known/oauth-protected-resource` plus its `/mcp` alias for OAuth discovery.
Empty standard MCP resource/prompt catalogs remain for client compatibility.

Removed: `POST /ask`, `ask_downops`, `read_downops_file`, `grep_downops`,
`list_downops`, direct file traversal, reset/delete-conversation behavior and
JSON-RPC batches. Authenticated legacy HTTP paths return404; unauthenticated
requests retain401. Ask the server agent to inspect files under its own rules.

## Operations

Node24+ standard library (`node:sqlite`); no npm dependencies or new service.
Preserve existing OpenRC → official Vault Agent → Bridge supervision. The three
credentials remain in `downops/services/opencode/bridge`; no Vault/OIDC changes
are required. Model defaults remain `github-copilot/gpt-6.1-sol`.

```sh
node --test tests/*.test.mjs
node scripts/verify-task-api.mjs --live-test
```

The explicit live test creates an isolated server conversation, verifies a
canonical-instruction read, skill activation, question reply and journal recovery.
It does not change infrastructure or delete existing conversations. It borrows
only the existing supervised Bridge credential in memory and prints metadata.

On LXC103 as root, with the source staged:

```sh
./deploy.sh --stage
# Only after explicit owner approval and checking that old Bridge work is idle:
./deploy.sh --activate-with-owner-approval CURRENT_BRIDGE_SHA256
```

Activation installs a versioned source directory, atomically switches the existing
`/opt/opencode-bridge/bridge.mjs` entrypoint, and restarts only the Bridge. It
preserves native Agent/init configuration. The retired credential-loader/init and
old model-pinned selftest are removed from this repo; never reinstall them.

The deployment retains the previous entrypoint under a root-only backup directory.
For an approved rollback, check current code/task activity, restore that entrypoint
(and its recorded release target for a previous modular build), and restart only
the Bridge. Keep the new journal and old OpenCode sessions; do not delete state.
