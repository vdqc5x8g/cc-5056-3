// Per-pixel / per-tile estimation core for the declared model:
//
//   O_k(x) = T(x) * B_k(x + s_k + d(x)) + A(x)
//
// where
//   O_k   observed image with the glass over known background plate k
//   B_k   known background plate k (registered/aligned by s_k)
//   T     per-channel transmittance (chromatic attenuation), in [0,1]^3
//   A     additive, background-independent reflection term, >= 0
//   d     optional background coordinate offset (refraction); only used when
//         the model explicitly declares `includeOffset`
//
// For a fixed d the model is linear in (T_c, A_c) per channel. With K>=2
// observations over different backgrounds the 2x2 normal equations are
// solvable; when the backgrounds are locally identical the system is rank
// deficient and the pixel is marked UNDETERMINED rather than being reported
// as transparent.
//
// Deliberately absent: any path that copies source pixels. Everything is
// recomputed from the estimated T, A and the *new* background.

export const STATUS = Object.freeze({
  OUTSIDE: 0, // not part of the selected transmission region
  OK: 1, // interior solution inside the physical box
  CLAMPED: 2, // optimum lies on the [0,1] / A>=0 box boundary
  UNDETERMINED: 3, // locally rank-deficient; T/A not separated
  NO_SOLUTION: 4, // degenerate in a way that yields no usable estimate
});

export function makeModel(width, height) {
  const n = width * height;
  const model = {
    width,
    height,
    T: new Float32Array(n * 3),
    A: new Float32Array(n * 3),
    Tstd: new Float32Array(n * 3),
    Astd: new Float32Array(n * 3),
    offset: new Float32Array(n * 2),
    status: new Uint8Array(n),
    channelStatus: new Uint8Array(n * 3),
    residualRms: new Float32Array(n),
    // Numerator of the local background spread used for identifiability.
    spread: new Float32Array(n * 3),
    includeOffset: false,
  };
  for (let i = 0; i < n; i++) {
    model.T[i * 3] = model.T[i * 3 + 1] = model.T[i * 3 + 2] = 1;
  }
  return model;
}

