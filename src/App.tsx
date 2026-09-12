import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveTranscriber } from './features/recorder/liveTranscriber';
import { acquireWorkspaceLock } from './features/recorder/workspaceLock';
import { getCodexStatus, startCodexLogin, generateCodexNotes, type CodexStatus } from './features/assistant/codex';
import { transcribeRecording } from './features/workflow/transcribe';
import { abortable } from './features/workflow/abortable';
import { backupLocalData, restoreLocalData } from './features/storage/backup';
import { recoverInterruptedRecording } from './features/storage/classRecords';
import { Icon } from './components/Icon';
import { StudyLibrary } from './features/study/StudyLibrary';
import { syncRecordingVault } from './features/study/vault';
import { Toggle } from './components/Toggle';
import { chooseRecordingMimeType, getAudioDuration } from './lib/audio';
import {
  clearLocalData,
  beginCaptureJournal,
  discardEmptyCaptureJournal,
  appendCaptureChunk,
  finishCaptureJournal,
  recoverCaptureJournals,
  DEFAULT_COURSE_ID,
  deleteCourse,
  deleteRecording,
  listCourses,
  listRecordings,
  loadSettings,
  saveCourse,
  saveRecording,
  saveSettings,
} from './lib/db';
import { exportAudio, exportRecording } from './lib/export';
import {
  BRIEF_SECTION_LABELS,
  KEY_MESSAGE_LABELS,
  enrichWithFocusNotes,
  extractKeyMessages,
} from './lib/focusNotes';
import { defaultRecordingTitle, formatClock, formatShortDate, makeId } from './lib/format';
import { TranslationService } from './lib/translation';
import {
  DEFAULT_SETTINGS,
  type AppPage,
  type AppSettings,
  type Course,
  type ModelProgress,
  type RecordingMode,
  type RecordingSession,
  type TranscriptSegment,
} from './types';

interface SpeechAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechResultLike {
  isFinal: boolean;
  [index: number]: SpeechAlternativeLike;
}

interface SpeechEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechResultLike>;
}

interface SpeechErrorLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechErrorLike) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type InputSource = 'microphone' | 'system';
type NotesTab = 'keys' | 'brief' | 'notes';
type BriefFilter = 'all' | 'assignments' | 'exam';
type CourseFilter = 'all' | 'unfiled' | string;

interface BatchProgress {
  total: number;
  completed: number;
  currentName: string;
  failed: number;
}

const COURSE_COLORS = ['#2ebd93', '#7c6df2', '#f16f61', '#e5a73c', '#4596e6', '#c25aa8'];

const DEFAULT_LEVELS = Array.from({ length: 34 }, (_, index) => 0.12 + ((index * 7) % 9) / 45);

const DEMO_SEGMENTS: TranscriptSegment[] = [
  {
    id: 'demo-1',
    startMs: 4_000,
    endMs: 12_000,
    speaker: '讲师',
    source: 'Today we are going to look at how memory changes when we learn in a second language.',
    translation: '今天我们来看看，当我们用第二语言学习时，记忆会发生怎样的变化。',
    confidence: 0.94,
  },
  {
    id: 'demo-2',
    startMs: 15_000,
    endMs: 27_000,
    speaker: '讲师',
    source: 'The important point is not to translate every word. Try to capture the relationship between ideas.',
    translation: '重点不是翻译每一个单词，而是抓住观点之间的关系。',
    confidence: 0.91,
  },
  {
    id: 'demo-3',
    startMs: 31_000,
    endMs: 42_000,
    speaker: '讲师',
    source: 'I will upload the reading list after class, and the first response paper is due next Friday.',
    translation: '我会在课后上传阅读清单，第一篇回应论文下周五截止。',
    confidence: 0.96,
  },
  {
    id: 'demo-4',
    startMs: 46_000,
    endMs: 58_000,
    speaker: '同学',
    source: 'Could you explain whether the references are included in the word count?',
    translation: '您能说明一下参考文献是否计入字数吗？',
    confidence: 0.89,
  },
];

function createSession(settings: AppSettings, title = defaultRecordingTitle(), courseId?: string): RecordingSession {
  const now = new Date().toISOString();
  return {
    id: makeId('recording'),
    title,
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    status: 'idle',
    analysisStatus: 'idle',
    recordingMode: settings.recordingMode,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    courseId,
    segments: [],
    notes: [],
    bookmarks: [],
    keyMessages: [],
  };
}

