// End-to-end estimation pipeline shared by the UI and the CLI.
//
// Inputs: K observations (glass over known background k), K matching known
// background plates, and a transmission mask in observation coordinates.
//
// Steps, in the order the interface presents them:
//   1. Per-observation consistency: align each observation to its own known
//      plate on a background-only ring and estimate an exposure gain. Report
//      shifts, gains and inlier fractions. Failure here invalidates estimates
//      downstream, so it is surfaced before any T/A numbers.
//   2. Optional background-coordinate offset: per tile, search a shared
//      (dx,dy) that best explains the observations. Only used when the model
//      is explicitly declared to include refraction offset.
//   3. Per-pixel box-constrained solve for T (transmission) and A (additive
//      reflection); locally rank-deficient pixels are marked UNDETERMINED.

import { STATUS, solveImage, pooledScore, makeModel } from './solver.js';
import { maskedNccShift, exposureAndDrift } from './align.js';
import { Region, makeComponents } from './components.js';

function ringMask(width, height, mask, margin) {
  // Background-only ring: pixels near but outside the glass selection.
  const ring = new Uint8Array(width * height);
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      // Mark pixels in the dilated border excluding the mask itself.
      for (let dy = -margin; dy <= margin; dy++) {
        for (let dx = -margin; dx <= margin; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (!mask[j] && !ring[j]) {
            // only the outer band, not the whole neighbourhood
            if (Math.max(Math.abs(dx), Math.abs(dy)) >= Math.ceil(margin * 0.6)) {
              ring[j] = 1;
              count++;
            }
          }
        }
      }
    }
  }
  return { ring, count };
}

