import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm } from 'node:fs/promises';
import { runApiWorker, safeCheckEnvironment, createCheckOutputCapture } from '../server/api-worker.mjs';

test('check capture retains failure names and final TAP summary after lengthy passing output', () => {
  const capture = createCheckOutputCapture();
  capture.append('TAP version 13\n' + 'ok passing output\n'.repeat(4000));
  capture.append('not '); capture.append('ok 4001 - meaningful regression name\n  ---\n  error: specific assertion failed\n  ...\n');
  capture.append('ok more passing output\n'.repeat(4000));
  capture.append('1..8001\n# tests 8001\n# pass 8000\n# fail 1\n');
  const result = capture.result();
  assert.equal(result.outputTruncated, true);
  assert.ok(result.output.length < 12000);
  assert.match(result.output, /meaningful regression name/);
  assert.match(result.output, /specific assertion failed/);
  assert.match(result.output, /# fail 1/);
});

test('short check output remains complete without a truncation marker', () => {
  const capture = createCheckOutputCapture(); capture.append('ok 1 - small\n'); capture.append('# pass 1\n');
  assert.deepEqual(capture.result(), { output: 'ok 1 - small\n# pass 1\n', outputTruncated: false });
});

// Every provider response is local and mocked. No request can reach an API.
async function fixture(t) {
  const base = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.api-worker-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'readable.txt'), 'hello');
  return { workspace, canonicalRepo: workspace, gateway: 'http://127.0.0.1:4317/anthropic/' + 'a'.repeat(64), model: 'claude-fable-5-1', prompt: 'Implement the assigned marker.', files: ['src/marker.txt'], stateFile: path.join(base, 'state.json') };
}
const tool = (name, input, id = name) => ({ type: 'tool_use', id, name, input });
const reply = (content, stop_reason = 'tool_use') => ({ ok: true, text: async () => JSON.stringify({ content, stop_reason }) });

test('exact edits preserve surrounding Unicode content and can shrink or delete matches', async t => {
  const config = await fixture(t); let calls = 0;
  const file = path.join(config.workspace, 'src/marker.txt');
  await writeFile(file, 'prefix 🪐\r\nunique original\r\nsuffix');
  const result = await runApiWorker(config, { fetchProvider: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.ok(request.tools.some(item => item.name === 'edit_file'));
    if (++calls === 1) return reply([
      tool('edit_file', { path: 'src/marker.txt', old_text: 'unique original', new_text: '新' }, 'shrink'),
      tool('edit_file', { path: 'src/marker.txt', old_text: 'suffix', new_text: '' }, 'delete'),
    ]);
    assert.ok(request.messages.at(-1).content.every(item => !item.is_error));
    return reply([], 'end_turn');
  } });
  assert.equal(result.state, 'idle');
  assert.equal(await readFile(file, 'utf8'), 'prefix 🪐\r\n新\r\n');
  assert.deepEqual(result.events.map(item => item.tool), ['edit_file', 'edit_file']);
});

test('exact edits reject missing, empty, ambiguous, oversized and unowned input without mutation', async t => {
  const config = await fixture(t); let calls = 0;
  const file = path.join(config.workspace, 'src/marker.txt');
  const original = 'aaaa\nunique'; await writeFile(file, original);
  const input = { path: 'src/marker.txt', old_text: 'unique', new_text: 'new' };
  const attempts = [
    { ...input, old_text: '' }, { ...input, old_text: 'missing' },
    { ...input, old_text: 'aaa' }, // Overlapping occurrences are ambiguous too.
    { ...input, old_text: 'x'.repeat(24577) }, { ...input, new_text: '🪐'.repeat(6145) },
    { ...input, path: 'src/readable.txt', old_text: 'hello' },
    { ...input, path: '../outside.txt' }, { ...input, command: 'unexpected' },
    { ...input, path: 'src/nonexistent.txt' },
  ];
  await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply(attempts.map((attempt, index) => tool('edit_file', attempt, String(index))));
    assert.ok(JSON.parse(options.body).messages.at(-1).content.every(item => item.is_error));
    return reply([], 'end_turn');
  } });
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(await readFile(path.join(config.workspace, 'src/readable.txt'), 'utf8'), 'hello');
});

