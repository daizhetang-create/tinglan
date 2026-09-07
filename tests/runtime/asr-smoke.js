const cases = {
  zh: { file: './fixtures/mandarin-classroom.wav', language: 'zh-CN' },
  en: { file: './fixtures/english-classroom.wav', language: 'en-US' },
};

const selected = new URLSearchParams(location.search).get('case') || 'zh';
const fixture = cases[selected];
const progress = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

function resampleLinear(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

async function decodeFixture(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const source = decoded.getChannelData(channel);
      for (let index = 0; index < source.length; index += 1) mono[index] += source[index] / decoded.numberOfChannels;
    }
    return resampleLinear(mono, decoded.sampleRate, 16_000);
  } finally {
    await context.close();
  }
}

async function run() {
  if (!fixture) throw new Error(`Unknown smoke case: ${selected}`);
  progress.textContent = `Decoding ${fixture.file}`;
  const audio = await decodeFixture(fixture.file);
  const worker = new Worker(new URL('../../src/workers/transcription.worker.ts', import.meta.url), { type: 'module' });
  let timeout;
  try {
    const output = await new Promise((resolve, reject) => {
      timeout = window.setTimeout(() => reject(new Error('ASR exceeded 15 minutes')), 15 * 60 * 1000);
      worker.onerror = (event) => reject(new Error(event.message || 'Worker crashed'));
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === 'progress' || message.type === 'working') {
          progress.textContent = `${message.label || message.type}${typeof message.progress === 'number' ? ` · ${message.progress}%` : ''}`;
          return;
        }
        if (message.type === 'error') reject(new Error(message.message || 'ASR failed'));
        if (message.type === 'result') resolve(message.result);
      };
      worker.postMessage({ type: 'transcribe', audio, model: 'tiny', sourceLanguage: fixture.language }, [audio.buffer]);
    });
    const chunks = (output.chunks || []).filter((chunk) => chunk.text?.trim());
    const text = String(output.text || chunks.map((chunk) => chunk.text).join(' ')).trim();
    if (!text) throw new Error('ASR returned no recognizable text');
    if (!chunks.length || chunks.some((chunk) => !Array.isArray(chunk.timestamp) || !Number.isFinite(chunk.timestamp[0]))) {
      throw new Error('ASR returned a chunk without a valid timestamp');
    }
    const evidence = { status: 'pass', case: selected, language: fixture.language, text, chunks };
    progress.textContent = 'PASS';
    resultNode.dataset.status = 'pass';
    resultNode.textContent = JSON.stringify(evidence, null, 2);
    document.title = `PASS · Tinglan ASR ${selected}`;
  } finally {
    window.clearTimeout(timeout);
    worker.terminate();
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  progress.textContent = 'FAIL';
  resultNode.dataset.status = 'fail';
  resultNode.textContent = message;
  document.title = `FAIL · Tinglan ASR ${selected}`;
});
