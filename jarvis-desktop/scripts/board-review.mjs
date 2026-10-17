// Captures the direction board (dist-prototype/prototype/board.html, built with `npm run prototype:build`) for review:
// full-page stills at 1280x720 and a compact width, the renderer lab in each real-signal state, and a short motion
// recording of the renderer (engineering test pattern, not character art). Fails on page errors, console errors,
// external requests or horizontal overflow. Evidence of the browser rendering only: nothing here shows native Windows
// behaviour (transparency, acrylic, focus, DPI, click-through).
//
// Usage: node scripts/board-review.mjs --out=../planning/ui-revamp/direction-board
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './ui-review.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = path.resolve(arg('out', path.join(root, '..', 'planning', 'ui-revamp', 'direction-board')));
const dist = path.join(root, 'dist-prototype');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serve() {
  if (!fs.existsSync(path.join(dist, 'prototype', 'board.html'))) throw new Error('Build first: npm run prototype:build');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const file = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

const LAB_STATES = [
  ['rest', 'Rest'],
  ['open-wave', 'Open (wave once)'],
  ['request-in-flight', 'Request in flight'],
  ['confirmation-open', 'Confirmation open'],
  ['verified-change-jump', 'Verified change (jump)'],
  ['answer-review', 'Answer shown (review)'],
  ['provider-error', 'Provider error'],
  ['cancelled', 'You cancelled'],
];

async function main() {
  const { chromium } = await loadPlaywright();
  const { server, origin } = await serve();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  fs.mkdirSync(out, { recursive: true });
  const report = { pages: [], errors: [], external: [], overflow: [], lab: [] };
  try {
    for (const [w, h, name] of [[1280, 720, 'board-1280'], [760, 900, 'board-760']]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, ...(name === 'board-1280' ? { recordVideo: { dir: out, size: { width: w, height: h } } } : {}) });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => report.errors.push(`${name}: ${e.message}`));
      page.on('console', (msg) => { if (msg.type() === 'error') report.errors.push(`${name}: ${msg.text()}`); });
      page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) report.external.push(r.url()); });
      await page.goto(`${origin}/prototype/board.html`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) report.overflow.push({ name, px: overflow });
      await page.screenshot({ path: path.join(out, `${name}-full.jpg`), fullPage: true, quality: 82, type: 'jpeg' });
      report.pages.push({ name, width: w, height: h });
      if (name === 'board-1280') {
        const lab = page.locator('.lab');
        await lab.scrollIntoViewIfNeeded();
        for (const [slug, label] of LAB_STATES) {
          await page.getByRole('button', { name: label, exact: true }).click();
          await page.waitForTimeout(slug === 'verified-change-jump' ? 300 : 450);
          const nowText = await page.locator('.lab-now').innerText();
          await lab.screenshot({ path: path.join(out, `lab-${slug}.jpg`), quality: 85, type: 'jpeg' });
          report.lab.push({ state: slug, shown: nowText.replace(/\s+/g, ' ').trim() });
          await page.waitForTimeout(900);
        }
        // Gaze: sweep the pointer around the stage.
        await page.getByRole('button', { name: 'Rest', exact: true }).click();
        const box = await page.locator('.lab-stage').boundingBox();
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height - 24 - 128 * 0.65;
        for (let i = 0; i < 16; i++) {
          const a = (i * 22.5 * Math.PI) / 180;
          await page.mouse.move(cx + Math.sin(a) * 150, cy - Math.cos(a) * 110);
          await page.waitForTimeout(140);
        }
        const look = await page.locator('.lab-now').innerText();
        report.lab.push({ state: 'gaze-sweep', shown: look.replace(/\s+/g, ' ').trim() });
        await page.locator('.lab').screenshot({ path: path.join(out, 'lab-gaze.jpg'), quality: 85, type: 'jpeg' });
        // Drag left, held.
        const dragLeft = page.getByRole('button', { name: 'Hold: drag left' });
        await dragLeft.hover();
        await page.mouse.down();
        await page.waitForTimeout(700);
        await page.locator('.lab').screenshot({ path: path.join(out, 'lab-drag-left.jpg'), quality: 85, type: 'jpeg' });
        report.lab.push({ state: 'drag-left', shown: (await page.locator('.lab-now').innerText()).replace(/\s+/g, ' ').trim() });
        await page.mouse.up();
        await page.getByRole('button', { name: /Reduced motion/ }).click();
        await page.getByRole('button', { name: 'Request in flight', exact: true }).click();
        await page.waitForTimeout(300);
        report.lab.push({ state: 'reduced-motion-working', shown: (await page.locator('.lab-now').innerText()).replace(/\s+/g, ' ').trim() });
      }
      const video = page.video();
      await ctx.close();
      if (video) fs.renameSync(await video.path(), path.join(out, 'board-renderer-motion.webm'));
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ errors: report.errors.length, external: report.external.length, overflow: report.overflow, lab: report.lab.length }));
  if (report.errors.length || report.external.length || report.overflow.length) process.exitCode = 1;
}

await main();
