import type {
  BriefItem,
  ClassBrief,
  KeyMessage,
  KeyMessageCategory,
  SummaryTemplate,
  TimestampNote,
  TranscriptSegment,
} from '../types';

export const KEY_MESSAGE_LABELS: Record<KeyMessageCategory, string> = {
  concept: '核心概念',
  emphasis: '老师强调',
  assignment: '作业',
  exam: '考试 / 阅读',
  question: '待确认',
  admin: '其他事务',
};

export const BRIEF_SECTION_LABELS: Record<keyof ClassBrief['sections'], string> = {
  concepts: '核心概念',
  takeaways: '老师强调 / 结论',
  assignments: '作业与截止日期',
  examReading: '考试与阅读提示',
  followUps: '待复习 / 其他事务',
};

const RULES: ReadonlyArray<{
  category: KeyMessageCategory;
  score: number;
  patterns: readonly RegExp[];
}> = [
  {
    category: 'assignment',
    score: 10,
    patterns: [
      /作业|课后练习|习题|提交|上交|交作业|截止|交稿|预习/,
      /论文|报告|课程项目|小组项目|阅读.{0,8}(?:章|页|材料|文章|文献)/,
      /\b(?:homework|assignment|coursework|exercise|essay|paper|report|project)\b/i,
      /\b(?:submit|submission|deadline)\b|\b(?:turn|hand)\s+in\b|\bdue\s+(?:on|by|next|this|tomorrow|monday|tuesday|wednesday|thursday|friday|\d)/i,
      /\b(?:read|prepare)\s+(?:chapter|chapters|page|pages|the article|the paper|the material)/i,
    ],
  },
  {
    category: 'exam',
    score: 9,
    patterns: [
      /考试|考点|测验|小测|期中|期末|必考|会考|复习范围|考试范围|开卷|闭卷/,
      /\b(?:quiz|exam|examination|midterm|finals|test)\b|\bfinal\s+(?:exam|test)\b/i,
      /\b(?:on|in|for)\s+the\s+(?:quiz|exam|test)\b|\bwill\s+be\s+tested\b/i,
      /\b(?:open|closed)[ -]?book\b|\b(?:revision|review)\s+(?:topic|topics|scope|material)\b/i,
    ],
  },
  {
    category: 'emphasis',
    score: 8,
    patterns: [
      /重点|注意|记住|务必|尤其|关键|核心|结论|总之|最重要|强调|千万不要|一定要/,
      /\b(?:important|remember|crucial|essential|notably)\b/i,
      /\bkey\s+(?:point|idea|takeaway)\b|\bpay\s+attention\b|\bnote\s+that\b/i,
      /\bin\s+conclusion\b|\bthe\s+main\s+(?:point|idea|takeaway)\b|\bmost\s+important\b/i,
    ],
  },
  {
    category: 'concept',
    score: 7,
    patterns: [
      /定义|是指|意味着|本质|概念|原理|机制|特征|区别在于|不同之处/,
      /原因是|由于|因而|因此|所以|换句话说|也就是说/,
      /\b(?:define|definition|concept|principle|mechanism)\b|\bdefined\s+as\b/i,
      /\b(?:means?\s+that|refers?\s+to|in\s+other\s+words)\b/i,
      /\b(?:because|therefore|thus|consequently)\b|\bthe\s+difference\s+between\b/i,
    ],
  },
  {
    category: 'admin',
    score: 6,
    patterns: [
      /下周|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|日期|时间|地点|教室/,
      /调课|停课|补课|答疑|课程安排|上课安排|通知|签到|考勤/,
      /\b(?:next\s+week|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\b(?:schedule|reschedule|cancelled|canceled|room|venue|attendance|announcement)\b/i,
      /\boffice\s+hours?\b|\bclass\s+(?:time|location|is\s+(?:cancelled|canceled))\b/i,
    ],
  },
  {
    category: 'question',
    score: 5,
    patterns: [
      /[?？]/,
      /为什么|如何|怎么|是否|什么是|不明白|没听懂|能否|可不可以|谁知道/,
      /\b(?:any|a|one)\s+questions?\b|\bI\s+(?:do\s+not|don't|didn't)\s+understand\b/i,
      /\b(?:could|can)\s+you\s+(?:explain|repeat|clarify)\b|\bwhat\s+does\b/i,
      /(?:^|[.!?]\s+)(?:why|how|what|when|where|who|which)\b/i,
    ],
  },
];

function displayText(segment: TranscriptSegment): string {
  const translation = segment.translation.trim();
  return translation || segment.source.trim();
}

function searchableText(segment: TranscriptSegment): string {
  const source = segment.source.trim();
  const translation = segment.translation.trim();
  if (!source) return translation;
  if (!translation || translation === source) return source;
  return `${source} ${translation}`;
}

function cleanTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').replace(/^[，。；：、,.!?\s]+/, '').trim();
  const firstSentence = compact.split(/(?<=[。！？.!?])\s*/)[0] || compact;
  return firstSentence.length > 56 ? `${firstSentence.slice(0, 55)}…` : firstSentence;
}

function classify(segment: TranscriptSegment, index: number): { category: KeyMessageCategory; score: number } | undefined {
  const text = searchableText(segment);
  if (!text) return undefined;

  let best: { category: KeyMessageCategory; score: number } | undefined;
  for (const rule of RULES) {
    const matches = rule.patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
    if (!matches) continue;
    const candidate = { category: rule.category, score: rule.score + Math.min(matches - 1, 2) };
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best && index < 3 && text.length >= 36) return { category: 'concept', score: 4 - index * 0.2 };
  if (!best && text.length >= 86 && /因为|所以|但是|同时|包括|首先|其次|because|therefore|however|includes|first|second/i.test(text)) {
    return { category: 'concept', score: 4 };
  }
  return best;
}

