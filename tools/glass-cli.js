#!/usr/bin/env node
// Command-line helper for the glass compositing lab.
//
// The graphical interface (app/index.html, served by tools/serve.js) is the
// primary entry point. This CLI is a convenience for batch export/estimation
// and for running the same checks headlessly. See docs/GLASS_COMPOSITING.md.
//
// Commands:
//   synth    [--scene basic|threeway|degenerate|refraction|drifting|all] [--out DIR]
//   estimate --obs A.png,B.png --bg A0.png,B0.png --mask M.png [--out DIR]
//            [--newbg N.png] [--offset]
//   check    --obs ... --bg ... --mask M.png
//
// All pixels are read as sRGB 8-bit and processed in linear light.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { LinearImage } from '../src/core/image.js';
import { estimateScene, STATUS } from '../src/core/pipeline.js';
import {
  composite,
  componentImages,
  reconstruct,
  referenceFromFields,
  residualStats,
} from '../src/core/composite.js';
import { generateScene, listScenes, truthFieldsPayload } from '../src/core/scenes.js';
import { makeBackground } from '../src/core/synth.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readPng(path) {
  return readFile(path).then((buf) => {
    const png = PNG.sync.read(buf);
    return LinearImage.fromSrgbBytes(png.data, png.width, png.height);
  });
}

function writePng(path, img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.toSrgbBytes());
  return writeFile(path, PNG.sync.write(png));
}

function maskFromImage(img) {
  const mask = new Uint8Array(img.width * img.height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = img.data[i * 3] > 0.18 ? 1 : 0;
  }
  return mask;
}

async function synth(args) {
  const outDir = join(args.out || 'out/synth');
  await mkdir(outDir, { recursive: true });
  const wanted = (args.scene || 'all') === 'all' ? listScenes().map((s) => s.name) : [args.scene];
  for (const name of wanted) {
    const scene = generateScene(name);
    const dir = join(outDir, name);
    await mkdir(dir, { recursive: true });
    const manifest = {
      scene: name,
      width: scene.width,
      height: scene.height,
      description: scene.description,
      includeOffset: scene.includeOffset,
      modelNotes: scene.modelNotes,
      truth: scene.truthSummary,
      observations: [],
      backgrounds: [],
    };
    for (let k = 0; k < scene.observations.length; k++) {
      const f = join(dir, `obs_${k + 1}.png`);
      await writePng(f, scene.observations[k].image);
      manifest.observations.push(f);
    }
    for (let k = 0; k < scene.backgrounds.length; k++) {
      const f = join(dir, `bg_${k + 1}.png`);
      await writePng(f, scene.backgrounds[k].image);
      manifest.backgrounds.push(f);
    }
    await writePng(join(dir, 'mask.png'), scene.maskImage);
    await writePng(join(dir, 'new_background.png'), scene.newBackground);
    await writePng(join(dir, 'reference.png'), scene.reference);
    // Ground truth for scoring, not for compositing.
    await writeFile(
      join(dir, 'truth.json'),
      JSON.stringify(
        {
          ...manifest,
          truthFields: truthFieldsPayload(scene.fields, scene.width, scene.height),
          referenceChecksumNote:
            'reference.png is recomputed from the true fields and the new background; it is not a crop of any observation or plate.',
        },
        null,
        2
      )
    );
    console.log(`wrote ${dir}/ (${scene.observations.length} observations, ${scene.backgrounds.length} plates)`);
  }
}

async function loadInputs(args) {
  const obsPaths = String(args.obs || '').split(',').filter(Boolean);
  const bgPaths = String(args.bg || '').split(',').filter(Boolean);
  if (obsPaths.length === 0 || bgPaths.length !== obsPaths.length) {
    throw new Error('need --obs a.png,b.png and a matching --bg a0.png,b0.png');
  }
  if (!args.mask) throw new Error('need --mask mask.png');
  const observations = [];
  for (const p of obsPaths) observations.push({ image: await readPng(p), label: p });
  const backgrounds = [];
  for (const p of bgPaths) backgrounds.push({ image: await readPng(p), label: p });
  const maskImg = await readPng(args.mask);
  const width = maskImg.width;
  const height = maskImg.height;
  for (const o of [...observations, ...backgrounds]) {
    if (o.image.width !== width || o.image.height !== height) {
      throw new Error(`size mismatch: ${o.label} is ${o.image.width}x${o.image.height}, mask is ${width}x${height}`);
    }
  }
  return { observations, backgrounds, mask: maskFromImage(maskImg), width, height };
}

