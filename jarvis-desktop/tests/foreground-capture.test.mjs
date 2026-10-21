import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const built = await build({entryPoints:[fileURLToPath(new URL('../electron/services/foreground-capture.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {ForegroundCapture} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

test('a Windows cold start longer than the old 700 ms deadline can still attach the source app', async () => {
  const gate = new ForegroundCapture();
  const target = {hwnd:12,pid:34};
  const result = await gate.capture(() => new Promise(r => setTimeout(() => r(target), 800)));
  assert.deepEqual(result,{target}); assert.equal(gate.busy,false);
});

test('close, lock or explicit target removal invalidates a pending capture', async () => {
  const gate = new ForegroundCapture(); let finish;
  const old = gate.capture(() => new Promise(r => finish=r));
  await Promise.resolve(); gate.cancel();
  const current = await gate.capture(async () => 'new target');
  finish('old target');
  assert.equal(await old,null); assert.deepEqual(current,{target:'new target'});
});

test('repeated invocation cannot start a second capture or steal focus early', async () => {
  const gate = new ForegroundCapture(); let finish; let reads=0;
  const first = gate.capture(() => new Promise(r => finish=r));
  assert.equal(gate.busy,true);
  assert.equal(await gate.capture(async () => {reads++;return 'wrong';}),null);
  finish('source'); assert.deepEqual(await first,{target:'source'}); assert.equal(reads,0);
});

test('failure and timeout fail closed, without accepting a late app', async () => {
  const gate = new ForegroundCapture(20); let finish;
  assert.deepEqual(await gate.capture(async () => {throw Error('unavailable');}),{target:null});
  const timed = await gate.capture(() => new Promise(r => finish=r));
  assert.deepEqual(timed,{target:null}); finish('late');
  assert.deepEqual(await gate.capture(async () => 'fresh'),{target:'fresh'});
});
