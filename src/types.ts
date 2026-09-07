export type AppPage = 'home' | 'recorder' | 'library' | 'settings';

export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'complete';

export type RecordingMode = 'en-zh' | 'zh';

export type AnalysisStatus = 'idle' | 'queued' | 'transcribing' | 'summarizing' | 'ready' | 'error';

export type KeyMessageCategory = 'concept' | 'emphasis' | 'assignment' | 'exam' | 'question' | 'admin';

export type SummaryTemplate = 'standard' | 'lecture' | 'seminar';

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string;
  source: string;
  translation: string;
  confidence?: number;
}

export interface KeyMessage {
  sourceRecordingId?: string;
  id: string;
  startMs: number;
  endMs: number;
  category: KeyMessageCategory;
  title: string;
  detail: string;
  sourceSegmentId: string;
  score: number;
}

export interface BriefItem {
  sourceRecordingId?: string;
  due?: string;
  id: string;
  text: string;
  atMs: number;
  sourceSegmentId?: string;
}

export interface ClassBrief {
  overview: string;
  sections: {
    concepts: BriefItem[];
    takeaways: BriefItem[];
    assignments: BriefItem[];
    examReading: BriefItem[];
    followUps: BriefItem[];
  };
  generatedAt: string;
  sourceSegmentCount: number;
  engine: 'local-rules' | 'openai' | 'codex';
  model?: string;
  threadId?: string;
  template: SummaryTemplate;
}

export interface TimestampNote {
  id: string;
  atMs: number;
  text: string;
}

export interface Course {
  id: string;
  name: string;
  term: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface Bookmark {
  id: string;
  atMs: number;
  label: string;
}

export interface RecordingSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  status: RecordingStatus;
  analysisStatus: AnalysisStatus;
  analysisError?: string;
  aiError?: string;
  summaryScope?: 'recording' | 'class' | 'course';
  recordingMode: RecordingMode;
  sourceLanguage: string;
  targetLanguage: string;
  courseId?: string;
  batchId?: string;
  sourceFileName?: string;
  segments: TranscriptSegment[];
  notes: TimestampNote[];
  bookmarks: Bookmark[];
  keyMessages: KeyMessage[];
  classBrief?: ClassBrief;
  audioBlob?: Blob;
  audioMimeType?: string;
}

export type TranslationPreference = 'auto' | 'browser' | 'local';

export interface AppSettings {
  autoTranslate: boolean;
  autoKeyMessages: boolean;
  autoAnalyzeUploads: boolean;
  recordingMode: RecordingMode;
  sourceLanguage: string;
  targetLanguage: string;
  translationPreference: TranslationPreference;
  preciseModel: 'tiny' | 'base';
  summaryTemplate: SummaryTemplate;
  aiProvider: 'local' | 'codex';
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoTranslate: true,
  autoKeyMessages: true,
  autoAnalyzeUploads: true,
  recordingMode: 'en-zh',
  sourceLanguage: 'en-US',
  targetLanguage: 'zh-CN',
  translationPreference: 'auto',
  preciseModel: 'tiny',
  summaryTemplate: 'standard',
  aiProvider: 'codex',
};

export interface ModelProgress {
  label: string;
  progress?: number;
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'working' | 'error';
}
