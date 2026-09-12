import { sanitizeAsrResult } from './asrQuality';

export interface NativeLiveChunk {
  text: string;
  timestamp: [number, number | null];
}

export interface NativeLiveResult {
  text?: string;
  chunks?: NativeLiveChunk[];
  quality?: { rejectedSegments?: number; reason?: string };
}

interface NativeLiveStatus { available?: boolean; liveSupported?: boolean }
type FetchLike = typeof fetch;

function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

/** Local-only retained Small ASR client. It never sends raw audio to a remote origin. */
export class NativeLiveClient {
  private readonly fetcher: FetchLike;
  constructor(fetcher: FetchLike = fetch) { this.fetcher = fetcher; }

  async prepare(signal?: AbortSignal): Promise<boolean> {
    const statusTimeout = signalWithTimeout(signal, 8_000);
    try {
      const response = await this.fetcher('/api/asr/status', { signal: statusTimeout.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false;
      const status = await response.json() as NativeLiveStatus;
      if (!status.available || !status.liveSupported) return false;
    } catch {
      signal?.throwIfAborted();
      return false;
    } finally { statusTimeout.dispose(); }

    const warmupTimeout = signalWithTimeout(signal, 45_000);
    try {
      const response = await this.fetcher('/api/asr/warmup', {
        method: 'POST', signal: warmupTimeout.signal,
        headers: { 'Content-Type': 'application/json', 'X-Tinglan-Client': '1' }, body: '{}',
      });
      return response.ok && Boolean((await response.json() as { liveSupported?: boolean }).liveSupported ?? true);
    } catch {
      signal?.throwIfAborted();
      return false;
    } finally { warmupTimeout.dispose(); }
  }

  async transcribe(audio: Float32Array, sourceLanguage: string, signal?: AbortSignal): Promise<NativeLiveResult> {
    signal?.throwIfAborted();
    const response = await this.fetcher(`/api/asr/live?language=${sourceLanguage.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en'}`, {
      method: 'POST', body: audio.slice().buffer, signal,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Tinglan-Client': '1' },
    });
    if (!response.ok) {
      let message = '本机实时转写暂不可用';
      try { message = String((await response.json() as { message?: string }).message || message); } catch { /* keep fallback */ }
      throw new Error(message);
    }
    const data = await response.json() as { type?: string; text?: string; chunks?: NativeLiveChunk[]; quality?: NativeLiveResult['quality']; message?: string };
    if (data.type && data.type !== 'result') throw new Error(data.message || '本机实时转写未返回有效结果');
    const result = sanitizeAsrResult({ text: data.text, chunks: data.chunks });
    if (!result.text && !result.chunks.length) throw new Error(result.quality?.reason || '本机未识别到清晰语音');
    return result;
  }
}
