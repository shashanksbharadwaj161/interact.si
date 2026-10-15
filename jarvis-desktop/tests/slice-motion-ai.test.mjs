import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function load(entry) {
  const bundle = await build({entryPoints:[path.join(root, entry)], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
  const code = bundle.outputFiles[0].text;
  return {code, m: await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)};
}
const {code: aiCode, m: ai} = await load('src/ui/motion-ai.ts');
const {m: spec} = await load('src/ui/scene-spec.ts');
const {m: presets} = await load('src/ui/motion-presets.ts');
const {MOTION_AI_LIMITS, buildMotionRequest, extractJsonCandidate, validateGeneratedScene, describeDestination, runMotionGeneration} = ai;

const validSpec = () => JSON.parse(spec.serializeSceneSpec(spec.composeSceneFromText('busy red particles').spec));
const validJson = () => JSON.stringify(validSpec());

test('motion-ai module is pure: no DOM, storage, clock, randomness or direct network', async () => {
  assert.equal(/\bdocument\b|\bwindow\b|localStorage|Date\.now|Math\.random|\bfetch\(|XMLHttpRequest/.test(aiCode), false);
  const src = await readFile(path.join(root, 'src/ui/motion-ai.ts'), 'utf8');
  assert.doesNotMatch(src, /https?:\/\//);
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ['./motion-presets', './scene-spec']);
  assert.match(src, /validateSceneSpec\(candidate\)/, 'uses the existing parser');
});

test('buildMotionRequest: frozen, preview is the exact prompt, schema derived from parser exports, JSON only', () => {
  const r = buildMotionRequest({description: '  slow violet aurora  ', reducedMotion: false});
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.warnings));
  assert.equal(r.preview, r.prompt);
  assert.equal(r.sentChars, r.prompt.length);
  assert.deepEqual(r.warnings, []);
  assert.match(r.prompt, /JSON object and nothing else/);
  assert.ok(r.prompt.includes(`"format": "${spec.SCENE_SPEC_FORMAT}"`));
  assert.ok(r.prompt.includes(`"version": ${spec.SCENE_SPEC_VERSION}`));
  for (const k of presets.ALL_MOTION_KINDS) assert.ok(r.prompt.includes(`"${k.id}"`), k.id);
  for (const key of ['intensity', 'speed', 'hue']) assert.ok(r.prompt.includes(`"${key}": integer from ${presets.LIMITS[key].min} to ${presets.LIMITS[key].max}`), key);
  assert.ok(r.prompt.includes(`at most ${presets.MAX_PRESET_NAME} characters`));
  assert.ok(r.prompt.includes(String(spec.MAX_SCENE_SPEC_CHARS)));
  assert.match(r.prompt, /"""\nslow violet aurora\n"""$/);
  // The embedded example is accepted by the existing parser.
  const example = /Example of a valid reply: (\{.*\})/.exec(r.prompt)[1];
  assert.equal(spec.validateSceneSpec(example).ok, true);
  assert.doesNotMatch(r.prompt, /reduced motion/);
  const rm = buildMotionRequest({description: 'x', reducedMotion: true});
  assert.ok(rm.prompt.includes(`at or below ${spec.COMPOSE_VALUES.slowSpeed}`));
  const based = buildMotionRequest({description: 'x', reducedMotion: false, baseSceneId: 'builtin:orbit'});
  assert.match(based.prompt, /Violet orbit/);
  const unknown = buildMotionRequest({description: 'x', reducedMotion: false, baseSceneId: 'p-mine'});
  assert.doesNotMatch(unknown.prompt, /p-mine/);
  assert.equal(unknown.warnings.length, 1);
});

