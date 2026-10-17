// Voice journey for the Assistant, driven through the visible UI in a local Chromium with Chromium's FAKE microphone
// (--use-fake-device-for-media-stream: a generated test tone, no real microphone). The renderer is the built dist/ on
// 127.0.0.1; the backend is tests/fixtures/fixture-bridge.js with speech: 'scripted', which answers transcribe/speak with
// labelled fixture results and logs every voice call. So this proves the renderer path end to end (consent, real
// MediaRecorder capture, real level, WAV encoding, the stop/cancel calls reaching the bridge, cleanup on navigation),
// and proves nothing about Windows speech recognition or playback, which need the installed app on Windows.
//
//   npm run build && node scripts/voice-journey.mjs [--out=../planning/ui-revamp/voice]
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_SRC, loadPlaywright, serveDist } from './ui-review.mjs';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = path.resolve(arg('out', '../planning/ui-revamp/voice'));
fs.mkdirSync(out, { recursive: true });
const results = [];
let n = 0;

async function open(browser, origin, { reducedMotion = false, fixture = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, colorScheme: 'dark', reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  await context.grantPermissions(['microphone'], { origin });
  const external = [];
  context.on('request', (r) => { const u = r.url(); if (!u.startsWith(origin) && !/^(data|blob|about):/.test(u)) external.push(u); });
  await context.addInitScript(({ src, fixture }) => {
    if (!sessionStorage.getItem('voice.init')) {
      sessionStorage.setItem('voice.init', '1');
      localStorage.clear();
      localStorage.setItem('jarvis.ui.appearance.theme', JSON.stringify('dark'));
    }
    window.__FIXTURE__ = { seed: 'populated', chat: 'ready', stt: true, tts: true, speech: 'scripted', speakMs: 8000, transcribeMs: 1500, ...fixture };
    // eslint-disable-next-line no-new-func
    new Function(src)();
    // Keep every stream the page opens, to check later that its tracks really ended.
    const md = navigator.mediaDevices;
    window.__streams = [];
    if (md?.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (c) => { const s = await orig(c); window.__streams.push(s); return s; };
    }
  }, { src: FIXTURE_SRC, fixture });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${origin}/#/assistant`);
  await page.waitForSelector('#chat-input');
  return { context, page, errors, external };
}

async function step(name, page, fn) {
  const t0 = Date.now();
  const notes = [];
  let ok = true;
  let failure = '';
  try {
    await fn(notes);
  } catch (e) {
    ok = false;
    failure = String(e?.message ?? e).split('\n')[0];
  }
  await page.waitForTimeout(400); // let the entrance animation settle before the evidence shot
  const file = `${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: path.join(out, file) }).catch(() => undefined);
  results.push({ name, ok, ms: Date.now() - t0, notes, failure, screenshot: file });
  console.log(ok ? 'PASS' : 'FAIL', name, failure || notes.join('; '));
}

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const calls = (page) => page.evaluate(() => window.__FIXTURE_VOICE__.calls.map((c) => c.join(':')));
const tracks = (page) => page.evaluate(() => window.__streams.flatMap((s) => s.getAudioTracks().map((t) => t.readyState)));
const levels = (page) => page.evaluate(() => [...document.querySelectorAll('.vx-meter i')].map((i) => Number(getComputedStyle(i).getPropertyValue('--l') || 0)));

async function main() {
  const { chromium } = await loadPlaywright();
  const { server, origin } = await serveDist();
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const { page, errors, external, context } = await open(browser, origin);
    const ptt = page.locator('button.ptt');

    await step('rest-consent-off', page, async (notes) => {
      expect(await ptt.isDisabled(), 'Talk is disabled before in-app consent');
      expect((await tracks(page)).length === 0, 'no microphone stream on load');
      await page.locator('.voice-pop > summary').click();
      await page.getByLabel('Allow the microphone in Desktop Companion').click();
      expect(!(await ptt.isDisabled()), 'Talk is enabled after consent');
      expect((await tracks(page)).length === 0, 'turning consent on does not open the microphone');
      await page.locator('.voice-pop > summary').click();
      notes.push('consent on, still no stream');
    });

    await step('listening-real-level', page, async (notes) => {
      await ptt.click();
      await page.waitForSelector('.vx-bar.is-listening', { timeout: 8000 });
      await page.waitForTimeout(1800);
      const l = await levels(page);
      expect(l.some((v) => v > 0), `the meter shows a real level from the fake device (${l.join(',')})`);
      expect((await tracks(page)).includes('live'), 'the stream is live while listening');
      expect((await page.locator('.vx-time').textContent())?.startsWith('0:0'), 'elapsed time shown');
      notes.push(`levels ${l.filter((v) => v > 0).length}/${l.length} lit, max ${Math.max(...l)}`);
    });

    await step('transcribing', page, async () => {
      await ptt.click();
      await page.waitForSelector('.vx-bar.is-transcribing', { timeout: 4000 });
      expect((await tracks(page)).every((t) => t === 'ended'), 'the microphone closed when listening stopped');
    });

    await step('transcript-for-review', page, async (notes) => {
      await page.waitForFunction(() => document.querySelector('#chat-input')?.value.includes('[fixture transcript 1:'), null, { timeout: 8000 });
      expect(!(await page.locator('.vx-bar').count()), 'the bar leaves when the work is done');
      const c = await calls(page);
      expect(c.some((x) => /^transcribe:\d+:true$/.test(x)), `a real WAV reached the bridge (${c.join(' ')})`);
      expect(!c.some((x) => x.startsWith('speak')), 'nothing was read aloud or sent');
      const text = await page.locator('#chat-input').inputValue();
      notes.push(text);
      expect(/Transcript added to the message box/.test(await page.locator('.chat-notes').innerText()), 'the review note is shown');
    });

    await step('cancel-while-transcribing', page, async (notes) => {
      await page.locator('#chat-input').fill('');
      await ptt.click();
      await page.waitForSelector('.vx-bar.is-listening');
      await page.waitForTimeout(900);
      await ptt.click();
      await page.waitForSelector('.vx-bar.is-transcribing');
      await page.locator('.vx-bar').getByRole('button', { name: 'Cancel' }).click();
      expect(!(await page.locator('.vx-bar').count()), 'cancel ends the voice state at once');
      await page.waitForTimeout(2200);
      expect((await page.locator('#chat-input').inputValue()) === '', 'the cancelled clip never reaches the message box');
      const c = await calls(page);
      expect(c.includes('transcribeCancel'), 'the cancel reached the backend');
      expect(c.some((x) => x.startsWith('transcribe-discarded')), 'the backend discarded the result');
      notes.push((await page.locator('.chat-notes').innerText()).trim());
    });

    await step('escape-cancels-listening', page, async () => {
      const before = (await calls(page)).length;
      await ptt.click();
      await page.waitForSelector('.vx-bar.is-listening');
      await page.waitForTimeout(500);
      await ptt.press('Escape');
      expect(!(await page.locator('.vx-bar').count()), 'Esc ends listening');
      await page.waitForTimeout(300);
      expect((await tracks(page)).every((t) => t === 'ended'), 'the microphone closed');
      expect((await calls(page)).length === before, 'nothing was transcribed');
      expect(/Recording cancelled\. Nothing was transcribed\./.test(await page.locator('.chat-notes').innerText()), 'the cancel is explained');
    });

    await step('reading-aloud', page, async (notes) => {
      await page.locator('#chat-input').fill('Plan the review in three steps');
      await page.locator('#chat-input').press('Enter');
      const read = page.getByRole('button', { name: 'Read this reply aloud' }).last();
      await read.waitFor({ timeout: 10000 });
      await page.locator('article.msg-assistant').last().hover();
      await read.click();
      await page.waitForSelector('.vx-bar.is-speaking');
      expect(await page.getByRole('button', { name: 'Stop reading this reply' }).count() === 1, 'the reply button turns into Stop');
      const c = await calls(page);
      notes.push(c.filter((x) => x.startsWith('speak')).join(' '));
    });

    await step('stop-reading', page, async () => {
      await page.locator('.vx-bar').getByRole('button', { name: 'Stop reading' }).click();
      expect(!(await page.locator('.vx-bar').count()), 'stop ends the reading state at once');
      await page.waitForTimeout(200);
      expect((await calls(page)).includes('speechStop'), 'the stop reached the backend');
      expect(!/Read aloud was stopped|failed/i.test(await page.locator('.chat-notes').innerText()), 'a stop the person asked for is not shown as an error');
    });

    await step('talk-interrupts-reading', page, async () => {
      const stops = (await calls(page)).filter((x) => x === 'speechStop').length;
      await page.locator('article.msg-assistant').last().hover();
      await page.getByRole('button', { name: 'Read this reply aloud' }).last().click();
      await page.waitForSelector('.vx-bar.is-speaking');
      await ptt.click();
      await page.waitForSelector('.vx-bar.is-listening');
      expect((await calls(page)).filter((x) => x === 'speechStop').length === stops + 1, 'pressing Talk stopped the voice first');
    });

    await step('leaving-the-page-stops-everything', page, async (notes) => {
      expect((await tracks(page)).includes('live'), 'listening before navigation');
      await page.evaluate(() => { location.hash = '#/home'; });
      await page.waitForTimeout(600);
      expect((await tracks(page)).every((t) => t === 'ended'), 'navigation closed the microphone');
      await page.evaluate(() => { location.hash = '#/assistant'; });
      await page.waitForSelector('#chat-input');
      await page.locator('article.msg-assistant').last().hover();
      await page.getByRole('button', { name: 'Read this reply aloud' }).last().click();
      await page.waitForSelector('.vx-bar.is-speaking');
      const stops = (await calls(page)).filter((x) => x === 'speechStop').length;
      await page.evaluate(() => { location.hash = '#/home'; });
      await page.waitForTimeout(400);
      expect((await calls(page)).filter((x) => x === 'speechStop').length === stops + 1, 'navigation stopped read-aloud');
      notes.push(`tracks: ${(await tracks(page)).join(',')}`);
    });

    results.push({ name: 'page-health', ok: errors.length === 0 && external.length === 0, notes: [`console errors: ${errors.length}`, `external requests: ${external.length}`], failure: errors[0] ?? external[0] ?? '' });
    await context.close();

    // Reduced motion: the same listening state without animation (still a real level).
    const rm = await open(browser, origin, { reducedMotion: true });
    await step('listening-reduced-motion', rm.page, async (notes) => {
      await rm.page.locator('.voice-pop > summary').click();
      await rm.page.getByLabel('Allow the microphone in Desktop Companion').click();
      await rm.page.locator('.voice-pop > summary').click();
      await rm.page.locator('button.ptt').click();
      await rm.page.waitForSelector('.vx-bar.is-listening');
      await rm.page.waitForTimeout(1200);
      const anim = await rm.page.evaluate(() => getComputedStyle(document.querySelector('.vx-bar'), '::before').animationName);
      expect(anim === 'none', `no ring animation under reduced motion (${anim})`);
      notes.push(`ring animation: ${anim}`);
      await rm.page.locator('.vx-bar').getByRole('button', { name: 'Cancel' }).click();
    });
    await rm.context.close();

    // No recognizer and no voice (what a Linux or a stripped Windows install reports): Talk stays off and says why.
    const off = await open(browser, origin, { fixture: { stt: false, tts: false, speech: undefined } });
    await step('unavailable-says-why', off.page, async (notes) => {
      const talk = off.page.locator('button.ptt');
      expect(await talk.isDisabled(), 'Talk is disabled');
      await off.page.locator('.voice-pop > summary').click();
      const panel = await off.page.locator('.voice-pop-panel').innerText();
      expect(/Speech recognition unavailable/.test(panel) && /Fixture backend has no speech recognizer/.test(panel), 'the engine reason is shown');
      expect((await tracks(off.page)).length === 0, 'no microphone stream');
      expect((await calls(off.page)).length === 0, 'no voice call was made');
      notes.push(panel.split('\n').slice(0, 2).join(' / '));
    });
    await off.context.close();
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(out, 'voice-journey.json'), `${JSON.stringify({ environment: 'Linux Chromium (Playwright), fake microphone, fixture bridge with scripted speech', results }, null, 2)}\n`);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
