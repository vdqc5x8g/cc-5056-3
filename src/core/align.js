// Observation pre-checks and the optional background-coordinate offset (s_k).
//
import { pooledScore } from './solver.js';

// Two distinct things are checked:
//   1. PER-OBSERVATION consistency: each glass-over-background frame must be
//      captured at the same object position and exposure. We estimate a small
//      translation and a scalar exposure gain between frames using only the
//      *transmission region*, and report both. The UI refuses to produce a
//      "confident" estimate when these are out of tolerance, because motion or
//      exposure drift aliases into per-pixel colour.
//   2. BACKGROUND registration: each known plate is aligned to a reference
//      frame so that B_k(x) refers to the same scene point.

export function lumaPlane(img) {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    out[i] = 0.2126 * d[i * 3] + 0.7152 * d[i * 3 + 1] + 0.0722 * d[i * 3 + 2];
  }
  return out;
}

function samplePlane(plane, width, height, x, y) {
  let sx = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
  let sy = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const a = plane[y0 * width + x0];
  const b = plane[y0 * width + x1];
  const c = plane[y1 * width + x0];
  const e = plane[y1 * width + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
}

// Masked normalised cross-correlation between two luma planes over a shift
// search, restricted to pixels where mask is set (eroded implicitly by
// sampling). Returns best integer shift and the NCC at that shift.
export function maskedNccShift(a, b, width, height, mask, radius) {
  const pa = lumaPlane(a);
  const pb = lumaPlane(b);
  const pts = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) pts.push(x, y);
    }
  }
  if (pts.length < 8) return { dx: 0, dy: 0, ncc: NaN, samples: pts.length / 2 };

  let best = { dx: 0, dy: 0, ncc: -Infinity };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      let n = 0;
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let p = 0; p < pts.length; p += 2) {
        const x = pts[p] + dx;
        const y = pts[p + 1] + dy;
        if (x < 0 || y < 0 || x > width - 1 || y > height - 1) continue;
        const va = pa[pts[p + 1] * width + pts[p]];
        const vb = samplePlane(pb, width, height, x, y);
        n++;
        sa += va;
        sb += vb;
        saa += va * va;
        sbb += vb * vb;
        sab += va * vb;
      }
      if (n < 8) continue;
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      if (va <= 1e-12 || vb <= 1e-12) continue;
      const ncc = (sab / n - ma * mb) / Math.sqrt(va * vb);
      if (ncc > best.ncc) best = { dx, dy, ncc };
    }
  }
  return { ...best, samples: pts.length / 2 };
}

// Estimate a scalar exposure ratio and residual between a moving frame and a
// reference, over the mask, using log-luminance. Returns gain (ref/moving) and
// the fraction of masked pixels whose ratio deviates strongly, which is the
// signal that the *scene* changed for reasons other than exposure.
export function exposureAndDrift(ref, moving, width, height, mask, shift = { dx: 0, dy: 0 }) {
  const pr = lumaPlane(ref);
  const pm = lumaPlane(moving);
  let n = 0;
  let sLog = 0;
  const ratios = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const a = pr[y * width + x];
      // maskedNccShift established obs(u) ~= plate(u + shift). So plate(x)
      // matches the moving frame at x - shift.
      const b = samplePlane(pm, width, height, x - shift.dx, y - shift.dy);
      if (a < 1e-3 || b < 1e-3) continue;
      const r = a / b;
      ratios.push(r);
      sLog += Math.log(r);
      n++;
    }
  }
  if (n === 0) return { gain: 1, inliers: 1, madLog: 0, samples: 0 };
  const mean = sLog / n;
  ratios.sort((a, b) => a - b);
  const med = ratios[Math.floor(n / 2)] || Math.exp(mean);
  let absdev = 0;
  let inliers = 0;
  for (const r of ratios) {
    const dev = Math.abs(Math.log(r / med));
    absdev += dev;
    if (dev < Math.log(1.25)) inliers++;
  }
  return {
    gain: med,
    meanGain: Math.exp(mean),
    inliers: inliers / n,
    madLog: absdev / n,
    samples: n,
  };
}

// For a single observation and its known plate, search a global shift of the
// background (refraction proxy) that best explains the observed glass region
// under the pooled T/A model. This is the explicit "does the model include
// background coordinate offset" switch.
export function searchGlobalOffset(obs, background, width, height, mask, radius) {
  const pixels = [];
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 4000)));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (mask[y * width + x]) pixels.push([x, y]);
    }
  }
  if (pixels.length < 16) return { dx: 0, dy: 0, score: NaN, samples: pixels.length };
  // Coarse-to-fine around zero. Score uses only this observation's plate.
  const obsA = [obs];
  const bgA = [background];
  const shifts = [{ dx: 0, dy: 0 }];
  let best = { dx: 0, dy: 0, score: Infinity };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const s = pooledScore(obsA, bgA, shifts, pixels, dx, dy, width, height, 1);
      if (s < best.score) best = { dx, dy, score: s };
    }
  }
  return { ...best, samples: pixels.length };
}
