import { DEFAULT_SETTINGS, type AppSettings, type Course, type RecordingSession } from '../../types';
import { recoverInterruptedRecording } from './classRecords';
import { openDatabase } from '../../lib/db';
import { materialSourceId, validateMaterial, validateOriginal, type StudyMaterial } from '../study/types';

const DATABASE_NAME = 'tinglan-local';
const STORES = ['recordings', 'courses', 'settings', 'materials'];
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const SECRET_FIELD = /(?:token|password|secret|api.?key|authorization)/i;

export interface LocalSnapshot {
  recordings: RecordingSession[];
  courses: Course[];
  settings: AppSettings;
  materials?: StudyMaterial[];
}

type JsonObject = Record<string, unknown>;

function invalid(detail: string): never {
  throw new Error(`备份无效：${detail}。未修改现有资料。`);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value as JsonObject;
}

function string(value: unknown, label: string, allowEmpty = true): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) invalid(label);
  return value as string;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(label);
  return value as number;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(label);
  return value as unknown[];
}

function oneOf(value: unknown, allowed: string[], label: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid(label);
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined) string(value, label);
}

function date(value: unknown, label: string): void {
  if (!Number.isFinite(Date.parse(string(value, label, false)))) invalid(label);
}

function uniqueIds(values: unknown[], label: string): void {
  const ids = values.map((value) => string(object(value, label).id, `${label}.id`, false));
  if (new Set(ids).size !== ids.length) invalid(`${label}存在重复ID`);
}

function validateSettings(value: unknown): AppSettings {
  const settings = object(value, 'settings');
  for (const key of Object.keys(settings)) {
    if (SECRET_FIELD.test(key)) invalid('设置中不得包含密钥或登录令牌');
  }
  for (const key of ['autoTranslate', 'autoKeyMessages', 'autoAnalyzeUploads']) {
    if (typeof settings[key] !== 'boolean') invalid(`settings.${key}`);
  }
  oneOf(settings.recordingMode, ['zh', 'en-zh'], 'settings.recordingMode');
  oneOf(settings.translationPreference, ['auto', 'browser', 'local'], 'settings.translationPreference');
  oneOf(settings.preciseModel, ['tiny', 'base'], 'settings.preciseModel');
  oneOf(settings.summaryTemplate, ['standard', 'lecture', 'seminar'], 'settings.summaryTemplate');
  oneOf(settings.aiProvider, ['local', 'codex'], 'settings.aiProvider');
  string(settings.sourceLanguage, 'settings.sourceLanguage', false);
  // Chinese-only mode historically stores no translation target as an empty string.
  string(settings.targetLanguage, 'settings.targetLanguage', settings.recordingMode === 'zh');
  return settings as unknown as AppSettings;
}

function validateCourse(value: unknown): Course {
  const course = object(value, 'course');
  for (const key of ['id', 'name', 'color']) string(course[key], `course.${key}`, false);
  string(course.term, 'course.term');
  date(course.createdAt, 'course.createdAt');
  date(course.updatedAt, 'course.updatedAt');
  return course as unknown as Course;
}