function sseAt(T, A, sums) {
  const { N, Sb2, Sb, So, Sbo, Soo } = sums;
  return (
    Soo - 2 * (T * Sbo + A * So) + T * T * Sb2 + 2 * T * A * Sb + N * A * A
  );
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Exact box-constrained least squares for the two unknowns (T,A).
// The feasible set is [0,1] x [0,maxA]; the optimum is interior or on an edge,
// so candidate evaluation is exact for this convex QP.
export function solveChannel(sums, opts) {
  const { N, Sb2, Sb, So, Sbo, Soo } = sums;
  const maxA = opts.maxA ?? 1;
  const denom = N * Sb2 - Sb * Sb; // = N^2 * Var(b); 0 iff all b_k equal

  if (!(denom > 1e-18 * Math.max(1, Sb2 * N))) {
    return {
      status: STATUS.UNDETERMINED,
      T: null,
      A: null,
      Tstd: Infinity,
      Astd: Infinity,
      spread: 0,
      // T stays free, A = (So - T*Sb)/N: the one-dimensional ambiguity line.
      ambiguity: { Tfree: true, AOfT: (T) => (So - T * Sb) / N },
    };
  }

  const Tfree = (N * Sbo - Sb * So) / denom;
  const Afree = (So - Tfree * Sb) / N;

  const candidates = [];
  if (Tfree >= 0 && Tfree <= 1 && Afree >= 0 && Afree <= maxA) {
    candidates.push({ T: Tfree, A: Afree, interior: true });
  } else {
    candidates.push({ T: clamp01(Tfree), A: Math.min(maxA, Math.max(0, Afree)) });
  }
  // Edge T=0 / T=1: solve A from the mean residual.
  candidates.push({ T: 0, A: Math.min(maxA, Math.max(0, So / N)) });
  candidates.push({ T: 1, A: Math.min(maxA, Math.max(0, (So - Sb) / N)) });
  // Edge A=0 / A=maxA: solve T.
  if (Sb2 > 1e-30) {
    candidates.push({ T: clamp01(Sbo / Sb2), A: 0 });
    candidates.push({ T: clamp01((Sbo - maxA * Sb) / Sb2), A: maxA });
  }

  let best = null;
  for (const cand of candidates) {
    const T = cand.T;
    const A = cand.A;
    if (T < -1e-9 || T > 1 + 1e-9 || A < -1e-9 || A > maxA + 1e-9) continue;
    const err = sseAt(T, A, sums);
    if (!best || err < best.err) best = { T, A, err };
  }
  if (!best) {
    return { status: STATUS.NO_SOLUTION, T: null, A: null, Tstd: Infinity, Astd: Infinity, spread: 0 };
  }

  const noiseVar = Math.max(opts.noiseVar ?? 0, opts.sigmaFloor ?? 0);
  const dof = N - 2;
  const sigma2 =
    dof > 0 ? Math.max(noiseVar, best.err / dof) : noiseVar;
  const varT = sigma2 * (N / denom);
  const varA = sigma2 * (Sb2 / denom);
  const spread = Math.sqrt(denom) / N; // sqrt(Var(b))

  let status = STATUS.OK;
  if (!(Tfree >= 0 && Tfree <= 1 && Afree >= 0 && Afree <= maxA)) {
    status = STATUS.CLAMPED;
  }

  return {
    status,
    T: best.T,
    A: best.A,
    Tstd: Math.sqrt(Math.max(0, varT)),
    Astd: Math.sqrt(Math.max(0, varA)),
    spread,
    constrained: status === STATUS.CLAMPED,
  };
}

// Accumulate the sufficient statistics for one pixel/channel.
export function accumulateChannel(bs, os, nObs) {
  let Sb2 = 0;
  let Sb = 0;
  let So = 0;
  let Sbo = 0;
  let Soo = 0;
  for (let k = 0; k < nObs; k++) {
    const b = bs[k];
    const o = os[k];
    Sb2 += b * b;
    Sb += b;
    So += o;
    Sbo += b * o;
    Soo += o * o;
  }
  return { N: nObs, Sb2, Sb, So, Sbo, Soo };
}

// Solves every pixel inside the mask. `sampleBg(k, x, y, out)` must already
// apply the per-observation alignment shift s_k and (when declared) the model
// offset d. Per-pixel T/A are solved independently; the offset field, if any,
// is estimated beforehand per tile by poolSolver.
export function solveImage(obs, sampleBg, mask, width, height, opts) {
  const model = makeModel(width, height);
  model.includeOffset = !!opts.includeOffset;
  const nObs = obs.length;
  const noiseVar = opts.noiseVar ?? 0;
  // Noise floor: one 8-bit step in linear light. Tstd is meaningless below
  // this, and using it keeps the identifiability gate well-defined even on
  // noise-free synthetic observations.
  const sigmaFloor2 = opts.sigmaFloor ?? (1 / 255) ** 2;
  const maxTstd = opts.maxTstd ?? 0.5;
  const maxA = opts.maxA ?? 1;
  const bs = new Float64Array(nObs);
  const os = new Float64Array(nObs);
  const bg = [0, 0, 0];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) {
        model.status[i] = STATUS.OUTSIDE;
        model.T[i * 3] = model.T[i * 3 + 1] = model.T[i * 3 + 2] = 1;
        model.A[i * 3] = model.A[i * 3 + 1] = model.A[i * 3 + 2] = 0;
        continue;
      }
      let worst = STATUS.OK;
      let rss = 0;
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < nObs; k++) {
          sampleBg(k, x, y, bg);
          bs[k] = bg[c];
          os[k] = obs[k].data[i * 3 + c];
        }
        const sums = accumulateChannel(bs, os, nObs);
        model.spread[i * 3 + c] = Math.sqrt(
          Math.max(0, sums.Sb2 / nObs - (sums.Sb / nObs) ** 2)
        );
        const res = solveChannel(sums, { noiseVar, maxA, sigmaFloor: sigmaFloor2 });
        model.channelStatus[i * 3 + c] = res.status;
        if (res.status > worst) worst = res.status;
        if (res.T == null) {
          // Leave undetermined values at neutral (not transparent) sentinel.
          model.T[i * 3 + c] = NaN;
          model.A[i * 3 + c] = NaN;
          model.Tstd[i * 3 + c] = Infinity;
          model.Astd[i * 3 + c] = Infinity;
          continue;
        }
        model.T[i * 3 + c] = res.T;
        model.A[i * 3 + c] = res.A;
        model.Tstd[i * 3 + c] = res.Tstd;
        model.Astd[i * 3 + c] = res.Astd;
        // Residual against every observation.
        for (let k = 0; k < nObs; k++) {
          sampleBg(k, x, y, bg);
          const pred = res.T * bg[c] + res.A;
          const d = obs[k].data[i * 3 + c] - pred;
          rss += d * d;
        }
      }
      // Identifiability gate. Rather than a fixed spread cutoff (arbitrary and
      // scale-dependent), mark a channel UNDETERMINED only when the estimated
      // transmittance uncertainty exceeds a stated bound maxTstd. The noise
      // floor (sigmaFloor, default one 8-bit step) is applied inside
      // solveChannel so Tstd cannot vanish on noise-free synthetic data.
      for (let c = 0; c < 3; c++) {
        if (
          model.channelStatus[i * 3 + c] === STATUS.OK ||
          model.channelStatus[i * 3 + c] === STATUS.CLAMPED
        ) {
          if (!(model.Tstd[i * 3 + c] <= maxTstd)) {
            model.channelStatus[i * 3 + c] = STATUS.UNDETERMINED;
            model.T[i * 3 + c] = NaN;
            model.A[i * 3 + c] = NaN;
            model.Tstd[i * 3 + c] = Infinity;
            model.Astd[i * 3 + c] = Infinity;
            if (STATUS.UNDETERMINED > worst) worst = STATUS.UNDETERMINED;
          }
        }
      }
      model.status[i] = worst;
      model.residualRms[i] = Math.sqrt(rss / (3 * nObs));
      if (model.status[i] === STATUS.UNDETERMINED) {
        model.T[i * 3] = model.T[i * 3 + 1] = model.T[i * 3 + 2] = NaN;
        model.A[i * 3] = model.A[i * 3 + 1] = model.A[i * 3 + 2] = NaN;
      }
    }
  }
  return model;
}

