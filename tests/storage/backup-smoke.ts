import { serializeBackup, parseBackup, readLocalSnapshot, restoreBackup, type LocalSnapshot } from '../../src/features/storage/backup';
import { getClassRecordings, getCourseRecordings, getRecordingSources, recoverInterruptedRecording } from '../../src/features/storage/classRecords';
import { enrichWithFocusNotes } from '../../src/lib/focusNotes';
import { DEFAULT_SETTINGS, type RecordingSession } from '../../src/types';

const results: string[] = [];
const result = document.querySelector<HTMLPreElement>('#result')!;
const databaseName = `tinglan-backup-test-${crypto.randomUUID()}`;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  results.push(`PASS ${message}`);
}
async function rejection(fn: () => Promise<unknown>, message: string) {
  let rejected = false;
  try { await fn(); } catch { rejected = true; }
  assert(rejected, message);
}
const at = '2026-09-07T00:00:00.000Z';
const bytes = new Uint8Array([0, 255, 127, 1, 2, 3, 0, 200]);
const recording: RecordingSession = enrichWithFocusNotes({
  id: 'audio-a', title: '中文课', createdAt: at, updatedAt: at,
  durationMs: 10_000, status: 'complete', analysisStatus: 'ready', recordingMode: 'zh',
  sourceLanguage: 'zh-CN', targetLanguage: 'zh-CN', courseId: 'math', batchId: 'class-1',
  segments: [{ id: 's1', startMs: 0, endMs: 5000, speaker: '讲师', source: '作業是閱讀第三章。期末考試會考這個概念。', translation: '' }],
  notes: [{ id: 'n1', atMs: 3000, text: '需要复习' }], bookmarks: [{ id: 'b1', atMs: 4000, label: '重点' }],
  keyMessages: [], audioBlob: new Blob([bytes], { type: 'audio/wav' }), audioMimeType: 'audio/wav',
}, 'lecture', true);
const partTwo: RecordingSession = { ...recording, id: 'audio-b', title: '第二段', createdAt: '2026-09-07T00:01:00.000Z' };
const sourceBrief = recording.classBrief!;
sourceBrief.sections.assignments[0] = { ...sourceBrief.sections.assignments[0], sourceRecordingId: 'audio-b' } as typeof sourceBrief.sections.assignments[number];
recording.keyMessages[0] = { ...recording.keyMessages[0], sourceRecordingId: 'audio-b' } as typeof recording.keyMessages[number];
const snapshot: LocalSnapshot = {
  recordings: [recording, partTwo],
  courses: [{ id: 'math', name: '数学', term: '秋季', color: '#123456', createdAt: at, updatedAt: at }],
  settings: { ...DEFAULT_SETTINGS, recordingMode: 'zh', sourceLanguage: 'zh-CN', autoTranslate: false },
};

