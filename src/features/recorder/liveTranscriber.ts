import type { ModelProgress, TranscriptSegment } from '../../types';
import captureModuleUrl from './pcm-capture.worklet.js?url';
import { sanitizeAsrResult } from './asrQuality';

interface LiveOptions {
  sourceLanguage: string;
  model: 'tiny' | 'base';
  onSegments: (segments: TranscriptSegment[]) => void;
  onProgress: (progress: ModelProgress) => void;
  onError: (message: string) => void;
}

interface AudioChunk { audio: Float32Array; startMs: number; durationMs: number }
interface AsrResult { text?: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }>; quality?: { rejectedSegments?: number; reason?: string } }
interface Reply { type: string; requestId?: string; message?: string; label?: string; progress?: number; result?: AsrResult }

const MAX_QUEUED_CHUNKS = 3;
// Four seconds gives a useful first caption after the model is warm; eight
// seconds bounds CPU work while retaining enough context for lecture phrases.
// A quiet boundary is preferred, but stop() always flushes the remaining tail.
const MIN_CHUNK_SECONDS = 4;
const MAX_CHUNK_SECONDS = 8;

/** Capture/inference are independent of MediaRecorder: this class never stops input tracks. */
export class LiveTranscriber {
  private readonly options: LiveOptions;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private capture?: AudioWorkletNode;
  private mutedOutput?: GainNode;
  private worker?: Worker;
  private parts: Float32Array[] = [];
  private partSamples = 0;
  private chunkStartMs = 0;
  private sampleRate = 48_000;
  private queue: AudioChunk[] = [];
  private processing?: Promise<void>;
  private pending?: { id: string; resolve: (result: AsrResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private paused = false;
  private closing = false;
  private disposed = false;
  private started = false;
  private stopPromise?: Promise<void>;
  private onFlushed?: () => void;
  private skippedChunks = 0;
  private rejectedSegments = 0;
  private peakQueuedChunks = 0;

  constructor(options: LiveOptions) { this.options = options; }

  /** Read-only operational telemetry; never exposes or retains captured audio. */
  get stats(): { queuedChunks: number; peakQueuedChunks: number; skippedChunks: number; capturedMs: number; bufferedMs: number } {
    return { queuedChunks: this.queue.length, peakQueuedChunks: this.peakQueuedChunks, skippedChunks: this.skippedChunks,
      capturedMs: this.chunkStartMs + this.partSamples / this.sampleRate * 1000, bufferedMs: this.partSamples / this.sampleRate * 1000 };
  }

  async start(stream: MediaStream): Promise<void> {
    if (this.started || this.disposed) throw new Error('实时转写会话不可重复启动');
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) throw new Error('没有可用的音频输入');
    this.started = true;
    this.options.onProgress({ state: 'checking', label: '准备本地实时转写 · 首次使用需要下载模型' });
    this.context = new AudioContext();
    this.sampleRate = this.context.sampleRate;
    try {
      await this.context.audioWorklet.addModule(captureModuleUrl);
      if (this.disposed || this.closing) throw new Error('实时转写已取消');
      this.source = this.context.createMediaStreamSource(stream);
      this.capture = new AudioWorkletNode(this.context, 'tinglan-pcm-capture');
      let readyResolve: (() => void) | undefined;
      const captureReady = new Promise<void>((resolve) => { readyResolve = resolve; });
      this.mutedOutput = this.context.createGain();
      this.mutedOutput.gain.value = 0;
      this.source.connect(this.capture).connect(this.mutedOutput).connect(this.context.destination);
      this.capture.port.onmessage = ({ data }: MessageEvent<{ type: string; samples?: Float32Array }>) => {
        if (data.type === 'ready') { readyResolve?.(); readyResolve = undefined; return; }
        if (data.type === 'flushed') { this.onFlushed?.(); return; }
        if (data.type === 'pcm' && data.samples && !this.disposed) this.acceptSamples(data.samples);
      };
      if (this.paused) this.capture.port.postMessage({ type: 'pause' });
      await this.context.resume();
      const readyTimer = setTimeout(() => readyResolve?.(), 1500);
      await captureReady;
      clearTimeout(readyTimer);
      if (this.disposed || this.closing) throw new Error('实时转写已取消');
      this.ensureWorker().postMessage({ type: 'warmup', model: this.options.model, sourceLanguage: this.options.sourceLanguage });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  pause(): void { this.paused = true; this.capture?.port.postMessage({ type: 'pause' }); }
  resume(): void { this.paused = false; if (!this.closing) this.capture?.port.postMessage({ type: 'resume' }); }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.finish();
    return this.stopPromise;
  }

  private async finish(): Promise<void> {
    this.closing = true;
    if (this.disposed) return;
    if (this.capture && this.context?.state === 'running') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        this.onFlushed = () => { clearTimeout(timer); resolve(); };
        this.capture!.port.postMessage({ type: 'flush' });
      });
      this.onFlushed = undefined;
    }
    this.disconnectCapture();
    this.flushChunk();
    while (this.processing) await this.processing;
    if (!this.disposed) this.options.onProgress({ state: 'ready', label: '实时转写队列处理完成' });
    this.worker?.terminate();
    this.worker = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.closing = true;
    this.queue = [];
    this.parts = [];
    this.partSamples = 0;
    this.onFlushed?.();
    this.onFlushed = undefined;
    this.disconnectCapture();
    this.failPending(new Error('实时转写已关闭'));
    this.worker?.terminate();
    this.worker = undefined;
  }

  private disconnectCapture(): void {
    this.source?.disconnect();
    this.capture?.disconnect();
    this.mutedOutput?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    this.capture = undefined;
    this.source = undefined;
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
  }

  private acceptSamples(samples: Float32Array): void {
    this.parts.push(samples);
    this.partSamples += samples.length;
    const seconds = this.partSamples / this.sampleRate;
    // Prefer a quiet boundary after four seconds; force a bound at eight.
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    if (seconds >= MAX_CHUNK_SECONDS || (seconds >= MIN_CHUNK_SECONDS && rms < 0.004)) this.flushChunk();
  }

  private flushChunk(): void {
    if (!this.partSamples) return;
    const input = new Float32Array(this.partSamples);
    let offset = 0;
    for (const part of this.parts) { input.set(part, offset); offset += part.length; }
    const durationMs = input.length / this.sampleRate * 1000;
    const startMs = this.chunkStartMs;
    this.chunkStartMs += durationMs;
    this.parts = [];
    this.partSamples = 0;
    // Reject silence before Whisper (which can hallucinate text on silence).
    let energy = 0;
    for (const value of input) energy += value * value;
    if (durationMs < 250 || Math.sqrt(energy / input.length) < 0.002) return;
    if (this.queue.length >= MAX_QUEUED_CHUNKS) {
      this.skippedChunks += 1;
      this.options.onError('电脑暂时跟不上实时转写，部分片段待录音结束后补转写；完整录音仍在保存。');
      return;
    }
    const audio = new Float32Array(Math.max(1, Math.round(input.length * 16_000 / this.sampleRate)));
    const ratio = this.sampleRate / 16_000;
    for (let i = 0; i < audio.length; i += 1) {
      const position = i * ratio;
      const left = Math.min(input.length - 1, Math.floor(position));
      const right = Math.min(input.length - 1, left + 1);
      audio[i] = input[left] + (input[right] - input[left]) * (position - left);
    }
    this.queue.push({ audio, startMs, durationMs });
    this.peakQueuedChunks = Math.max(this.peakQueuedChunks, this.queue.length);
    if (!this.processing) {
      this.processing = this.drain().finally(() => { this.processing = undefined; });
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.disposed) {
      const chunk = this.queue.shift()!;
      try {
        const result = await this.infer(chunk.audio);
        if (this.disposed) return;
        // Sanitize again at the controller boundary. This protects the UI if a
        // worker is replaced or an older cached worker returns raw hypotheses.
        const sanitized = sanitizeAsrResult(result);
        this.rejectedSegments += sanitized.quality?.rejectedSegments ?? 0;
        const rawChunks = sanitized.chunks.filter((item) => item.text?.trim());
        if (!rawChunks.length && sanitized.text) rawChunks.push({ text: sanitized.text, timestamp: [0, chunk.durationMs / 1000] });
        if (!rawChunks.length && sanitized.quality?.rejectedSegments) {
          this.options.onError(`${sanitized.quality.reason ?? '检测到异常重复字幕，已丢弃'}；完整录音保留，结束后可补转写。`);
        }
        const segments = rawChunks.map((item): TranscriptSegment => ({
          id: crypto.randomUUID(),
          startMs: Math.round(chunk.startMs + Math.max(0, Math.min(chunk.durationMs, (item.timestamp?.[0] ?? 0) * 1000))),
          endMs: Math.round(chunk.startMs + Math.max(0, Math.min(chunk.durationMs, (item.timestamp?.[1] ?? chunk.durationMs / 1000) * 1000))),
          speaker: '课堂讲者', source: item.text.trim(), translation: '',
        }));
        if (segments.length) this.options.onSegments(segments);
        this.options.onProgress({ state: this.closing ? 'working' : 'ready', label: this.queue.length ? `实时字幕处理中 · 剩余 ${this.queue.length} 段` : '本地实时字幕已就绪 · 每 4–8 秒更新' });
      } catch (error) {
        if (!this.disposed) this.options.onError(`${error instanceof Error ? error.message : '实时转写失败'}；完整录音保留，结束后可补转写。`);
      }
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('../../workers/transcription.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (data.type === 'engine-ready' && !this.pending) {
        this.options.onProgress({ state: 'ready', label: '实时模型已就绪 · 等待语音片段' });
      } else if (data.type === 'warmup-error') {
        const message = data.message ?? '实时转写模型加载失败，请检查网络后重试';
        this.options.onProgress({ state: 'error', label: message });
        this.options.onError(message);
      } else if (data.type === 'progress' || data.type === 'working') {
        this.options.onProgress({ state: data.type === 'progress' ? 'downloading' : 'working', label: data.label ?? '本地实时转写中', progress: data.progress });
      } else if ((data.type === 'result' || data.type === 'error') && this.pending && (!data.requestId || data.requestId === this.pending.id)) {
        const task = this.pending;
        clearTimeout(task.timer);
        this.pending = undefined;
        if (data.type === 'result' && data.result) task.resolve(data.result);
        else task.reject(new Error(data.message ?? '实时转写未返回内容'));
      }
    };
    this.worker.onerror = (event) => {
      if (!this.disposed) this.options.onError(event.message || '实时转写引擎异常');
      this.failPending(new Error(event.message || '实时转写引擎异常'));
      this.worker?.terminate();
      this.worker = undefined;
    };
    return this.worker;
  }

  private infer(audio: Float32Array): Promise<AsrResult> {
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.failPending(new Error('实时转写超时，请检查首次模型下载和网络'));
        this.worker?.terminate();
        this.worker = undefined;
      }, 180_000);
      this.pending = { id, resolve, reject, timer };
      worker.postMessage({ type: 'transcribe', requestId: id, audio, model: this.options.model, sourceLanguage: this.options.sourceLanguage }, [audio.buffer]);
    });
  }

  private failPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = undefined;
  }
}
