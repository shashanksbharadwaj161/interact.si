import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const built = await build({stdin:{contents:`export * from './electron/services/screen-context'; export * from './src/voice/consent'; export {createNativeAdapter} from './electron/native/adapter';`,resolveDir:root,loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {ScreenContext, SelectionGate, nativeMicConsent, createNativeAdapter} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
function clock() {
  let now = 0; const jobs = new Set();const expired=[];
  const store = new ScreenContext(100, () => now, (fn, ms) => {const job={fn,at:now+ms,unref(){}};jobs.add(job);return job;}, job => jobs.delete(job), token=>expired.push(token));
  return {store,jobs,expired,advance(ms,run=true){now+=ms;if(run)for(const job of [...jobs])if(job.at<=now){jobs.delete(job);job.fn();}}};
}
test('screen bytes actively expire while idle, rather than waiting for the next request', () => {
  const f=clock(); f.store.put('one',{png:'private sample bytes'});
  assert.equal(f.store.size,1);f.advance(100);assert.equal(f.store.size,0);assert.equal(f.store.take('one'),null);assert.equal(f.jobs.size,0);assert.deepEqual(f.expired,['one']);
});
test('selected screen context is bounded to one crop, single-use, and wrong tokens cannot consume it', () => {
  const f=clock();f.store.put('old','old bytes');f.store.put('new','new bytes');
  assert.equal(f.jobs.size,1);assert.equal(f.store.take('old'),null);assert.equal(f.store.size,1);
  assert.equal(f.store.take('new'),'new bytes');assert.equal(f.store.take('new'),null);assert.equal(f.jobs.size,0);assert.deepEqual(f.expired,[]);
});
test('expiry is enforced even when a suspended process delays its timer; clear cancels its timer', () => {
  const f=clock();f.store.put('late','bytes');f.advance(101,false);assert.equal(f.store.take('late'),null);
  f.store.put('cancel','bytes');assert.equal(f.store.discard('wrong'),false);f.store.clear();assert.equal(f.jobs.size,0);assert.equal(f.store.size,0);
});
test('cancelled captures cannot resurrect a picker or finish a newer capture', () => {
  const g=new SelectionGate(); const a=g.begin();assert.notEqual(a,null);assert.equal(g.begin(),null);
  g.cancel();assert.equal(g.current(a),false);const b=g.begin();g.finish(a);assert.equal(g.current(b),true);g.finish(b);assert.equal(g.current(b),false);
});
test('native microphone consent cannot be granted by browser grant() or a stale confirmation', async () => {
  let finish;const calls=[];const c=nativeMicConsent({initial:false,set:on=>{calls.push(on);return on?new Promise(r=>finish=r):Promise.resolve(false);}});
  c.grant();assert.equal(c.granted(),false);const pending=c.request(true);await c.request(false);finish(true);await pending;
  assert.equal(c.granted(),false);assert.deepEqual(calls,[true,false]);
});
test('a main-process microphone revocation wins over an older allow response', async () => {
  let finish;const c=nativeMicConsent({initial:false,set:()=>new Promise(r=>finish=r)});
  const pending=c.request(true);c.update(false);finish(true);assert.equal(await pending,false);assert.equal(c.granted(),false);
});
test('typing forwards cancellation to the bounded native runner, without executing desktop input here', async () => {
  const ctl=new AbortController();let args;
  const n=createNativeAdapter({run:async(...a)=>{args=a;return {ok:true,typed:3};}});
  assert.deepEqual(await n.typeText({hwnd:12,pid:24},'abc',ctl.signal),{typed:3});
  assert.equal(args[0],'type-text');assert.equal(args[2].signal,ctl.signal);assert.equal(args[2].timeoutMs,30000);
});