test('exact edits reject source or resulting file over the byte limit', async t => {
  const config = await fixture(t); let calls = 0;
  const file = path.join(config.workspace, 'src/marker.txt');
  const original = 'x'.repeat(131071) + 'a'; await writeFile(file, original);
  await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply([tool('edit_file', { path: 'src/marker.txt', old_text: 'a', new_text: 'aa' })]);
    assert.equal(JSON.parse(options.body).messages.at(-1).content[0].is_error, true);
    return reply([], 'end_turn');
  } });
  assert.equal(await readFile(file, 'utf8'), original);
  await writeFile(file, original + 'a'); calls = 0;
  await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply([tool('edit_file', { path: 'src/marker.txt', old_text: 'aa', new_text: '' })]);
    assert.equal(JSON.parse(options.body).messages.at(-1).content[0].is_error, true);
    return reply([], 'end_turn');
  } });
  assert.equal(await readFile(file, 'utf8'), original + 'a');
});

test('max_tokens tool responses stop explicitly without execution or automatic retries', async t => {
  const config = await fixture(t); let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async () => {
    calls++;
    return reply([tool('write_file', { path: 'src/marker.txt', content: 'must not write' }), tool('edit_file', '{partial JSON')], 'max_tokens');
  } });
  assert.equal(calls, 1); assert.equal(result.state, 'blocked'); assert.equal(result.reason, 'output_limit');
  assert.deepEqual(result.events, []);
  await assert.rejects(readFile(path.join(config.workspace, 'src/marker.txt')), { code: 'ENOENT' });
});

test('exact edits reject owned hardlinks without changing their target', async t => {
  const config = await fixture(t); let calls = 0;
  const outside = path.join(path.dirname(config.workspace), 'outside.txt');
  await writeFile(outside, 'outside');
  await link(outside, path.join(config.workspace, 'src/marker.txt'));
  await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply([tool('edit_file', { path: 'src/marker.txt', old_text: 'outside', new_text: 'bad' })]);
    assert.equal(JSON.parse(options.body).messages.at(-1).content[0].is_error, true);
    return reply([], 'end_turn');
  } });
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('mocked provider uses real filesystem tool to write only the owned marker', async t => {
  const config = await fixture(t); let calls = 0;
  const thinking = { type: 'thinking', thinking: 'PRIVATE REASONING', signature: 'private-signature' };
  const result = await runApiWorker(config, { fetchProvider: async (url, options) => {
    calls++; assert.equal(url, config.gateway + '/v1/messages');
    const request = JSON.parse(options.body);
    assert.equal(request.stream, false); assert.equal(request.max_tokens, 16384); assert.equal(request.model, config.model);
    assert.deepEqual(request.cache_control, { type: 'ephemeral' });
    assert.deepEqual(Object.keys(options.headers).sort(), ['anthropic-version', 'content-type']);
    if (calls === 1) return reply([thinking, tool('write_file', { path: 'src/marker.txt', content: 'owned marker\n' })]);
    assert.deepEqual(request.messages[1].content[0], thinking);
    assert.match(request.messages.at(-1).content[0].content, /written/);
    return reply([{ type: 'text', text: 'Wrote the assigned marker.' }], 'end_turn');
  } });
  assert.equal(result.state, 'idle'); assert.equal(calls, 2);
  assert.equal(await readFile(path.join(config.workspace, 'src/marker.txt'), 'utf8'), 'owned marker\n');
  const persisted = await readFile(config.stateFile, 'utf8');
  for (const privateValue of ['PRIVATE REASONING', 'private-signature', config.prompt, config.gateway, 'a'.repeat(64)]) assert.ok(!persisted.includes(privateValue));
  assert.deepEqual(result.events, [{ tool: 'write_file', path: 'src/marker.txt' }]);
});

