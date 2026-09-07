// Opt-in real Codex test. Uses synthetic material only, never user classroom data.
import { NotesService } from '../../server/codex.mjs';
import { analyzeStudy, extractImage } from '../../server/study.mjs';
import { readFile } from 'node:fs/promises';
const service = new NotesService();
const run = service.runStructured.bind(service);
service.runStructured = (task, emit, signal) => run({ ...task, validate: (raw, threadId) => {
  try { return task.validate(raw, threadId); }
  catch (error) { console.log('SYNTHETIC INVALID RESULT', raw); throw error; }
} }, emit, signal);
try {
  const started = Date.now();
  const bytes = await readFile(new URL('./assignment-fixture.png', import.meta.url));
  const image = await extractImage(service, { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }, () => {});
  console.log('IMAGE', JSON.stringify(image), 'elapsedMs', Date.now() - started);
  const analysis = await analyzeStudy(service, { query: '整理作业、要求和考试日期。', courses: [], sources: image.blocks.map(b => ({ id: `m:fixture:${b.id}`, title: 'Synthetic assignment', text: b.text })) }, () => {});
  console.log('ANALYSIS', JSON.stringify(analysis), 'elapsedMs', Date.now() - started);
} finally { service.close(); }