function validateRecording(value: unknown): Omit<RecordingSession, 'audioBlob'> {
  const recording = object(value, 'recording');
  for (const key of ['id', 'sourceLanguage']) string(recording[key], `recording.${key}`, false);
  // The existing title editor allows an empty title; backups preserve it verbatim.
  string(recording.title, 'recording.title');
  string(recording.targetLanguage, 'recording.targetLanguage', recording.recordingMode === 'zh');
  for (const key of ['courseId', 'batchId', 'sourceFileName', 'analysisError', 'aiError', 'audioMimeType']) optionalString(recording[key], key);
  if (recording.summaryScope !== undefined) oneOf(recording.summaryScope, ['recording', 'class', 'course'], 'recording.summaryScope');
  date(recording.createdAt, 'recording.createdAt');
  date(recording.updatedAt, 'recording.updatedAt');
  number(recording.durationMs, 'recording.durationMs');
  oneOf(recording.status, ['idle', 'recording', 'paused', 'complete'], 'recording.status');
  oneOf(recording.analysisStatus, ['idle', 'queued', 'transcribing', 'summarizing', 'ready', 'error'], 'recording.analysisStatus');
  oneOf(recording.recordingMode, ['zh', 'en-zh'], 'recording.recordingMode');
  if (recording.audioBlob !== undefined) invalid('音频必须使用备份音频字段');
  optionalString(recording.transcriptionEngine, 'transcriptionEngine');
  optionalString(recording.transcriptionWarning, 'transcriptionWarning');
  if (recording.transcriptionDraft !== undefined) {
    const draft = object(recording.transcriptionDraft, 'transcriptionDraft');
    date(draft.updatedAt, 'transcriptionDraft.updatedAt');
    if (draft.durationMs !== undefined) number(draft.durationMs, 'transcriptionDraft.durationMs');
    const segments = array(draft.segments, 'transcriptionDraft.segments');
    uniqueIds(segments, 'transcriptionDraft.segments');
    for (const row of segments) {
      const item = object(row, 'draft segment');
      for (const key of ['source','translation','speaker']) string(item[key], `draft.${key}`);
      if (number(item.endMs,'draft.endMs') < number(item.startMs,'draft.startMs')) invalid('草稿时间顺序');
    }
  }

  for (const key of ['segments', 'notes', 'bookmarks', 'keyMessages']) uniqueIds(array(recording[key], key), key);
  for (const value of array(recording.segments, 'segments')) {
    const item = object(value, 'segment');
    for (const key of ['source', 'translation', 'speaker']) string(item[key], `segment.${key}`);
    if (number(item.endMs, 'segment.endMs') < number(item.startMs, 'segment.startMs')) invalid('字幕时间顺序');
    if (item.confidence !== undefined && number(item.confidence, 'confidence') > 1) invalid('confidence');
  }
  for (const value of array(recording.notes, 'notes')) {
    const item = object(value, 'note');
    string(item.text, 'note.text');
    number(item.atMs, 'note.atMs');
  }
  for (const value of array(recording.bookmarks, 'bookmarks')) {
    const item = object(value, 'bookmark');
    string(item.label, 'bookmark.label');
    number(item.atMs, 'bookmark.atMs');
  }
  for (const value of array(recording.keyMessages, 'keyMessages')) {
    const item = object(value, 'keyMessage');
    for (const key of ['title', 'detail', 'sourceSegmentId']) string(item[key], `keyMessage.${key}`);
    optionalString(item.sourceRecordingId, 'keyMessage.sourceRecordingId');
    oneOf(item.category, ['concept', 'emphasis', 'assignment', 'exam', 'question', 'admin'], 'keyMessage.category');
    number(item.score, 'keyMessage.score');
    if (number(item.endMs, 'keyMessage.endMs') < number(item.startMs, 'keyMessage.startMs')) invalid('要点时间顺序');
  }
  if (recording.classBrief !== undefined) {
    const brief = object(recording.classBrief, 'classBrief');
    string(brief.overview, 'classBrief.overview');
    date(brief.generatedAt, 'classBrief.generatedAt');
    number(brief.sourceSegmentCount, 'classBrief.sourceSegmentCount');
    oneOf(brief.engine, ['local-rules', 'openai', 'codex'], 'classBrief.engine');
    oneOf(brief.template, ['standard', 'lecture', 'seminar'], 'classBrief.template');
    optionalString(brief.model, 'classBrief.model');
    optionalString(brief.threadId, 'classBrief.threadId');
    const sections = object(brief.sections, 'classBrief.sections');
    for (const key of ['concepts', 'takeaways', 'assignments', 'examReading', 'followUps']) {
      const items = array(sections[key], `classBrief.${key}`);
      uniqueIds(items, `classBrief.${key}`);
      for (const value of items) {
        const item = object(value, 'brief item');
        string(item.text, 'brief item.text');
        number(item.atMs, 'brief item.atMs');
        optionalString(item.sourceSegmentId, 'brief item.sourceSegmentId');
        optionalString(item.sourceRecordingId, 'brief item.sourceRecordingId');
        optionalString(item.due, 'brief item.due');
      }
    }
  }
  return recording as unknown as Omit<RecordingSession, 'audioBlob'>;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
}

function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return btoa(parts.join(''));
}

export async function serializeBackup(snapshot: LocalSnapshot): Promise<Blob> {
  validateSettings(snapshot.settings);
  const recordings = [];
  let totalBytes = 0;
  for (const recording of snapshot.recordings) {
    const { audioBlob, ...metadata } = recording;
    validateRecording(metadata);
    let audio;
    if (audioBlob) {
      totalBytes += audioBlob.size;
      if (totalBytes * 1.4 > MAX_BACKUP_BYTES) throw new Error('完整备份超过1GB，请先分批导出音频，避免浏览器内存不足。');
      const bytes = new Uint8Array(await audioBlob.arrayBuffer());
      audio = { type: audioBlob.type, byteLength: bytes.length, sha256: await sha256(bytes), base64: encodeBase64(bytes) };
    }
    recordings.push({ metadata, audio });
  }
  snapshot.courses.forEach(validateCourse);
  const materials = [];
  for (const material of snapshot.materials ?? []) {
    const { originalBlob, ...metadata } = material;
    validateMaterial(metadata);
    await validateOriginal(material);
    totalBytes += originalBlob.size;
    if (totalBytes * 1.4 > MAX_BACKUP_BYTES) throw new Error('完整备份超过 1 GB，请先分批导出资料。');
    const bytes = new Uint8Array(await originalBlob.arrayBuffer());
    if (await sha256(bytes) !== metadata.sha256) invalid('资料原件校验失败');
    materials.push({ metadata, original: { type: originalBlob.type, byteLength: bytes.length, sha256: metadata.sha256, base64: encodeBase64(bytes) } });
  }
  return new Blob([JSON.stringify({
    format: 'tinglan-backup', version: 2, databaseVersion: 3,
    createdAt: new Date().toISOString(), recordings, materials, courses: snapshot.courses, settings: snapshot.settings,
  })], { type: 'application/json;charset=utf-8' });
}

