# Discuss saved audits from another agent

`pronto serve --mcp` exposes saved audit evidence and the audit-discussion skill on the webhook server's HTTP listener. Your external agent supplies its own model and conversation history. Pronto does not host another chat agent or start a second process.

The endpoint supports MCP `2026-07-28` only. It uses stateless Streamable HTTP with JSON responses, per-request metadata and `server/discover`. It does not support stdio, `initialize`, protocol sessions, GET event streams or older MCP versions.

## Start the endpoint

Install and configure `pronto serve` as described in the [technical guide](GUIDE.md#serve-mode). The process still needs its usual GitHub credentials, model configuration and `PRONTO_WEBHOOK_SECRET`. Enabling MCP adds no model runtime. External MCP clients need no Pronto or Pi model login.

1. Choose the absolute `PRONTO_STATE_DIR` containing the repository databases you want to share.
2. Generate a dedicated secret once with `openssl rand -hex 32`. Store it in your secret manager. Inject it as `PRONTO_MCP_TOKEN` on the server and transfer it securely to authorised clients.
3. Start Pronto behind an HTTPS reverse proxy.

```sh
# Inject PRONTO_WEBHOOK_SECRET and PRONTO_MCP_TOKEN before running this command.
export PRONTO_STATE_DIR=/var/lib/pronto
pronto serve --mcp --mcp-public-url https://audits.example.com/mcp
```

MCP is disabled by default. It shares the `serve` listener, which defaults to `127.0.0.1:8080`. Options are:

| Option | Meaning |
| --- | --- |
| `--mcp` | Enable the read-only MCP endpoint |
| `--mcp-public-url` | Required with `--mcp`; public HTTPS URL, including the endpoint path |
| `--mcp-allow-origin` | Additional trusted HTTPS browser origin; repeat as needed |
| `--host` | Shared bind address; default `127.0.0.1` |
| `--port` | Shared HTTP port; default `8080`; `0` selects a free port for local checks |

The MCP path must differ from the webhook path, `/healthz` and `/readyz`. MCP bearer credentials cannot authorise webhook admission. A webhook signature cannot authorise MCP reads. `--mcp` cannot yet be combined with experimental `--replicated-state`: reads need a term-aware audit source, not the replica's base state directory.

The token must contain at least 32 characters and differ from `PRONTO_WEBHOOK_SECRET`. Reusing the webhook secret would let readers forge deliveries, so startup rejects it. Do not reuse a GitHub credential either. There is no token argument: putting secrets in command arguments exposes them to process listings and shell history. Never put it in a URL. Keep the same token across restarts; changing it revokes existing clients. There are no per-client identities or permissions.

The token grants access to all readable audits in that state directory, including private review text and saved code. It also allows additional file inspection within those audits' pinned repositories and commits, using the server's GitHub credentials. Use a separate state directory and process for a different access boundary. An `auditRef` identifies evidence; it is not a credential or permission grant.

Saved evidence reads do not contact GitHub. Only additional `read_github_file` calls need server-side GitHub authentication through `GITHUB_TOKEN`, `GH_TOKEN` or the existing `gh` fallback. Incoming MCP credentials are never used as GitHub credentials.

## Put Caddy in front

Use [the example Caddyfile](examples/Caddyfile). Replace `audits.example.com` with a hostname you control, point its DNS at the proxy, and allow Caddy's certificate-validation traffic. Caddy obtains and renews TLS certificates.

```sh
caddy validate --config examples/Caddyfile --adapter caddyfile
caddy run --config examples/Caddyfile --adapter caddyfile
```

The example proxies `/mcp` and `/webhook` to the same port. Health and readiness endpoints remain private. It preserves the request Host and bearer header. Keep Pronto's HTTP port off the public network. If Caddy runs on another machine, bind Pronto to a private address and restrict that port to the proxy with your firewall.

Pronto validates Host against the configured public hostname and loopback diagnostic hosts. It does not trust `X-Forwarded-Host` or `X-Forwarded-Proto`. The configured public URL determines routing and the default allowed browser origin.

Requests without an Origin header are accepted with valid authentication, as needed by server-side agents. When Origin is present, it must exactly match the public HTTPS origin or a configured `--mcp-allow-origin`. Opaque, HTTP and unlisted origins are rejected. This is not a CORS-enabled browser API: no browser preflight endpoint or wildcard origin is provided.

Use a trusted certificate and normal TLS verification on the client. Do not disable certificate checks. Avoid logging credentials or raw evidence at the proxy or client.

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
- `Mcp-Name` matching the tool name or resource URI when required by that method
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

## Read-only guarantees and limits

MCP requests open saved databases through the read-only audit reader. They do not create a repository Harness, take the audit owner's lock, migrate databases, initialise model credentials, resume assessments or recover authorised publications. They can read while the audit writer owns a database. MCP creates no conversation history.

The enclosing `serve` process still owns audit execution and startup recovery, including previously authorised publications. Enabling MCP does not disable or add to that work. Only signed webhook admission starts webhook audits; MCP reads do not enter that path. Shutdown closes both endpoints and the audit runtime.

There are no shell, local file, editing, assessment, approval or publication tools. Missing audits and evidence remain errors or explicit limitations. Run a manual audit with `pronto <PR URL>` or send an authorised webhook delivery.

An external agent may have other tools. Loading this skill does not authorise that agent to use them to change code, rerun an audit or post reviews. Pronto enforces the limits of its own tools even if an agent ignores the skill.

Saved evidence does not establish current GitHub comments, thread resolution, approvals, CI results or mergeability. Your agent's provider receives the evidence it retrieves; choose authorised clients and providers accordingly.

## Verification

Run `npm run check` and `npm test`. The MCP tests use real HTTP, the pinned modern SDK client and its native skill verifier. Audits come from the real CLI against simulated external endpoints.

They cover complete paginated sources, pinned code, malformed protocol traffic, credentials, origins, Host validation, oversized bodies, independent clients, restart and snapshot replacement. They also mount and request MCP against committed assessment and publication checkpoints while the audit owner lock is held. They verify unchanged audit bytes, task records and external request counts. A combined `serve` CLI test verifies modern MCP discovery, verified skill loading and saved reads on the webhook port, separate authentication, signed webhook delivery and graceful shutdown. MCP stays unavailable without the flag.
