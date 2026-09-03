# Codex-backed Notes architecture

Status: planned under `AI-001`  
Default model: `gpt-5.6-luna`  
Reasoning effort: `low`  
Authentication: ChatGPT managed  
Transport: local bridge to Codex App Server over stdio

## Boundary

The browser UI is not allowed to launch Codex, store OAuth tokens, or connect to an unauthenticated App Server listener. A local Node or desktop host owns the Codex App Server child process and exposes a narrow authenticated loopback API to the UI.

```text
React UI
  -> authenticated localhost HTTP/SSE bridge
      -> codex app-server (stdio JSON-RPC)
          -> ChatGPT-managed Codex account
```

Audio transcription remains a separate local ASR responsibility. Codex receives normalized transcript chunks and source metadata, not an opaque hour-long browser blob.

## Required bridge responsibilities

- start, monitor, and restart the App Server process;
- initialize the version-matched JSON-RPC schema;
- run ChatGPT browser or device-code login;
- report account and rate-limit state without exposing tokens;
- create one durable Codex thread per course or configured class session;
- stream turn events to the UI and support cancellation;
- validate structured Notes output before persistence;
- retain recording ID, segment ID, start/end timestamps, model, prompt version, and generating turn ID;
- enforce loopback-only transport, per-launch capability tokens, origin checks, request-size limits, and explicit file access scope;
- recover cleanly after browser refresh or bridge restart.

## Initial Notes contract

The model must return schema-validated JSON containing:

- concise class summary;
- key concepts;
- teacher emphasis and conclusions;
- assignments with due dates and confidence;
- exam/reading points;
- questions and unresolved follow-ups;
- source citations as recording/segment/timestamp tuples.

Unsupported or uncertain claims must remain marked uncertain rather than being invented. The UI must show the underlying transcript at each citation.

## Model routing

Use Luna/low for live batches, classification, extraction, and ordinary questions. Batch transcript updates rather than starting a turn for every utterance. Escalate a final long-course synthesis to Terra only after a measured quality failure or an explicit user choice.