try {
  const serialized = await serializeBackup(snapshot);
  const parsed = await parseBackup(serialized);
  assert(parsed.recordings.length === 2 && parsed.courses.length === 1, 'metadata counts round-trip');
  assert(JSON.stringify([...new Uint8Array(await parsed.recordings[0].audioBlob!.arrayBuffer())]) === JSON.stringify([...bytes]), 'actual Blob bytes round-trip');
  assert(parsed.recordings[0].audioBlob!.type === 'audio/wav', 'Blob MIME preserved');
  assert(parsed.recordings[0].notes[0].text === '需要复习' && parsed.recordings[0].bookmarks[0].atMs === 4000, 'notes and timestamps preserved');
  assert(parsed.settings.autoTranslate === false && parsed.settings.sourceLanguage === 'zh-CN', 'settings round-trip');
  assert(recording.classBrief!.sections.assignments.length > 0 && recording.classBrief!.sections.examReading.length > 0, 'traditional Chinese multi-category classification');
  assert(recording.segments[0].source.includes('作業'), 'original traditional transcript unchanged');
  assert(!enrichWithFocusNotes({ ...recording, segments: [] }, 'standard', true).classBrief, 'no empty successful brief');

  assert(getClassRecordings([partTwo, recording], recording)[0].id === recording.id, 'class source order stable');
  assert(getClassRecordings([recording, partTwo], { ...recording, batchId: undefined }).length === 1, 'no batch means only current recording');
  assert(getCourseRecordings([recording, partTwo], 'math').length === 2, 'course source selection');
  assert(getRecordingSources([recording, partTwo])[1].recordingId === 'audio-b', 'source recording identity retained');
  const recovered = recoverInterruptedRecording({ ...recording, analysisStatus: 'transcribing' });
  assert(recovered.analysisStatus === 'error' && recovered.audioBlob === recording.audioBlob && recovered.segments === recording.segments, 'interrupted job retry preserves audio and transcript');
  assert(recoverInterruptedRecording(recording) === recording, 'completed job untouched');

  await restoreBackup(serialized, databaseName);
  const firstRead = await readLocalSnapshot(databaseName);
  assert(firstRead.recordings.length === 2 && firstRead.courses.length === 1, 'first restore uses real IndexedDB');
  assert(JSON.stringify([...new Uint8Array(await firstRead.recordings[0].audioBlob!.arrayBuffer())]) === JSON.stringify([...bytes]), 'Blob persisted through IndexedDB');
  await restoreBackup(serialized, databaseName);
  const merged = await readLocalSnapshot(databaseName);
  assert(merged.recordings.length === 4 && merged.courses.length === 2, 'colliding IDs clone instead of overwriting');
  const original = merged.recordings.find((item) => item.id === 'audio-a')!;
  assert(original.title === recording.title && original.courseId === 'math', 'existing data preserved');
  const clones = merged.recordings.filter((item) => !['audio-a', 'audio-b'].includes(item.id));
  assert(clones[0].courseId !== 'math' && clones[0].courseId === clones[1].courseId, 'cloned course references remapped');
  assert(clones[0].batchId === clones[1].batchId && clones[0].batchId !== original.batchId, 'restored class batches isolated and grouped');
  const clonedA = clones.find((item) => item.title === '中文课')!;
  const clonedB = clones.find((item) => item.title === '第二段')!;
  assert((clonedA.classBrief!.sections.assignments[0] as unknown as {sourceRecordingId: string}).sourceRecordingId === clonedB.id, 'cross-recording brief citation remapped');
  assert((clonedA.keyMessages[0] as unknown as {sourceRecordingId: string}).sourceRecordingId === clonedB.id, 'cross-recording key message citation remapped');

  const damaged = JSON.parse(await serialized.text());
  damaged.recordings[0].audio.base64 = btoa('damaged audio');
  await rejection(() => restoreBackup(new Blob([JSON.stringify(damaged)]), databaseName), 'corrupt audio rejected before write');
  const malformed = JSON.parse(await serialized.text());
  malformed.recordings[1].metadata.segments[0].startMs = -3;
  await rejection(() => restoreBackup(new Blob([JSON.stringify(malformed)]), databaseName), 'invalid nested metadata rejected before write');
  const duplicated = JSON.parse(await serialized.text());
  duplicated.recordings.push(duplicated.recordings[0]);
  await rejection(() => restoreBackup(new Blob([JSON.stringify(duplicated)]), databaseName), 'duplicate IDs rejected before write');
  const secret = JSON.parse(await serialized.text());
  secret.settings.apiKey = 'test-only-not-a-credential';
  await rejection(() => restoreBackup(new Blob([JSON.stringify(secret)]), databaseName), 'credentials not imported');
  await rejection(() => restoreBackup(new Blob(['{"truncated"']), databaseName), 'truncated JSON rejected');
  const afterErrors = await readLocalSnapshot(databaseName);
  assert(afterErrors.recordings.length === 4 && afterErrors.courses.length === 2, 'failed restore leaves existing data intact');

  result.dataset.status = 'pass';
  result.textContent = `${results.join('\n')}\n\nALL ${results.length} CHECKS PASSED\nIsolated database: ${databaseName}`;
} catch (error) {
  result.dataset.status = 'fail';
  result.textContent = `${results.join('\n')}\nFAIL ${error instanceof Error ? error.stack : error}`;
} finally {
  // Delete only this randomly named test database, never the production database.
  indexedDB.deleteDatabase(databaseName);
}