/** Validate every item and every audio checksum before opening any write transaction. */
export async function parseBackup(file: Blob): Promise<LocalSnapshot> {
  if (!file.size || file.size > MAX_BACKUP_BYTES) invalid('文件为空或超过1GB');
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); } catch { invalid('不是完整JSON文件'); }
  const root = object(parsed, '格式');
  if (root.format !== 'tinglan-backup' || !((root.version === 1 && root.databaseVersion === 2) || (root.version === 2 && root.databaseVersion === 3))) invalid('不支持的备份版本');
  date(root.createdAt, 'createdAt');
  const courses = array(root.courses, 'courses').map(validateCourse);
  uniqueIds(courses, 'courses');
  const settings = validateSettings(root.settings);
  const recordings: RecordingSession[] = [];
  for (const value of array(root.recordings, 'recordings')) {
    const entry = object(value, 'recording entry');
    const metadata = validateRecording(entry.metadata);
    let audioBlob: Blob | undefined;
    if (entry.audio !== undefined) {
      const audio = object(entry.audio, 'audio');
      const encoded = string(audio.base64, 'audio.base64');
      const length = number(audio.byteLength, 'audio.byteLength');
      const mime = string(audio.type, 'audio.type');
      const checksum = string(audio.sha256, 'audio.sha256');
      if (!/^[a-f0-9]{64}$/.test(checksum) || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid('音频编码');
      let decoded: string;
      try { decoded = atob(encoded); } catch { invalid('音频编码'); }
      if (decoded.length !== length) invalid('音频长度不匹配');
      const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
      if (await sha256(bytes) !== checksum) invalid('音频校验失败，文件可能损坏');
      audioBlob = new Blob([bytes], { type: mime });
    }
    recordings.push({ ...metadata, audioBlob });
  }
  uniqueIds(recordings, 'recordings');
  const materials: StudyMaterial[] = [];
  for (const value of root.version === 2 ? array(root.materials, 'materials') : []) {
    const entry = object(value, 'material entry');
    const metadata = validateMaterial(entry.metadata);
    const original = object(entry.original, 'original');
    const encoded = string(original.base64, 'original.base64');
    if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid('资料原件编码');
    let decoded: string;
    try { decoded = atob(encoded); } catch { invalid('资料原件编码'); }
    const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
    if (bytes.length !== number(original.byteLength, 'original.byteLength') || await sha256(bytes) !== metadata.sha256 || original.sha256 !== metadata.sha256) invalid('资料原件校验失败');
    const material = { ...metadata, originalBlob: new Blob([bytes], { type: string(original.type, 'original.type') }) };
    await validateOriginal(material);
    materials.push(material);
  }
  uniqueIds(materials, 'materials');
  const courseIds = new Set(courses.map((course) => course.id));
  for (const recording of recordings) {
    if (recording.courseId && recording.courseId !== 'course-unfiled' && !courseIds.has(recording.courseId)) invalid('录音引用了不存在的课程');
  }
  for (const material of materials) if (material.courseId && material.courseId !== 'course-unfiled' && !courseIds.has(material.courseId)) invalid('资料引用了不存在的课程');
  return { recordings, materials, courses, settings };
}

export async function readLocalSnapshot(databaseName = DATABASE_NAME): Promise<LocalSnapshot> {
  const db = await openDatabase(databaseName, false);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORES, 'readonly');
    const recordings = transaction.objectStore('recordings').getAll();
    const courses = transaction.objectStore('courses').getAll();
    const settings = transaction.objectStore('settings').get('app');
    const materials = transaction.objectStore('materials').getAll();
    transaction.oncomplete = () => {
      db.close();
      resolve({ recordings: recordings.result, materials: materials.result, courses: courses.result, settings: settings.result?.value ?? DEFAULT_SETTINGS });
    };
    transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error('备份读取失败')); };
  });
}

