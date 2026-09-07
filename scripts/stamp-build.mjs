import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const { version }=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
writeFileSync(new URL('../dist/release.json',import.meta.url),JSON.stringify({product:'tinglan',version,commit,builtAt:new Date().toISOString()},null,2));
