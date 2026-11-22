// Minimal static + API server for the glass compositing lab.
// The graphical UI (app/index.html) is the primary entry point; this server
// only serves files and a small JSON API used by the "Load sample scene"
// button so the browser can obtain synthetic ground-truth scenes.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { generateScene } from '../src/core/scenes.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = join(ROOT, 'app');
const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function pngBuffer(img) {
  const png = new PNG({ width: img.width, height: img.height });
  const bytes = img.toSrgbBytes();
  png.data = Buffer.from(bytes);
  return PNG.sync.write(png);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/api/scenes') {
      // Metadata for the built-in synthetic scenes.
      const { listScenes } = await import('../src/core/scenes.js');
      return sendJson(res, 200, { scenes: listScenes() });
    }
    if (url.pathname === '/api/scene') {
      const name = url.searchParams.get('name') || 'basic';
      const scene = generateScene(name);
      const { truthFieldsPayload } = await import('../src/core/scenes.js');
      const observations = scene.observations.map((o) => ({
        png: pngBuffer(o.image).toString('base64'),
        label: o.label,
      }));
      const backgrounds = scene.backgrounds.map((b) => ({
        png: pngBuffer(b.image).toString('base64'),
        label: b.label,
      }));
      return sendJson(res, 200, {
        name: scene.name,
        width: scene.width,
        height: scene.height,
        description: scene.description,
        maskPng: pngBuffer(scene.maskImage).toString('base64'),
        observations,
        backgrounds,
        newBackgroundPng: pngBuffer(scene.newBackground).toString('base64'),
        newBackgroundKind: scene.newBackgroundKind,
        includeOffset: scene.includeOffset,
        referencePng: pngBuffer(scene.reference).toString('base64'),
        truth: scene.truthSummary,
        truthFields: truthFieldsPayload(scene.fields, scene.width, scene.height),
        modelNotes: scene.modelNotes,
      });
    }
    if (url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    // Static files under app/ (and /src/ for shared ES modules).
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const base = path.startsWith('/src/') ? ROOT : APP;
    const resolved = normalize(join(base, path));
    if (!resolved.startsWith(APP) && !resolved.startsWith(join(ROOT, 'src'))) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const data = await readFile(resolved);
    res.writeHead(200, {
      'content-type': MIME[extname(resolved)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.writeHead(404);
      return res.end('not found');
    }
    console.error(err);
    res.writeHead(500);
    res.end('server error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`Glass compositing lab: http://localhost:${PORT}/`);
});
