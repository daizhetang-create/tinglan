import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

function clients(location) {
  const cache = new Map(); let fetchCalls = 0;
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { exports, window: { location }, Blob, AbortSignal, AbortController,
      fetch() { fetchCalls++; return Promise.reject(new Error('test transport reached')); },
      require(specifier) { return load(resolve(dirname(file), specifier + '.ts')); },
    });
    return exports;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/features');
  return { codex: load(resolve(root, 'assistant/codex.ts')), study: load(resolve(root, 'study/client.ts')),
    vault: load(resolve(root, 'study/vault.ts')), asr: load(resolve(root, 'workflow/nativeTranscribe.ts')), count: () => fetchCalls };
}
async function postEntries(c, expected) {
  const recording = { audioBlob: new Blob(['synthetic']), sourceLanguage: 'en-US' };
  for (const run of [() => c.codex.startCodexLogin(), () => c.codex.generateCodexNotes([]),
    () => c.study.studyRequest('image', { dataUrl: 'synthetic-private-data' }), () => c.study.studyRequest('analyze', {}),
    () => c.vault.syncVault(recording.audioBlob, 'test.wav', [], {}), () => c.asr.nativeTranscribe(recording, () => {})]) {
    await assert.rejects(run(), expected);
  }
}
test('hosted and deceptive origins reject every sensitive POST before fetch', async () => {
  for (const location of [
    { protocol: 'https:', hostname: 'example.com' }, { protocol: 'http:', hostname: 'localhost.evil.example' },
    { protocol: 'http:', hostname: '127.0.0.1.evil.example' }, { protocol: 'file:', hostname: '' },
    { protocol: 'https:', hostname: 'localhost' },
  ]) {
    const c = clients(location);
    await postEntries(c, /本机完整版/);
    assert.equal((await c.codex.getCodexStatus()).connected, false);
    assert.equal((await c.vault.getVaultStatus()).configured, false);
    assert.equal((await c.asr.nativeTranscriptionStatus()).available, false);
    assert.equal(c.count(), 0);
  }
});
test('exact HTTP loopback hosts still reach same-origin transport', async () => {
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const c = clients({ protocol: 'http:', hostname });
    await postEntries(c, /test transport reached/);
    assert.equal(c.count(), 6);
  }
});
