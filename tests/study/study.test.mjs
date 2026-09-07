import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSources, validateStudy, extractImage } from '../../server/study.mjs';
const source = { id: 'm:test:block-1', title: 'Synthetic assignment', text: 'Academic English. Submit a 500-word report by next Friday at 5 pm. Use three academic sources.' };
const input = normalizeSources({ query: '作业是什么？', courses: ['Academic English'], sources: [source] });
const result = { category: 'assignment', courseName: 'Academic English', claims: [{ category: 'assignment', text: '提交 500 词报告，引用三份学术来源。', due: 'next Friday at 5 pm', evidence: [{ sourceId: source.id, quote: source.text }] }], notFound: [] };
test('study source validation rejects empty, duplicate, oversized and malformed data', () => {
  for (const body of [{}, { query: '', sources: [] }, { query: '', sources: [source, source] }, { query: 'a'.repeat(4001), sources: [source] }, { query: '', sources: [{ ...source, text: '' }] }]) assert.throws(() => normalizeSources(body));
});
test('cited study result retains literal relative deadline, quote and model', () => {
  const value = validateStudy(JSON.stringify(result), input, 'test-thread');
  assert.equal(value.claims[0].due, 'next Friday at 5 pm');
  assert.equal(value.claims[0].evidence[0].quote, source.text);
  assert.equal(value.model, 'gpt-5.6-luna');
});
test('invented sources, paraphrased evidence and invented deadline fail closed', () => {
  for (const claim of [
    { ...result.claims[0], evidence: [{ sourceId: 'missing', quote: source.text }] },
    { ...result.claims[0], evidence: [{ sourceId: source.id, quote: 'Submit a 500-character essay.' }] },
    { ...result.claims[0], due: '2026-09-18' },
    { ...result.claims[0], evidence: [] },
  ]) assert.throws(() => validateStudy(JSON.stringify({ ...result, claims: [claim] }), input), /证据/);
  assert.throws(() => validateStudy(JSON.stringify({ ...result, courseName: 'Physics' }), input));
});
test('image endpoint never fetches remote URLs, SVGs or mislabeled bytes', () => {
  const service = { runStructured: () => assert.fail('invalid image reached Codex') };
  for (const dataUrl of ['https://example.com/image.png', 'file:///private', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AAAA']) assert.throws(() => extractImage(service, { dataUrl }));
});

test('unsupported absence statements are uncertainty, not cited requirements', () => {
  for (const text of ['录音未提及字数或字数单位。', '录音没有说明提交方式。']) {
    const value = validateStudy(JSON.stringify({ ...result, claims: [{ ...result.claims[0], category: 'requirement', text, due: null }] }), input, 'test-thread');
    assert.equal(value.claims.length, 0);
    assert.ok(value.notFound.includes(text));
  }
});
