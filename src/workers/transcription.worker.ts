/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
// onnxruntime-web 1.26 currently cannot open the q8 Whisper exports used by
// Transformers.js 4.2.0 (TransposeDQWeightsForMatMulNBits / missing scale).
// fp32 is larger, but it is the verified WASM compatibility path and remains
// cached by the browser after the first download.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

type WhisperSize = 'tiny' | 'base';
type TranscriberPipeline = Awaited<ReturnType<typeof pipeline>>;

interface TranscriptionRequest {
  type: 'transcribe';
  audio: Float32Array;
  model: WhisperSize;
  sourceLanguage?: string;
}

let loadedModel = '';
let transcriberPromise: Promise<TranscriberPipeline> | undefined;

function isEnglish(language: string): boolean {
  return language.trim().toLowerCase().split(/[-_]/)[0] === 'en';
}

function whisperLanguage(language: string): string {
  const code = language.trim().toLowerCase().split(/[-_]/)[0];
  const names: Record<string, string> = {
    en: 'english',
    zh: 'chinese',
    yue: 'cantonese',
    ja: 'japanese',
    ko: 'korean',
    fr: 'french',
    de: 'german',
    es: 'spanish',
    it: 'italian',
    pt: 'portuguese',
    ru: 'russian',
  };
  return names[code] ?? code;
}

function modelId(size: WhisperSize, sourceLanguage: string): string {
  const suffix = isEnglish(sourceLanguage) ? '.en' : '';
  return `onnx-community/whisper-${size}${suffix}`;
}

function getTranscriber(model: string): Promise<TranscriberPipeline> {
  if (!transcriberPromise || loadedModel !== model) {
    loadedModel = model;
    const pending = pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: 'fp32',
      progress_callback: (event: Record<string, unknown>) => {
        const rawProgress = Number(event.progress ?? 0);
        const progress = rawProgress;
        self.postMessage({
          type: 'progress',
          label: event.file ? `首次下载兼容模型 · ${String(event.file).split('/').pop()}` : '准备兼容版精确转写模型',
          progress: Number.isFinite(progress) ? Math.round(progress) : undefined,
        });
      },
    }) as Promise<TranscriberPipeline>;
    const guarded = pending.catch((error) => {
      // A failed model load must not poison every later retry in this worker.
      if (transcriberPromise === guarded) transcriberPromise = undefined;
      loadedModel = '';
      throw error;
    });
    transcriberPromise = guarded;
  }
  return transcriberPromise;
}

self.onmessage = async (event: MessageEvent<TranscriptionRequest>) => {
  if (event.data.type !== 'transcribe') return;
  try {
    if (!event.data.audio?.length || !event.data.audio.every(Number.isFinite)) {
      throw new Error('音频为空或已损坏，请重新选择可播放的录音');
    }
    if (!event.data.audio.some((value) => Math.abs(value) > 0.0001)) {
      throw new Error('音频没有可识别的声音，请检查麦克风输入');
    }
    const sourceLanguage = event.data.sourceLanguage || 'en-US';
    const selectedModel = modelId(event.data.model, sourceLanguage);
    const transcriber = await getTranscriber(selectedModel);
    self.postMessage({
      type: 'working',
      label: isEnglish(sourceLanguage) ? '兼容模式正在转写英文' : '兼容模式正在转写中文',
    });
    const generationOptions: Record<string, unknown> = {
      chunk_length_s: 20,
      stride_length_s: 4,
      return_timestamps: true,
    };
    // Transformers.js rejects language/task hints for Whisper `.en` models.
    // Multilingual checkpoints need both hints for deterministic Chinese ASR.
    if (!isEnglish(sourceLanguage)) {
      generationOptions.language = whisperLanguage(sourceLanguage);
      generationOptions.task = 'transcribe';
    }
    const result = await (transcriber as unknown as (
      audio: Float32Array,
      options: Record<string, unknown>,
    ) => Promise<{ text: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> }>)(
      event.data.audio,
      generationOptions,
    );
    if (!result.text?.trim() && !result.chunks?.some((chunk) => chunk.text.trim())) {
      throw new Error('未识别到清晰语音，录音已保留，请检查音量或重新转写');
    }
    self.postMessage({ type: 'result', result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '精确转写失败';
    self.postMessage({
      type: 'error',
      message: /Missing required scale|TransposeDQWeightsForMatMulNBits/i.test(detail)
        ? '转写引擎版本不兼容，请重新打开最新版本后重试。无需清除录音或网站数据。'
        : /fetch|network|load file|download/i.test(detail)
          ? '模型下载或读取失败。请检查网络后重试；首次使用需要下载模型，录音不会丢失。'
          : `本地转写失败：${detail}`,
    });
  }
};

export {};
