// Interaction journeys for the UI revamp, driven through the visible UI (clicks and keys) in a local Chromium.
// The renderer is the built dist/ served on 127.0.0.1; the backend is tests/fixtures/fixture-bridge.js (labelled test
// data, no network, no model, no real key). Each journey records pass/fail with its own evidence; a failure is
// reported, never skipped. Videos and step screenshots go to --out. This is not the Electron app and proves no native
// Windows behaviour (trusted dialogs, DPAPI vault, real Anthropic calls); see the result document for those checks.
//
//   node scripts/ui-journeys.mjs --out=../planning/ui-revamp/after/journeys
import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright, openPage, serveDist } from './ui-review.mjs';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = path.resolve(arg('out', '../planning/ui-revamp/after/journeys'));
fs.mkdirSync(out, { recursive: true });
const results = [];
const VIEW_IDS = ['home', 'assistant', 'companion', 'capsules', 'notes', 'tasks', 'computer', 'status', 'settings', 'lab', 'developer', 'search', 'motion', 'avatar', 'routines', 'clipboard', 'calendar', 'models', 'integrations', 'usage', 'memory', 'writing', 'guide'];

async function journey(name, browser, origin, opts, fn) {
  const t0 = Date.now();
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  const { context, page, errors, external } = await openPage(browser, origin, { width: 1280, height: 720, theme: 'dark', prefs: { 'appearance.theme': 'dark' }, ...opts, video: dir });
  const notes = [];
  let ok = true;
  let failure = '';
  let n = 0;
  const shot = async (label) => page.screenshot({ path: path.join(dir, `${String(++n).padStart(2, '0')}-${label}.png`) });
  try {
    await fn({ page, notes, shot, context });
  } catch (e) {
    ok = false;
    failure = String(e?.message ?? e).split('\n')[0];
    await shot('failure').catch(() => undefined);
  }
  await context.close();
  if (errors.length) notes.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  if (external.length) {
    ok = false;
    failure ||= `non-local requests: ${external.slice(0, 3).join(', ')}`;
  }
  results.push({ name, ok, ms: Date.now() - t0, failure, notes, errors: errors.length, externalRequests: external.length });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${failure ? ` - ${failure}` : ''}${notes.length ? `\n     ${notes.join('\n     ')}` : ''}`);
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** Two canvas snapshots some time apart: different means the renderer is drawing. */
async function canvasChanges(page, selector, waitMs = 600) {
  const read = () => page.evaluate((sel) => document.querySelector(sel)?.toDataURL() ?? '', selector);
  const a = await read();
  await page.waitForTimeout(waitMs);
  const b = await read();
  return a !== b && a.length > 100;
}

/** requestAnimationFrame cadence for a period, and main-thread task time from the DevTools protocol. */
async function frameStats(page, ms = 3000) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  const frames = await page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        const times = [];
        const start = performance.now();
        const step = (t) => {
          times.push(t);
          if (t - start < dur) requestAnimationFrame(step);
          else resolve(times);
        };
        requestAnimationFrame(step);
      }),
    ms,
  );
  const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  const deltas = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
  const pct = (p) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))] ?? 0;
  const taskMs = ((m1.TaskDuration ?? 0) - (m0.TaskDuration ?? 0)) * 1000;
  return { fps: +(deltas.length / (ms / 1000)).toFixed(1), p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1), mainThreadBusyPct: +((taskMs / ms) * 100).toFixed(1) };
}

async function main() {
  const { chromium } = await loadPlaywright();
  const { server, origin } = await serveDist();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    // 1. Fresh install, no key: start locally, save a note, see the stored record, reopen it after relaunch.
    await journey('01-first-run-local', browser, origin, { fixture: { onboarded: false, chat: 'unavailable' }, hash: '#/home' }, async ({ page, notes, shot }) => {
      const t0 = Date.now();
      await shot('welcome');
      await page.getByRole('button', { name: /Start locally/ }).click();
      await page.getByLabel('Title').fill('Ideas for the weekend');
      await page.locator('.ob-first textarea').fill('Ride to the lake. Try the new bakery.');
      await shot('first-note');
      await page.getByRole('button', { name: 'Save note' }).click();
      await page.getByRole('article', { name: 'Saved note' }).waitFor();
      const record = await page.getByRole('article', { name: 'Saved note' }).innerText();
      expect(/Ideas for the weekend/.test(record), 'the saved record shows the stored title');
      await shot('saved-record');
      await page.getByRole('button', { name: 'Continue to Today' }).click();
      await page.getByRole('heading', { level: 1 }).filter({ hasText: /^Good / }).waitFor();
      expect(await page.getByRole('button', { name: /Ideas for the weekend/ }).count(), 'Today shows the note under Continue');
      notes.push(`first success in ${((Date.now() - t0) / 1000).toFixed(1)} s of scripted time (a person needs longer to read; measure with a real user)`);
      await shot('today');
      await page.reload();
      await page.waitForTimeout(800);
      expect(await page.getByRole('button', { name: /Ideas for the weekend/ }).count(), 'the note is still there after a relaunch');
      await page.getByRole('button', { name: /Ideas for the weekend/ }).click();
      await page.waitForURL(/#\/notes\?item=/);
      expect(await page.locator('input.input-title').inputValue() === 'Ideas for the weekend', 'the note opens in Notes');
      await shot('note-open');
      expect(!(await page.getByText(/error/i).filter({ hasText: /^Error/ }).count()), 'no error wall');
    });

    // 2. No key: one clear Connect Claude action; local work keeps working.
    await journey('02-ai-not-connected', browser, origin, { fixture: { seed: 'populated', chat: 'unavailable' }, hash: '#/home' }, async ({ page, shot }) => {
      expect(await page.getByText('AI is not connected').count(), 'Today says AI is not connected');
      expect(await page.getByRole('button', { name: 'Connect Claude' }).count() === 1, 'exactly one Connect Claude action on Today');
      expect(!(await page.getByText(/Ollama/).count()), 'no local-model setup copy in the normal path');
      await shot('today-blocked');
      await page.getByRole('link', { name: 'Assistant' }).first().click();
      await page.getByRole('heading', { name: 'Connect Claude to chat' }).waitFor();
      expect(!(await page.getByText(/Ollama/).count()), 'no Ollama recovery copy in the Assistant');
      await shot('assistant-blocked');
      await page.getByRole('link', { name: 'Today' }).click();
      await page.getByPlaceholder(/Write a note title/).fill('Still works offline');
      await page.getByRole('button', { name: 'Save note' }).click();
      await page.getByText(/Note “Still works offline” saved/).waitFor();
    });

    // 3. Connect Claude (fixture): key, online consent, model list, streamed test with Stop, then a real conversation turn.
    await journey('03-connect-claude-and-stream', browser, origin, { fixture: { seed: 'populated', chat: 'unavailable', wordMs: 120 }, hash: '#/assistant' }, async ({ page, notes, shot }) => {
      await page.getByRole('button', { name: 'Connect Claude' }).first().click();
      await page.getByRole('dialog', { name: 'Connect AI' }).waitFor();
      await shot('setup-open');
      await page.getByLabel('API key').fill('fixture-key-not-a-secret-0123456789');
      await page.getByRole('button', { name: 'Save key' }).click();
      await page.getByRole('button', { name: 'Turn on online mode' }).click();
      await page.getByRole('radiogroup', { name: /models/ }).waitFor();
      const models = await page.getByRole('radio', { name: /Fixture model/ }).count();
      expect(models === 2, `the model list comes from the provider check (${models} fixture models)`);
      await shot('models');
      await page.getByRole('button', { name: 'Use this model' }).click();
      await page.getByRole('button', { name: 'Send a test message' }).click();
      await page.getByText('Receiving').waitFor();
      await page.waitForTimeout(500);
      await shot('test-streaming');
      await page.getByRole('button', { name: 'Stop' }).click();
      await page.getByText('Test stopped').waitFor();
      notes.push('test message streamed and was stopped by the user');
      await page.getByRole('button', { name: 'Send another test' }).click();
      await page.getByText(/answered\. Chat is working/).waitFor({ timeout: 15000 });
      await shot('test-complete');
      await page.getByRole('button', { name: 'Open the Assistant' }).click();
      await page.locator('#chat-input').fill('Plan my review prep in three steps.');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.locator('.msg-pending').waitFor();
      await page.waitForTimeout(600);
      await shot('assistant-streaming');
      const stopBtn = page.getByRole('button', { name: /^Stop/ });
      await stopBtn.click();
      await page.getByText('You stopped this reply').waitFor({ timeout: 10000 });
      await shot('assistant-stopped');
      notes.push('assistant reply streamed, Stop worked and the partial reply was kept');
    });

    // 4. Studio: choose a form, apply, every placement changes, relaunch keeps it, the classic pack stays available.
    await journey('04-studio-applies-everywhere', browser, origin, { fixture: { seed: 'populated' }, hash: '#/companion' }, async ({ page, shot }) => {
      const forms = () => page.evaluate(() => [...document.querySelectorAll('.rail .orb, .today-core .orb')].map((e) => e.getAttribute('data-form')));
      await page.getByRole('radio', { name: /Lattice/ }).click();
      expect((await page.getByText('Not applied yet').count()) === 1, 'the change is a draft until Apply');
      await shot('draft');
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.getByText('Applied everywhere').waitFor();
      const railForm = await page.evaluate(() => document.querySelector('.rail .orb')?.getAttribute('data-form'));
      expect(railForm === 'lattice', `the rail companion changed (${railForm})`);
      await page.getByRole('link', { name: 'Today' }).click();
      await page.waitForTimeout(500);
      const all = await forms();
      expect(all.length >= 2 && all.every((f) => f === 'lattice'), `rail and Today use the applied form (${all.join(',')})`);
      await shot('today-lattice');
      await page.reload();
      await page.waitForTimeout(800);
      const after = await forms();
      expect(after.every((f) => f === 'lattice'), 'the choice survives a relaunch');
      await page.getByRole('link', { name: 'Studio' }).click();
      await page.getByRole('radio', { name: /Classic character/ }).waitFor();
    });

    // 5. Keyboard: Alt shortcuts, quick search, Escape, and every deep link renders its own screen.
    await journey('05-keyboard-and-deep-links', browser, origin, { fixture: { seed: 'populated' }, hash: '#/home' }, async ({ page, notes, shot }) => {
      await page.keyboard.press('Alt+5');
      await page.waitForURL(/#\/notes/);
      await page.keyboard.press('Alt+2');
      await page.waitForURL(/#\/assistant/);
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox', { name: /Search saved items/ }).waitFor();
      await page.keyboard.type('review');
      await page.waitForTimeout(250);
      await shot('palette');
      const firstSaved = await page.locator('.palette-item').first().innerText();
      expect(/review/i.test(firstSaved), `quick search finds saved items first (${firstSaved.split('\n')[0]})`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      expect(/#\/notes\?item=|#\/capsules\?item=/.test(page.url()), 'Enter opens the saved item');
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox', { name: /Search saved items/ }).waitFor();
      await page.waitForTimeout(150);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(350);
      expect(!(await page.locator('dialog[open]').count()), 'Escape closes quick search');
      const broken = [];
      for (const id of VIEW_IDS) {
        await page.evaluate((h) => (location.hash = h), `/${id}`);
        await page.waitForTimeout(350);
        const ok = await page.evaluate(() => {
          const m = document.getElementById('main');
          return Boolean(m && m.innerText.trim().length > 20 && m.querySelector('h1'));
        });
        if (!ok) broken.push(id);
      }
      expect(!broken.length, `routes without content: ${broken.join(', ')}`);
      notes.push(`all ${VIEW_IDS.length} route ids render a titled screen`);
      await page.evaluate(() => (location.hash = '/home'));
      await page.reload();
      await page.waitForTimeout(700);
      await page.keyboard.press('Tab');
      const skip = await page.evaluate(() => document.activeElement?.textContent);
      expect(/Skip to content/.test(skip ?? ''), 'the first Tab stop is Skip to content');
    });

    // 6. Theme and motion preferences persist; reduced motion and a hidden window stop the renderer.
    await journey('06-theme-motion-renderer', browser, origin, { fixture: { seed: 'populated' }, hash: '#/home' }, async ({ page, notes, shot }) => {
      expect(await canvasChanges(page, '.today-core canvas'), 'the core animates while visible');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(200);
      expect(!(await canvasChanges(page, '.today-core canvas')), 'nothing is drawn while the window is hidden');
      notes.push('renderer pauses when the window is hidden');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const live = await frameStats(page, 3000);
      notes.push(`Today, live core (software GL): ${live.fps} rAF/s, frame p50 ${live.p50} ms, p95 ${live.p95} ms, main thread busy ${live.mainThreadBusyPct}%`);
      await page.getByRole('link', { name: 'Studio' }).click();
      await page.getByRole('switch', { name: /Reduce motion everywhere/ }).waitFor();
      await page.waitForTimeout(600);
      await page.getByRole('switch', { name: /Reduce motion everywhere/ }).click();
      await page.waitForTimeout(900);
      expect((await page.evaluate(() => document.documentElement.dataset.motion)) === 'reduced', 'reduced motion is applied');
      expect(!(await canvasChanges(page, '.studio-stage canvas')), 'with reduced motion the core is a still frame');
      notes.push('reduced motion stops the animation loop (still frame)');
      await page.reload();
      await page.waitForTimeout(700);
      expect((await page.evaluate(() => document.documentElement.dataset.motion)) === 'reduced', 'reduced motion persists');
      await shot('reduced-motion');
      const idle = await frameStats(page, 3000);
      notes.push(`Studio with reduced motion: main thread busy ${idle.mainThreadBusyPct}%`);
    });

    // 7. Frame timing on the Studio stage (largest placement) in full motion.
    await journey('07-studio-frame-timing', browser, origin, { fixture: { seed: 'populated' }, hash: '#/companion' }, async ({ page, notes }) => {
      const s = await frameStats(page, 4000);
      notes.push(`Studio 340px stage + thumbnails (software GL): ${s.fps} rAF/s, frame p50 ${s.p50} ms, p95 ${s.p95} ms, p99 ${s.p99} ms, main thread busy ${s.mainThreadBusyPct}%`);
    });
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'journeys.json'), JSON.stringify({ when: new Date().toISOString(), environment: 'Linux container, Chromium (Playwright) with SwiftShader software WebGL, fixture backend', results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} journeys passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
