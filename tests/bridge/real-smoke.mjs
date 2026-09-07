import { NotesService } from '../../server/codex.mjs';
const service = new NotesService();
const body = { recordings: [{ id: 'public-smoke', title: 'Synthetic classroom test (no user data)', createdAt: '2026-09-07T08:00:00Z', segments: [
  { id: 'concept', startMs: 1000, source: 'Working memory is the central concept today.' },
  { id: 'assignment', startMs: 12000, source: 'Submit a 500-word report on chapter three by next Friday at 5 pm.' },
  { id: 'exam', startMs: 25000, source: 'The final exam is on October 20 at 9 am. Bring your student ID.' },
]}] };
try {
  const status = await service.status(); console.log(JSON.stringify({ check: 'status', ...status }));
  const begin = Date.now(); let deltas = 0;
  const notes = await service.generate(body, event => { if (event.type === 'delta') deltas++; });
  if (!notes.items.some(i => i.category === 'assignment') || !notes.items.some(i => i.category === 'exam')) throw new Error('Missing required assignment/exam categories');
  console.log(JSON.stringify({ check: 'real-notes', elapsedMs: Date.now() - begin, deltas, notes }));
  const answer = await service.generate({ ...body, prompt: '报告的提交时间是什么？课堂有没有说补考日期？' }, () => {});
  if (!answer.answer || !answer.items.length) throw new Error('Missing cited question answer');
  console.log(JSON.stringify({ check: 'real-question', notes: answer }));
} finally { service.close(); }