test('denies traversal, unowned writes, private files, unknown checks, and shell tools', async t => {
  const config = await fixture(t); let calls = 0;
  const attempts = [
    tool('write_file', { path: '../escape.txt', content: 'bad' }, 'a'),
    tool('write_file', { path: 'src/unowned.txt', content: 'bad' }, 'b'),
    tool('read_file', { path: '.env' }, 'c'),
    tool('read_file', { path: 'src/private/key.json' }, 'd'),
    tool('run_check', { check: 'build', command: 'echo bad' }, 'e'),
    tool('shell', { command: 'echo bad' }, 'f'),
  ];
  await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply(attempts);
    const results = JSON.parse(options.body).messages.at(-1).content;
    assert.equal(results.length, attempts.length); assert.ok(results.every(r => r.is_error === true));
    return reply([{ type: 'text', text: 'Denied unsafe tools.' }], 'end_turn');
  } });
  await assert.rejects(readFile(path.join(config.workspace, 'src/unowned.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(config.workspace, '..', 'escape.txt')), { code: 'ENOENT' });
});

test('denies symlink/junction read and owned write escape', async t => {
  const config = await fixture(t); const outside = path.join(path.dirname(config.workspace), 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'value.txt'), 'outside');
  await symlink(outside, path.join(config.workspace, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  config.files = ['src/linked/value.txt']; let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply([tool('read_file', { path: 'src/linked/value.txt' }, 'r'), tool('write_file', { path: 'src/linked/value.txt', content: 'bad' }, 'w'), tool('edit_file', { path: 'src/linked/value.txt', old_text: 'outside', new_text: 'bad' }, 'e')]);
    assert.ok(JSON.parse(options.body).messages.at(-1).content.every(r => r.is_error));
    return reply([], 'end_turn');
  } });
  assert.equal(result.state, 'idle'); assert.equal(await readFile(path.join(outside, 'value.txt'), 'utf8'), 'outside');
});

test('invalid gateway and unsafe ownership fail before any request', async t => {
  const config = await fixture(t); let requests = 0;
  const fetchProvider = async () => { requests++; throw new Error('Must not fetch'); };
  for (const gateway of ['https://api.anthropic.com', 'http://example.com/anthropic/' + 'a'.repeat(64), config.gateway + '?key=secret', config.gateway + '/v1/messages', 'http://user:pass@127.0.0.1/anthropic/' + 'a'.repeat(64)]) {
    await assert.rejects(runApiWorker({ ...config, gateway }, { fetchProvider }), /gateway/);
  }
  await assert.rejects(runApiWorker({ ...config, files: ['src/../escape'] }, { fetchProvider }), /path/);
  assert.equal(requests, 0);
});

test('check subprocess environment contains no credential or Node preload variables', () => {
  const env = safeCheckEnvironment({ PATH: 'safe-path', SystemRoot: 'windows', TEMP: 'temp', ANTHROPIC_API_KEY: 'secret', AWS_ACCESS_KEY_ID: 'secret', GITHUB_TOKEN: 'secret', NODE_OPTIONS: '--require evil', npm_config_registry: 'secret', PRIVATE_GRANT: 'secret', HOME: 'private' });
  assert.deepEqual(env, { PATH: 'safe-path', SystemRoot: 'windows', TEMP: 'temp', CI: '1', NO_COLOR: '1' });
});

test('source listing is bounded to safe roots and large files support read windows', async t => {
  const config = await fixture(t);
  await mkdir(path.join(config.workspace, 'private')); await writeFile(path.join(config.workspace, 'private', 'hidden.txt'), 'hidden');
  await writeFile(path.join(config.workspace, '.env'), 'hidden');
  await writeFile(path.join(config.workspace, 'GOAL.md'), 'a'.repeat(30000) + 'TAIL');
  let calls = 0;
  await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply([tool('list_files', {}, 'l'), tool('read_file', { path: 'GOAL.md', offset: 30000, limit: 4 }, 'r')]);
    const results = JSON.parse(options.body).messages.at(-1).content;
    assert.match(results[0].content, /src\/readable.txt/); assert.match(results[0].content, /GOAL.md/);
    assert.doesNotMatch(results[0].content, /hidden|\.env/); assert.equal(results[1].content, 'TAIL');
    return reply([], 'end_turn');
  } });
});

test('fixed test check really executes Node tests with stripped credentials', async t => {
  const config = await fixture(t); await mkdir(path.join(config.workspace, 'tests'));
  await writeFile(path.join(config.workspace, 'tests', 'environment.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('clean and bounded',()=>{ assert.equal(process.env.API_WORKER_PRIVATE_TOKEN,undefined); assert.ok(process.execArgv.includes('--test-concurrency=2')); });");
  const previous = process.env.API_WORKER_PRIVATE_TOKEN; process.env.API_WORKER_PRIVATE_TOKEN = 'private-check-secret';
  t.after(() => { if (previous === undefined) delete process.env.API_WORKER_PRIVATE_TOKEN; else process.env.API_WORKER_PRIVATE_TOKEN = previous; });
  let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply([tool('run_check', { check: 'test' })]);
    const outcome = JSON.parse(JSON.parse(options.body).messages.at(-1).content[0].content);
    assert.equal(outcome.exit, 0); assert.match(outcome.output, /pass 1/);
    return reply([], 'end_turn');
  } });
  assert.equal(result.events[0].exit, 0);
});

