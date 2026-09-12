import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInput, validateNotes } from '../../server/codex.mjs';

const source = 'Submit a 500-word report on chapter three by next Friday at 5 pm.';
const input = { recordings: [{ id: 'r', segments: [{ id: 's', source, startMs: 1200 }] }] };
const makeNotes = () => ({ overview: '本节布置了第三章报告，需要注意字数和截止时间。', answer: '', items: [{ category: 'assignment', text: '完成第三章 500 词报告，下周五下午五点前提交。', evidenceQuote: source, sourceRecordingId: 'r', sourceSegmentId: 's', due: 'next Friday at 5 pm' }] });
const validate = value => validateNotes(JSON.stringify(value), normalizeInput(input).sources, 't');
test('runaway transcript is not submitted as facts; normal emphasis allowed', () => {
  assert.throws(() => normalizeInput({ recordings: [{ id: 'r', segments: [{ id: 's', startMs: 0, source: '们'.repeat(500) }] }] }), e => e.code === 'TRANSCRIPT_QUALITY');
  assert.doesNotThrow(() => normalizeInput({ recordings: [{ id: 'r', segments: [{ id: 's', startMs: 0, source: '不不不，不是这个意思。' }] }] }));
});
test('summary keeps verified evidence, timestamp and literal deadline', () => {
  const result = validate(makeNotes()); assert.equal(result.items[0].atMs, 1200); assert.equal(result.items[0].evidenceQuote, source);
});
test('fabricated evidence and calendar normalization rejected', () => {
  const value = makeNotes(); value.items[0].evidenceQuote = 'There will be a test on Sunday.';
  assert.throws(() => validate(value), e => e.code === 'INVALID_EVIDENCE');
  value.items[0].evidenceQuote = source; value.items[0].due = '2026-09-18';
  assert.throws(() => validate(value), e => e.code === 'INVALID_DEADLINE');
});
test('duplicate concepts collapse; unabridged repetitive prose is not a summary', () => {
  const value = makeNotes(); value.items.push({ ...value.items[0] }); assert.equal(validate(value).items.length, 1);
  value.items[0].text = '这是未经提炼的原话。'.repeat(100);
  assert.throws(() => validate(value), e => e.code === 'LOW_QUALITY_NOTES');
});
