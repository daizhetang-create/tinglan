import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = mkdtempSync(join(root, '.runtime/portable-'));
for (const path of ['src', 'public', 'server', 'scripts', 'dist', 'package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', '启动听澜.cmd', '配置本机转写.cmd']) cpSync(join(root, path), join(fixture, path), { recursive: true });
const env = { ...process.env, PATH: dirname(process.execPath), TINGLAN_WEB_PORT: '4550', TINGLAN_BRIDGE_PORT: '4551', TINGLAN_LIBRARY_ROOT: join(fixture, 'isolated-vault') };
delete env.TINGLAN_CODEX_BIN;
function run(args, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: fixture, env: { ...env, ...overrides }, shell: false, windowsHide: true });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
}
let ownedHealth;
try {
  const stamp = await run(['scripts/stamp-build.mjs']); if (stamp.code) throw new Error(stamp.output);
  const release = JSON.parse(readFileSync(join(fixture, 'dist/release.json'), 'utf8'));
  if (release.commit !== null) throw new Error('ZIP borrowed unrelated parent Git HEAD');
  const first = await run(['scripts/start.mjs', '--no-open']); if (first.code) throw new Error(first.output);
  ownedHealth = await (await fetch('http://127.0.0.1:4550/__health')).json();
  if (ownedHealth.root !== fixture || ownedHealth.sourceFingerprint !== release.sourceFingerprint || !ownedHealth.pid) throw new Error('Wrong runtime');
  const second = await run(['scripts/start.mjs', '--no-open']); if (second.code) throw new Error(second.output);
  const reused = await (await fetch('http://127.0.0.1:4550/__health')).json();
  if (reused.pid !== ownedHealth.pid) throw new Error('Duplicate service started');
  const mismatch = await run(['scripts/start.mjs', '--no-open'], { TINGLAN_BRIDGE_PORT: '4552' });
  if (!mismatch.code) throw new Error('Mismatched configuration reused');
  const page = await fetch('http://127.0.0.1:4550/'); if (!page.ok) throw new Error('Website not ready');
  console.log(JSON.stringify({ prebuiltZipWithoutGitNpmModulesOrPwsh: true, unrelatedParentGitIgnored: true, reusableSamePid: true, bridgePortMismatchRejected: true, websiteStatus: page.status, fixture }, null, 2));
} finally {
  // This synthetic fixture's service only. Never stop the formal 4318 service.
  if (ownedHealth?.root === fixture && ownedHealth.webPort === 4550 && Number.isInteger(ownedHealth.pid)) process.kill(ownedHealth.pid);
}
