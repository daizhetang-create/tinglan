import { openDatabase } from '../../src/lib/db';
import { serializeBackup, parseBackup, readLocalSnapshot, restoreBackup } from '../../src/features/storage/backup';
import { hashBlob, buildSources, retrieveSources } from '../../src/features/study/client';
import { materialSourceId, type StudyMaterial } from '../../src/features/study/types';
import { DEFAULT_SETTINGS, type RecordingSession } from '../../src/types';
const output = document.querySelector('#result')!;
const results: string[] = [];
const assert = (ok: unknown, text: string) => { if (!ok) throw new Error(text); results.push(`PASS ${text}`); output.textContent = results.join('\n'); };
const dbName = `tinglan-study-synthetic-${crypto.randomUUID()}`;
const at = '2026-09-07T12:00:00.000Z';
const course = { id: 'test-english', name: 'Academic English', term: '2026', color: '#333333', createdAt: at, updatedAt: at };
const recordings: RecordingSession[] = Array.from({ length: 27 }, (_, i) => ({
  id: `recording-${i}`, title: `Synthetic lecture ${i}`, createdAt: at, updatedAt: at, durationMs: 3000,
  status: 'complete', analysisStatus: 'idle', recordingMode: 'en-zh', sourceLanguage: 'en-US', targetLanguage: 'zh-CN', courseId: course.id,
  segments: [{ id: 's1', startMs: 0, endMs: 3000, speaker: 'Teacher', source: `Lecture ${i}. Submit a report by next Friday.`, translation: '下周五提交报告。' }],
  notes: [], bookmarks: [], keyMessages: [], audioBlob: new Blob([`synthetic-audio-${i}`], { type: 'audio/wav' }),
}));
try {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore('recordings', { keyPath: 'id' }); store.createIndex('createdAt', 'createdAt'); store.createIndex('courseId', 'courseId'); store.createIndex('courseUpdatedAt', ['courseId', 'updatedAt']);
      const cs = db.createObjectStore('courses', { keyPath: 'id' }); cs.createIndex('name', 'name'); cs.createIndex('updatedAt', 'updatedAt'); cs.put(course);
      db.createObjectStore('settings', { keyPath: 'key' }).put({ key: 'app', value: DEFAULT_SETTINGS });
      recordings.forEach(r => store.put(r));
    };
    req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = () => reject(req.error);
  });
  const migrated = await readLocalSnapshot(dbName);
  assert(migrated.recordings.length === 27, 'v2 → v3 keeps all 27 synthetic recordings');
  assert(migrated.courses.length === 1 && migrated.courses[0].updatedAt === at, 'migration does not rewrite existing course metadata');
  for (const original of recordings) {
    const recovered = migrated.recordings.find(r => r.id === original.id)!;
    assert(await hashBlob(recovered.audioBlob!) === await hashBlob(original.audioBlob!) && JSON.stringify(recovered.segments) === JSON.stringify(original.segments), `${original.id}: original Blob hash and transcript unchanged`);
  }
  const fixture = await fetch('./assignment-fixture.png').then(r => r.blob());
  const text = 'Submit a 500-word report by next Friday at 5 pm.';
  const material: StudyMaterial = { id: 'material-test', title: 'Synthetic assignment', fileName: 'assignment-fixture.png', mimeType: 'image/png', sha256: await hashBlob(fixture), originalBlob: fixture, createdAt: at, updatedAt: at, courseId: course.id, category: 'assignment', state: 'ready', blocks: [{ id: 'b1', text, uncertain: false }], warnings: [], analysis: { category: 'assignment', courseName: course.name, model: 'synthetic-test-only', generatedAt: at, notFound: [], claims: [{ id: 'c1', category: 'assignment', text: '提交 500 词报告。', due: 'next Friday at 5 pm', evidence: [{ sourceId: materialSourceId('material-test', 'b1'), quote: text }] }] } };
  const db = await openDatabase(dbName);
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('materials', 'readwrite'); tx.objectStore('materials').put(material); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  const backup = await serializeBackup(await readLocalSnapshot(dbName));
  const parsed = await parseBackup(backup);
  assert(parsed.materials?.length === 1 && await hashBlob(parsed.materials[0].originalBlob) === material.sha256, 'image bytes and MIME survive backup serialization');
  await restoreBackup(backup, dbName);
  const restored = await readLocalSnapshot(dbName);
  assert(restored.recordings.length === 54 && restored.materials?.length === 2, 'collision restore appends instead of overwriting all sources');
  const clone = restored.materials!.find(m => m.id !== material.id)!;
  assert(clone.analysis!.claims[0].evidence[0].sourceId === materialSourceId(clone.id, 'b1'), 'restored image citation remapped to cloned material ID');
  assert(clone.courseId !== course.id && restored.courses.some(c => c.id === clone.courseId), 'restored material points to restored course');
  const raw = JSON.parse(await backup.text()); raw.materials[0].metadata.analysis.claims[0].evidence[0].quote = 'Invented quote';
  let rejected = false; try { await restoreBackup(new Blob([JSON.stringify(raw)]), dbName); } catch { rejected = true; }
  assert(rejected && (await readLocalSnapshot(dbName)).materials?.length === 2, 'invalid citation fails before any database write');
  const malicious = JSON.parse(await backup.text()); malicious.materials[0].original.type = 'text/html';
  let mimeRejected = false; try { await restoreBackup(new Blob([JSON.stringify(malicious)]), dbName); } catch { mimeRejected = true; }
  assert(mimeRejected && (await readLocalSnapshot(dbName)).materials?.length === 2, 'HTML Blob masquerading as image rejected before any database write');
  const legacy = JSON.parse(await backup.text()); legacy.version = 1; legacy.databaseVersion = 2; delete legacy.materials;
  assert((await parseBackup(new Blob([JSON.stringify(legacy)]))).recordings.length === 27, 'legacy v1/databaseVersion 2 backup still parses');
  const sources = buildSources(recordings, [material]);
  assert(retrieveSources(sources, '作业截止时间').covered === 28, 'cross-material and recording retrieval includes all in-budget sources');
  const many = Array.from({ length: 900 }, (_, i) => ({ ...sources[0], id: `test-${i}`, text: `source ${i}` }));
  const selected = retrieveSources(many, 'source');
  assert(selected.total === 900 && selected.covered === 780, 'limited retrieval reports the actual coverage instead of claiming full-library completeness');
  output.textContent = `ALL ${results.length} CHECKS PASSED\n` + results.join('\n');
} catch (error) { output.textContent = `FAILED: ${error instanceof Error ? error.stack : error}\n` + results.join('\n'); }
