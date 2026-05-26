// QR code generation for room join links. The speaker page shows a QR encoding
// the listener URL for its room; an audience member scans it to join.

import QRCode from 'qrcode';

// Returns a PNG Buffer of a QR code for the given text (a URL).
export function qrPng(text) {
  return QRCode.toBuffer(text, { type: 'png', width: 300, margin: 1 });
}
