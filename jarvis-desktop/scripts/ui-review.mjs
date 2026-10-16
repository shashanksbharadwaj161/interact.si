// Visual review captures for the UI revamp. Serves the built renderer (dist/) on 127.0.0.1 only and opens it in a local
// Chromium through Playwright. Each scenario injects tests/fixtures/fixture-bridge.js (labelled test data, no network,
// no model, no keys) or uses the built-in browser preview bridge, then saves a PNG. These are composition evidence only:
// they do not prove motion, native Windows behaviour or the installed app.
//
// Usage: npm run build (or npx vite build) first, then
//   node scripts/ui-review.mjs --out=../planning/ui-revamp/after [--only=today,assistant] [--sizes=1280x720,1440x900]
// Playwright is resolved from PLAYWRIGHT_MODULE, then the local package, then a global install.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = path.resolve(arg('out', path.join(root, '..', 'planning', 'ui-revamp', 'after')));
const only = arg('only', '').split(',').filter(Boolean);
const sizes = arg('sizes', '1280x720').split(',').map((s) => s.split('x').map(Number));
const themes = arg('themes', 'light,dark').split(',');

export async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try {
      const req = createRequire(path.join(root, 'package.json'));
      return req(c);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('Playwright is not available. Set PLAYWRIGHT_MODULE to its path.');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
export function serveDist() {
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/index.html is missing: build the renderer first.');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const file = path.normalize(path.join(dist, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!file.startsWith(dist) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

export const FIXTURE_SRC = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'fixture-bridge.js'), 'utf8');

/** Opens a page with an isolated profile, the given fixture config (or the preview bridge) and preferences. */
export async function openPage(browser, origin, { width, height, theme, fixture, prefs = {}, hash = '#/home', reducedMotion = false, scale = 1 }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  const external = [];
  context.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !/^(data|blob|about):/.test(u)) external.push(u);
  });
  await context.addInitScript(({ prefs: p, fixture: f, src }) => {
    if (sessionStorage.getItem('review.init')) return;
    sessionStorage.setItem('review.init', '1');
    localStorage.clear();
    for (const [k, v] of Object.entries(p)) localStorage.setItem(`jarvis.ui.${k}`, JSON.stringify(v));
    if (f) localStorage.setItem('review.fixture', JSON.stringify(f));
  }, { prefs, fixture, src: '' });
  if (fixture) {
    await context.addInitScript(({ src }) => {
      const f = localStorage.getItem('review.fixture');
      if (!f) return;
      window.__FIXTURE__ = JSON.parse(f);
      // eslint-disable-next-line no-new-func
      new Function(src)();
    }, { src: FIXTURE_SRC });
  } else {
    await context.addInitScript(({ onboarded }) => {
      if (sessionStorage.getItem('review.preview')) return;
      sessionStorage.setItem('review.preview', '1');
      if (onboarded) localStorage.setItem('jarvis.preview.state.v1', JSON.stringify({ settings: { onboarded: true } }));
    }, { onboarded: prefs.__previewOnboarded ?? true });
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${origin}/${hash}`);
  await page.waitForTimeout(900);
  return { context, page, errors, external };
}

const SCENARIOS = [
  { name: 'onboarding-welcome', hash: '#/home', fixture: { onboarded: false } },
  { name: 'today-empty', hash: '#/home', fixture: { seed: 'empty' } },
  { name: 'today-populated', hash: '#/home', fixture: { seed: 'populated' } },
  { name: 'today-ai-blocked', hash: '#/home', fixture: { seed: 'populated', chat: 'unavailable' } },
  { name: 'assistant-empty', hash: '#/assistant', fixture: { seed: 'populated' } },
  { name: 'assistant-blocked', hash: '#/assistant', fixture: { seed: 'populated', chat: 'unavailable' } },
  { name: 'studio', hash: '#/companion', fixture: { seed: 'populated' } },
  { name: 'check-failed', hash: '#/home', fixture: { seed: 'populated', systemError: 'System information is unavailable.' } },
  { name: 'preview-bridge-today', hash: '#/home', fixture: null },
];

async function main() {
  const { chromium } = await loadPlaywright();
  const { server, origin } = await serveDist();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  fs.mkdirSync(out, { recursive: true });
  const report = [];
  try {
    for (const sc of SCENARIOS.filter((s) => !only.length || only.includes(s.name))) {
      for (const [width, height] of sizes) {
        for (const theme of themes) {
          const { context, page, errors, external } = await openPage(browser, origin, { width, height, theme, fixture: sc.fixture, prefs: { 'appearance.theme': theme, ...(sc.prefs ?? {}) }, hash: sc.hash });
          if (sc.act) await sc.act(page);
          await page.waitForTimeout(500);
          const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
          const file = `${sc.name}-${width}x${height}-${theme}.png`;
          await page.screenshot({ path: path.join(out, file) });
          report.push({ file, errors, external, overflowX });
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'capture-report.json'), JSON.stringify(report, null, 2));
  for (const r of report) console.log(`${r.file}${r.errors.length ? ` errors=${r.errors.length}: ${r.errors[0]}` : ''}${r.external.length ? ` EXTERNAL=${r.external.length}` : ''}${r.overflowX ? ' OVERFLOW-X' : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
