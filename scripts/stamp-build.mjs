import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
writeFileSync(new URL('../dist/release.json',import.meta.url),JSON.stringify({product:'tinglan',version:'0.3.0',commit,builtAt:new Date().toISOString()},null,2));
