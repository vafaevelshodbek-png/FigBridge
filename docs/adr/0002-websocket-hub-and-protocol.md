# 0002. WebSocket hub with a versioned request/response protocol

- Status: accepted
- Date: 2026-09-24

## Context

The prototype used HTTP long-polling with a single command slot: 0.4–5 s latency, stalls when Figma throttles hidden iframes, and any concurrent call overwrote the pending one. Competitors show the failure modes to avoid: servers bound to all interfaces with `Access-Control-Allow-Origin: *` (grab #163), silent hangs without timeouts (southleft #94/#133), port leaks on Windows (southleft #116), writes landing in the wrong file (southleft #72) (research 01, 03).

## Decision

- WebSocket (`ws`) between the hub and the plugin UI iframe, `127.0.0.1:7331`.
- Envelope `{v, id, type: req|res|evt|cancel, method, params, session}`, ULID ids, structured errors `{code, message, retryable, data}`.
- `hello`/`welcome` handshake with protocol-version negotiation and a pairing token.
- One session per open file; explicit routing; `AMBIGUOUS_SESSION` instead of guessing.
- Timeouts from a single table, cancellation, heartbeat 20 s, reconnect with full-jitter backoff, idempotency keys.
- Binary frames for blobs in ≤1 MB chunks with acks; the Scene references blobs by id.
- One process owns the port (PID lockfile); later processes relay to it. Exit on stdin EOF / parent death.

## Consequences

- Latency drops to one round trip; concurrent calls are safe.
- The plugin must implement reconnection and chunk reassembly — covered by contract tests against a fake plugin.
- Protocol changes require an ADR and a version bump.
