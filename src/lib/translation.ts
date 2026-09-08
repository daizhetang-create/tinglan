import type { ModelProgress, TranslationPreference } from '../types';

type ProgressListener = (progress: ModelProgress) => void;

async function bounded<T>(promise: Promise<T>, milliseconds: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_,reject)=>{timer=setTimeout(()=>{onTimeout?.();reject(new Error('浏览器翻译响应超时，已回退本地模型'));},milliseconds);})]);
  } finally { clearTimeout(timer); }
}

interface WorkerReply {
  type: 'progress' | 'result' | 'error';
  requestId?: string;
  text?: string;
  message?: string;
  progress?: number;
  label?: string;
}

interface BrowserTranslator {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

interface TranslatorFactory {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: EventTarget) => void;
  }): Promise<BrowserTranslator>;
}

export class TranslationService {
  private preference: TranslationPreference;
  private listener: ProgressListener;
  private browserTranslator?: BrowserTranslator;
  private browserChecked = false;
  private worker?: Worker;
  private pending = new Map<string, { resolve: (value: string) => void; reject: (reason: Error) => void }>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private queuedTasks = 0;
  private epoch = 0;

  constructor(preference: TranslationPreference, listener: ProgressListener) {
    this.preference = preference;
    this.listener = listener;
  }

  setPreference(preference: TranslationPreference): void {
    this.preference = preference;
  }

  async translate(text: string): Promise<string> {
    if (this.disposed) throw new Error('翻译服务已关闭');
    const clean = text.trim();
    if (!clean) return '';
    if (this.queuedTasks >= 24) throw new Error('翻译队列暂时繁忙，英文原文已保留，请稍后重试');

    this.queuedTasks += 1;
    const epoch = this.epoch;
    const task = this.queue.then(() => {
      if (epoch !== this.epoch) throw new Error('上次翻译未完成，原文已保留；请重试');
      return this.performTranslation(clean);
    }).catch(error=>{if(epoch===this.epoch)this.epoch++;throw error;}).finally(() => { this.queuedTasks -= 1; });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async performTranslation(clean: string): Promise<string> {
    if (this.disposed) throw new Error('翻译服务已关闭');
    if (this.preference !== 'local') {
      const translator = await this.getBrowserTranslator();
      if (this.disposed) throw new Error('翻译服务已关闭');
      if (translator) {
        this.listener({ label: '浏览器翻译中', state: 'working' });
        try {
          const result = await bounded(translator.translate(clean), 10000);
          this.listener({ label: '浏览器翻译已就绪', state: 'ready' });
          return result;
        } catch (error) {
          translator.destroy?.(); this.browserTranslator = undefined;
          if (this.preference === 'browser') throw error;
        }
      } else if (this.preference === 'browser') {
        throw new Error('当前浏览器不支持内置翻译，请切换到“自动”或“本地模型”');
      }
    }

    if (this.disposed) throw new Error('翻译服务已关闭');
    return this.translateWithWorker(clean);
  }

  dispose(): void {
    this.disposed = true;
    this.browserTranslator?.destroy?.();
    this.worker?.terminate();
    this.pending.forEach(({ reject }) => reject(new Error('翻译服务已关闭')));
    this.pending.clear();
  }

  private async getBrowserTranslator(): Promise<BrowserTranslator | undefined> {
    if (this.browserChecked) return this.browserTranslator;
    this.browserChecked = true;
    this.listener({ label: '检测浏览器翻译能力', state: 'checking' });

    const factory = (globalThis as typeof globalThis & { Translator?: TranslatorFactory }).Translator;
    if (!factory) return undefined;

    try {
      const availability = await bounded(factory.availability({ sourceLanguage: 'en', targetLanguage: 'zh' }), 4000);
      if (availability === 'unavailable' || availability === 'no') return undefined;
      let abandoned = false;
      const created = factory.create({
        sourceLanguage: 'en',
        targetLanguage: 'zh',
        monitor: (monitor) => {
          monitor.addEventListener('downloadprogress', (event) => {
            const loaded = Number((event as Event & { loaded?: number }).loaded ?? 0);
            this.listener({
              label: '正在下载浏览器翻译模型',
              progress: Math.round(loaded * 100),
              state: 'downloading',
            });
          });
        },
      });
      void created.then(translator=>{if(abandoned||this.disposed)translator.destroy?.();},()=>{});
      this.browserTranslator = await bounded(created, 12000, ()=>{abandoned=true;});
      if (this.disposed) { this.browserTranslator = undefined; return undefined; }
      this.listener({ label: '浏览器翻译已就绪', state: 'ready' });
      return this.browserTranslator;
    } catch {
      return undefined;
    }
  }

  private translateWithWorker(text: string): Promise<string> {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/translation.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<WorkerReply>) => this.onWorkerMessage(event.data);
      this.worker.onerror = (event) => {
        this.listener({ label: '本地翻译模型加载失败', state: 'error' });
        this.pending.forEach(({ reject }) => reject(new Error(event.message)));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = undefined;
      };
    }

    const requestId = crypto.randomUUID();
    this.listener({ label: '准备本地英译中模型', state: 'checking' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.worker?.terminate();
        this.worker = undefined;
        this.pending.delete(requestId);
        this.listener({ label: '翻译超时，原文已保留，可重试', state: 'error' });
        reject(new Error('翻译超时，原文已保留，可重试'));
      }, 180_000);
      this.pending.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (reason) => { clearTimeout(timer); reject(reason); },
      });
      this.worker?.postMessage({ type: 'translate', requestId, text });
    });
  }

  private onWorkerMessage(message: WorkerReply): void {
    if (message.type === 'progress') {
      this.listener({
        label: message.label ?? '下载本地翻译模型',
        progress: message.progress,
        state: 'downloading',
      });
      return;
    }
    if (!message.requestId) return;
    const task = this.pending.get(message.requestId);
    if (!task) return;
    this.pending.delete(message.requestId);
    if (message.type === 'result') {
      this.listener({ label: '本地翻译已就绪', state: 'ready' });
      task.resolve(message.text ?? '');
    } else {
      this.listener({ label: message.message ?? '翻译失败', state: 'error' });
      task.reject(new Error(message.message ?? '翻译失败'));
    }
  }
}
