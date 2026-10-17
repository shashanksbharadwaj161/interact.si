// Native companion review: drives the real desktop companion (island window, region overlay, preloads, IPC checks, tool
// loop, task store, undo) in a throwaway profile and records what happened, with screenshots.
//
// Run (Linux CI/Xvfb or Windows):  npm run build && node scripts/build-main.mjs && <serve dist on 127.0.0.1:5173>
//   VITE_DEV_SERVER_URL=http://127.0.0.1:5173 npx electron scripts/companion-review.cjs [--no-sandbox]
//
// Review-only substitutions, all inside this script and never in the app:
//   1. PROVIDER: a scripted Anthropic Messages endpoint replaces global fetch for https://api.anthropic.com/v1/messages.
//      Its replies are written below; they are not Claude. Every other fetch is refused, so nothing leaves the machine.
//   2. KEY PROTECTION: a reversible stand-in for Windows key protection (the real protector is Windows only). The key is
//      a placeholder string, not a credential.
//   3. CONFIRMATION: the Windows confirmation dialog is answered by this script from a queue, and its text is recorded.
//      The app's own rule still applies first: no dialog unless the island is visible and focused.
// Everything else is the shipping code path. The report says which parts are scripted.
const electron = require('electron');
const {app, BrowserWindow, dialog, safeStorage} = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = path.resolve(root, '..', 'planning', 'ui-revamp', 'native-companion');
fs.mkdirSync(outDir, {recursive: true});
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-companion-review-'));
app.setPath('userData', data);
delete process.env.JARVIS_TEST_MODE;
const W = 1280;
const H = 720;
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const report = {scripted: ['provider replies (not Claude)', 'key protection stand-in', 'confirmation answers'], steps: [], requests: [], dialogs: [], errors: []};
const step = (name, facts) => { report.steps.push({name, ...facts}); console.log('STEP', name, JSON.stringify(facts)); };
const timeout = setTimeout(() => { report.errors.push('timed out'); finish(1); }, 240_000);
function finish(code) {
  clearTimeout(timeout);
  fs.writeFileSync(path.join(outDir, 'review-report.json'), JSON.stringify(report, null, 2));
  try { fs.rmSync(data, {recursive: true, force: true}); } catch { /* temp */ }
  app.exit(code);
}

/* ---------- 2. Key protection stand-in ---------- */
safeStorage.isEncryptionAvailable = () => true;
safeStorage.encryptString = (s) => Buffer.from(`review:${Buffer.from(s, 'utf8').toString('base64')}`, 'utf8');
safeStorage.decryptString = (b) => Buffer.from(b.toString('utf8').slice(7), 'base64').toString('utf8');

/* ---------- 3. Confirmation answers ---------- */
const answers = [];
dialog.showMessageBox = async (_w, o) => {
  const response = answers.length ? answers.shift() : 0;
  report.dialogs.push({message: o.message, detail: o.detail, buttons: o.buttons, defaultId: o.defaultId, answered: o.buttons[response]});
  await sleep(500);
  return {response};
};

/* ---------- 1. Scripted provider ---------- */
let handler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.anthropic.com/v1/messages')) throw new TypeError(`review: request to ${new URL(u).host} refused`);
  const body = JSON.parse(init.body);
  const h = init.headers instanceof Headers ? Object.fromEntries(init.headers) : {...init.headers};
  const first = body.messages[0].content;
  report.requests.push({
    method: init.method, keyHeader: !!h['x-api-key'], authorization: !!h.authorization, version: h['anthropic-version'], model: body.model,
    tools: body.tools.map((t) => t.name), messages: body.messages.length,
    image: first.filter((b) => b.type === 'image').map((b) => ({media_type: b.source.media_type, base64Chars: b.source.data.length})),
  });
  if (!handler) throw new TypeError('review: no scripted reply');
  return handler(body, init.signal);
};
void realFetch;
const reply = (content, stop = 'end_turn') => new Response(JSON.stringify({id: 'msg_review', type: 'message', role: 'assistant', model: 'scripted-review', content, stop_reason: stop, usage: {input_tokens: 10, output_tokens: 10}}), {status: 200, headers: {'content-type': 'application/json'}});
const text = (t) => ({type: 'text', text: t});
const toolUse = (id, name, input) => ({type: 'tool_use', id, name, input});
const lastResults = (body) => body.messages.at(-1).content.filter((b) => b.type === 'tool_result');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), {name: 'AbortError'})); });
});

