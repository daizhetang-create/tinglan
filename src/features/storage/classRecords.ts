import type { RecordingSession } from '../../types';

/** A batch identifies one class; a course can contain many independent classes. */
export function getClassRecordings(records: RecordingSession[], active: RecordingSession): RecordingSession[] {
  const candidates = new Map(records.map((recording) => [recording.id, recording]));
  candidates.set(active.id, active);
  return [...candidates.values()]
    .filter((recording) => active.batchId ? recording.batchId === active.batchId : recording.id === active.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function getCourseRecordings(records: RecordingSession[], courseId: string): RecordingSession[] {
  return records
    .filter((recording) => (recording.courseId || 'course-unfiled') === courseId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Call only while hydrating persisted records, never on an actively running job. */
export function recoverInterruptedRecording(recording: RecordingSession): RecordingSession {
  const captureInterrupted = recording.status === 'recording' || recording.status === 'paused';
  const analysisInterrupted = ['queued', 'transcribing', 'summarizing'].includes(recording.analysisStatus);
  if (!captureInterrupted && !analysisInterrupted) return recording;
  return {
    ...recording,
    status: 'complete',
    analysisStatus: 'error',
    analysisError: recording.audioBlob?.size
      ? '上次处理被关闭或刷新中断，已有音频和文字已保留。请重试转写或重新整理笔记。'
      : '上次录音未正常结束，未保存到完整音频。已有文字和笔记已保留；请补充导入原音频。',
  };
}

export interface CourseSource {
  recordingId: string;
  recordingTitle: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  translation: string;
}

/** Preserve per-recording time, not a fabricated continuous timestamp. */
export function getRecordingSources(recordings: RecordingSession[]): CourseSource[] {
  return recordings.flatMap((recording) => recording.segments
    .filter((segment) => segment.source.trim())
    .map((segment) => ({
      recordingId: recording.id,
      recordingTitle: recording.title,
      segmentId: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.source,
      translation: segment.translation,
    })));
}
