export type StudyCategory = 'assignment' | 'slides' | 'reading' | 'notice' | 'other';
export interface StudyEvidence { sourceId: string; quote: string }
export interface StudyClaim {
  id: string;
  category: 'summary' | 'assignment' | 'exam' | 'requirement' | 'attention';
  text: string;
  due: string | null;
  evidence: StudyEvidence[];
}
export interface StudyAnalysis {
  category: StudyCategory;
  courseName: string | null;
  claims: StudyClaim[];
  notFound: string[];
  generatedAt: string;
  model: string;
  threadId?: string;
}
export interface StudyBlock { id: string; text: string; uncertain: boolean }
export interface StudyMaterial {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  sha256: string;
  originalBlob: Blob;
  createdAt: string;
  updatedAt: string;
  courseId: string;
  courseConfirmed?: boolean;
  category: StudyCategory;
  state: 'stored' | 'extracting' | 'analyzing' | 'ready' | 'error';
  error?: string;
  blocks: StudyBlock[];
  warnings: string[];
  analysis?: StudyAnalysis;
  vault?: { sha256: string; note: string; state: string };
  vaultError?: string;
}
export interface StudySource {
  id: string;
  title: string;
  text: string;
  kind: 'recording' | 'material';
  ownerId: string;
  partId: string;
  atMs?: number;
  uncertain?: boolean;
}
export const materialSourceId = (materialId: string, blockId: string) => `m:${materialId}:${blockId}`;
export const recordingSourceId = (recordingId: string, segmentId: string) => `r:${recordingId}:${segmentId}`;

/** Used on backup input too: reject broken evidence before any database write. */
export function validateMaterial(value: unknown): Omit<StudyMaterial, 'originalBlob'> {
  const fail = (): never => { throw new Error('资料格式或证据引用无效，未修改现有资料。'); };
  if (!value || typeof value !== 'object') return fail();
  const m = value as StudyMaterial;
  if (['id', 'title', 'fileName', 'mimeType', 'sha256', 'courseId'].some(k => typeof (m as unknown as Record<string, unknown>)[k] !== 'string') || !m.id || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isFinite(Date.parse(m.createdAt)) || !Number.isFinite(Date.parse(m.updatedAt))) fail();
  if (!['image/png', 'image/jpeg', 'image/webp', 'text/plain'].includes(m.mimeType)) fail();
  if (!['assignment', 'slides', 'reading', 'notice', 'other'].includes(m.category) || !['stored', 'extracting', 'analyzing', 'ready', 'error'].includes(m.state) || !Array.isArray(m.blocks) || !Array.isArray(m.warnings) || m.warnings.some(x => typeof x !== 'string')) fail();
  if (m.blocks.some(b => !b || typeof b.id !== 'string' || !b.id || typeof b.text !== 'string' || typeof b.uncertain !== 'boolean') || new Set(m.blocks.map(b => b.id)).size !== m.blocks.length) fail();
  const sources = new Map(m.blocks.map(b => [materialSourceId(m.id, b.id), b.text]));
  if (m.analysis) {
    const a = m.analysis;
    if (!Array.isArray(a.claims) || !Array.isArray(a.notFound) || a.notFound.some(x => typeof x !== 'string') || typeof a.model !== 'string' || !Number.isFinite(Date.parse(a.generatedAt)) || (a.courseName !== null && typeof a.courseName !== 'string')) fail();
    for (const c of a.claims) {
      if (!c || typeof c.id !== 'string' || typeof c.text !== 'string' || !['summary', 'assignment', 'exam', 'requirement', 'attention'].includes(c.category) || !Array.isArray(c.evidence) || !c.evidence.length || (c.due !== null && typeof c.due !== 'string')) fail();
      for (const e of c.evidence) if (!e || typeof e.quote !== 'string' || !e.quote.trim() || !sources.get(e.sourceId)?.includes(e.quote)) fail();
      if (c.due !== null && !c.evidence.some(e => e.quote.includes(c.due!))) fail();
    }
  }
  if (m.state === 'ready' && !m.analysis) fail();
  return m;
}

export async function validateOriginal(material: Pick<StudyMaterial, 'mimeType' | 'originalBlob'>): Promise<void> {
  const { originalBlob: blob, mimeType: mime } = material;
  if (blob.type !== mime || !['image/png', 'image/jpeg', 'image/webp', 'text/plain'].includes(mime)) throw new Error('资料原件类型不一致或不安全。');
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const isValid = mime === 'text/plain' || (mime === 'image/png' && [137,80,78,71,13,10,26,10].every((x, i) => bytes[i] === x)) || (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) || (mime === 'image/webp' && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP');
  if (!isValid) throw new Error('资料图片签名无效，未导入。');
}
