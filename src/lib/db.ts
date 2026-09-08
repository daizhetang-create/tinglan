import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Course,
  type RecordingMode,
  type RecordingSession,
} from '../types';
import { validateMaterial, type StudyMaterial } from '../features/study/types';

const DB_NAME = 'tinglan-local';
const DB_VERSION = 4;
const CAPTURES = 'captureSessions';
const CHUNKS = 'captureChunks';
const RECORDINGS = 'recordings';
const SETTINGS = 'settings';
const COURSES = 'courses';
const MATERIALS = 'materials';

export const DEFAULT_COURSE_ID = 'course-unfiled';

type LegacySettings = Partial<Omit<AppSettings, 'preciseModel'>> & {
  preciseModel?: AppSettings['preciseModel'] | 'tiny-en' | 'base-en';
};

function nowIso(): string {
  return new Date().toISOString();
}

function defaultCourse(at = nowIso()): Course {
  return {
    id: DEFAULT_COURSE_ID,
    name: '未分组',
    term: '',
    color: '#6f9d8f',
    createdAt: at,
    updatedAt: at,
  };
}

function normalizeRecordingMode(value: unknown, sourceLanguage: string): RecordingMode {
  if (value === 'zh' || value === 'en-zh') return value;
  return sourceLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en-zh';
}

function normalizeRecording(value: RecordingSession | Record<string, unknown>): RecordingSession {
  const raw = value as Partial<RecordingSession> & Record<string, unknown>;
  const sourceLanguage = typeof raw.sourceLanguage === 'string' ? raw.sourceLanguage : 'en-US';
  const recordingMode = normalizeRecordingMode(raw.recordingMode, sourceLanguage);
  const hasAnalysis = Boolean(raw.classBrief) || (Array.isArray(raw.keyMessages) && raw.keyMessages.length > 0);

  return {
    ...raw,
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : '课堂记录',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
    status:
      raw.status === 'idle' || raw.status === 'recording' || raw.status === 'paused' || raw.status === 'complete'
        ? raw.status
        : 'complete',
    analysisStatus:
      raw.analysisStatus === 'idle' ||
      raw.analysisStatus === 'queued' ||
      raw.analysisStatus === 'transcribing' ||
      raw.analysisStatus === 'summarizing' ||
      raw.analysisStatus === 'ready' ||
      raw.analysisStatus === 'error'
        ? raw.analysisStatus
        : hasAnalysis
          ? 'ready'
          : 'idle',
    recordingMode,
    sourceLanguage: recordingMode === 'zh' && !sourceLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : sourceLanguage,
    targetLanguage: typeof raw.targetLanguage === 'string' ? raw.targetLanguage : 'zh-CN',
    courseId: typeof raw.courseId === 'string' && raw.courseId ? raw.courseId : DEFAULT_COURSE_ID,
    segments: Array.isArray(raw.segments) ? raw.segments : [],
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks : [],
    keyMessages: Array.isArray(raw.keyMessages) ? raw.keyMessages : [],
  } as RecordingSession;
}

function normalizeSettings(value?: LegacySettings): AppSettings {
  const preciseModel = value?.preciseModel === 'tiny' || value?.preciseModel === 'tiny-en' ? 'tiny' : 'base';
  const recordingMode: RecordingMode =
    value?.recordingMode === 'zh' || value?.sourceLanguage?.toLowerCase().startsWith('zh') ? 'zh' : 'en-zh';
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    recordingMode,
    sourceLanguage:
      recordingMode === 'zh'
        ? value?.sourceLanguage?.toLowerCase().startsWith('zh')
          ? value.sourceLanguage
          : 'zh-CN'
        : value?.sourceLanguage ?? DEFAULT_SETTINGS.sourceLanguage,
    preciseModel,
    // Older builds hard-coded local mode. This release adopts the user's chosen subscription route;
    // later explicit local-mode selections are retained.
    aiProvider: value?.aiProviderConfigured && value.aiProvider === 'local' ? 'local' : 'codex',
    aiProviderConfigured: true,
  };
}

