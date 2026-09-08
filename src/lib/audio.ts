export function chooseRecordingMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

export async function decodeAudioTo16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(bytes);
    const mono = mixToMono(decoded);
    return resampleLinear(mono, decoded.sampleRate, 16_000);
  } finally {
    await context.close();
  }
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = buffer.getChannelData(channel);
    for (let index = 0; index < source.length; index += 1) {
      output[index] += source[index] / buffer.numberOfChannels;
    }
  }
  return output;
}

function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

export async function getAudioDuration(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  const audio = document.createElement('audio');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    audio.preload = 'metadata';
    audio.src = url;
    return await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => resolve(0), 10000);
      audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration * 1000 : 0);
      audio.onerror = () => reject(new Error('无法读取音频时长'));
    });
  } finally {
    clearTimeout(timer);
    audio.removeAttribute('src'); audio.load();
    URL.revokeObjectURL(url);
  }
}