test('buildMotionRequest: description cap, control characters and empty input', () => {
  assert.equal(MOTION_AI_LIMITS.descriptionChars, 1000);
  const long = buildMotionRequest({description: 'a'.repeat(5000), reducedMotion: false});
  assert.ok(long.prompt.includes('a'.repeat(1000)));
  assert.equal(long.prompt.includes('a'.repeat(1001)), false);
  assert.ok(long.warnings.some((w) => /cut to 1000/.test(w)));
  const ctl = buildMotionRequest({description: 'teal\u0000\u0007 waves', reducedMotion: false});
  assert.equal(/[\u0000\u0007]/.test(ctl.prompt), false);
  assert.ok(ctl.warnings.some((w) => /Control characters/.test(w)));
  for (const bad of ['', '   \n', undefined, 42]) assert.throws(() => buildMotionRequest({description: bad, reducedMotion: false}), /Describe the scene/);
});

test('extractJsonCandidate: fences, prose, nested braces in strings, and no JSON', () => {
  const json = validJson();
  assert.equal(extractJsonCandidate(json), json);
  assert.equal(extractJsonCandidate('```json\n' + json + '\n```'), json);
  assert.equal(extractJsonCandidate('Sure! Here it is:\n```\n' + json + '\n```\nEnjoy.'), json);
  assert.equal(extractJsonCandidate(`Here you go ${json} hope it helps {not json}`), json);
  assert.equal(extractJsonCandidate('Use {braces} like this: ' + json), json, 'prefers a parseable object');
  const tricky = JSON.stringify({...validSpec(), name: 'a } b { c "q"'});
  assert.equal(extractJsonCandidate(`x ${tricky} y`), tricky);
  assert.equal(extractJsonCandidate('no json here'), null);
  assert.equal(extractJsonCandidate('{ unbalanced'), null);
  assert.equal(extractJsonCandidate(''), null);
  assert.equal(extractJsonCandidate(null), null);
});

test('validateGeneratedScene: accepts a known-valid spec and rejects bad JSON with parser-sourced errors', () => {
  const ok = validateGeneratedScene('Here:\n```json\n' + validJson() + '\n```');
  assert.equal(ok.ok, true);
  assert.deepEqual({...ok.spec}, spec.validateSceneSpec(validJson()).spec);
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.spec));
  assert.ok(ok.warnings.some((w) => /around the JSON/.test(w)));
  const exact = validateGeneratedScene(validJson());
  assert.deepEqual(exact.warnings, []);

  const parserErrors = (obj) => spec.validateSceneSpec(obj).errors.map((e) => `${e.path || '(root)'}: ${e.message}`);
  const unknownKind = {...validSpec(), kind: 'tornado'};
  const r1 = validateGeneratedScene(JSON.stringify(unknownKind));
  assert.equal(r1.ok, false);
  assert.deepEqual([...r1.errors], parserErrors(unknownKind));
  assert.match(r1.errors[0], /^kind: Unknown kind "tornado"/);
  const over = {...validSpec(), intensity: 101, hue: 999};
  const r2 = validateGeneratedScene(JSON.stringify(over));
  assert.deepEqual([...r2.errors], parserErrors(over));
  assert.equal(r2.errors.length, 2);
  const huge = JSON.stringify({...validSpec(), pad: 'x'.repeat(spec.MAX_SCENE_SPEC_CHARS)});
  const r3 = validateGeneratedScene(huge);
  assert.equal(r3.ok, false);
  assert.match(r3.errors[0], /larger than 20000/);
  const r4 = validateGeneratedScene('{"format": "desktop-companion-scene", version: 1}');
  assert.equal(r4.ok, false);
  assert.match(r4.errors[0], /not valid JSON/);
  assert.deepEqual([...validateGeneratedScene('I cannot do that.').errors], ['The reply did not contain a JSON object.']);
  assert.equal(validateGeneratedScene('').ok, false);
  const extra = validateGeneratedScene(JSON.stringify({...validSpec(), script: 'alert(1)'}));
  assert.equal(extra.ok, true);
  assert.equal('script' in extra.spec, false);
});

