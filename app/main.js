// Glass Compositing Lab — graphical entry point.
//
// All estimation runs in the browser via the shared core modules under /src/.
// The server is only used to deliver the built-in synthetic scenes (with ground
// truth) so the interface can be exercised immediately.

import { LinearImage } from '/src/core/image.js';
import { makeBackground } from '/src/core/synth.js';
import { estimateScene, STATUS } from '/src/core/pipeline.js';
import { composite, componentImages, reconstruct, residualStats, referenceFromFields } from '/src/core/composite.js';
import { maskedNccShift } from '/src/core/align.js';

const state = {
  scene: null, // loaded scene spec with PNG data
  width: 0,
  height: 0,
  observations: [], // LinearImage
  backgrounds: [], // LinearImage
  mask: null, // Uint8Array (0/1)
  maskCanvas: null, // offscreen 1-channel display
  brush: { size: 18, erase: false },
  activeObs: 0,
  result: null,
  newBgKind: 'dots',
  newBg: null,
  useOffset: false,
  truth: null,
  reference: null,
  lastEstimateKey: '',
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Image decoding helpers (PNG base64 -> LinearImage)
// ---------------------------------------------------------------------------
function decodePngBase64(b64) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      resolve({ rgba: data, width: c.width, height: c.height });
    };
    img.onerror = () => reject(new Error('failed to decode PNG'));
    img.src = `data:image/png;base64,${b64}`;
  });
}

function linearFromRgbaView(rgba, width, height) {
  const out = new LinearImage(width, height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    out.data[i * 3] = srgbToLinearChannel(rgba[p]);
    out.data[i * 3 + 1] = srgbToLinearChannel(rgba[p + 1]);
    out.data[i * 3 + 2] = srgbToLinearChannel(rgba[p + 2]);
  }
  return out;
}

function srgbToLinearChannel(v) {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function decodeTruthFields(payload) {
  if (!payload) return null;
  const decode = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  };
  return { T: decode(payload.T), A: decode(payload.A), offset: decode(payload.offset) };
}

// Draw a LinearImage (possibly with NaN) into a canvas at display size.
function drawLinear(canvas, img, { nanColor = [255, 91, 208], fallback = '#0b0e12' } = {}) {
  const ctx = canvas.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = img.width;
  tmp.height = img.height;
  const tctx = tmp.getContext('2d');
  const out = tctx.createImageData(img.width, img.height);
  for (let i = 0, n = img.width * img.height; i < n; i++) {
    const r = img.data[i * 3];
    const g = img.data[i * 3 + 1];
    const b = img.data[i * 3 + 2];
    const p = i * 4;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      out.data[p] = nanColor[0];
      out.data[p + 1] = nanColor[1];
      out.data[p + 2] = nanColor[2];
      out.data[p + 3] = 255;
    } else {
      out.data[p] = toByte(r);
      out.data[p + 1] = toByte(g);
      out.data[p + 2] = toByte(b);
      out.data[p + 3] = 255;
    }
  }
  tctx.putImageData(out, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = fallback;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}

