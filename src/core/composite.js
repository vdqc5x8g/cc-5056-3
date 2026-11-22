// Recomposition from estimated components onto a NEW background.
//
// This module is the compatibility surface. The authoritative component
// contract lives in `components.js`; a legacy per-pixel `model` is adapted at
// this boundary so every existing caller keeps working unchanged, while new
// callers can pass typed components directly.
//
// External behaviour is frozen:
//   * predicted(x) = T(x) * Bnew(x + d(x)) + A(x)
//   * outside the selection the new background passes through unchanged,
//   * degenerate pixels are NaN and listed in `unresolved` (never transparent),
//   * no source image is ever copied in.

import { LinearImage } from './image.js';
import {
  Region,
  asComponents,
  compositeComponents,
  componentImagesFromComponents,
  reconstructComponents,
} from './components.js';

// The new background must match the component grid; silently sampling a
// differently-sized plate would invent coordinates the model never declared.
function assertBackgroundSize(width, height, newBg) {
  if (newBg.width !== width || newBg.height !== height) {
    throw new Error(
      `background is ${newBg.width}x${newBg.height}, expected ${width}x${height}; refusing to assume a coordinate grid`
    );
  }
}

export function composite(modelOrComponents, newBg, opts = {}) {
  const components = asComponents(modelOrComponents);
  if (!newBg) throw new Error('composite: a new background image is required');
  assertBackgroundSize(components.width, components.height, newBg);
  return compositeComponents(components, newBg, opts);
}

// Component visualisations. Each returns an image in linear space:
//   transmission  -> T tint on mid-grey, so 1.0 reads as neutral grey
//   reflection    -> A as emitted colour on black
//   backgroundTerm-> T * Bnew on black (the background contribution)
export function componentImages(modelOrComponents, newBg, opts = {}) {
  const components = asComponents(modelOrComponents);
  if (!newBg) throw new Error('componentImages: a new background image is required');
  assertBackgroundSize(components.width, components.height, newBg);
  return componentImagesFromComponents(components, newBg, opts);
}

// Re-render the fitted observations (for residual diagnostics). This is
// reconstruction from the model, not a copy of the source.
export function reconstruct(modelOrComponents, observations, sampleBgForObs, width, height) {
  return reconstructComponents(asComponents(modelOrComponents), observations, sampleBgForObs, width, height);
}

// Residual between two linear images over a mask, per channel + luma.
export function residualStats(a, b, width, height, mask) {
  let n = 0;
  let sumSq = 0;
  let maxAbs = 0;
  let maxAt = -1;
  const perChannel = [0, 0, 0];
  for (let i = 0; i < width * height; i++) {
    if (mask && !mask[i]) continue;
    let bad = false;
    for (let c = 0; c < 3; c++) {
      const d = a.data[i * 3 + c] - b.data[i * 3 + c];
      if (!Number.isFinite(d)) { bad = true; break; }
      perChannel[c] += d * d;
    }
    if (bad) continue;
    const dr = a.data[i * 3] - b.data[i * 3];
    const dg = a.data[i * 3 + 1] - b.data[i * 3 + 1];
    const db = a.data[i * 3 + 2] - b.data[i * 3 + 2];
    const d2 = dr * dr + dg * dg + db * db;
    sumSq += d2 / 3;
    const m = Math.sqrt(d2);
    if (m > maxAbs) { maxAbs = m; maxAt = i; }
    n++;
  }
  return {
    pixels: n,
    rms: n ? Math.sqrt(sumSq / n) : NaN,
    maxAbs,
    maxAt,
    perChannelRms: perChannel.map((v) => (n ? Math.sqrt(v / n) : NaN)),
  };
}

// Render a reference composite directly from known (truth) fields and a chosen
// new background. Used only to produce ground truth for any selected
// background; the delivered product itself comes from estimated fields.
export function referenceFromFields(T, A, offset, mask, newBg, width, height, useOffset = true) {
  const out = new LinearImage(width, height);
  const bg = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) {
        newBg.sampleBilinear(x, y, 0, 0, bg);
        out.setPixel(x, y, bg[0], bg[1], bg[2]);
        continue;
      }
      const dx = useOffset ? offset[i * 2] : 0;
      const dy = useOffset ? offset[i * 2 + 1] : 0;
      newBg.sampleBilinear(x, y, dx, dy, bg);
      out.setPixel(
        x,
        y,
        T[i * 3] * bg[0] + A[i * 3],
        T[i * 3 + 1] * bg[1] + A[i * 3 + 1],
        T[i * 3 + 2] * bg[2] + A[i * 3 + 2]
      );
    }
  }
  return out;
}

export { Region };