function transactionDone(transaction: IDBTransaction, fallback: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(fallback));
    transaction.onabort = () => reject(transaction.error ?? new Error(fallback));
  });
}

export function openDatabase(name = DB_NAME, seedDefaultCourse = true): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(name, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) return;

      let recordingsStore: IDBObjectStore;
      if (!db.objectStoreNames.contains(RECORDINGS)) {
        recordingsStore = db.createObjectStore(RECORDINGS, { keyPath: 'id' });
      } else {
        recordingsStore = transaction.objectStore(RECORDINGS);
      }
      if (!recordingsStore.indexNames.contains('createdAt')) {
        recordingsStore.createIndex('createdAt', 'createdAt');
      }
      if (!recordingsStore.indexNames.contains('courseId')) {
        recordingsStore.createIndex('courseId', 'courseId');
      }
      if (!recordingsStore.indexNames.contains('courseUpdatedAt')) {
        recordingsStore.createIndex('courseUpdatedAt', ['courseId', 'updatedAt']);
      }

      let settingsStore: IDBObjectStore;
      if (!db.objectStoreNames.contains(SETTINGS)) {
        settingsStore = db.createObjectStore(SETTINGS, { keyPath: 'key' });
      } else {
        settingsStore = transaction.objectStore(SETTINGS);
      }

      let coursesStore: IDBObjectStore;
      if (!db.objectStoreNames.contains(COURSES)) {
        coursesStore = db.createObjectStore(COURSES, { keyPath: 'id' });
      } else {
        coursesStore = transaction.objectStore(COURSES);
      }
      if (!coursesStore.indexNames.contains('updatedAt')) {
        coursesStore.createIndex('updatedAt', 'updatedAt');
      }
      if (!coursesStore.indexNames.contains('name')) {
        coursesStore.createIndex('name', 'name');
      }

      if (!db.objectStoreNames.contains(MATERIALS)) {
        const materials = db.createObjectStore(MATERIALS, { keyPath: 'id' });
        materials.createIndex('courseId', 'courseId');
        materials.createIndex('sha256', 'sha256');
      }

      if (!db.objectStoreNames.contains(CAPTURES)) db.createObjectStore(CAPTURES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNKS)) {
        db.createObjectStore(CHUNKS, { keyPath: ['recordingId', 'sequence'] }).createIndex('recordingId', 'recordingId');
      }

      if (event.oldVersion < 2) {
        if (seedDefaultCourse) coursesStore.put(defaultCourse(nowIso()));
        const cursorRequest = recordingsStore.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          cursor.update(normalizeRecording(cursor.value as RecordingSession));
          cursor.continue();
        };

        const settingsRequest = settingsStore.get('app');
        settingsRequest.onsuccess = () => {
          const saved = (settingsRequest.result as { key: string; value?: LegacySettings } | undefined)?.value;
          if (saved) settingsStore.put({ key: 'app', value: normalizeSettings(saved) });
        };
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onblocked = () => { blocked = true; reject(new Error('数据库升级被其他听澜窗口阻塞，请关闭其他窗口后重试')); };
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地数据操作失败'));
  });
}