/* ---------- Helpers ---------- */
const windows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
const byUrl = (re) => windows().find((w) => re.test(w.webContents.getURL()));
const islandWin = () => byUrl(/\/companion\.html$/);
const overlayWin = () => byUrl(/\/companion\.html#overlay$/);
const hubWin = () => byUrl(/\/index\.html|:5173\/(#.*)?$/);
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(80);
  }
}
const js = (w, code) => w.webContents.executeJavaScript(code, true);
const surface = () => js(islandWin(), `document.querySelector('.island')?.dataset.surface ?? null`);
const edge = () => js(islandWin(), `document.querySelector('.island')?.dataset.edge ?? null`);
const atSurface = (s, ms) => until(async () => (await surface()) === s, ms, `surface ${s}`);
async function invoke() {
  const w = islandWin();
  w.show();
  w.focus();
  w.webContents.send('companion:event', {type: 'invoke'});
  await atSurface('command');
  await sleep(450);
}
async function typeAndAsk(t) {
  const w = islandWin();
  await js(w, `document.querySelector('#cmp-input')?.focus()`);
  w.webContents.insertText(t);
  await sleep(120);
  w.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Enter'});
  w.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Enter'});
}
async function key(w, keyCode) {
  w.webContents.sendInputEvent({type: 'keyDown', keyCode});
  w.webContents.sendInputEvent({type: 'keyUp', keyCode});
}
const click = (w, selector) => js(w, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector.split('|')[0])})].find((e) => ${selector.includes('|') ? `e.textContent.includes(${JSON.stringify(selector.split('|')[1])})` : 'true'}); if (!el) return false; el.click(); return true; })()`);

let shot = 0;
async function capture(name, {withHub = true} = {}) {
  const isl = islandWin();
  const ib = isl.getBounds();
  const islandPng = path.join(data, `${name}-island.png`);
  fs.writeFileSync(islandPng, (await isl.webContents.capturePage()).toPNG());
  const out = path.join(outDir, `${String(++shot).padStart(2, '0')}-${name}.jpg`);
  if (withHub) {
    const hubPng = path.join(data, `${name}-hub.png`);
    fs.writeFileSync(hubPng, (await hubWin().webContents.capturePage()).toPNG());
    const hb = hubWin().getBounds();
    // Composite for review: the island window's own pixels (with its transparent margin) over the hub window's pixels,
    // at their real screen positions. Real Windows composition and acrylic are a separate Windows check.
    execFileSync('convert', ['-size', `${W}x${H}`, 'xc:#05070b', hubPng, '-geometry', `+${hb.x}+${hb.y}`, '-composite', islandPng, '-geometry', `+${ib.x}+${ib.y}`, '-composite', '-quality', '86', out]);
  } else {
    execFileSync('convert', [islandPng, '-background', '#05070b', '-flatten', '-quality', '88', out]);
  }
  return {file: path.relative(path.resolve(root, '..'), out).replace(/\\/g, '/'), island: ib};
}

require(path.join(root, 'dist-electron', 'main.cjs'));

app.whenReady().then(async () => {
  try {
    await until(() => hubWin() && islandWin(), 15000, 'hub and island windows');
    const hub = hubWin();
    await until(async () => !hub.webContents.isLoading() && !islandWin().webContents.isLoading(), 15000, 'pages loaded');
    hub.setBounds({x: 0, y: 0, width: W, height: H});
    hub.show();

    // A fresh profile: finish first run and add saved items the companion can find.
    await js(hub, `window.jarvis.saveSettings({onboarded: true})`);
    const notes = [
      {title: 'Router reset steps', body: 'Hold the reset pin 10 s, wait for the amber light, then sign in at 192.168.1.1 with the label password. Re-pair the mesh last.', tags: ['home']},
      {title: 'Quarterly review notes', body: 'Wins: offline search shipped. Risks: calendar import needs a recurring-event test.', tags: ['work']},
    ];
    for (const n of notes) await js(hub, `window.jarvis.saveNote(${JSON.stringify(n)})`);
    hub.webContents.reload();
    await until(async () => !hub.webContents.isLoading(), 15000, 'hub reloaded');
    await sleep(600);
    await js(hub, `location.hash = '#/notes'`);
    await sleep(1200);

    // Rest, not connected.
    await until(async () => (await surface()) === 'rest', 8000, 'rest');
    await sleep(800);
    step('rest-not-connected', {surface: await surface(), edge: await edge(), focusedAtRest: islandWin().isFocused(), skipTaskbar: true, ...(await capture('rest-not-connected'))});

    await invoke();
    const disabled = await js(islandWin(), `document.querySelector('#cmp-input').disabled`);
    step('command-not-connected', {surface: await surface(), inputDisabled: disabled, reason: await js(islandWin(), `document.querySelector('.cmd-setup p')?.textContent`), requestsSoFar: report.requests.length, ...(await capture('command-not-connected'))});
    await key(islandWin(), 'Escape');
    await atSurface('rest');

    // Connect: online mode and a placeholder key through the hub's real IPC.
    await js(hub, `window.jarvis.setProviderKey('anthropic', 'sk-ant-review-placeholder-not-a-key-0000000000')`);
    // Going online is itself a confirmed change in the hub (its own trusted dialog, owned by the focused hub window).
    hub.focus();
    await sleep(200);
    answers.push(1);
    await js(hub, `window.jarvis.saveSettings({mode: 'online', cloudProvider: 'anthropic'})`);
    step('online', {hubDialog: report.dialogs.at(-1)?.message, readiness: (await js(islandWin(), `window.companion.state()`)).readiness});

    /* Journey 4: find saved information with a citation. */
    handler = async (body, signal) => {
      await wait(900, signal);
      if (body.messages.length === 1) return reply([text('Let me look.'), toolUse('toolu_r1', 'search_saved', {query: 'router reset', limit: 4})], 'tool_use');
      const r = lastResults(body)[0];
      const id = /"id":"([A-Za-z0-9_-]+)"/.exec(r.content)?.[1] ?? 'missing';
      return reply([text(`Your note says: hold the reset pin for 10 seconds, wait for the amber light, then sign in at 192.168.1.1 with the password on the label. Re-pair the mesh last. [note:${id}]`)]);
    };
    await invoke();
    await typeAndAsk('Where did I put the router reset steps?');
    await atSurface('working', 4000);
    await until(async () => (await js(islandWin(), `document.querySelectorAll('.steps li').length`)) > 0, 6000, 'a step');
    step('j4-working', {surface: await surface(), edge: await edge(), steps: await js(islandWin(), `[...document.querySelectorAll('.steps li')].map((l) => l.className + ': ' + l.textContent)`), ...(await capture('j4-working'))});
    await atSurface('answer', 8000);
    await sleep(250);
    const cites = await js(islandWin(), `[...document.querySelectorAll('.cite')].map((c) => c.textContent)`);
    step('j4-answer-with-citation', {surface: await surface(), edge: await edge(), citations: cites, ...(await capture('j4-answer'))});
    await click(islandWin(), '.cite');
    await sleep(900);
    step('j4-citation-opens-hub', {hubHash: await js(hub, 'location.hash'), hubVisible: hub.isVisible(), ...(await capture('j4-citation-opens-hub'))});
    await click(islandWin(), '.p-foot .btn-primary');
    await atSurface('rest');

    /* Journey 1: ask about a selected screen region. */
    handler = async (body, signal) => {
      await wait(700, signal);
      const img = body.messages[0].content.find((b) => b.type === 'image');
      return reply([text(img ? 'This is the Notes list in the hub: two saved notes, "Router reset steps" and "Quarterly review notes", with the first one open. (Scripted review reply: the image was received, but this text was not generated by Claude.)' : 'No image arrived.')]);
    };
    await invoke();
    await click(islandWin(), '.chipbtn');
    await until(() => overlayWin(), 6000, 'overlay window');
    const ov = overlayWin();
    await until(async () => !ov.webContents.isLoading() && (await js(ov, `!!document.querySelector('.ov-shot')`)), 8000, 'frozen picture');
    await sleep(300);
    ov.webContents.sendInputEvent({type: 'mouseDown', x: 220, y: 90, button: 'left', clickCount: 1});
    for (let i = 1; i <= 10; i++) ov.webContents.sendInputEvent({type: 'mouseMove', x: 220 + i * 62, y: 90 + i * 34, button: 'left'});
    ov.webContents.sendInputEvent({type: 'mouseUp', x: 840, y: 430, button: 'left', clickCount: 1});
    await sleep(250);
    const ovPng = path.join(outDir, `${String(++shot).padStart(2, '0')}-j1-region-overlay.jpg`);
    fs.writeFileSync(path.join(data, 'ov.png'), (await ov.webContents.capturePage()).toPNG());
    execFileSync('convert', [path.join(data, 'ov.png'), '-quality', '86', ovPng]);
    step('j1-region-overlay', {islandHiddenDuringCapture: !islandWin().isVisible(), selection: await js(ov, `document.querySelector('.ov-size')?.textContent`), file: path.relative(path.resolve(root, '..'), ovPng).replace(/\\/g, '/')});
    await key(ov, 'Enter');
    await until(async () => !overlayWin() && (await js(islandWin(), `!!document.querySelector('.ctx-img')`)), 6000, 'region attached');
    await sleep(300);
    step('j1-region-attached', {overlayClosed: !overlayWin(), chip: await js(islandWin(), `document.querySelector('.ctx-chip')?.textContent`), ...(await capture('j1-region-attached'))});
    await typeAndAsk('What am I looking at here?');
    await atSurface('answer', 8000);
    await sleep(250);
    const imgReq = report.requests.at(-1);
    step('j1-answer', {imageSent: imgReq.image, ...(await capture('j1-answer'))});
    // Single use: asking again does not resend the picture.
    await click(islandWin(), '.p-foot .btn|Follow up');
    await atSurface('command');
    step('j1-region-single-use', {chipAfterAnswer: await js(islandWin(), `!!document.querySelector('.ctx-img')`)});

    /* Region cancel: Escape throws the picture away and returns to the command surface. */
    await click(islandWin(), '.chipbtn');
    await until(() => overlayWin(), 6000, 'overlay window');
    await until(async () => !overlayWin().webContents.isLoading(), 6000, 'overlay loaded');
    await sleep(300);
    await key(overlayWin(), 'Escape');
    await until(() => !overlayWin(), 6000, 'overlay closed');
    await sleep(300);
    step('region-escape', {overlayClosed: !overlayWin(), surface: await surface(), chip: await js(islandWin(), `!!document.querySelector('.ctx-img')`)});
    await key(islandWin(), 'Escape');
    await atSurface('rest');

    /* Journey 2: one reversible action (a task) with the Windows confirmation, verification and undo. */
    const taskCall = (title) => async (body, signal) => {
      await wait(700, signal);
      if (body.messages.length === 1) return reply([toolUse('toolu_t1', 'create_task', {title, due: '2026-10-17'})], 'tool_use');
      const r = lastResults(body)[0];
      if (r.is_error || /not confirmed/i.test(r.content)) return reply([text('Okay, I did not add it.')]);
      const id = /"id":"([A-Za-z0-9_-]+)"/.exec(r.content)?.[1] ?? 'missing';
      return reply([text(`Added "${title}" for tomorrow. [task:${id}]`)]);
    };
    handler = taskCall('Send the invoice to Priya');
    answers.push(1);
    await invoke();
    await typeAndAsk('Remind me to send the invoice to Priya tomorrow');
    await until(async () => (await edge()) === 'waiting', 6000, 'waiting for confirmation');
    step('j2-waiting-for-confirmation', {edge: await edge(), step: await js(islandWin(), `document.querySelector('.steps li')?.textContent`), ...(await capture('j2-waiting'))});
    await atSurface('answer', 8000);
    await sleep(250);
    const tasks = async () => (await js(hub, `window.jarvis.getState()`)).tasks.map((t) => t.title);
    step('j2-task-added', {receipt: await js(islandWin(), `document.querySelector('.receipts li')?.textContent`), tasksNow: await tasks(), dialog: report.dialogs.at(-1), ...(await capture('j2-added'))});
    await click(islandWin(), '.receipts .btn');
    await until(async () => (await js(islandWin(), `document.querySelector('.receipts .tag-ok')?.textContent`)) === 'undone', 4000, 'undone');
    step('j2-undo', {tasksNow: await tasks(), ...(await capture('j2-undone'))});
    await click(islandWin(), '.p-foot .btn-primary');
    await atSurface('rest');

    /* Journey 2, declined: Cancel in the confirmation saves nothing. */
    handler = taskCall('Book the dentist');
    answers.push(0);
    await invoke();
    await typeAndAsk('Add a task to book the dentist');
    await atSurface('answer', 8000);
    await sleep(250);
    step('j2-declined', {tasksNow: await tasks(), dialog: report.dialogs.at(-1), steps: await js(islandWin(), `[...document.querySelectorAll('.steps li')].map((l) => l.className)`), answer: await js(islandWin(), `document.querySelector('.ans-text')?.textContent`), ...(await capture('j2-declined'))});
    await click(islandWin(), '.p-foot .btn-primary');
    await atSurface('rest');

    /* Cancel: Escape during a request stops it; the provider request is aborted. */
    let aborted = false;
    handler = async (_b, signal) => {
      signal?.addEventListener('abort', () => { aborted = true; });
      await wait(6000, signal);
      return reply([text('too late')]);
    };
    await invoke();
    await typeAndAsk('Summarise everything I saved this week');
    await atSurface('working', 4000);
    await sleep(500);
    await key(islandWin(), 'Escape');
    await atSurface('error', 4000);
    await sleep(250);
    step('cancel', {providerRequestAborted: aborted, title: await js(islandWin(), `document.querySelector('.p-title strong')?.textContent`), message: await js(islandWin(), `document.querySelector('.ans-text')?.textContent`), edge: await edge(), ...(await capture('cancelled'))});
    await click(islandWin(), '.p-foot .btn-primary');
    await atSurface('rest');

    /* Provider failure and network failure. */
    handler = async () => new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {status: 529, headers: {'content-type': 'application/json'}});
    await invoke();
    await typeAndAsk('What is on my list today?');
    await atSurface('error', 6000);
    await sleep(250);
    step('provider-error', {title: await js(islandWin(), `document.querySelector('.p-title strong')?.textContent`), message: await js(islandWin(), `document.querySelector('.ans-text')?.textContent`), edge: await edge(), ...(await capture('provider-error'))});
    await click(islandWin(), '.p-foot .btn|Try again');
    await atSurface('command');
    handler = async () => { throw new TypeError('fetch failed'); };
    await typeAndAsk('What is on my list today?');
    await atSurface('error', 6000);
    await sleep(250);
    step('network-error', {title: await js(islandWin(), `document.querySelector('.p-title strong')?.textContent`), message: await js(islandWin(), `document.querySelector('.ans-text')?.textContent`), ...(await capture('network-error'))});
    await click(islandWin(), '.p-foot .btn-primary');
    await atSurface('rest');

    /* Offline again: nothing is sent. */
    const before = report.requests.length;
    await js(hub, `window.jarvis.saveSettings({mode: 'offline'})`);
    await invoke();
    step('offline-again', {inputDisabled: await js(islandWin(), `document.querySelector('#cmp-input').disabled`), reason: await js(islandWin(), `document.querySelector('.cmd-setup p')?.textContent`), newRequests: report.requests.length - before, ...(await capture('offline-again', {withHub: false}))});

    report.activity = (await js(hub, `window.jarvis.getState()`)).activity?.filter((a) => a.kind === 'companion').map((a) => a.summary);
    finish(0);
  } catch (e) {
    report.errors.push(String(e && e.stack));
    try { report.errors.push({surface: await surface(), island: await js(islandWin(), `document.querySelector('.island')?.innerText`), lastRequest: report.requests.at(-1), requests: report.requests.length}); } catch { /* best effort */ }
    console.error(e);
    finish(1);
  }
});
