import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { sourceFingerprint, validArtifacts } from './release-info.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
const webPort = Number(process.env.TINGLAN_WEB_PORT || 4318);
const bridgePort = Number(process.env.TINGLAN_BRIDGE_PORT || 4319);
const url = `http://127.0.0.1:${webPort}/`;
const noOpen = process.argv.includes('--no-open');
const runtime = join(root, '.runtime');
let lockOwned = false;
const lockFile = join(runtime, 'start.lock');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, shell: false, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`启动步骤失败（${code}），请检查上方提示。`)));
  });
}
async function health() {
  try { const response = await fetch(url + '__health', { signal: AbortSignal.timeout(1200) }); return response.ok ? await response.json() : null; }
  catch { return null; }
}
function matches(health, fingerprint) {
  if (health?.product !== 'tinglan' || health.sourceFingerprint !== fingerprint || health.webPort !== webPort || health.bridgePort !== bridgePort) return false;
  try { return realpathSync(health.root).toLowerCase() === realpathSync(root).toLowerCase(); } catch { return false; }
}
async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', () => reject(new Error(`端口 ${port} 已被使用。请先停止旧录音并关闭旧服务；听澜不会自动结束其他程序。`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
function openWebsite() {
  if (noOpen) return;
  const executable = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', shell: false });
  child.on('error', () => console.log(`请在浏览器打开 ${url}`)); child.unref();
}
function findNpm() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  const result = candidates.find(path => path && path.endsWith('npm-cli.js') && existsSync(path));
  if (!result) throw new Error('首次构建需要 npm。请从 https://nodejs.org 安装 Node.js 22.12 或以上版本（包含 npm），再双击启动。');
  return result;
}

try {
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('请先安装 Node.js 22.12 或以上版本：https://nodejs.org');
  if (![webPort, bridgePort].every(port => Number.isInteger(port) && port > 1024 && port < 65536) || webPort === bridgePort) throw new Error('本机端口配置无效');
  mkdirSync(runtime, { recursive: true });
  const fingerprint = sourceFingerprint(root);
  const existing = await health();
  if (existing && !matches(existing, fingerprint)) throw new Error('已运行其他目录或旧版本的听澜。请先保存录音并关闭旧服务，再启动此版本；未自动结束旧服务。');
  if (existing) {
    let release; try { release = JSON.parse(readFileSync(join(root, 'dist/release.json'), 'utf8')); } catch {}
    if (!validArtifacts(join(root, 'dist'), release)) throw new Error('正在运行的网站文件缺失或损坏，请保存录音并关闭旧服务后重新启动。');
  }
  if (!existing) {
    try {
      const fd = openSync(lockFile, 'wx'); lockOwned = true;
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); }
      finally { closeSync(fd); }
    }
    catch (error) {
      if (error.code !== 'EEXIST' || lockOwned) throw error;
      let pid;
      for (let attempt = 0; attempt < 4; attempt++) {
        try { pid = JSON.parse(readFileSync(lockFile, 'utf8')).pid; break; } catch { await pause(100); }
      }
      if (!Number.isInteger(pid) || pid < 1) throw new Error('启动锁损坏，请保留 .runtime/start.lock 并联系维护者。');
      let alive = true; try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (!alive) { unlinkSync(lockFile); throw new Error('已清理上次中断的启动标记，请重新双击启动。'); }
      throw new Error('听澜正在另一个启动窗口中准备，请等待那个窗口完成。');
    }
    await checkPort(webPort); await checkPort(bridgePort);
    let release;
    try { release = JSON.parse(readFileSync(join(root, 'dist/release.json'), 'utf8')); } catch { /* build below */ }
    if (release?.sourceFingerprint !== fingerprint || !validArtifacts(join(root, 'dist'), release)) {
      const npm = findNpm();
      // A copied node_modules or changed lockfile is not evidence of compatible dependencies.
      console.log('正在按锁定版本准备网站依赖…'); await run(process.execPath, [npm, 'ci']);
      console.log('正在准备当前版本…'); await run(process.execPath, [npm, 'run', 'build']);
    }
    const out = openSync(join(runtime, 'website.log'), 'a'), err = openSync(join(runtime, 'website-error.log'), 'a');
    const child = spawn(process.execPath, [join(root, 'scripts/serve.mjs')], { cwd: root, windowsHide: true, detached: true, shell: false, stdio: ['ignore', out, err] });
    closeSync(out); closeSync(err); child.unref();
    let spawnError; child.on('error', error => { spawnError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw spawnError;
      if (matches(await health(), sourceFingerprint(root))) { ready = true; break; }
      await pause(250);
    }
    if (!ready) throw new Error('启动未完成，请查看 .runtime/website-error.log；已保留所有资料。');
  }
  console.log(`听澜已就绪：${url}。AI 笔记需要本机 Codex 与 ChatGPT 登录。`); openWebsite();
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { if (lockOwned) unlinkSync(lockFile); }
