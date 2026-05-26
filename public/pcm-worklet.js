// AudioWorkletProcessor: accumulates mono Float32 mic samples and posts them
// to the main thread in fixed-size frames. Runs at the AudioContext sample rate.

const FRAME_SAMPLES = 1600; // ~100ms at 16kHz

class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(FRAME_SAMPLES);
    this._len = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0]; // mono
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buf[this._len++] = channel[i];
      if (this._len === FRAME_SAMPLES) {
        // Transfer a copy; reset buffer.
        const frame = this._buf.slice(0);
        this.port.postMessage(frame, [frame.buffer]);
        this._buf = new Float32Array(FRAME_SAMPLES);
        this._len = 0;
      }
    }
    return true; // keep processor alive; no audio output (silent)
  }
}

registerProcessor('pcm-capture', PCMCapture);