export async function listCourses(): Promise<Course[]> {
  const db = await openDatabase();
  const transaction = db.transaction(COURSES, 'readonly');
  const items = await requestResult(transaction.objectStore(COURSES).getAll());
  await transactionDone(transaction, '课程读取失败');
  db.close();
  return (items as Course[]).sort((a, b) => {
    if (a.id === DEFAULT_COURSE_ID) return -1;
    if (b.id === DEFAULT_COURSE_ID) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

export async function getCourse(id: string): Promise<Course | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(COURSES, 'readonly');
  const item = await requestResult(transaction.objectStore(COURSES).get(id));
  await transactionDone(transaction, '课程读取失败');
  db.close();
  return item as Course | undefined;
}

export async function createCourse(input: { name: string; term?: string; color?: string }): Promise<Course> {
  const createdAt = nowIso();
  const course: Course = {
    id: `course-${crypto.randomUUID()}`,
    name: input.name.trim() || '未命名课程',
    term: input.term?.trim() ?? '',
    color: input.color ?? '#7f72d8',
    createdAt,
    updatedAt: createdAt,
  };
  await saveCourse(course);
  return course;
}

export async function saveCourse(course: Course): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(COURSES, 'readwrite');
  transaction.objectStore(COURSES).put({
    ...course,
    name: course.name.trim() || '未命名课程',
    term: course.term.trim(),
    updatedAt: nowIso(),
  });
  await transactionDone(transaction, '课程保存失败');
  db.close();
}

export function deleteCourse(id: string): Promise<void> {
  return queueRecordingWrite(()=>deleteCourseNow(id));
}

async function deleteCourseNow(id: string): Promise<void> {
  if (id === DEFAULT_COURSE_ID) throw new Error('默认的“未分组”课程不能删除');
  const db = await openDatabase();
  const transaction = db.transaction([COURSES, RECORDINGS, MATERIALS], 'readwrite');
  const coursesStore = transaction.objectStore(COURSES);
  const recordingsStore = transaction.objectStore(RECORDINGS);
  coursesStore.put(defaultCourse());
  coursesStore.delete(id);

  const cursorRequest = recordingsStore.index('courseId').openCursor(IDBKeyRange.only(id));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    cursor.update({ ...cursor.value, courseId: DEFAULT_COURSE_ID, updatedAt: nowIso() });
    cursor.continue();
  };

  const materialCursor = transaction.objectStore(MATERIALS).index('courseId').openCursor(IDBKeyRange.only(id));
  materialCursor.onsuccess = () => {
    const cursor = materialCursor.result;
    if (!cursor) return;
    cursor.update({ ...cursor.value, courseId: DEFAULT_COURSE_ID, courseConfirmed: false, updatedAt: nowIso() });
    cursor.continue();
  };

  await transactionDone(transaction, '课程删除失败');
  db.close();
}

export async function listRecordings(courseId?: string): Promise<RecordingSession[]> {
  const db = await openDatabase();
  const transaction = db.transaction(RECORDINGS, 'readonly');
  const store = transaction.objectStore(RECORDINGS);
  const request = courseId ? store.index('courseId').getAll(IDBKeyRange.only(courseId)) : store.getAll();
  const items = await requestResult(request);
  await transactionDone(transaction, '录音读取失败');
  db.close();
  return (items as RecordingSession[])
    .map((item) => normalizeRecording(item))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getRecording(id: string): Promise<RecordingSession | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(RECORDINGS, 'readonly');
  const item = await requestResult(transaction.objectStore(RECORDINGS).get(id));
  await transactionDone(transaction, '录音读取失败');
  db.close();
  return item ? normalizeRecording(item as RecordingSession) : undefined;
}

let recordingWrites: Promise<void> = Promise.resolve();
function queueRecordingWrite<T>(operation:()=>Promise<T>):Promise<T>{
  const pending=recordingWrites.then(operation);
  recordingWrites=pending.then(()=>undefined,()=>undefined);
  return pending;
}
export function saveRecording(recording: RecordingSession): Promise<void> {
  // Snapshot at invocation and serialize writes so an older auto-save cannot finish after a newer stage.
  const snapshot = structuredClone(recording);
  return queueRecordingWrite(() => writeRecording(snapshot));
}

async function writeRecording(recording: RecordingSession): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(RECORDINGS, 'readwrite');
  transaction.objectStore(RECORDINGS).put(normalizeRecording(recording));
  await transactionDone(transaction, '录音保存失败');
  db.close();
}

export function deleteRecording(id: string, name = DB_NAME): Promise<void> {
  return queueRecordingWrite(()=>deleteRecordingNow(id, name));
}

async function deleteRecordingNow(id: string, name: string): Promise<void> {
  const db = await openDatabase(name);
  const transaction = db.transaction([RECORDINGS, CAPTURES, CHUNKS], 'readwrite');
  transaction.objectStore(RECORDINGS).delete(id);
  clearCaptureInTransaction(transaction, id);
  await transactionDone(transaction, '删除失败');
  db.close();
}

