import type { Course, RecordingSession } from '../../types';
import { requireLocalBridge } from '../assistant/localBridge';
import { materialSourceId, recordingSourceId, type StudyAnalysis, type StudyBlock, type StudyMaterial, type StudySource } from './types';

export async function studyRequest<T>(path: 'image' | 'analyze', body: unknown, signal?: AbortSignal, onStatus?: (message: string) => void): Promise<T> {
  requireLocalBridge();
  const response = await fetch(`/api/study/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinglan-Client': '1' }, body: JSON.stringify(body), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(280000)]) });
  if (!response.ok) { const error = await response.json().catch(() => null); throw new Error(error?.message || 'Codex 本机服务未连接，请在设置中检查连接。'); }
  if (!response.headers.get('content-type')?.includes('application/x-ndjson') || !response.body) throw new Error('当前网站没有连接 Codex 服务。请使用本机完整版本，网页托管不包含你的本机 AI。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result: T | undefined;
  const accept = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.message || '资料分析失败');
    if (event.type === 'status') onStatus?.(event.message);
    if (event.type === 'result') result = event.result;
  };
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; lines.forEach(accept); }
    accept(buffer + decoder.decode());
    if (!result) throw new Error('连接中断，原件已保存，识别未完成。');
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export const hashBlob = async (blob: Blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取原件')); reader.readAsDataURL(blob); });
}
export function buildSources(recordings: RecordingSession[], materials: StudyMaterial[]): StudySource[] {
  return [
    ...recordings.flatMap(r => r.segments.filter(s => s.source.trim()).map(s => ({ id: recordingSourceId(r.id, s.id), title: r.title, text: s.source, kind: 'recording' as const, ownerId: r.id, partId: s.id, atMs: s.startMs }))),
    ...materials.flatMap(m => m.blocks.filter(b => b.text.trim()).map(b => ({ id: materialSourceId(m.id, b.id), title: m.title, text: b.text, kind: 'material' as const, ownerId: m.id, partId: b.id, uncertain: b.uncertain }))),
  ];
}
/** Deterministic bounded retrieval; return coverage so a subset never masquerades as the entire library. */
export function retrieveSources(sources: StudySource[], query: string) {
  const tokens = [...new Set((query.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []).flatMap(t => /[\u4e00-\u9fff]/.test(t) ? [t, ...Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2))] : [t]))];
  const scored = sources.map((source, index) => { const text = `${source.title} ${source.text}`.toLowerCase(); return { source, index, score: tokens.reduce((n, t) => n + (text.includes(t) ? 2 : 0), 0) + (/due|deadline|assignment|submit|exam|作业|截止|考试|提交/i.test(text) ? 1 : 0) }; });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  let chars = 0;
  const selected = scored.filter(({ source }) => { if (source.text.length > 16000 || chars + source.text.length > 175000) return false; chars += source.text.length; return true; }).slice(0, 780).map(s => s.source);
  return { selected, total: sources.length, covered: selected.length };
}
export async function analyzeMaterial(material: StudyMaterial, courses: Course[], signal: AbortSignal, onStatus: (message: string) => void, onExtracted: (blocks: StudyBlock[], warnings: string[]) => Promise<void>): Promise<StudyAnalysis> {
  let blocks = material.blocks;
  if (!blocks.length) {
    if (material.mimeType.startsWith('image/')) {
      const extraction = await studyRequest<{ blocks: StudyBlock[]; warnings: string[] }>('image', { dataUrl: await blobDataUrl(material.originalBlob) }, signal, onStatus);
      blocks = extraction.blocks;
      await onExtracted(blocks, extraction.warnings);
    } else {
      const text = await material.originalBlob.text();
      blocks = text.match(/[\s\S]{1,4000}/g)?.map((text, i) => ({ id: `block-${i + 1}`, text, uncertain: false })) ?? [];
      await onExtracted(blocks, []);
    }
  }
  if (!blocks.some(b => b.text.trim())) throw new Error('没有识别到可读文字。原件已保留，请上传更清晰的图片或文字文件。');
  return studyRequest<StudyAnalysis>('analyze', { query: '请分类这份学习资料，提炼内容概要、全部作业、具体要求、考试安排、截止时间和注意事项。缺失的 DDL 明确指出。', courses: courses.filter(c => c.id !== 'course-unfiled').map(c => c.name), sources: blocks.map(b => ({ id: materialSourceId(material.id, b.id), text: b.text, title: material.title })) }, signal, onStatus);
}
