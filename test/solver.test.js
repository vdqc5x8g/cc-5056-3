import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveChannel, accumulateChannel, STATUS } from '../src/core/solver.js';
import { srgbToLinear, linearToSrgb } from '../src/core/color.js';

test('unconstrained exact recovery from two distinct backgrounds', () => {
  const Ttrue = 0.7, Atrue = 0.12;
  const bs = [0.2, 0.8];
  const os = bs.map((b) => Ttrue * b + Atrue);
  const sums = accumulateChannel(bs, os, 2);
  const r = solveChannel(sums, { noiseVar: 0, maxA: 1 });
  assert.equal(r.status, STATUS.OK);
  assert.ok(Math.abs(r.T - Ttrue) < 1e-9);
  assert.ok(Math.abs(r.A - Atrue) < 1e-9);
});

test('identical backgrounds are undetermined, not transparent', () => {
  const bs = [0.5, 0.5, 0.5];
  const os = bs.map((b) => 0.6 * b + 0.1);
  const sums = accumulateChannel(bs, os, 3);
  const r = solveChannel(sums, { noiseVar: 0, maxA: 1 });
  assert.equal(r.status, STATUS.UNDETERMINED);
  assert.equal(r.T, null);
  assert.equal(r.A, null);
  assert.equal(r.spread, 0);
});

test('near-identical backgrounds nearly undetermined and uncertain', () => {
  const bs = [0.5, 0.5001];
  const os = bs.map((b) => 0.6 * b + 0.1);
  const sums = accumulateChannel(bs, os, 2);
  // A realistic measurement-noise floor; without noise the analytic variance is 0.
  const r = solveChannel(sums, { noiseVar: 1e-6, maxA: 1 });
  assert.ok(r.Tstd === Infinity || r.Tstd > 0.1, `Tstd=${r.Tstd}`);
  // Compare to a well-conditioned pair with the same noise floor.
  const good = solveChannel(accumulateChannel([0.1, 0.9], [0.16, 0.64], 2), { noiseVar: 1e-6, maxA: 1 });
  assert.ok(r.Tstd > good.Tstd * 100, `ill-conditioned Tstd ${r.Tstd} vs ${good.Tstd}`);
});

test('box constraints keep T in [0,1] and A in [0,maxA]', () => {
  // Construct data whose unconstrained A would be negative.
  const bs = [0.1, 0.9];
  const os = [0.9 * 0.1, 0.9 * 0.9]; // T=0.9, A=0 -> okay; now force negative A
  const obsNeg = [0.05, 0.12]; // slopes plus negative intercept
  const sums = accumulateChannel(bs, obsNeg, 2);
  const r = solveChannel(sums, { noiseVar: 0, maxA: 1 });
  assert.ok(r.T >= -1e-9 && r.T <= 1 + 1e-9);
  assert.ok(r.A >= -1e-9 && r.A <= 1 + 1e-9);
});

test('srgb roundtrip is stable', () => {
  for (const v of [0, 0.02, 0.1, 0.5, 0.9, 1]) {
    assert.ok(Math.abs(linearToSrgb(srgbToLinear(v)) - v) < 1e-9);
  }
});
