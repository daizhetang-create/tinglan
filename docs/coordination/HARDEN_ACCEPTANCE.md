# Tinglan 0.5 · hardening acceptance

Date: 2026-09-08. Task: HARDEN-001. Formal delivery is the integrated main commit, not this report alone.

## Root causes addressed

- Original q8 ONNX session initialization failure was fixed by fp32 WASM in earlier accepted work.
- Capture previously retained audio only in memory until stop. A v4 journal now commits chunks every second and atomically finalizes; interrupted decodable prefixes can recover. Duplicate tabs and repeated permission clicks cannot own the same capture.
- Whole-recording browser decoding could allocate multiple lecture-sized PCM copies. Native Small now streams through bounded windows; unknown/long files cannot silently fall back to unbounded browser decode.
- Native browser translation creation had no deadline; initialization and per-call waits are now bounded. A failed local worker drains its old queue rather than making repeated model reload attempts.
- New Windows installations could require Git/PowerShell 7, or fail on the official npm Codex shim. Node startup and safe npm-entry resolution now support a prebuilt portable directory. Configuration verifies the actual Python selected by the runtime.
- Hosted UI could attempt sensitive POST requests even without its local bridge. The client now rejects these before fetch, including deceptive localhost suffixes and file origins.

## Actual browser workflows

Only synthetic classroom speech was used on isolated 4546/4549 origins. No new user microphone permission or private recording was claimed as test evidence.

| Workflow | Observed result |
| --- | --- |
| English actual App MediaRecorder | 42-second source fixture; final encoded audio decodes to 39.72 seconds, eight Small segments with Chinese translation, four actual Codex items; reload retains data |
| Chinese actual App MediaRecorder | Same controlled 42-second source; six Small segments, three actual Codex items, including chapter-three/report task, literal next-Friday DDL, exam reminder; reload retains data |
| Mid-job cancellation | Original Blob and already saved text survive cancellation, home navigation and reload; cancellation is not shown as successful GPT completion |
| Re-transcribe confirmation | In-page confirmation replaces blocking native confirm; accepted re-run finishes Small -> translation -> Codex |
| Partial refinement | Draft stored separately from old complete transcript; only complete results replace formal text and engine metadata |
| Journal | 29 checks; real navigation-interrupted WebM yields a decodable 6.12-second prefix from ~9 seconds capture, not a claim of lossless last-tail recovery |
| Existing storage | 36 original backup, 38 study migration/backup and six persistence regression checks pass in isolated DBs |

Live Tiny remains approximate. In Chinese, “一份报告” was incorrect in live output and corrected by native Small; compressed English fixture still sometimes reads “Read” as “Red”. Codex cites these transcripts and can inherit ASR errors. Do not hard-code sample phrases or conceal uncertainty.

## Long workloads

- **Two-hour live soak:** actual wall-clock synthetic playback through AudioWorklet/Tiny/translation on a frozen accepted 0.4 build. 7205.5 seconds elapsed, 1779 segments, 857 translation batches, 0 skipped chunks, 100805604 saved bytes. First text 13.26 seconds, first Chinese translation 13.93 seconds. JS heap remained ~15 MB, but excludes native/WASM/browser/Blob memory. This test predates candidate capture journaling.
- **Native three-window HTTP run:** 141752 ms decoded audio, 31 segments, 1024000 maximum buffered samples, 0 seam warnings, 99.3 seconds processing under load. Actual abort releases worker; malformed audio rejected.
- **Native two-hour sparse file:** 24 declared speech bursts separated by silence, 7200000 ms, 95 segments, 1024000 maximum buffered samples, 157.34 seconds processing. Not dense-speech two-hour accuracy.
- **Unit/regression:** 24 Node tests and four Python seam/coverage tests. Controller fakes prove bounds/failure handling, not speech accuracy.

## User-facing conditions and limits

1. This computer: local Small configured; ChatGPT-managed Codex Pro login tested with `gpt-5.6-luna` low. No Platform API calls or key required. Network and remaining Codex quota still matter.
2. New Windows computer: Node >=22.12, installed Codex CLI + own ChatGPT login; Python 3.12 and first-time Small setup for long-audio refinement. Bundled source does not include private login, model cache, vault or user recordings.
3. Keep computer/page awake. Not certified for sleep/wake, physical microphone/noisy lecture hall, all devices or malicious-codec native RSS limits. Stop/save during sensible breaks and export a backup.
4. Notes are grouped into concepts, emphasis, assignments/literal deadlines, exams/readings and follow-ups. Time-source buttons support verification. Relative dates stay literal; model reasoning can still be wrong.
5. Static hosting is not a remote Codex server. Localhost service is never exposed by this release; no cross-device browser-data sync. Private Sites and Cloudflare no-public-route policy remain unchanged.
6. PDF/Office parsing, speaker diarization, team accounts, signed installer and durable OS background job daemon are not implemented. Other platform destinations remain unspecified.

## Release gate

Run check/build, checkpoint, commit, publish and integrate through the coordination Skill; then rebuild on exact clean main. Verify launcher, package manifest/archive, health and each deployment receipt. Shared `vibe Coding/Tinglan/LIVE_STATUS.json` mirrors accepted metadata automatically. Do not copy source directories between tasks.
