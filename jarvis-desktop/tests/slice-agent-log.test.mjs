import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/agent-log.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const al = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {appendEntry, redactSecrets, filterLog, summarizeTask, exportLog, parseLog, normalizeLog, AGENT_LOG_PREF_KEY, AGENT_LOG_LIMITS, LOG_LEVELS} = al;

const T0 = Date.UTC(2026, 9, 15, 9, 0, 0);
const add = (log, over = {}, i = 0) => appendEntry(log, {taskId:'t-1', level:'info', message:'hello', ...over}, T0 + i);

test('agent log: append returns new arrays with deterministic ids and trimmed fields', () => {
  assert.equal(AGENT_LOG_PREF_KEY, 'developer.agentLog');
  assert.deepEqual({...AGENT_LOG_LIMITS, taskIdChars:undefined}, {messageChars:500, dataChars:4000, entriesPerTask:200, totalEntries:1000, taskIdChars:undefined});
  assert.deepEqual([...LOG_LEVELS], ['info', 'warn', 'error', 'result']);
  const empty = [];
  const one = appendEntry(empty, {taskId:'  t-1 ', level:'warn', message:'  careful  '}, T0);
  assert.equal(empty.length, 0, 'input not mutated');
  assert.deepEqual(one, [{id:`l-${T0.toString(36)}-0`, taskId:'t-1', at:new Date(T0).toISOString(), level:'warn', message:'careful'}]);
  const two = appendEntry(one, {taskId:'t-1', level:'result', message:'ok', data:'x'.repeat(5000)}, new Date(T0));
  assert.equal(two[1].id, `l-${T0.toString(36)}-1`);
  assert.equal(two[1].data.length, 4000);
  assert.ok(two[1].data.endsWith('…[truncated]'));
  assert.equal(appendEntry([], {taskId:'t', level:'info', message:'m', data:'small'}, T0)[0].data, 'small');
  assert.equal('data' in appendEntry([], {taskId:'t', level:'info', message:'m', data:'   '}, T0)[0], false);
  assert.deepEqual(appendEntry([], {taskId:'t-1', level:'warn', message:'careful'}, T0), appendEntry([], {taskId:'t-1', level:'warn', message:'careful'}, T0), 'deterministic');
});

test('agent log: validation throws descriptive errors', () => {
  assert.throws(() => add([], {level:'debug'}), /Unknown log level "debug"/);
  assert.throws(() => add([], {level:undefined}), /Unknown log level/);
  assert.throws(() => add([], {taskId:'   '}), /task id is required/);
  assert.throws(() => add([], {taskId:'x'.repeat(81)}), /task id must be at most 80/);
  assert.throws(() => add([], {message:'  '}), /message is required/);
  assert.throws(() => add([], {message:'x'.repeat(501)}), /message must be at most 500/);
  assert.equal(add([], {message:'x'.repeat(500)})[0].message.length, 500);
  assert.throws(() => add([], {data:42}), /data must be text/);
  assert.throws(() => appendEntry([], {taskId:'t', level:'info', message:'m'}, Number.NaN), /Invalid timestamp/);
});

test('agent log: per-task and total caps keep the newest entries', () => {
  let log = [];
  for (let i = 0; i < 205; i++) log = add(log, {message:`m${i}`}, i);
  assert.equal(log.length, 200);
  assert.equal(log[0].message, 'm5');
  assert.equal(log[199].message, 'm204');
  assert.equal(new Set(log.map((e) => e.id)).size, 200, 'ids stay unique after trimming');
  let big = [];
  for (let i = 0; i < 1005; i++) big = add(big, {taskId:`t-${i % 10}`, message:`b${i}`}, i);
  assert.equal(big.length, 1000);
  assert.equal(big[0].message, 'b5');
  assert.equal(big[999].message, 'b1004');
  assert.equal(new Set(big.map((e) => e.id)).size, 1000);
  // same-ms appends after a cap do not collide
  const again = add(add(log, {message:'n1'}, 9999), {message:'n2'}, 9999);
  assert.equal(new Set(again.map((e) => e.id)).size, again.length);
});

