# Use Pronto audits from another agent

`pronto serve --mcp` exposes audit evidence, audit execution and the audit-discussion skill on the webhook server's HTTP listener. Your external agent supplies its own conversation history. Pronto does not host another chat agent or start a second process.

The MCP token can run audits and post GitHub reviews when a caller sets `apply: true`. Previously read-only MCP tokens now have these permissions. Rotate or restrict existing tokens before enabling the upgraded endpoint.

The endpoint supports MCP `2026-07-28` only. It uses stateless Streamable HTTP with JSON responses, per-request metadata and `server/discover`. It advertises the `io.modelcontextprotocol/tasks` extension for long `run_audit` calls. It does not support stdio, `initialize`, protocol sessions, GET event streams or older MCP versions.

## Start the endpoint

Install and configure `pronto serve` as described in the [technical guide](GUIDE.md#serve-mode). The process still needs its usual GitHub credentials, model configuration and `PRONTO_WEBHOOK_SECRET`. Enabling MCP adds no model runtime. External MCP clients need no Pronto or Pi model login.

1. Choose the absolute `PRONTO_STATE_DIR` containing the repository databases you want to share.
2. Generate a dedicated secret once with `openssl rand -hex 32`. Store it in your secret manager. Inject it as `PRONTO_MCP_TOKEN` on the server and transfer it securely to authorised clients.
3. For remote access, start Pronto behind an HTTPS reverse proxy. For loopback-only local use, the MCP URL can use HTTP.

```sh
# Inject PRONTO_WEBHOOK_SECRET and PRONTO_MCP_TOKEN before running this command.
export PRONTO_STATE_DIR=/var/lib/pronto
pronto serve --mcp --mcp-public-url https://audits.example.com/mcp
```

MCP is disabled by default. It shares the `serve` listener, which defaults to `127.0.0.1:8080`. Options are:

| Option | Meaning |
| --- | --- |
| `--mcp` | Enable the MCP endpoint for audit reads and execution |
| `--mcp-public-url` | Required with `--mcp`; an HTTPS URL, or an HTTP URL on `localhost` or a loopback IP, including the endpoint path |
| `--mcp-allow-origin` | Additional trusted HTTPS browser origin; repeat as needed |
| `--host` | Shared bind address; default `127.0.0.1` |
| `--port` | Shared HTTP port; default `8080`; `0` selects a free port for local checks |

The MCP path must differ from the webhook path, `/healthz` and `/readyz`. MCP bearer credentials cannot authorise webhook admission. A webhook signature cannot authorise MCP reads. `--mcp` cannot yet be combined with experimental `--replicated-state`: reads need a term-aware audit source, not the replica's base state directory.

The token must contain at least 32 characters and differ from `PRONTO_WEBHOOK_SECRET`. Do not reuse a GitHub credential. There is no token argument: putting secrets in command arguments exposes them to process listings and shell history. Never put a token in a URL. Changing the token revokes existing clients. There are no read-only tokens, per-client identities or per-repository permissions.

The token grants access to all readable audits in that state directory, including private review text and saved code. It also allows file inspection at pinned commits and audit execution using the server's GitHub credentials. Audits can spend model credits, force reassessments and publish reviews or approvals with `apply: true`. Give the token only to clients you trust with those permissions. An `auditRef` identifies evidence; it is not a credential or permission grant.

Saved evidence reads do not contact GitHub. Additional `read_github_file` calls and audit execution use the server's GitHub authentication through `GITHUB_TOKEN`, `GH_TOKEN` or the existing `gh` fallback. Incoming MCP credentials are never used as GitHub credentials.

## Run an audit

Authenticated clients can call `run_audit` with these arguments:

| Argument | CLI equivalent and default |
| --- | --- |
| `targets` | PR URLs, `owner/repo#number`, numbers or branches. Omit to use the server's current branch |
| `model` | `provider/model-id`; omit to use the server's CLI default model |
| `skipLabels` | Repeated `--skip` labels; default empty |
| `skipDrafts` | `--skip-drafts`; default `true` |
| `skipApproved` | `--skip-approved`; default `true` |
| `reportSkips` | `--report-skips`; default `false` |
| `exclude` | Repeated `--exclude` path patterns; default empty |
| `force` | `--force`; default `false` |
| `approve` | `--approve`; default `false` |
| `allowUncertain` | `--allow-uncertain`; default `false` |
| `approveMigrations` | `--approve-migrations`; default `false` |
| `apply` | `--apply`; default `false` |

For example, `run_audit({targets: ["https://github.com/owner/repo/pull/42"], force: true})` reassesses a PR without publishing. To publish an eligible approval, add `apply: true` and `approve: true`. The defaults match the CLI, not the webhook flags passed to `pronto serve`. As with the CLI, previously authorised publications can still recover.

Skips are logged and returned without a review by default. Set `reportSkips: true` to preview a skip review, or combine it with `apply: true` to post the review. A skip caused by the server's own current approval remains quiet, even with both options. Repeated skip reviews are suppressed when a matching receipt is saved locally. This option does not affect verdict reviews for completed audits.

Numbers and branches use the server's `GH_REPO` or Git checkout, not the client's. An omitted target uses the server's current branch. Use explicit PR URLs when that context is not intended. The tool resolves and validates the whole batch before starting audits. The request body is limited to 64 KiB.

If an audit finishes within one second, `run_audit` returns the usual tool result. If it takes longer and the client declares `io.modelcontextprotocol/tasks` in its per-request capabilities, Pronto returns a task handle instead. Clients that do not declare the extension retain the synchronous behavior.

The synchronous result, or the completed task's `result`, contains `apply` and a `results` array in target order. Each result has a `prUrl` and a `status`: `completed`, `skipped` or `failed`. A completed result includes `auditId` and `cached`; a skipped result includes `reason`; a failed result includes `error`. If any PR fails, the tool result has `isError: true` and still includes the other results. Use the completed result's `prUrl` and `auditId` with `read_audit` for its evidence. A skip does not select an older audit.

The task handle includes a `taskId`, `ttlMs` and `pollIntervalMs`. Call `tasks/get` with that ID, sending the tasks extension capability on every request, and wait at least the advertised poll interval between polls. Pronto currently asks clients to poll every 1,000 ms. Task IDs and results are stored in the `mcp-tasks.sqlite` database under the configured state directory; completed task records are retained for 24 hours. In-progress tasks resume after a server restart using the audit runner's existing recovery behavior.

`tasks/cancel` requests cooperative cancellation. Pronto aborts waiting or active work where possible, but cancellation cannot undo an audit or publication that has already been saved. A server restart may also recover durable audit work independently of the task handle. Check the audit and GitHub before retrying an `apply: true` request.

MCP and webhook audits share `--concurrency` and do not overlap on the same PR. Work waiting for a slot is held in memory; cancellation removes a waiting call. A disconnect or shutdown can interrupt an active call. Once audit work or publication intent is saved, it may continue or recover after restart, including an explicitly requested `apply`. A lost response does not prove that no review was posted. Check the saved audit and GitHub before retrying.

## Put Caddy in front

Use [the example Caddyfile](examples/Caddyfile). Replace `audits.example.com` with a hostname you control, point its DNS at the proxy, and allow Caddy's certificate-validation traffic. Caddy obtains and renews TLS certificates.

```sh
caddy validate --config examples/Caddyfile --adapter caddyfile
caddy run --config examples/Caddyfile --adapter caddyfile
```

The example proxies `/mcp` and `/webhook` to the same port. Health and readiness endpoints remain private. It preserves the request Host and bearer header. Keep Pronto's HTTP port off the public network. If Caddy runs on another machine, bind Pronto to a private address and restrict that port to the proxy with your firewall.

Pronto validates Host against the configured public hostname and loopback diagnostic hosts. It does not trust `X-Forwarded-Host` or `X-Forwarded-Proto`. The configured public URL determines routing and the default allowed browser origin.

Requests without an Origin header are accepted with valid authentication, as needed by server-side agents. When Origin is present, it must exactly match the origin of `--mcp-public-url` or a configured `--mcp-allow-origin`. HTTP is permitted only for the loopback public URL; additional allowed origins must use HTTPS. Opaque and unlisted origins are rejected. This is not a CORS-enabled browser API: no browser preflight endpoint or wildcard origin is provided.

For remote access, use a trusted certificate and normal TLS verification on the client. Do not disable certificate checks. Avoid logging credentials or raw evidence at the proxy or client.

## Connect a current client

Use a client that implements the `2026-07-28` revision. A client advertised as supporting “Streamable HTTP” may still use the removed initialization handshake. Older MCP clients, including the built-in MCP connector in Pi 1.5.0, cannot connect directly. Pronto deliberately does not downgrade.

[The runnable SDK example](examples/mcp-client.mjs) uses `@modelcontextprotocol/client` 2.4.0, pinned to the modern revision:

```sh
# Securely inject the token on the client.
export PRONTO_MCP_URL=https://audits.example.com/mcp
node examples/mcp-client.mjs https://github.com/owner/repo/pull/42
```

Run it from this checkout after installing development dependencies. It discovers tools, fetches and verifies the native skill, and retrieves the full findings. It is a protocol example, not a conversation agent. Your agent host must load the verified skill body as guidance and expose the discovered tools to its model.

The skill uses the native `io.modelcontextprotocol/skills` extension. `skills/list` advertises `pronto-audit-discussion` with file sizes and SHA-256 digests. `resources/read` serves `skill://pronto-audit-discussion/SKILL.md`. The SDK's `SkillsClient` verifies those bytes. A host without native skills support can explicitly read that resource and load it as guidance. Resource discovery alone does not activate a skill.

The canonical source is [`skills/pronto-audit-discussion/SKILL.md`](skills/pronto-audit-discussion/SKILL.md). Terminal chat and MCP use the same instruction body. Pronto serves only the packaged skill, not arbitrary server files.

### Wire requirements

The official SDK supplies the mandatory metadata and matching HTTP headers. Hand-written clients must supply:

- `Authorization: Bearer <PRONTO_MCP_TOKEN>` on every request
- `Content-Type: application/json` and an Accept header permitting JSON
- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method` matching the JSON-RPC method
- `Mcp-Name` matching the tool name, resource URI or task ID when required by that method
- `params._meta` with `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`, and preferably `io.modelcontextprotocol/clientInfo`

Bodies are limited to 64 KiB, including chunked requests. Pronto does not mint, retain or resume a `Mcp-Session-Id`. Legacy session and event-ID headers have no meaning.

## Keep the selected audit stable

The external agent must retain the returned reference in its own conversation history:

```text
read_audit({prUrl})
  → auditRef, audit metadata, summary content
read_audit({auditRef, section: "findings"})
  → the same attempt's findings and original sources
read_github_file({auditRef, path: "src/access.ts", revision: "head"})
  → additional numbered code at that attempt's pinned commit
```

Without an `auditRef`, each PR lookup selects the latest saved attempt. A connection has no remembered selection. An omitted selector is an error, not permission to reuse another client's selection.

A retained reference keeps its PR, attempt and snapshot across newer audits, independent clients and MCP restarts. Pronto checks that the saved snapshot still has the expected identity. If evidence has been removed or replaced, the call fails rather than silently selecting different evidence.

To switch deliberately, use `read_audit({prUrl, latest: true})` without the old reference. To select an older attempt, supply a positive `auditId` returned by a tool or provided by the user. Never guess an ID. Metadata identifies the latest attempt and cached success separately; an accepted report is not necessarily a completed audit.

### Retrieve complete sources

`read_audit` provides `summary`, `findings`, `discussion`, `files`, `instructions` and `code`. A returned `commentKey` narrows findings or discussion to one saved source.

Its `content` is a character slice of section JSON, not always a complete JSON value. Each call returns at most 16,000 characters. Follow `nextOffset` with the same reference, section and comment key, join the content, then parse the complete JSON. Retain long replies' final qualifications. Tool results provide the same data as structured content and text.

Read saved `code` excerpts before requesting more code. `read_github_file` accepts only a repository-relative path and `head` or `base`, never arbitrary URLs, repositories, SHAs or moving branches. It returns at most 300 numbered lines. If an excerpt exceeds its 100,000-byte output limit, request fewer lines. A single oversized line is unavailable rather than silently truncated. Additional reads are labelled as new inspection, not evidence the original auditor necessarily saw.

## Read tools and audit execution

The read-only tools open saved databases through the audit reader. They do not create a repository Harness, take the audit owner's lock, migrate databases, initialise model credentials, resume assessments or recover authorised publications. They can read while the audit writer owns a database. MCP creates no conversation history.

The enclosing `serve` process owns audit execution and startup recovery, including previously authorised publications. Read tool calls do not start audits. `run_audit` uses the same server auditor as webhook work. Shutdown closes the endpoint and audit runtime.

There are no shell, local file or editing tools. Missing audits and evidence remain errors or explicit limitations.

An external agent may have other tools. Loading this skill does not authorise that agent to use them to change code, rerun an audit or post reviews. Pronto enforces the limits of its own tools even if an agent ignores the skill.

Saved evidence does not establish current GitHub comments, thread resolution, approvals, CI results or mergeability. Your agent's provider receives the evidence it retrieves; choose authorised clients and providers accordingly.

## Verification

Run `npm run check` and `npm test`. The MCP tests use real HTTP, the pinned modern SDK client and its native skill verifier. Audits come from the real CLI against simulated external endpoints.

They cover complete paginated sources, pinned code, malformed protocol traffic, credentials, origins, Host validation, oversized bodies, independent clients, restart and snapshot replacement. They also request read-only MCP tools against committed assessment and publication checkpoints while the audit owner lock is held, and verify unchanged state and external request counts. Task tests cover capability discovery, synchronous quick results, durable polling across restart and cooperative cancellation. Combined serve tests cover the single credential, CLI options and defaults, publication safeguards, shared concurrency, cancellation and recovery. MCP stays unavailable without the flag.
