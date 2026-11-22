// Built-in synthetic scenes with ground truth. Shared by the browser UI and
// the CLI so both can produce identical samples and references.
//
// Each scene has:
//   - K observations of the same fixed object over known background plates
//   - a matching bare background plate for each observation
//   - a held-out new background and a reference composite (true fields)
//   - ground-truth T / A and a checksum of the reference
//
// The reference composite is computed from the true optical fields, never
// cropped from an observation or plate.

import { LinearImage } from './image.js';
import {
  makeBackground,
  makeGlassFields,
  roundedRectMask,
  renderObservation,
  renderReference,
  checksum,
  scoreAgainstTruth,
} from './synth.js';

function maskImageFrom(mask, width, height) {
  const img = new LinearImage(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = mask[i] ? 0.8 : 0.05;
    img.data[i * 3] = v;
    img.data[i * 3 + 1] = v;
    img.data[i * 3 + 2] = v;
  }
  return img;
}

export const SCENES = {
  basic: {
    description:
      'Two distinct backgrounds (checker + gradient): a well-conditioned pair. Transmission and additive reflection are separable almost everywhere.',
    size: 128,
    mask: [32, 18, 96, 110, 16],
    backgrounds: ['checker', 'gradient'],
    shifts: [{ dx: 0, dy: 0 }, { dx: 1, dy: -1 }],
    gains: [1, 1.04],
    glass: {},
    newBackground: 'dots',
    includeOffset: false,
  },
  threeway: {
    description:
      'Three varied backgrounds. More observations add redundancy and let the residual check catch a bad frame, but do not by themselves model refraction.',
    size: 128,
    mask: [30, 20, 98, 108, 18],
    backgrounds: ['checker', 'gradient', 'stripes'],
    shifts: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }],
    gains: [1, 0.98, 1.03],
    glass: { reflectionLevel: 0.18 },
    newBackground: 'spectrum',
    includeOffset: false,
  },
  degenerate: {
    description:
      'Two nearly identical backgrounds. Locally the system is rank deficient, so large areas must be left UNDETERMINED. This scene exists to show the tool refusing to guess.',
    size: 128,
    mask: [32, 18, 96, 110, 16],
    backgrounds: ['gradient', 'gradient'],
    shifts: [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }],
    gains: [1, 1],
    glass: {},
    newBackground: 'checker',
    includeOffset: false,
    samePlateVariant: true,
  },
  refraction: {
    description:
      'The object refracts the background (radial coordinate offset). Turning on the declared offset model helps but cannot fully express real refraction; residuals stay high near the rim.',
    size: 128,
    mask: [32, 18, 96, 110, 16],
    backgrounds: ['checker', 'spectrum', 'stripes'],
    shifts: [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }],
    gains: [1, 1, 1],
    glass: { refraction: 8 },
    newBackground: 'dots',
    includeOffset: true,
  },
  drifting: {
    description:
      'The object moved slightly between the second and third shots. Consistency checks should flag it; the shared T/A fields cannot explain all frames.',
    size: 128,
    mask: [32, 18, 96, 110, 16],
    backgrounds: ['checker', 'gradient', 'stripes'],
    shifts: [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }],
    gains: [1, 1, 1],
    glass: {},
    newBackground: 'spectrum',
    includeOffset: false,
    objectShiftLast: { dx: 4, dy: 2 },
  },
};

export function listScenes() {
  return Object.entries(SCENES).map(([name, s]) => ({
    name,
    description: s.description,
    observations: s.backgrounds.length,
    includeOffset: s.includeOffset,
  }));
}

export function generateScene(name) {
  const spec = SCENES[name];
  if (!spec) throw new Error(`unknown scene: ${name}`);
  const W = spec.size;
  const H = spec.size;
  const mask = roundedRectMask(W, H, ...spec.mask);
  const fields = makeGlassFields(W, H, mask, spec.glass);
  const backgrounds = spec.backgrounds.map((kind, k, arr) => ({
    // degenerate scene intentionally reuses one plate content
    image: makeBackground(kind, W, H, spec.samePlateVariant ? 900 : 100 + k),
    label: `${kind} #${k + 1}`,
    kind,
  }));
  const observations = backgrounds.map((bg, k) => ({
    image: renderObservation(fields, bg.image, mask, W, H, {
      shift: spec.shifts[k],
      gain: spec.gains[k],
      seed: 40 + k,
      useOffset: spec.includeOffset,
      objectShift: k === backgrounds.length - 1 && spec.objectShiftLast ? spec.objectShiftLast : { dx: 0, dy: 0 },
    }),
    label: `shot ${k + 1} over ${bg.label}`,
  }));
  const newBackground = makeBackground(spec.newBackground, W, H, 707);
  const reference = renderReference(fields, newBackground, mask, W, H, spec.includeOffset);

  return {
    name,
    width: W,
    height: H,
    description: spec.description,
    mask,
    maskImage: maskImageFrom(mask, W, H),
    fields,
    backgrounds,
    observations,
    newBackground,
    newBackgroundKind: spec.newBackground,
    reference,
    includeOffset: spec.includeOffset,
    truthSummary: summarizeTruth(fields, mask, W, H),
    modelNotes: modelNotes(spec),
  };
}

// Pack the true fields for transport so a client can render a reference for
// any chosen new background (not only the scene's default held-out one).
// Float64 -> Float32 is enough for display/ground-truth comparison.
export function truthFieldsPayload(fields, width, height) {
  return {
    T: Buffer.from(Float32Array.from(fields.T).buffer).toString('base64'),
    A: Buffer.from(Float32Array.from(fields.A).buffer).toString('base64'),
    offset: Buffer.from(Float32Array.from(fields.offset).buffer).toString('base64'),
  };
}

function summarizeTruth(fields, mask, W, H) {
  let n = 0;
  const t = [0, 0, 0];
  const a = [0, 0, 0];
  const tmin = [Infinity, Infinity, Infinity];
  const tmax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    n++;
    for (let c = 0; c < 3; c++) {
      t[c] += fields.T[i * 3 + c];
      a[c] += fields.A[i * 3 + c];
      tmin[c] = Math.min(tmin[c], fields.T[i * 3 + c]);
      tmax[c] = Math.max(tmax[c], fields.T[i * 3 + c]);
    }
  }
  return {
    pixels: n,
    meanT: t.map((v) => v / Math.max(1, n)),
    meanA: a.map((v) => v / Math.max(1, n)),
    minT: tmin,
    maxT: tmax,
    chromatic: fields.chromatic,
    reflectionLevel: fields.reflectionLevel,
    refraction: fields.refraction,
  };
}

function modelNotes(spec) {
  const notes = [
    'Model: O_k = T * B_k(x + s_k + d) + A.',
    'T is per-channel transmittance (chromatic attenuation); A is an additive, background-independent reflection term.',
  ];
  if (spec.includeOffset) {
    notes.push(
      'Background coordinate offset d is enabled as a per-tile translation. This is a coarse proxy for refraction and does not model curvature, caustics or dispersion.'
    );
  } else {
    notes.push(
      'Background coordinate offset is NOT part of this scene\'s model; any refraction in the object cannot be represented and will appear in the residuals.'
    );
  }
  if (spec.objectShiftLast) {
    notes.push('The last shot has the object displaced. A fixed-object model should flag it.');
  }
  if (spec.samePlateVariant) {
    notes.push(
      'Both plates are the same image, so T and A cannot be separated locally; expect a large UNDETERMINED region.'
    );
  }
  return notes;
}

export { scoreAgainstTruth, checksum };