export async function loadSettings(): Promise<AppSettings> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS, 'readonly');
  const item = await requestResult(transaction.objectStore(SETTINGS).get('app'));
  await transactionDone(transaction, '设置读取失败');
  db.close();
  const saved = (item as { key: string; value: LegacySettings } | undefined)?.value;
  return normalizeSettings(saved);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(SETTINGS, 'readwrite');
  transaction.objectStore(SETTINGS).put({ key: 'app', value: normalizeSettings(settings) });
  await transactionDone(transaction, '设置保存失败');
  db.close();
}

export function clearLocalData(name = DB_NAME): Promise<void> {
  return queueRecordingWrite(() => clearLocalDataNow(name));
}

async function clearLocalDataNow(name: string): Promise<void> {
  const db = await openDatabase(name);
  const transaction = db.transaction([RECORDINGS, SETTINGS, COURSES, MATERIALS, CAPTURES, CHUNKS], 'readwrite');
  transaction.objectStore(CAPTURES).clear();
  transaction.objectStore(CHUNKS).clear();
  transaction.objectStore(MATERIALS).clear();
  transaction.objectStore(RECORDINGS).clear();
  transaction.objectStore(SETTINGS).clear();
  const coursesStore = transaction.objectStore(COURSES);
  coursesStore.clear();
  coursesStore.put(defaultCourse());
  await transactionDone(transaction, '清除数据失败');
  db.close();
}

export async function listMaterials(): Promise<StudyMaterial[]> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(MATERIALS, 'readonly');
    const done = transactionDone(tx, '学习资料读取失败');
    const rows = await requestResult(tx.objectStore(MATERIALS).getAll());
    await done;
    return (rows as StudyMaterial[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } finally { db.close(); }
}

export function saveMaterial(material: StudyMaterial): Promise<void> {
  validateMaterial(material);
  const snapshot = structuredClone(material);
  return queueRecordingWrite(async () => {
    const db = await openDatabase();
    try {
      const tx = db.transaction(MATERIALS, 'readwrite');
      tx.objectStore(MATERIALS).put(snapshot);
      await transactionDone(tx, '学习资料保存失败');
    } finally { db.close(); }
  });
}

interface CaptureSession { id: string; recording: RecordingSession; mimeType: string }
interface CaptureChunk { recordingId: string; sequence: number; blob: Blob; elapsedMs: number }

function clearCaptureInTransaction(tx: IDBTransaction, id: string): void {
  tx.objectStore(CAPTURES).delete(id);
  tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
}

export async function beginCaptureJournal(recording: RecordingSession, mimeType: string, name = DB_NAME): Promise<void> {
  const db = await openDatabase(name);
  try {
    const tx = db.transaction([RECORDINGS, CAPTURES], 'readwrite', { durability: 'strict' });
    const done = transactionDone(tx, '无法开启录音自动保存，请检查存储空间');
    tx.objectStore(RECORDINGS).put(normalizeRecording(recording));
    // add, not put: a second capture must never replace an unfinished original.
    tx.objectStore(CAPTURES).add({ id: recording.id, recording, mimeType } satisfies CaptureSession);
    await done;
  } finally { db.close(); }
}

export async function appendCaptureChunk(chunk: CaptureChunk, name = DB_NAME): Promise<void> {
  const db = await openDatabase(name);
  try {
    const tx = db.transaction([CAPTURES, CHUNKS], 'readwrite', { durability: 'strict' });
    const done = transactionDone(tx, '录音片段保存失败，请立即停止并导出原音频');
    const request = tx.objectStore(CAPTURES).get(chunk.recordingId);
    request.onsuccess = () => {
      if (!request.result) { tx.abort(); return; }
      tx.objectStore(CHUNKS).add(chunk);
    };
    await done;
  } finally { db.close(); }
}

