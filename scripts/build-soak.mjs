import { build } from 'vite';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd();
const outDir = resolve(root, '.runtime/soak-build');
await build({ configFile: false, root, publicDir: false, build: { outDir, emptyOutDir: false, rollupOptions: { input: resolve(root, 'tests/runtime/live-smoke.html') } } });
await mkdir(resolve(outDir, 'tests/runtime/fixtures'), { recursive: true });
await cp(resolve(root, 'tests/runtime/fixtures'), resolve(outDir, 'tests/runtime/fixtures'), { recursive: true });
console.log('Frozen soak build from package ' + JSON.parse(await readFile(resolve(root, 'package.json'))).version + ': ' + outDir);
