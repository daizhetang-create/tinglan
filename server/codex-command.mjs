import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep, delimiter } from 'node:path';

function fromPath(candidate, node = process.execPath) {
  if (!existsSync(candidate)) return null;
  if (/\.cmd$/i.test(candidate)) {
    // Never execute or parse arbitrary batch shim text. Only the official npm entry is supported.
    const root = resolve(dirname(candidate), 'node_modules/@openai/codex');
    let manifest;
    try { manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')); } catch { return null; }
    if (manifest.name !== '@openai/codex' || typeof manifest.bin?.codex !== 'string') return null;
    const entry = resolve(root, manifest.bin.codex);
    if (!entry.startsWith(root + sep) || !entry.endsWith('.js') || !existsSync(entry)) return null;
    return { command: node, argsPrefix: [entry], kind: 'official-npm' };
  }
  return { command: candidate, argsPrefix: [], kind: 'native' };
}

export function resolveCodexCommand({ env = process.env, platform = process.platform, node = process.execPath } = {}) {
  if (env.TINGLAN_CODEX_BIN) {
    const explicit = fromPath(resolve(env.TINGLAN_CODEX_BIN), node);
    if (explicit) return explicit;
    throw new Error('Configured Codex executable or official npm entry is missing');
  }
  const directories = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  for (const filename of platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']) {
    for (const directory of directories) {
      const resolved = fromPath(resolve(directory.replace(/^"|"$/g, ''), filename), node);
      if (resolved) return resolved;
    }
  }
  throw new Error('Codex CLI missing');
}
