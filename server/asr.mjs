import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, open, unlink, rmdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './codex.mjs';

const WORKER = fileURLToPath(new URL('./asr_worker.py', import.meta.url));
const LIMIT = 512 * 1024 * 1024;
const unavailable = { available: false, localOnly: true, message: '本机精校尚未配置。请运行“配置本机转写”；短录音可使用浏览器精校，长录音请先配置本机引擎。' };

export class AsrService {
  constructor({ python } = {}) {
    const known = join(homedir(), 'AppData/Local/Programs/Python/Python312/python.exe');
    const venv = fileURLToPath(new URL(process.platform === 'win32' ? '../.runtime/asr-venv/Scripts/python.exe' : '../.runtime/asr-venv/bin/python', import.meta.url));
    this.python = python || process.env.TINGLAN_PYTHON || (existsSync(venv) ? venv : existsSync(known) ? known : process.platform === 'win32' ? 'python' : 'python3');
    this.active = false; this.children = new Set(); this.cached = null; this.checking = null; this.closed = false; this.request = null;
  }
  run(args, emit, signal, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      if (this.closed) throw new BridgeError('ASR_OFFLINE', '本机转写服务已关闭。', 503);
      signal?.throwIfAborted();
      const child = spawn(this.python, ['-u', '-X', 'utf8', WORKER, ...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' } });
      this.children.add(child);
      let buffer = '', result, failure, total = 0;
      const stop = error => { failure ||= error; child.kill(); };
      const abort = () => stop(new BridgeError('CANCELLED', '已取消本机转写，原音频和已有文字保留。', 499));
      const timer = setTimeout(() => stop(new BridgeError('ASR_TIMEOUT', '本机转写长时间没有进展，已停止；原音频和已有文字保留。', 504)), timeoutMs);
      const deadline = setTimeout(() => stop(new BridgeError('ASR_TIMEOUT', '本机转写超过任务时限，请分段重试。', 504)), 6*3600000);
      signal?.addEventListener('abort', abort, { once: true });
      const accept = line => {
        if (!line.trim() || failure) return;
        let event;
        try { event = JSON.parse(line); } catch { return stop(new BridgeError('ASR_PROTOCOL', '本机转写返回了无效结果，请重试。')); }
        timer.refresh();
        if (event.type === 'error') return stop(new BridgeError(event.code || 'ASR_FAILED', event.message));
        if (event.type === 'result' || typeof event.available === 'boolean') result = event;
        emit(event);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        total += Buffer.byteLength(chunk);
        if (total > 32*1024*1024) return stop(new BridgeError('ASR_LIMIT', '转写输出超过安全上限，请分段处理。'));
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index+1); accept(line); }
        if (buffer.length > 262144) stop(new BridgeError('ASR_PROTOCOL', '本机转写输出异常。'));
      });
      child.stderr.on('data', () => {});
      child.once('error', () => { failure = new BridgeError('ASR_OFFLINE', unavailable.message, 503); });
      child.once('close', code => {
        accept(buffer);
        clearTimeout(timer); clearTimeout(deadline); signal?.removeEventListener('abort', abort); this.children.delete(child);
        if (failure) reject(failure);
        else if (code !== 0 || !result) reject(new BridgeError('ASR_FAILED', '本机转写中断，原音频和已有文字保留。'));
        else resolve(result);
      });
    });
  }
  async status() {
    if (this.cached && Date.now() - this.cached.at < 30000) return this.cached.value;
    if (!this.checking) this.checking = this.run(['--probe'], () => {}, undefined, 20000)
      .catch(() => unavailable).then(value => { this.cached = { at: Date.now(), value }; return value; }).finally(() => { this.checking = null; });
    return this.checking;
  }
  async transcribe(req, language, emit, signal) {
    if (this.closed) throw new BridgeError('ASR_OFFLINE', '本机转写服务已关闭。', 503);
    if (!['en', 'zh'].includes(language)) throw new BridgeError('BAD_INPUT', '只支持中文或英语录音。', 400);
    if (this.active) throw new BridgeError('ASR_BUSY', '另一段本机转写正在处理，请完成或取消后再试。', 429);
    this.active = true; this.request = req;
    let directory, path;
    try {
      if (!(await this.status()).available) throw new BridgeError('ASR_OFFLINE', unavailable.message, 503);
      signal.throwIfAborted();
      if (this.closed) throw new BridgeError('ASR_OFFLINE', '本机转写服务已关闭。', 503);
      directory = await mkdtemp(join(tmpdir(), 'tinglan-asr-')); path = join(directory, 'input.media');
      const file = await open(path, 'wx'); let bytes = 0;
      try {
        for await (const chunk of req) {
          signal.throwIfAborted();
          if (this.closed) throw new BridgeError('ASR_OFFLINE', '本机转写服务已关闭。', 503);
          bytes += chunk.length;
          if (bytes > LIMIT) throw new BridgeError('TOO_LARGE', '单段本机转写上限为 512 MB，请分段处理。', 413);
          await file.writeFile(chunk);
        }
        await file.sync();
      } finally { await file.close(); }
      if (!bytes) throw new BridgeError('BAD_INPUT', '音频文件为空。', 400);
      signal.throwIfAborted();
      return await this.run(['--file', path, '--language', language], emit, signal);
    } finally {
      // Only a newly created processing copy is removed. Browser/vault originals are untouched.
      if (path) await unlink(path).catch(() => {});
      if (directory) await rmdir(directory).catch(() => {});
      this.active = false; this.request = null;
    }
  }
  close() { this.closed = true; this.request?.destroy(); for (const child of this.children) child.kill(); }
}
