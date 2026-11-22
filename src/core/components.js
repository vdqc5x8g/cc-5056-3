// Typed glass-component representation shared by estimation and compositing.
//
// The component contract is frozen here so that no caller can silently
// reinterpret transmission as alpha/opacity, or reflection as a background
// pixel. Two typed regions are carried explicitly:
//
//   IDENTIFIABLE  T and A were separated; values are usable.
//   DEGENERATE    locally rank-deficient / not recovered; T and A are unknown
//                 and MUST NOT be replaced by defaults (0, 1 or the background).
//
// Coordinates and colour are declared, not implied:
//   * T(x,y), A(x,y) live on the object / observation pixel grid.
//   * The optional refraction offset d(x,y)=(dx,dy) is in pixels and is added
//     when sampling a background: B(x + dx, y + dy).
//   * Colour is per-channel linear RGB. T is a dimensionless transmittance
//     ratio in [0,1] multiplying the background. A is additive linear radiance,
//     independent of the background.
//
// This module never synthesises pixels from a source photograph. Everything is
// recomputed from the typed components and a new background.

import { STATUS } from './solver.js';
import { LinearImage } from './image.js';

export const Region = Object.freeze({
  OUTSIDE: 0, // not part of the selected transmission region
  IDENTIFIABLE: 1, // T and A separated and usable
  DEGENERATE: 2, // unknown; never treated as transparent or opaque
});

export const REGION_NAMES = Object.freeze(['outside', 'identifiable', 'degenerate']);

// Per-pixel anomaly flags produced by compositing. They are about the two
// contributions visible in the composite canvas: the transparent product's own
// additive reflection, and the background transmitted through it.
export const Anomaly = Object.freeze({
  UNKNOWN: 1 << 0, // degenerate region: no contribution can be stated
  BACKGROUND_OUT_OF_RANGE: 1 << 1, // T*B_new outside display range
  PRODUCT_OUT_OF_RANGE: 1 << 2, // A outside display range
  COMPOSITE_OUT_OF_RANGE: 1 << 3, // T*B_new + A clips in [0,1]
  REFLECTION_DOMINATED: 1 << 4, // A exceeds the transmitted background term
});

export const ANOMALY_KEYS = Object.freeze([
  ['unknown', Anomaly.UNKNOWN],
  ['backgroundOutOfRange', Anomaly.BACKGROUND_OUT_OF_RANGE],
  ['productOutOfRange', Anomaly.PRODUCT_OUT_OF_RANGE],
  ['compositeOutOfRange', Anomaly.COMPOSITE_OUT_OF_RANGE],
  ['reflectionDominated', Anomaly.REFLECTION_DOMINATED],
]);

export const GLASS_COMPONENT_SPEC = Object.freeze({
  model: 'O_k(x) = T(x) * B_k(x + s_k + d(x)) + A(x)',
  color: Object.freeze({
    space: 'linear-rgb',
    channels: Object.freeze(['r', 'g', 'b']),
    encoding: 'linear light internally; sRGB only at display/PNG output',
    exceedsUnitRange: true,
  }),
  coordinates: Object.freeze({
    grid: 'object / observation pixel grid (x, y)',
    transmission: 'T(x, y) on the object grid',
    reflection: 'A(x, y) on the object grid',
    refractionOffset: 'd(x, y) = (dx, dy) in pixels, added when sampling B: B(x + dx, y + dy)',
  }),
  transmission: Object.freeze({
    symbol: 'T',
    kind: 'transmission',
    units: 'dimensionless transmittance ratio',
    perChannel: true,
    range: Object.freeze([0, 1]),
    role: 'multiplicative chromatic attenuation of the background',
  }),
  reflection: Object.freeze({
    symbol: 'A',
    kind: 'reflection',
    units: 'linear radiance (added)',
    perChannel: true,
    range: Object.freeze([0, Infinity]),
    role: 'additive, background-independent reflection',
  }),
  unknown: Object.freeze({
    representation: 'region = degenerate; T and A are NaN and must never be defaulted',
  }),
});

