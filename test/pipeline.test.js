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
import { composite, residualStats } from '../src/core/composite.js';

const W = 96;
const H = 96;

function buildScene({ backgrounds, shifts, gains, noise = 0, useOffset = false, seed = 3 }) {
  const mask = roundedRectMask(W, H, 24, 14, 72, 82, 12);
  const fields = makeGlassFields(W, H, mask, { refraction: useOffset ? 6 : 0 });
  const obs = backgrounds.map((bg, k) =>
    renderObservation(fields, bg, mask, W, H, {
      shift: shifts[k],
      gain: gains[k],
      noise,
      useOffset,
      seed: seed + k,
    })
  );
  return { mask, fields, obs };
}

test('two distinct backgrounds recover T and A per pixel', () => {
  const backgrounds = [
    makeBackground('checker', W, H, 11),
    makeBackground('gradient', W, H, 12),
  ].map((img) => ({ image: img }));
  const shifts = [{ dx: 0, dy: 0 }, { dx: 1, dy: -1 }];
  const gains = [1, 1];
  const { mask, fields, obs } = buildScene({ backgrounds, shifts, gains });

  const result = estimateScene({
    observations: obs.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: { alignRadius: 2, maxShift: 3 },
  });

  const score = scoreAgainstTruth(result.model, fields, mask, W, H);
  assert.ok(score.scoredPixels > 1000, `scored ${score.scoredPixels}`);
  assert.ok(score.T_rmse < 0.06, `T rmse ${score.T_rmse}`);
  assert.ok(score.A_rmse < 0.06, `A rmse ${score.A_rmse}`);
  assert.ok(result.diagnostics.resolvedFraction > 0.8, `resolved ${result.diagnostics.resolvedFraction}`);
  // Undetermined pixels carry NaN (unknown), never a transparent alpha.
  for (let i = 0; i < W * H; i++) {
    if (result.model.status[i] === 3) {
      assert.ok(Number.isNaN(result.model.T[i * 3]));
      assert.ok(Number.isNaN(result.model.A[i * 3]));
    }
  }
});

test('a background pair that is locally identical leaves pixels undetermined', () => {
  // Same plate twice: no local colour spread to separate T from A.
  const bg = makeBackground('gradient', W, H, 21);
  const backgrounds = [{ image: bg }, { image: bg.clone() }];
  const { mask, obs } = buildScene({
    backgrounds,
    shifts: [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }],
    gains: [1, 1],
  });
  const result = estimateScene({
    observations: obs.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: {  },
  });
  assert.equal(result.diagnostics.resolvedPixels, 0);
  assert.ok(result.diagnostics.undeterminedPixels > 0);
  const codes = result.warnings.map((w) => w.code);
  assert.ok(codes.includes('OBS_VARIATION') || codes.includes('LOW_IDENTIFIABILITY'));
});

test('composite reproduces held-out reference from estimated fields', () => {
  const backgrounds = [
    makeBackground('checker', W, H, 31),
    makeBackground('stripes', W, H, 32),
    makeBackground('spectrum', W, H, 33),
  ].map((image) => ({ image }));
  const shifts = [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }];
  const gains = [1, 1.05, 0.97];
  const { mask, fields, obs } = buildScene({ backgrounds, shifts, gains });

  const result = estimateScene({
    observations: obs.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: { alignRadius: 2 },
  });

  const newBg = makeBackground('dots', W, H, 99);
  const reference = renderReference(fields, newBg, mask, W, H, false);
  const comp = composite(result.model, newBg, { useOffset: false });
  const resolvedMask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const st = result.model.status[i];
    if (st === 1 || st === 2) resolvedMask[i] = 1;
    else if (st === 3) {
      // Undetermined area must be NaN, not silently transparent background.
      assert.ok(Number.isNaN(comp.image.data[i * 3]));
    }
  }
  const stats = residualStats(comp.image, reference, W, H, resolvedMask);
  assert.ok(stats.rms < 0.06, `composite rms ${stats.rms}`);
  assert.ok(stats.pixels > 1000);
  assert.equal(comp.unresolved.length, result.diagnostics.undeterminedPixels);
});

test('exposure drift is flagged and not attributed to object colour', () => {
  const backgrounds = [
    makeBackground('checker', W, H, 41),
    makeBackground('gradient', W, H, 42),
  ].map((image) => ({ image }));
  const { mask, obs } = buildScene({
    backgrounds,
    shifts: [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }],
    gains: [1, 1.35], // major exposure difference
  });
  const result = estimateScene({
    observations: obs.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: { maxGainSpread: 0.05 },
  });
  const codes = result.warnings.map((w) => w.code);
  assert.ok(codes.includes('OBS_INCONSISTENT') || codes.includes('OBS_VARIATION'));
});

