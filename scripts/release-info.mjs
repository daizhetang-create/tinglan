import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

export function sourceFingerprint(root) {
  const files = [];
  const visit = path => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
      if (entry.isDirectory()) visit(join(path, entry.name));
      else if (entry.isFile()) files.push(join(path, entry.name));
    }
  };
  for (const directory of ['src', 'public', 'server', 'scripts']) visit(join(root, directory));
  for (const filename of ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']) {
    if (existsSync(join(root, filename))) files.push(join(root, filename));
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(relative(root, file).replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

export function artifactManifest(dist) {
  const assets = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path !== join(dist, 'release.json')) {
        const bytes = readFileSync(path);
        assets.push({ path: relative(dist, path).replaceAll('\\', '/'), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  };
  visit(dist); return assets.sort((a,b) => a.path.localeCompare(b.path, 'en'));
}

export function validArtifacts(dist, release) {
  if (!Array.isArray(release?.assets) || !release.assets.some(asset => asset.path === 'index.html')) return false;
  try {
    const current = new Map(artifactManifest(dist).map(asset => [asset.path, asset]));
    return release.assets.every(asset => current.get(asset.path)?.sha256 === asset.sha256 && current.get(asset.path)?.size === asset.size);
  } catch { return false; }
}

export function localCommit(root) {
  if (!existsSync(join(root, '.git'))) return null;
  try {
    const options = { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], options).trim();
    if (realpathSync(resolve(top)).toLowerCase() !== realpathSync(root).toLowerCase()) return null;
    return execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
  } catch { return null; }
}
