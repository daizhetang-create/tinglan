import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localCommit, sourceFingerprint, artifactManifest } from './release-info.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const commit=localCommit(root);
const { version }=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
writeFileSync(new URL('../dist/release.json',import.meta.url),JSON.stringify({product:'tinglan',version,commit,sourceFingerprint:sourceFingerprint(root),assets:artifactManifest(fileURLToPath(new URL('../dist',import.meta.url))),builtAt:new Date().toISOString()},null,2));