/** Only call for a capture that failed before MediaRecorder.start; never remove any saved bytes. */
export async function discardEmptyCaptureJournal(id: string, name = DB_NAME): Promise<void> {
  const db = await openDatabase(name);
  try {
    const tx = db.transaction([CAPTURES, CHUNKS], 'readwrite', { durability: 'strict' });
    const done = transactionDone(tx, '未启动的录音清理失败');
    const request = tx.objectStore(CHUNKS).index('recordingId').count(id);
    request.onsuccess = () => { if (request.result === 0) tx.objectStore(CAPTURES).delete(id); };
    await done;
  } finally { db.close(); }
}

export function finishCaptureJournal(recording: RecordingSession, name = DB_NAME): Promise<RecordingSession> {
  return queueRecordingWrite(async () => {
    const db = await openDatabase(name);
    try {
      const tx = db.transaction([RECORDINGS, CAPTURES, CHUNKS], 'readwrite', { durability: 'strict' });
      const done = transactionDone(tx, '完整录音保存失败；已保存片段会在下次打开时恢复');
      let finished = recording;
      const request = tx.objectStore(RECORDINGS).get(recording.id);
      request.onsuccess = () => {
        // Live subtitles / handwritten notes may arrive while chunk writes drain.
        finished = normalizeRecording({ ...recording, ...request.result, status: recording.status,
          analysisStatus: recording.analysisStatus, analysisError: recording.analysisError,
          audioBlob: recording.audioBlob, audioMimeType: recording.audioMimeType,
          durationMs: recording.durationMs, updatedAt: nowIso() });
        tx.objectStore(RECORDINGS).put(finished);
        clearCaptureInTransaction(tx, recording.id);
      };
      await done;
      return finished;
    } finally { db.close(); }
  });
}

/** Caller must hold the origin's workspace lock; never recover another live window. */
export async function recoverCaptureJournals(name = DB_NAME): Promise<number> {
  const db = await openDatabase(name);
  let sessions: CaptureSession[];
  let chunks: CaptureChunk[];
  let recordings: RecordingSession[];
  try {
    const tx = db.transaction([RECORDINGS, CAPTURES, CHUNKS], 'readonly');
    const done = transactionDone(tx, '录音恢复读取失败');
    [sessions, chunks, recordings] = await Promise.all([
      requestResult(tx.objectStore(CAPTURES).getAll()), requestResult(tx.objectStore(CHUNKS).getAll()),
      requestResult(tx.objectStore(RECORDINGS).getAll()),
    ]);
    await done;
  } finally { db.close(); }
  let recovered = 0;
  for (const session of sessions) {
    const latest = recordings.find(r => r.id === session.id) ?? session.recording;
    // An already-finalized original wins. Retain unexpected conflicting chunks for manual recovery.
    if (latest.audioBlob?.size) continue;
    const ordered = chunks.filter(c => c.recordingId === session.id).sort((a, b) => a.sequence - b.sequence);
    const contiguous: CaptureChunk[] = [];
    for (const chunk of ordered) {
      if (chunk.sequence !== contiguous.length) break;
      contiguous.push(chunk);
    }
    const blob = new Blob(contiguous.map(c => c.blob), { type: session.mimeType });
    const warning = contiguous.length !== ordered.length
      ? '检测到不连续片段，只恢复了中断前连续部分。请保留原件并核对音频。'
      : blob.size ? '已恢复意外关闭前保存的录音；最后未写入的片段可能缺失。可重新转写并生成笔记。'
        : '录音在第一个片段保存前中断，没有可恢复的音频。';
    const restored: RecordingSession = { ...latest, status: 'complete', analysisStatus: 'error', analysisError: warning,
      audioBlob: blob.size ? blob : undefined, audioMimeType: session.mimeType,
      durationMs: contiguous.at(-1)?.elapsedMs ?? 0, updatedAt: nowIso() };
    // Preserve non-contiguous evidence for support; ordinary contiguous journals finalize atomically.
    if (contiguous.length !== ordered.length) {
      const target = await openDatabase(name);
      try {
        const tx = target.transaction(RECORDINGS, 'readwrite');
        const done = transactionDone(tx, '恢复保存失败'); tx.objectStore(RECORDINGS).put(restored); await done;
      } finally { target.close(); }
    } else await finishCaptureJournal(restored, name);
    recovered += 1;
  }
  return recovered;
}
