// Captures the companion experience prototype (dist-prototype/, built with `npm run prototype:build`). Drives the
// prototype's own guide controls through each state on the dark, light and busy mock desktops, saves stills, and
// records the guided journey as a video. Composition and motion evidence for review only: the prototype is scripted,
// and none of this shows native Windows behaviour (always-on-top, focus with other apps, desktop blur, DPI).
//
// Usage: node scripts/prototype-review.mjs --out=../planning/ui-revamp/prototype [--sizes=1280x720,1440x900]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './ui-review.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = path.resolve(arg('out', path.join(root, '..', 'planning', 'ui-revamp', 'prototype')));
const sizes = arg('sizes', '1280x720,1440x900').split(',').map((s) => s.split('x').map(Number));
const dist = path.join(root, 'dist-prototype');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };

function serve() {
  if (!fs.existsSync(path.join(dist, 'prototype', 'index.html'))) throw new Error('Build the prototype first: npm run prototype:build');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const file = path.normalize(path.join(dist, decodeURIComponent(url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname)));
    if (!file.startsWith(dist) || !fs.existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

const STATES = ['Resting', 'Invoked', 'Listening preview', 'Plan to confirm', 'Answer', 'Utilities', 'Customise', 'Full hub'];

async function main() {
  const { chromium } = await loadPlaywright();
  const { server, origin } = await serve();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  fs.mkdirSync(out, { recursive: true });
  const report = [];
  try {
    for (const [width, height] of sizes) {
      for (const wall of ['Dark', 'Light', 'Busy']) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark' });
        const external = [];
        context.on('request', (r) => {
          if (!r.url().startsWith(origin) && !/^(data|blob|about):/.test(r.url())) external.push(r.url());
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(`${origin}/prototype/index.html`);
        await page.waitForTimeout(600);
        await page.getByRole('radiogroup', { name: 'Mock desktop' }).getByRole('radio', { name: wall }).click();
        for (const [i, name] of STATES.entries()) {
          if (wall !== 'Dark' && !['Resting', 'Invoked', 'Answer', 'Customise'].includes(name)) continue;
          await page.getByRole('navigation', { name: 'States' }).getByRole('button', { name: new RegExp(`${name}$`) }).click();
          await page.waitForTimeout(name === 'Full hub' ? 1800 : name === 'Listening preview' ? 1500 : 700);
          const file = `${String(i + 1).padStart(2, '0')}-${name.toLowerCase().replace(/\s+/g, '-')}-${wall.toLowerCase()}-${width}x${height}.jpg`;
          await page.screenshot({ path: path.join(out, file), type: 'jpeg', quality: 82 });
          const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
          report.push({ file, errors: [...errors], external: [...external], overflowX });
        }
        await context.close();
      }
    }
    // Edge-light states: hover, working, done and error, each a real state of the island (scripted content).
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      await page.goto(`${origin}/prototype/index.html`);
      await page.waitForTimeout(600);
      const shot = async (name) => {
        const file = `edge-${name}-1280x720.jpg`;
        await page.locator('.desk').screenshot({ path: path.join(out, file), type: 'jpeg', quality: 85 });
        report.push({ file, errors: [], external: [], overflowX: false });
      };
      await page.locator('.island').hover();
      await page.waitForTimeout(300);
      await shot('hover');
      await page.getByRole('navigation', { name: 'States' }).getByRole('button', { name: /Invoked$/ }).click();
      await page.getByRole('button', { name: 'Remind me to call the bank tomorrow at 10' }).click();
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'Add task' }).click();
      await page.waitForTimeout(250);
      await shot('working');
      await page.waitForTimeout(700);
      await shot('done');
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.keyboard.press('Control+Space');
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'Email this draft to Priya (not connected)' }).click();
      await page.waitForTimeout(700);
      await shot('error');
      await context.close();
    }
    // The guided journey as video, at one laptop size.
    const vdir = path.join(out, 'video-tmp');
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: vdir, size: { width: 1280, height: 720 } } });
    const page = await context.newPage();
    await page.goto(`${origin}/prototype/index.html`);
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Play the journey' }).click();
    await page.waitForFunction(() => !document.querySelector('.tour-caption'), null, { timeout: 90_000, polling: 500 });
    await page.waitForTimeout(800);
    const video = page.video();
    await context.close();
    if (video) {
      const src = await video.path();
      fs.renameSync(src, path.join(out, 'journey-1280x720.webm'));
      fs.rmSync(vdir, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'capture-report.json'), JSON.stringify(report, null, 2));
  for (const r of report) console.log(`${r.file}${r.errors.length ? ` errors=${r.errors.length}: ${r.errors[0]}` : ''}${r.external.length ? ` EXTERNAL=${r.external.length}` : ''}${r.overflowX ? ' OVERFLOW-X' : ''}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