export function regionFromStatus(status) {
  if (status === STATUS.OUTSIDE) return Region.OUTSIDE;
  if (status === STATUS.OK || status === STATUS.CLAMPED) return Region.IDENTIFIABLE;
  return Region.DEGENERATE;
}

export function statusFromRegion(region) {
  if (region === Region.OUTSIDE) return STATUS.OUTSIDE;
  if (region === Region.IDENTIFIABLE) return STATUS.OK;
  return STATUS.UNDETERMINED;
}

// Container for typed components. `region` is authoritative: a compositor must
// consult it instead of guessing from NaN or from whatever stale value happens
// to sit in T/A.
export function makeComponents({
  width,
  height,
  T,
  A,
  offset,
  region,
  channelRegion,
  includeOffset = false,
  source = 'estimated',
  legacyStatus = null,
}) {
  const n = width * height;
  if (!(T && A && region) || T.length !== n * 3 || A.length !== n * 3 || region.length !== n) {
    throw new Error('makeComponents: T/A/region sizes do not match width*height');
  }
  const unknownMask = new Uint8Array(n);
  const counts = { outside: 0, identifiable: 0, degenerate: 0 };
  for (let i = 0; i < n; i++) {
    const r = region[i];
    if (r === Region.OUTSIDE) counts.outside++;
    else if (r === Region.IDENTIFIABLE) counts.identifiable++;
    else if (r === Region.DEGENERATE) {
      counts.degenerate++;
      unknownMask[i] = 1;
    } else {
      throw new Error(`makeComponents: invalid region code ${r} at pixel ${i}`);
    }
  }
  return {
    width,
    height,
    spec: GLASS_COMPONENT_SPEC,
    source,
    region,
    channelRegion: channelRegion ?? null,
    T,
    A,
    offset: offset ?? new Float32Array(n * 2),
    includeOffset: !!includeOffset,
    unknownMask,
    counts,
    // Frozen reference to the legacy status codes (kept so old callers and
    // tests can be compared without re-deriving them).
    legacyStatus: legacyStatus ?? null,
  };
}

// Compatibility adapter: old per-pixel model ({T,A,offset,status,...}) ->
// typed components. The legacy model is the "old entry" that must keep working.
export function componentsFromModel(model, { source = 'legacy-model' } = {}) {
  if (!model || !model.width || !model.height) throw new Error('componentsFromModel: not a model');
  const { width, height, T, A, offset, status, channelStatus } = model;
  const n = width * height;
  const region = new Uint8Array(n);
  let channelRegion = null;
  if (channelStatus) {
    channelRegion = new Uint8Array(n * 3);
    for (let j = 0; j < n * 3; j++) channelRegion[j] = regionFromStatus(channelStatus[j]);
  }
  for (let i = 0; i < n; i++) region[i] = regionFromStatus(status[i]);
  return makeComponents({
    width,
    height,
    T,
    A,
    offset,
    region,
    channelRegion,
    includeOffset: !!model.includeOffset,
    source,
    legacyStatus: status,
  });
}

function isTypedComponents(value) {
  return !!(value && value.spec && value.region && value.T && value.A);
}

function asComponents(value) {
  return isTypedComponents(value) ? value : componentsFromModel(value);
}

