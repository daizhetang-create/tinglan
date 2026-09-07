import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { enrichWithFocusNotes, extractKeyMessages } = await server.ssrLoadModule('/src/lib/focusNotes.ts');
  const { serializeBackup, parseBackup } = await server.ssrLoadModule('/src/features/storage/backup.ts');
  const { recoverInterruptedRecording, getClassRecordings } = await server.ssrLoadModule('/src/features/storage/classRecords.ts');
  const { DEFAULT_SETTINGS } = await server.ssrLoadModule('/src/types.ts');
  const sample = { id: 's1', startMs: 0, endMs: 5000, speaker: '讲师', source: '作業是閱讀第三章，期末考試會考這個概念。', translation: '' };
  const keys = extractKeyMessages([sample]);
  assert(keys.some((key) => key.category === 'assignment'));
  assert(keys.some((key) => key.category === 'exam'));
  assert(keys.some((key) => key.category === 'concept'));
  assert(sample.source.includes('作業'));
  assert.equal(extractKeyMessages([sample], 0).length, 0);
  assert.equal(extractKeyMessages([sample, { ...sample, id: 'duplicate' }]).length, keys.length);
  const at = '2026-09-07T00:00:00.000Z';
  const rec = enrichWithFocusNotes({
    id: 'record1', title: '', createdAt: at, updatedAt: at, durationMs: 5000,
    status: 'complete', analysisStatus: 'ready', recordingMode: 'zh', sourceLanguage: 'zh-CN', targetLanguage: '',
    segments: [sample], notes: [], bookmarks: [], keyMessages: [], audioBlob: new Blob([new Uint8Array([0, 1, 255, 128])], { type: 'audio/wav' }),
  }, 'standard', true);
  assert.equal(enrichWithFocusNotes({ ...rec, segments: [] }, 'standard', true).classBrief, undefined);
  assert.equal(recoverInterruptedRecording(rec), rec);
  const recovery = recoverInterruptedRecording({ ...rec, analysisStatus: 'summarizing' });
  assert.equal(recovery.analysisStatus, 'error');
  assert.equal(recovery.audioBlob, rec.audioBlob);
  assert.equal(recovery.segments, rec.segments);
  assert.equal(getClassRecordings([rec, { ...rec, id: 'other' }], rec).length, 1);
  const serialized = await serializeBackup({ recordings: [rec], courses: [], settings: { ...DEFAULT_SETTINGS, recordingMode: 'zh', targetLanguage: '' } });
  const parsed = await parseBackup(serialized);
  assert.equal(parsed.settings.targetLanguage, '');
  assert.equal(parsed.recordings[0].targetLanguage, '');
  assert.equal(parsed.recordings[0].title, '');
  assert.deepEqual(new Uint8Array(await parsed.recordings[0].audioBlob.arrayBuffer()), new Uint8Array([0, 1, 255, 128]));
  assert.equal(parsed.recordings[0].classBrief.sections.assignments.length, 1);
  const damaged = JSON.parse(await serialized.text());
  damaged.recordings[0].audio.sha256 = '0'.repeat(64);
  await assert.rejects(() => parseBackup(new Blob([JSON.stringify(damaged)])), /校验失败/);
  const malformed = JSON.parse(await serialized.text());
  malformed.settings.recordingMode = ['zh'];
  await assert.rejects(() => parseBackup(new Blob([JSON.stringify(malformed)])), /recordingMode/);
  const badEnglish = JSON.parse(await serialized.text());
  badEnglish.settings.recordingMode = 'en-zh';
  await assert.rejects(() => parseBackup(new Blob([JSON.stringify(badEnglish)])), /targetLanguage/);
  const badEnglishRecording = JSON.parse(await serialized.text());
  badEnglishRecording.recordings[0].metadata.recordingMode = 'en-zh';
  await assert.rejects(() => parseBackup(new Blob([JSON.stringify(badEnglishRecording)])), /targetLanguage/);
  const badTitle = JSON.parse(await serialized.text());
  badTitle.recordings[0].metadata.title = null;
  await assert.rejects(() => parseBackup(new Blob([JSON.stringify(badTitle)])), /title/);
  await assert.rejects(() => parseBackup(new Blob(['not a backup'])), /JSON/);
  console.log('NOTES_AND_BACKUP_UNIT_PASS: traditional multi-category, deduplication, empty input, interruption, class grouping, Blob checksum, malformed input, legacy Chinese empty target.');
} finally {
  await server.close();
}
