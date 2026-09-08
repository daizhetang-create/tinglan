import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceFingerprint, localCommit, artifactManifest, validArtifacts } from '../../scripts/release-info.mjs';
import { resolveCodexCommand } from '../../server/codex-command.mjs';

test('ZIP source has deterministic fingerprints without git; source and assets detect corruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'tinglan-portable-test-'));
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'src/app.ts'), 'source'); writeFileSync(join(root, 'package.json'), '{}');
    assert.equal(localCommit(root), null);
    const before = sourceFingerprint(root); assert.equal(sourceFingerprint(root), before);
    writeFileSync(join(root, 'dist/index.html'), 'index'); writeFileSync(join(root, 'dist/model.wasm'), 'wasm');
    assert.equal(sourceFingerprint(root), before, 'build outputs cannot invalidate source hash');
    const release = { assets: artifactManifest(join(root, 'dist')) };
    assert.equal(validArtifacts(join(root, 'dist'), release), true);
    writeFileSync(join(root, 'dist/model.wasm'), 'corrupt');
    assert.equal(validArtifacts(join(root, 'dist'), release), false);
    writeFileSync(join(root, 'src/app.ts'), 'new source'); assert.notEqual(sourceFingerprint(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows Codex resolution uses native exe or official npm JS, never arbitrary cmd text', () => {
  const root = mkdtempSync(join(tmpdir(), 'tinglan-codex-command-test-'));
  try {
    writeFileSync(join(root, 'codex.cmd'), '@echo malicious text must not be executed');
    assert.throws(() => resolveCodexCommand({ platform: 'win32', env: { PATH: root } }));
    const pkg = join(root, 'node_modules/@openai/codex'); mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
    writeFileSync(join(pkg, 'bin/codex.js'), '// fixture: never executed');
    assert.deepEqual(resolveCodexCommand({ platform: 'win32', node: 'node-path', env: { PATH: root } }), { command: 'node-path', argsPrefix: [join(pkg, 'bin/codex.js')], kind: 'official-npm' });
    writeFileSync(join(root, 'codex.exe'), 'fixture');
    assert.equal(resolveCodexCommand({ platform: 'win32', env: { PATH: root } }).kind, 'native');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: '../outside.js' } }));
    assert.throws(() => resolveCodexCommand({ platform: 'win32', env: { TINGLAN_CODEX_BIN: join(root, 'codex.cmd') } }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
