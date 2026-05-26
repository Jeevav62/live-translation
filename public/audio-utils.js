// Shared PCM conversion / resampling helpers used by speaker and listener pages.

export const TARGET_RATE = 16000;

// Float32 [-1,1] -> Int16 little-endian PCM (pcm_s16le).
export function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Int16 PCM -> Float32 [-1,1].
export function int16ToFloat(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    out[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

// Linear-interpolation downsample. Used only if the AudioContext could not be
// created at TARGET_RATE and is running at a higher rate.
export function downsample(float32, inRate, outRate) {
  if (outRate >= inRate) return float32;
  const ratio = inRate / outRate;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = float32[idx] || 0;
    const b = float32[idx + 1] || a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