export function estimateScene({ observations, backgrounds, mask, width, height, options = {} }) {
  const K = observations.length;
  if (backgrounds.length !== K) throw new Error('observations/backgrounds length mismatch');
  const warnings = [];
  const checks = [];

  const margin = options.ringMargin ?? Math.max(6, Math.round(Math.min(width, height) * 0.04));
  const { ring, count: ringCount } = ringMask(width, height, mask, margin);
  if (ringCount < 32) {
    warnings.push({
      code: 'RING_TOO_SMALL',
      message:
        'The background-only ring is too small to verify registration and exposure. Shrink the transmission selection or use a margin.',
    });
  }

  // --- 1. per-observation registration + exposure -------------------------
  const shifts = [];
  const exposures = [];
  const alignRadius = options.alignRadius ?? 3;
  for (let k = 0; k < K; k++) {
    let align = { dx: 0, dy: 0, ncc: NaN, samples: 0 };
    if (ringCount >= 32) {
      align = maskedNccShift(observations[k].image, backgrounds[k].image, width, height, ring, alignRadius);
    }
    const exp = ringCount >= 32 ? exposureAndDrift(backgrounds[k].image, observations[k].image, width, height, ring, align) : { gain: 1, inliers: 1, samples: 0 };
    shifts.push({ dx: align.dx, dy: align.dy });
    exposures.push(exp);
    const ok = align.ncc > 0.9 && exp.inliers > 0.8 && Math.abs(exp.gain - 1) < 0.1;
    checks.push({
      k,
      shift: { dx: align.dx, dy: align.dy },
      ncc: align.ncc,
      gain: exp.gain,
      inliers: exp.inliers,
      samples: align.samples,
      ok,
    });
    if (!ok) {
      warnings.push({
        code: 'OBS_INCONSISTENT',
        message:
          `Observation ${k + 1}: registration/exposure check is outside tolerance ` +
          `(ncc=${fmt(align.ncc)}, gain=${fmt(exp.gain)}, inliers=${fmt(exp.inliers)}). ` +
          'Frame-to-frame motion or exposure drift is aliasing into object colour; results may be wrong.',
        observation: k,
      });
    }
  }

  // Cross-observation exposure/registration spread. A moving object is detected
  // separately below, by per-observation residuals of the solved model.
  if (K > 1) {
    const maxShift = Math.max(...checks.map((c) => Math.hypot(c.shift.dx, c.shift.dy)));
    const gains = checks.map((c) => c.gain);
    const meanGain = gains.reduce((a, b) => a + b, 0) / gains.length;
    const gainSpread = Math.max(...gains.map((g) => Math.abs(g / meanGain - 1)));
    checks.summary = { maxShift, meanGain, gainSpread };
    if (maxShift > (options.maxShift ?? 2) || gainSpread > (options.maxGainSpread ?? 0.08)) {
      warnings.push({
        code: 'OBS_VARIATION',
        message:
          `Observations disagree on plate registration (max |shift|=${fmt(maxShift)} px) or exposure ` +
          `(gain spread=${fmt(gainSpread)}). Background change must not be read as object colour ` +
          'until this is resolved.',
      });
    }
  }

  // Exposure normalisation. exposures[k].gain is median(plate / observation at
  // the registered position) over the background-only ring, i.e. ~1/exposure.
  // Multiplying the observation by it brings the observation back to the
  // plate's exposure. Each observation is normalised against its own plate, so
  // the per-pair model O_k = T*B_k + A stays exact; the operation removes
  // exposure but cannot create background spread.
  const normObs = observations.map((o, k) => {
    const g = exposures[k].gain;
    if (!Number.isFinite(g) || Math.abs(g - 1) < 1e-4) return o.image;
    const img = o.image.clone();
    for (let i = 0; i < img.data.length; i++) img.data[i] *= g;
    return img;
  });
  const normBg = backgrounds.map((b) => b.image);

  // --- 2. optional background coordinate offset (per tile) ----------------
  const includeOffset = !!options.includeOffset;
  const tileOffsets = [];
  if (includeOffset) {
    const tile = options.tileSize ?? 48;
    const radius = options.offsetRadius ?? 4;
    const stride = options.offsetStride ?? 2;
    // Only accept a non-zero tile shift if it explains clearly more residual
    // than the zero shift. This regularises the choice: noise alone must not
    // manufacture refraction that isn't there. A moved object also breaks the
    // residual check, so this cannot hide real misalignment.
    const minGain = options.offsetMinGain ?? 0.02;
    for (let ty = 0; ty < height; ty += tile) {
      for (let tx = 0; tx < width; tx += tile) {
        const pixels = [];
        for (let y = ty; y < Math.min(ty + tile, height); y += stride) {
          for (let x = tx; x < Math.min(tx + tile, width); x += stride) {
            if (mask[y * width + x]) pixels.push([x, y]);
          }
        }
        if (pixels.length < 12) continue;
        const zero = pooledScore(normObs, normBg, shifts, pixels, 0, 0, width, height, options.maxA ?? 1);
        let best = { dx: 0, dy: 0, score: zero };
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx === 0 && dy === 0) continue;
            const s = pooledScore(normObs, normBg, shifts, pixels, dx, dy, width, height, options.maxA ?? 1);
            if (s < best.score) best = { dx, dy, score: s };
          }
        }
        const gain = zero > 1e-12 ? 1 - best.score / zero : 0;
        const accept = gain >= minGain && Number.isFinite(gain);
        tileOffsets.push({
          tx, ty,
          dx: accept ? best.dx : 0,
          dy: accept ? best.dy : 0,
          gain,
          accepted: accept,
        });
      }
    }
    warnings.push({
      code: 'OFFSET_MODEL',
      message:
        'Background coordinate offset is enabled. This adds a per-tile translation only; it does not ' +
        'model true refraction (curvature, caustics) and cannot claim to recover arbitrary glass optics.',
    });
  }

  const sampleBgBase = (k, x, y, out) => {
    const s = shifts[k];
    let dx = s.dx;
    let dy = s.dy;
    if (includeOffset) {
      const tile = options.tileSize ?? 48;
      const ox = tileOffsets.find((t) => x >= t.tx && x < t.tx + tile && y >= t.ty && y < t.ty + tile);
      if (ox) { dx += ox.dx; dy += ox.dy; }
    }
    normBg[k].sampleBilinear(x, y, dx, dy, out);
  };

  // --- 3. solve T/A per pixel ---------------------------------------------
  const model = solveImage(
    normObs,
    (k, x, y, out) => sampleBgBase(k, x, y, out),
    mask,
    width,
    height,
    {
      includeOffset,
      noiseVar: options.noiseVar ?? 0,
      sigmaFloor: options.sigmaFloor ?? (1 / 255) ** 2,
      maxTstd: options.maxTstd ?? 0.3,
      maxA: options.maxA ?? 1,
    }
  );

  if (includeOffset) {
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      const y = (i / width) | 0;
      const t = tileOffsets.find((tt) => x >= tt.tx && x < tt.tx + tileSize(options) && y >= tt.ty && y < tt.ty + tileSize(options));
      if (t) { model.offset[i * 2] = t.dx; model.offset[i * 2 + 1] = t.dy; }
    }
  }

  // --- diagnostics ---------------------------------------------------------
  const counts = { OUTSIDE: 0, OK: 0, CLAMPED: 0, UNDETERMINED: 0, NO_SOLUTION: 0 };
  let spreadSum = 0;
  let spreadN = 0;
  let residualSum = 0;
  let residualN = 0;
  for (let i = 0; i < width * height; i++) {
    const st = model.status[i];
    for (const name of Object.keys(counts)) if (STATUS[name] === st) counts[name]++;
    if (st !== STATUS.OUTSIDE) {
      spreadSum += (model.spread[i * 3] + model.spread[i * 3 + 1] + model.spread[i * 3 + 2]) / 3;
      spreadN++;
      residualSum += model.residualRms[i];
      residualN++;
    }
  }
  const selected = counts.OK + counts.CLAMPED + counts.UNDETERMINED + counts.NO_SOLUTION;
  const resolved = counts.OK + counts.CLAMPED;

  // Per-observation residual: if one fixed object explains every shot, the RMS
  // of |O_k - (T*B_k + A)| over resolved pixels is similar for all k. A frame
  // where the object moved cannot be explained by the shared T/A fields and
  // shows a much larger residual. This directly tests "same fixed object",
  // rather than a silhouette statistic that legitimately varies with the
  // background we chose.
  const perObsRms = [];
  for (let k = 0; k < K; k++) {
    let ss = 0;
    let cnt = 0;
    const bg = [0, 0, 0];
    for (let i = 0; i < width * height; i++) {
      if (!mask[i]) continue;
      const st = model.status[i];
      if (st !== STATUS.OK && st !== STATUS.CLAMPED) continue;
      const x = i % width;
      const y = (i / width) | 0;
      sampleBgBase(k, x, y, bg);
      for (let c = 0; c < 3; c++) {
        const pred = model.T[i * 3 + c] * bg[c] + model.A[i * 3 + c];
        const d = normObs[k].data[i * 3 + c] - pred;
        ss += d * d;
        cnt++;
      }
    }
    perObsRms.push(cnt ? Math.sqrt(ss / cnt) : NaN);
  }
  const finiteRms = perObsRms.filter((v) => Number.isFinite(v));
  let worstObs = -1;
  let residualRatio = 1;
  if (finiteRms.length > 1) {
    const median = medianOf(finiteRms);
    for (let k = 0; k < K; k++) {
      if (Number.isFinite(perObsRms[k]) && median > 1e-6) {
        const ratio = perObsRms[k] / median;
        if (ratio > residualRatio) { residualRatio = ratio; worstObs = k; }
      }
    }
    if (residualRatio > (options.maxResidualRatio ?? 3)) {
      warnings.push({
        code: 'OBJECT_MISALIGNED',
        message:
          `Observation ${worstObs + 1} is not explained by the shared transmission/reflection fields ` +
          `(residual ${fmt(perObsRms[worstObs])} vs median ${fmt(median)}). This is the signature of the ` +
          'object moving between shots; a fixed object is assumed by the model.',
        observation: worstObs,
      });
    }
  }

  const diagnostics = {
    selectedPixels: selected,
    resolvedPixels: resolved,
    undeterminedPixels: counts.UNDETERMINED + counts.NO_SOLUTION,
    resolvedFraction: selected ? resolved / selected : 0,
    meanBackgroundSpread: spreadN ? spreadSum / spreadN : 0,
    meanResidualRms: residualN ? residualSum / residualN : 0,
    perObservationResidualRms: perObsRms,
    worstObservation: worstObs,
    residualRatio,
    counts,
    tileOffsets,
    tileSize: options.tileSize ?? 48,
  };

  if (selected === 0) {
    warnings.push({ code: 'EMPTY_MASK', message: 'No transmission region selected. Paint a selection before estimating.' });
  } else if (diagnostics.resolvedFraction < 0.5) {
    warnings.push({
      code: 'LOW_IDENTIFIABILITY',
      message:
        `Only ${fmtPct(diagnostics.resolvedFraction)} of the selected region is identifiable from these ` +
        'backgrounds. Choose backgrounds with more local colour spread, or accept the undetermined area as unknown.',
    });
  }

  // The model cannot express everything. State the unsupported range plainly.
  warnings.push({
    code: 'MODEL_SCOPE',
    message:
      'Declared model: O_k = T*B_k(x+s+d) + A. It assumes one fixed object, additive background-independent ' +
      'reflection, and (unless offset is enabled) no background coordinate shift. It does not model refraction ' +
      'curvature, caustics, dispersion or polarisation; a single alpha/transparency cannot reproduce arbitrary glass.',
  });

  // --- typed component representation -------------------------------------
  // The solver's per-pixel status is the authority on what is known. Convert
  // it once, here, into the frozen component contract. The legacy `model` is
  // kept as the old entry; `components` is what new callers should consume.
  //
  // The integrity check is deliberate: a pixel marked identifiable must carry
  // finite T/A, and a degenerate pixel must carry none. If the solver ever
  // drifted from that contract, compositing would otherwise be free to
  // substitute a default — which is exactly what the interface forbids.
  const nPixels = width * height;
  const region = new Uint8Array(nPixels);
  for (let i = 0; i < nPixels; i++) {
    const st = model.status[i];
    if (st === STATUS.OUTSIDE) region[i] = Region.OUTSIDE;
    else if (st === STATUS.OK || st === STATUS.CLAMPED) {
      region[i] = Region.IDENTIFIABLE;
      for (let c = 0; c < 3; c++) {
        if (!Number.isFinite(model.T[i * 3 + c]) || !Number.isFinite(model.A[i * 3 + c])) {
          throw new Error(
            `estimateScene: pixel ${i} is ${STATUS[st]} but T/A are non-finite; refusing to emit a defaulted component`
          );
        }
      }
    } else {
      region[i] = Region.DEGENERATE;
      for (let c = 0; c < 3; c++) {
        if (!Number.isNaN(model.T[i * 3 + c]) || !Number.isNaN(model.A[i * 3 + c])) {
          throw new Error(
            `estimateScene: degenerate pixel ${i} carries finite T/A; unknown components must not be defaulted`
          );
        }
      }
    }
  }
  const components = makeComponents({
    width,
    height,
    T: model.T,
    A: model.A,
    offset: model.offset,
    region,
    channelRegion: null,
    includeOffset,
    source: 'estimated',
    legacyStatus: model.status,
  });
  diagnostics.componentCounts = {
    outside: components.counts.outside,
    identifiable: components.counts.identifiable,
    degenerate: components.counts.degenerate,
  };

  return {
    // Legacy entry (old callers): per-pixel model with status codes.
    model,
    // Typed component entry (refactored callers): frozen T/A/region contract.
    components,
    shifts,
    exposures,
    checks,
    warnings,
    diagnostics,
    includeOffset,
    normalize: { normObs, normBg },
  };
}

function tileSize(options) {
  return options.tileSize ?? 48;
}

function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(3) : String(x);
}
function fmtPct(x) {
  return `${(x * 100).toFixed(0)}%`;
}

export { STATUS };

function medianOf(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
