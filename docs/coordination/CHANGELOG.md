# Integrated product changes

This file is updated only by the integration workflow. Feature branches publish to `refs/codex/ready/*`; publication is not acceptance.

## 2026-09-03

- Established the independent Tinglan repository and a coordination baseline.
- Recorded the verified product gap and the 90/100 recovery mission.
- Added repo-level project coordination instructions, task leases, ready refs, guarded commits, safe-boundary sync, and integration gates.


- 2026-09-07 10:23 integrated CORE-001 from ee1ca70f2ecd9efdbb7e0c4aa177e3325538b6f6: Browser WASM fp32 smoke passes for synthetic Mandarin and English PCM audio with timestamps; Xenova opus translation returns Chinese. Worker retry and timeout recovery added. App auto-analysis wiring remains FLOW-001.

- 2026-09-08 00:22 integrated AI-001 from 425f60b678be8275965d5afddcc40a05d9d51642: Real ChatGPT Pro Codex Luna notes and Q&A verified; secure local NDJSON bridge, cited outputs, login status, cancellation, 7 regression tests and build pass

- 2026-09-08 00:22 integrated COURSE-001 from ed525aa9fe15645b62640dddfcbd044fc12d905b: Full backup restore and class source helpers; 28 isolated browser checks pass plus Blob/notes unit regression. Release owns UI/Codex integration.

- 2026-09-08 00:33 integrated AI-002 from 98f8069a391e22b599e30813cb37263eab95fb9c: Codex startup and restart hardened; 8 bridge regressions and build pass; AI-001 real subscription inference unchanged

- 2026-09-08 00:56 integrated LIVE-001 from 1c4dba56c932d4d0fc8241261767b4afe5ab07b4: Verified real-time synthetic EN to Chinese and Mandarin through MediaStream/AudioWorklet/Whisper; first output12s, bounded queue, pause/resume, recording retained; 3 controller tests pass; cold download and tiny accuracy limits documented.

- 2026-09-08 01:06 integrated COURSE-002 from 5f1de7ff9bd49479f0df664f7b916e1a51927ef2: Legacy Chinese empty targetLanguage and empty title now round-trip; 36 real IndexedDB browser checks and Node/check/build pass.

- 2026-09-08 02:13 integrated RELEASE-001 from bbefd533c5b05cd60adb75540a114fcb66c12172: Verified recording-to-Codex integration, 42 real IndexedDB checks, grounded Q&A preservation, final Base quality tests, stable local launcher and shared Skill; no perfect/long-class certification.

- 2026-09-08 04:56 integrated LEARN-001 from 006d45ad77a8b19363e18705d851b98c7110d9c5: Verified real image/audio study library, source-grounded DDL retrieval, local vault preservation, 15 Node and 74 browser regression checks; hosted AI and unspecified platforms remain explicit limitations

- 2026-09-08 08:51 integrated HARDEN-001 from 8e6078923b3410dc586e8f1be68fa2fc077c8fae: Verified 0.5: durable recording recovery, bounded Small ASR, actual Chinese/English Codex workflow, portable launch and hosted no-upload guards; documented limits

- 2026-09-12 15:30 integrated ENGINE-001 from ead349ade81e8ba7a8610869504810f380f62df3: Retained native live/file ASR, bounded quality gates, grounded notes citations, and real synthetic latency evidence; frontend integration remains next.

- 2026-09-12 15:49 integrated ASR-002 from 8002a9e52d6cf305a47eccbbd5987e42baf2d910: Connect live captions to retained native Small API with bounded browser fallback

- 2026-09-12 15:59 integrated NOTES-003 from ef0d6b6abc71859d8c076d2e55216ce76f11b46b: Connected native live ASR UI, removed quadratic live Codex submissions, withheld local fallback as final AI summary, and preserved grounded evidence quotes.