// Recompute the product over a NEW background from typed components only.
// Degenerate regions are returned as NaN and listed in `unresolved`; they are
// never turned into transparency or an opaque layer.
export function compositeComponents(components, newBg, opts = {}) {
  const { width, height, region, T, A, offset } = components;
  if (!width || !height) throw new Error('compositeComponents: malformed components');
  if (newBg.width !== width || newBg.height !== height) {
    throw new Error(`compositeComponents: new background is ${newBg.width}x${newBg.height}, expected ${width}x${height}`);
  }
  const n = width * height;
  const useOffset = opts.useOffset ?? !!components.includeOffset;
  const eps = opts.rangeEpsilon ?? 1e-6;
  const image = new LinearImage(width, height);
  const backgroundContribution = new LinearImage(width, height);
  const productContribution = new LinearImage(width, height);
  const unknownMask = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const unresolved = [];
  const counts = {
    unknown: 0,
    backgroundOutOfRange: 0,
    productOutOfRange: 0,
    compositeOutOfRange: 0,
    reflectionDominated: 0,
  };
  const bg = [0, 0, 0];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const r = region[i];
      if (r === Region.OUTSIDE) {
        // The product is not present here: the new background passes through.
        newBg.sampleBilinear(x, y, 0, 0, bg);
        image.setPixel(x, y, bg[0], bg[1], bg[2]);
        backgroundContribution.setPixel(x, y, bg[0], bg[1], bg[2]);
        productContribution.setPixel(x, y, 0, 0, 0);
        continue;
      }
      if (r === Region.DEGENERATE) {
        // Explicit unknown. Do not read T/A, even if stale finite values exist.
        unknownMask[i] = 1;
        unresolved.push(i);
        flags[i] |= Anomaly.UNKNOWN;
        counts.unknown++;
        image.setPixel(x, y, Number.NaN, Number.NaN, Number.NaN);
        backgroundContribution.setPixel(x, y, Number.NaN, Number.NaN, Number.NaN);
        productContribution.setPixel(x, y, Number.NaN, Number.NaN, Number.NaN);
        continue;
      }
      if (r !== Region.IDENTIFIABLE) throw new Error(`compositeComponents: invalid region ${r} at ${x},${y}`);

      const dx = useOffset ? offset[i * 2] : 0;
      const dy = useOffset ? offset[i * 2 + 1] : 0;
      newBg.sampleBilinear(x, y, dx, dy, bg);
      let backgroundBad = false;
      let productBad = false;
      let compositeBad = false;
      let dominated = false;
      for (let c = 0; c < 3; c++) {
        const t = T[i * 3 + c];
        const a = A[i * 3 + c];
        if (!Number.isFinite(t) || !Number.isFinite(a)) {
          // Refuse to hide a broken estimate behind a default.
          throw new Error(
            `compositeComponents: pixel (${x},${y}) is marked identifiable but T/A are non-finite; ` +
              'refusing to substitute defaults'
          );
        }
        const bt = t * bg[c];
        backgroundContribution.data[i * 3 + c] = bt;
        productContribution.data[i * 3 + c] = a;
        const v = bt + a;
        image.data[i * 3 + c] = v;
        if (bt < -eps || bt > 1 + eps) backgroundBad = true;
        if (a < -eps || a > 1 + eps) productBad = true;
        if (v < -eps || v > 1 + eps) compositeBad = true;
        if (a > bt + eps) dominated = true;
      }
      if (backgroundBad) { flags[i] |= Anomaly.BACKGROUND_OUT_OF_RANGE; counts.backgroundOutOfRange++; }
      if (productBad) { flags[i] |= Anomaly.PRODUCT_OUT_OF_RANGE; counts.productOutOfRange++; }
      if (compositeBad) { flags[i] |= Anomaly.COMPOSITE_OUT_OF_RANGE; counts.compositeOutOfRange++; }
      if (dominated) { flags[i] |= Anomaly.REFLECTION_DOMINATED; counts.reflectionDominated++; }
    }
  }

  return {
    image,
    backgroundContribution,
    productContribution,
    unresolved,
    unknownMask,
    anomalies: { flags, counts },
    region,
    spec: components.spec,
  };
}

