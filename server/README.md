# Tinglan local Codex bridge

Run `node server/index.mjs` with Node 22.12+ and a current installed Codex CLI. The listener binds only to `127.0.0.1:4319`. The website must proxy `/api` to this address, preserving Origin and rewriting Host to `127.0.0.1:4319`. Root release scripts start this process alongside the site. `TINGLAN_CODEX_BIN` optionally specifies an absolute CLI executable; no API key is used. No packages beyond Node built-ins are required.

## Browser contract

- `GET /api/health`: process health, fixed model.
- `GET /api/codex/status`: safe account/authentication/plan/usage windows. No email, account ID, OAuth token, key or raw CLI errors returned.
- `POST /api/codex/login`: returns an official ChatGPT login URL for the user to open. Codex owns authentication. Login changes the shared local Codex account; there is intentionally no automated logout or quota-credit purchase.
- `POST /api/codex/notes`: `{recordings:[{id,title,createdAt,segments:[{id,source,translation,startMs}]}],prompt?:string}`. Responds in NDJSON: status, heartbeat, delta, result, or error. Browser cancellation aborts the Codex turn. No browser-supplied model, cwd, tool, credential, or arbitrary RPC is accepted.
- All POST requests need JSON, an allowed Origin, and `X-Tinglan-Client: 1`. Exact allowed localhost ports: 4317/4318/4319/4482/4416. Additional local development ports can be explicitly supplied through `TINGLAN_ALLOWED_PORTS` (comma-separated numeric ports).

Default: **gpt-5.6-luna**, **low** reasoning. Unavailable model/auth/usage errors do not silently switch model, provider, or billing. Transcript processing sends text (not audio blobs) to Codex under the user's ChatGPT account. Generated notes are returned to the app for local persistence. Threads are ephemeral: this is not a promise of a mirrored desktop sidebar task or durable Codex conversation history. The application owns persisted notes.

## Guardrails

The bridge creates a dedicated temporary working directory; thread/turn settings enforce read-only, no network-enabled tool sandbox, no environment access and no approvals. Startup disables shell, execution, browser, apps, plugins, hooks, agents and other unnecessary features; configured MCP servers are disabled. Tool requests fail closed and tool lifecycle events interrupt the turn. Base/developer instructions explicitly treat transcripts as untrusted data. The app-server transport is private stdio, never exposed over HTTP. Requests and outputs are size-limited, at most two concurrent jobs are admitted, and each turn is limited to four minutes. IDs are validated against submitted transcripts and timestamps are reconstructed from the source, never trusted from the model. This does not eliminate ordinary LLM factual/translation errors; users must still inspect source audio for deadlines and requirements.

## Tests and evidence

`node --test tests/bridge/bridge.test.mjs` covers input validation, fabricated citation rejection, protected hosts/origins, streaming, missing login, cancellation, process restart, forbidden tools and concurrency. These are mock/logic tests and do not prove account inference.

`node tests/bridge/real-smoke.mjs` consumes actual Codex quota using only a public synthetic classroom transcript. On 2026-09-07 UTC, real ChatGPT Pro authentication and Luna low succeeded: 166 streamed deltas, 16.6 seconds, cited concept/assignment/exam notes, and grounded follow-up Q&A. Test originally found an English word-count translation ambiguity in Q&A; instructions now explicitly preserve units. `node tests/bridge/real-adversarial-smoke.mjs` separately checks a public prompt-injection fixture, zero tool events and report units. Never run real tests using user recordings without authorization.

Official protocol references: https://learn.chatgpt.com/docs/app-server and the locally generated `codex app-server generate-ts --experimental` schemas for CLI 0.153.4. The app-server is version-dependent; a future CLI upgrade requires these regression tests.
