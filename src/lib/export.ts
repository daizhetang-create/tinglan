import type { BriefItem, KeyMessageCategory, RecordingSession } from '../types';
import { formatClock, formatSrtTime } from './format';

const KEY_MESSAGE_LABELS: Record<KeyMessageCategory, string> = {
  concept: '核心概念',
  emphasis: '重点强调',
  assignment: '作业要求',
  exam: '考试相关',
  question: '问题与讨论',
  admin: '课程安排',
};

const BRIEF_SECTION_LABELS = {
  concepts: '核心概念',
  takeaways: '关键结论',
  assignments: '作业与截止事项',
  examReading: '考试与阅读',
  followUps: '待跟进',
} as const;

function safeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').trim() || '课堂记录';
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function markdownKeyMessages(recording: RecordingSession): string[] {
  const messages = recording.keyMessages ?? [];
  if (!messages.length) return ['## Key Messages', '', '- 暂无关键消息', ''];
  return [
    '## Key Messages',
    '',
    ...messages.flatMap((message) => [
      `- **${formatClock(message.startMs)} · ${KEY_MESSAGE_LABELS[message.category]} · ${message.title}**`,
      `  ${message.detail}`,
    ]),
    '',
  ];
}

function markdownBriefItems(items: BriefItem[]): string[] {
  return items.length ? items.map((item) => `- **${formatClock(item.atMs)}** ${item.text}`) : ['- 暂无'];
}

function markdownClassBrief(recording: RecordingSession): string[] {
  const brief = recording.classBrief;
  if (!brief) return ['## Class Brief', '', '尚未生成课堂纪要。', ''];
  return [
    '## Class Brief',
    '',
    brief.overview || '暂无概览。',
    '',
    ...Object.entries(BRIEF_SECTION_LABELS).flatMap(([key, label]) => [
      `### ${label}`,
      '',
      ...markdownBriefItems(brief.sections[key as keyof typeof brief.sections]),
      '',
    ]),
    `> 生成时间：${new Date(brief.generatedAt).toLocaleString('zh-CN')} · 引擎：${brief.engine} · 来源片段：${brief.sourceSegmentCount}`,
    '',
  ];
}

function textKeyMessages(recording: RecordingSession): string {
  const messages = recording.keyMessages ?? [];
  if (!messages.length) return 'KEY MESSAGES\n暂无关键消息';
  return [
    'KEY MESSAGES',
    ...messages.map(
      (message) =>
        `[${formatClock(message.startMs)}] ${KEY_MESSAGE_LABELS[message.category]} · ${message.title}\n${message.detail}`,
    ),
  ].join('\n\n');
}

function textBriefItems(items: BriefItem[]): string[] {
  return items.length ? items.map((item) => `- [${formatClock(item.atMs)}] ${item.text}`) : ['- 暂无'];
}

function textClassBrief(recording: RecordingSession): string {
  const brief = recording.classBrief;
  if (!brief) return 'CLASS BRIEF\n尚未生成课堂纪要。';
  return [
    'CLASS BRIEF',
    brief.overview || '暂无概览。',
    ...Object.entries(BRIEF_SECTION_LABELS).flatMap(([key, label]) => [
      '',
      label.toUpperCase(),
      ...textBriefItems(brief.sections[key as keyof typeof brief.sections]),
    ]),
  ].join('\n');
}

export function exportRecording(recording: RecordingSession, format: 'md' | 'txt' | 'srt' | 'json'): void {
  const base = safeFilename(recording.title);
  let content = '';
  let mime = 'text/plain;charset=utf-8';

  if (format === 'md') {
    const language = recording.recordingMode === 'zh'
      ? '中文'
      : `${recording.sourceLanguage} → ${recording.targetLanguage}`;
    content = [
      `# ${recording.title}`,
      '',
      `- 创建时间：${new Date(recording.createdAt).toLocaleString('zh-CN')}`,
      `- 时长：${formatClock(recording.durationMs)}`,
      `- 语言：${language}`,
      '',
      ...markdownKeyMessages(recording),
      ...markdownClassBrief(recording),
      '## 双语转写',
      '',
      ...recording.segments.flatMap((segment) => [
        `**${formatClock(segment.startMs)} · ${segment.speaker}**`,
        '',
        segment.source,
        '',
        segment.translation ? `> ${segment.translation}` : '> （暂无译文）',
        '',
      ]),
      '## 时间戳笔记',
      '',
      ...(recording.notes.length
        ? recording.notes.map((note) => `- **${formatClock(note.atMs)}** ${note.text}`)
        : ['- 暂无笔记']),
    ].join('\n');
    mime = 'text/markdown;charset=utf-8';
  }

  if (format === 'txt') {
    const transcript = recording.segments
      .map(
        (segment) =>
          `[${formatClock(segment.startMs)}] ${segment.speaker}\n${segment.source}\n${segment.translation || '（暂无译文）'}`,
      )
      .join('\n\n');
    content = [textKeyMessages(recording), textClassBrief(recording), 'TRANSCRIPT', transcript || '暂无转写'].join(
      '\n\n',
    );
  }

  if (format === 'srt') {
    content = recording.segments
      .map((segment, index) => {
        const end = Math.max(segment.endMs, segment.startMs + 1500);
        const bilingual = segment.translation ? `${segment.source}\n${segment.translation}` : segment.source;
        return `${index + 1}\n${formatSrtTime(segment.startMs)} --> ${formatSrtTime(end)}\n${bilingual}`;
      })
      .join('\n\n');
  }

  if (format === 'json') {
    content = JSON.stringify(
      {
        ...recording,
        audioBlob: recording.audioBlob
          ? { type: recording.audioBlob.type, size: recording.audioBlob.size, exportedSeparately: true }
          : undefined,
      },
      null,
      2,
    );
    mime = 'application/json;charset=utf-8';
  }

  download(new Blob([content], { type: mime }), `${base}.${format}`);
}

export function exportAudio(recording: RecordingSession): void {
  if (!recording.audioBlob) return;
  const extension = recording.audioMimeType?.includes('mp4')
    ? 'm4a'
    : recording.audioMimeType?.includes('ogg')
      ? 'ogg'
      : 'webm';
  download(recording.audioBlob, `${safeFilename(recording.title)}.${extension}`);
}