test('focused checks execute assigned behavior tests only, retain clean environment and report limited scope', async t => {
  const config = await fixture(t); await mkdir(path.join(config.workspace, 'tests'));
  config.files.push('tests/owned.test.mjs');
  await writeFile(path.join(config.workspace, 'src/behavior.mjs'), 'export const double = value => value * 2;');
  await writeFile(path.join(config.workspace, 'tests/owned.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {double} from '../src/behavior.mjs'; test('owned behavior actually works',()=>{ assert.equal(double(21),42); assert.equal(process.env.API_WORKER_PRIVATE_TOKEN,undefined); assert.ok(process.execArgv.includes('--test-concurrency=2')); });");
  await writeFile(path.join(config.workspace, 'tests/unowned.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('unowned deliberate failure',()=>assert.fail('must not execute in focused check'));");
  const previous = process.env.API_WORKER_PRIVATE_TOKEN; process.env.API_WORKER_PRIVATE_TOKEN = 'focused-private-check-secret';
  t.after(() => { if (previous === undefined) delete process.env.API_WORKER_PRIVATE_TOKEN; else process.env.API_WORKER_PRIVATE_TOKEN = previous; });
  let calls = 0, results, requestSystem, advertisedChecks;
  const result = await runApiWorker(config, { fetchProvider: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (++calls === 1) {
      requestSystem = request.system; advertisedChecks = request.tools.find(item => item.name === 'run_check').input_schema.properties.check.enum;
      return reply([tool('run_check', { check: 'test_owned' }, 'focused'), tool('run_check', { check: 'test' }, 'full')]);
    }
    results = request.messages.at(-1).content;
    return reply([], 'end_turn');
  } });
  assert.equal(result.state, 'idle'); assert.equal(calls, 2);
  assert.ok(advertisedChecks.includes('test_owned')); assert.match(requestSystem, /Prefer test_owned and typecheck/);
  const focused = JSON.parse(results[0].content), full = JSON.parse(results[1].content);
  assert.equal(focused.exit, 0); assert.equal(focused.scope, 'assigned_tests_only'); assert.equal(focused.fullVerification, false);
  assert.match(focused.output, /owned behavior actually works/); assert.match(focused.output, /# pass 1/);
  assert.doesNotMatch(focused.output, /unowned deliberate failure/);
  assert.equal(full.exit, 1); assert.match(full.output, /unowned deliberate failure/);
  assert.deepEqual(result.events, [{ tool: 'run_check', check: 'test_owned', exit: 0 }, { tool: 'run_check', check: 'test', exit: 1 }]);
});

test('focused checks reject missing ownership and arbitrary command arguments', async t => {
  const config = await fixture(t); let calls = 0, results;
  const result = await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply([
      tool('run_check', { check: 'test_owned' }, 'none'),
      tool('run_check', { check: 'test_owned', command: 'arbitrary' }, 'command'),
      tool('run_check', { check: 'test_owned', args: ['../escape.test.mjs'] }, 'args'),
      tool('run_check', { check: 'test_owned', files: ['tests/unowned.test.mjs'] }, 'files'),
    ]);
    results = JSON.parse(options.body).messages.at(-1).content; return reply([], 'end_turn');
  } });
  assert.equal(result.state, 'idle'); assert.equal(results.length, 4);
  assert.ok(results.every(item => item.is_error));
  assert.match(results[0].content, /No bounded assigned test set/);
  assert.ok(results.slice(1).every(item => /Unknown fixed check/.test(item.content)));
});

test('focused checks reject assigned symlink escapes and nonexistent test paths', async t => {
  const config = await fixture(t), outside = path.join(path.dirname(config.workspace), 'outside');
  await mkdir(outside); await mkdir(path.join(config.workspace, 'tests'));
  await writeFile(path.join(outside, 'escape.test.mjs'), "throw new Error('must never execute escaped source');");
  await symlink(outside, path.join(config.workspace, 'tests/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of ['tests/linked/escape.test.mjs', 'tests/missing.test.mjs']) {
    config.files = [file]; let calls = 0, results;
    const result = await runApiWorker(config, { fetchProvider: async (_url, options) => {
      if (++calls === 1) return reply([tool('run_check', { check: 'test_owned' })]);
      results = JSON.parse(options.body).messages.at(-1).content; return reply([], 'end_turn');
    } });
    assert.equal(result.state, 'idle'); assert.equal(results[0].is_error, true);
    assert.ok(!Object.hasOwn(result.events[0], 'exit'));
  }
  let calls = 0;
  await assert.rejects(runApiWorker({ ...config, files: ['tests/../outside/escape.test.mjs'] }, { fetchProvider: async () => { calls++; } }), /Unsafe source path/);
  assert.equal(calls, 0);
});

test('long failed checks return valid bounded JSON with redacted failure diagnostics and final summary', async t => {
  const config = await fixture(t); await mkdir(path.join(config.workspace, 'tests'));
  const fakeSecret = 'sk-ant-' + 'synthetic-test-value-12345678';
  await writeFile(path.join(config.workspace, 'tests', 'noisy.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict'; console.log('passing noise '.repeat(6000)); test('late failing regression',()=>{ assert.fail(${JSON.stringify(fakeSecret)}); });`);
  let calls = 0;
  await runApiWorker(config, { fetchProvider: async (_url, options) => {
    if (++calls === 1) return reply([tool('run_check', { check: 'test' })]);
    const text = JSON.parse(options.body).messages.at(-1).content[0].content;
    assert.ok(text.length <= 24576);
    assert.ok(!text.includes(fakeSecret));
    const result = JSON.parse(text);
    assert.equal(result.exit, 1); assert.equal(result.outputTruncated, true);
    assert.match(result.output, /late failing regression/);
    assert.match(result.output, /\[redacted\]/);
    assert.match(result.output, /# fail 1/);
    return reply([], 'end_turn');
  } });
});

test('provider rejection stops immediately without retry or error body publication', async t => {
  const config = await fixture(t); let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async () => { calls++; return { ok: false, status: 400, text: async () => 'private provider credit details' }; } });
  assert.equal(calls, 1); assert.equal(result.state, 'failed'); assert.equal(result.reason, 'provider_http_400');
  assert.ok(!(await readFile(config.stateFile, 'utf8')).includes('credit details'));
});

test('malformed provider JSON publishes only a fixed diagnostic without retrying or leaking the body', async t => {
  const config = await fixture(t); let calls = 0;
  const privateBody = `{"private":"${config.gateway} PRIVATE_REASONING sk-ant-private-provider-value", broken`;
  const result = await runApiWorker(config, { fetchProvider: async () => {
    calls++; return { ok: true, status: 200, text: async () => privateBody };
  } });
  assert.equal(calls, 1);
  assert.equal(result.reason, 'provider_malformed_json');
  assert.equal(result.failureStage, 'provider_decode');
  assert.match(result.summary, /malformed JSON/);
  const persisted = await readFile(config.stateFile, 'utf8');
  for (const value of [privateBody, config.gateway, 'PRIVATE_REASONING', 'sk-ant-private-provider-value']) assert.ok(!persisted.includes(value));
});

test('invalid provider protocol rejects the entire response before publishing text or executing tools', async t => {
  for (const body of [
    null,
    { content: null, stop_reason: 'end_turn' },
    { content: [null], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: 'PRIVATE_PROTOCOL_TEXT' }], stop_reason: 'tool_use' },
    { content: [tool('write_file', { path: 'src/marker.txt', content: 'must not write' }), { type: 'unknown', data: 'PRIVATE_PROTOCOL_TEXT' }], stop_reason: 'tool_use' },
    { content: [tool('write_file', { path: 'src/marker.txt', content: 'must not write' })], stop_reason: 'end_turn' },
    { content: [tool('write_file', { path: 'src/marker.txt', content: 'must not write' }, 'same'), tool('list_files', {}, 'same')], stop_reason: 'tool_use' },
  ]) {
    const config = await fixture(t); let calls = 0;
    const result = await runApiWorker(config, { fetchProvider: async () => {
      calls++; return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    } });
    assert.equal(calls, 1); assert.equal(result.reason, 'provider_protocol');
    assert.equal(result.failureStage, 'provider_validation');
    assert.deepEqual(result.events, []);
    assert.ok(!(await readFile(config.stateFile, 'utf8')).includes('PRIVATE_PROTOCOL_TEXT'));
    await assert.rejects(readFile(path.join(config.workspace, 'src/marker.txt')), { code: 'ENOENT' });
  }
});

test('state persistence failure returns a fixed filesystem diagnostic before contacting a provider', async t => {
  const config = await fixture(t); let calls = 0;
  const occupied = path.join(path.dirname(config.workspace), 'occupied');
  await writeFile(occupied, 'private filesystem contents');
  config.stateFile = path.join(occupied, 'state.json');
  const result = await runApiWorker(config, { fetchProvider: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal(calls, 0); assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'filesystem_persistence'); assert.equal(result.failureStage, 'state_persistence');
  assert.ok(!JSON.stringify(result).includes(occupied));
});

test('unreadable provider body stops with a fixed transport code and no fresh paid retry', async t => {
  const config = await fixture(t); let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async () => {
    calls++; return { ok: true, status: 200, text: async () => { throw new Error('PRIVATE_BODY_FAILURE ' + config.gateway); } };
  } });
  assert.equal(calls, 1); assert.equal(result.reason, 'provider_transport_exhausted');
  assert.equal(result.failureStage, 'provider_transport');
  const persisted = await readFile(config.stateFile, 'utf8');
  assert.ok(!persisted.includes('PRIVATE_BODY_FAILURE')); assert.ok(!persisted.includes(config.gateway));
});

test('unclassified runtime exception never publishes its message', async t => {
  const config = await fixture(t);
  const result = await runApiWorker(config, { fetchProvider: async () => ({ status: 200, get ok() { throw new Error('PRIVATE_RUNTIME_FAILURE ' + config.gateway); } }) });
  assert.equal(result.reason, 'worker_error');
  assert.match(result.summary, /unclassified runtime failure/);
  assert.ok(!(await readFile(config.stateFile, 'utf8')).includes('PRIVATE_RUNTIME_FAILURE'));
});

test('redacts gateway and prompt echoes and stops on provider transport failure', async t => {
  const config = await fixture(t); let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async () => { if (++calls === 1) return reply([{ type: 'text', text: config.gateway + ' ' + config.prompt }, tool('list_files', {})]); throw new Error('sensitive transport failure ' + config.gateway); } });
  assert.equal(calls, 4); assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'provider_transport_exhausted');
  assert.equal(result.failureStage, 'provider_transport');
  const state = await readFile(config.stateFile, 'utf8'); assert.ok(!state.includes(config.gateway)); assert.ok(!state.includes(config.prompt)); assert.ok(!state.includes('sensitive transport'));
});

test('planner allows six successful inspections, excludes checks, preserves tool definitions while restricting further inspection', async t => {
  const config = await fixture(t); config.files = ['docs/loop/decision.json']; let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (++calls === 1) {
      assert.deepEqual(request.tools.map(t => t.name).sort(), ['list_files', 'read_file', 'write_file']);
      assert.match(request.system, /at most six/); assert.match(request.system, /small independently complete tasks/); assert.match(request.system, /single-worker instruction/);
      return reply([
        tool('read_file', { path: 'src/missing.txt' }, 'missing'),
        ...Array.from({ length: 6 }, (_, i) => tool(i % 2 ? 'list_files' : 'read_file', i % 2 ? { path: 'src' } : { path: 'src/readable.txt' }, `inspection-${i}`)),
        tool('read_file', { path: 'src/readable.txt' }, 'seventh'),
        tool('run_check', { check: 'test' }, 'check'),
      ]);
    }
    assert.deepEqual(request.tools.map(t => t.name).sort(), ['list_files', 'read_file', 'write_file']);
    const results = request.messages.at(-1).content;
    assert.equal(results[0].is_error, true);
    assert.ok(results.slice(1, 7).every(r => !r.is_error));
    assert.match(results[7].content, /Planning limit: six successful/); assert.equal(results[7].is_error, true);
    assert.match(results[8].content, /planners cannot run checks/); assert.equal(results[8].is_error, true);
    return reply([tool('write_file', { path: 'docs/loop/decision.json', content: JSON.stringify({ version: 1, tasks: [] }) })]);
  } });
  assert.equal(calls, 2); assert.equal(result.state, 'idle'); assert.equal(result.summary, 'Checkpoint written.');
});

test('valid owned checkpoints finish after one provider response and execute the entire batch', async t => {
  for (const [file, checkpoint] of [
    ['docs/loop/decision.json', { version: 1 }],
    ['docs/loop/result.builder.json', { done: true, checks: ['test passed'] }],
  ]) {
    const config = await fixture(t); config.files.push(file); let calls = 0;
    const result = await runApiWorker(config, { fetchProvider: async () => {
      assert.equal(++calls, 1, 'No paid completion turn after checkpoint');
      return reply([tool('write_file', { path: file, content: JSON.stringify(checkpoint) }, 'checkpoint'), tool('write_file', { path: 'src/marker.txt', content: 'whole batch finished' }, 'marker')]);
    } });
    assert.equal(calls, 1); assert.equal(result.state, 'idle'); assert.equal(result.summary, 'Checkpoint written.');
    assert.deepEqual(JSON.parse(await readFile(path.join(config.workspace, file), 'utf8')), checkpoint);
    assert.equal(await readFile(path.join(config.workspace, 'src/marker.txt'), 'utf8'), 'whole batch finished');
    assert.equal(result.events.length, 2);
  }
});

test('invalid or overwritten checkpoints do not stop a worker early', async t => {
  const config = await fixture(t); config.files = ['docs/loop/result.builder.json']; let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async () => {
    if (++calls === 1) return reply([
      tool('write_file', { path: config.files[0], content: JSON.stringify({ done: true, checks: [] }) }, 'valid'),
      tool('write_file', { path: config.files[0], content: '{broken' }, 'overwrite'),
    ]);
    return reply([], 'end_turn');
  } });
  assert.equal(calls, 2); assert.equal(result.state, 'idle'); assert.notEqual(result.summary, 'Checkpoint written.');
});

test('planner stops at twelve turns instead of continuing repeated inspections', async t => {
  const config = await fixture(t); config.files = ['docs/loop/decision.json']; let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async () => {
    calls++; return reply([tool('read_file', { path: 'src/readable.txt' }, `read-${calls}`)]);
  } });
  assert.equal(calls, 12); assert.equal(result.state, 'blocked'); assert.equal(result.reason, 'turn_limit');
  assert.match(result.summary, /12-turn/);
});

test('transient 502 re-enters gateway and then completes a real checkpoint write', async t => {
  const config = await fixture(t); config.files = ['docs/loop/decision.json']; let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async url => {
    assert.equal(url, config.gateway + '/v1/messages');
    if (++calls === 1) return { ok: false, status: 502, text: async () => { throw new Error('Transient body must not be read'); } };
    return reply([tool('write_file', { path: config.files[0], content: '{"version":1}' })]);
  } });
  assert.equal(calls, 2); assert.equal(result.state, 'idle');
  assert.deepEqual(result.events[0], { tool: 'provider_retry', attempt: 2, status: 502 });
  assert.deepEqual(JSON.parse(await readFile(path.join(config.workspace, config.files[0]), 'utf8')), { version: 1 });
});

test('transient status stops after three attempts and never publishes provider body', async t => {
  const config = await fixture(t); let calls = 0;
  const result = await runApiWorker(config, { fetchProvider: async () => { calls++; return { ok: false, status: 503, text: async () => 'private upstream error' }; } });
  assert.equal(calls, 3); assert.equal(result.state, 'failed'); assert.equal(result.reason, 'provider_http_503');
  assert.deepEqual(result.events, [{ tool: 'provider_retry', attempt: 2, status: 503 }, { tool: 'provider_retry', attempt: 3, status: 503 }]);
  assert.ok(!(await readFile(config.stateFile, 'utf8')).includes('private upstream'));
});

test('cancellation interrupts transient retry backoff without another request', async t => {
  const config = await fixture(t); const abort = new AbortController(); let calls = 0;
  const result = await runApiWorker(config, { signal: abort.signal, fetchProvider: async () => {
    calls++; setTimeout(() => abort.abort(), 10); return { ok: false, status: 429 };
  } });
  assert.equal(calls, 1); assert.equal(result.state, 'failed'); assert.equal(result.reason, 'cancelled');
});

