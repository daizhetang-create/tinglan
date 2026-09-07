// Controller-only tests intentionally stall a fake Worker. Real inference is
// verified separately by live-smoke.html; these tests do NOT count as ASR proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

function loadClass(relativePath, exportName) {
  let source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  source = source.replace(/import captureModuleUrl from [^;]+;/, "const captureModuleUrl = 'pcm.js';")
    .replace(/new URL\([^,]+, import\.meta\.url\)/g, "'test-worker.js'");
  const workers = [];
  class StalledWorker {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  const exports = {};
  const context = vm.createContext({ exports, Worker: StalledWorker, crypto: webcrypto, setTimeout, clearTimeout, console });
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(compiled, context);
  return { Class: exports[exportName], workers };
}

test('live queue rejects overload while preserving elapsed time and bounded memory', async () => {
  const { Class: LiveTranscriber, workers } = loadClass('../../src/features/recorder/liveTranscriber.ts', 'LiveTranscriber');
  const errors = [];
  const live = new LiveTranscriber({ sourceLanguage: 'en-US', model: 'tiny', onSegments() {}, onProgress() {}, onError(message) { errors.push(message); } });
  // Exercise the PCM/controller boundary only; no fake transcript is returned.
  for (let i = 0; i < 8; i++) live.acceptSamples(new Float32Array(48_000 * 12).fill(0.1));
  assert.equal(live.stats.queuedChunks, 3);
  assert.equal(live.stats.peakQueuedChunks, 3);
  assert.equal(live.stats.skippedChunks, 4);
  assert.equal(live.stats.capturedMs, 96_000);
  assert.equal(live.stats.bufferedMs, 0);
  assert.equal(errors.length, 4);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 1);
  live.dispose();
  await live.stop();
  assert.equal(workers[0].terminated, true);
  assert.equal(live.stats.queuedChunks, 0);
});

test('silence advances the clock without starting Whisper or inventing a transcript', () => {
  const { Class: LiveTranscriber, workers } = loadClass('../../src/features/recorder/liveTranscriber.ts', 'LiveTranscriber');
  const live = new LiveTranscriber({ sourceLanguage: 'zh-CN', model: 'tiny', onSegments() { assert.fail('No silence transcript'); }, onProgress() {}, onError() { assert.fail('Silence is not an error'); } });
  live.acceptSamples(new Float32Array(48_000 * 12));
  assert.equal(live.stats.capturedMs, 12_000);
  assert.equal(workers.length, 0);
  assert.equal(live.stats.queuedChunks, 0);
  live.dispose();
});

test('translation queue bounds backlog and disposal cannot spawn replacement workers', async () => {
  const { Class: TranslationService, workers } = loadClass('../../src/lib/translation.ts', 'TranslationService');
  const service = new TranslationService('local', () => {});
  const pending = Array.from({ length: 24 }, () => service.translate('Test source sentence.'));
  const settled = Promise.allSettled(pending);
  await assert.rejects(service.translate('Overflow'), /队列暂时繁忙/);
  // The first queued request has started by this microtask boundary.
  assert.equal(workers.length, 1);
  service.dispose();
  const results = await settled;
  assert.equal(results.filter((result) => result.status === 'rejected').length, 24);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, true);
  await assert.rejects(service.translate('After disposal'), /已关闭/);
});
