# Tinglan · recovery and evidence-backed study library

Updated: 2026-09-08. Accepted code is **main HEAD**; use `npm run coord -- status` for exact live SHA, pending changes and owners.

## Outcome

The original zero-transcript failure has been fixed. The website connects real local audio recognition/translation to a real ChatGPT-subscription Codex notes service. The 0.4 study-library candidate additionally handles real image understanding, mixed image/text/audio intake, cited assignment/DDL retrieval and the existing personal vault. Only integrated main is accepted; this document is not proof that a dirty candidate or cloud deployment is live. It is **not certified perfect or a measured 90/100**: classroom acoustic accuracy and long-lecture stress still need validation.

## What is implemented and evidenced

| Area | Current evidence |
| --- | --- |
| Local Chinese/English ASR | fp32 WASM avoids the former q8 ONNX initialization defect. Real WAV inference passes. |
| Recording-time captions | Actual AudioWorklet/MediaStream -> retained Whisper Tiny. English source and Chinese translation, Chinese captions, pause/resume and stop drain pass. Approx. 12-second warm-model first result in isolated 52-second tests, not zero-latency streaming. |
| Stop-time workflow | Actual App recording produces live subtitles, saves a playable Blob, runs full-recording refinement, translation and Codex final notes automatically; results survive reload. |
| Codex notes/Q&A | Local App Server, existing ChatGPT Pro login, gpt-5.6-luna low; streamed results with original recording/segment IDs and timestamps. No API key or separate Platform API calls. |
| Class/course organization | Course CRUD, batch import, append-to-class, recording/class/course summary scope, cross-recording citation playback. Real two-Chinese-audio UI import yielded 11 sources and classified deadlines/exam content. |
| Failure handling | Actionable model/network/AI errors, separate retry buttons, cancellation, protected old notes, interrupted-job recovery notices. Saved audio is retained. |
| Backup | Full audio Blob, text, course, settings, notes/checksum backup; atomic restore clones colliding IDs. Actual isolated IndexedDB 36/36 checks pass, including legacy empty Chinese target/title. |
| Local delivery | Version-stamped build, 4318 website + 4319 bridge, same-origin API proxy, hidden startup, wrong/stale version detection. No exposing public backend. |
| Coordination | Scoped worktrees, lease ownership, safe expired-lease renewal, deleted-path checks, ready refs, gated main integration. Lifecycle test passes. Local vibe Coding journal auto-updates metadata. |
| Study materials | Originals saved before AI. Actual Codex image extraction and course/category recognition; exact quoted evidence, source IDs and literal deadlines validated. Mixed invalid-image/TXT/WAV test preserved valid files, produced 3 real bilingual segments and Codex notes, then survived a new view. |
| Study retrieval | Combined material blocks and recording segments; explicit coverage, evidence viewer and recording-time links. Assignment/exam list keeps ambiguous DDL unbound instead of inventing calendar dates. |
| Personal vault | Existing library intake protocol, SHA-256 originals, verified append-only note section, duplicate detection, uncertainty states and preserved human edits. Two actual isolated vault tests pass; no unrelated personal files scanned. |
| Storage v3 | Original 36 backup checks plus 38 study migration/backup checks pass using isolated synthetic databases. v2 recordings preserved byte-for-byte; backup v2 and legacy v1 supported. |
| Lifecycle fixes | Learning batch survives navigation; cross-page cancellation stops remaining audio and marks saved pending originals retryable. Restore/clear invalidates temporary query/evidence snapshots. |

## Product architecture

- Browser: MediaRecorder, IndexedDB, AudioWorklet, Whisper Tiny for live captions, selected Tiny/Base for final refinement, local Opus English->Chinese translation.
- Backend: localhost-only Node bridge owns Codex App Server stdio and uses ChatGPT-managed authentication.
- Only selected transcript/material text and explicit images are sent to Codex. Raw recording files stay local: browser and, when configured, the existing personal vault. No OpenAI Audio API is used.
- Website notes are persisted by the website. Temporary Codex sessions are not represented as a mirror of the desktop task sidebar.
- New installations default to Base for final accuracy; Tiny is always used for lower-latency live captions. Existing precise-model selections are preserved.

## Remaining work / limitations

1. No 60–120 minute classroom, sleep/wake, crash-during-capture or multi-hour memory soak certification. Entire-file decoding still has memory cost. Keep the page/computer awake and stop/save at reasonable breaks.
2. Live captions are approximate; first-time model downloads are not real-time. Tiny misrecognizes some words; Base improves important terms but still makes mistakes and may repeat text.
3. Microphone/distance/noise, accents, Cantonese and mixed-language lessons require real-user testing. Tests used openly identified synthetic speech, not a fabricated microphone-permission pass.
4. Stop-time processing and upload jobs run while the page is open. After interruption, saved audio/text can be retried; no durable OS background job daemon.
5. Codex needs network, valid ChatGPT login and available subscription quota. It cannot turn subscription quota into arbitrary OpenAI API credit.
6. Browser storage is not cross-device sync. Backup JSON is unencrypted, with a 1GB import limit. Do not clear browser data without backup.
7. Not every Notta feature exists: no collaboration accounts, speaker diarization, calendar meeting bot, online shared links, mobile native app, or signed installer.
8. App has extracted runtime/assistant/storage/workflow modules but still has a large integration component. ARCH-001/UI-001/QA-001 remain future refinement tasks, not falsely marked finished.
9. Study intake does not yet parse PDF/Office. Cross-library queries are bounded and disclose selected-source coverage; query replies are temporary while material analyses persist. Exact-quote validation verifies citations, not overall model reasoning accuracy.
10. Online static UI does not include the user's localhost Codex/vault service. GitHub private repository exists; Cloudflare and Sites delivery must be verified by terminal deployment results. Other requested platforms are unspecified and await the user's names; do not mark the overall goal complete.

## How another task should join

Read `C:/Users/HP/Documents/vibe Coding/Tinglan/SKILL.md`, then canonical AGENTS/coordination Skill/protocol. Create a new task/worktree from current main, claim a non-overlapping scope and use its assigned dev port. Publish tested commits; integrate only on clean main; sync at clean boundaries. Never copy source folders over another task.

Detailed test evidence: `RELEASE_ACCEPTANCE.md`, `LEARN_ACCEPTANCE.md`, task JSON files, `tests/runtime/live-evidence.json`.