test('agent log: redactSecrets masks each pattern and leaves plain text untouched', () => {
  const plain = 'Ran 12 tests in src/ui/agent-log.ts; all passed. Token budget unchanged.';
  assert.deepEqual(redactSecrets(plain), {text:plain, count:0});
  assert.deepEqual(redactSecrets(''), {text:'', count:0});
  const sk = redactSecrets('key sk-abcDEF1234567890xyz used');
  assert.equal(sk.text, 'key [redacted] used');
  assert.equal(sk.count, 1);
  const bearer = redactSecrets('Authorization: Bearer abc.def-ghi_123');
  assert.equal(bearer.text, 'Authorization: Bearer [redacted]');
  assert.equal(bearer.count, 1);
  const hex = redactSecrets(`hash ${'a1b2c3d4'.repeat(4)} end`);
  assert.equal(hex.text, 'hash [redacted] end');
  const b64 = redactSecrets('blob QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYWJjZGVmZ2hpams= end');
  assert.equal(b64.text, 'blob [redacted] end');
  assert.equal(b64.count, 1);
  for (const [input, expected] of [
    ['api_key=hunter2', 'api_key=[redacted]'],
    ['API-KEY: abc', 'API-KEY: [redacted]'],
    ['apikey=zz', 'apikey=[redacted]'],
    ['access_token=xyz&x=1', 'access_token=[redacted]&x=1'],
    ['client_secret: s3cr3t', 'client_secret: [redacted]'],
    ['{"password": "pa55"}', '{"password": "[redacted]"}'],
  ]) {
    const r = redactSecrets(input);
    assert.equal(r.text, expected, input);
    assert.equal(r.count, 1, input);
  }
  const multi = redactSecrets('token=a password=b sk-0123456789abcdef');
  assert.equal(multi.count, 3);
  assert.doesNotMatch(multi.text, /=a|=b|sk-0123/);
});

test('agent log: filterLog orders newest first and matches query case-insensitively', () => {
  let log = [];
  log = add(log, {taskId:'a', level:'info', message:'Start'}, 10);
  log = add(log, {taskId:'b', level:'warn', message:'Slow DISK'}, 30);
  log = add(log, {taskId:'a', level:'error', message:'boom', data:'stack disk trace'}, 20);
  log = add(log, {taskId:'a', level:'result', message:'done'}, 30);
  assert.deepEqual(filterLog(log).map((e) => e.message), ['done', 'Slow DISK', 'boom', 'Start'], 'ties broken by later position first');
  assert.deepEqual(filterLog(log, {taskId:'a'}).map((e) => e.message), ['done', 'boom', 'Start']);
  assert.deepEqual(filterLog(log, {level:'warn'}).map((e) => e.message), ['Slow DISK']);
  assert.deepEqual(filterLog(log, {query:'disk'}).map((e) => e.message), ['Slow DISK', 'boom']);
  assert.deepEqual(filterLog(log, {taskId:'a', query:'DISK'}).map((e) => e.message), ['boom']);
  assert.deepEqual(filterLog(log, {query:'nothing'}), []);
  assert.deepEqual(filterLog(log, {level:''}).length, 4);
  assert.equal(log[0].message, 'Start', 'input order untouched');
});

test('agent log: summarizeTask counts levels and never invents a result', () => {
  let log = [];
  log = add(log, {taskId:'a', level:'info'}, 1);
  log = add(log, {taskId:'a', level:'warn'}, 2);
  log = add(log, {taskId:'b', level:'result', message:'other task'}, 3);
  const none = summarizeTask(log, 'a');
  assert.deepEqual(none, {taskId:'a', total:2, counts:{info:1, warn:1, error:0, result:0}, lastResult:null});
  log = add(log, {taskId:'a', level:'result', message:'first'}, 4);
  log = add(log, {taskId:'a', level:'result', message:'second'}, 5);
  log = add(log, {taskId:'a', level:'error', message:'after'}, 6);
  const sum = summarizeTask(log, 'a');
  assert.deepEqual(sum.counts, {info:1, warn:1, error:1, result:2});
  assert.equal(sum.total, 5);
  assert.equal(sum.lastResult.message, 'second');
  assert.deepEqual(summarizeTask([], 'zzz'), {taskId:'zzz', total:0, counts:{info:0, warn:0, error:0, result:0}, lastResult:null});
});

