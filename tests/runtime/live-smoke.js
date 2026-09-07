import { LiveTranscriber } from '../../src/features/recorder/liveTranscriber.ts';
import { TranslationService } from '../../src/lib/translation.ts';

const progress = document.querySelector('#progress');
const resultNode = document.querySelector('#result');
const button = document.querySelector('#start');
const language = new URLSearchParams(location.search).get('case') === 'zh' ? 'zh-CN' : 'en-US';
const evidence = { kind: `real-time synthetic ${language} speech, not human microphone`, segments: [], translations: [], errors: [] };
const show = () => { resultNode.textContent = JSON.stringify(evidence, null, 2); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

button.onclick = async () => {
  button.disabled = true;
  resultNode.dataset.status = 'running';
  const context = new AudioContext();
  await context.resume();
  let live;
  let translator;
  let recorder;
  try {
    const response = await fetch(language === 'zh-CN' ? './fixtures/mandarin-classroom.wav' : './fixtures/english-classroom.wav');
    if (!response.ok) throw new Error('Fixture unavailable');
    const speech = await context.decodeAudioData(await response.arrayBuffer());
    // Preflight is disclosed explicitly: first-use model downloads are not real-time.
    progress.textContent = 'Preflight: download and verify models before timed stream';
    evidence.stage = 'preflight ASR'; show();
    const warmup = new Worker(new URL('../../src/workers/transcription.worker.ts', import.meta.url), { type: 'module' });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Preflight ASR timeout')), 12 * 60_000);
        warmup.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
        warmup.onmessage = ({ data }) => {
          if (data.type === 'result') { clearTimeout(timeout); resolve(data.result); }
          else if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); }
          else progress.textContent = `Preflight ASR: ${data.label ?? data.type} ${data.progress ?? ''}`;
        };
        const offline = new OfflineAudioContext(1, Math.ceil(speech.duration * 16000), 16000);
        const input = offline.createBufferSource(); input.buffer = speech; input.connect(offline.destination); input.start();
        offline.startRendering().then((buffer) => warmup.postMessage({ type: 'transcribe', model: 'tiny', sourceLanguage: language, audio: buffer.getChannelData(0) }));
      });
    } finally { warmup.terminate(); }
    if (language === 'en-US') {
      evidence.stage = 'preflight translation'; show();
      translator = new TranslationService('local', (state) => { progress.textContent = `Translation: ${state.label}`; });
      evidence.preflightTranslation = await translator.translate('Please submit the assignment by next Friday.');
      if (!/[\u3400-\u9fff]/.test(evidence.preflightTranslation)) throw new Error('Translation preflight returned no Chinese');
    }

    evidence.stage = 'timed live stream'; show();
    const destination = context.createMediaStreamDestination();
    const source = context.createBufferSource();
    const duration = 52;
    const repeated = context.createBuffer(1, Math.ceil(duration * context.sampleRate), context.sampleRate);
    const samples = repeated.getChannelData(0);
    // Repeat the actual audio at its original pace with 800 ms gaps.
    for (let second = 0; second < duration; second += speech.duration + 0.8) {
      for (let i = 0; i < speech.length && second * context.sampleRate + i < samples.length; i += 1) samples[Math.floor(second * context.sampleRate) + i] = speech.getChannelData(0)[i];
    }
    source.buffer = repeated;
    source.connect(destination);
    const recorded = [];
    recorder = new MediaRecorder(destination.stream);
    recorder.ondataavailable = ({ data }) => recorded.push(data);
    let began = 0;
    let ended = false;
    const translationJobs = [];
    live = new LiveTranscriber({ sourceLanguage: language, model: 'tiny',
      onProgress: (state) => { progress.textContent = state.label; },
      onError: (message) => { evidence.errors.push(message); show(); },
      onSegments: (segments) => {
        evidence.segments.push(...segments);
        if (evidence.firstTranscriptSeconds === undefined) {
          evidence.firstTranscriptSeconds = (performance.now() - began) / 1000;
          evidence.transcriptBeforeEnd = !ended;
        }
        const job = translator?.translate(segments.map((segment) => segment.source).join(' ')).then((text) => {
          evidence.translations.push(text);
          if (evidence.firstTranslationSeconds === undefined) {
            evidence.firstTranslationSeconds = (performance.now() - began) / 1000;
            evidence.translationBeforeEnd = !ended;
          }
          show();
        });
        if (job) translationJobs.push(job);
        show();
      },
    });
    await live.start(destination.stream);
    began = performance.now();
    recorder.start();
    const sourceEnded = new Promise((resolve) => { source.onended = resolve; });
    source.start();
    const pauseCheck = (async () => {
      await wait(16000);
      live.pause(); recorder.pause(); await context.suspend();
      await wait(2000);
      live.resume(); recorder.resume(); await context.resume();
      evidence.pauseResumePerformed = true;
    })();
    await sourceEnded;
    ended = true;
    evidence.wallStreamSeconds = (performance.now() - began) / 1000;
    await pauseCheck;
    const recorderStopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.stop();
    await live.stop();
    evidence.captureStats = live.stats;
    await recorderStopped;
    await Promise.all(translationJobs);
    evidence.savedRecordingBytes = new Blob(recorded).size;
    evidence.lastEndMs = evidence.segments.at(-1)?.endMs;
    if (!evidence.segments.length || !evidence.transcriptBeforeEnd) throw new Error('No actual transcription before stream ended');
    if (language === 'en-US' && (!evidence.translationBeforeEnd || !evidence.translations.every((text) => /[\u3400-\u9fff]/.test(text)))) throw new Error('No Chinese translation before stream ended');
    if (evidence.captureStats.peakQueuedChunks > 3 || evidence.captureStats.queuedChunks !== 0 || evidence.captureStats.skippedChunks !== 0) throw new Error('Queue bound/draining failed');
    if (evidence.lastEndMs > 53500) throw new Error('Transcript clock included pause or overflowed capture duration');
    if (!evidence.savedRecordingBytes) throw new Error('Independent audio recording is empty');
    if (evidence.errors.length) throw new Error('Live errors occurred');
    evidence.status = 'pass';
    progress.textContent = `PASS — ${language} timed audio → live transcript${language === 'en-US' ? ' → Chinese translation' : ''}, pause/resume, bounded queue, recording retained`;
    resultNode.dataset.status = 'pass'; document.title = 'PASS · Tinglan live audio';
  } catch (error) {
    evidence.status = 'fail'; evidence.failure = error instanceof Error ? error.message : String(error);
    progress.textContent = `FAIL: ${evidence.failure}`; resultNode.dataset.status = 'fail'; document.title = 'FAIL · Tinglan live audio';
  } finally {
    live?.dispose(); translator?.dispose();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    await context.close();
    show();
  }
};