test('describeDestination: only online requires confirmation', () => {
  assert.equal(describeDestination('online').requiresConfirmation, true);
  assert.match(describeDestination('online').label, /Anthropic cloud/);
  assert.equal(describeDestination('offline').requiresConfirmation, false);
  assert.match(describeDestination('offline').label, /Local model/);
});

const reply = (text, source = 'local') => ({id: 'm1', role: 'assistant', text, createdAt: '2024-01-01T00:00:00Z', source});

function streamApi({events = [], startError, autoCancel = true} = {}) {
  const sent = [];
  const cancelled = [];
  let handler = null;
  let unsubscribed = 0;
  const start = {streamId: 's-1', generation: 3, route: 'local'};
  const api = {
    chat: async () => { throw new Error('chat should not be used when streaming exists'); },
    chatStreamStart: async (text) => { sent.push(text); if (startError) throw new Error(startError); return start; },
    onChatStream: (s, h) => { handler = h; queueMicrotask(() => events.forEach((e) => h({streamId: s.streamId, generation: s.generation, seq: 0, ...e}))); return () => { unsubscribed++; }; },
    chatStreamCancel: async (id) => {
      cancelled.push(id);
      if (autoCancel) queueMicrotask(() => handler({streamId: 's-1', generation: 3, seq: 9, type: 'done', outcome: 'cancelled', reply: reply('Stopped by you.', 'system'), stored: []}));
      return true;
    },
  };
  return {api, sent, cancelled, get unsubscribed() { return unsubscribed; }, emit: (e) => handler({streamId: 's-1', generation: 3, seq: 1, ...e})};
}

test('runMotionGeneration streams: preview is the exact text sent, deltas reported, done wins, stale events ignored', async () => {
  const request = buildMotionRequest({description: 'calm teal waves', reducedMotion: false});
  const json = validJson();
  const fake = streamApi({events: [
    {type: 'status', status: 'streaming'},
    {type: 'delta', text: json.slice(0, 10)},
    {type: 'delta', text: json.slice(10)},
    {type: 'delta', text: 'IGNORED', generation: 2},
    {type: 'done', outcome: 'complete', reply: reply(json), stored: []},
  ]});
  const deltas = [];
  const out = await runMotionGeneration(fake.api, request, {onDelta: (t) => deltas.push(t)});
  assert.deepEqual(fake.sent, [request.preview]);
  assert.equal(fake.sent[0].length, request.sentChars);
  assert.deepEqual(out, {outcome: 'complete', text: json, source: 'local'});
  assert.deepEqual(deltas, [json.slice(0, 10), json]);
  assert.equal(fake.unsubscribed, 1);
  assert.equal(validateGeneratedScene(out.text).ok, true);
});

test('runMotionGeneration: abort cancels through chatStreamCancel; failures map without throwing', async () => {
  const request = buildMotionRequest({description: 'x', reducedMotion: false});
  const fake = streamApi({events: [{type: 'delta', text: '{"for'}]});
  const controller = new AbortController();
  const p = runMotionGeneration(fake.api, request, {signal: controller.signal, onDelta: () => controller.abort()});
  const out = await p;
  assert.deepEqual(fake.cancelled, ['s-1']);
  assert.equal(out.outcome, 'cancelled');
  assert.equal(out.text, '{"for');

  const noDone = streamApi({events: [], autoCancel: false});
  noDone.api.chatStreamCancel = async () => { throw new Error('gone'); };
  const c2 = new AbortController();
  const p2 = runMotionGeneration(noDone.api, request, {signal: c2.signal});
  await new Promise((r) => setTimeout(r, 0));
  c2.abort();
  assert.equal((await p2).outcome, 'cancelled');

  const pre = new AbortController(); pre.abort();
  const pf = streamApi();
  assert.equal((await runMotionGeneration(pf.api, request, {signal: pre.signal})).outcome, 'cancelled');
  assert.deepEqual(pf.sent, [], 'nothing sent when already aborted');

  const failed = streamApi({events: [{type: 'done', outcome: 'failed', reply: reply('Local model unavailable: refused. No reply was generated.', 'system'), stored: []}]});
  const f = await runMotionGeneration(failed.api, request);
  assert.equal(f.outcome, 'failed');
  assert.match(f.error, /Local model unavailable/);

  const lost = streamApi({events: [{type: 'delta', text: 'abc'}, {type: 'lost', reason: 'timeout'}]});
  const l = await runMotionGeneration(lost.api, request);
  assert.equal(l.outcome, 'incomplete');
  assert.equal(l.text, 'abc');
  assert.match(l.error, /timeout/);

  const busy = streamApi({startError: 'Another reply is in progress.'});
  const b = await runMotionGeneration(busy.api, request);
  assert.deepEqual(b, {outcome: 'failed', text: '', source: 'none', error: 'Another reply is in progress.'});
});

