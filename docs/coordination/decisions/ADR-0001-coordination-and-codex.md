# ADR-0001: Git coordination and Codex-backed product architecture

Status: accepted  
Date: 2026-09-03

## Decision

Use an independent Git repository with `main` as the only accepted product state. Parallel Codex chats work in dedicated branches/worktrees and communicate through task files, shared leases, ready refs, and coordinator-controlled integration.

For product AI, keep audio transcription in a reliable local ASR service. Use a localhost bridge to communicate with Codex App Server over stdio and authenticate with ChatGPT-managed OAuth. Use `gpt-5.6-luna` with low reasoning as the default notes model.

## Why

The former directory had no independent Git history, no task ownership, and no safe integration mechanism. The browser-only q8 inference stack currently fails before producing transcript segments. Browser code also cannot safely own account credentials or launch a local Codex process.

## Consequences

- The project gains reversible history and conflict-safe parallel work.
- Other chats must start from the new baseline and use the repo skill.
- Accepted updates propagate through `main`, not by copying folders.
- A small local backend or desktop shell is required for Codex integration.
- Local-first no longer means offline-only when Codex enhancement is enabled; the UI must disclose that transcript text is sent to Codex.

