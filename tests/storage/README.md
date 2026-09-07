# Storage and notes regression smoke

Run Vite for this task and open `/tests/storage/backup-smoke.html`.
The page must report `data-status="pass"` and all checks passed.

This uses actual browser IndexedDB transactions and binary Blobs in a randomly
named `tinglan-backup-test-*` database, deleted after the run. It never opens
`tinglan-local` or reads user recordings. It exercises valid full backups,
restoration into an empty current-v2 schema, add-only collision recovery,
class/course/source identity, settings, damaged input rejection, traditional
Chinese multi-category rules and interrupted-job recovery.

The module does not change the application schema. Existing legacy-v1 database
migration remains owned by `src/lib/db.ts`; the app must hydrate it before these
operations. A backed-up v2 database is re-created by the isolated test above.

Public integration contracts:

- `backupLocalData(): Promise<void>` — downloads one full JSON backup with audio.
- `restoreLocalData(file: File): Promise<{ recordings: number; courses: number }>`
  — validates everything before a single transaction, preserves existing records,
  clones conflicting IDs and remaps references. Counts are processed backup
  items, not unique additions (the reserved unfiled course may already exist).
  The previous settings are retained under a `before-restore-*` settings key.
- `getClassRecordings(records, active)` — same batch, or current recording only.
- `getCourseRecordings(records, courseId)` — ordered recordings in a course.
- `getRecordingSources(recordings)` — texts with original recording IDs and times.
- `recoverInterruptedRecording(recording)` — call at hydration only; converts stale
  processing/capturing to a truthful retryable error without removing content.

App controls, recorder stop integration and live Codex course-summary delivery
are the release task's responsibility and are not claimed by this smoke test.
Backups are unencrypted and contain private audio/text; store them privately.
Single-file JSON backups are limited to 1GB to avoid unbounded browser memory use.
