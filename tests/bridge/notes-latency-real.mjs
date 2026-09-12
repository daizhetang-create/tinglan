import { NotesService, CodexRpc } from '../../server/codex.mjs';
import assert from 'node:assert/strict';

// Diagnostic only: the requested model is not persisted in app/account settings.
const requestedModel = process.argv[2] || 'gpt-5.6-luna';
assert(['gpt-5.6-luna', 'gpt-5.3-codex-spark'].includes(requestedModel));
const provider = process.argv[3];
assert(!provider || provider === 'openai');
const rpc = new CodexRpc();
const request = rpc.request.bind(rpc);
rpc.request = async (method, params, timeout) => {
  if (method === 'thread/start' || method === 'turn/start') params = { ...params, model: requestedModel };
  if (method === 'thread/start' && provider) params = { ...params, modelProvider: provider };
  const started = performance.now();
  try {
    const result = await request(method, params, timeout);
    if (method === 'thread/start') console.log(JSON.stringify({ actualModel: result.model, modelProvider: result.modelProvider, reasoningEffort: result.reasoningEffort }));
    return result;
  }
  finally { console.log(JSON.stringify({ stage: method, ms: Math.round(performance.now()-started) })); }
};
const service = new NotesService(rpc);
const body = { recordings: [{ id: 'synthetic', segments: [
  { id: 'one', startMs: 0, source: 'The important distinction is that correlation does not prove causation. Two variables can move together because a third variable influences both.' },
  { id: 'two', startMs: 10000, source: 'Submit a 500-word report by next Friday at 5 pm. The final exam is on October 20 at 9 am.' },
] }] };
let firstDeltaMs, count = 0;
const started = performance.now();
try {
  const notes = await service.generate(body, e => { if (e.type === 'delta') { count++; firstDeltaMs ??= Math.round(performance.now()-started); } });
  assert(notes.items.some(i => i.category === 'assignment'));
  assert(notes.items.some(i => i.category === 'exam'));
  console.log(JSON.stringify({ requestedModel, elapsedMs: Math.round(performance.now()-started), firstDeltaMs, count, overview: notes.overview, items: notes.items }));
} finally { service.close(); }
