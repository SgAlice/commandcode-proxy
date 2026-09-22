# Local parent-agent compatibility proxy

This optional service stays in the same fork but runs separately from the
Command Code adapter. It forwards **native Responses to native Responses**;
it does not route the parent model through Command Code or change its model.

```text
Codex -> authenticated gateway
           |-- parent Responses -> parent-proxy :3051 -> existing parent upstream
           `-- child Responses  -> proxy.mjs    :3050 -> Command Code
```

## Why both sides are needed

The child adapter understands Responses Lite tools and plaintext agent messages.
It cannot decrypt a delegated task encrypted by another provider. The parent
service changes the tool declarations **before** task generation:

- Removes `message.encrypted` annotations on collaboration message tools.
- Renames the `collaboration` namespace to the reserved
  `cc_collaboration_plain` namespace on the upstream wire (including tool-call
  history and explicit tool selection).
- Restores the original namespace on JSON responses and complete SSE JSON
  frames, including output-item and completed-response events.
- Leaves arguments, prompts, documents, images, tool results and encrypted
  reasoning/compaction contents untouched. This is **not decryption**.

The approach is informed by
[CLIProxyAPI's multi-agent compatibility implementation](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/client/codex/optimize-multi-agent-v2/optimize_multi_agent_v2.go).
That project's YAML flag is not a flag supported by this project. No access to
the upstream operator's configuration is needed to run this local service.
An upstream can still reject or override the adaptation, so live verification
is required; existing encrypted tasks must be dispatched again.

## Run

Linux Docker host, with a gateway able to reach host loopback:

```sh
# .env.parent is ignored by Git. Do not put API keys in it.
printf '%s\n' 'PARENT_UPSTREAM_BASE=https://your-existing-upstream.example/v1' > .env.parent
docker compose --env-file .env.parent -f compose.parent.yml up -d --build
curl --fail http://127.0.0.1:3051/health
```

The upstream URL must be the **original provider URL**, not the public gateway
URL (which would create a routing loop). Change only that provider's Responses
endpoint base URL in the gateway to `http://127.0.0.1:3051/v1`. Keep its original
credentials and header rules; the service forwards the incoming authorization
to the fixed upstream. Do not substitute the gateway's public client key for
the upstream provider key.

`compose.parent.yml` uses its own Compose project, `commandcode-parent`. The
existing `compose.local.yml` deployment is not recreated or removed by it.

Without Docker:

```sh
PARENT_UPSTREAM_BASE=https://your-existing-upstream.example/v1 npm run start:parent
```

Options: `PARENT_HOST` (loopback only), `PARENT_PORT` (3051),
`PARENT_TIMEOUT_MS` (600000), `PARENT_MAX_BODY_MB` (100).
The Compose health check assumes port 3051.

## Supported boundary and security

- `POST /v1/responses`: adapt JSON and SSE; full stateless input is required.
- `POST /v1/responses/compact`: authenticated pass-through, no content rewriting.
- `GET /v1/models`: authenticated pass-through.
- `GET /health`: local liveness only, not an upstream credential/model test.
- WebSockets and `previous_response_id` are not supported; use HTTP Responses
  with complete input. Compressed request bodies are rejected explicitly.
- The service binds only to loopback, requires incoming authorization for API
  paths, uses one fixed upstream, and does not follow redirects. It must remain
  behind an authenticated gateway, not be exposed directly to the Internet.
- Request/response bodies, API keys, prompts and upstream errors are not logged.
  Authorization is held only while forwarding; no credential store is added.
- SSE parsing handles split UTF-8 and CRLF frames, bounds frame size, respects
  downstream backpressure, and aborts the upstream when the client disconnects.
  A broken stream never becomes a fabricated `response.completed`.
- This is a protocol adapter, not a security boundary between local OS users.
  Any local caller can present its own upstream credentials to the fixed target.

## Tests and rollout

```sh
npm test
npm run test:parent
```

The parent suite uses local mock servers only. It verifies selective schema
rewriting, untouched user/tool data, tool history, output namespace restoration,
SSE chunk boundaries, authorization/header forwarding, error/timeout behavior,
size limits, fixed destination routing, and compaction pass-through.

Deployment validation on 2026-09-22 also passed two real Codex child tasks with
the configured DeepSeek mapping: a plaintext arithmetic/sentinel response, and
an actual read-only shell tool call returning its sentinel and exit code 0.
The shell call and matching tool result were checked in the child's session
record. No upstream operator settings were changed.

Before switching production traffic, save the original endpoint URL and confirm
that a synthetic delegated task comes back with a plaintext `message` and the
original tool namespace. Then test an actual child task and a child tool/result
round trip. Do not treat a successful HTTP status alone as a passing test.

## Rollback

Restore the gateway provider endpoint's saved original base URL **first**. This
returns parent traffic directly to the original upstream; leave credentials and
all other endpoints unchanged. After checking normal parent requests, stop only
the separate compatibility service:

```sh
docker compose --env-file .env.parent -f compose.parent.yml down
```

Do not stop the existing Command Code child adapter. Production backup files,
credential-loading scripts, endpoint IDs and live request logs do not belong in
this repository.