test('agent log: export redacts and round-trips; parse rejects bad envelopes with exact paths', () => {
  let log = [];
  log = add(log, {taskId:'a', message:'using sk-abcdef1234567890', data:'password=hunter2\nok'}, 1);
  log = add(log, {taskId:'b', level:'result', message:'fine'}, 2);
  const text = exportLog(log);
  assert.doesNotMatch(text, /hunter2|sk-abcdef/);
  const doc = JSON.parse(text);
  assert.equal(doc.format, 'desktop-companion-agent-log');
  assert.equal(doc.version, 1);
  assert.equal(doc.entries[0].data, 'password=[redacted]\nok');
  assert.equal(doc.entries[0].message, 'using [redacted]');
  const back = parseLog(text);
  assert.equal(back.dropped, 0);
  assert.deepEqual(back.entries.map((e) => e.id), log.map((e) => e.id));
  assert.deepEqual(back.entries[1], log[1]);
  const onlyB = JSON.parse(exportLog(log, {taskId:'b'}));
  assert.deepEqual(onlyB.entries.map((e) => e.taskId), ['b']);
  assert.equal(log[0].data, 'password=hunter2\nok', 'export does not mutate the log');

  assert.throws(() => parseLog('{nope'), /^Error: \$: invalid JSON\.$/);
  assert.throws(() => parseLog('[]'), /^Error: \$: expected an object\.$/);
  assert.throws(() => parseLog('null'), /^Error: \$: expected an object\.$/);
  assert.throws(() => parseLog(JSON.stringify({format:'other', version:1, entries:[]})), /^Error: \$\.format: expected "desktop-companion-agent-log"\.$/);
  assert.throws(() => parseLog(JSON.stringify({format:'desktop-companion-agent-log', version:2, entries:[]})), /^Error: \$\.version: expected 1\.$/);
  assert.throws(() => parseLog(JSON.stringify({format:'desktop-companion-agent-log', version:1, entries:{}})), /^Error: \$\.entries: expected an array\.$/);
  const good = log[1];
  const mixed = parseLog(JSON.stringify({format:'desktop-companion-agent-log', version:1, entries:[
    good, {...good}, null, 7, {...good, id:'x1', level:'debug'}, {...good, id:'x2', at:'bad'}, {...good, id:'x3', message:''},
    {...good, id:'x4', taskId:''}, {...good, id:'x5', data:5}, {...good, id:'x6', message:'y'.repeat(501)}, {...good, id:'ok2', progress:50},
  ]}));
  assert.deepEqual(mixed.entries.map((e) => e.id), [good.id, 'ok2']);
  assert.equal('progress' in mixed.entries[1], false);
  assert.equal(mixed.dropped, 9);
  assert.deepEqual(normalizeLog('x'), []);
  assert.deepEqual(normalizeLog([good, good]), [good]);
});

test('agent log: module is offline and Developer page wires the log group through prefs', () => {
  const mod = readFileSync(path.join(root, 'src/ui/agent-log.ts'), 'utf8');
  assert.doesNotMatch(mod, /fetch|XMLHttpRequest|setInterval|setTimeout|WebSocket|document\.|window\./);
  assert.doesNotMatch(mod, /progress|percent/i);
  const src = readFileSync(path.join(root, 'src/components/Developer.tsx'), 'utf8');
  assert.match(src, /usePref<unknown>\(AGENT_LOG_PREF_KEY, \[\]\)/);
  for (const label of ['Agent log', 'Add entry', 'Export JSON', 'Clear task log', 'No result recorded', 'Filter text', '<pre']) assert.ok(src.includes(label), label);
  assert.match(src, /navigator\.clipboard\.writeText\(exportLog\(/);
  assert.match(src, /redactSecrets\(e\.data\)\.text/);
  assert.match(src, /<AgentLogGroup tasks=\{tasks\}/);
});
