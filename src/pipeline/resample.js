// Linear-interpolation resampler for PCM16 LE audio (Node Buffers).
// Used only by the OpenAI engine: speaker audio is 16 kHz, but
// gpt-realtime-translate speaks/listens at 24 kHz. We keep the rest of the
// system at 16 kHz, so we resample on the way in (16→24) and out (24→16).
// Linear interpolation is plenty for speech at these rates.

// Read a Node Buffer of PCM16 LE into a Float32Array in [-1, 1].
function bufToFloat(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    out[i] = s / (s < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

// Float32 [-1, 1] -> Node Buffer of PCM16 LE.
function floatToBuf(float) {
  const buf = Buffer.allocUnsafe(float.length * 2);
  for (let i = 0; i < float.length; i++) {
    let s = Math.max(-1, Math.min(1, float[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return buf;
}

// Resample a PCM16 LE Buffer from inRate to outRate. Returns a PCM16 LE Buffer.
export function resamplePcm16(buf, inRate, outRate) {
  if (inRate === outRate || buf.length < 2) return buf;
  const input = bufToFloat(buf);
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] || 0;
    const b = input[idx + 1] !== undefined ? input[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return floatToBuf(out);
}
