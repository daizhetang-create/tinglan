// Only PCM transport runs on the audio thread. Inference stays in its Worker.
class TinglanPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.active = true;
    this.readySent = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'pause') this.active = false;
      if (data.type === 'resume') this.active = true;
      if (data.type === 'flush') {
        if (this.offset) this.port.postMessage({ type: 'pcm', samples: this.buffer.slice(0, this.offset) });
        this.offset = 0;
        this.active = false;
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  process(inputs) {
    if (!this.readySent) { this.port.postMessage({ type: 'ready' }); this.readySent = true; }
    const channels = inputs[0];
    if (!this.active || !channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame += 1) {
      let value = 0;
      for (const channel of channels) value += channel[frame] / channels.length;
      this.buffer[this.offset++] = value;
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ type: 'pcm', samples: this.buffer }, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('tinglan-pcm-capture', TinglanPcmCapture);
