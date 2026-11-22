// Linear-light RGB image container. Interleaved layout: [r,g,b, r,g,b, ...]
// All values are linear-light, nominally in [0,1] but may exceed 1 after
// additive reflection/attenuation math (kept unclamped internally).

import { srgbByteToLinear, encodePixel } from './color.js';

export class LinearImage {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data || new Float64Array(width * height * 3);
  }

  static fromSrgbBytes(rgba, width, height) {
    const img = new LinearImage(width, height);
    const d = img.data;
    for (let i = 0, p = 0; i < width * height; i++, p += 4) {
      const o = i * 3;
      d[o] = srgbByteToLinear(rgba[p]);
      d[o + 1] = srgbByteToLinear(rgba[p + 1]);
      d[o + 2] = srgbByteToLinear(rgba[p + 2]);
    }
    return img;
  }

  static solid(width, height, r, g, b) {
    const img = new LinearImage(width, height);
    const d = img.data;
    for (let i = 0; i < width * height; i++) {
      d[i * 3] = r;
      d[i * 3 + 1] = g;
      d[i * 3 + 2] = b;
    }
    return img;
  }

  clone() {
    return new LinearImage(this.width, this.height, new Float64Array(this.data));
  }

  getPixel(x, y, out) {
    const o = (y * this.width + x) * 3;
    out[0] = this.data[o];
    out[1] = this.data[o + 1];
    out[2] = this.data[o + 2];
    return out;
  }

  setPixel(x, y, r, g, b) {
    const o = (y * this.width + x) * 3;
    this.data[o] = r;
    this.data[o + 1] = g;
    this.data[o + 2] = b;
  }

  // Bilinear sample with a signed displacement (dx,dy) in pixels. Coordinates
  // outside the image are clamped to the nearest edge (documented behaviour,
  // not a claim to know what lies outside the observed background).
  sampleBilinear(x, y, dx = 0, dy = 0, out = [0, 0, 0]) {
    const w = this.width;
    const h = this.height;
    let sx = x + dx;
    let sy = y + dy;
    if (sx < 0) sx = 0;
    else if (sx > w - 1) sx = w - 1;
    if (sy < 0) sy = 0;
    else if (sy > h - 1) sy = h - 1;
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const fx = sx - x0;
    const fy = sy - y0;
    const d = this.data;
    for (let c = 0; c < 3; c++) {
      const a = d[(y0 * w + x0) * 3 + c];
      const b = d[(y0 * w + x1) * 3 + c];
      const e = d[(y1 * w + x0) * 3 + c];
      const f = d[(y1 * w + x1) * 3 + c];
      const top = a + (b - a) * fx;
      const bot = e + (f - e) * fx;
      out[c] = top + (bot - top) * fy;
    }
    return out;
  }

  toSrgbBytes() {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    const d = this.data;
    for (let i = 0, n = this.width * this.height; i < n; i++) {
      const o = i * 3;
      encodePixel(d[o], d[o + 1], d[o + 2], out, i * 4);
    }
    return out;
  }
}
