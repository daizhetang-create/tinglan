/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

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
    transcriberPromise = pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (event: Record<string, unknown>) => {
        const rawProgress = Number(event.progress ?? 0);
        const progress = rawProgress <= 1 ? rawProgress * 100 : rawProgress;
        self.postMessage({
          type: 'progress',
          label: event.file ? `下载 ${String(event.file).split('/').pop()}` : '下载精确转写模型',
          progress: Number.isFinite(progress) ? Math.round(progress) : undefined,
        });
      },
    }) as Promise<TranscriberPipeline>;
  }
  return transcriberPromise;
}

self.onmessage = async (event: MessageEvent<TranscriptionRequest>) => {
  if (event.data.type !== 'transcribe') return;
  try {
    const sourceLanguage = event.data.sourceLanguage || 'en-US';
    const selectedModel = modelId(event.data.model, sourceLanguage);
    const transcriber = await getTranscriber(selectedModel);
    self.postMessage({
      type: 'working',
      label: isEnglish(sourceLanguage) ? '英文模型正在精确转写' : '多语言模型正在精确转写',
    });
    const result = await (transcriber as unknown as (
      audio: Float32Array,
      options: Record<string, unknown>,
    ) => Promise<{ text: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> }>)(
      event.data.audio,
      {
        chunk_length_s: 20,
        stride_length_s: 4,
        return_timestamps: true,
        language: whisperLanguage(sourceLanguage),
        task: 'transcribe',
      },
    );
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : '精确转写失败',
    });
  }
};

export {};