function report(result) {
  console.log('— consistency —');
  for (const c of result.checks) {
    console.log(
      `  shot ${c.k + 1}: ncc=${fmt(c.ncc)} gain=${fmt(c.gain)} inliers=${fmt(c.inliers)} shift=(${c.shift.dx},${c.shift.dy}) ${c.ok ? 'ok' : 'CHECK'}`
    );
  }
  if (result.checks.summary) {
    const s = result.checks.summary;
    console.log(`  summary: gain spread=${fmt(s.gainSpread)} max shift=${fmt(s.maxShift)}`);
  }
  console.log('— diagnostics —');
  const d = result.diagnostics;
  console.log(`  selected=${d.selectedPixels} resolved=${d.resolvedPixels} undetermined=${d.undeterminedPixels} (${(d.resolvedFraction * 100).toFixed(1)}%)`);
  console.log(`  mean background spread=${fmt(d.meanBackgroundSpread)} mean residual RMS=${fmt(d.meanResidualRms)}`);
  if (d.perObservationResidualRms?.length > 1) {
    console.log(`  per-observation residual: ${d.perObservationResidualRms.map((v) => fmt(v)).join(', ')} (worst ×${fmt(d.residualRatio)})`);
  }
  if (d.tileOffsets?.length) {
    const accepted = d.tileOffsets.filter((t) => t.accepted).length;
    console.log(`  offset tiles: ${accepted}/${d.tileOffsets.length} accepted`);
  }
  console.log('— warnings —');
  for (const w of result.warnings) console.log(`  [${w.code}] ${w.message}`);
}

async function estimate(args) {
  const inputs = await loadInputs(args);
  const result = estimateScene({
    ...inputs,
    options: { includeOffset: !!args.offset },
  });
  report(result);

  const outDir = join(args.out || 'out/estimate');
  await mkdir(outDir, { recursive: true });
  const newBg = args.newbg ? await readPng(args.newbg) : makeBackground('dots', inputs.width, inputs.height, 99);
  const comps = componentImages(result.model, newBg, { useOffset: !!args.offset });
  await writePng(join(outDir, 'transmission.png'), comps.tint);
  await writePng(join(outDir, 'reflection.png'), comps.reflection);
  await writePng(join(outDir, 'background_term.png'), comps.backgroundTerm);
  const comp = composite(result.model, newBg, { useOffset: !!args.offset });
  await writePng(join(outDir, 'composite.png'), comp.image);

  // Validity mask: white where the model resolved a value, black where it left
  // the pixel undetermined (those are written as black in composite.png and
  // must not be scored as if they were predictions).
  const valid = new LinearImage(inputs.width, inputs.height);
  for (let i = 0; i < inputs.width * inputs.height; i++) {
    const st = result.model.status[i];
    const v = st === STATUS.OK || st === STATUS.CLAMPED ? 1 : 0;
    valid.data[i * 3] = valid.data[i * 3 + 1] = valid.data[i * 3 + 2] = v;
  }
  await writePng(join(outDir, 'resolved_mask.png'), valid);
  await writePng(join(outDir, 'new_background.png'), newBg);

  const sampleBg = (k, x, y, out) => {
    const s = result.shifts[k];
    let dx = s.dx;
    let dy = s.dy;
    if (args.offset) {
      const tile = result.diagnostics.tileSize;
      const t = result.diagnostics.tileOffsets.find(
        (tt) => x >= tt.tx && x < tt.tx + tile && y >= tt.ty && y < tt.ty + tile
      );
      if (t) { dx += t.dx; dy += t.dy; }
    }
    result.normalize.normBg[k].sampleBilinear(x, y, dx, dy, out);
  };
  const { recon } = reconstruct(result.model, result.normalize.normObs, sampleBg, inputs.width, inputs.height);
  for (let k = 0; k < recon.length; k++) {
    await writePng(join(outDir, `recon_${k + 1}.png`), recon[k]);
  }

  const rms = result.diagnostics.perObservationResidualRms.map((v) => fmt(v)).join(', ');
  await writeFile(
    join(outDir, 'report.json'),
    JSON.stringify(
      {
        warnings: result.warnings,
        checks: result.checks,
        diagnostics: result.diagnostics,
        unresolvedPixels: comp.unresolved.length,
        compositeNote:
          'composite.png is recomputed from estimated T, A and the new background; it is not a crop of any observation.',
        validityNote:
          'resolved_mask.png is white where T/A were resolved. Score composite.png against a reference only inside that mask; undetermined pixels are unknown, not predictions.',
        perObservationReconstructionRms: result.diagnostics.perObservationResidualRms,
      },
      null,
      2
    )
  );
  console.log(`wrote ${outDir}/ (composite, components, reconstructions, resolved_mask.png, report.json)`);
  console.log(`reconstruction RMS per shot: ${rms}`);
}

