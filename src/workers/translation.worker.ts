/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

type TranslatorPipeline = Awaited<ReturnType<typeof pipeline>>;
let translatorPromise: Promise<TranslatorPipeline> | undefined;

function getTranslator(): Promise<TranslatorPipeline> {
  if (!translatorPromise) {
    const pending = pipeline('translation', 'Xenova/opus-mt-en-zh', {
      device: 'wasm',
      // Keep the translation fallback on the same known-good compatibility
      // path as Whisper; q8 is affected by the same ORT 1.26 scale bug.
      dtype: 'fp32',
      progress_callback: (event: Record<string, unknown>) => {
        const rawProgress = Number(event.progress ?? 0);
        const progress = rawProgress;
        self.postMessage({
          type: 'progress',
          label: event.file ? `下载 ${String(event.file).split('/').pop()}` : '下载本地英译中模型',
          progress: Number.isFinite(progress) ? Math.round(progress) : undefined,
        });
      },
    }) as Promise<TranslatorPipeline>;
    const guarded = pending.catch((error) => {
      if (translatorPromise === guarded) translatorPromise = undefined;
      throw error;
    });
    translatorPromise = guarded;
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
    const translated = output[0]?.translation_text?.trim();
    if (!translated) throw new Error('翻译未返回内容，英文原文已保留，可稍后重试');
    self.postMessage({ type: 'result', requestId, text: translated });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : '本地翻译失败',
    });
  }
};

export {};
