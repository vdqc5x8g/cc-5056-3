import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinearImage } from '../src/core/image.js';
import {
  makeBackground,
  makeGlassFields,
  roundedRectMask,
  renderObservation,
  renderReference,
  scoreAgainstTruth,
} from '../src/core/synth.js';
import { estimateScene } from '../src/core/pipeline.js';
import { composite, componentImages, reconstruct, residualStats } from '../src/core/composite.js';
import {
  Region,
  Anomaly,
  makeComponents,
  componentsFromModel,
  compositeComponents,
  componentImagesFromComponents,
  reconstructComponents,
  GLASS_COMPONENT_SPEC,
} from '../src/core/components.js';

const W = 96;
const H = 96;

function basicEstimate(seedBase = 100) {
  const backgrounds = [
    makeBackground('checker', W, H, seedBase + 1),
    makeBackground('gradient', W, H, seedBase + 2),
  ].map((image) => ({ image }));
  const mask = roundedRectMask(W, H, 24, 14, 72, 82, 12);
  const fields = makeGlassFields(W, H, mask, {});
  const obs = backgrounds.map((bg, k) =>
    renderObservation(fields, bg, mask, W, H, { seed: seedBase + 10 + k })
  );
  const result = estimateScene({
    observations: obs.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: { alignRadius: 2 },
  });
  return { backgrounds, mask, fields, obs, result };
}

test('typed components declare coordinates and colour explicitly', () => {
  const spec = GLASS_COMPONENT_SPEC;
  assert.equal(spec.color.space, 'linear-rgb');
  assert.deepEqual([...spec.color.channels], ['r', 'g', 'b']);
  assert.equal(spec.transmission.symbol, 'T');
  assert.equal(spec.reflection.symbol, 'A');
  assert.match(spec.coordinates.refractionOffset, /B\(x \+ dx, y \+ dy\)/);
  assert.match(spec.transmission.role, /multiplicative/);
  assert.match(spec.reflection.role, /additive/);
});

test('estimate exposes typed components with consistent region counts', () => {
  const { result, mask } = basicEstimate();
  const c = result.components;
  assert.ok(c, 'components must be emitted');
  assert.equal(c.T.length, W * H * 3);
  assert.equal(c.A.length, W * H * 3);
  assert.equal(c.region.length, W * H);
  let ident = 0;
  let degen = 0;
  let outside = 0;
  for (let i = 0; i < W * H; i++) {
    if (c.region[i] === Region.IDENTIFIABLE) {
      ident++;
      for (let ch = 0; ch < 3; ch++) {
        assert.ok(Number.isFinite(c.T[i * 3 + ch]), 'identifiable T must be finite');
        assert.ok(Number.isFinite(c.A[i * 3 + ch]), 'identifiable A must be finite');
      }
    } else if (c.region[i] === Region.DEGENERATE) {
      degen++;
      for (let ch = 0; ch < 3; ch++) {
        assert.ok(Number.isNaN(c.T[i * 3 + ch]), 'degenerate T must be NaN, not a default');
        assert.ok(Number.isNaN(c.A[i * 3 + ch]), 'degenerate A must be NaN, not a default');
      }
    } else {
      outside++;
      assert.equal(mask[i], 0, 'outside region must match the unpainted selection');
    }
  }
  assert.equal(ident, c.counts.identifiable);
  assert.equal(degen, c.counts.degenerate);
  assert.equal(outside, c.counts.outside);
  assert.equal(ident + degen, result.diagnostics.selectedPixels);
});