// Typed component visualisations (same conventions as the frozen legacy tool):
//   transmission  -> T tint on mid-grey, so 1.0 reads as neutral grey
//   reflection    -> A as emitted colour on black
//   backgroundTerm-> T * B_new on black
export function componentImagesFromComponents(components, newBg, opts = {}) {
  const { width, height, region, T, A } = components;
  const useOffset = opts.useOffset ?? !!components.includeOffset;
  const tint = new LinearImage(width, height);
  const reflection = new LinearImage(width, height);
  const backgroundTerm = new LinearImage(width, height);
  const bg = [0, 0, 0];
  for (let i = 0, n = width * height; i < n; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    const r = region[i];
    if (r === Region.OUTSIDE) {
      for (let c = 0; c < 3; c++) {
        tint.data[i * 3 + c] = 0.18;
        reflection.data[i * 3 + c] = 0;
        backgroundTerm.data[i * 3 + c] = 0;
      }
      continue;
    }
    if (r === Region.DEGENERATE) {
      for (let c = 0; c < 3; c++) {
        // Magenta sentinel = the model does not know here.
        tint.data[i * 3 + c] = c === 1 ? 0 : 0.35;
        reflection.data[i * 3 + c] = 0;
        backgroundTerm.data[i * 3 + c] = 0;
      }
      continue;
    }
    if (r !== Region.IDENTIFIABLE) throw new Error(`componentImages: invalid region ${r}`);
    newBg.sampleBilinear(x, y, useOffset ? components.offset[i * 2] : 0, useOffset ? components.offset[i * 2 + 1] : 0, bg);
    for (let c = 0; c < 3; c++) {
      const t = T[i * 3 + c];
      const a = A[i * 3 + c];
      if (!Number.isFinite(t) || !Number.isFinite(a)) {
        throw new Error(`componentImages: identifiable pixel ${x},${y} has non-finite T/A; refusing to default`);
      }
      tint.data[i * 3 + c] = 0.18 * t + 0.5 * (1 - t);
      reflection.data[i * 3 + c] = a;
      backgroundTerm.data[i * 3 + c] = t * bg[c];
    }
  }
  return { tint, reflection, backgroundTerm };
}

// Reconstruction from typed components, for residual diagnostics. This is a
// model re-render, not a copy of the source photograph.
export function reconstructComponents(components, observations, sampleBgForObs, width, height) {
  const { region, T, A } = components;
  if (width !== components.width || height !== components.height) {
    throw new Error('reconstructComponents: size mismatch');
  }
  const nObs = observations.length;
  const recon = observations.map(() => new LinearImage(width, height));
  const mask = new Uint8Array(width * height);
  const bg = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const r = region[i];
      if (r === Region.OUTSIDE) {
        for (let k = 0; k < nObs; k++) {
          observations[k].getPixel(x, y, bg);
          recon[k].setPixel(x, y, bg[0], bg[1], bg[2]);
        }
        continue;
      }
      if (r === Region.DEGENERATE) {
        mask[i] = 1;
        for (let k = 0; k < nObs; k++) recon[k].setPixel(x, y, Number.NaN, Number.NaN, Number.NaN);
        continue;
      }
      if (r !== Region.IDENTIFIABLE) throw new Error(`reconstructComponents: invalid region ${r}`);
      for (let k = 0; k < nObs; k++) {
        sampleBgForObs(k, x, y, bg);
        const t0 = T[i * 3], t1 = T[i * 3 + 1], t2 = T[i * 3 + 2];
        const a0 = A[i * 3], a1 = A[i * 3 + 1], a2 = A[i * 3 + 2];
        if (![t0, t1, t2, a0, a1, a2].every(Number.isFinite)) {
          throw new Error(`reconstructComponents: identifiable pixel ${x},${y} has non-finite T/A`);
        }
        recon[k].setPixel(
          x, y,
          t0 * bg[0] + a0,
          t1 * bg[1] + a1,
          t2 * bg[2] + a2
        );
      }
    }
  }
  return { recon, undeterminedMask: mask };
}

export { isTypedComponents, asComponents };