test('runMotionGeneration falls back to chat() and maps system notes and rejections', async () => {
  const request = buildMotionRequest({description: 'violet orbit', reducedMotion: true});
  const sent = [];
  const json = validJson();
  const ok = await runMotionGeneration({chat: async (t) => { sent.push(t); return reply('```json\n' + json + '\n```', 'cloud'); }}, request);
  assert.deepEqual(sent, [request.preview]);
  assert.equal(ok.outcome, 'complete');
  assert.equal(ok.source, 'cloud');
  assert.equal(validateGeneratedScene(ok.text).ok, true);
  const sys = await runMotionGeneration({chat: async () => reply('Cloud model unavailable: no key. No reply was generated.', 'system')}, request);
  assert.equal(sys.outcome, 'failed');
  assert.match(sys.error, /Cloud model unavailable/);
  const rej = await runMotionGeneration({chat: async () => { throw new Error('IPC closed'); }}, request);
  assert.deepEqual(rej, {outcome: 'failed', text: '', source: 'none', error: 'IPC closed'});
  const big = await runMotionGeneration({chat: async () => reply('x'.repeat(MOTION_AI_LIMITS.replyChars + 5))}, request);
  assert.equal(big.outcome, 'truncated');
  assert.equal(big.text.length, MOTION_AI_LIMITS.replyChars);
  const c = new AbortController();
  const pending = runMotionGeneration({chat: () => new Promise(() => {})}, request, {signal: c.signal});
  c.abort();
  assert.equal((await pending).outcome, 'cancelled');
});

test('Motion Studio gates Preview/Apply behind the validated spec, confirms cloud sends and has no useCloud flag', async () => {
  const src = await readFile(path.join(root, 'src/components/MotionStudio.tsx'), 'utf8');
  assert.match(src, /from '\.\.\/ui\/motion-ai'/);
  assert.doesNotMatch(src, /useCloud/);
  assert.match(src, /const aiValidatedSpec = aiResult\?\.ok \? aiResult\.spec : null;/);
  assert.match(src, /setAiResult\(validateGeneratedScene\(out\.text\)\)/);
  assert.match(src, /const applyAiSpec = \(\) => \{\s*if \(!aiValidatedSpec\) return;\s*setSettings\(sceneSpecToSettings\(aiValidatedSpec\)\)/);
  assert.match(src, /const previewAiSpec = \(\) => \{\s*if \(!aiValidatedSpec\) return;/);
  assert.match(src, /onClick=\{applyAiSpec\} disabled=\{!aiValidatedSpec\}>Apply</);
  assert.match(src, />Send to Anthropic cloud</);
  assert.match(src, />Generate locally</);
  assert.match(src, /Add your key in Settings/);
  assert.match(src, /aiApi\.cloudKeyStatus\(\)/);
  assert.match(src, /if \(!configured \|\| controller\.signal\.aborted\) \{/);
  assert.match(src, /runMotionGeneration\(aiApi, request,/);
  assert.match(src, /recorded in Assistant chat history/);
  assert.match(src, />Try again</);
  assert.match(src, />Cancel</);
  assert.match(src, /store\?\.settings\?\.mode/);
});
