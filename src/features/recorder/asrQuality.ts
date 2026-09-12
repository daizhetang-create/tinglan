/**
 * Guard the UI from a known Whisper failure mode: a stalled/low-signal
 * decoder can emit one CJK character (for example `们`) hundreds of times.
 * It is important that this is a rejection, not a replacement transcript.
 */
export interface AsrQuality {
  rejectedSegments: number;
  reason?: string;
}

export interface AsrChunkLike {
  text: string;
  timestamp: [number, number | null];
}

export interface SanitizedAsrResult<T extends AsrChunkLike = AsrChunkLike> {
  text: string;
  chunks: T[];
  quality?: AsrQuality;
}

const HAN_OR_WORD = /[\p{L}\p{N}\p{Script=Han}]/u;

function compactText(value: string): string {
  return Array.from(value.normalize('NFKC').toLocaleLowerCase())
    .filter((character) => HAN_OR_WORD.test(character))
    .join('');
}

function hasRepeatedCycle(value: string, cycleLength: number): boolean {
  if (value.length < cycleLength * 4) return false;
  const cycle = value.slice(0, cycleLength);
  for (let index = cycleLength; index < value.length; index += cycleLength) {
    if (value.slice(index, index + cycleLength) !== cycle) return false;
  }
  return true;
}

/** Return true only for strong, high-signal evidence of decoder degeneration. */
export function isDegenerateAsrText(value: string): boolean {
  const compact = compactText(value);
  if (compact.length < 8) return false;

  // A single character repeated at least eight times is never useful as a
  // classroom sentence. Keep the threshold high so “哈哈哈哈” or “不不不”
  // spoken naturally is not thrown away.
  const counts = new Map<string, number>();
  for (const character of compact) counts.set(character, (counts.get(character) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  if (maxCount >= 8 && maxCount / compact.length >= 0.8) return true;

  // Whisper may repeat a short token or 2–3-character phrase instead of one
  // glyph, especially on silence. Restrict this to compact, exact cycles.
  if (hasRepeatedCycle(compact, 1) || hasRepeatedCycle(compact, 2) || hasRepeatedCycle(compact, 3)) return true;

  const words = value.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 8 && new Set(words).size === 1) return true;
  return false;
}

export function sanitizeAsrResult<T extends AsrChunkLike>(result: { text?: string; chunks?: T[] }): SanitizedAsrResult<T> {
  const sourceChunks = result.chunks ?? [];
  const chunks = sourceChunks.filter((chunk) => Boolean(chunk.text?.trim()) && !isDegenerateAsrText(chunk.text));
  const rejectedSegments = sourceChunks.length - chunks.length;
  const text = result.text?.trim() && !isDegenerateAsrText(result.text) ? result.text.trim() : '';
  if (!rejectedSegments && text) return { text, chunks };
  return {
    text,
    chunks,
    quality: rejectedSegments || result.text?.trim() ? {
      rejectedSegments,
      ...(rejectedSegments ? { reason: '识别结果疑似重复幻觉，已丢弃异常字幕' } : {}),
    } : undefined,
  };
}
