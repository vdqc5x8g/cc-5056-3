// sRGB <-> linear-light conversion. All optical math is done in linear RGB.
// 8-bit PNG data is assumed to be sRGB-encoded.

export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v) {
  const x = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_LUT[i] = srgbToLinear(i / 255);

export function srgbByteToLinear(byte) {
  return SRGB_LUT[byte & 255];
}

export function linearToSrgbByte(v) {
  return Math.round(linearToSrgb(v) * 255);
}

// Encode a linear RGB triple to 8-bit sRGB bytes (display / PNG).
export function encodePixel(r, g, b, out, offset) {
  out[offset] = linearToSrgbByte(r);
  out[offset + 1] = linearToSrgbByte(g);
  out[offset + 2] = linearToSrgbByte(b);
  out[offset + 3] = 255;
}

export function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