test('compatibility adapter reproduces the legacy entry exactly', () => {
  const { result } = basicEstimate(300);
  const fromLegacy = componentsFromModel(result.model);
  const direct = result.components;
  for (let i = 0; i < W * H; i++) {
    assert.equal(fromLegacy.region[i], direct.region[i], `region at ${i}`);
    for (let ch = 0; ch < 3; ch++) {
      const a = fromLegacy.T[i * 3 + ch];
      const b = direct.T[i * 3 + ch];
      assert.ok((Number.isNaN(a) && Number.isNaN(b)) || a === b, `T at ${i}`);
    }
  }
  assert.equal(fromLegacy.counts.identifiable, direct.counts.identifiable);
  assert.equal(fromLegacy.counts.degenerate, direct.counts.degenerate);
});

test('composite accepts the legacy model and typed components with identical output', () => {
  const { result } = basicEstimate(500);
  const newBg = makeBackground('dots', W, H, 77);
  const fromLegacy = composite(result.model, newBg, { useOffset: false });
  const fromTyped = composite(result.components, newBg, { useOffset: false });
  for (let i = 0; i < W * H * 3; i++) {
    const a = fromLegacy.image.data[i];
    const b = fromTyped.image.data[i];
    assert.ok((Number.isNaN(a) && Number.isNaN(b)) || a === b, `composite pixel channel ${i}`);
  }
  assert.deepEqual(fromLegacy.unresolved, fromTyped.unresolved);
  assert.deepEqual(fromLegacy.anomalies.counts, fromTyped.anomalies.counts);
});

test('degenerate pixels are unknown in the composite, never transparent or opaque', () => {
  // Two identical plates: the whole selection is rank deficient.
  const bg = makeBackground('gradient', W, H, 601);
  const backgrounds = [{ image: bg }, { image: bg.clone() }];
  const mask = roundedRectMask(W, H, 24, 14, 72, 82, 12);
  const fields = makeGlassFields(W, H, mask, {});
  const obs = backgrounds.map((b, k) =>
    renderObservation(fields, b, mask, W, H, { seed: 610 + k })
  );
  const result = estimateScene({
    observations: obs.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: {},
  });
  const c = result.components;
  assert.equal(c.counts.identifiable, 0);
  assert.ok(c.counts.degenerate > 0);
  const newBg = LinearImage.solid(W, H, 0.3, 0.4, 0.5);
  const comp = compositeComponents(c, newBg, {});
  for (let i = 0; i < W * H; i++) {
    if (c.region[i] === Region.DEGENERATE) {
      assert.ok(Number.isNaN(comp.image.data[i * 3]), 'degenerate composite must be NaN');
      assert.ok(comp.unknownMask[i], 'unknown mask must mark degenerate pixels');
      assert.ok(comp.anomalies.flags[i] & Anomaly.UNKNOWN, 'UNKNOWN anomaly must be set');
      // It is explicitly NOT the new background (which would be "transparent").
      assert.ok(!(comp.image.data[i * 3] === newBg.data[i * 3]));
    }
  }
  assert.equal(comp.unresolved.length, c.counts.degenerate);
  assert.equal(comp.anomalies.counts.unknown, c.counts.degenerate);
});

test('composite residual against a reference is bounded over identifiable pixels', () => {
  const { result, fields } = basicEstimate(700);
  const newBg = makeBackground('dots', W, H, 99);
  const reference = renderReference(fields, newBg, result.components.region.map((r) => (r !== Region.OUTSIDE ? 1 : 0)), W, H, false);
  const comp = composite(result.components, newBg, { useOffset: false });
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = result.components.region[i] === Region.IDENTIFIABLE ? 1 : 0;
  const stats = residualStats(comp.image, reference, W, H, mask);
  assert.ok(stats.pixels > 1000, `scored ${stats.pixels}`);
  assert.ok(stats.rms < 0.08, `composite rms ${stats.rms}`);
});

