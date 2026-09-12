import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './codex.mjs';

/** One bounded job per worker. Model survives between requests; cancellation kills only this worker. */
export class RetainedAsr {
  constructor({ python, worker, spawnProcess = spawn, idleMs = 300000 } = {}) {
    this.python = python; this.worker = worker; this.spawnProcess = spawnProcess;
    this.idleMs = idleMs; this.child = null; this.pending = null; this.closed = false; this.warm = false;
  }
  start() {
    if (this.closed) throw new BridgeError('ASR_OFFLINE', '本机语音服务已关闭。', 503);
    if (this.child) return;
    const child = this.spawnProcess(this.python, ['-u', '-X', 'utf8', this.worker, '--serve'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' },
    });
    this.child = child; let buffer = '';
    const failed = () => {
      if (this.child !== child) return;
      this.child = null; this.warm = false;
      this.finish(new BridgeError('ASR_OFFLINE', '本机语音引擎已断开；原音频保留，可重试。', 503));
    };
    child.once('error', failed); child.once('exit', failed); child.stdin.on('error', failed);
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 1048576) return this.reset(new BridgeError('ASR_PROTOCOL', '本机语音输出异常，已停止。'));
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { return this.reset(new BridgeError('ASR_PROTOCOL', '本机语音结果格式无效。')); }
        if (!this.pending || event.id !== this.pending.id) continue;
        if (event.type === 'error') { this.finish(new BridgeError(event.code || 'ASR_FAILED', event.message)); continue; }
        const job = this.pending;
        job.timer.refresh(); job.bytes += Buffer.byteLength(line);
        if (job.bytes > 32 * 1024 * 1024) return this.reset(new BridgeError('ASR_LIMIT', '本机转写结果过大，请分段处理。'));
        try { job.emit(event); } catch { return this.reset(new BridgeError('ASR_PROTOCOL', '本机语音结果无法接收。')); }
        if (event.type === 'result') { this.warm = true; this.finish(null, event); }
      }
    });
  }
  request(body, emit = () => {}, signal, timeoutMs = 30000) {
    if (this.pending) return Promise.reject(new BridgeError('ASR_BUSY', '本机语音引擎正忙，请稍后重试。', 429));
    if (signal?.aborted) return Promise.reject(new BridgeError('CANCELLED', '本机语音处理已取消。', 499));
    try { this.start(); } catch (error) { return Promise.reject(error); }
    clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => this.reset(new BridgeError('CANCELLED', '本机语音处理已取消；原音频保留。', 499));
      const timer = setTimeout(() => this.reset(new BridgeError('ASR_TIMEOUT', '本机语音处理超时；原音频保留。', 504)), timeoutMs);
      const deadline = setTimeout(() => this.reset(new BridgeError('ASR_TIMEOUT', '本机语音任务超过时限。', 504)), body.operation === 'file' ? 6 * 3600000 : timeoutMs);
      this.pending = { id, emit, resolve, reject, abort, signal, timer, deadline, bytes: 0 };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (!this.child?.stdin?.writable) throw new Error('stdin closed');
        this.child.stdin.write(JSON.stringify({ ...body, id }) + '\n');
      } catch {
        this.reset(new BridgeError('ASR_OFFLINE', '本机语音引擎已断开；原音频保留，可重试。', 503));
      }
    });
  }
  finish(error, result) {
    const job = this.pending; this.pending = null;
    if (!job) return;
    clearTimeout(job.timer); clearTimeout(job.deadline); job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(result);
    clearTimeout(this.idleTimer);
    if (this.child) { this.idleTimer = setTimeout(() => this.reset(), this.idleMs); this.idleTimer.unref?.(); }
  }
  reset(error) {
    const child = this.child; this.child = null; this.warm = false;
    this.finish(error || new BridgeError('ASR_OFFLINE', '本机语音引擎已关闭。', 503));
    clearTimeout(this.idleTimer); child?.kill();
  }
  close() { this.closed = true; this.reset(); }
}