/** Add-only restore. Existing IDs are never overwritten; references are remapped atomically. */
export async function restoreBackup(file: Blob, databaseName = DATABASE_NAME): Promise<{ recordings: number; courses: number; materials: number }> {
  const snapshot = await parseBackup(file);
  const db = await openDatabase(databaseName, false);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORES, 'readwrite');
    const recordingStore = transaction.objectStore('recordings');
    const courseStore = transaction.objectStore('courses');
    const settingsStore = transaction.objectStore('settings');
    const materialStore = transaction.objectStore('materials');
    const materialKeys = materialStore.getAllKeys();
    const recordingKeys = recordingStore.getAllKeys();
    const courseKeys = courseStore.getAllKeys();
    const previousSettings = settingsStore.get('app');
    let readCount = 0;
    const write = () => {
      if (++readCount !== 4) return;
      try {
        const existingRecordingIds = new Set(recordingKeys.result.map(String));
        const existingCourseIds = new Set(courseKeys.result.map(String));
        const recordingMap = new Map(snapshot.recordings.map((item) => [item.id,
          existingRecordingIds.has(item.id) ? `restored-${crypto.randomUUID()}` : item.id]));
        const courseMap = new Map(snapshot.courses.map((item) => [item.id,
          item.id === 'course-unfiled' || !existingCourseIds.has(item.id) ? item.id : `course-restored-${crypto.randomUUID()}`]));
        const batchMap = new Map<string, string>();
        const existingMaterialIds = new Set(materialKeys.result.map(String));
        for (const material of snapshot.materials ?? []) {
          const id = existingMaterialIds.has(material.id) ? `material-restored-${crypto.randomUUID()}` : material.id;
          const sourceMap = new Map(material.blocks.map(b => [materialSourceId(material.id, b.id), materialSourceId(id, b.id)]));
          const restored: StudyMaterial = { ...material, id, courseId: courseMap.get(material.courseId) ?? material.courseId };
          if (['extracting', 'analyzing'].includes(restored.state)) { restored.state = 'error'; restored.error = '上次处理未完成，原件已恢复，请重试识别。'; }
          if (restored.analysis) restored.analysis = { ...restored.analysis, claims: restored.analysis.claims.map(c => ({ ...c, evidence: c.evidence.map(e => ({ ...e, sourceId: sourceMap.get(e.sourceId) ?? e.sourceId })) })) };
          validateMaterial(restored);
          materialStore.add(restored);
        }
        for (const course of snapshot.courses) {
          if (course.id === 'course-unfiled' && existingCourseIds.has(course.id)) continue;
          courseStore.add({ ...course, id: courseMap.get(course.id) });
        }
        for (const recording of snapshot.recordings) {
          const restored = recoverInterruptedRecording({ ...recording, id: recordingMap.get(recording.id)! });
          if (recording.courseId) restored.courseId = courseMap.get(recording.courseId) ?? recording.courseId;
          if (recording.batchId) {
            if (!batchMap.has(recording.batchId)) batchMap.set(recording.batchId, `batch-restored-${crypto.randomUUID()}`);
            restored.batchId = batchMap.get(recording.batchId);
          }
          restored.keyMessages = restored.keyMessages.map((item) => {
            const source = (item as unknown as JsonObject).sourceRecordingId;
            return typeof source === 'string' ? { ...item, sourceRecordingId: recordingMap.get(source) ?? source } : item;
          });
          if (restored.classBrief) {
            restored.classBrief = {
              ...restored.classBrief,
              sections: Object.fromEntries(Object.entries(restored.classBrief.sections).map(([key, items]) => [key, items.map((item) => {
                const source = (item as unknown as JsonObject).sourceRecordingId;
                return typeof source === 'string' ? { ...item, sourceRecordingId: recordingMap.get(source) ?? source } : item;
              })])) as NonNullable<RecordingSession['classBrief']>['sections'],
            };
          }
          recordingStore.add(restored);
        }
        if (previousSettings.result) settingsStore.add({ ...previousSettings.result, key: `before-restore-${crypto.randomUUID()}` });
        settingsStore.put({ key: 'app', value: snapshot.settings });
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
    recordingKeys.onsuccess = courseKeys.onsuccess = previousSettings.onsuccess = materialKeys.onsuccess = write;
    transaction.oncomplete = () => { db.close(); resolve({ recordings: snapshot.recordings.length, materials: snapshot.materials?.length ?? 0, courses: snapshot.courses.length }); };
    transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error('恢复失败，所有改动已回滚，原资料未改变。')); };
  });
}

export async function backupLocalData(): Promise<void> {
  const backup = await serializeBackup(await readLocalSnapshot());
  const url = URL.createObjectURL(backup);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `tinglan-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function restoreLocalData(file: File): Promise<{ recordings: number; courses: number; materials: number }> {
  return restoreBackup(file);
}
