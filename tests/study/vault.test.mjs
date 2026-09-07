import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { VaultService } from '../../server/vault.mjs';

test('early Python exit with a large stdin payload is an ordinary error, not a bridge crash', async () => {
  const service = new VaultService();
  await assert.rejects(service.run('-c', ['pass'], { synthetic: 'x'.repeat(1000000) }), /归档|资料库/);
  assert.ok(true, 'Node process is still alive');
});

test('real isolated vault intake, verified note append, dedupe and human edits preservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinglan-vault-test-'));
  const service = new VaultService({ root });
  if (!(await service.status()).configured) throw new Error('Daily library runtime missing; integration is not verified');
  const text = 'Synthetic test only. Submit a 500-word report by next Friday at 5 pm.';
  const sources = [{ id: 'synthetic:s1', title: 'Synthetic report', text }];
  const analysis = { category: 'assignment', courseName: null, claims: [{ category: 'assignment', text: '合成测试：提交 500 词报告。', due: 'next Friday at 5 pm', evidence: [{ sourceId: sources[0].id, quote: text }] }], notFound: [] };
  const upload = async () => { const req = Readable.from([Buffer.from(text)]); req.headers = { 'x-tinglan-filename': encodeURIComponent('synthetic-study.txt') }; return service.upload(req); };
  const receipt = await upload();
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  const notePath = join(root, receipt.note);
  const originalNote = await readFile(notePath, 'utf8');
  assert.ok(originalNote.includes(receipt.sha256));
  const result = await service.finalize({ ticket: receipt.ticket, sha256: receipt.sha256, sources, analysis });
  assert.equal(result.state, 'ready');
  const first = await readFile(notePath, 'utf8');
  assert.ok(first.includes('TINGLAN_ANALYSIS_') && first.includes('500-word') && first.includes('next Friday at 5 pm'));
  assert.ok(first.includes('DAILY_LIBRARY_AI_SUMMARY_BEGIN') && first.includes('（尚未提炼）'), 'existing summary placeholder/content not replaced');
  await appendFile(notePath, '\n## Human note\nKeep this exact manual addition.\n');
  const duplicate = await upload();
  assert.equal(duplicate.sha256, receipt.sha256); assert.equal(duplicate.note, receipt.note);
  await service.finalize({ ticket: duplicate.ticket, sha256: duplicate.sha256, sources, analysis });
  const second = await readFile(notePath, 'utf8');
  assert.ok(second.endsWith('Keep this exact manual addition.\n'));
  assert.equal((second.match(/<!-- TINGLAN_ANALYSIS_/g) ?? []).length, 1, 'idempotent retry does not duplicate analysis');
  await assert.rejects(service.finalize({ ticket: 'forged', sha256: receipt.sha256, sources, analysis }), /凭据/);
  const third = await upload();
  await assert.rejects(service.finalize({ ticket: third.ticket, sha256: third.sha256, sources, analysis: { ...analysis, claims: [{ ...analysis.claims[0], due: '2026-10-01' }] } }), /证据/);
  assert.equal(await readFile(notePath, 'utf8'), second, 'invalid evidence leaves existing note untouched');
  console.log('Isolated synthetic vault only:', root);
});
