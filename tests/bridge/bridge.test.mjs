import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { createBridge } from '../../server/index.mjs';
import { normalizeInput, validateNotes, publicError, NotesService } from '../../server/codex.mjs';

export const fixture = { recordings: [{ id: 'test-class', title: 'Synthetic classroom fixture', createdAt: '2026-09-07T08:00:00Z', segments: [
  { id: 'segment-1', startMs: 1000, source: 'Working memory is the central concept today.' },
  { id: 'segment-2', startMs: 12000, source: 'Submit a 500-word report on chapter three by next Friday at 5 pm.' },
  { id: 'segment-3', startMs: 25000, source: 'The final exam is on October 20 at 9 am. Bring your student ID.' },
] }] };
test('input refuses empty transcript, duplicate citation, invalid timestamp and oversized question', () => {
  assert.throws(() => normalizeInput({ recordings: [{ id: 'x', segments: [] }] }), /文字/);
  assert.throws(() => normalizeInput({ ...fixture, prompt: 'x'.repeat(4001) }), /4000/);
  assert.throws(() => normalizeInput({ recordings: [{ id: 'x', segments: [{ id: 's', source: 'a', startMs: -1 }] }] }), /时间戳/);
  assert.throws(() => normalizeInput({ recordings: [{ id: 'x', segments: [{ id: 's', source: 'a', startMs: 0 }, { id: 's', source: 'a', startMs: 0 }] }] }), /重复/);
});

class FakeRpc extends EventEmitter {
  constructor(mode) { super(); this.mode = mode; this.calls = []; this.cwd = 'test-only'; }
  async start() {}
  async request(method) {
    this.calls.push(method);
    if (method === 'account/read') return { account: this.mode === 'logged-out' ? null : { type: 'chatgpt', planType: 'pro' } };
    if (method === 'account/rateLimits/read') return {};
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') { setImmediate(() => {
      if (this.mode === 'death') this.emit('disconnected');
      if (this.mode === 'tool') this.emit('notification', { method: 'item/started', params: { threadId: 'thread', item: { type: 'commandExecution' } } });
      this.emit('started');
    }); return { turn: { id: 'turn' } }; }
    return {};
  }
  close() {}
}
test('subscription login required; no API key fallback or turn is started', async () => {
  const rpc = new FakeRpc('logged-out'), service = new NotesService(rpc);
  await assert.rejects(service.generate(fixture, () => {}), error => error.code === 'LOGIN_REQUIRED');
  assert.equal(rpc.calls.includes('turn/start'), false); assert.equal(service.active, 0);
});
test('cancel, runtime restart, and forbidden tools fail closed and release job slot', async () => {
  for (const [mode, code] of [['cancel', 'CANCELLED'], ['death', 'SERVER_RESTARTED'], ['tool', 'TOOL_BLOCKED']]) {
    const rpc = new FakeRpc(mode), service = new NotesService(rpc), controller = new AbortController();
    if (mode === 'cancel') rpc.once('started', () => controller.abort());
    await assert.rejects(service.generate(fixture, () => {}, controller.signal), error => error.code === code);
    assert.equal(service.active, 0); assert.ok(rpc.calls.includes('turn/interrupt'));
  }
});
test('concurrent jobs are bounded', async () => {
  const service = new NotesService(new FakeRpc('normal')); service.active = 2;
  await assert.rejects(service.generate(fixture, () => {}), error => error.code === 'BUSY');
});
test('output citation timestamps come from source, fabricated sources are rejected', () => {
  const { sources } = normalizeInput(fixture);
  const value = { overview: '测试', answer: '', items: [{ category: 'assignment', text: '报告', sourceRecordingId: 'test-class', sourceSegmentId: 'segment-2', atMs: 999999, due: 'next Friday at 5 pm' }] };
  assert.equal(validateNotes(JSON.stringify(value), sources, 'test-thread').items[0].atMs, 12000);
  value.items[0].sourceSegmentId = 'made-up'; assert.throws(() => validateNotes(JSON.stringify(value), sources, 'test-thread'), /引用/);
});
test('errors do not expose raw tokens or local paths', () => {
  assert.equal(publicError(new Error('secret C:/private/auth.json token=abc')).code, 'CODEX_ERROR');
  assert.equal(publicError(new Error('usage limit exceeded')).code, 'QUOTA');
  assert.equal(publicError(new Error('401 auth failed')).code, 'LOGIN_REQUIRED');
});
test('HTTP bridge rejects foreign hosts/origins and streams bounded cited responses', async () => {
  const bridge = createBridge({ port: 14319, allowedPorts: [14318], service: { status: async () => ({ connected: true, authenticated: true }), close() {}, generate: async (body, emit) => { normalizeInput(body); emit({ type: 'delta', text: 'test' }); return { overview: 'test', items: [] }; } } });
  await bridge.listen();
  try {
    const headers = { Origin: 'http://127.0.0.1:14318', 'Content-Type': 'application/json', 'X-Tinglan-Client': '1' };
    const url = 'http://127.0.0.1:14319/api/codex/notes';
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => { const req = request(url, { method: 'POST', headers: { ...headers, Host: 'evil.example:14319' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end('{}'); });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const success = await fetch(url, { method: 'POST', headers, body: JSON.stringify(fixture) }); const lines = (await success.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(x => x.type), ['status', 'delta', 'result']);
  } finally { bridge.close(); }
});
