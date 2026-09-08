import type { ModelProgress, RecordingSession, TranscriptSegment } from '../../types';
import { requireLocalBridge } from '../assistant/localBridge';

export interface NativeStatus { available: boolean; message?: string }
export async function nativeTranscriptionStatus(signal?: AbortSignal): Promise<NativeStatus> {
  try {
    requireLocalBridge();
    const response = await fetch('/api/asr/status', { signal: AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : [])]) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return { available: false };
    return await response.json();
  } catch { signal?.throwIfAborted(); return { available: false }; }
}

export async function nativeTranscribe(recording: RecordingSession, progress: (value: ModelProgress) => void,
  signal?: AbortSignal, savePartial?: (segments: TranscriptSegment[], durationMs?: number, warning?: string) => Promise<void>): Promise<TranscriptSegment[]> {
  requireLocalBridge();
  if (!recording.audioBlob || recording.audioBlob.size > 512*1024*1024) throw new Error('本机转写需要小于 512 MB 的音频，请分段处理。');
  const response = await fetch('/api/asr/transcribe?language=' + (recording.sourceLanguage.startsWith('zh') ? 'zh' : 'en'), {
    method: 'POST', body: recording.audioBlob, signal,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Tinglan-Client': '1' },
  });
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('本机转写服务未返回有效结果，请重启听澜。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const segments: TranscriptSegment[] = [];
  let buffer = '', complete = false;
  const accept = async (line: string) => {
    if (!line.trim()) return;
    signal?.throwIfAborted();
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.message || '本机转写未完成。');
    if (event.type === 'progress') progress({ label: String(event.message || '本机正在精校'), state: 'working' });
    if (event.type === 'segment') {
      const s = event.segment;
      if (!s || typeof s.source !== 'string' || !s.source.trim() || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.startMs < 0 || s.endMs <= s.startMs) throw new Error('本机转写时间戳无效，已停止接收。');
      segments.push({ id: crypto.randomUUID(), startMs: s.startMs, endMs: s.endMs, source: s.source.trim(), speaker: '讲师', translation: '' });
      await savePartial?.([...segments]);
    }
    if (event.type === 'result') {
      if (event.segments !== segments.length || !segments.length || !Number.isFinite(event.durationMs)) throw new Error('本机转写结果不完整，原音频保留。');
      await savePartial?.([...segments], event.durationMs, event.boundaryWarnings ? `${event.boundaryWarnings} 处转写接缝不确定，请结合原音频核对。` : undefined);
      if (event.boundaryWarnings) progress({ label: `本机精校完成；${event.boundaryWarnings} 处接缝需要结合原音频核对`, state: 'ready' });
      complete = true;
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index+1); await accept(line); }
      if (buffer.length > 262144) throw new Error('本机转写数据异常。');
    }
    await accept(buffer + decoder.decode());
    if (!complete) throw new Error('本机转写中断；已完成的文字与原音频已保留，可重试。');
    return segments;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
