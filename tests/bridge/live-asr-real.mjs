import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AsrService } from '../../server/asr.mjs';
import { createBridge } from '../../server/index.mjs';

// Only repository-owned synthetic audio, never the user's private recordings.
const asr = new AsrService();
const bridge = createBridge({ port: 14323, allowedPorts: [14323], asr, service: { close() {} } });
await bridge.listen();
const headers = { Origin: 'http://127.0.0.1:14323', 'X-Tinglan-Client': '1', 'Content-Type': 'application/octet-stream' };
const base = 'http://127.0.0.1:14323';
try {
  const began = performance.now();
  const warm = await fetch(base + '/api/asr/warmup', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(warm.status, 200); assert.equal((await warm.json()).available, true);
  console.log(JSON.stringify({ stage: 'cold-model-warmup', ms: Math.round(performance.now()-began) }));
  for (const [language, name] of [['en', 'english'], ['zh', 'mandarin']]) {
    const file = new URL(`../runtime/fixtures/${name}-classroom.wav`, import.meta.url);
    const decoded = spawnSync(asr.python, ['-X', 'utf8', '-c', 'import sys; from faster_whisper.audio import decode_audio; sys.stdout.buffer.write(decode_audio(sys.argv[1], sampling_rate=16000).astype("<f4").tobytes())', decodeURIComponent(file.pathname.replace(/^\/([A-Za-z]:)/, '$1'))], { windowsHide: true, maxBuffer: 20*1024*1024 });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    const pcm = decoded.stdout; let texts = [], timings = [];
    for (let offset = 0; offset < pcm.length; offset += 6*16000*4) {
      const chunk = pcm.subarray(offset, offset + 6*16000*4); if (chunk.length < 1600) continue;
      const started = performance.now();
      const response = await fetch(base + '/api/asr/live?language=' + language, { method: 'POST', headers, body: chunk });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.quality.rejectedSegments, 0);
      assert(result.chunks.every(c => c.timestamp[0] >= 0 && c.timestamp[1] <= chunk.length/64000));
      texts.push(result.text); timings.push(Math.round(performance.now()-started));
    }
    const text = texts.join(' ');
    assert(language === 'en' ? /chapter\s*(three|3)/i.test(text) && /Friday/i.test(text) : /工作記憶|工作记忆/.test(text), text);
    console.log(JSON.stringify({ stage: 'real-live', language, audioSeconds: pcm.length/64000, requestMs: timings, text }));
  }
  const silence = await fetch(base + '/api/asr/live?language=zh', { method: 'POST', headers, body: Buffer.alloc(6*16000*4) });
  const silent = await silence.json(); assert.equal(silent.text, ''); assert.equal(silent.chunks.length, 0);
  console.log('REAL_LIVE_ASR_AND_SILENCE_PASS');
} finally { bridge.close(); }
