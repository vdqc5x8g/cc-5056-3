// Browser smoke test: loads the UI, runs an estimate, and captures screenshots.
// Not part of `npm test`; run with: node tools/browser-check.mjs
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

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

// Click estimate.
await page.click('#estimate');
await page.waitForFunction(() => window.__glassLab.state.result != null, { timeout: 30000 });

const result = await page.evaluate(() => {
  const r = window.__glassLab.state.result;
  return {
    resolved: r.diagnostics.resolvedPixels,
    undetermined: r.diagnostics.undeterminedPixels,
    fraction: r.diagnostics.resolvedFraction,
    warnings: r.warnings.map((w) => w.code),
  };
});
console.log('estimate', JSON.stringify(result));
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// Check the composite canvas has non-trivial content and the DOM shows stats.
const dom = await page.evaluate(() => {
  const kv = document.getElementById('compare-kv').textContent;
  const ident = document.getElementById('ident-kv').textContent;
  const canvas = document.getElementById('composite-canvas');
  const ctx = canvas.getContext('2d');
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonBlack = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 30) nonBlack++;
  return { hasCompare: kv.length > 20, hasIdent: ident.length > 20, compositeNonBlack: nonBlack };
});
console.log('dom', JSON.stringify(dom));

await page.screenshot({ path: new URL('lab-basic.png', OUT).pathname, fullPage: true });

// Exercise every scene.
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
      compositeKv: document.getElementById('compare-kv').textContent.slice(0, 120),
    };
  });
  console.log(name, JSON.stringify(r));
  await page.screenshot({ path: new URL(`lab-${name}.png`, OUT).pathname, fullPage: true });
}

if (logs.length) console.log('browser logs:\n' + logs.join('\n'));
await browser.close();