test('composite never copies source pixels: changing the new background changes every output', () => {
  const backgrounds = [
    makeBackground('checker', W, H, 51),
    makeBackground('gradient', W, H, 52),
  ].map((image) => ({ image }));
  const { mask, obs } = buildScene({ backgrounds, shifts: [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }], gains: [1, 1] });
  const result = estimateScene({
    observations: obs.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: {  },
  });
  const bgA = LinearImage.solid(W, H, 0.2, 0.3, 0.4);
  const bgB = LinearImage.solid(W, H, 0.7, 0.6, 0.5);
  const a = composite(result.model, bgA, {});
  const b = composite(result.model, bgB, {});
  let differs = 0;
  let total = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    if (result.model.status[i] !== 1 && result.model.status[i] !== 2) continue;
    total++;
    if (Math.abs(a.image.data[i * 3] - b.image.data[i * 3]) > 1e-6) differs++;
  }
  assert.ok(total > 500, `resolved pixels ${total}`);
  assert.equal(differs, total);
});

test('a moving object is reported, not absorbed into object colour', () => {
  const mask = roundedRectMask(W, H, 24, 14, 72, 82, 12);
  const backgrounds = [
    makeBackground('checker', W, H, 61),
    makeBackground('gradient', W, H, 62),
    makeBackground('stripes', W, H, 63),
  ].map((image) => ({ image }));
  const fields = makeGlassFields(W, H, mask, {});
  const obs = [
    renderObservation(fields, backgrounds[0], mask, W, H, { seed: 1 }),
    renderObservation(fields, backgrounds[1], mask, W, H, { seed: 2 }),
    // frame 3: the object was nudged; the drawn mask no longer describes it.
    renderObservation(fields, backgrounds[2], mask, W, H, { seed: 3, objectShift: { dx: 5, dy: 3 } }),
  ];
  const result = estimateScene({
    observations: obs.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: {  },
  });
  const codes = result.warnings.map((w) => w.code);
  // A moved object breaks background registration (ncc) and/or the shared-field
  // residual; either diagnosis is acceptable, but it must not be silent.
  assert.ok(
    codes.includes('OBJECT_MISALIGNED') || codes.includes('OBS_INCONSISTENT'),
    `warnings: ${codes}`
  );
  assert.ok(result.diagnostics.residualRatio > 1.1, `ratio ${result.diagnostics.residualRatio}`);
});

test('declared background offset is a no-op without refraction and helps with it', () => {
  const mask = roundedRectMask(W, H, 24, 14, 72, 82, 12);
  const backgrounds = [
    makeBackground('checker', W, H, 71),
    makeBackground('gradient', W, H, 72),
    makeBackground('stripes', W, H, 73),
  ].map((image) => ({ image }));
  const flat = makeGlassFields(W, H, mask, {});
  const obsFlat = backgrounds.map((b, k) =>
    renderObservation(flat, b, mask, W, H, { seed: 20 + k })
  );
  const rFlat = estimateScene({
    observations: obsFlat.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: { includeOffset: true, offsetRadius: 4, tileSize: 32 },
  });
  // No refraction: the offset search must not invent a shift.
  assert.ok(rFlat.diagnostics.tileOffsets.every((t) => t.dx === 0 && t.dy === 0));

  const refracting = makeGlassFields(W, H, mask, { refraction: 8 });
  const obsRef = backgrounds.map((b, k) =>
    renderObservation(refracting, b, mask, W, H, { seed: 30 + k, useOffset: true })
  );
  const off = estimateScene({
    observations: obsRef.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: { includeOffset: false },
  });
  const on = estimateScene({
    observations: obsRef.map((image) => ({ image })),
    backgrounds,
    mask,
    width: W,
    height: H,
    options: { includeOffset: true, offsetRadius: 6, tileSize: 16, offsetStride: 1 },
  });
  const offScore = scoreAgainstTruth(off.model, refracting, mask, W, H);
  const onScore = scoreAgainstTruth(on.model, refracting, mask, W, H);
  assert.ok(onScore.T_rmse < offScore.T_rmse, `on ${onScore.T_rmse} off ${offScore.T_rmse}`);
  assert.ok(on.diagnostics.tileOffsets.some((t) => t.accepted));
});
