import type { RecordingSession } from '../../types';
import { requireLocalBridge } from '../assistant/localBridge';
import { buildSources } from './client';
import type { StudyAnalysis, StudyClaim, StudyMaterial } from './types';

export interface VaultStatus { configured: boolean; message: string; localOnly: boolean }
export interface VaultReceipt { sha256: string; note: string; state: string }
export async function getVaultStatus(): Promise<VaultStatus> {
  try {
    requireLocalBridge();
    const response = await fetch('/api/library/status', { signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
    return await response.json();
  } catch { return { configured: false, localOnly: true, message: '本机学习资料库未连接；浏览器资料仍保留，可导出完整备份。' }; }
}
async function receive(response: Response) {
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.message || '归档服务未连接，浏览器原件保留。');
  return result;
}
export async function syncVault(original: Blob, fileName: string, sources: Array<{ id: string; title: string; text: string }>, analysis: StudyAnalysis, warnings: string[] = [], signal?: AbortSignal): Promise<VaultReceipt> {
  requireLocalBridge();
  const effective = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(240000)]);
  const upload = await receive(await fetch('/api/library/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Tinglan-Client': '1', 'X-Tinglan-Filename': encodeURIComponent(fileName) }, body: original, signal: effective }));
  return receive(await fetch('/api/library/finalize', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinglan-Client': '1' }, body: JSON.stringify({ ticket: upload.ticket, sha256: upload.sha256, sources, analysis, warnings }), signal: effective }));
}
export function syncMaterialVault(material: StudyMaterial, signal?: AbortSignal) {
  if (!material.analysis) throw new Error('请先完成资料识别与分析。');
  return syncVault(material.originalBlob, material.fileName, buildSources([], [material]), material.analysis, [...material.warnings, ...material.blocks.filter(b => b.uncertain).map(b => `文字块 ${b.id} 识别存疑，请核对原件。`)], signal);
}
export async function syncRecordingVault(recording: RecordingSession, signal?: AbortSignal): Promise<VaultReceipt | undefined> {
  if (!recording.audioBlob || !recording.segments.length || recording.classBrief?.engine !== 'codex') return;
  if (!(await getVaultStatus()).configured) return;
  const sources = buildSources([recording], []);
  const categories = { concepts: 'summary', takeaways: 'attention', assignments: 'assignment', examReading: 'exam', followUps: 'attention' } as const;
  const claims: StudyClaim[] = Object.entries(recording.classBrief.sections).flatMap(([key, items]) => items.flatMap(item => {
    const source = sources.find(s => s.partId === item.sourceSegmentId && (!item.sourceRecordingId || item.sourceRecordingId === recording.id));
    return source ? [{ id: item.id, category: categories[key as keyof typeof categories], text: item.text, due: item.due && source.text.includes(item.due) ? item.due : null, evidence: [{ sourceId: source.id, quote: source.text }] }] : [];
  }));
  if (!claims.length) return;
  const ext = recording.audioBlob.type.includes('ogg') ? 'ogg' : recording.audioBlob.type.includes('wav') ? 'wav' : recording.audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
  return syncVault(recording.audioBlob, recording.sourceFileName || `${recording.title}.${ext}`, sources, { category: 'other', courseName: null, claims, notFound: [], generatedAt: recording.classBrief.generatedAt, model: recording.classBrief.model || 'gpt-5.6-luna' }, [], signal);
}
