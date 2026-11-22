// Synthetic transparent-object generator with known ground truth.
//
// Produces K observations of the SAME fixed object over known background
// plates, plus a held-out reference composite onto a new background. Ground
// truth T (transmission / chromatic attenuation), A (additive reflection) and
// optional d (background coordinate offset) are stored so estimates can be
// scored against them. The object silhouette is deliberately simple and is
// never pasted: observations are recomputed pixelwise from the fields.

import { LinearImage } from './image.js';
import { linearToSrgbByte } from './color.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Procedural background plates with strong local colour/spatial variation so
// the per-pixel system is well conditioned.
export function makeBackground(kind, width, height, seed = 1) {
  const img = new LinearImage(width, height);
  const rnd = mulberry32(seed);
  const d = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      let r, g, b;
      switch (kind) {
        case 'checker': {
          const c = ((x >> 4) + (y >> 4)) & 1;
          r = c ? 0.72 : 0.16;
          g = c ? 0.42 : 0.28;
          b = c ? 0.20 : 0.66;
          break;
        }
        case 'gradient': {
          r = 0.08 + 0.82 * u;
          g = 0.10 + 0.70 * (1 - v);
          b = 0.14 + 0.80 * (0.5 + 0.5 * Math.sin(6.283 * (u - v) * 0.5));
          break;
        }
        case 'stripes': {
          const s = Math.sin(2 * Math.PI * (u * 9 + 0.15 * Math.sin(v * 6)));
          const t = 0.5 + 0.5 * s;
          r = 0.10 + 0.75 * t;
          g = 0.55 - 0.35 * t;
          b = 0.20 + 0.55 * (1 - t);
          break;
        }
        case 'dots': {
          const cx = (x % 40) - 20;
          const cy = (y % 40) - 20;
          const r2 = cx * cx + cy * cy;
          const t = r2 < 120 ? 1 : 0;
          r = 0.18 + 0.60 * t;
          g = 0.30 + 0.45 * (1 - t);
          b = 0.72 - 0.55 * t;
          break;
        }
        case 'spectrum': {
          r = 0.5 + 0.45 * Math.sin(2 * Math.PI * (u + 0.0));
          g = 0.5 + 0.45 * Math.sin(2 * Math.PI * (u + 0.33));
          b = 0.5 + 0.45 * Math.sin(2 * Math.PI * (u + 0.66));
          break;
        }
        default:
          r = g = b = 0.5;
      }
      const grain = (rnd() - 0.5) * 0.02;
      d[(y * width + x) * 3] = Math.max(0, r + grain);
      d[(y * width + x) * 3 + 1] = Math.max(0, g + grain);
      d[(y * width + x) * 3 + 2] = Math.max(0, b + grain);
    }
  }
  return img;
}

// A simple bottle / rounded-rectangle silhouette. Returns mask + fields.
export function makeGlassFields(width, height, mask, opts = {}) {
  const chromatic = opts.chromatic ?? [0.82, 0.86, 0.9]; // slightly green-tinted glass
  const reflectionLevel = opts.reflectionLevel ?? 0.16;
  const refraction = opts.refraction ?? 0; // pixels of barrel-like offset at edges
  // Optional whole-object displacement in pixels, simulating the object being
  // nudged between shots. Applied as a lookup shift so the silhouette (and all
  // fields) move together while the mask stays where it was drawn.
  const objShift = opts.objectShift ?? { dx: 0, dy: 0 };
  const n = width * height;
  const T = new Float64Array(n * 3);
  const A = new Float64Array(n * 3);
  const offset = new Float64Array(n * 2);
  let count = 0;
  const srcMask = mask;
  const sampleSrc = (x, y) => {
    const sx = x - objShift.dx;
    const sy = y - objShift.dy;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) return 0;
    return srcMask[sy * width + sx];
  };
  const maskAt = new Uint8Array(n);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) maskAt[y * width + x] = sampleSrc(x, y);
  const { cx, cy } = maskBounds(maskAt, width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!maskAt[i]) {
        T[i * 3] = T[i * 3 + 1] = T[i * 3 + 2] = 1;
        continue;
      }
      count++;
      // Transmission: gentle thickness variation toward the silhouette edge.
      const edge = edgeDistance(maskAt, width, height, x, y);
      const thick = Math.min(1, edge / 14); // 0 at edge -> 1 inside
      const base = 0.72 + 0.24 * thick;
      T[i * 3] = base * chromatic[0];
      T[i * 3 + 1] = base * chromatic[1];
      T[i * 3 + 2] = base * chromatic[2];
      // Additive reflection: a vertical sheen plus an edge rim.
      const v = y / (height - 1);
      const sheen = reflectionLevel * (0.35 + 0.65 * Math.exp(-((v - 0.28) ** 2) / 0.02));
      const rim = reflectionLevel * 1.4 * Math.exp(-edge / 4);
      A[i * 3] = sheen + rim * 0.9;
      A[i * 3 + 1] = sheen + rim;
      A[i * 3 + 2] = sheen + rim * 1.15;
      // Refraction proxy: radial offset pulling the background inward.
      if (refraction !== 0) {
        const ddx = cx - x;
        const ddy = cy - y;
        const rr = Math.hypot(ddx, ddy) + 1e-6;
        offset[i * 2] = (refraction * edge * ddx) / rr / 20;
        offset[i * 2 + 1] = (refraction * edge * ddy) / rr / 20;
      }
    }
  }
  return { T, A, offset, count, maskAt, chromatic, reflectionLevel, refraction };
}

