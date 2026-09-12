import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RetainedAsr } from '../../server/retained-asr.mjs';
import { AsrService } from '../../server/asr.mjs';
import { createBridge } from '../../server/index.mjs';

function fakeWorker() {
  let count = 0; const children = [];
  const spawnProcess = () => {
    count++;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
    child.stdin.on('data', data => {
      const req = JSON.parse(data.toString()); child.request = req;
      if (req.operation === 'hang') return;
      setImmediate(() => child.stdout.write(JSON.stringify({ id: req.id, type: 'result', text: 'hello', chunks: [] }) + '\n'));
    }); children.push(child); return child;
  };
  return { spawnProcess, children, get count() { return count; } };
}
test('native model process is reused between jobs, timeout and cancellation release ownership', async () => {
  const fake = fakeWorker(), worker = new RetainedAsr({ spawnProcess: fake.spawnProcess });
  try {
    await worker.request({ operation: 'live' }); await worker.request({ operation: 'live' });
    assert.equal(fake.count, 1); assert.equal(worker.warm, true);
    const controller = new AbortController(); const waiting = worker.request({ operation: 'hang' }, undefined, controller.signal);
    await assert.rejects(worker.request({ operation: 'live' }), e => e.code === 'ASR_BUSY');
    controller.abort(); await assert.rejects(waiting, e => e.code === 'CANCELLED');
    assert.equal(fake.children[0].killed, true);
    await worker.request({ operation: 'live' }); assert.equal(fake.count, 2);
    await assert.rejects(worker.request({ operation: 'hang' }, undefined, undefined, 20), e => e.code === 'ASR_TIMEOUT');
    assert.equal(worker.pending, null);
  } finally { worker.close(); }
});
test('late events from cancelled native process cannot complete replacement request', async () => {
  const fake = fakeWorker(), worker = new RetainedAsr({ spawnProcess: fake.spawnProcess });
  const controller = new AbortController();
  const first = worker.request({ operation: 'hang' }, undefined, controller.signal);
  const old = fake.children[0]; controller.abort(); await assert.rejects(first);
  const next = worker.request({ operation: 'hang' }, undefined, undefined, 50);
  old.stdout.write(JSON.stringify({ type: 'result', id: fake.children[1].request.id }) + '\n');
  await assert.rejects(next, e => e.code === 'ASR_TIMEOUT'); worker.close();
});
test('live HTTP validates origin, language, size, PCM; no arbitrary worker commands accepted', async () => {
  const asr = new AsrService(); let calls = 0;
  asr.liveWorker.request = async body => { calls++; assert.equal(body.operation, 'live'); assert(!body.path); return { text: 'test', chunks: [] }; };
  const bridge = createBridge({ port: 14321, allowedPorts: [14321], asr, service: { close() {} } });
  await bridge.listen();
  const headers = { Origin: 'http://127.0.0.1:14321', 'Content-Type': 'application/octet-stream', 'X-Tinglan-Client': '1' };
  const url = 'http://127.0.0.1:14321/api/asr/live?language=en';
  const send = (body, changes = {}, address = url) => fetch(address, { method: 'POST', headers: { ...headers, ...changes }, body });
  try {
    assert.equal((await send(Buffer.alloc(1600), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await send(Buffer.alloc(1600), {}, url.replace('en', 'xx'))).status, 400);
    assert.equal((await send(Buffer.alloc(1599))).status, 400);
    assert.equal((await send(Buffer.alloc(768004))).status, 413);
    const invalid = Buffer.alloc(1600); invalid.writeFloatLE(NaN); assert.equal((await send(invalid)).status, 400);
    invalid.writeFloatLE(2); assert.equal((await send(invalid)).status, 400);
    assert.equal((await send(Buffer.alloc(1600))).status, 200); assert.equal(calls, 1);
  } finally { bridge.close(); }
});
