# 0.3 recovery acceptance — 2026-09-08

## Root-cause resolution

The app previously recorded a playable file while the ONNX q8 Whisper session failed to initialize. Empty transcripts then fed a rule-only Notes placeholder. Stopping capture did not actually run the full recognition->translation->AI workflow. Launching old development/preview servers and clipped error text obscured these failures.

The recovery uses verified fp32 WASM pipelines, a retained live worker and a complete stop-time pipeline. The Notes panel now calls a real local Codex bridge with ChatGPT-managed authentication. An unsuccessful step is displayed as unsuccessful, with saved audio retained.

## Performed tests (not all equivalent)

### Real inference and browser UI

- CORE: real English and Chinese WAV -> timestamped ASR; real English->Chinese translation.
- LIVE: 52s synthetic audio at original speed through AudioContext -> MediaStream -> AudioWorklet -> actual Whisper. Independent MediaRecorder, 2s pause/resume. English first text 11.88s, first Chinese translation 12.36s; Mandarin first text 12.48s. Queue peak 1 of 3, drain 0, no skipped chunks in these samples. Models were preflighted for timing.
- Full App, isolated origin 4482: actual start/stop buttons, real WAV-derived MediaStream (only microphone source replaced; no ASR/translation/AI result mocking). 42s speech followed by silence, 3:14 saved recording. Live 12 transcript segments + Chinese text appeared while recording; stop triggered full final pass -> 10 timestamped segments and real Codex summary with working-memory concept, chapter-three/next-Friday assignment and final-exam relevance.
- Reload App: saved recording, 10 segments and 3 AI items remained.
- Actual UI multi-file chooser: two Chinese WAVs imported into a newly created test course. Each transcribed; combined class summary had 11 source segments. Categories included report due next Friday 17:00, exam October 20 09:00, chapter-three/working-memory scope and teacher follow-up. Unclear recognized words were flagged, not silently certified correct.
- Cross-recording source button: opened mandarin-classroom from mandarin-exam's class summary and played its audio.
- Actual append-to-class chooser: a third audio remained in the same course; cancellation stopped analysis and retained audio/text with an AI cancellation error and retry entry.
- Base final-pass Mandarin quality check: actual inference succeeded; recognized the exam term and October20 09:00 correctly. It still repeated an ending sentence / misrecognized one word. Base is not claimed error-free.
- Base final-pass English quality check: actual 11.36s fixture -> three correctly recognized sentences, including chapter-three / next-Friday assignment and final-exam relevance. Measured wall time was 62.67s; local final-pass inference is not instant.
- Post-fix real App Q&A: absent makeup-exam time answered "未提到补考的日期和时间，无法据此确定。" while the existing 8 key messages, 11-source overview and all original category counts remained intact. Focused questions no longer replace the full summary.
- Edited a synthetic record title, navigated to another recording and reloaded: updated title retained.

### Backend, storage and coordination

- Real ChatGPT Pro / Codex Luna low: synthetic summary streamed 166 deltas, completed in 16.6s, all three cited sources validated. Real Q&A for an absent makeup-exam date answered that it was not given. Adversarial transcript test generated no tools; units were preserved.
- 8 backend regression tests: no-login handling, schema/citation validation, error redaction, concurrent-job guard, concurrent first-status initialization, cancellation, tool blocking, foreign Host/Origin rejection.
- 3 runtime controller tests: deliberately stalled-worker queue bound, silence suppression, translation backlog/disposal. These are unit tests, not real inference claims.
- Real isolated IndexedDB 36/36: Blob bytes/MIME, metadata, courses, settings, citations, collisions remapped, no overwrite, corrupted data rejected atomically, Chinese legacy empty target and empty title supported.
- Additional real IndexedDB persistence regression 6/6: enqueue-time snapshot, newest-note ordering, save-then-delete, save-then-course-removal, Blob preservation and save-then-clear. Save/delete/clear now share the same queue; UI refuses deletion during capture/analysis.
- Notes/backup Node regression: traditional Chinese classification, empty-text refusal, source selection, checksums and malformed backups.
- Coordinator full isolated lifecycle: claim, dirty-worktree refusal, overlap rejection, invalid TTL, wrong-owner expired renewal rejection, active-overlap resurrection rejection, successful original-owner renewal, publish, main integration, ready/lease cleanup -> FORWARD_TEST_PASS.
- TypeScript and production build pass at release checkpoint. Formal 4318 serving/health/version must match integrated main, not this document's mutable commit.

## Verification boundaries

No synthetic fixture results were added to the user's production 4318 database. No user recording was sent to Codex during these tests; all remote tests used explicitly synthetic transcript data.

Not verified: physical microphone permission/acoustics, noisy lecture accuracy, 60–120 minute stress, suspend/resume, interrupted in-progress audio recovery, all browsers/devices, signed installer or automatic OS background processing. No “perfect” or numeric90 score is asserted.

## User checks / prerequisites

- Start with the project launcher, keeping the machine on and browser open.
- Wait for first model download on a working network. Saved audio is not deleted on download failure.
- Confirm the connection strip says Codex connected. Login with ChatGPT if the existing session expires; do not paste keys/tokens into the page.
- Use the same browser/origin to find old audio. 4317, 4318 and worktree preview ports have separate browser databases.
- Recording requires microphone permission. For computer sound, explicitly select share-audio in the browser picker.
- Critical dates/assignments are draft notes: use source timestamps to check them against original speech.
- Back up before clearing any browser data; backup files contain private unencrypted audio and text.