function toByte(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

// Draw observation with the selection overlay tinted.
function drawObservationWithMask(canvas, img, mask, width, height) {
  const ctx = canvas.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext('2d');
  const out = tctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    out.data[p] = toByte(img.data[i * 3]);
    out.data[p + 1] = toByte(img.data[i * 3 + 1]);
    out.data[p + 2] = toByte(img.data[i * 3 + 2]);
    if (mask[i]) {
      out.data[p] = Math.round(out.data[p] * 0.55 + 20);
      out.data[p + 1] = Math.round(out.data[p + 1] * 0.75 + 30);
      out.data[p + 2] = Math.round(out.data[p + 2] * 0.75 + 90);
    }
    out.data[p + 3] = 255;
  }
  tctx.putImageData(out, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}

// Residual visualisation: per-pixel |O_k - recon_k| as a heat map.
function drawResidual(canvas, observations, recon, width, height) {
  const ctx = canvas.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext('2d');
  const out = tctx.createImageData(width, height);
  const nObs = observations.length;
  for (let i = 0; i < width * height; i++) {
    let sum = 0;
    let bad = false;
    for (let k = 0; k < nObs; k++) {
      for (let c = 0; c < 3; c++) {
        const d = observations[k].data[i * 3 + c] - recon[k].data[i * 3 + c];
        if (!Number.isFinite(d)) { bad = true; break; }
        sum += d * d;
      }
      if (bad) break;
    }
    const p = i * 4;
    if (bad) {
      out.data[p] = 255; out.data[p + 1] = 91; out.data[p + 2] = 208; out.data[p + 3] = 255;
      continue;
    }
    const rms = Math.sqrt(sum / (3 * nObs));
    // heat scale: 0 -> dark, 0.05 -> orange, 0.2 -> hot
    const t = Math.min(1, rms / 0.12);
    const [r, g, b] = heat(t);
    out.data[p] = r; out.data[p + 1] = g; out.data[p + 2] = b; out.data[p + 3] = 255;
  }
  tctx.putImageData(out, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}

function heat(t) {
  // simple black -> red -> yellow -> white ramp
  if (t < 0.5) {
    const u = t / 0.5;
    return [Math.round(120 * u + 20), Math.round(20 + 40 * u), Math.round(30 + 20 * u)];
  }
  const u = (t - 0.5) / 0.5;
  return [Math.round(140 + 115 * u), Math.round(60 + 195 * u), Math.round(50 + 205 * u)];
}

// ---------------------------------------------------------------------------
// Scene loading
// ---------------------------------------------------------------------------
async function loadSceneList() {
  const res = await fetch('/api/scenes');
  const { scenes } = await res.json();
  const sel = $('scene-select');
  sel.innerHTML = '';
  for (const s of scenes) {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `${s.name} — ${s.observations} backgrounds${s.includeOffset ? ' · offset' : ''}`;
    sel.appendChild(opt);
  }
}

async function loadScene(name) {
  const res = await fetch(`/api/scene?name=${encodeURIComponent(name)}`);
  const spec = await res.json();
  const width = spec.width;
  const height = spec.height;

  const decode = async (b64) => {
    const { rgba } = await decodePngBase64(b64);
    return linearFromRgbaView(rgba, width, height);
  };

  const observations = [];
  for (const o of spec.observations) observations.push(await decode(o.png));
  const backgrounds = [];
  for (const b of spec.backgrounds) backgrounds.push(await decode(b.png));
  const newBg = await decode(spec.newBackgroundPng);
  const reference = await decode(spec.referencePng);
  const maskImg = await decode(spec.maskPng);

  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = maskImg.data[i * 3] > 0.4 ? 1 : 0;
  }

  state.scene = spec;
  state.width = width;
  state.height = height;
  state.observations = observations;
  state.backgrounds = backgrounds;
  state.mask = mask;
  state.activeObs = 0;
  state.result = null;
  state.newBg = newBg;
  state.reference = reference;
  state.truth = spec.truth;
  state.useOffset = !!spec.includeOffset;
  $('use-offset').checked = state.useOffset;
  // Decode ground-truth fields so the reference can be rendered for any chosen
  // new background, not only the scene's default held-out one.
  state.truthFields = decodeTruthFields(spec.truthFields);

  // Sync the new-background selector to the scene's declared held-out plate.
  if (spec.newBackgroundKind) {
    state.newBgKind = spec.newBackgroundKind;
    $('newbg-select').value = spec.newBackgroundKind;
  }

  $('obs-count').textContent = String(observations.length);
  $('estimate').disabled = false;

  buildTabs();
  renderObservation();
  renderNewBackground();
  renderReference();
  clearEstimatePanels();
  renderChecksPlaceholder();
  $('compare-note').textContent =
    'Estimate to compare the predicted composite against the ground-truth reference.';
  $('compare-kv').innerHTML = '';
}

function buildTabs() {
  const tabs = $('obs-tabs');
  tabs.innerHTML = '';
  state.observations.forEach((_, k) => {
    const b = document.createElement('button');
    b.textContent = `Shot ${k + 1} · ${state.scene.backgrounds[k].label}`;
    if (k === state.activeObs) b.classList.add('active');
    b.onclick = () => {
      state.activeObs = k;
      buildTabs();
      renderObservation();
    };
    tabs.appendChild(b);
  });
}

function renderObservation() {
  if (!state.observations.length) return;
  drawObservationWithMask(
    $('obs-canvas'),
    state.observations[state.activeObs],
    state.mask,
    state.width,
    state.height
  );
}

function renderNewBackground() {
  if (!state.newBg) return;
  drawLinear($('composite-canvas'), state.newBg);
  // The composite canvas is overwritten once an estimate exists.
}

function renderReference() {
  if (!state.truthFields) {
    if (state.reference) drawLinear($('reference-canvas'), state.reference);
    return;
  }
  renderReferenceForChosenBg();
}

function clearEstimatePanels() {
  for (const id of ['c-transmission', 'c-reflection', 'c-bgterm', 'c-residual']) {
    const c = $(id);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0b0e12';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  $('ident-kv').innerHTML = '';
  $('warnings').innerHTML = '';
  $('resolved-bar').style.width = '0%';
  $('resolved-text').textContent = '—';
}

// ---------------------------------------------------------------------------
// Painting the selection
// ---------------------------------------------------------------------------
let painting = false;
function setupPainting() {
  const canvas = $('obs-canvas');
  const paintAt = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((clientX - rect.left) / rect.width) * state.width);
    const y = Math.floor(((clientY - rect.top) / rect.height) * state.height);
    const r = state.brush.size / 2;
    const r2 = r * r;
    const val = state.brush.erase ? 0 : 1;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
        state.mask[ny * state.width + nx] = val;
      }
    }
    renderObservation();
  };
  canvas.addEventListener('pointerdown', (e) => {
    painting = true;
    canvas.setPointerCapture(e.pointerId);
    paintAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (painting) paintAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerup', () => { painting = false; });
  canvas.addEventListener('pointercancel', () => { painting = false; });

  $('brush-mode').onclick = () => {
    state.brush.erase = false;
    $('brush-mode').classList.add('active');
    $('erase-mode').classList.remove('active');
  };
  $('erase-mode').onclick = () => {
    state.brush.erase = true;
    $('erase-mode').classList.add('active');
    $('brush-mode').classList.remove('active');
  };
  $('brush-size').oninput = (e) => { state.brush.size = Number(e.target.value); };
  $('clear-mask').onclick = () => {
    state.mask.fill(0);
    renderObservation();
  };
  $('fill-mask').onclick = () => {
    // Fill the current selection's bounding region with a generous disc; a
    // convenience for the sample scenes, not an automatic segmentation claim.
    if (!state.scene) return;
    const spec = state.scene;
    // Use the scene's recorded mask if available on next estimate; here just
    // fill the central rounded area using the same mask included in the scene.
    refillSceneMask();
  };
}

async function refillSceneMask() {
  // The server delivered a mask with the scene; reuse it for "fill body".
  if (!state._sceneMaskPng) return;
  const width = state.width;
  const height = state.height;
  const { rgba } = await decodePngBase64(state._sceneMaskPng);
  for (let i = 0; i < width * height; i++) {
    state.mask[i] = srgbToLinearChannel(rgba[i * 4]) > 0.15 ? 1 : 0;
  }
  renderObservation();
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------
function estimate() {
  if (!state.scene) return;
  const width = state.width;
  const height = state.height;
  const observations = state.observations.map((image) => ({ image }));
  const backgrounds = state.backgrounds.map((image) => ({ image }));

  const result = estimateScene({
    observations,
    backgrounds,
    mask: state.mask,
    width,
    height,
    options: {
      includeOffset: state.useOffset,
      tileSize: 48,
      alignRadius: 3,
    },
  });
  state.result = result;

  showChecks(result);
  showWarnings(result);
  showComponents(result);
  showIdentifiability(result);
  showComposite(result);
}

function showChecks(result) {
  const el = $('checks');
  const rows = result.checks.map((c) => {
    const cls = c.ok ? 'ok' : 'warn';
    const ncc = Number.isFinite(c.ncc) ? c.ncc.toFixed(3) : 'n/a';
    const gain = Number.isFinite(c.gain) ? c.gain.toFixed(3) : 'n/a';
    return `<div class="check-item ${cls}">
      <span class="badge"></span>
      <span>Shot ${c.k + 1} · alignment &amp; exposure</span>
      <span class="detail">ncc ${ncc} · gain ${gain} · shift ${c.shift.dx},${c.shift.dy}</span>
    </div>`;
  });
  const summary = result.checks.summary;
  let summaryHtml = '';
  if (summary) {
    summaryHtml = `<div class="check-item ${summary.gainSpread > 0.08 ? 'warn' : 'ok'}">
      <span class="badge"></span>
      <span>Across shots</span>
      <span class="detail">gain spread ${summary.gainSpread.toFixed(3)} · max shift ${summary.maxShift.toFixed(2)}px</span>
    </div>`;
  }
  const objectRows = [];
  if (result.diagnostics.perObservationResidualRms?.length > 1) {
    const ratio = result.diagnostics.residualRatio;
    const cls = ratio > 3 ? 'warn' : 'ok';
    objectRows.push(`<div class="check-item ${cls}">
      <span class="badge"></span>
      <span>One fixed object explains all shots</span>
      <span class="detail">worst residual ×${ratio.toFixed(2)}</span>
    </div>`);
  }
  const res = `<div class="check-item ${result.diagnostics.resolvedFraction > 0.5 ? 'ok' : 'warn'}">
    <span class="badge"></span>
    <span>Local rank (backgrounds differ enough)</span>
    <span class="detail">${(result.diagnostics.resolvedFraction * 100).toFixed(1)}% resolved</span>
  </div>`;
  el.innerHTML = `<h3>Consistency checks</h3>${rows.join('')}${summaryHtml}${objectRows.join('')}${res}`;
}

function showWarnings(result) {
  const el = $('warnings');
  const rank = { OBS_INCONSISTENT: 'bad', OBJECT_MISALIGNED: 'bad', OBS_VARIATION: 'bad', LOW_IDENTIFIABILITY: 'warn', EMPTY_MASK: 'warn' };
  el.innerHTML = result.warnings
    .map((w) => {
      const cls = w.code === 'MODEL_SCOPE' ? 'info' : rank[w.code] || 'warn';
      return `<div class="warning ${cls}"><span class="wcode">${w.code}</span>${escapeHtml(w.message)}</div>`;
    })
    .join('');
}

function showComponents(result) {
  const { model } = result;
  const comps = componentImages(model, state.newBg, { useOffset: state.useOffset });
  drawLinear($('c-transmission'), comps.tint);
  drawLinear($('c-reflection'), comps.reflection);
  drawLinear($('c-bgterm'), comps.backgroundTerm);

  const sampleBgForObs = (k, x, y, out) => {
    const s = result.shifts[k];
    let dx = s.dx;
    let dy = s.dy;
    if (state.useOffset) {
      const tile = result.diagnostics.tileSize;
      const t = result.diagnostics.tileOffsets.find(
        (tt) => x >= tt.tx && x < tt.tx + tile && y >= tt.ty && y < tt.ty + tile
      );
      if (t) { dx += t.dx; dy += t.dy; }
    }
    result.normalize.normBg[k].sampleBilinear(x, y, dx, dy, out);
  };
  const { recon } = reconstruct(
    model,
    result.normalize.normObs,
    sampleBgForObs,
    state.width,
    state.height
  );
  drawResidual($('c-residual'), result.normalize.normObs, recon, state.width, state.height);
}

function showIdentifiability(result) {
  const d = result.diagnostics;
  const pct = d.resolvedFraction * 100;
  $('resolved-bar').style.width = `${pct.toFixed(1)}%`;
  $('resolved-text').textContent = `${pct.toFixed(1)}% of selection identifiable`;
  const rows = [
    ['Selected pixels', d.selectedPixels],
    ['Resolved (interior/clamped)', d.resolvedPixels],
    ['Undetermined', d.undeterminedPixels],
    ['Mean background spread', d.meanBackgroundSpread.toFixed(4)],
    ['Mean residual RMS', d.meanResidualRms.toFixed(4)],
  ];
  if (state.truth) {
    rows.push(['Truth mean T', fmtTriple(state.truth.meanT)]);
    rows.push(['Truth mean A', fmtTriple(state.truth.meanA)]);
  }
  $('ident-kv').innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join('');
}

function showComposite(result) {
  const comp = composite(result.model, state.newBg, { useOffset: state.useOffset });
  drawLinear($('composite-canvas'), comp.image);

  // Compare against ground-truth reference where the model resolved.
  const compareKv = $('compare-kv');
  const note = $('compare-note');
  if (!state.reference) {
    compareKv.innerHTML = '';
    note.textContent = 'No ground-truth reference for this background.';
    return;
  }
  const resolvedMask = new Uint8Array(state.width * state.height);
  let resolvedCount = 0;
  let undetermined = 0;
  for (let i = 0; i < state.width * state.height; i++) {
    const st = result.model.status[i];
    if (st === STATUS.OK || st === STATUS.CLAMPED) { resolvedMask[i] = 1; resolvedCount++; }
    if (st === STATUS.UNDETERMINED || st === STATUS.NO_SOLUTION) undetermined++;
  }
  const stats = residualStats(comp.image, state.reference, state.width, state.height, resolvedMask);
  const fmtNum = (v) => (Number.isFinite(v) ? v.toFixed(4) : 'n/a');
  const rows = [
    ['Resolved pixels compared', stats.pixels],
    ['Composite RMS (linear)', fmtNum(stats.rms)],
    ['Max abs error', fmtNum(stats.maxAbs)],
    ['Per-channel RMS', stats.perChannelRms.map(fmtNum).join(' / ')],
    ['Unresolved pixels (not scored)', undetermined],
  ];
  compareKv.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
  if (stats.pixels === 0) {
    note.textContent =
      'Nothing was resolved, so there is no prediction to compare. The model cannot separate ' +
      'transmission from reflection with these backgrounds; that is shown rather than hidden.';
  } else {
    note.textContent =
      'A low residual means the declared model fits this held-out background. It does NOT prove the ' +
      'real material parameters are uniquely known; see the warnings for what the model cannot represent.';
  }
}

function fmtTriple(a) {
  return `(${a.map((v) => v.toFixed(2)).join(', ')})`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderChecksPlaceholder() {
  $('checks').innerHTML =
    '<h3>Consistency checks</h3><p class="muted">Estimate to run alignment, exposure and identifiability checks.</p>';
}

// ---------------------------------------------------------------------------
// New background selection
// ---------------------------------------------------------------------------
function makeNewBg(kind) {
  const W = state.width;
  const H = state.height;
  if (kind === 'flat-light') return LinearImage.solid(W, H, 0.82, 0.82, 0.82);
  if (kind === 'flat-dark') return LinearImage.solid(W, H, 0.08, 0.09, 0.11);
  const seed = 700 + kind.length;
  return makeBackground(kind, W, H, seed);
}

function onNewBgChange() {
  state.newBgKind = $('newbg-select').value;
  state.newBg = makeNewBg(state.newBgKind);
  renderReference();
  if (state.result) {
    showComponents(state.result);
    showComposite(state.result);
  } else {
    drawLinear($('composite-canvas'), state.newBg);
  }
}

function renderReferenceForChosenBg() {
  if (!state.truthFields) return;
  // Ground truth always includes the object's real coordinate offset (if the
  // scene has any), regardless of whether the *model* declares offset.
  const truthUsesOffset = !!state.scene?.includeOffset;
  const ref = referenceFromFields(
    state.truthFields.T,
    state.truthFields.A,
    state.truthFields.offset,
    state.mask,
    state.newBg,
    state.width,
    state.height,
    truthUsesOffset
  );
  state.reference = ref;
  drawLinear($('reference-canvas'), ref);
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
async function init() {
  await loadSceneList();
  setupPainting();

  $('load-scene').onclick = async () => {
    const name = $('scene-select').value;
    await loadScene(name);
    // Stash the delivered mask for "fill body".
    state._sceneMaskPng = state.scene.maskPng;
  };

  $('estimate').onclick = estimate;

  $('newbg-select').onchange = onNewBgChange;

  $('use-offset').onchange = (e) => {
    state.useOffset = e.target.checked;
    if (state.result) estimate();
  };

  // Load the default scene immediately.
  await loadScene($('scene-select').value);
  state._sceneMaskPng = state.scene.maskPng;
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="warning bad" style="margin:20px">Failed to initialise: ${escapeHtml(err.message)}</div>`
  );
});

// Expose a few internals for debugging in the console (not used by the UI).
window.__glassLab = { state, estimateScene, composite };
