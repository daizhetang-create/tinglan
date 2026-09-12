import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadNative(fetcher) {
  const qualitySource = readFileSync(new URL('../../src/features/recorder/asrQuality.ts', import.meta.url), 'utf8');
  const qualityExports = {};
  const qualityContext = vm.createContext({ exports: qualityExports, console });
  vm.runInContext(ts.transpileModule(qualitySource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, qualityContext);
  const source = readFileSync(new URL('../../src/features/recorder/nativeLive.ts', import.meta.url), 'utf8');
  const exports = {};
  const context = vm.createContext({ exports, console, setTimeout, clearTimeout, AbortController, fetch: fetcher });
  context.require = (request) => request === './asrQuality' ? qualityExports : (() => { throw new Error(`Unexpected import ${request}`); });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return exports.NativeLiveClient;
}

function response(value, ok = true) {
  return { ok, headers: { get: () => 'application/json' }, async json() { return value; } };
}

test('native live client probes, warms and posts Float32 PCM', async () => {
  const calls = [];
  const Client = loadNative(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/asr/status') return response({ available: true, liveSupported: true });
    if (url === '/api/asr/warmup') return response({ liveSupported: true });
    return response({ type: 'result', text: '清晰字幕', chunks: [{ text: '清晰字幕', timestamp: [0, 1] }] });
  });
  const client = new Client();
  assert.equal(await client.prepare(), true);
  const result = await client.transcribe(new Float32Array([0.1, 0.2]), 'zh-CN');
  assert.equal(result.text, '清晰字幕');
  assert.deepEqual(calls.map((call) => call.url), ['/api/asr/status', '/api/asr/warmup', '/api/asr/live?language=zh']);
  assert.equal(calls[2].options.headers['X-Tinglan-Client'], '1');
  assert.equal(calls[2].options.body instanceof ArrayBuffer, true);
});

test('native client keeps legitimate repetition', async () => {
  const Client = loadNative(async (url) => url === '/api/asr/status'
    ? response({ available: true, liveSupported: true })
    : url === '/api/asr/warmup'
      ? response({ liveSupported: true })
      : response({ type: 'result', text: '不不不', chunks: [{ text: '不不不', timestamp: [0, 1] }] }));
  const client = new Client();
  assert.equal(await client.prepare(), true);
  const result = await client.transcribe(new Float32Array([0.1]), 'zh-CN');
  assert.equal(result.text, '不不不');
});
