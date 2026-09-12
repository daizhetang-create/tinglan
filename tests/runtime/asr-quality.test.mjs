import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadQuality() {
  const source = readFileSync(new URL('../../src/features/recorder/asrQuality.ts', import.meta.url), 'utf8');
  const exports = {};
  const context = vm.createContext({ exports, console });
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(compiled, context);
  return exports;
}

test('rejects the repetitive CJK hallucination shown by the app', () => {
  const { isDegenerateAsrText } = loadQuality();
  assert.equal(isDegenerateAsrText('们'.repeat(80)), true);
  assert.equal(isDegenerateAsrText('他们'.repeat(20)), true);
});

test('keeps legitimate short repetition and normal classroom text', () => {
  const { isDegenerateAsrText, sanitizeAsrResult } = loadQuality();
  assert.equal(isDegenerateAsrText('不不不'), false);
  assert.equal(isDegenerateAsrText('哈哈哈哈'), false);
  assert.equal(isDegenerateAsrText('今天我们讨论研究设计和证据。'), false);
  const result = sanitizeAsrResult({
    text: '今天我们讨论研究设计和证据。',
    chunks: [
      { text: '们'.repeat(20), timestamp: [0, 1] },
      { text: '今天我们讨论研究设计和证据。', timestamp: [1, 3] },
    ],
  });
  assert.equal(result.chunks.length, 1);
  assert.equal(result.quality?.rejectedSegments, 1);
});