// Pooled fit over a set of pixels/channels, used only to score candidate
// offsets. Per-pixel T/A are too flexible to identify d; pooling across a
// tile (shared T,A in the score) ties the offset to spatial consistency.
export function pooledScore(obs, backgrounds, shifts, pixels, dx, dy, width, height, maxA) {
  const nObs = obs.length;
  const sums = [];
  for (let c = 0; c < 3; c++) {
    sums.push({ N: 0, Sb2: 0, Sb: 0, So: 0, Sbo: 0, Soo: 0 });
  }
  const bg = [0, 0, 0];
  for (const [x, y] of pixels) {
    const i = y * width + x;
    for (let k = 0; k < nObs; k++) {
      const s = shifts[k];
      backgrounds[k].sampleBilinear(x, y, s.dx + dx, s.dy + dy, bg);
      for (let c = 0; c < 3; c++) {
        const b = bg[c];
        const o = obs[k].data[i * 3 + c];
        const q = sums[c];
        q.N += 1;
        q.Sb2 += b * b;
        q.Sb += b;
        q.So += o;
        q.Sbo += b * o;
        q.Soo += o * o;
      }
    }
  }
  let total = 0;
  for (let c = 0; c < 3; c++) {
    const res = solveChannel(sums[c], { noiseVar: 0, maxA });
    if (res.T == null) {
      total += sums[c].Soo; // undetermined: use zero-fit score
    } else {
      total += sseAt(res.T, res.A, sums[c]);
    }
  }
  return total;
}
