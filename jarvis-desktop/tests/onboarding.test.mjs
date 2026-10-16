// Onboarding, Settings, shell and Home: shared endpoint rule, model readiness, safe-launch banner source, visible branding.
// Bundles the real TypeScript in memory. No window, network, Electron or desktop input is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Components only need icon identifiers here, so replace the icon package with inert placeholders.
// The names are collected from the real imports so the stub cannot drift from the source.
const iconNames = new Set();
for (const dir of ['src/components', 'src/ui']) {
  for (const f of await readdir(path.join(root, dir))) {
    if (!/\.tsx?$/.test(f)) continue;
    const text = await readFile(path.join(root, dir, f), 'utf8');
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
        if (name) iconNames.add(name);
      }
    }
  }
}

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'onboarding-test-entry.ts',
    loader: 'ts',
    contents: `
      export * as onboarding from './src/components/Onboarding.tsx';
      export * as validation from './electron/services/validation.ts';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  // react-dom/server is CommonJS and needs Node builtins; a data: module has no require of its own.
  banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(root, 'package.json'))});` },
  plugins: [
    {
      name: 'icon-stub',
      setup(bld) {
        bld.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        bld.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({ contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';') }));
      },
    },
  ],
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { onboarding, validation, createElement, renderToStaticMarkup } = mod;

const backendAccepts = (v) => {
  try {
    validation.validateLocalEndpoint(v);
    return true;
  } catch {
    return false;
  }
};

test('the UI rejects exactly the endpoints the backend rejects', () => {
  const cases = [
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    'http://[::1]:11434',
    'http://127.0.0.1',
    'http://127.1:11434',
    'HTTP://LOCALHOST:11434',
    '  http://localhost:11434  ',
    'http://127.0.0.1:11434/some/path',
    'https://127.0.0.1:11434',
    'http://example.com',
    'http://192.168.1.5:11434',
    'http://0.0.0.0:11434',
    'http://user:secret@127.0.0.1:11434',
    'http://:secret@localhost:11434',
    'ftp://127.0.0.1',
    'localhost:11434',
    '127.0.0.1:11434',
    'not a url',
    '',
    '   ',
    'http://127.0.0.1\u0007:11434',
    'http://' + 'a'.repeat(200),
  ];
  for (const c of cases) {
    const ui = onboarding.localEndpointError(c);
    assert.equal(ui === null, backendAccepts(c), `parity for ${JSON.stringify(c)} (UI said ${JSON.stringify(ui)})`);
  }
});