function normalizeForComparison(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function makeBigrams(value: string): Set<string> {
  if (!value) return new Set<string>();
  if (value.length < 3) return new Set([value]);

  const chunks = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) chunks.add(value.slice(index, index + 2));
  return chunks;
}

function similarity(a: string, b: string): number {
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;

  const shorter = normalizedA.length <= normalizedB.length ? normalizedA : normalizedB;
  const longer = shorter === normalizedA ? normalizedB : normalizedA;
  if (shorter.length >= 8 && longer.includes(shorter) && shorter.length / longer.length >= 0.65) return 0.94;

  const left = makeBigrams(normalizedA);
  const right = makeBigrams(normalizedB);
  let intersection = 0;
  left.forEach((item) => right.has(item) && (intersection += 1));
  return intersection / (left.size + right.size - intersection);
}

export function extractKeyMessages(segments: TranscriptSegment[], limit = 8): KeyMessage[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 8;
  if (safeLimit === 0) return [];

  const candidates = segments
    .map((segment, index) => {
      const classification = classify(segment, index);
      if (!classification) return undefined;
      const detail = displayText(segment);
      if (!detail) return undefined;
      return {
        id: `key-${segment.id}-${classification.category}`,
        startMs: segment.startMs,
        endMs: segment.endMs,
        category: classification.category,
        title: cleanTitle(detail),
        detail,
        sourceSegmentId: segment.id,
        score: classification.score,
      } satisfies KeyMessage;
    })
    .filter((item): item is KeyMessage => Boolean(item))
    .sort((a, b) => b.score - a.score || a.startMs - b.startMs);

  const unique: KeyMessage[] = [];
  for (const item of candidates) {
    const duplicate = unique.some((existing) => {
      const textSimilarity = similarity(existing.detail, item.detail);
      return textSimilarity >= (existing.category === item.category ? 0.72 : 0.9);
    });
    if (duplicate) continue;
    unique.push(item);
    if (unique.length >= safeLimit) break;
  }
  return unique.sort((a, b) => a.startMs - b.startMs);
}

function asBriefItem(message: KeyMessage): BriefItem {
  return {
    id: `brief-${message.id}`,
    text: message.detail,
    atMs: message.startMs,
    sourceSegmentId: message.sourceSegmentId,
  };
}

function uniqueItems(items: BriefItem[], limit: number): BriefItem[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (safeLimit === 0) return [];

  const output: BriefItem[] = [];
  for (const item of items) {
    const text = item.text.trim();
    if (!text || output.some((existing) => similarity(existing.text, text) >= 0.72)) continue;
    output.push({ ...item, text });
    if (output.length >= safeLimit) break;
  }
  return output;
}

export function buildClassBrief(
  segments: TranscriptSegment[],
  keyMessages: KeyMessage[],
  notes: TimestampNote[],
  template: SummaryTemplate,
): ClassBrief {
  const meaningful = segments.filter((segment) => displayText(segment).length >= 10);
  const overviewLimit = template === 'seminar' ? 3 : 2;
  const overviewParts: string[] = [];
  for (const segment of meaningful) {
    const text = displayText(segment);
    if (overviewParts.some((existing) => similarity(existing, text) >= 0.72)) continue;
    overviewParts.push(text);
    if (overviewParts.length >= overviewLimit) break;
  }
  const fallbackConcepts = meaningful.slice(0, 4).map((segment) => ({
    id: `brief-fallback-${segment.id}`,
    text: displayText(segment),
    atMs: segment.startMs,
    sourceSegmentId: segment.id,
  }));

  const byCategory = (categories: KeyMessageCategory[]) =>
    keyMessages.filter((message) => categories.includes(message.category)).map(asBriefItem);

  const noteItems: BriefItem[] = notes.map((note) => ({
    id: `brief-note-${note.id}`,
    text: note.text,
    atMs: note.atMs,
  }));
  const conceptItems = byCategory(['concept']);

  return {
    overview: overviewParts.join(' ') || '当前还没有足够的转写内容来生成课堂概览。',
    sections: {
      concepts: uniqueItems(conceptItems.length ? conceptItems : fallbackConcepts, 6),
      takeaways: uniqueItems(byCategory(['emphasis']), 6),
      assignments: uniqueItems(byCategory(['assignment']), 8),
      examReading: uniqueItems(byCategory(['exam']), 6),
      followUps: uniqueItems([...byCategory(['question', 'admin']), ...noteItems], 8),
    },
    generatedAt: new Date().toISOString(),
    sourceSegmentCount: segments.length,
    engine: 'local-rules',
    template,
  };
}

export function enrichWithFocusNotes<T extends {
  segments: TranscriptSegment[];
  notes: TimestampNote[];
  keyMessages: KeyMessage[];
  classBrief?: ClassBrief;
}>(recording: T, template: SummaryTemplate, includeBrief: boolean): T {
  const keyMessages = extractKeyMessages(recording.segments);
  return {
    ...recording,
    keyMessages,
    classBrief: includeBrief
      ? buildClassBrief(recording.segments, keyMessages, recording.notes, template)
      : recording.classBrief,
  };
}