async function check(args) {
  const inputs = await loadInputs(args);
  const result = estimateScene({ ...inputs, options: { includeOffset: !!args.offset } });
  report(result);
  const bad = result.warnings.filter((w) =>
    ['OBS_INCONSISTENT', 'OBJECT_MISALIGNED', 'OBS_VARIATION', 'EMPTY_MASK'].includes(w.code)
  );
  process.exitCode = bad.length ? 2 : 0;
}

// Compare an estimated composite against a ground-truth reference, if present.
// By default only resolved pixels are scored; pass --mask resolved_mask.png
// explicitly, or --all to include every pixel (not recommended).
async function compare(args) {
  if (!args.pred || !args.ref) throw new Error('need --pred composite.png --ref reference.png');
  const pred = await readPng(args.pred);
  const ref = await readPng(args.ref);
  if (pred.width !== ref.width || pred.height !== ref.height) throw new Error('size mismatch');
  let mask = null;
  if (args.mask) mask = maskFromImage(await readPng(args.mask));
  else if (!args.all) {
    // Try to find a sibling resolved_mask.png next to the prediction.
    try {
      mask = maskFromImage(await readPng(join(dirname(args.pred), 'resolved_mask.png')));
    } catch {
      mask = null;
    }
  }
  const stats = residualStats(pred, ref, pred.width, pred.height, mask);
  console.log(JSON.stringify({ ...stats, scoredAllPixels: !mask }, null, 2));
  if (!mask) {
    console.error(
      'note: no resolved mask found; undetermined pixels are included. Pass --mask or place resolved_mask.png next to the prediction.'
    );
  }
}

function fmt(x) {
  return Number.isFinite(x) ? +x.toFixed(4) : String(x);
}

const USAGE = `glass-cli — command-line helper for the glass compositing lab.

The primary entry point is the graphical interface: run "npm run ui" and open
http://localhost:5173/ (see docs/GLASS_COMPOSITING.md).

Commands:
  synth     [--scene NAME|all] [--out DIR]
  estimate  --obs A.png,B.png --bg A0.png,B0.png --mask M.png [--newbg N.png] [--offset] [--out DIR]
  check     --obs ... --bg ... --mask M.png [--offset]
  compare   --pred composite.png --ref reference.png [--mask M.png]

Scenes: ${listScenes().map((s) => s.name).join(', ')}
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    if (cmd === 'synth') return await synth(args);
    if (cmd === 'estimate') return await estimate(args);
    if (cmd === 'check') return await check(args);
    if (cmd === 'compare') return await compare(args);
    console.log(USAGE);
    if (!cmd) process.exitCode = 1;
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