test('endpoint messages say what to change', () => {
  assert.match(onboarding.localEndpointError(''), /Enter the address/);
  assert.match(onboarding.localEndpointError('https://localhost:11434'), /http:\/\//);
  assert.match(onboarding.localEndpointError('http://example.com'), /this computer/);
  assert.match(onboarding.localEndpointError('http://me:pw@localhost:11434'), /user name and password/);
  assert.equal(onboarding.localEndpointError('http://localhost:11434'), null);
});

test('model name rules match the backend settings validation', () => {
  const merge = (patch) => validation.mergeSettings(validation.DEFAULT_SETTINGS, patch);
  const accepts = (patch) => {
    try {
      merge(patch);
      return true;
    } catch {
      return false;
    }
  };
  for (const v of ['llama3.2:3b', '', '   ', 'x'.repeat(201), 'name\u0001']) {
    assert.equal(onboarding.localModelError(v) === null, accepts({ localModel: v }), `localModel ${JSON.stringify(v)}`);
  }
  for (const v of ['claude-fable-5-1', 'gpt.4:x_y', '', 'has space', 'bad/slash', 'x'.repeat(101), 'x'.repeat(100)]) {
    assert.equal(onboarding.cloudModelError(v) === null, accepts({ cloudModel: v }), `cloudModel ${JSON.stringify(v)}`);
  }
});

const settings = (over = {}) => ({ mode: 'offline', localEndpoint: 'http://127.0.0.1:11434', localModel: 'llama3.2:3b', cloudModel: 'cloud-model-1', ...over });
const cap = (id, available, reason) => ({ id, name: id, available, ...(reason ? { reason } : {}) });

test('offline readiness is Claude-first: AI is off unless a legacy local model proves it answers', () => {
  // Default settings carry a local model name; that alone must never read as connected AI, and Ollama is never the advice.
  const down = onboarding.modelReadiness({ settings: settings(), capabilities: [cap('local-llm', false, 'Ollama is not running at http://127.0.0.1:11434')], cloudConfigured: false });
  assert.equal(down.level, 'blocked');
  assert.equal(down.title, 'AI is not connected');
  assert.match(down.detail, /Connect Claude/);
  assert.doesNotMatch(down.title + down.detail, /ollama|pull/i, 'the normal flow never sends the user to install a local model');

  const up = onboarding.modelReadiness({ settings: settings(), capabilities: [cap('local-llm', true)], cloudConfigured: false });
  assert.equal(up.route, 'local');
  assert.equal(up.level, 'ready');
  assert.match(up.title, /Legacy local model/);
  assert.match(up.detail, /llama3\.2:3b/);
});

test('a missing legacy model is reported as AI not connected, without the local install hint', () => {
  const reason = 'Ollama is running but model "x" is not installed. Install it once with "ollama pull x"';
  const r = onboarding.modelReadiness({ settings: settings({ localModel: 'x' }), capabilities: [cap('local-llm', false, reason)], cloudConfigured: null });
  assert.equal(r.level, 'blocked');
  assert.doesNotMatch(r.detail, /ollama pull/);
});

test('unchecked or failed checks are "unknown", never "ready"', () => {
  assert.equal(onboarding.modelReadiness({ settings: settings(), capabilities: null, cloudConfigured: null }).level, 'unknown');
  assert.notEqual(onboarding.modelReadiness({ settings: settings(), capabilities: [], cloudConfigured: null }).level, 'ready', 'no local-llm answer is not a working model');
  const failed = onboarding.modelReadiness({ settings: settings(), capabilities: null, systemError: 'System information is unavailable.', cloudConfigured: null });
  assert.equal(failed.level, 'unknown');
  assert.match(failed.detail, /unavailable/);
  const failedWithCaps = onboarding.modelReadiness({ settings: settings(), capabilities: [cap('local-llm', true)], systemError: 'System information is unavailable.', cloudConfigured: null });
  assert.equal(failedWithCaps.level, 'unknown', 'a failed refresh never leaves a stale "ready"');
});

test('settings the backend would reject are never reported ready', () => {
  const caps = [cap('local-llm', true)];
  assert.equal(onboarding.modelReadiness({ settings: settings({ localEndpoint: 'https://example.com' }), capabilities: caps, cloudConfigured: null }).level, 'blocked');
  assert.equal(onboarding.modelReadiness({ settings: settings({ localModel: '' }), capabilities: caps, cloudConfigured: null }).level, 'blocked');
  assert.equal(onboarding.modelReadiness({ settings: settings({ mode: 'online', cloudModel: 'has space' }), capabilities: caps, cloudConfigured: true }).level, 'blocked');
});

test('online readiness depends on the saved key and ignores the local model', () => {
  const caps = [cap('local-llm', true)];
  const noKey = onboarding.modelReadiness({ settings: settings({ mode: 'online' }), capabilities: caps, cloudConfigured: false });
  assert.equal(noKey.route, 'cloud');
  assert.equal(noKey.level, 'blocked');
  assert.match(noKey.detail, /never switches to another provider or to a local model/);
  assert.equal(onboarding.modelReadiness({ settings: settings({ mode: 'online' }), capabilities: caps, cloudConfigured: null }).level, 'unknown');
  assert.equal(onboarding.modelReadiness({ settings: settings({ mode: 'online', cloudModel: '' }), capabilities: caps, cloudConfigured: true }).level, 'blocked');
  const ready = onboarding.modelReadiness({ settings: settings({ mode: 'online' }), capabilities: [cap('local-llm', false, 'Ollama is not running')], cloudConfigured: true });
  assert.equal(ready.level, 'ready');
  assert.match(ready.detail, /Whether the provider answers is shown in the conversation/, 'does not claim the provider was reached');
});

test('safe launch is detected only from the desktop-control capability reason', () => {
  assert.equal(onboarding.safeLaunchReason([cap('ui-automation', false, 'Safe launch is active')]), 'Safe launch is active');
  assert.equal(onboarding.safeLaunchReason([cap('ui-automation', false, 'Requires Windows')]), null);
  assert.equal(onboarding.safeLaunchReason([cap('ui-automation', true, 'Every action needs a preview and your approval')]), null);
  assert.equal(onboarding.safeLaunchReason([cap('cloud', false, 'Safe launch is active')]), null);
  assert.equal(onboarding.safeLaunchReason(null), null);
});

test('the readiness notice shows the reason and a Check again control', () => {
  const blocked = onboarding.modelReadiness({ settings: settings({ mode: 'online' }), capabilities: [], cloudConfigured: false });
  const html = renderToStaticMarkup(createElement(onboarding.ModelReadinessNotice, { readiness: blocked, onRecheck: () => undefined }));
  assert.match(html, /No API key is saved/);
  assert.match(html, /save your key in Connect AI/);
  assert.match(html, /Check again/);
  assert.match(html, /notice-warn/);

  const ready = onboarding.modelReadiness({ settings: settings(), capabilities: [cap('local-llm', true)], cloudConfigured: null });
  const ok = renderToStaticMarkup(createElement(onboarding.ModelReadinessNotice, { readiness: ready }));
  assert.match(ok, /Legacy local model is answering/);
  assert.doesNotMatch(ok, /Check again/, 'no button without a handler');
  assert.doesNotMatch(ok, /notice-warn/);
});

const read = (p) => readFile(path.join(root, p), 'utf8');
const OWNED = ['src/components/Onboarding.tsx', 'src/components/Settings.tsx', 'src/components/App.tsx', 'src/components/Home.tsx'];

test('the working name does not appear in the owned screens', async () => {
  for (const f of OWNED) assert.doesNotMatch(await read(f), /jarvis/i, `${f} must not mention the working name`);
});

test('the owned screens no longer make claims the backend contradicts', async () => {
  // Comments may name the backend; only the text users can read is checked.
  const src = (await Promise.all(OWNED.map(read))).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /does not probe|does not test the connection|only known when you send/i, 'the backend does probe Ollama');
  assert.doesNotMatch(src, /would leave this machine/, 'remote endpoints are rejected, not warned about');
  assert.doesNotMatch(src, /no key is requested here/i, 'online setup now has a key step');
  assert.doesNotMatch(src, /nothing is sent elsewhere/i, 'a failed cloud request may have reached the provider');
  assert.doesNotMatch(src, /\bthe backend\b/i, 'visible copy says what the user can act on');
});

test('first run never saves AI settings itself, and the AI setup refuses a model name the backend would reject', async () => {
  const src = await read('src/components/Onboarding.tsx');
  assert.doesNotMatch(src, /saveSettings\(\{[^}]*(cloudModel|localModel|localEndpoint)/, 'first run only marks setup finished and saves appearance');
  const setup = await read('src/components/AiSetup.tsx');
  assert.match(setup, /if \(!id \|\| cloudModelError\(id\)\) return;/);
  assert.match(setup, /disabled=\{!target \|\| Boolean\(cloudModelError\(target\)\)\}/);
});

test('the shell labels icon-only navigation and shows the safe-launch banner', async () => {
  const src = await read('src/components/App.tsx');
  assert.match(src, /aria-label=\{v\.label\}/, 'links stay named when the compact sidebar hides their text');
  assert.match(src, /<RecoveryBanner \/>/);
  assert.doesNotMatch(src, /Alt\+11/);
});
