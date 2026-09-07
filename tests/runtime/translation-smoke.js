const source = 'Please submit the assignment by next Friday. This topic will appear on the final exam.';
const progress = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

async function run() {
  const worker = new Worker(new URL('../../src/workers/translation.worker.ts', import.meta.url), { type: 'module' });
  let timeout;
  try {
    const text = await new Promise((resolve, reject) => {
      timeout = window.setTimeout(() => reject(new Error('Translation exceeded 15 minutes')), 15 * 60 * 1000);
      const requestId = crypto.randomUUID();
      worker.onerror = (event) => reject(new Error(event.message || 'Worker crashed'));
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === 'progress') {
          progress.textContent = `${message.label || message.type}${typeof message.progress === 'number' ? ` · ${message.progress}%` : ''}`;
          return;
        }
        if (message.requestId !== requestId) return;
        if (message.type === 'error') reject(new Error(message.message || 'Translation failed'));
        if (message.type === 'result') resolve(String(message.text || '').trim());
      };
      worker.postMessage({ type: 'translate', requestId, text: source });
    });
    if (!text || !/[\u3400-\u9fff]/u.test(text)) throw new Error(`Expected non-empty Chinese text, received: ${text || '(empty)'}`);
    progress.textContent = 'PASS';
    resultNode.dataset.status = 'pass';
    resultNode.textContent = JSON.stringify({ status: 'pass', source, translation: text }, null, 2);
    document.title = 'PASS · Tinglan translation';
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
  document.title = 'FAIL · Tinglan translation';
});
