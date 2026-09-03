/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

type TranslatorPipeline = Awaited<ReturnType<typeof pipeline>>;
let translatorPromise: Promise<TranslatorPipeline> | undefined;

function getTranslator(): Promise<TranslatorPipeline> {
  if (!translatorPromise) {
    translatorPromise = pipeline('translation', 'onnx-community/opus-mt-en-zh', {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (event: Record<string, unknown>) => {
        const rawProgress = Number(event.progress ?? 0);
        const progress = rawProgress <= 1 ? rawProgress * 100 : rawProgress;
        self.postMessage({
          type: 'progress',
          label: event.file ? `下载 ${String(event.file).split('/').pop()}` : '下载本地英译中模型',
          progress: Number.isFinite(progress) ? Math.round(progress) : undefined,
        });
      },
    }) as Promise<TranslatorPipeline>;
  }
  return translatorPromise;
}

self.onmessage = async (event: MessageEvent<{ type: string; requestId: string; text: string }>) => {
  if (event.data.type !== 'translate') return;
  const { requestId, text } = event.data;
  try {
    const translator = await getTranslator();
    const output = await (translator as unknown as (
      value: string,
      options: Record<string, unknown>,
    ) => Promise<Array<{ translation_text?: string }>>)(text, { max_new_tokens: 256 });
    self.postMessage({ type: 'result', requestId, text: output[0]?.translation_text ?? '' });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : '本地翻译失败',
    });
  }
};

export {};
