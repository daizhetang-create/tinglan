import type { RecordingSession } from '../../types';
import { requireLocalBridge } from './localBridge';

export interface CodexNotes {
  overview: string;
  items: Array<{ category: 'concept' | 'emphasis' | 'assignment' | 'exam' | 'question' | 'admin'; text: string; sourceRecordingId: string; sourceSegmentId: string; atMs: number; due?: string }>;
  answer?: string; model: string; threadId: string; generatedAt: string;
}
export interface CodexStatus {
  connected: boolean; authenticated: boolean; model: string; planType?: string; message?: string;
  rateLimits?: Array<{ name: string; usedPercent: number; remainingPercent: number; resetsAt: number | null; windowDurationMins: number | null }>;
}
// The bridge never accepts keys/tokens from browser storage. Only transcript text crosses this boundary.
const BASE = '';
async function responseError(response: Response): Promise<Error> {
  const data = await response.json().catch(() => null);
  return new Error(data?.message || `Codex 本地服务返回错误 (${response.status})。`);
}
export async function getCodexStatus(): Promise<CodexStatus> {
  try {
    requireLocalBridge();
    const response = await fetch(`${BASE}/api/codex/status`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw await responseError(response);
    return await response.json();
  } catch (error) { return { connected: false, authenticated: false, model: 'gpt-5.6-luna', message: error instanceof TypeError ? 'Codex 本地服务未启动。请使用“启动听澜”同时启动网站和服务。' : error instanceof Error ? error.message : 'Codex 连接失败。' }; }
}
export async function startCodexLogin(): Promise<{ loginId: string; authUrl: string }> {
  requireLocalBridge();
  const response = await fetch(`${BASE}/api/codex/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinglan-Client': '1' }, body: '{}', signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw await responseError(response);
  return await response.json();
}
export async function generateCodexNotes(recordings: RecordingSession[], prompt = '', onDelta?: (text: string) => void, signal?: AbortSignal): Promise<CodexNotes> {
  requireLocalBridge();
  const response = await fetch(`${BASE}/api/codex/notes`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Tinglan-Client': '1' }, body: JSON.stringify({ prompt, recordings: recordings.map(r => ({ id: r.id, title: r.title, createdAt: r.createdAt, segments: r.segments.map(s => ({ id: s.id, source: s.source, translation: s.translation, startMs: s.startMs })) })) }) });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error('Codex 未返回数据流。');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', result: CodexNotes | undefined;
  const accept = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.message || 'Codex 生成失败。');
    if (event.type === 'delta') onDelta?.(String(event.text));
    if (event.type === 'result') result = event.notes;
  };
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; for (const line of lines) accept(line); }
    buffer += decoder.decode(); accept(buffer);
    if (!result) throw new Error('Codex 数据流中断，尚未保存新笔记。请重试。');
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
