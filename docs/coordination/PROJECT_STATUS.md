# Tinglan product recovery status

Updated: 2026-09-03

## Main objective

Raise Tinglan from the current broken prototype to a verified 90/100 product. `main` is the only accepted product state; branches are proposals until integrated.

## Honest baseline

Current audited state: **prototype / approximately 20 of 100**. Recording, playback, local storage, course grouping, multi-file import, and exports have real implementations. The core transcript-to-notes chain is not usable on the current runtime.

The score is evidence-based, not cosmetic. A feature earns points only after its acceptance tests pass with real inputs.

| Area | Target points | Current evidence |
|---|---:|---|
| Reliable Chinese/English transcription and translation | 25 | Blocked by ONNX q8 session failure; browser captions are not a reliable fallback |
| Codex-powered notes, extraction, and cited Q&A | 20 | Not implemented; current engine is rules and keyword search |
| Multi-audio course workflow and durable jobs | 15 | File import exists; course-level merge, resume, and retry do not |
| Data safety, backup, privacy, and recovery | 10 | IndexedDB exists; full backup, migration safety, and encryption do not |
| Notta-inspired usable UI and accessibility | 10 | Strong visual prototype; error truthfulness and full interaction QA are missing |
| Performance and long-lecture reliability | 10 | Whole-audio decode risks excessive memory; no 60–120 minute stress evidence |
| Automated quality gates and distributable app | 10 | TypeScript/build only; no unit, E2E, audio smoke, installer, or update path |

Target 90 means the first six areas are production-usable, automated regression coverage exists, and no P0/P1 blocker remains. The final ten points may cover advanced collaboration, cloud sync, and broader platform polish.

## Confirmed P0 failure

The browser records audio, but local Whisper cannot create its ONNX session. The installed `@huggingface/transformers 4.2.0` path uses a pre-fix development `onnxruntime-web 1.26` with hard-coded `wasm + q8`. This produces `TransposeDQWeightsForMatMulNBits Missing required scale`, leaving zero transcript segments. Notes then have zero sources.

The user does not need an API key to fix this defect.

## Architecture decision

- Use a reliable local ASR service (`faster-whisper` or `whisper.cpp`) for recording-time and uploaded-audio transcription, with browser inference only as a verified fallback.
- Use Codex App Server through a localhost bridge for summaries, structured extraction, cited Q&A, and course-level synthesis.
- Use ChatGPT-managed Codex authentication, not a secret embedded in the browser.
- Default AI model target: `gpt-5.6-luna`, low reasoning, streaming output. Escalate only complex final synthesis to Terra when quality gates require it.
- Preserve local-first storage, but disclose when transcript text is sent to Codex.

## Ordered delivery plan

1. **CORE-001** — restore and harden transcription/translation with real audio smoke tests.
2. **ARCH-001** — split the `App.tsx` monolith so runtime, notes, and UI can safely progress in parallel.
3. **AI-001** — add the localhost bridge and Codex App Server ChatGPT login; replace fake AI controls with streamed, cited results.
4. **COURSE-001** — durable background jobs, multi-audio course timeline, merged notes, retry, and resume.
5. **UI-001** — complete Notta-inspired interaction quality, truthful states, accessibility, and responsive QA.
6. **QA-001** — unit/E2E/audio fixtures, long-lecture stress, backup/restore, and release gates.

## Coordination state

Use `npm run coord -- status` for live branch, lease, ready-queue, and SHA information. Runtime coordination is stored in the Git common directory so every worktree sees it immediately. This document is the durable roadmap, not a substitute for Git state.

