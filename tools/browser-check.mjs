// Browser smoke test: loads the UI, runs an estimate, and captures screenshots.
// Not part of `npm test`; run with: node tools/browser-check.mjs
//
// It exercises the primary entry point end to end and then asserts the typed
// component contract from the page itself:
//   * the estimate exposes identifiable/degenerate regions,
//   * the composite canvas is recomputed and non-trivial,
//   * the composite run status lists the transparent product's contribution and
//     the transmitted background contribution separately, with anomaly counts,
//   * degenerate regions stay unknown (never silently transparent).
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const TARGET = process.env.URL || 'http://localhost:5173/';
const OUT = new URL('../screenshots/', import.meta.url);
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: process.env.CHROME_PATH || undefined,
  env: {
    ...process.env,
    LD_LIBRARY_PATH:
      process.env.LD_LIBRARY_PATH ||
      '/tmp/gllibs/root/usr/lib/aarch64-linux-gnu:/tmp/gllibs/root/lib/aarch64-linux-gnu',
  },
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const canvasNonBlack = (id) =>
  page.evaluate((canvasId) => {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlack = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 30) nonBlack++;
    return nonBlack;
  }, id);

await page.goto(TARGET, { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction(() => window.__glassLab && window.__glassLab.state.observations.length > 0, { timeout: 20000 });

const info = await page.evaluate(() => {
  const s = window.__glassLab.state;
  return {
    width: s.width,
    height: s.height,
    observations: s.observations.length,
    backgrounds: s.backgrounds.length,
    maskPixels: Array.from(s.mask).reduce((a, b) => a + b, 0),
    scene: s.scene.name,
  };
});
console.log('loaded', JSON.stringify(info));
assert.ok(info.observations >= 2, 'scene must ship at least two observations');

await page.click('#estimate');
await page.waitForFunction(() => window.__glassLab.state.result != null, { timeout: 30000 });

const result = await page.evaluate(() => {
  const r = window.__glassLab.state.result;
  const c = r.components;
  let identifiable = 0;
  let degenerate = 0;
  let unknownWithFiniteT = 0;
  const R = window.__glassLab.Region;
  for (let i = 0; i < c.region.length; i++) {
    if (c.region[i] === R.IDENTIFIABLE) {
      identifiable++;
      if (!Number.isFinite(c.T[i * 3]) || !Number.isFinite(c.A[i * 3])) unknownWithFiniteT++;
    } else if (c.region[i] === R.DEGENERATE) {
      degenerate++;
    }
  }
  return {
    resolved: r.diagnostics.resolvedPixels,
    undetermined: r.diagnostics.undeterminedPixels,
    fraction: r.diagnostics.resolvedFraction,
    warnings: r.warnings.map((w) => w.code),
    hasComponents: !!c && !!c.spec,
    componentCounts: c ? c.counts : null,
    identifiable,
    degenerate,
    unknownWithFiniteT,
  };
});
console.log('estimate', JSON.stringify(result));
assert.equal(result.hasComponents, true, 'estimate must expose typed components');
assert.equal(result.identifiable, result.componentCounts.identifiable, 'region counts must be consistent');
assert.equal(result.degenerate, result.componentCounts.degenerate, 'region counts must be consistent');
assert.equal(result.unknownWithFiniteT, 0, 'identifiable pixels must have finite T/A');
assert.ok(result.degenerate >= 0, 'degenerate count is defined');

await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const dom = await page.evaluate(() => {
  const kv = document.getElementById('compare-kv').textContent;
  const ident = document.getElementById('ident-kv').textContent;
  const statusText = document.getElementById('composite-status-text').textContent;
  const anomalyText = document.getElementById('composite-anomalies').textContent;
  const statusClass = document.getElementById('composite-status').className;
  return { hasCompare: kv.length > 20, hasIdent: ident.length > 20, statusText, anomalyText, statusClass };
});
console.log('dom', JSON.stringify(dom));
assert.ok(dom.hasCompare, 'prediction-vs-reference stats must be present');
assert.ok(dom.hasIdent, 'identifiability stats must be present');
assert.ok(/unknown px/.test(dom.statusText), 'composite run status must be visible');
assert.ok(/reflection/.test(dom.anomalyText) && /background contribution/.test(dom.anomalyText),
  'anomaly list must name the product reflection and the background contribution');

const compositePixels = await canvasNonBlack('composite-canvas');
assert.ok(compositePixels > 500, `composite canvas should be non-trivial (${compositePixels} px)`);

const compositeContributionPixels = await page.evaluate(() => {
  // The composite canvas is recomputed from T/A, so a different new background
  // must change it. Capture a checksum, switch the background, and compare.
  const canvas = document.getElementById('composite-canvas');
  const ctx = canvas.getContext('2d');
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let h = 0;
  for (let i = 0; i < px.length; i += 97) h = (h * 31 + px[i]) >>> 0;
  return h;
});
await page.select('#newbg-select', 'flat-dark');
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const compositeAfterBgChange = await page.evaluate(() => {
  const canvas = document.getElementById('composite-canvas');
  const ctx = canvas.getContext('2d');
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let h = 0;
  for (let i = 0; i < px.length; i += 97) h = (h * 31 + px[i]) >>> 0;
  return h;
});
assert.notEqual(compositeContributionPixels, compositeAfterBgChange,
  'composite must be recomputed from components, not copied from the source photo');
await page.select('#newbg-select', 'dots');
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

await page.screenshot({ path: new URL('lab-basic.png', OUT).pathname, fullPage: true });

// Exercise every scene. For the degenerate scene the composite status must
// report unknown pixels and the composite canvas must still render.
const names = await page.evaluate(() =>
  Array.from(document.querySelectorAll('#scene-select option')).map((o) => o.value)
);
for (const name of names) {
  await page.select('#scene-select', name);
  await page.evaluate(() => { window.__glassLab.state.result = null; });
  await page.click('#load-scene');
  await page.waitForFunction(
    (n) => window.__glassLab.state.scene && window.__glassLab.state.scene.name === n,
    { timeout: 20000 },
    name
  );
  await page.click('#estimate');
  await page.waitForFunction(() => window.__glassLab.state.result != null, { timeout: 40000 });
  const r = await page.evaluate(() => {
    const res = window.__glassLab.state.result;
    return {
      resolved: res.diagnostics.resolvedPixels,
      undetermined: res.diagnostics.undeterminedPixels,
      fraction: +res.diagnostics.resolvedFraction.toFixed(3),
      warnings: res.warnings.map((w) => w.code),
      componentCounts: res.components.counts,
      compositeStatus: document.getElementById('composite-status-text').textContent,
      statusClass: document.getElementById('composite-status').className,
    };
  });
  console.log(name, JSON.stringify(r));
  if (name === 'degenerate') {
    assert.ok(r.undetermined > 0, 'degenerate scene must leave pixels unknown');
    assert.ok(/unknown px/.test(r.compositeStatus), 'composite status must report unknown pixels');
    assert.ok(r.statusClass.includes('warn') || r.statusClass.includes('bad'), 'degenerate scene must not read all-ok');
  }
  await page.screenshot({ path: new URL(`lab-${name}.png`, OUT).pathname, fullPage: true });
}

if (logs.length) console.log('browser logs:\n' + logs.join('\n'));
await browser.close();
console.log('browser check passed');
