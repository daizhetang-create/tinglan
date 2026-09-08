import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sourceFingerprint, validArtifacts } from './release-info.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(readFileSync(join(root, 'dist/release.json'), 'utf8'));
if (release.sourceFingerprint !== sourceFingerprint(root) || !validArtifacts(join(root, 'dist'), release)) throw new Error('请先构建当前版本，再打包。');
mkdirSync(join(root, '.runtime'), { recursive: true });
const stage = mkdtempSync(join(root, '.runtime/release-'));
const product = join(stage, `Tinglan-${release.version}`);
mkdirSync(product);
const allowed = ['src', 'public', 'server', 'scripts', 'dist', 'docs', 'package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'README.md', 'NOTICE.md', '启动听澜.cmd', '配置本机转写.cmd'];
for (const path of allowed) {
  if (!existsSync(join(root, path))) throw new Error(`交付文件缺失：${path}`);
  cpSync(join(root, path), join(product, path), { recursive: true, filter(source) {
    if (lstatSync(source).isSymbolicLink()) throw new Error('交付包不允许链接文件');
    return !source.split(/[\\/]/).includes('__pycache__') && !source.endsWith('.pyc');
  } });
}
if (sourceFingerprint(product) !== release.sourceFingerprint) throw new Error('交付包源码不完整');
const files = [];
function visit(path) { for (const item of readdirSync(path, { withFileTypes: true })) {
  const file = join(path, item.name);
  if (item.isDirectory()) visit(file);
  else { const bytes = readFileSync(file); files.push({ path: relative(product, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
} }
visit(product);
writeFileSync(join(product, 'PACKAGE-MANIFEST.json'), JSON.stringify({ ...release, files }, null, 2));
const zip = join(stage, `Tinglan-${release.version}-Windows.zip`);
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/package-archive.ps1'), '-Source', product, '-Destination', zip], { windowsHide: true, stdio: 'inherit' });
console.log(JSON.stringify({ zip, directory: product, version: release.version, commit: release.commit, files: files.length, sha256: createHash('sha256').update(readFileSync(zip)).digest('hex') }, null, 2));
