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
