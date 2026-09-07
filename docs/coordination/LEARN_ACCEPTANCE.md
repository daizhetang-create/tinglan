# Tinglan 0.4 study-library acceptance — 2026-09-08

## Scope and truth

This report covers the LEARN-001 candidate. Accepted source is main after gated integration. A deployment is only delivered after its platform reports success; do not infer that from this report or a build. The full active user goal also includes long-classroom reliability, hosted distribution and unspecified other platforms; it is not complete merely because these bounded tests pass.

## Actual model / browser evidence

- Existing ChatGPT-managed Codex login, `gpt-5.6-luna`, low effort; no Platform API key or API billing fallback.
- A clearly labelled synthetic assignment PNG was uploaded through the real UI. Codex vision extracted six blocks; subsequent structured analysis retained: a **500-word** report, memory/learning topic, three academic sources, PDF portal submission, `next Friday at 5 pm`, exam `October 20 at 9 am`, student ID and missing exam year. No test result was seeded into product state.
- The first model analysis proposed an unconfigured course and was rejected. Output schema now restricts course names to configured names/null; real retry succeeded. Creating `Academic English` and reanalyzing assigned the existing exact course.
- Duplicate image + real synthetic English WAV: image was not saved twice; Whisper produced three real English segments, local translation produced three Chinese translations, Codex produced cited notes. Mixed invalid image + valid TXT + WAV subsequently retained both valid files. Reopening the view showed two materials and two audio originals; newest audio correctly displayed **00:11**, three segments and archived Codex notes.
- The invalid image was rejected by MIME/signature validation without aborting other selected files. The valid reading TXT was classified as reading under Academic English.
- Actual cross-image/audio query returned cited report/reading/submission/deadline facts. Citation viewer displayed `Read chapter 3 and submit the assignment by next Friday.` with the 00:03 audio source. Missing word-count/submission statements were subsequently moved to the explicitly unconfirmed section instead of being treated as requirements.
- Cross-page cancellation was tested with two selected synthetic WAVs: after navigating into the recording page and pressing Cancel, processing ended, the next audio remained unprocessed with an explicit retry notice, and all originals stayed saved. This is not a claim that abort instantly terminates an in-progress local inference kernel.
- Visual check of the real dual-pane recording view showed source/Chinese text, playable 11-second audio, connected Codex and classified notes.
- One older in-app test view stopped responding to automation; a replacement view on the same origin recovered stored results without clearing data. The already-running formal 4318 view remained responsive. This is recorded as a test-view limitation, not omitted from acceptance.

## Regression and safety evidence

- `node --test tests/bridge/bridge.test.mjs tests/study/study.test.mjs tests/study/vault.test.mjs`: **15/15** pass. Coverage includes subscription-only authentication, concurrency/cancel/error handling, Host/Origin protections, exact citations, invented dates/sources, image signatures, unsupported absence claims and real isolated vault execution.
- Existing browser `tests/storage/backup-smoke.html`: **36/36** pass.
- New browser `tests/study/storage-smoke.html`: **38/38** pass. Synthetic v2 database with 27 recordings migrates without altering audio hashes/transcripts or existing course metadata. Image backup, collision clone/remapped citations, legacy v1 import, atomic invalid-reference rejection and HTML-Blob disguise rejection pass. Retrieval coverage is explicit.
- Real vault test uses a separate temporary synthetic vault, verifies original hashes, successful note append, ready state, deduplication and preservation of manual additions. Forged tickets/invented deadlines do not alter existing notes. A Python subprocess exiting before receiving a large payload reports an error instead of crashing the bridge.
- No real user's 27 original recordings were cleared, replaced or used as test fixtures. The formal 4318 browser had its pre-existing originals plus the explicitly labelled 0.3 synthetic acceptance example.

## Known limitations / conditions

1. Keep the local launcher, browser and computer running; model downloads need network initially. Not certified for 60–120 minute continuous capture, sleep/wake or noisy classroom microphone conditions.
2. AI evidence checks guarantee source existence/exact quotation, not perfect OCR, translation or reasoning. Confirm important dates and word-count units against originals.
3. PNG/JPG/WebP up to 8 MB and TXT/MD up to 600 KB; PDF/Office parsing is not implemented. Audio decode still depends on browser codec and memory limits.
4. Personal-vault archive is local and optional; test traffic used an isolated override. Standard installed vault/Python are required for automatic archival on another computer. Browser origins keep separate local databases.
5. Static Sites/Cloudflare hosting cannot run the local Codex CLI or access private disk. The online surface states this and links to the local full application. No public AI backend or cross-device account/data sync is claimed.
6. Temporary cross-library query answers are not persisted/exported; original material analysis and evidence are. Oversized-library query coverage is disclosed; it is not unlimited full-library reasoning.
7. Do not call the whole product perfect, 90/100 or ready for anyone without the remaining long-classroom/installation/deployment checks. The user has not identified the requested “other platforms”.

## Integration and release gates

Before publication: TypeScript/build, task checkpoint, clean intended commit, isolated coordination lifecycle self-test (`FORWARD_TEST_PASS`), ready-ref publication and gated main integration. Build main again so `release.json` contains the actual accepted SHA and package version. Do not deploy a stale or differently built source.