function upsertRecording(items: RecordingSession[], recording: RecordingSession): RecordingSession[] {
  return [recording, ...items.filter((item) => item.id !== recording.id)].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function App() {
  const [page, setPage] = useState<AppPage>('home');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [recordings, setRecordings] = useState<RecordingSession[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [active, setActive] = useState<RecordingSession | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [startupError, setStartupError] = useState('');
  const [startingRecording, setStartingRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [interimText, setInterimText] = useState('');
  const [levels, setLevels] = useState(DEFAULT_LEVELS);
  const [inputSource, setInputSource] = useState<InputSource>('microphone');
  const [runtimeNotice, setRuntimeNotice] = useState('准备就绪，数据默认保存在这台设备');
  const [translationProgress, setTranslationProgress] = useState<ModelProgress>({
    label: '翻译待命',
    state: 'idle',
  });
  const [preciseProgress, setPreciseProgress] = useState<ModelProgress>({
    label: '精确转写待命',
    state: 'idle',
  });
  const [noteDraft, setNoteDraft] = useState('');
  const [notesTab, setNotesTab] = useState<NotesTab>('keys');
  const [briefFilter, setBriefFilter] = useState<BriefFilter>('all');
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [showTranscriptSearch, setShowTranscriptSearch] = useState(false);
  const [confirmTranscription, setConfirmTranscription] = useState(false);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [mobilePane, setMobilePane] = useState<'transcript' | 'notes'>('transcript');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [courseFilter, setCourseFilter] = useState<CourseFilter>('all');
  const [showCourseDialog, setShowCourseDialog] = useState(false);
  const [courseName, setCourseName] = useState('');
  const [courseTerm, setCourseTerm] = useState('');
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [toast, setToast] = useState('');
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [editingSegment, setEditingSegment] = useState<TranscriptSegment | null>(null);
  const [editSource, setEditSource] = useState('');
  const [editTranslation, setEditTranslation] = useState('');

  const [aiStatus, setAiStatus] = useState<CodexStatus>({connected:false,authenticated:false,model:'gpt-5.6-luna',message:'正在检查本机 Codex'});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStream, setAiStream] = useState('');
  const [assistantAnswer, setAssistantAnswer] = useState('');
  const [summaryScope, setSummaryScope] = useState<'recording'|'class'|'course'>('recording');
  const [processingBusy, setJobBusy] = useState(false);
  const [studyBusy, setStudyBusy] = useState(false);
  const studyBusyRef = useRef(false);
  const studyCancelRef = useRef<(() => void) | null>(null);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const jobBusy = processingBusy || studyBusy;
  const liveRef = useRef<LiveTranscriber|null>(null);
  const liveFailedRef = useRef(false);
  const recordsRef = useRef<RecordingSession[]>([]);
  const analysisAbortRef = useRef<AbortController|null>(null);
  const aiAbortRef = useRef<AbortController|null>(null);
  const liveAiAtRef = useRef(0);
  const liveAiPromiseRef = useRef<Promise<unknown>|null>(null);
  const liveTranslationsRef = useRef(new Set<Promise<void>>());
  const finalizingRef = useRef(false);
  const finalizeAbortRef = useRef<AbortController|null>(null);
  const importRunningRef = useRef(false);
  const cancelBatchRef = useRef(false);
  const aiJobRef = useRef(false);
  const onRecordedRef = useRef<(recording:RecordingSession)=>Promise<void>>(async()=>{});
  const importBatchRef = useRef<string|undefined>(undefined);
  const backupInputRef = useRef<HTMLInputElement|null>(null);
  const pendingSeekRef = useRef<number|null>(null);
  const activeRef = useRef<RecordingSession | null>(null);
  const elapsedRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const startingRef = useRef(false);
  const captureFreezeRef = useRef<(() => void) | null>(null);
  const workspaceReleaseRef = useRef<(() => void) | null>(null);
  const recordingStartedAtRef = useRef(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantsSpeechRef = useRef(false);
  const translationServiceRef = useRef<TranslationService | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importCourseRef = useRef<string | undefined>(undefined);

  const speechRecognitionConstructor = useMemo(() => {
    const browserWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
  }, []);

  useEffect(() => { recordsRef.current=recordings; },[recordings]);
  const refreshCodex = useCallback(async()=> {
    try {setAiStatus(await getCodexStatus());}
    catch(error) {setAiStatus({connected:false,authenticated:false,model:'gpt-5.6-luna',message:error instanceof Error?error.message:'本机 Codex 服务未启动'});}
  },[]);
  useEffect(()=>{void refreshCodex();},[refreshCodex]);

  const webGpuAvailable = 'gpu' in navigator;
  const recordingSupported = 'MediaRecorder' in window && Boolean(navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    void (async () => {
      release = await acquireWorkspaceLock();
      // StrictMode can briefly overlap the previous effect's asynchronous release.
      if (!release && !cancelled) { await new Promise(resolve => setTimeout(resolve, 60)); if (!cancelled) release = await acquireWorkspaceLock(); }
      if (cancelled) { release?.(); return; }
      if (!release) { setStartupError('听澜已在另一个窗口打开。为保护正在保存的录音，请使用原窗口，或关闭原窗口后重试。'); return; }
      workspaceReleaseRef.current = release;
      const recovered = await recoverCaptureJournals();
      const [savedRecordings, savedCourses, savedSettings] = await Promise.all([listRecordings(), listCourses(), loadSettings()]);
        if (cancelled) return;
        const upgradedRecordings = savedRecordings.map(recording => recoverInterruptedRecording(recording));
        setRecordings(upgradedRecordings);
        await Promise.all(upgradedRecordings
          .filter((recording, index) => recording !== savedRecordings[index])
          .map((recording) => saveRecording(recording)));
        setCourses(savedCourses.filter((course) => course.id !== DEFAULT_COURSE_ID));
        setSettings(savedSettings);
        setHydrated(true);
        if (recovered) setRuntimeNotice(`已恢复 ${recovered} 段意外中断的录音，请在最近记录中核对并重试转写。`);
    })().catch((error) => {
        if (!cancelled) {
          setStartupError(error instanceof Error ? error.message : '本地数据库不可用，请确认存储空间和浏览器权限。');
        }
      });
    navigator.storage?.persist?.().catch(() => false);
    return () => {
      cancelled = true;
      release?.();
      if (workspaceReleaseRef.current === release) workspaceReleaseRef.current = null;
    };
  }, []);

  useEffect(() => {
    const service = new TranslationService(settings.translationPreference, setTranslationProgress);
    translationServiceRef.current = service;
    return () => {
      service.dispose();
      if (translationServiceRef.current === service) translationServiceRef.current = null;
    };
    // The service keeps model instances alive; preference updates through setPreference below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    translationServiceRef.current?.setPreference(settings.translationPreference);
    if (hydrated) saveSettings(settings).catch(() => setToast('设置保存失败'));
  }, [settings, hydrated]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    elapsedRef.current = elapsedMs;
  }, [elapsedMs]);

  useEffect(() => {
    if (!hydrated || !active) return;
    const latest = activeRef.current;
    if (!latest || latest.id !== active.id) return;
    // Queue immediately; navigation must not discard an outstanding debounced edit.
    // Completion only reports failures, never writes an older snapshot back to React.
    saveRecording(latest).catch(() => setToast('本地自动保存失败'));
  }, [active, hydrated]);

  useEffect(() => {
    if (!active?.audioBlob) {
      setAudioUrl('');
      setAudioPlaying(false);
      return;
    }
    const url = URL.createObjectURL(active.audioBlob);
    setAudioUrl(url);
    setAudioPlaying(false);
    return () => URL.revokeObjectURL(url);
  }, [active?.id, active?.audioBlob]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [page]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        setShowTranscriptSearch(false);
        setTranscriptQuery('');
        setShowExport(false);
        setEditingSegment(null);
        setConfirmTranscription(false);
        setShowCourseDialog(false);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => {
    if (active?.status !== 'recording') return;
    const timer = window.setInterval(() => {
      setElapsedMs(Math.max(0, performance.now() - recordingStartedAtRef.current));
    }, 160);
    return () => window.clearInterval(timer);
  }, [active?.status]);

  useEffect(() => {
    const protectRecording = (event: BeforeUnloadEvent) => {
      if (startingRef.current || finalizingRef.current || mediaRecorderRef.current?.state === 'recording' || mediaRecorderRef.current?.state === 'paused') {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protectRecording);
    return () => {
      window.removeEventListener('beforeunload', protectRecording);
      wantsSpeechRef.current = false;
      recognitionRef.current?.abort();
      liveRef.current?.dispose();
      analysisAbortRef.current?.abort();
      aiAbortRef.current?.abort();
      captureFreezeRef.current?.();
      mediaRecorderRef.current?.state !== 'inactive' && mediaRecorderRef.current?.stop();
      captureStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      audioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  const updateActive = useCallback((updater: (recording: RecordingSession) => RecordingSession) => {
    if (!activeRef.current) return;
    const next={...updater(activeRef.current),updatedAt:new Date().toISOString()};
    activeRef.current=next;
    recordsRef.current=upsertRecording(recordsRef.current,next);
    setRecordings(items=>upsertRecording(items,next));
    // Enqueue before another click can switch active records in the same render batch.
    void saveRecording(next).catch(()=>setToast('本地自动保存失败'));
    setActive(next);
  }, []);

  const persistRecording = useCallback(async(recording:RecordingSession) => {
    const next={...recording,updatedAt:new Date().toISOString()};
    recordsRef.current=upsertRecording(recordsRef.current,next);
    setRecordings(items=>upsertRecording(items,next));
    if(activeRef.current?.id===next.id){activeRef.current=next;setActive(next);}
    await saveRecording(next);
    return next;
  },[]);

  const applyRecordingMode = useCallback((mode: RecordingMode) => {
    const sourceLanguage = mode === 'zh' ? 'zh-CN' : 'en-US';
    const targetLanguage = mode === 'zh' ? '' : 'zh-CN';
    setSettings((current) => ({ ...current, recordingMode: mode, sourceLanguage, targetLanguage }));
    if (activeRef.current?.status === 'idle') {
      updateActive((recording) => ({ ...recording, recordingMode: mode, sourceLanguage, targetLanguage }));
    }
  }, [updateActive]);

  const chooseImportFiles = useCallback((courseId?: string) => {
    importCourseRef.current = courseId;
    fileInputRef.current?.click();
  }, []);

  const translateSegment = useCallback(
    async (segmentId: string, source: string, recordingId: string) => {
      if (!settings.autoTranslate || activeRef.current?.recordingMode !== 'en-zh') return;
      try {
        const translation = await translationServiceRef.current?.translate(source);
        if (!translation) return;
        setActive((current) => {
          if (!current || current.id !== recordingId) return current;
          const translated = {
            ...current,
            segments: current.segments.map((segment) =>
              segment.id === segmentId ? { ...segment, translation } : segment,
            ),
          };
          const next = settings.autoKeyMessages && settings.aiProvider === 'local'
            ? enrichWithFocusNotes(translated, settings.summaryTemplate, current.status === 'complete')
            : translated;
          activeRef.current = next;
          return next;
        });
      } catch (error) {
        setRuntimeNotice(error instanceof Error ? error.message : '中文翻译暂时不可用');
      }
    },
    [settings.autoKeyMessages, settings.autoTranslate, settings.summaryTemplate, settings.aiProvider],
  );

  const appendFinalTranscript = useCallback(
    (source: string, confidence = 0) => {
      const current = activeRef.current;
      const clean = source.trim();
      if (!current || !clean) return;
      const endMs = elapsedRef.current;
      const estimatedLength = Math.max(1800, Math.min(12_000, clean.split(/\s+/).length * 420));
      const segment: TranscriptSegment = {
        id: makeId('segment'),
        startMs: Math.max(0, endMs - estimatedLength),
        endMs,
        speaker: '讲师',
        source: clean,
        translation: '',
        confidence,
      };
      updateActive((recording) => {
        const next = { ...recording, segments: [...recording.segments, segment] };
        return settings.autoKeyMessages
          ? { ...next, keyMessages: extractKeyMessages(next.segments) }
          : next;
      });
      setInterimText('');
      if (current.recordingMode === 'en-zh') void translateSegment(segment.id, clean, current.id);
    },
    [settings.autoKeyMessages, translateSegment, updateActive],
  );

  const beginSpeechRecognition = useCallback(() => {
    const recordingId = activeRef.current?.id;
    const ownedRecorder = mediaRecorderRef.current;
    const stillRecording = () => activeRef.current?.id === recordingId && activeRef.current?.status === 'recording' && mediaRecorderRef.current === ownedRecorder && ownedRecorder?.state === 'recording';
    if (!speechRecognitionConstructor || inputSource !== 'microphone' || !stillRecording()) return;
    wantsSpeechRef.current = true;
    const recognition = new speechRecognitionConstructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = settings.sourceLanguage;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      if (!stillRecording() || recognitionRef.current !== recognition) return;
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result[0];
        if (!alternative) continue;
        if (result.isFinal) appendFinalTranscript(alternative.transcript, alternative.confidence);
        else interim += alternative.transcript;
      }
      setInterimText(interim.trim());
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed') {
        setRuntimeNotice('实时字幕权限被拒绝；录音仍会保存，可在结束后运行本地精确转写');
      } else {
        setRuntimeNotice(`实时字幕暂时中断：${event.error}`);
      }
    };
    recognition.onend = () => {
      if (!wantsSpeechRef.current || !stillRecording()) return;
      window.setTimeout(() => {
        if (!wantsSpeechRef.current || !stillRecording() || recognitionRef.current !== recognition) return;
        try {
          recognition.start();
        } catch {
          // A restart may race with the browser's previous recognition session.
        }
      }, 250);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setRuntimeNotice(`正在录音 · 实时${settings.recordingMode === 'zh' ? '中文' : '英文'}字幕已开启`);
    } catch {
      setRuntimeNotice('录音已开始，实时字幕启动失败；结束后仍可精确转写');
    }
  }, [appendFinalTranscript, inputSource, settings.recordingMode, settings.sourceLanguage, speechRecognitionConstructor]);

  const startVisualizer = useCallback((stream: MediaStream) => {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);
    audioContextRef.current = context;
    const data = new Uint8Array(analyser.frequencyBinCount);
    let lastPaint = 0;
    const paint = (timestamp: number) => {
      analyser.getByteFrequencyData(data);
      if (timestamp - lastPaint > 70) {
        const next = DEFAULT_LEVELS.map((_, index) => {
          const sampleIndex = Math.floor((index / DEFAULT_LEVELS.length) * data.length);
          return Math.max(0.08, data[sampleIndex] / 255);
        });
        setLevels(next);
        lastPaint = timestamp;
      }
      animationFrameRef.current = requestAnimationFrame(paint);
    };
    animationFrameRef.current = requestAnimationFrame(paint);
  }, []);

  const releaseCapture = useCallback(() => {
    captureStreamRef.current?.getTracks().forEach((track) => track.stop());
    captureStreamRef.current = null;
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    setLevels(DEFAULT_LEVELS);
  }, []);

  const startRecording = useCallback(async () => {
    if (!hydrated || !workspaceReleaseRef.current || startingRef.current || (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive')) return;
    if (studyBusyRef.current) { setToast('请先完成或取消学习资料处理'); return; }
    if (analysisAbortRef.current || aiJobRef.current || finalizingRef.current) {setToast('请等待当前处理完成或取消后再录音');return;}
    if (!recordingSupported) {
      setToast('当前浏览器不支持录音，请使用最新版 Edge 或 Chrome');
      return;
    }
    startingRef.current = true;
    setStartingRecording(true);
    let current = activeRef.current;
    let journalStarted = false;
    let captureStarted = false;
    if (!current || current.status === 'complete') {
      current = createSession(settings);
      activeRef.current = current;
      setActive(current);
      setElapsedMs(0);
      elapsedRef.current = 0;
    }
    try {
      const capture =
        inputSource === 'system'
          ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
          : await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
      if (!workspaceReleaseRef.current) { capture.getTracks().forEach(track => track.stop()); throw new Error('录音页面已关闭，已取消声音采集'); }
      if (activeRef.current?.id !== current.id) { capture.getTracks().forEach(track => track.stop()); throw new Error('录音页面已切换，请重新开始录音'); }
      if (!capture.getAudioTracks().length) {
        capture.getTracks().forEach((track) => track.stop());
        throw new Error('没有捕获到声音。共享屏幕时请勾选“共享音频”。');
      }
      captureStreamRef.current = capture;
      const audioStream = new MediaStream(capture.getAudioTracks());
      const mimeType = chooseRecordingMimeType();
      const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      const recordingId = current.id;
      const chunks: Blob[] = [];
      let journalWrites = Promise.resolve();
      let sequence = 0;
      let stoppedElapsed = 0;
      const sampleElapsed = () => activeRef.current?.id === recordingId && activeRef.current.status === 'recording'
        ? Math.max(0, performance.now() - recordingStartedAtRef.current) : elapsedRef.current;
      const freezeInput = () => {
        if (mediaRecorderRef.current !== recorder) return;
        stoppedElapsed = sampleElapsed(); elapsedRef.current = stoppedElapsed; setElapsedMs(stoppedElapsed);
        liveRef.current?.pause(); wantsSpeechRef.current = false; recognitionRef.current?.stop();
      };
      captureFreezeRef.current = freezeInput;
      await beginCaptureJournal({ ...current, status: 'recording' }, recorder.mimeType || mimeType || 'audio/webm');
      journalStarted = true;
      if (activeRef.current?.id !== recordingId || !workspaceReleaseRef.current) throw new Error('录音已取消，未启动声音采集');
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        chunks.push(event.data);
        const chunk = { recordingId, sequence: sequence++, blob: event.data, elapsedMs: recorder.state === 'inactive' ? stoppedElapsed : sampleElapsed() };
        journalWrites = journalWrites.then(() => appendCaptureChunk(chunk)).catch(error => {
          setRuntimeNotice(error instanceof Error ? error.message : '录音自动保存失败，请停止并导出音频');
          // The in-memory original remains available; don't continue a whole class without durable storage.
          if (recorder.state !== 'inactive') { freezeInput(); recorder.stop(); }
        });
      };
      recorder.onstop = () => {
        if (!stoppedElapsed) freezeInput();
        releaseCapture();
        finalizingRef.current=true;setJobBusy(true);
        const finalizeController=new AbortController();finalizeAbortRef.current=finalizeController;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        const completed:RecordingSession={...(activeRef.current?.id===recordingId?activeRef.current:current!),durationMs:stoppedElapsed,status:'complete',analysisStatus:'queued',analysisError:undefined,audioBlob:blob,audioMimeType:blob.type};
        activeRef.current=completed;setActive(completed);
        // Cancellation may return to the list before analysis starts. Its copy must own the Blob too.
        recordsRef.current=upsertRecording(recordsRef.current,completed);
        setRecordings(items=>upsertRecording(items,completed));
        setNotesTab('brief');
        setRuntimeNotice('录音结束，正在保存音频并整理剩余字幕…');
        wantsSpeechRef.current=false;
        recognitionRef.current?.stop();
        void (async()=>{
          try {
            await journalWrites;
            await finishCaptureJournal(completed);
            chunks.length = 0;
            try { await abortable(Promise.resolve(liveRef.current?.stop()),finalizeController.signal); } catch { liveFailedRef.current=true; }
            finalizeController.signal.throwIfAborted();
            await abortable(Promise.allSettled([...liveTranslationsRef.current]),finalizeController.signal);
            // Do not wait for a live Codex request. Live key messages are local;
            // the final pass is the single grounded AI summary.
            aiAbortRef.current?.abort();
            finalizeController.signal.throwIfAborted();
            liveRef.current?.dispose();liveRef.current=null;
            const latest=activeRef.current?.id===recordingId?activeRef.current:completed;
            releaseCapture();
            await onRecordedRef.current({...latest,audioBlob:blob,audioMimeType:blob.type,status:'complete',durationMs:completed.durationMs});
          } catch(error) {
            releaseCapture();
            const message=error instanceof Error?error.message:'保存或处理失败，录音仍在当前页面，请先导出音频';
            const latest=activeRef.current?.id===recordingId?activeRef.current:completed;
            await persistRecording({...latest,audioBlob:blob,audioMimeType:blob.type,status:'complete',durationMs:completed.durationMs,analysisStatus:'error',analysisError:message}).catch(()=>setToast('本地保存失败，请立即导出音频'));
            setRuntimeNotice(message);
          } finally { liveRef.current?.dispose();liveRef.current=null;releaseCapture();if(mediaRecorderRef.current===recorder){mediaRecorderRef.current=null;captureFreezeRef.current=null;}finalizeAbortRef.current=null;finalizingRef.current=false;setJobBusy(false); }
        })();
      };
      capture.getAudioTracks()[0].addEventListener('ended', () => {
        if (mediaRecorderRef.current === recorder && recorder.state !== 'inactive') { freezeInput(); recorder.stop(); }
      });
      recorder.start(1000);
      captureStarted = true;
      setStartingRecording(false);
      recordingStartedAtRef.current = performance.now() - elapsedRef.current;
      updateActive((recording) => ({ ...recording, status: 'recording' }));
      startVisualizer(audioStream);
      liveFailedRef.current=false;
      liveAiAtRef.current=0;
      const live = new LiveTranscriber({
        sourceLanguage:current.sourceLanguage,model:'tiny',
        onSegments:(segments)=>{
          if(activeRef.current?.id!==recordingId)return;
          updateActive(recording=>({...recording,segments:[...recording.segments,...segments],keyMessages:settings.aiProvider==='local'?extractKeyMessages([...recording.segments,...segments]):recording.keyMessages}));
          for(const segment of segments) {
            const pending=translateSegment(segment.id,segment.source,recordingId);
            liveTranslationsRef.current.add(pending);
            void pending.finally(()=>liveTranslationsRef.current.delete(pending));
          }
        },
        onProgress:setPreciseProgress,
        onError:(message)=>{liveFailedRef.current=true;setRuntimeNotice(message+'；完整录音会在停止后重新转写。');},
      });
      liveRef.current=live;
      try {await live.start(audioStream);if(recorder.state==='recording')setRuntimeNotice('录音正在分段保存 · 本地实时字幕按语音片段出现，首次使用需等待模型。');}
      catch(error) {liveFailedRef.current=true;live.dispose();if(liveRef.current===live)liveRef.current=null;if(recorder.state==='recording'&&activeRef.current?.id===recordingId){setRuntimeNotice(error instanceof Error?error.message:'实时转写启动失败，停止后将完整转写');if(inputSource==='microphone')beginSpeechRecognition();}}
    } catch (error) {
      const failedRecorder = mediaRecorderRef.current;
      if (failedRecorder && failedRecorder.state !== 'inactive') { captureFreezeRef.current?.(); failedRecorder.stop(); }
      releaseCapture();
      if (journalStarted && !captureStarted && current) await discardEmptyCaptureJournal(current.id).catch(()=>undefined);
      setRuntimeNotice(error instanceof Error ? error.message : '无法开始录音');
      setToast('没有开始录音，请检查麦克风或共享音频权限');
    } finally { startingRef.current = false; setStartingRecording(false); }
  }, [beginSpeechRecognition, hydrated, inputSource, recordingSupported, releaseCapture, settings, startVisualizer, updateActive, persistRecording, translateSegment]);

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    elapsedRef.current = Math.max(0, performance.now() - recordingStartedAtRef.current); setElapsedMs(elapsedRef.current);
    recorder.requestData();
    recorder.pause();
    liveRef.current?.pause();
    wantsSpeechRef.current = false;
    recognitionRef.current?.stop();
    setInterimText('');
    updateActive((recording) => ({ ...recording, status: 'paused' }));
    setRuntimeNotice('录音已暂停');
  }, [updateActive]);

  const resumeRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'paused') return;
    recorder.resume();
    liveRef.current?.resume();
    recordingStartedAtRef.current = performance.now() - elapsedRef.current;
    updateActive((recording) => ({ ...recording, status: 'recording' }));
    if (!liveRef.current && inputSource === 'microphone') beginSpeechRecognition();
    setRuntimeNotice('继续录音');
  }, [beginSpeechRecognition, inputSource, updateActive]);

  const stopRecording = useCallback(() => {
    wantsSpeechRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setInterimText('');
    const recorder = mediaRecorderRef.current;
    captureFreezeRef.current?.();
    liveRef.current?.pause();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else releaseCapture();
  }, [releaseCapture]);

  const openNewRecording = useCallback(() => {
    if (startingRef.current) { setToast('正在等待录音权限，请先完成权限选择'); return; }
    if (studyBusyRef.current) { setToast('请先完成或取消学习资料处理'); return; }
    if(finalizingRef.current||importRunningRef.current){setToast('请等待录音收尾或批量处理结束');return;}
    if (activeRef.current?.status === 'recording' || activeRef.current?.status === 'paused') {
      setToast('请先停止当前录音');
      setPage('recorder');
      return;
    }
    const selectedCourse = courseFilter !== 'all' && courseFilter !== 'unfiled' ? courseFilter : undefined;
    const session = createSession(settings, defaultRecordingTitle(), selectedCourse);
    activeRef.current = session;
    setActive(session);
    setElapsedMs(0);
    setInterimText('');
    setPage('recorder');
  }, [courseFilter, settings]);

  const openRecording = useCallback((recording: RecordingSession) => {
    if (startingRef.current) { setToast('正在等待录音权限，请先完成权限选择'); return; }
    if(finalizingRef.current){setToast('正在保存最后的字幕，请稍候');return;}
    if (
      activeRef.current?.id !== recording.id &&
      (activeRef.current?.status === 'recording' || activeRef.current?.status === 'paused')
    ) {
      setToast('请先停止当前录音');
      return;
    }
    activeRef.current = recording;
    setActive(recording);
    setSummaryScope(recording.summaryScope??'recording');
    setAssistantAnswer('');
    elapsedRef.current = 0;
    setElapsedMs(0);
    setInterimText('');
    setPage('recorder');
  }, []);

  const loadDemo = useCallback(() => {
    if (studyBusyRef.current) { setToast('请先完成或取消学习资料处理'); return; }
    if(finalizingRef.current||importRunningRef.current||analysisAbortRef.current||aiJobRef.current||activeRef.current?.status==='recording'||activeRef.current?.status==='paused'){setToast('请先完成当前处理');return;}
    const session = createSession(settings, '认知心理学 · 示例课堂');
    const demoBase: RecordingSession = {
      ...session,
      status: 'complete',
      analysisStatus: 'ready',
      durationMs: 63_000,
      segments: DEMO_SEGMENTS,
      notes: [
        { id: makeId('note'), atMs: 21_000, text: '记笔记时优先记录观点关系，不要逐字翻译。' },
        { id: makeId('note'), atMs: 36_000, text: '待办：课后查看 reading list；下周五交 response paper。' },
      ],
      bookmarks: [{ id: makeId('bookmark'), atMs: 31_000, label: '作业要求' }],
    };
    const demo = enrichWithFocusNotes(demoBase, settings.summaryTemplate, true);
    activeRef.current = demo;
    setActive(demo);
    elapsedRef.current = 0;
    setElapsedMs(0);
    setNotesTab('keys');
    setPage('recorder');
    setToast('示例已载入，可以体验编辑、笔记与导出');
  }, [settings]);

  const generateNotes = useCallback(async(recording:RecordingSession, scope:'recording'|'class'|'course'='recording', prompt?:string, parentSignal?:AbortSignal, answerOnly=false) => {
    parentSignal?.throwIfAborted();
    if(aiJobRef.current)throw new Error('Codex 正在处理，请稍后重试');
    const all=upsertRecording(recordsRef.current,recording);
    const sources=(scope==='course' && recording.courseId && recording.courseId!==DEFAULT_COURSE_ID
      ? all.filter(item=>item.courseId===recording.courseId)
      : scope==='class' && recording.batchId ? all.filter(item=>item.batchId===recording.batchId) : [recording])
      .filter(item=>item.segments.length).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    if(!sources.length)throw new Error('需要先有转写文字，才能生成纪要');
    const controller=new AbortController();
    const abortFromParent=()=>controller.abort();
    parentSignal?.addEventListener('abort',abortFromParent,{once:true});
    aiAbortRef.current=controller;aiJobRef.current=true;setAiBusy(true);setAiStream('');setAssistantAnswer('');
    try {
      const result=await generateCodexNotes(sources,prompt,text=>setAiStream(value=>(value+text).slice(-12000)),controller.signal);
      const sections:NonNullable<RecordingSession['classBrief']>['sections']={concepts:[],takeaways:[],assignments:[],examReading:[],followUps:[]};
      const mapping={concept:'concepts',emphasis:'takeaways',assignment:'assignments',exam:'examReading',question:'followUps',admin:'followUps'} as const;
      result.items.forEach((item,index)=>sections[mapping[item.category]].push({id:'ai-'+index+'-'+item.sourceSegmentId,text:item.text,atMs:item.atMs,sourceSegmentId:item.sourceSegmentId,sourceRecordingId:item.sourceRecordingId,due:item.due,evidenceQuote:item.evidenceQuote}));
      const latest=activeRef.current?.id===recording.id?activeRef.current:(recordsRef.current.find(item=>item.id===recording.id)??recording);
      // A focused question must not replace the saved, comprehensive classroom summary.
      if(answerOnly){
        const preserved=await persistRecording({...latest,aiError:undefined});
        setAssistantAnswer(result.answer||result.overview);
        setAiStream('');setNotesTab('brief');
        return preserved;
      }
      const finished:RecordingSession={...latest,analysisStatus:latest.status==='recording'||latest.status==='paused'?latest.analysisStatus:'ready',aiError:undefined,summaryScope:scope,
        keyMessages:result.items.map((item,index)=>({id:'ai-key-'+index,category:item.category,title:item.text,detail:item.text,startMs:item.atMs,endMs:item.atMs,sourceSegmentId:item.sourceSegmentId,sourceRecordingId:item.sourceRecordingId,score:10})),
        classBrief:{overview:result.overview,sections,generatedAt:result.generatedAt,engine:'codex',model:result.model,threadId:result.threadId,sourceSegmentCount:sources.reduce((sum,item)=>sum+item.segments.length,0),template:settings.summaryTemplate}};
      await persistRecording(finished);
      if(result.answer)setAssistantAnswer(result.answer);
      setAiStream('');setNotesTab('brief');
      return finished;
    } catch(error) {
      const message=controller.signal.aborted?'已取消 AI 整理，录音和文字已保留，可重试':error instanceof Error?error.message:'Codex 生成失败';
      const latest=activeRef.current?.id===recording.id?activeRef.current:(recordsRef.current.find(item=>item.id===recording.id)??recording);
      await persistRecording({...latest,aiError:message,analysisStatus:latest.status==='recording'||latest.status==='paused'?latest.analysisStatus:'error'});
      throw new Error(message);
    } finally {parentSignal?.removeEventListener('abort',abortFromParent);aiJobRef.current=false;setAiBusy(false);aiAbortRef.current=null;}
  },[persistRecording,settings.summaryTemplate]);

  const analyzeRecording = useCallback(async (recording: RecordingSession, reuseTranscript=false, parentSignal?: AbortSignal): Promise<RecordingSession> => {
    parentSignal?.throwIfAborted();
    if(analysisAbortRef.current)throw new Error('已有转写任务正在处理，请等待或取消');
    const controller=new AbortController();analysisAbortRef.current=controller;setJobBusy(true);
    const abortFromParent = () => controller.abort();
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    let working:RecordingSession={...recording,analysisStatus:'transcribing',analysisError:undefined};
    const saveStage=async(patch:Partial<RecordingSession>)=>{
      const latest=activeRef.current?.id===recording.id?activeRef.current:(recordsRef.current.find(item=>item.id===recording.id)??working);
      return persistRecording({...latest,...patch});
    };
    try {
      const durationMs = recording.durationMs || (recording.audioBlob ? await getAudioDuration(recording.audioBlob).catch(() => 0) : 0);
      controller.signal.throwIfAborted();
      working=await saveStage({durationMs,analysisStatus:'transcribing',analysisError:undefined,aiError:undefined});
      controller.signal.throwIfAborted();
      const reused = reuseTranscript && working.segments.length > 0;
      let nativeCompleted: { durationMs: number; warning?: string } | undefined;
      const segments=reused?working.segments:await transcribeRecording(working,settings.preciseModel,setPreciseProgress,controller.signal,
        async (partial, duration, warning) => {
          if (typeof duration === 'number') nativeCompleted = { durationMs: duration, warning };
          working = await saveStage({ transcriptionDraft: { segments: partial, durationMs: duration, updatedAt: new Date().toISOString() } });
        });
      controller.signal.throwIfAborted();
      working=await saveStage({segments,analysisStatus:'summarizing',...(reused ? {} : {
        durationMs: nativeCompleted?.durationMs || working.durationMs, transcriptionDraft: undefined,
        transcriptionEngine: nativeCompleted ? '本机 Small 分窗精校' : `浏览器 ${settings.preciseModel === 'base' ? 'Base' : 'Tiny'} 精校`,
        transcriptionWarning: nativeCompleted?.warning,
      })});
      let translationError='';
      if(working.recordingMode==='en-zh'&&settings.autoTranslate) {
        for(const segment of working.segments) {
          if(controller.signal.aborted)throw new Error('已取消，音频和文字已保留');
          if(segment.translation)continue;
          setPreciseProgress({label:'正在生成中文翻译',state:'working'});
          try {segment.translation=await translationServiceRef.current?.translate(segment.source)??'';controller.signal.throwIfAborted();}
          catch(error){translationError=error instanceof Error?error.message:'中文翻译未完成';break;}
          working=await saveStage({segments:[...working.segments]});
        }
      }
      controller.signal.throwIfAborted();
      const local=enrichWithFocusNotes(working,settings.summaryTemplate,settings.aiProvider!=='codex');
      // Local rules may power real-time Key Messages, but are not presented as
      // a completed AI summary while Codex is still running.
      working=await saveStage({keyMessages:local.keyMessages,classBrief:settings.aiProvider==='codex'?working.classBrief:local.classBrief,analysisStatus:settings.aiProvider==='codex'?'summarizing':'ready',analysisError:translationError||undefined});
      controller.signal.throwIfAborted();
      if(settings.aiProvider==='codex') {
        try {working=await generateNotes(working,working.batchId?'class':'recording',undefined,controller.signal);}
        catch(error){working={...working,aiError:error instanceof Error?error.message:'Codex 未完成'};}
      }
      if (!working.aiError && !controller.signal.aborted) {
        try {
          const vault = await syncRecordingVault(working, controller.signal);
          if (vault) working = await saveStage({ vault, vaultError: undefined });
        } catch (error) { working = await saveStage({ vaultError: error instanceof Error ? error.message : '本机学习库归档待重试' }); }
      }
      setPreciseProgress({label:working.aiError?'文字已保存；Codex 纪要未完成，可重试':translationError?'文字和笔记已保存；中文翻译未完成':'转写与分类笔记已保存',state:working.aiError||translationError?'error':'ready',progress:100});
      return working;
    } catch(error) {
      const message=controller.signal.aborted?'已取消处理，音频和已生成的文字已保留':error instanceof Error?error.message:'转写失败';
      await saveStage({analysisStatus:'error',analysisError:message});
      setPreciseProgress({label:message,state:'error'});
      throw new Error(message);
    } finally {parentSignal?.removeEventListener('abort', abortFromParent);analysisAbortRef.current=null;setJobBusy(false);}
  },[persistRecording,settings.autoTranslate,settings.preciseModel,settings.summaryTemplate,settings.aiProvider,generateNotes]);

  onRecordedRef.current=async recording=>{
    // Final full-recording pass refines approximate live chunk boundaries before final notes.
    const finished=await analyzeRecording(recording,false);
    setRuntimeNotice(finished.aiError||finished.analysisError||finished.transcriptionWarning||'录音、文字和笔记已保存');
  };

  // During capture, Key Messages come from local classification of the newest
  // segments. Sending the full growing transcript every 30 seconds caused
  // quadratic latency and occupied the user's Codex task line.

  const handleAudioImport = useCallback(async (files: File[]) => {
    if (studyBusyRef.current) { setToast('请先完成或取消学习资料处理'); return; }
    const validFiles = files.filter((file) => file.type.startsWith('audio/') || /\.(mp3|m4a|wav|webm|ogg|mp4)$/i.test(file.name));
    if (!validFiles.length) {
      setToast('请选择音频文件');
      return;
    }
    if(jobBusy||aiJobRef.current||finalizingRef.current||importRunningRef.current||activeRef.current?.status==='recording'||activeRef.current?.status==='paused'){setToast('请先结束当前录音或处理任务');return;}
    importRunningRef.current=true;cancelBatchRef.current=false;
    const batchId = importBatchRef.current ?? makeId('batch');
    let processingFailures=0;
    const imported: RecordingSession[] = [];
    const totalSteps = validFiles.length * (settings.autoAnalyzeUploads ? 2 : 1);
    setPage('library');
    setBatchProgress({ total: totalSteps, completed: 0, currentName: '正在读取文件', failed: 0 });
    for (const [index, file] of validFiles.entries()) {
      try {
        setBatchProgress((current) => current ? { ...current, currentName: `正在导入 ${file.name}` } : current);
        const durationMs = await getAudioDuration(file);
        const session: RecordingSession = {
          ...createSession(settings, file.name.replace(/\.[^.]+$/, ''), importCourseRef.current),
          durationMs,
          status: 'complete',
          analysisStatus: settings.autoAnalyzeUploads ? 'queued' : 'idle',
          batchId,
          sourceFileName: file.name,
          audioBlob: file,
          audioMimeType: file.type,
        };
        await saveRecording(session);
        imported.push(session);
        setRecordings((items) => upsertRecording(items, session));
      } catch {
        setBatchProgress((current) => current ? { ...current, failed: current.failed + 1 } : current);
      }
      setBatchProgress((current) => current ? { ...current, completed: index + 1 } : current);
    }
    if (settings.autoAnalyzeUploads) {
      for (const [index, session] of imported.entries()) {
        if(cancelBatchRef.current)break;
        setBatchProgress((current) => current ? {
          ...current,
          currentName: `生成笔记 ${index + 1}/${imported.length} · ${session.title}`,
        } : current);
        try {
          const analyzed=await analyzeRecording(session);
          if(analyzed.aiError||analyzed.analysisError)processingFailures++;
        } catch {
          processingFailures++;
          setBatchProgress((current) => current ? { ...current, failed: current.failed + 1 } : current);
        }
        setBatchProgress((current) => current ? { ...current, completed: Math.min(current.total, current.completed + 1) } : current);
      }
    }
    setBatchProgress((current) => current ? { ...current, completed: current.total, currentName: cancelBatchRef.current?'批量处理已取消':'批量处理完成' } : current);
    window.setTimeout(() => setBatchProgress(null), 4500);
    setToast(`${imported.length} 段音频已保存${processingFailures ? `，${processingFailures} 段处理未完成，请打开重试` : settings.autoAnalyzeUploads ? '，笔记处理已完成' : ''}`);
    importBatchRef.current=undefined;
    importCourseRef.current = undefined;
    importRunningRef.current=false;
    if(cancelBatchRef.current)setToast('批量处理已取消，已导入音频保留，可逐条重试');
  }, [analyzeRecording, settings, jobBusy]);

  const runPreciseTranscription = useCallback(async (confirmed = false) => {
    if (studyBusyRef.current) { setToast('请先完成或取消学习资料处理'); return; }
    if(analysisAbortRef.current||aiJobRef.current||finalizingRef.current||importRunningRef.current){setToast('请等待当前处理结束');return;}
    const recording = activeRef.current;
    if (!recording?.audioBlob) {
      setToast('这条记录没有音频，无法精确转写');
      return;
    }
    if (recording.segments.length && !confirmed) { setConfirmTranscription(true); return; }
    setConfirmTranscription(false);
    setRuntimeNotice('正在检查本机精校环境；原音频始终保留');
    try {
      const finished=await analyzeRecording(recording);
      setNotesTab('brief');
      setRuntimeNotice(finished.aiError || finished.analysisError || finished.transcriptionWarning || '转写和分类纪要已保存');
    } catch (error) {
      setRuntimeNotice(error instanceof Error ? error.message : '精确转写失败');
    }
  }, [analyzeRecording]);

  const addNote = useCallback(() => {
    const text = noteDraft.trim();
    if (!text) return;
    const atMs = audioElementRef.current
      ? audioElementRef.current.currentTime * 1000
      : elapsedRef.current;
    updateActive((recording) => ({
      ...recording,
      notes: [...recording.notes, { id: makeId('note'), atMs, text }],
    }));
    setNoteDraft('');
    setToast(`笔记已标记在 ${formatClock(atMs)}`);
  }, [noteDraft, updateActive]);

  const regenerateBrief = useCallback(() => {
    if (studyBusyRef.current) { setToast('请先完成或取消学习资料处理'); return; }
    if(analysisAbortRef.current||finalizingRef.current||importRunningRef.current){setToast('请等待转写结束后再整理');return;}
    const recording=activeRef.current;
    if(!recording?.segments.length){setToast('请先完成转写');return;}
    setNotesTab('brief');
    if(settings.aiProvider==='codex') {
      void generateNotes(recording,summaryScope).catch(error=>setToast(error instanceof Error?error.message:'Codex 请求失败'));
    } else {
      updateActive(item=>({...enrichWithFocusNotes(item,settings.summaryTemplate,true),analysisStatus:'ready'}));
      setToast('已按本地规则整理；这不是大模型纪要');
    }
  },[generateNotes,settings.aiProvider,settings.summaryTemplate,summaryScope,updateActive]);

  const appendToClass = useCallback(async()=>{
    const recording=activeRef.current;
    if(!recording || recording.status==='recording'||recording.status==='paused'||jobBusy||aiBusy)return;
    const batchId=recording.batchId??makeId('batch');
    await persistRecording({...recording,batchId});
    importBatchRef.current=batchId;
    importCourseRef.current=recording.courseId;
    fileInputRef.current?.click();
  },[aiBusy,jobBusy,persistRecording]);

  const connectCodex = useCallback(async()=>{
    try {const login=await startCodexLogin();window.open(login.authUrl,'_blank','noopener,noreferrer');setToast('请在官方登录页完成登录，再点检查连接');}
    catch(error){setToast(error instanceof Error?error.message:'无法启动登录');}
  },[]);

  const restoreBackup = useCallback(async(file:File)=>{
    if(jobBusy||aiBusy||activeRef.current?.status==='recording'||activeRef.current?.status==='paused'){setToast('请先停止录音并等待处理完成');return;}
    try{
      const restored=await restoreLocalData(file);
      const [records,groups,prefs]=await Promise.all([listRecordings(),listCourses(),loadSettings()]);
      setRecordings(records);recordsRef.current=records;
      setCourses(groups.filter(course=>course.id!==DEFAULT_COURSE_ID));setSettings(prefs);
      setLibraryRevision(value => value + 1);
      setToast('恢复成功：'+restored.recordings+' 段录音、'+restored.materials+' 份图文、'+restored.courses+' 门课程；已有数据保留');
    }catch(error){setToast(error instanceof Error?error.message:'恢复失败，原数据未修改');}
  },[aiBusy,jobBusy]);

  const shareActiveRecording = useCallback(async () => {
    const recording = activeRef.current;
    if (!recording) return;
    const keySummary = recording.keyMessages.slice(0, 4).map((message) => message.detail).join('\n');
    const text = recording.classBrief?.overview || keySummary || recording.title;
    try {
      if (navigator.share) {
        await navigator.share({ title: recording.title, text });
        return;
      }
      await navigator.clipboard.writeText(`${recording.title}\n\n${text}`);
      setToast('课堂概览已复制，可以直接分享');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setToast('暂时无法分享，请使用导出功能');
    }
  }, []);

  const runAssistantPrompt = useCallback((suggestion?: string) => {
    if (studyBusyRef.current) { setToast('请先完成或取消学习资料处理'); return; }
    if(analysisAbortRef.current||finalizingRef.current||importRunningRef.current){setToast('请等待转写结束后再提问');return;}
    const prompt=(suggestion??assistantPrompt).trim();
    const recording=activeRef.current;
    if(!recording?.segments.length){setToast('请先转写，再生成纪要或提问');return;}
    if(settings.aiProvider==='local'){regenerateBrief();setToast('当前是本地规则模式；切换 Codex 后可智能问答');return;}
    const answerOnly=Boolean(prompt && suggestion!=='生成总纪要');
    void generateNotes(recording,summaryScope,prompt||undefined,undefined,answerOnly)
      .then(()=>setAssistantPrompt('')).catch(error=>setToast(error instanceof Error?error.message:'Codex 请求失败'));
  },[assistantPrompt,generateNotes,regenerateBrief,settings.aiProvider,summaryScope]);

  const addBookmark = useCallback(
    (atMs?: number, label = '重点') => {
      const time = atMs ?? (audioElementRef.current?.currentTime ?? elapsedRef.current / 1000) * 1000;
      updateActive((recording) => ({
        ...recording,
        bookmarks: [...recording.bookmarks, { id: makeId('bookmark'), atMs: time, label }],
      }));
      setToast(`已收藏 ${formatClock(time)}`);
    },
    [updateActive],
  );

  const seekTo = useCallback((atMs: number) => {
    if (activeRef.current?.status === 'recording' || activeRef.current?.status === 'paused') {
      setToast(`字幕时间 ${formatClock(atMs)}；请结束录音后回放`);
      return;
    }
    const audio = audioElementRef.current;
    if (!audio) {
      elapsedRef.current = atMs;
      setElapsedMs(atMs);
      setToast(`已定位到 ${formatClock(atMs)}；当前示例不含音频`);
      return;
    }
    audio.currentTime = atMs / 1000;
    void audio.play().catch(() => undefined);
  }, []);

  const seekSource = useCallback((atMs:number,recordingId?:string)=>{
    if(recordingId && recordingId!==activeRef.current?.id){
      if(activeRef.current?.status==='recording'||activeRef.current?.status==='paused'){setToast('请先停止录音再回放其他来源');return;}
      const source=recordsRef.current.find(record=>record.id===recordingId);
      if(!source){setToast('来源录音不存在，可能已被删除');return;}
      pendingSeekRef.current=atMs;openRecording(source);setMobilePane('transcript');
      if(!source.audioBlob){setToast('来源没有音频，已打开对应转写');pendingSeekRef.current=null;}
    }else seekTo(atMs);
  },[openRecording,seekTo]);

  const toggleAudioPlayback = useCallback(() => {
    const audio = audioElementRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setToast('音频暂时无法播放'));
    else audio.pause();
  }, []);

  const skipAudio = useCallback((seconds: number) => {
    const audio = audioElementRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds));
    setElapsedMs(audio.currentTime * 1000);
  }, []);

  const openSegmentEditor = useCallback((segment: TranscriptSegment) => {
    setEditingSegment(segment);
    setEditSource(segment.source);
    setEditTranslation(segment.translation);
  }, []);

  const saveSegmentEdit = useCallback(() => {
    if (!editingSegment || !editSource.trim()) return;
    if(jobBusy||aiBusy){setToast('请在处理结束后编辑原文，避免纪要引用失效');return;}
    updateActive((recording) => ({
      ...recording,
      segments: recording.segments.map((item) =>
        item.id === editingSegment.id
          ? { ...item, source: editSource.trim(), translation: editTranslation.trim() }
          : item,
      ),
    }));
    setEditingSegment(null);
    setToast('这一段已更新');
  }, [editSource, editTranslation, editingSegment, updateActive]);

  const removeRecording = useCallback(async (recording: RecordingSession) => {
    if (studyBusyRef.current) { setToast('资料正在处理，请先完成或取消，再删除'); return; }
    if(finalizingRef.current||importRunningRef.current||analysisAbortRef.current||aiJobRef.current||activeRef.current?.status==='recording'||activeRef.current?.status==='paused'){setToast('请先停止录音并完成或取消当前处理，再删除资料');return;}
    if (!window.confirm(`确定删除“${recording.title}”及其本地音频吗？此操作无法撤销。`)) return;
    await deleteRecording(recording.id);
    recordsRef.current=recordsRef.current.filter(item=>item.id!==recording.id);
    setRecordings((items) => items.filter((item) => item.id !== recording.id));
    if (activeRef.current?.id === recording.id) {
      activeRef.current = null;
      setActive(null);
      setElapsedMs(0);
    }
    setToast('记录已从本机删除');
  }, []);

  const createCourseFromDialog = useCallback(async () => {
    const name = courseName.trim();
    if (!name) return;
    const now = new Date().toISOString();
    const course: Course = {
      id: makeId('course'),
      name,
      term: courseTerm.trim(),
      color: COURSE_COLORS[courses.length % COURSE_COLORS.length],
      createdAt: now,
      updatedAt: now,
    };
    await saveCourse(course);
    setCourses((items) => [course, ...items]);
    setCourseFilter(course.id);
    setCourseName('');
    setCourseTerm('');
    setShowCourseDialog(false);
    setToast(`课程“${course.name}”已创建`);
  }, [courseName, courseTerm, courses.length]);

  const removeCourse = useCallback(async (course: Course) => {
    if (studyBusyRef.current) { setToast('资料正在处理，请先完成或取消，再删除分组'); return; }
    if(finalizingRef.current||importRunningRef.current||analysisAbortRef.current||aiJobRef.current||activeRef.current?.status==='recording'||activeRef.current?.status==='paused'){setToast('请先停止录音并完成或取消当前处理，再删除分组');return;}
    if (!window.confirm(`删除课程分组“${course.name}”？录音会保留并移到“未分组”。`)) return;
    await deleteCourse(course.id);
    // deleteCourse atomically moves all records to the default group in IndexedDB.
    recordsRef.current=recordsRef.current.map(recording=>recording.courseId===course.id?{...recording,courseId:DEFAULT_COURSE_ID}:recording);
    setCourses((items) => items.filter((item) => item.id !== course.id));
    setRecordings(recordsRef.current);
    if (activeRef.current?.courseId === course.id) updateActive((recording) => ({ ...recording, courseId: DEFAULT_COURSE_ID }));
    if (courseFilter === course.id) setCourseFilter('all');
    setToast('课程分组已删除，录音仍然保留');
  }, [courseFilter, updateActive]);

  const installApp = useCallback(async () => {
    if (!installPrompt) {
      setToast('可在浏览器菜单中选择“安装此网站为应用”');
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setToast('听澜已安装');
    setInstallPrompt(null);
  }, [installPrompt]);

  const clearEverything = useCallback(async () => {
    if (startingRef.current) return;
    if (studyBusyRef.current) { setToast('资料正在处理，请先完成或取消，再清除'); return; }
    if(finalizingRef.current||importRunningRef.current||analysisAbortRef.current||aiJobRef.current||activeRef.current?.status==='recording'||activeRef.current?.status==='paused'){setToast('请先停止录音并完成或取消当前处理，再清除资料');return;}
    if (!window.confirm('确定删除所有录音、转写、笔记和设置吗？此操作无法撤销。')) return;
    await clearLocalData();
    recordsRef.current=[];
    setRecordings([]);
    setCourses([]);
    setActive(null);
    activeRef.current = null;
    setSettings(DEFAULT_SETTINGS);
    setLibraryRevision(value => value + 1);
    setElapsedMs(0);
    setPage('home');
    setToast('本地数据已全部清除');
  }, []);

  const totalMinutes = Math.round(recordings.reduce((sum, item) => sum + item.durationMs, 0) / 60_000);
  const translatedSegments = recordings.reduce(
    (sum, item) => sum + item.segments.filter((segment) => segment.translation).length,
    0,
  );
  const totalKeyMessages = recordings.reduce((sum, item) => sum + item.keyMessages.length, 0);
  const filteredRecordings = recordings.filter((recording) => {
    if (courseFilter === 'unfiled' && recording.courseId && recording.courseId !== DEFAULT_COURSE_ID) return false;
    if (courseFilter !== 'all' && courseFilter !== 'unfiled' && recording.courseId !== courseFilter) return false;
    const courseNameForRecording = courses.find((course) => course.id === recording.courseId)?.name ?? '';
    const haystack = [
      recording.title,
      courseNameForRecording,
      ...recording.segments.flatMap((segment) => [segment.source, segment.translation]),
      ...recording.notes.map((note) => note.text),
      recording.classBrief?.overview ?? '',
      ...Object.values(recording.classBrief?.sections ?? {}).flatMap(items => items.map(item => item.text)),
      ...recording.keyMessages.flatMap(item => [item.title, item.detail]),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(libraryQuery.trim().toLowerCase());
  });

  const pageLabel = page === 'home' ? 'Home' : page === 'library' ? 'All Records' : page === 'study' ? 'Study Library' : page === 'settings' ? 'Settings' : 'Recording';

  const renderTopbar = () => (
    <header className="app-topbar">
      <div className="topbar-left">
        <button className="menu-trigger" onClick={() => setSidebarOpen(true)} aria-label="打开导航菜单"><Icon name="menu" /></button>
        <button className="dashboard-crumb" onClick={() => setPage('home')}><Icon name="home" /> Dashboard</button>
        <Icon name="arrow" className="crumb-arrow" />
      </div>
      <div className="topbar-center">
        {page === 'recorder' && active ? <>
          <input className="topbar-title-input" aria-label="录音标题" value={active.title} onChange={(event) => updateActive((recording) => ({ ...recording, title: event.target.value }))} />
          <div className="topbar-meta">
            <span><Icon name="calendar" /> {formatShortDate(active.createdAt)}</span>
            <span>{active.recordingMode === 'zh' ? '中文（简体）' : 'English → 中文'}</span>
            <span>{courses.find((course) => course.id === active.courseId)?.name ?? '未分组'}</span>
          </div>
        </> : <strong>{pageLabel}</strong>}
      </div>
      <div className="topbar-actions">
        {page !== 'recorder' && active && (active.status === 'recording' || active.status === 'paused') && (
          <button className="topbar-recording-chip" onClick={() => setPage('recorder')} aria-label={`返回正在进行的录音，${formatClock(elapsedMs)}`}>
            <i className={active.status === 'recording' ? 'live' : ''} />
            <span>{active.status === 'recording' ? '录音中' : '已暂停'}</span>
            <time>{formatClock(elapsedMs)}</time>
          </button>
        )}
        {page === 'recorder' && active ? <>
          <button className="topbar-icon" onClick={() => addBookmark()} disabled={active.status === 'idle'} title="收藏当前时刻"><Icon name="star" /></button>
          <button className="topbar-button" onClick={() => void shareActiveRecording()} aria-label="分享课堂记录" title="分享课堂记录"><Icon name="share" /><span>分享</span></button>
          <button className={`topbar-button ${showTranscriptSearch ? 'active' : ''}`} onClick={() => { if (showTranscriptSearch) setTranscriptQuery(''); setShowTranscriptSearch(!showTranscriptSearch); }} aria-label={showTranscriptSearch ? '关闭转写查找' : '查找转写内容'} title={showTranscriptSearch ? '关闭转写查找' : '查找转写内容'}><Icon name="search" /><span>查找</span></button>
          <button className="topbar-icon" onClick={() => chooseImportFiles(active.courseId === DEFAULT_COURSE_ID ? undefined : active.courseId)} title="添加音频"><Icon name="paperclip" /></button>
          {active.audioBlob && <button className="topbar-icon accent" onClick={() => void runPreciseTranscription()} disabled={preciseProgress.state === 'working' || preciseProgress.state === 'downloading'} title="本地精确转写"><Icon name="wand" /></button>}
          <div className="export-wrap">
            <button className="topbar-icon" onClick={() => setShowExport((value) => !value)} title="导出"><Icon name="download" /></button>
            {showExport && <div className="export-menu">
              {(['md', 'txt', 'srt', 'json'] as const).map((format) => <button key={format} onClick={() => { exportRecording(active, format); setShowExport(false); }}>{format === 'md' ? 'Markdown 课堂笔记' : format === 'txt' ? '纯文本' : format === 'srt' ? '双语字幕 SRT' : '完整数据 JSON'}<span>.{format}</span></button>)}
              {active.audioBlob && <button onClick={() => { exportAudio(active); setShowExport(false); }}>原始录音<span>audio</span></button>}
            </div>}
          </div>
        </> : <>
          <button className="topbar-button" onClick={() => chooseImportFiles(courseFilter !== 'all' && courseFilter !== 'unfiled' ? courseFilter : undefined)} aria-label="导入音频" title="导入音频"><Icon name="upload" /><span>导入音频</span></button>
          <button className="topbar-button primary" onClick={openNewRecording} aria-label="新建录音" title="新建录音"><Icon name="mic" /><span>新录音</span></button>
        </>}
      </div>
    </header>
  );

  const renderHome = () => (
    <main id="main-content" className="page home-page">
      <header className="page-header home-header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>开始一堂新的课堂记录</h1>
          <p className="page-intro">实时转写、中文理解和 AI Notes，都在同一个工作区。</p>
          <button className="text-button" onClick={() => setPage('study')}><Icon name="library" />打开学习资料库 · 图片、作业与截止时间</button>
        </div>
        <div className="privacy-chip"><Icon name="lock" /> 音频留本机</div>
      </header>

      <section className="start-hero" aria-labelledby="start-title">
        <div className="hero-copy">
          <div className="hero-kicker"><Icon name="mic" /> New recording</div>
          <h2 id="start-title">录音时就开始整理</h2>
          <p>选择课堂语言后开始录制，或者一次导入同一门课的多段音频。</p>
          <div className="mode-switch" aria-label="课堂语言模式">
            <button className={settings.recordingMode === 'en-zh' ? 'active' : ''} onClick={() => applyRecordingMode('en-zh')}><b>EN → 中</b><span>英文课 · 中文理解</span></button>
            <button className={settings.recordingMode === 'zh' ? 'active' : ''} onClick={() => applyRecordingMode('zh')}><b>中文</b><span>中文课 · 原声笔记</span></button>
          </div>
          <div className="hero-actions">
            <button className="button primary large" onClick={openNewRecording}>
              <Icon name="mic" /> 新建录音
            </button>
            <button className="button secondary large" onClick={() => chooseImportFiles()}>
              <Icon name="upload" /> 批量导入音频
            </button>
          </div>
          <button className="text-button" onClick={loadDemo}>
            暂时不录音，先看一份双语示例 <Icon name="arrow" />
          </button>
        </div>
        <div className="hero-capabilities">
          <article><span><Icon name="mic" /></span><div><strong>实时转写</strong><small>中文或英文课堂</small></div><Icon name="check" /></article>
          <article><span><Icon name="brain" /></span><div><strong>AI Notes</strong><small>要点、作业与考点</small></div><Icon name="check" /></article>
          <article><span><Icon name="lock" /></span><div><strong>Local first</strong><small>默认保存在本机</small></div><Icon name="check" /></article>
        </div>
      </section>

      <section className="stats-grid" aria-label="使用统计">
        <article className="stat-card accent-mint">
          <span>累计录音</span><strong>{totalMinutes}</strong><small>分钟</small>
        </article>
        <article className="stat-card accent-violet">
          <span>双语片段</span><strong>{translatedSegments}</strong><small>段</small>
        </article>
        <article className="stat-card accent-coral">
          <span>AI 重点</span><strong>{totalKeyMessages}</strong><small>条</small>
        </article>
      </section>

      <div className="dashboard-columns">
        <section className="section-block">
          <div className="section-heading"><div><p className="eyebrow">Recent</p><h2>最近记录</h2></div><button className="text-button" onClick={() => setPage('library')}>查看全部 <Icon name="arrow" /></button></div>
          {recordings.length ? <div className="recent-list">{recordings.slice(0, 5).map((recording) => (
            <button className="recent-row" key={recording.id} onClick={() => openRecording(recording)}>
              <span className="recording-emblem"><Icon name="headphones" /></span>
              <span className="recent-main"><strong>{recording.title}</strong><small>{formatShortDate(recording.createdAt)} · {recording.segments.length} 个片段</small></span>
              <span className="duration">{formatClock(recording.durationMs)}</span><Icon name="arrow" className="row-arrow" />
            </button>
          ))}</div> : <div className="empty-shelf"><span className="empty-mark"><Icon name="library" /></span><div><strong>你的第一堂课会出现在这里</strong><p>开始录音，或导入一段已有音频。</p></div></div>}
        </section>
        <section className="section-block course-summary-block">
          <div className="section-heading"><div><p className="eyebrow">Courses</p><h2>课程</h2></div><button className="text-button" onClick={() => { setShowCourseDialog(true); }}>新建 <Icon name="plus" /></button></div>
          <div className="home-course-list">
            {courses.slice(0, 5).map((course) => {
              const count = recordings.filter((recording) => recording.courseId === course.id).length;
              return <button key={course.id} onClick={() => { setCourseFilter(course.id); setPage('library'); }}><i style={{ background: course.color }} /><span><strong>{course.name}</strong><small>{course.term || '课程分组'} · {count} 段录音</small></span><Icon name="arrow" /></button>;
            })}
            {!courses.length && <button className="empty-course-row" onClick={() => setShowCourseDialog(true)}><span><strong>还没有课程分组</strong><small>新建课程后，多段录音会更好整理</small></span><Icon name="plus" /></button>}
          </div>
        </section>
      </div>
    </main>
  );

  const renderRecorder = () => {
    if (!active) {
      return (
        <main id="main-content" className="page centered-page">
          <div className="empty-recorder">
            <span><Icon name="mic" /></span>
            <h1>还没有打开的课堂记录</h1>
            <p>新建一条记录后，就能开始录音、实时字幕和中文翻译。</p>
            <button className="button primary" onClick={openNewRecording}><Icon name="plus" /> 新建录音</button>
          </div>
        </main>
      );
    }

    const isCapturing = active.status === 'recording' || active.status === 'paused';
    const modelProgress = preciseProgress.state !== 'idle' ? preciseProgress : translationProgress;
    const showModelBar = ['checking', 'downloading', 'working', 'error'].includes(modelProgress.state);
    const normalizedTranscriptQuery = showTranscriptSearch ? transcriptQuery.trim().toLowerCase() : '';
    const visibleSegments = normalizedTranscriptQuery
      ? active.segments.filter((segment) => `${segment.speaker} ${segment.source} ${segment.translation}`.toLowerCase().includes(normalizedTranscriptQuery))
      : active.segments;
    const briefSectionKeys: Array<'concepts' | 'takeaways' | 'assignments' | 'examReading' | 'followUps'> = briefFilter === 'assignments'
      ? ['assignments']
      : briefFilter === 'exam'
        ? ['examReading']
        : ['concepts', 'takeaways', 'assignments', 'examReading', 'followUps'];
    const transportBar = (
      <section className="recording-dock" aria-label="录音与播放控制">
        <input
          className="transport-progress"
          type="range"
          min={0}
          max={Math.max(1, active.durationMs)}
          value={Math.min(elapsedMs, Math.max(1, active.durationMs))}
          disabled={!audioUrl}
          aria-label="播放进度"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (audioElementRef.current) audioElementRef.current.currentTime = next / 1000;
            setElapsedMs(next);
          }}
        />
        <div className="dock-time-row"><span>{formatClock(isCapturing ? elapsedMs : Math.min(elapsedMs, active.durationMs))}</span><span>{formatClock(active.durationMs)}</span></div>
        <div className="transport-main-row">
          <div className="dock-status"><span className={`status-orb status-${active.status}`} /><div><strong>{active.status === 'recording' ? '正在记录' : active.status === 'paused' ? '已暂停' : active.status === 'complete' ? '课堂录音' : '准备录音'}</strong><small>{runtimeNotice}</small></div></div>
          <div className={`waveform ${active.status === 'recording' ? 'active' : ''}`} aria-hidden="true">{levels.slice(0, 22).map((level, index) => <i key={index} style={{ height: `${Math.max(9, level * 100)}%` }} />)}</div>
          <div className="transport-controls">
            {active.status === 'idle' && <button className="record-button" onClick={() => void startRecording()} title="开始录音"><Icon name="mic" /></button>}
            {active.status === 'recording' && <><button className="round-button" onClick={pauseRecording} title="暂停"><Icon name="pause" /></button><button className="stop-button" onClick={stopRecording} title="停止"><Icon name="stop" /></button></>}
            {active.status === 'paused' && <><button className="record-button small" onClick={resumeRecording} title="继续"><Icon name="play" /></button><button className="stop-button" onClick={stopRecording} title="停止"><Icon name="stop" /></button></>}
            {active.status === 'complete' && <>
              <button className="transport-skip" onClick={() => skipAudio(-3)} disabled={!audioUrl} title="后退 3 秒">−3</button>
              <button className="play-button" onClick={toggleAudioPlayback} disabled={!audioUrl} title={audioPlaying ? '暂停' : '播放'}><Icon name={audioPlaying ? 'pause' : 'play'} /></button>
              <button className="transport-skip" onClick={() => skipAudio(3)} disabled={!audioUrl} title="前进 3 秒">+3</button>
            </>}
          </div>
          <button className="quick-bookmark" onClick={() => addBookmark()} disabled={active.status === 'idle'} title="收藏当前时刻"><Icon name="bookmark" /></button>
        </div>
        {audioUrl && <audio ref={audioElementRef} src={audioUrl} onLoadedMetadata={(event)=>{if(pendingSeekRef.current!==null){event.currentTarget.currentTime=pendingSeekRef.current/1000;pendingSeekRef.current=null;void event.currentTarget.play().catch(()=>undefined);}}} onPlay={() => setAudioPlaying(true)} onPause={() => setAudioPlaying(false)} onEnded={() => setAudioPlaying(false)} onTimeUpdate={(event) => setElapsedMs(event.currentTarget.currentTime * 1000)} />}
      </section>
    );
    const modelStatusBar = showModelBar ? <div className={`model-bar state-${modelProgress.state}`} role="status">
      <Icon name={modelProgress.state === 'error' ? 'warning' : 'sparkles'} />
      <span>{modelProgress.label}</span>
      {typeof modelProgress.progress === 'number' && <div className="model-progress"><i style={{ width: `${Math.min(100, modelProgress.progress)}%` }} /></div>}
      {typeof modelProgress.progress === 'number' && <b>{Math.round(modelProgress.progress)}%</b>}
    </div> : null;

    return (
      <main id="main-content" className={`page recorder-page ${showTranscriptSearch ? 'search-open' : ''}`}>
        <div className="mobile-pane-switch" aria-label="移动端工作区">
          <button className={mobilePane === 'transcript' ? 'active' : ''} onClick={() => setMobilePane('transcript')}>转写</button>
          <button className={mobilePane === 'notes' ? 'active' : ''} onClick={() => setMobilePane('notes')}>AI Notes</button>
        </div>
        <section className="recording-toolbar" aria-label="转写设置">
          <label className="course-select">
            <span><Icon name="folder" /> 课程</span>
            <select value={active.courseId === DEFAULT_COURSE_ID ? '' : active.courseId ?? ''} onChange={(event) => updateActive((recording) => ({ ...recording, courseId: event.target.value || DEFAULT_COURSE_ID }))}>
              <option value="">未分组</option>
              {courses.map((course) => <option key={course.id} value={course.id}>{course.name}{course.term ? ` · ${course.term}` : ''}</option>)}
            </select>
          </label>
          <div className="toolbar-divider" />
          <div className="language-flow">
            {active.recordingMode === 'en-zh' ? <>
              <span className="language-pill"><b>EN</b> English</span>
              <Icon name="arrow" />
              <span className="language-pill translated"><b>中</b> 简体中文</span>
            </> : <span className="language-pill translated"><b>中</b> 普通话课堂</span>}
          </div>
          <div className="toolbar-divider" />
          {active.recordingMode === 'en-zh' ? <div className="toolbar-setting">
            <span><Icon name="sparkles" /> 自动中文翻译</span>
            <Toggle checked={settings.autoTranslate} onChange={(checked) => setSettings((value) => ({ ...value, autoTranslate: checked }))} label="自动中文翻译" />
          </div> : <div className="toolbar-setting focus-on"><span><Icon name="sparkles" /> 实时提炼 Key Messages</span></div>}
          {active.status === 'idle' && <div className="mini-mode-switch" aria-label="切换课堂语言">
            <button className={active.recordingMode === 'en-zh' ? 'active' : ''} onClick={() => applyRecordingMode('en-zh')}>EN → 中</button>
            <button className={active.recordingMode === 'zh' ? 'active' : ''} onClick={() => applyRecordingMode('zh')}>中文</button>
          </div>}
          {!isCapturing && active.status !== 'complete' && (
            <div className="input-source" aria-label="录音输入来源">
              <button className={inputSource === 'microphone' ? 'active' : ''} onClick={() => setInputSource('microphone')}><Icon name="mic" /> 麦克风</button>
              <button className={inputSource === 'system' ? 'active' : ''} onClick={() => setInputSource('system')}><Icon name="monitor" /> 电脑声音</button>
            </div>
          )}
          <span className="engine-label">实时本机 Small · {active.transcriptionEngine || '实时服务预热中，异常时回退浏览器字幕'}</span>
        </section>

        <div className="processing-actions" aria-label="音频处理">
          <span>{active.analysisError || active.aiError || active.vaultError || (jobBusy ? '正在处理，请保留页面…' : active.vault?.state === 'ready' ? '文字与纪要已保存 · 原件和笔记已归档到本机学习库' : active.segments.length ? '文字已保存，可整理纪要或继续添加本堂课音频' : '录音结束后会自动转写；旧录音请点右侧按钮')}</span>
          {active.audioBlob && !isCapturing && <button className="button primary" disabled={jobBusy||aiBusy} onClick={()=>void runPreciseTranscription()}>{active.segments.length?'重新转写并整理':'转写并生成笔记'}</button>}
          {active.segments.length>0 && !isCapturing && <button className="button secondary" disabled={jobBusy||aiBusy} onClick={regenerateBrief}>生成 / 重试纪要</button>}
          {!isCapturing && <button className="button secondary" disabled={jobBusy||aiBusy} onClick={()=>void appendToClass()}>追加本堂课音频</button>}
          {(jobBusy||aiBusy)&&<button className="button secondary" onClick={()=>{studyCancelRef.current?.();cancelBatchRef.current=true;finalizeAbortRef.current?.abort();analysisAbortRef.current?.abort();aiAbortRef.current?.abort();setToast('已请求取消，已保存的数据保留');}}>取消处理</button>}
        </div>
        {active.transcriptionWarning && <p role="status">{active.transcriptionWarning}</p>}
        {Boolean(active.transcriptionDraft?.segments.length) && <details className="transcription-draft">
          <summary>已保存 {active.transcriptionDraft!.segments.length} 段精校草稿 · 原字幕和笔记保留，完整成功后替换</summary>
          <div>{active.transcriptionDraft!.segments.map(segment=><p key={segment.id}><button onClick={()=>seekTo(segment.startMs)}>{formatClock(segment.startMs)}</button> {segment.source}</p>)}</div>
        </details>}
        {showTranscriptSearch && <div className="transcript-searchbar">
          <Icon name="search" />
          <input value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} placeholder="在原文、译文和讲者中查找…" autoFocus />
          <span>{visibleSegments.length}/{active.segments.length}</span>
          <button onClick={() => { setShowTranscriptSearch(false); setTranscriptQuery(''); }} aria-label="关闭查找"><Icon name="close" /></button>
        </div>}

        <div className={`workspace-grid mobile-${mobilePane}`}>
          <section className="transcript-card" aria-labelledby="transcript-title">
            <div className="panel-heading">
              <div><p className="eyebrow">Live Transcript</p><h1 id="transcript-title">{active.recordingMode === 'zh' ? '中文课堂流' : '双语课堂流'}</h1></div>
              <span className="segment-count">{visibleSegments.length} 个片段</span>
            </div>
            {modelStatusBar}
            <div className="transcript-scroll" aria-live="polite">
              {!active.segments.length && !interimText ? (
                <div className="transcript-empty">
                  <div className="empty-wave" aria-hidden="true">{DEFAULT_LEVELS.slice(0, 15).map((level, index) => <i key={index} style={{ height: `${18 + level * 72}%` }} />)}</div>
                  <h2>{active.status === 'complete' ? '这段音频还没有字幕' : active.recordingMode === 'zh' ? '中文声音会在这里变成课堂线索' : '声音会在这里变成双语线索'}</h2>
                  <p>{active.status === 'complete' ? `点击“转写并生成笔记”，在设备上生成${active.recordingMode === 'zh' ? '中文课堂笔记' : '英文字幕和中文理解'}。` : inputSource === 'system' ? '系统声音会先完整录下，停止后可进行本地精确转写。' : active.recordingMode === 'zh' ? '开始后会显示中文原话，并同步捕捉作业、考点和老师强调。' : '开始后先显示英文原文，再逐段补上中文理解与 Key Messages。'}</p>
                  {active.status !== 'recording' && active.status !== 'paused' && !active.audioBlob && (
                    <button className="button soft" onClick={loadDemo}><Icon name="sparkles" /> 载入示例看看</button>
                  )}
                </div>
              ) : (
                <div className="segments">
                  {visibleSegments.map((segment) => (
                    <article className="segment" key={segment.id}>
                      <button className="timecode" onClick={() => seekTo(segment.startMs)} title="从这里播放">{formatClock(segment.startMs)}</button>
                      <div className="speaker-avatar">{segment.speaker.slice(0, 1)}</div>
                      <div className="segment-copy">
                        <div className="speaker-line"><strong>{segment.speaker}</strong>{segment.confidence ? <span>{Math.round(segment.confidence * 100)}%</span> : null}</div>
                        <p className="source-copy">{segment.source}</p>
                        {active.recordingMode === 'en-zh' && <p className={`translation-copy ${segment.translation ? '' : 'pending'}`}>{segment.translation || (settings.autoTranslate ? '正在生成中文…' : '中文翻译已关闭')}</p>}
                      </div>
                      <div className="segment-actions">
                        <button onClick={() => openSegmentEditor(segment)} title="编辑这一段"><Icon name="edit" /></button>
                        {active.recordingMode === 'en-zh' && !segment.translation && settings.autoTranslate && <button onClick={() => void translateSegment(segment.id, segment.source, active.id)} title="重新生成中文"><Icon name="sparkles" /></button>}
                        <button onClick={() => addBookmark(segment.startMs, '课堂重点')} title="收藏这一刻"><Icon name="bookmark" /></button>
                      </div>
                    </article>
                  ))}
                  {normalizedTranscriptQuery && !visibleSegments.length && <div className="transcript-no-results"><Icon name="search" /><strong>没有找到“{transcriptQuery.trim()}”</strong><span>换一个课程关键词试试</span></div>}
                  {interimText && (
                    <article className="segment interim-segment">
                      <span className="timecode">{formatClock(elapsedMs)}</span>
                      <div className="speaker-avatar listening"><span /></div>
                      <div className="segment-copy"><div className="speaker-line"><strong>正在聆听</strong></div><p className="source-copy">{interimText}</p>{active.recordingMode === 'en-zh' && <p className="translation-copy pending">完整句子结束后翻译</p>}</div>
                    </article>
                  )}
                </div>
              )}
            </div>
            {transportBar}
          </section>

          <aside className="notes-card" aria-labelledby="notes-title">
            <div className="panel-heading compact">
              <div><p className="eyebrow">Focus Notes</p><h2 id="notes-title">AI 课堂助手</h2></div>
              <button className="refresh-brief" onClick={regenerateBrief} disabled={!active.segments.length || aiBusy || jobBusy} title="按最新内容重新整理"><Icon name="sparkles" /></button>
            </div>
            {isCapturing && <div className="mobile-capture-controls" role="status" aria-label="录音控制">
              <span><i className={active.status === 'recording' ? 'live' : ''} /><strong>{active.status === 'recording' ? '录音中' : '已暂停'}</strong><time>{formatClock(elapsedMs)}</time></span>
              <div>
                {active.status === 'recording'
                  ? <button onClick={pauseRecording} aria-label="暂停录音"><Icon name="pause" /></button>
                  : <button onClick={resumeRecording} aria-label="继续录音"><Icon name="play" /></button>}
                <button className="stop" onClick={stopRecording} aria-label="停止录音"><Icon name="stop" /></button>
              </div>
            </div>}
            <div className="notes-tabs" role="tablist" aria-label="课堂笔记视图">
              <button role="tab" aria-selected={notesTab === 'keys'} className={notesTab === 'keys' ? 'active' : ''} onClick={() => setNotesTab('keys')}>Key Messages <b>{active.keyMessages.length}</b></button>
              <button role="tab" aria-selected={notesTab === 'brief'} className={notesTab === 'brief' ? 'active' : ''} onClick={() => setNotesTab('brief')}>Class Brief</button>
              <button role="tab" aria-selected={notesTab === 'notes'} className={notesTab === 'notes' ? 'active' : ''} onClick={() => setNotesTab('notes')}>随手记 <b>{active.notes.length}</b></button>
            </div>

            <div className="notes-scope">
              <label>整理范围 <select aria-label="整理范围" value={summaryScope} disabled={aiBusy||jobBusy||isCapturing} onChange={event=>setSummaryScope(event.target.value as typeof summaryScope)}>
                <option value="recording">这一段录音</option><option value="class">本堂课 · 多段录音</option><option value="course" disabled={!active.courseId||active.courseId===DEFAULT_COURSE_ID}>整门课程</option>
              </select></label>
              <span>{settings.aiProvider==='codex'?'Codex · Luna':'本地规则'}</span>
            </div>
            {aiBusy && <div className="ai-stream" role="status"><strong>Codex 正在整理…</strong><pre>{aiStream ? '已收到 '+aiStream.length+' 字符，正在验证来源与分类…' : '正在连接订阅模型…'}</pre></div>}
            {assistantAnswer && <div className="assistant-answer"><strong>课堂问答</strong><p>{assistantAnswer}</p></div>}
            {active.aiError && <div className="workflow-error" role="alert">{active.aiError} · 音频和文字已保留。</div>}
            {notesTab === 'keys' && <div className="focus-scroll">
              {active.keyMessages.map((message, index) => (
                <button className={`key-message category-${message.category}`} key={message.id} onClick={() => seekSource(message.startMs,message.sourceRecordingId)}>
                  <span className="key-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="key-copy"><small>{KEY_MESSAGE_LABELS[message.category]} · {formatClock(message.startMs)}</small><strong>{message.title}</strong></span>
                </button>
              ))}
              {!active.keyMessages.length && <div className="notes-empty"><Icon name="sparkles" /><p>{active.status === 'recording' ? '正在聆听。出现作业、考点或老师强调时，会实时收进这里。' : '有了转写内容后，Focus Notes 会自动筛出关键信息。'}</p></div>}
            </div>}

            {notesTab === 'brief' && <div className="brief-scroll">
              {active.classBrief ? <>
                <article className="brief-document">
                  <header><div><span className="ai-doc-mark"><Icon name="brain" /></span><div><small>Lecture Notes</small><h3>{briefFilter === 'assignments' ? '作业与截止时间' : briefFilter === 'exam' ? '考试重点与阅读' : '课堂行动与要点分析'}</h3></div></div><span className="source-badge">{active.classBrief.sourceSegmentCount} sources</span></header>
                  <section className="brief-overview"><h4>Note</h4><p>{active.classBrief.overview}</p></section>
                  {briefSectionKeys.map((section) => (
                    <section className="brief-document-section" key={section}>
                      <h4>{BRIEF_SECTION_LABELS[section]} <b>{active.classBrief?.sections[section].length ?? 0}</b></h4>
                      {active.classBrief?.sections[section].length ? <ul>{active.classBrief.sections[section].map((item) => <li key={item.id}><button onClick={() => seekSource(item.atMs,item.sourceRecordingId)}><time>{formatClock(item.atMs)}</time><span>{item.text}{item.due && <small className="due-date">截止 / 时间：{item.due}</small>}{item.evidenceQuote && <small className="evidence-quote">依据原话：“{item.evidenceQuote}”</small>}</span></button></li>)}</ul> : <p className="brief-empty">本次暂未识别到相关内容</p>}
                    </section>
                  ))}
                  <p className="brief-engine">{active.classBrief.engine==='codex'?'Codex · '+active.classBrief.model:'本地规则整理（非大模型）'} · {new Date(active.classBrief.generatedAt).toLocaleString('zh-CN')}</p>
                </article>
              </> : <div className="notes-empty"><Icon name="note" /><p>{active.analysisStatus === 'transcribing' || active.analysisStatus === 'summarizing' ? '正在整理这堂课的分类纪要…' : '停止录音或导入音频后，会在这里生成总的课堂纪要。'}</p>{active.segments.length > 0 && <button className="button soft" onClick={regenerateBrief}>立即生成</button>}</div>}
            </div>}

            {notesTab === 'notes' && <>
              <div className="note-composer">
                <textarea value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="写下观点、作业或没听懂的问题…" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') addNote(); }} />
                <div><span>标记在 {formatClock(audioElementRef.current ? audioElementRef.current.currentTime * 1000 : elapsedMs)}</span><button onClick={addNote} disabled={!noteDraft.trim()}><Icon name="plus" /> 添加</button></div>
              </div>
              <div className="notes-timeline">
                {[...active.notes.map((note) => ({ ...note, kind: 'note' as const })), ...active.bookmarks.map((bookmark) => ({ ...bookmark, text: bookmark.label, kind: 'bookmark' as const }))]
                  .sort((a, b) => a.atMs - b.atMs)
                  .map((item) => (
                    <button key={item.id} className={`timeline-item ${item.kind}`} onClick={() => seekTo(item.atMs)}>
                      <span className="timeline-icon"><Icon name={item.kind === 'note' ? 'note' : 'bookmark'} /></span>
                      <span><time>{formatClock(item.atMs)}</time><strong>{item.text}</strong></span>
                    </button>
                  ))}
                {!active.notes.length && !active.bookmarks.length && <div className="notes-empty"><Icon name="note" /><p>笔记会和录音时间绑在一起，点一下就能回到当时。</p></div>}
              </div>
            </>}
            <div className="assistant-footer">
              <div className="assistant-quick-actions" aria-label="快捷整理">
                <button className={briefFilter === 'all' && notesTab === 'brief' ? 'active' : ''} onClick={() => runAssistantPrompt('生成总纪要')}><Icon name="wand" /> 总纪要</button>
                <button className={briefFilter === 'assignments' && notesTab === 'brief' ? 'active' : ''} onClick={() => runAssistantPrompt('只看作业和截止日期')}>只看作业</button>
                <button className={briefFilter === 'exam' && notesTab === 'brief' ? 'active' : ''} onClick={() => runAssistantPrompt('提取考试重点')}>提取考点</button>
              </div>
              <div className="assistant-composer">
                <textarea value={assistantPrompt} onChange={(event) => setAssistantPrompt(event.target.value)} placeholder="搜索或整理本课内容" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); runAssistantPrompt(); } }} />
                <div><button title="添加音频" onClick={() => chooseImportFiles(active.courseId === DEFAULT_COURSE_ID ? undefined : active.courseId)}><Icon name="paperclip" /></button><span>{settings.aiProvider==='codex'?'Codex · ChatGPT 订阅':'本地规则助手'}</span><button className="assistant-send" onClick={() => runAssistantPrompt()} disabled={!assistantPrompt.trim()||aiBusy||jobBusy} title="整理"><Icon name="send" /></button></div>
              </div>
              <small className="assistant-disclaimer">仅选定的转写文字发送至 Codex；请点击时间戳核对原话，日期不明时不要自行推断。</small>
            </div>
          </aside>
        </div>

      </main>
    );
  };

  const renderLibrary = () => (
    <main id="main-content" className="page library-page">
      <header className="page-header">
        <div><p className="eyebrow">Course Library</p><h1>按课程收好每一段声音</h1><p className="page-intro">一门课可以连续加入多段录音，每段独立转写，最后都留在同一课程下。</p></div>
        <button className="button primary" onClick={openNewRecording}><Icon name="plus" /> 新录音</button>
      </header>
      <section className="course-shelf" aria-label="课程分组">
        <div className="section-heading compact-heading"><div><p className="eyebrow">Your courses</p><h2>课程分组</h2></div><button className="button soft" onClick={() => setShowCourseDialog(true)}><Icon name="plus" /> 新建课程</button></div>
        <div className="course-grid">
          <button className={`course-card all-courses ${courseFilter === 'all' ? 'selected' : ''}`} onClick={() => setCourseFilter('all')}>
            <span className="course-color" /><strong>全部录音</strong><small>{recordings.length} 段 · {totalMinutes} 分钟</small>
          </button>
          {courses.map((course) => {
            const courseRecordings = recordings.filter((recording) => recording.courseId === course.id);
            const minutes = Math.round(courseRecordings.reduce((sum, recording) => sum + recording.durationMs, 0) / 60_000);
            return <article className={`course-card ${courseFilter === course.id ? 'selected' : ''}`} key={course.id}>
              <button className="course-open" onClick={() => setCourseFilter(course.id)}>
                <span className="course-color" style={{ background: course.color }} /><strong>{course.name}</strong><small>{course.term || '个人课程'} · {courseRecordings.length} 段 · {minutes} 分钟</small>
              </button>
              <button className="course-delete" onClick={() => void removeCourse(course)} title="删除课程分组">×</button>
            </article>;
          })}
          <button className={`course-card unfiled ${courseFilter === 'unfiled' ? 'selected' : ''}`} onClick={() => setCourseFilter('unfiled')}>
            <span className="course-color" /><strong>未分组</strong><small>{recordings.filter((recording) => !recording.courseId || recording.courseId === DEFAULT_COURSE_ID).length} 段录音</small>
          </button>
        </div>
      </section>
      <div className="library-toolbar">
        <label className="search-box"><Icon name="search" /><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="搜索所有课堂内容…" /></label>
        <button className="button secondary" onClick={() => chooseImportFiles(courseFilter !== 'all' && courseFilter !== 'unfiled' ? courseFilter : undefined)}><Icon name="upload" /> 批量导入{courseFilter !== 'all' && courseFilter !== 'unfiled' ? '到本课程' : '音频'}</button>
      </div>
      {batchProgress && <div className="batch-banner" role="status">
        <span className="batch-spinner"><Icon name={batchProgress.currentName === '批量处理完成' ? 'check' : 'sparkles'} /></span>
        <div><strong>{batchProgress.currentName}</strong><small>{batchProgress.completed}/{batchProgress.total} 个步骤{batchProgress.failed ? ` · ${batchProgress.failed} 条失败` : ''}</small><i><b style={{ width: `${Math.round((batchProgress.completed / Math.max(1, batchProgress.total)) * 100)}%` }} /></i></div>
      </div>}
      {filteredRecordings.length ? (
        <section className="library-table" aria-label="录音列表">
          <div className="table-head"><span>名称</span><span>内容</span><span>日期</span><span>时长</span><span>操作</span></div>
          {filteredRecordings.map((recording) => (
            <article className="library-row" key={recording.id}>
              <button className="library-title" onClick={() => openRecording(recording)}><span><Icon name="headphones" /></span><strong>{recording.title}</strong></button>
              <span className="content-summary"><b>{recording.segments.length}</b> 片段 · <b>{recording.keyMessages.length}</b> 重点{recording.aiError || recording.analysisError ? <em className="analysis-badge error">需重试</em> : recording.analysisStatus === 'queued' || recording.analysisStatus === 'transcribing' || recording.analysisStatus === 'summarizing' ? <em className="analysis-badge working">生成中</em> : recording.analysisStatus === 'error' ? <em className="analysis-badge error">需重试</em> : recording.analysisStatus === 'ready' ? <em className="analysis-badge ready">已整理</em> : null}</span>
              <time>{formatShortDate(recording.createdAt)}</time>
              <span className="duration">{formatClock(recording.durationMs)}</span>
              <span className="row-actions"><button onClick={() => openRecording(recording)} title="打开"><Icon name="arrow" /></button><button className="danger" onClick={() => void removeRecording(recording)} title="删除"><Icon name="trash" /></button></span>
            </article>
          ))}
        </section>
      ) : (
        <div className="library-empty"><span><Icon name={libraryQuery ? 'search' : 'library'} /></span><h2>{libraryQuery ? '没有找到相关内容' : '资料库还是空的'}</h2><p>{libraryQuery ? '试试课程名、关键词或中文笔记。' : '录音、字幕和笔记都会安全地保存在这里。'}</p>{!libraryQuery && <button className="button primary" onClick={openNewRecording}><Icon name="mic" /> 开始第一条录音</button>}</div>
      )}
    </main>
  );

  const renderSettings = () => (
    <main id="main-content" className="page settings-page">
      <header className="page-header"><div><p className="eyebrow">Preferences</p><h1>设置与隐私</h1><p className="page-intro">选择速度与隐私之间适合你的平衡。</p></div></header>
      <div className="settings-layout">
        <section className="settings-section">
          <div className="settings-heading"><span><Icon name="sparkles" /></span><div><h2>转写与翻译</h2><p>模型只在需要时加载，避免课堂中占满内存。</p></div></div>
          <div className="setting-stack"><div><strong>默认课堂语言</strong><p>新录音和新导入的音频会使用这个模式。</p></div><div className="choice-grid two">
            <button className={settings.recordingMode === 'en-zh' ? 'selected' : ''} onClick={() => applyRecordingMode('en-zh')}><span className="radio-mark">{settings.recordingMode === 'en-zh' && <i />}</span><strong>English → 中文</strong><small>英文原文 + 中文理解</small></button>
            <button className={settings.recordingMode === 'zh' ? 'selected' : ''} onClick={() => applyRecordingMode('zh')}><span className="radio-mark">{settings.recordingMode === 'zh' && <i />}</span><strong>中文课堂</strong><small>中文原话 + AI Notes</small></button>
          </div></div>
          <div className="setting-row"><div><strong>自动生成中文</strong><p>每个完整英文片段结束后自动翻译。</p></div><Toggle checked={settings.autoTranslate} onChange={(checked) => setSettings((value) => ({ ...value, autoTranslate: checked }))} label="自动生成中文" /></div>
          <div className="setting-row"><div><strong>实时 Key Messages</strong><p>Codex 模式下按新增文字每约 30 秒整理一次；速度受订阅额度与网络影响。</p></div><Toggle checked={settings.autoKeyMessages} onChange={(checked) => setSettings((value) => ({ ...value, autoKeyMessages: checked }))} label="实时 Key Messages" /></div>
          <div className="setting-row"><div><strong>导入后自动生成笔记</strong><p>多段音频会依次转写；单条失败不会影响其他文件。</p></div><Toggle checked={settings.autoAnalyzeUploads} onChange={(checked) => setSettings((value) => ({ ...value, autoAnalyzeUploads: checked }))} label="导入后自动生成笔记" /></div>
          <div className="setting-stack"><div><strong>翻译引擎</strong><p>“自动”会优先使用浏览器内置模型，再降级到本地开源模型。</p></div><div className="choice-grid">
            {([
              ['auto', '自动选择', '优先快，兼容性最好'],
              ['browser', '浏览器内置', '新版 Edge / Chrome'],
              ['local', '本地开源模型', '首次下载后可离线'],
            ] as const).map(([value, title, description]) => <button key={value} className={settings.translationPreference === value ? 'selected' : ''} onClick={() => setSettings((current) => ({ ...current, translationPreference: value }))}><span className="radio-mark">{settings.translationPreference === value && <i />}</span><strong>{title}</strong><small>{description}</small></button>)}
          </div></div>
          <div className="setting-stack"><div><strong>精确转写模型</strong><p>用于导入音频或课后校正；首次运行会下载模型文件。</p></div><div className="choice-grid two">
            {([ 
              ['tiny', 'Whisper Tiny', '中英文自适应，更快、更省内存'],
              ['base', 'Whisper Base', '中英文自适应，更准确但更慢'],
            ] as const).map(([value, title, description]) => <button key={value} className={settings.preciseModel === value ? 'selected' : ''} onClick={() => setSettings((current) => ({ ...current, preciseModel: value }))}><span className="radio-mark">{settings.preciseModel === value && <i />}</span><strong>{title}</strong><small>{description}</small></button>)}
          </div></div>
        </section>

        <section className="settings-section api-section">
          <div className="settings-heading"><span><Icon name="sparkles" /></span><div><h2>Codex 订阅连接</h2><p>通过本机桥接服务使用 ChatGPT 登录，不需要 API Key。</p></div></div>
          <div className="api-verdict"><span><Icon name={aiStatus.authenticated?'check':'warning'} /></span><div><small>{aiStatus.connected?'本机服务已连接':'本机服务未就绪'}</small><strong>{aiStatus.authenticated?'ChatGPT 已登录 · '+(aiStatus.planType??'订阅'):'需要检查服务或登录'}</strong><p>{aiStatus.message || 'Luna · low，笔记和问答消耗 Codex 订阅配额，不是 API 钱包余额。'}</p></div></div>
          <div className="setting-row"><label>笔记引擎 <select aria-label="笔记引擎" value={settings.aiProvider} disabled={aiBusy||jobBusy} onChange={event=>setSettings(value=>({...value,aiProvider:event.target.value as 'codex'|'local',aiProviderConfigured:true}))}><option value="codex">Codex · ChatGPT 订阅</option><option value="local">本地规则 · 非大模型</option></select></label><button className="button secondary" onClick={()=>void refreshCodex()}>检查连接</button><button className="button primary" onClick={()=>void connectCodex()} disabled={!aiStatus.connected}>ChatGPT 登录</button></div>
          {aiStatus.rateLimits?.map((limit,index)=><p key={index}>{limit.name}：剩余 {Math.round(limit.remainingPercent)}%{limit.resetsAt?' · 重置 '+new Date(limit.resetsAt*1000).toLocaleString('zh-CN'):''}</p>)}
          <p className="privacy-note">音频在本机进行识别和翻译；启用 Codex 时，选定的转写文字会发送至 OpenAI。网站保存纪要，不会把临时 AI 会话伪装成桌面任务栏的镜像。断网或额度耗尽时保留资料并提示重试。</p>
        </section>

        <section className="settings-section">
          <div className="settings-heading"><span><Icon name="lock" /></span><div><h2>数据与设备</h2><p>录音、转写和笔记保存在浏览器的本地数据库。</p></div></div>
          <div className="capability-grid">
            <div className={recordingSupported ? 'ok' : 'warn'}><Icon name={recordingSupported ? 'check' : 'warning'} /><span><strong>录音能力</strong><small>{recordingSupported ? '可用' : '不可用'}</small></span></div>
            <div className={speechRecognitionConstructor ? 'ok' : 'warn'}><Icon name={speechRecognitionConstructor ? 'check' : 'warning'} /><span><strong>本机实时转写</strong><small>Whisper · 首次需下载模型</small></span></div>
            <div className={webGpuAvailable ? 'ok' : 'neutral'}><Icon name={webGpuAvailable ? 'check' : 'warning'} /><span><strong>WebGPU</strong><small>{webGpuAvailable ? '可用' : '使用 WASM'}</small></span></div>
          </div>
          <div className="privacy-note"><Icon name="lock" /><div><strong>关于“本地优先”</strong><p>录音、图片、字幕和笔记保存在当前浏览器。Codex 模式发送所选文字和待识别图片至 OpenAI，不发送原始录音。连接本机学习库后，新资料的原件与笔记会自动归档。清除浏览器数据前请导出完整备份。</p></div></div>
          <div className="setting-row"><div><strong>安装为桌面应用</strong><p>获得独立窗口和更像原生应用的使用方式。</p></div><button className="button secondary" onClick={() => void installApp()}>安装应用</button></div>
          <div className="setting-row"><div><strong>完整备份 / 恢复</strong><p>包含录音、图片原件、课程与笔记；请先停止录音再备份。文件未加密，请私下保管。</p></div><button className="button secondary" disabled={jobBusy||aiBusy||active?.status==='recording'||active?.status==='paused'} onClick={()=>{if(startingRef.current)return;void backupLocalData().catch(error=>setToast(String(error)));}}>导出完整备份</button><button className="button secondary" disabled={jobBusy||aiBusy||active?.status==='recording'||active?.status==='paused'} onClick={()=>{if(!startingRef.current)backupInputRef.current?.click();}}>恢复备份</button></div>
          <div className="setting-row danger-row"><div><strong>清除所有本地数据</strong><p>永久删除录音、字幕、笔记和偏好。</p></div><button className="button danger-button" onClick={() => void clearEverything()}><Icon name="trash" /> 全部清除</button></div>
        </section>
      </div>
    </main>
  );

  if (!hydrated) return <main className="loading-screen" role="status"><h1>{startupError ? '暂时无法打开资料库' : '正在安全打开资料库…'}</h1><p>{startupError || '检查未完成录音，原有资料不会被清空。'}</p>{startupError && <button className="button primary" onClick={() => window.location.reload()}>重试打开</button>}</main>;
  if (startingRecording) return <main className="loading-screen" role="status"><h1>正在准备录音</h1><p>请完成浏览器的麦克风或共享音频权限选择。此时不会开启第二段录音。</p></main>;

  return (
    <div className="app-shell">
      {renderTopbar()}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="应用导航" aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
        <div className="drawer-brand-row">
          <button className="brand" onClick={() => { setPage('home'); setSidebarOpen(false); }} aria-label="返回首页">
            <span className="brand-mark"><i /><i /><i /><i /></span>
            <span><strong>听澜</strong><small>Lecture Flow</small></span>
          </button>
          <button className="drawer-close" onClick={() => setSidebarOpen(false)} aria-label="关闭导航菜单"><Icon name="close" /></button>
        </div>
        <nav aria-label="主要导航">
          <button className={page === 'home' ? 'active' : ''} onClick={() => { setPage('home'); setSidebarOpen(false); }}><Icon name="home" /><span>首页</span></button>
          <button className={page === 'recorder' && mobilePane === 'notes' ? 'active' : ''} onClick={() => { setPage('recorder'); setNotesTab('brief'); setMobilePane('notes'); setSidebarOpen(false); }}><Icon name="brain" /><span>AI 课堂助手</span></button>
          <button className={page === 'library' && courseFilter === 'all' ? 'active' : ''} onClick={() => { setCourseFilter('all'); setPage('library'); setSidebarOpen(false); }}><Icon name="library" /><span>全部录音</span>{recordings.length > 0 && <b>{recordings.length}</b>}</button>
          <button className={page === 'library' && courseFilter !== 'all' ? 'active' : ''} onClick={() => { setCourseFilter(courses[0]?.id ?? 'unfiled'); setPage('library'); setSidebarOpen(false); }}><Icon name="folder" /><span>课程分组</span>{courses.length > 0 && <b>{courses.length}</b>}</button>
          <button className={page === 'study' ? 'active' : ''} onClick={() => { setPage('study'); setSidebarOpen(false); }}><Icon name="note" /><span>学习资料库</span></button>
          <button className={page === 'settings' ? 'active' : ''} onClick={() => { setPage('settings'); setSidebarOpen(false); }}><Icon name="settings" /><span>设置</span></button>
        </nav>
        <div className="drawer-actions">
          <button onClick={() => { openNewRecording(); setSidebarOpen(false); }}><Icon name="mic" /> 新录音</button>
          <button onClick={() => { chooseImportFiles(); setSidebarOpen(false); }}><Icon name="upload" /> 批量导入</button>
        </div>
        <div className="sidebar-bottom">
          <div className="local-card"><Icon name="lock" /><div><strong>Local first</strong><small>音频留在本机 · 文字可送 Codex</small></div><span className="online-dot" /></div>
          <p>听澜 0.5 · Study Library</p>
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="关闭导航菜单" />}

      <div className="content-shell">
      {!['localhost', '127.0.0.1'].includes(window.location.hostname) && <div className="study-status" role="status"><span>在线资料界面：这里的数据保存在当前浏览器，不会自动同步本机资料。Codex AI 与个人学习库归档需要在电脑上启动完整版本；托管页面不包含你的本机 AI 服务。</span><a className="button secondary" href="http://127.0.0.1:4318/" target="_blank" rel="noreferrer">打开本机完整版</a></div>}
      {importRunningRef.current && <div className="processing-actions"><span>批量音频处理进行中；已导入的音频已保存在本机。</span><button className="button secondary" onClick={()=>{cancelBatchRef.current=true;finalizeAbortRef.current?.abort();analysisAbortRef.current?.abort();aiAbortRef.current?.abort();}}>取消批量处理</button></div>}
      <div className="connection-strip" role="status"><span className={aiStatus.authenticated?'connected':'disconnected'} />{settings.aiProvider==='codex'?(aiStatus.authenticated?'Codex 已连接 · Luna · ChatGPT 订阅':'Codex 未就绪 · 录音可保存，笔记需要连接'):'本地规则模式 · 非大模型'}<button onClick={()=>{setPage('settings');void refreshCodex();}}>连接设置</button><small>学习库 0.5</small></div>

        {!hydrated ? (
          <main id="main-content" className="loading-screen"><span className="loading-mark"><i /><i /><i /><i /></span><p>正在打开你的本地资料库…</p></main>
        ) : page === 'home' ? renderHome() : page === 'recorder' ? renderRecorder() : page === 'library' ? renderLibrary() : page === 'settings' ? renderSettings() : null}
        {hydrated && <StudyLibrary visible={page === 'study'} recordings={recordings} courses={courses} revision={libraryRevision} cancelRef={studyCancelRef} disabled={jobBusy || aiBusy || !!batchProgress || active?.status === 'recording' || active?.status === 'paused'}
          onBusy={busy => { studyBusyRef.current = busy; setStudyBusy(busy); }} onNewCourse={() => setShowCourseDialog(true)}
          onOpenRecording={(id, atMs) => { const recording = recordsRef.current.find(r => r.id === id); if (recording) { if (atMs !== undefined) seekSource(atMs, id); else openRecording(recording); } }}
          onStageAudio={async (files, courseId) => {
            const batchId = makeId('batch'), saved: RecordingSession[] = [];
            for (const file of files) {
              const session: RecordingSession = { ...createSession(settings, file.name.replace(/\.[^.]+$/, ''), courseId), status: 'complete', analysisStatus: 'queued', batchId, sourceFileName: file.name, audioBlob: file, audioMimeType: file.type };
              // Persist bytes before metadata probing or model loading. Cancel never discards selected audio.
              await persistRecording(session); saved.push(session);
            }
            return saved;
          }}
          onAnalyzeAudio={async (recording, signal) => { const result = await analyzeRecording(recording, false, signal); if (result.analysisError || result.aiError) throw new Error(result.analysisError || result.aiError); }}
          onAudioBatchEnd={async staged => {
            for (const original of staged) {
              const latest = recordsRef.current.find(recording => recording.id === original.id);
              if (latest?.analysisStatus === 'queued') await persistRecording({ ...latest, analysisStatus: 'error', analysisError: '批次已停止，此音频尚未处理；原件已保存，请单独重试。' });
            }
          }}
          onCancelAudio={() => { analysisAbortRef.current?.abort(); aiAbortRef.current?.abort(); }} />}
      </div>

      <input ref={backupInputRef} type="file" accept=".json,application/json" hidden onChange={event=>{const file=event.target.files?.[0];if(file)void restoreBackup(file);event.currentTarget.value='';}} />
      <input ref={fileInputRef} type="file" multiple accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg,.mp4" hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) void handleAudioImport(files); event.currentTarget.value = ''; }} />
      {confirmTranscription && <div className="modal-backdrop" role="presentation">
        <section className="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="retranscribe-title">
          <h2 id="retranscribe-title">重新精校这段录音？</h2>
          <p>原音频和当前字幕会保留到新转写完整成功。中途取消时，新结果单独保存为草稿；成功后会重新整理纪要。</p>
          <div className="dialog-actions"><button className="button secondary" autoFocus onClick={()=>setConfirmTranscription(false)}>保留当前版本</button><button className="button primary" onClick={()=>void runPreciseTranscription(true)}>开始重新精校</button></div>
        </section>
      </div>}
      {editingSegment && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingSegment(null); }}>
          <section className="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-dialog-title">
            <div className="dialog-heading">
              <div><p className="eyebrow">{formatClock(editingSegment.startMs)} · {editingSegment.speaker}</p><h2 id="edit-dialog-title">校对这一段</h2></div>
              <button onClick={() => setEditingSegment(null)} aria-label="关闭编辑窗口">×</button>
            </div>
            <label><span>{active?.recordingMode === 'zh' ? '中文原话' : '英文原文'}</span><textarea value={editSource} onChange={(event) => setEditSource(event.target.value)} autoFocus /></label>
            {active?.recordingMode === 'en-zh' && <label><span>中文翻译</span><textarea value={editTranslation} onChange={(event) => setEditTranslation(event.target.value)} /></label>}
            <div className="dialog-actions"><button className="button secondary" onClick={() => setEditingSegment(null)}>取消</button><button className="button primary" onClick={saveSegmentEdit} disabled={!editSource.trim()}>保存修改</button></div>
          </section>
        </div>
      )}
      {showCourseDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCourseDialog(false); }}>
          <section className="edit-dialog course-dialog" role="dialog" aria-modal="true" aria-labelledby="course-dialog-title">
            <div className="dialog-heading"><div><p className="eyebrow">New course</p><h2 id="course-dialog-title">新建课程分组</h2></div><button onClick={() => setShowCourseDialog(false)} aria-label="关闭">×</button></div>
            <label><span>课程名称</span><input value={courseName} onChange={(event) => setCourseName(event.target.value)} placeholder="例如：Cognitive Psychology" autoFocus onKeyDown={(event) => { if (event.key === 'Enter') void createCourseFromDialog(); }} /></label>
            <label><span>学期 / 备注（可选）</span><input value={courseTerm} onChange={(event) => setCourseTerm(event.target.value)} placeholder="例如：2026 Fall" /></label>
            <div className="dialog-actions"><button className="button secondary" onClick={() => setShowCourseDialog(false)}>取消</button><button className="button primary" onClick={() => void createCourseFromDialog()} disabled={!courseName.trim()}>创建课程</button></div>
          </section>
        </div>
      )}
      {toast && <div className="toast" role="status"><Icon name="check" />{toast}</div>}
    </div>
  );
}

export default App;