function maskBounds(mask, width) {
  // cheap centroid cache per call; small images so fine
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { sx += i % width; sy += (i / width) | 0; n++; }
  return { cx: sx / Math.max(1, n), cy: sy / Math.max(1, n) };
}

function edgeDistance(mask, width, height, x, y) {
  // distance to nearest non-mask pixel via small flood (bounded).
  for (let r = 1; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return r;
        if (!mask[ny * width + nx]) return r;
      }
    }
  }
  return 40;
}

export function roundedRectMask(width, height, x0, y0, x1, y1, radius) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
      if (inside) {
        const cx = x < x0 + radius ? x0 + radius : x > x1 - radius ? x1 - radius : x;
        const cy = y < y0 + radius ? y0 + radius : y > y1 - radius ? y1 - radius : y;
        if (cx !== x || cy !== y) {
          inside = Math.hypot(x - cx, y - cy) <= radius;
        }
      }
      mask[y * width + x] = inside ? 1 : 0;
    }
  }
  return mask;
}

function asImage(bg) {
  return bg && bg.sampleBilinear ? bg : bg.image;
}

// Render one observation: O = T * B(x + s + d) + A + noise.
// `objectShift` moves only the object's fields (not the mask), so the same
// selection can be used to detect that the object moved between shots.
export function renderObservation(fields, background, mask, width, height, opts = {}) {
  const out = new LinearImage(width, height);
  background = asImage(background);
  const s = opts.shift ?? { dx: 0, dy: 0 };
  const os = opts.objectShift ?? { dx: 0, dy: 0 };
  const gain = opts.gain ?? 1;
  const noise = opts.noise ?? 0;
  const useOffset = opts.useOffset ?? false;
  const rnd = mulberry32(opts.seed ?? 7);
  const bg = [0, 0, 0];
  const objAt = (x, y) => {
    const sx = x - os.dx;
    const sy = y - os.dy;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
    const si = sy * width + sx;
    return mask[si] ? si : null;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const src = objAt(x, y);
      if (src == null) {
        background.sampleBilinear(x, y, s.dx, s.dy, bg);
        out.setPixel(x, y, bg[0] * gain, bg[1] * gain, bg[2] * gain);
        continue;
      }
      const dx = s.dx + (useOffset ? fields.offset[src * 2] : 0);
      const dy = s.dy + (useOffset ? fields.offset[src * 2 + 1] : 0);
      background.sampleBilinear(x, y, dx, dy, bg);
      for (let c = 0; c < 3; c++) {
        const v =
          fields.T[src * 3 + c] * bg[c] + fields.A[src * 3 + c] +
          (noise ? (rnd() - 0.5) * noise : 0);
        out.data[i * 3 + c] = v * gain;
      }
    }
  }
  return out;
}

// Reference composite onto a new background using the true fields.
export function renderReference(fields, newBg, mask, width, height, useOffset = false) {
  const out = new LinearImage(width, height);
  newBg = asImage(newBg);
  const bg = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) {
        newBg.sampleBilinear(x, y, 0, 0, bg);
        out.setPixel(x, y, bg[0], bg[1], bg[2]);
        continue;
      }
      const dx = useOffset ? fields.offset[i * 2] : 0;
      const dy = useOffset ? fields.offset[i * 2 + 1] : 0;
      newBg.sampleBilinear(x, y, dx, dy, bg);
      out.setPixel(
        x,
        y,
        fields.T[i * 3] * bg[0] + fields.A[i * 3],
        fields.T[i * 3 + 1] * bg[1] + fields.A[i * 3 + 1],
        fields.T[i * 3 + 2] * bg[2] + fields.A[i * 3 + 2]
      );
    }
  }
  return out;
}

// Score an estimated model against ground truth over the mask.
export function scoreAgainstTruth(model, truth, mask, width, height) {
  let n = 0;
  let sumT = 0, sumA = 0, maxT = 0, maxA = 0;
  let sumT2 = 0, sumA2 = 0;
  let resolvedButWrong = 0;
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    const st = model.status[i];
    if (st !== 1 && st !== 2) continue; // only resolved pixels are scored
    n++;
    for (let c = 0; c < 3; c++) {
      const dt = model.T[i * 3 + c] - truth.T[i * 3 + c];
      const da = model.A[i * 3 + c] - truth.A[i * 3 + c];
      sumT += dt; sumA += da;
      sumT2 += dt * dt; sumA2 += da * da;
      maxT = Math.max(maxT, Math.abs(dt));
      maxA = Math.max(maxA, Math.abs(da));
      if (Math.abs(dt) > 0.15) resolvedButWrong++;
    }
  }
  const denom = Math.max(1, n * 3);
  return {
    scoredPixels: n,
    T_bias: sumT / denom,
    A_bias: sumA / denom,
    T_rmse: Math.sqrt(sumT2 / denom),
    A_rmse: Math.sqrt(sumA2 / denom),
    T_maxAbs: maxT,
    A_maxAbs: maxA,
    largeTransmissionErrors: resolvedButWrong,
  };
}

// FNV-1a over the linear bytes for a stable content checksum (documents use it
// to prove the reference is not a crop of any observation/plate).
export function checksum(img) {
  let h = 0x811c9dc5;
  const d = img.data;
  for (let i = 0; i < d.length; i++) {
    const v = linearToSrgbByte(d[i]);
    h ^= v & 255;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
