// Production pet renderer in the real Electron app, with an isolated offline profile. The invocation is scripted;
// no keyboard, mouse, microphone, external app or provider request is used. Screenshots contain this app window only.
const {app, BrowserWindow, screen, session} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-companion-pet-'));
const evidence = path.join(root, '..', 'planning', 'ui-revamp', 'pet-art', 'first-light-motion-2026-10-18', 'qa');
app.setPath('userData', data);
delete process.env.JARVIS_TEST_MODE;
const results = [];
const errors = [];
const external = [];
const check = (name, ok, detail = {}) => {results.push({name, ok, ...detail}); if (!ok) errors.push(name);};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => {errors.push('test timeout'); finish();}, 60000);
function finish() {
  clearTimeout(timeout);
  fs.mkdirSync(evidence, {recursive: true});
  fs.writeFileSync(path.join(evidence, 'native-playback.json'), JSON.stringify({platform:process.platform, display:screen.getPrimaryDisplay().workArea, results, errors, externalRequests:external, scriptedInvocation:true, liveProvider:false}, null, 2));
  console.log(JSON.stringify({checks:results.length, errors, externalRequests:external.length}));
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(data));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(data).startsWith('desktop-companion-pet-')) {
    try {fs.rmSync(data, {recursive:true, force:true});} catch { /* Electron may still hold profile files until exit. */ }
  }
  app.exit(errors.length ? 1 : 0);
}
async function until(fn, label, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {const value = await fn(); if (value) return value; await delay(80);}
  throw new Error('Timed out: ' + label);
}
require(path.join(root, 'dist-electron', 'main.cjs'));
app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onCompleted(details => {if (!/^(file|data|blob|devtools):/.test(details.url)) external.push(details.url);});
    const island = await until(() => BrowserWindow.getAllWindows().find(w => /companion\.html$/.test(w.webContents.getURL())), 'companion page');
    await until(() => !island.webContents.isLoading(), 'companion loaded');
    island.showInactive();
    const js = code => island.webContents.executeJavaScript(code, true);
    const frame = () => js('document.querySelector(".pet-slot[data-kind=pet] canvas")?.dataset.petFrame ?? null');
    await until(frame, 'validated atlas drawn');
    check('validated character is drawn in the native companion', true, {frame:await frame()});
    check('draft animation is visibly labelled', await js('document.querySelector(".pet-review-tag")?.textContent === "Animation preview"'));
    await js('window.companion.gaze(false)');
    await js('window.__petRafTicks=0;window.__petCheckRaf=function(){window.__petRafTicks++; if(window.__petRafTicks<180)requestAnimationFrame(window.__petCheckRaf);};requestAnimationFrame(window.__petCheckRaf);true');
    // Exercise the production adapter and renderer with an explicitly scripted native event.
    island.webContents.send('companion:event', {type:'invoke'});
    const seen = [];
    const diagnostics = [];
    for (let i = 0; i < 9; i++) {
      seen.push(await frame());
      diagnostics.push(await js('({now:performance.now(),raf:window.__petRafTicks,hidden:document.hidden,motion:document.documentElement.dataset.motion,reason:document.querySelector(".pet-sr")?.textContent,rect:document.querySelector(".pet-slot canvas")?.getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight]})'));
      await delay(90);
    }
    const waveFrames = [...new Set(seen.filter(v => v?.startsWith('3:')))];
    check('invocation plays multiple distinct generated wave poses', waveFrames.length >= 2, {frames:seen,diagnostics});
    check('voice input is visible with microphone off and Talk blocked until consent', await js('!!document.querySelector(".pet-voice input[type=checkbox]") && !document.querySelector(".pet-voice input[type=checkbox]").checked && document.querySelector(".vx-talk")?.disabled === true'));
    const hub = BrowserWindow.getAllWindows().find(w => w !== island && /index\.html/.test(w.webContents.getURL()));
    if (!hub) throw new Error('Hub not found');
    await until(() => !hub.webContents.isLoading(), 'hub loaded');
    await hub.webContents.executeJavaScript('window.jarvis.saveSettings({reduceMotion:true})', true);
    await until(() => js('document.documentElement.dataset.motion === "reduced"'), 'native motion preference');
    check('saved reduced-motion setting reaches the separate companion document', true);
    await until(() => js('document.querySelector(".pet-slot canvas")?.dataset.petFrame === "0:0"'), 'reduced motion key pose');
    const stills = [await frame()]; await delay(250); stills.push(await frame()); await delay(250); stills.push(await frame());
    check('reduced motion keeps a single still pose', new Set(stills).size === 1, {frames:stills});
    island.hide();
    await until(() => js('document.hidden'), 'hidden renderer visibility');
    check('hidden window restores throttling and page visibility pause', island.webContents.getBackgroundThrottling());
    island.showInactive();
    await until(() => js('!document.hidden'), 'visible renderer resumes');
    await delay(150);
    fs.writeFileSync(path.join(evidence, 'native-companion.png'), (await island.webContents.capturePage()).toPNG());
    check('no external requests during native animation checks', external.length === 0);
  } catch (error) {errors.push(error.message);}
  finish();
});
