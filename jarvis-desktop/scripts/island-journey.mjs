// Island review journey: drives the PRODUCTION island (src/companion/island/CompanionIsland.tsx) on
// dist-prototype/prototype/island.html in a local Chromium, over original mock desktops, against a scripted preview of
// window.companion (labelled on the page). It checks the motion contract with real measurements from the shell itself:
// grow-before-open, collapse-before-shrink, continuity on reversal, focus, edge light per state, and frame timing.
// Evidence of the browser rendering only: no native window, Windows composition, DPI or real model is involved.
//
//   npm run prototype:build && node scripts/island-journey.mjs [--out=../planning/ui-revamp/island]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './ui-review.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = path.resolve(arg('out', path.join(root, '..', 'planning', 'ui-revamp', 'island')));
fs.mkdirSync(out, { recursive: true });
const dist = path.join(root, 'dist-prototype');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

function serve() {
  if (!fs.existsSync(path.join(dist, 'prototype', 'island.html'))) throw new Error('Build first: npm run prototype:build');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const file = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

const results = [];
let n = 0;
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

function stats(frames) {
  if (!frames.length) return { frames: 0 };
  const dts = frames.map((f) => f.dt).sort((a, b) => a - b);
  const pick = (q) => dts[Math.min(dts.length - 1, Math.floor(q * dts.length))];
  return { frames: frames.length, meanMs: +(dts.reduce((a, b) => a + b, 0) / dts.length).toFixed(2), p95Ms: +pick(0.95).toFixed(2), maxMs: +dts.at(-1).toFixed(2), over20Ms: dts.filter((d) => d > 20).length, timerSteps: frames.filter((f) => f.via === 'timer').length };
}

async function main() {
  const { chromium } = await loadPlaywright();
  const { server, origin } = await serve();
  const browser = await chromium.launch({executablePath: arg('browser-executable', process.env.ISLAND_REVIEW_BROWSER || undefined)});
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'dark', recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
  const external = [];
  context.on('request', (r) => { if (!r.url().startsWith(origin) && !/^(data|blob|about):/.test(r.url())) external.push(r.url()); });
  const page = await context.newPage();
  const errors = [];
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url().replace(origin, '')}`); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${origin}/prototype/island.html`);
  await page.waitForFunction(() => !!window.__island);
  const call = (fn, ...a) => page.evaluate(([f, args]) => window.__island[f](...args), [fn, a]);
  const frames = () => page.evaluate(() => window.__frames.slice());
  const layout = () => page.evaluate(() => window.__layout.slice());
  const edge = () => page.locator('.cd.isl').getAttribute('data-edge');
  const shot = async (name) => { const f = `${String(++n).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: path.join(out, f) }); return f; };
  const settled = async () => { await page.waitForFunction(() => document.querySelector('.cd.isl')?.dataset.placed === 'true'); await page.waitForTimeout(520); };
  async function step(name, fn) {
    const notes = [];
    let ok = true, failure = '', file = null;
    try { file = await fn(notes); } catch (e) { ok = false; failure = String(e?.message ?? e).split('\n')[0]; file = await shot(`${name}-failure`).catch(() => null); }
    results.push({ name, ok, failure, notes, screenshot: file });
    console.log(ok ? 'PASS' : 'FAIL', name, failure || notes.join('; '));
  }

  await step('rest', async (notes) => {
    await page.waitForTimeout(300);
    expect((await page.locator('.cd.isl').count()) === 0, 'at rest the island is not mounted (only the character slot)');
    const l = await layout();
    expect(l.length >= 1 && l.every((x) => x.bubble === null), 'the window was only ever asked for the rest size');
    notes.push('no island, no request, no microphone');
    return shot('rest-light');
  });

  await step('invoke-command', async (notes) => {
    await call('resetFrames');
    const before = (await layout()).length;
    await call('invoke');
    await settled();
    const l = (await layout()).slice(before);
    expect(l.length >= 1 && l[0].bubble && l[0].bubble.width > 300, 'the content size is requested from the window first');
    const f = await frames();
    const firstFrameAt = f[0]?.at ?? Infinity;
    expect(l[0].at < firstFrameAt, 'the window is asked to grow before the glass starts moving');
    expect(await page.evaluate(() => document.activeElement?.id === 'cmp-input'), 'the caret is in the message field');
    expect((await edge()) === 'idle', 'no work light at rest of the command view');
    const skin = await page.evaluate(() => { const s = document.querySelector('.isl-skin'); const c = document.querySelector('[data-isl-layer="in"]'); return { sw: parseFloat(s.style.width), cw: c.offsetWidth, sh: parseFloat(s.style.height), ch: c.offsetHeight }; });
    expect(Math.abs(skin.sw - skin.cw) < 1.5 && Math.abs(skin.sh - skin.ch) < 1.5, `the glass settles exactly on the content (${JSON.stringify(skin)})`);
    notes.push(`open: ${JSON.stringify(stats(f.filter((x) => x.phase === 'open')))}`);
    return shot('command-light');
  });

  await step('context-region-and-window', async (notes) => {
    await page.getByRole('button', { name: 'Pick an area' }).click();
    await page.getByText('Screen area attached').waitFor();
    await page.waitForTimeout(400);
    expect(await page.getByText(/Typing goes to notepad/).isVisible(), 'the remembered window is a visible, removable chip');
    expect((await page.getByRole('button', { name: 'Remove' }).count()) === 2, 'both chips can be removed');
    notes.push('region + window chips');
    return shot('context');
  });

  await step('click-during-morph', async (notes) => {
    // The region chip makes the content taller; clicking a control while the glass is still growing must work.
    await page.getByRole('button', { name: 'Remove' }).first().click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Pick an area' }).click();
    await page.getByText('Screen area attached').waitFor();
    await page.waitForTimeout(40);
    const moving = await page.evaluate(() => window.__frames.length);
    const box = await page.locator('#cmp-input').boundingBox();
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + 20, box.y + box.height / 2]);
    expect(hit === 'cmp-input', `the message field is hittable mid-morph (got ${hit})`);
    notes.push(`hit-tested mid-move (${moving} frames recorded so far)`);
    await page.waitForTimeout(450);
    return null;
  });

  await step('work-sending-and-tool', async () => {
    await page.locator('#cmp-input').fill('When do I reset the router? Add a task to re-pair the mesh tomorrow.');
    await call('resetFrames');
    await page.getByRole('button', { name: 'Ask' }).click();
    await page.getByText('Sending your request to Claude').waitFor();
    expect((await edge()) === 'working', 'the light traces while the request is worked on');
    await page.waitForTimeout(350);
    await shot('work-sending');
    await page.getByText('Searching saved items').first().waitFor();
    await page.waitForTimeout(250);
    return shot('work-tool');
  });

  await step('confirmation', async (notes) => {
    await page.locator('.conf').waitFor({ timeout: 8000 });
    await page.waitForTimeout(350);
    expect((await edge()) === 'waiting', 'the light holds while waiting for the person');
    expect((await page.getByRole('button', { name: /^(Continue|Approve|Yes)$/ }).count()) === 0, 'the island offers no approve button');
    notes.push('summary + Stop only; approval is the (scripted) native dialog');
    return shot('confirmation');
  });

  await step('verify-and-answer', async (notes) => {
    await call('confirm', true);
    await page.getByText('Checking the result').waitFor({ timeout: 4000 }).catch(() => notes.push('the checking stage passed before it could be captured'));
    await page.getByText('Answer', { exact: true }).waitFor({ timeout: 8000 });
    expect((await edge()) === 'done', 'a verified change settles the light');
    expect(await page.getByRole('button', { name: 'Undo' }).isVisible(), 'the verified change offers Undo');
    const morph = (await frames()).filter((x) => x.phase === 'morph');
    notes.push(`morphs: ${JSON.stringify(stats(morph))}`);
    await page.waitForTimeout(500);
    return shot('answer-verified');
  });

  await step('collapse-then-shrink', async (notes) => {
    await call('resetFrames');
    const before = (await layout()).length;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    await shot('collapse-mid');
    await page.waitForFunction(() => !document.querySelector('.cd.isl'));
    const f = (await frames()).filter((x) => x.phase === 'close');
    const shrinks = (await layout()).slice(before).filter((x) => x.bubble === null);
    const shrink = shrinks[0];
    expect(shrinks.length === 1, `exactly one shrink request (${shrinks.length})`);
    expect(f.length > 3, 'the close was animated');
    expect(shrink && shrink.at >= f.at(-1).at, `the window shrinks only after the last close frame (shrink ${shrink?.at}, last ${f.at(-1)?.at}, layout ${JSON.stringify((await layout()).slice(before))})`);
    notes.push(`close: ${JSON.stringify(stats(f))}; shrink ${Math.round(shrink.at - f.at(-1).at)} ms after the last frame`);
    return shot('rest-after-collapse');
  });

  await step('interruption-reversal', async (notes) => {
    await call('resetFrames');
    await call('invoke');
    await page.waitForFunction(() => document.querySelector('.cd.isl')?.dataset.placed === 'true');
    await page.waitForTimeout(110);
    await call('collapse');
    await page.waitForTimeout(90);
    await call('invoke');
    await settled();
    const widths = await page.evaluate(() => window.__frames.map((f) => f.phase));
    const trace = await page.evaluate(() => window.__trace ?? null);
    const f = await frames();
    const jumps = f.filter((x) => x.dt > 60).length;
    // Reopening before the close finished continues from the drawn shape (a morph back), not from the capsule.
    expect(f.some((x) => x.phase === 'open') && f.some((x) => x.phase === 'close') && f.at(-1).phase === 'morph', `open, reversed to close, reversed again (${[...new Set(f.map((x) => x.phase))].join(',')})`);
    expect(jumps === 0, 'no stalled frame during the reversals');
    expect(await page.evaluate(() => document.activeElement?.id === 'cmp-input'), 'focus is back in the message field once, not lost');
    notes.push(`phases: ${[...new Set(widths)].join(' → ')}; ${JSON.stringify(stats(f))}${trace ? '' : ''}`);
    return shot('reopened-after-reversal');
  });

  await step('typing-unverified-dark', async (notes) => {
    await call('scene', 'dark');
    await call('scenario', 'type');
    await page.locator('#cmp-input').fill('Write the shopping list into Notepad.');
    await page.getByRole('button', { name: 'Ask' }).click();
    await page.locator('.conf').waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    await shot('confirmation-typing-dark');
    await call('confirm', true);
    await page.getByText('Answer', { exact: true }).waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    expect((await edge()) === 'idle', 'typing that was not read back gets no done light');
    expect(await page.getByText('no undo').isVisible(), 'and says there is no undo');
    notes.push('typed, not read back');
    return shot('answer-unverified-dark');
  });

  await step('stop-during-confirmation', async (notes) => {
    await call('scenario', 'saved');
    await page.getByRole('button', { name: 'Follow up' }).click();
    await page.locator('#cmp-input').fill('Add a task to call the bank.');
    await page.getByRole('button', { name: 'Ask' }).click();
    await page.locator('.conf').waitFor({ timeout: 8000 });
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.getByText('Stopped', { exact: true }).waitFor();
    await page.waitForTimeout(400);
    expect((await edge()) === 'idle', 'Stop is not shown as an error');
    expect(await page.getByText(/Your request is kept/).isVisible(), 'the request is kept for Ask again');
    notes.push('Stop closes the confirmation as Cancel (in the app: MessageBox signal)');
    return shot('stopped');
  });

  await step('offline-error-busy', async (notes) => {
    await call('scene', 'busy');
    await call('scenario', 'offline');
    await page.getByRole('button', { name: 'Edit request' }).click();
    await page.getByRole('button', { name: 'Ask' }).click();
    await page.getByText('Online mode is off').waitFor({ timeout: 6000 });
    await page.waitForTimeout(400);
    expect((await edge()) === 'error', 'the error light');
    expect(await page.getByRole('button', { name: 'Open Settings' }).isVisible(), 'a way to fix it');
    notes.push('offline is its own state, distinct from network and provider limits');
    return shot('offline-busy');
  });

  await step('reduced-motion', async (notes) => {
    await call('scenario', 'saved');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cd.isl'));
    await page.waitForTimeout(200);
    await call('reduced', true);
    await call('resetFrames');
    await call('invoke');
    await page.waitForFunction(() => document.querySelector('.cd.isl')?.dataset.placed === 'true');
    await page.waitForTimeout(80);
    const f = await frames();
    expect(f.length === 0, `no animated frames under reduced motion (${JSON.stringify(f)})`);
    notes.push('opens in place');
    return shot('reduced-motion-command');
  });

  const health = { name: 'page-health', ok: errors.length === 0 && external.length === 0, failure: errors[0] ?? external[0] ?? '', notes: [`console errors: ${errors.length}`, `external requests: ${external.length}`] };
  results.push(health);
  await context.close();
  await browser.close();
  server.close();
  const video = fs.readdirSync(out).filter((f) => f.endsWith('.webm')).sort((a, b) => fs.statSync(path.join(out, b)).mtimeMs - fs.statSync(path.join(out, a)).mtimeMs)[0];
  if (video && video !== 'island-journey.webm') fs.renameSync(path.join(out, video), path.join(out, 'island-journey.webm'));
  for (const f of fs.readdirSync(out)) if (f.endsWith('.webm') && f !== 'island-journey.webm') fs.rmSync(path.join(out, f));
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(out, 'island-journey.json'), `${JSON.stringify({ environment: {platform: process.platform, browser: browser.version(), headless: true, actions: 'scripted preview', note: 'Frame timing describes this headless test, not native Windows composition.'}, results }, null, 2)}\n`);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