test('component reconstruction matches observations and leaves unknown pixels NaN', () => {
  const { result } = basicEstimate(800);
  const c = result.components;
  const sampleBgForObs = (k, x, y, out) => {
    const s = result.shifts[k];
    result.normalize.normBg[k].sampleBilinear(x, y, s.dx, s.dy, out);
  };
  const { recon, undeterminedMask } = reconstructComponents(
    c,
    result.normalize.normObs,
    sampleBgForObs,
    W,
    H
  );
  const identMask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) identMask[i] = c.region[i] === Region.IDENTIFIABLE ? 1 : 0;
  for (let k = 0; k < recon.length; k++) {
    const stats = residualStats(recon[k], result.normalize.normObs[k], W, H, identMask);
    assert.ok(stats.rms < 0.02, `shot ${k} reconstruction rms ${stats.rms}`);
  }
  for (let i = 0; i < W * H; i++) {
    if (c.region[i] === Region.DEGENERATE) {
      assert.ok(undeterminedMask[i], 'degenerate pixel must be marked in reconstruction');
      assert.ok(Number.isNaN(recon[0].data[i * 3]), 'degenerate reconstruction must be NaN');
    }
  }
});

test('compositor refuses to default a mislabelled identifiable pixel', () => {
  // Hand-build components that violate the contract: identifiable region but
  // non-finite T. The compositor must throw, not substitute a default.
  const n = W * H;
  const T = new Float64Array(n * 3).fill(1);
  const A = new Float64Array(n * 3).fill(0);
  const region = new Uint8Array(n).fill(Region.IDENTIFIABLE);
  T[0] = NaN;
  const bad = makeComponents({ width: W, height: H, T, A, region });
  const newBg = LinearImage.solid(W, H, 0.2, 0.2, 0.2);
  assert.throws(() => compositeComponents(bad, newBg, {}), /refusing to substitute defaults/);
});

test('component visuals keep magenta for degenerate region and neutral grey for T=1', () => {
  const n = W * H;
  const T = new Float64Array(n * 3).fill(1);
  const A = new Float64Array(n * 3).fill(0);
  const region = new Uint8Array(n).fill(Region.IDENTIFIABLE);
  region[5] = Region.DEGENERATE;
  T[5 * 3] = NaN;
  T[5 * 3 + 1] = NaN;
  T[5 * 3 + 2] = NaN;
  const c = makeComponents({ width: W, height: H, T, A, region });
  const newBg = LinearImage.solid(W, H, 0.4, 0.4, 0.4);
  const imgs = componentImagesFromComponents(c, newBg);
  assert.ok(Math.abs(imgs.tint.data[0] - 0.18) < 1e-9, 'T=1 reads as neutral grey 0.18');
  assert.ok(Math.abs(imgs.tint.data[5 * 3] - 0.35) < 1e-9, 'degenerate tint is magenta sentinel');
  assert.ok(Math.abs(imgs.tint.data[5 * 3 + 1]) < 1e-9, 'magenta has zero green');
});

test('composite rejects a background on a different coordinate grid', () => {
  const { result } = basicEstimate(900);
  const wrong = LinearImage.solid(W + 4, H, 0.5, 0.5, 0.5);
  assert.throws(() => composite(result.components, wrong, {}), /refusing to assume a coordinate grid/);
});

test('composite records out-of-range contributions as anomalies', () => {
  const n = W * H;
  const T = new Float64Array(n * 3).fill(1);
  const A = new Float64Array(n * 3).fill(0);
  const region = new Uint8Array(n).fill(Region.IDENTIFIABLE);
  // A reflection far above display range on one pixel.
  A[3] = 2.5;
  const c = makeComponents({ width: W, height: H, T, A, region });
  const newBg = LinearImage.solid(W, H, 0.5, 0.5, 0.5);
  const comp = compositeComponents(c, newBg, {});
  assert.ok(comp.anomalies.flags[1] & Anomaly.PRODUCT_OUT_OF_RANGE, 'product out of range flagged');
  assert.ok(comp.anomalies.flags[1] & Anomaly.COMPOSITE_OUT_OF_RANGE, 'composite clipping flagged');
  assert.ok(comp.anomalies.counts.productOutOfRange >= 1);
});
