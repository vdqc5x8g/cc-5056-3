// Recomposition from estimated components onto a NEW background.
//
//   predicted(x) = T(x) * Bnew(x + d(x)) + A(x)
//
// Every output pixel is computed from the estimated T/A fields and the new
// background; no source image is ever copied in. Undetermined pixels are
// reported as errors rather than silently made transparent.

import { STATUS } from './solver.js';
import { LinearImage } from './image.js';

export function composite(model, newBg, opts = {}) {
  const { width, height } = model;
  const out = new LinearImage(width, height);
  const residualMask = new Uint8Array(width * height);
  const useOffset = opts.useOffset ?? model.includeOffset;
  const unresolved = [];
  const bg = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const st = model.status[i];
      if (st === STATUS.OUTSIDE) {
        // Outside the selected transmission region: show the new background
        // unchanged (the product is not present there).
        newBg.sampleBilinear(x, y, 0, 0, bg);
        out.setPixel(x, y, bg[0], bg[1], bg[2]);
        continue;
      }
      if (st === STATUS.UNDETERMINED || st === STATUS.NO_SOLUTION) {
        residualMask[i] = 1;
        unresolved.push(i);
        out.setPixel(x, y, Number.NaN, Number.NaN, Number.NaN);
        continue;
      }
      const dx = useOffset ? model.offset[i * 2] : 0;
      const dy = useOffset ? model.offset[i * 2 + 1] : 0;
      newBg.sampleBilinear(x, y, dx, dy, bg);
      const r = model.T[i * 3] * bg[0] + model.A[i * 3];
      const g = model.T[i * 3 + 1] * bg[1] + model.A[i * 3 + 1];
      const b = model.T[i * 3 + 2] * bg[2] + model.A[i * 3 + 2];
      out.setPixel(x, y, r, g, b);
    }
  }
  return { image: out, unresolved, unresolvedMask: residualMask };
}

// Re-render the fitted observations (for residual diagnostics). This is
// reconstruction from the model, not a copy of the source.
export function reconstruct(model, observations, sampleBgForObs, width, height) {
  const nObs = observations.length;
  const recon = observations.map(() => new LinearImage(width, height));
  const mask = new Uint8Array(width * height);
  const bg = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (model.status[i] === STATUS.OUTSIDE) {
        for (let k = 0; k < nObs; k++) {
          observations[k].getPixel(x, y, bg);
          recon[k].setPixel(x, y, bg[0], bg[1], bg[2]);
        }
        continue;
      }
      if (model.status[i] === STATUS.UNDETERMINED) {
        mask[i] = 1;
        for (let k = 0; k < nObs; k++) recon[k].setPixel(x, y, Number.NaN, Number.NaN, Number.NaN);
        continue;
      }
      for (let k = 0; k < nObs; k++) {
        sampleBgForObs(k, x, y, bg);
        const T = model.T;
        const A = model.A;
        recon[k].setPixel(
          x,
          y,
          T[i * 3] * bg[0] + A[i * 3],
          T[i * 3 + 1] * bg[1] + A[i * 3 + 1],
          T[i * 3 + 2] * bg[2] + A[i * 3 + 2]
        );
      }
    }
  }
  return { recon, undeterminedMask: mask };
}

// Component visualisations. Each returns an image in linear space:
//   transmission  -> T tint on mid-grey, so 1.0 reads as neutral grey
//   reflection    -> A as emitted colour on black
//   backgroundTerm-> T * Bnew on black (the background contribution)
export function componentImages(model, newBg, opts = {}) {
  const { width, height } = model;
  const tint = new LinearImage(width, height);
  const reflection = new LinearImage(width, height);
  const backgroundTerm = new LinearImage(width, height);
  const useOffset = opts.useOffset ?? model.includeOffset;
  const bg = [0, 0, 0];
  for (let i = 0, n = width * height; i < n; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    const st = model.status[i];
    if (st === STATUS.OUTSIDE) {
      for (let c = 0; c < 3; c++) {
        tint.data[i * 3 + c] = 0.18;
        reflection.data[i * 3 + c] = 0;
        backgroundTerm.data[i * 3 + c] = 0;
      }
      continue;
    }
    if (st === STATUS.UNDETERMINED || st === STATUS.NO_SOLUTION) {
      for (let c = 0; c < 3; c++) {
        // Magenta sentinel = "model does not know here".
        tint.data[i * 3 + c] = c === 1 ? 0 : 0.35;
        reflection.data[i * 3 + c] = 0;
        backgroundTerm.data[i * 3 + c] = 0;
      }
      continue;
    }
    const dx = useOffset ? model.offset[i * 2] : 0;
    const dy = useOffset ? model.offset[i * 2 + 1] : 0;
    newBg.sampleBilinear(x, y, dx, dy, bg);
    for (let c = 0; c < 3; c++) {
      const T = model.T[i * 3 + c];
      tint.data[i * 3 + c] = 0.18 * T + 0.5 * (1 - T); // T=1 -> 0.18, T=0 -> 0.5
      reflection.data[i * 3 + c] = model.A[i * 3 + c];
      backgroundTerm.data[i * 3 + c] = T * bg[c];
    }
  }
  return { tint, reflection, backgroundTerm };
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
