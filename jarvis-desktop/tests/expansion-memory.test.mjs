import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'electron/services/store.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const {ProductivityStore} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const now = '2026-10-14T12:00:00.000Z';
const iso = (days) => new Date(Date.parse(now) - days * 86400000).toISOString();
function fixture() {
  const files = new Map();
  const fs = {
    mkdir: async () => {},
    readFile: async (name) => {if (!files.has(name)) throw new Error('ENOENT'); return files.get(name);},
    writeFile: async (name, value) => {files.set(name,value);},
    rename: async (from,to) => {files.set(to,files.get(from)); files.delete(from);},
    unlink: async (name) => {files.delete(name);},
    readdir: async () => [],
  };
  let id = 0;
  const make = () => new ProductivityStore({dir:path.join(root,'test-memory-fixture'),fs,now:()=>new Date(now),newId:()=>`checkpoint-${++id}`});
  return {files,make,store:make()};
}

test('imported checkpoint dates normalize and persist beside generated timestamps and evidence', async () => {
  const f=fixture(); await f.store.load();
  await f.store.apply({op:'checkpoint.add',title:'Imported milestone',createdAt:'2026-10-13T14:00:00+02:00',capsuleId:'project-1',refs:[{kind:'note',id:'note-1'}]});
  await f.store.apply({op:'checkpoint.add',title:'Current milestone'});
  const state=f.store.snapshot();
  assert.deepEqual(state.checkpoints.map(x=>x.createdAt),[iso(1),now]);
  assert.deepEqual(state.checkpoints[0].refs,[{kind:'note',id:'note-1'}]);
  const reloaded=f.make(); await reloaded.load();
  assert.deepEqual(reloaded.snapshot().checkpoints,state.checkpoints);
});

test('future and invalid imported dates reject atomically without altering saved data', async () => {
  const f=fixture(); await f.store.load();
  await f.store.apply({op:'checkpoint.add',title:'Existing'});
  const before=f.store.snapshot(), saved=f.files.get(f.store.statePath);
  for (const createdAt of ['2026-10-14T12:00:00.001Z','invalid',null,{},'x'.repeat(41)]) {
    await assert.rejects(f.store.apply({op:'checkpoint.add',title:'Rejected',createdAt}),/createdAt/);
    assert.deepEqual(f.store.snapshot(),before);
    assert.equal(f.files.get(f.store.statePath),saved);
  }
});

test('imported checkpoint retention uses original date and explicit forget leaves project goals intact', async () => {
  const f=fixture(); await f.store.load();
  await f.store.apply({op:'capsule.setMeta',capsuleId:'project-1',goals:[{text:'Finish review'}]});
  await f.store.apply({op:'checkpoint.add',title:'Old',createdAt:iso(31)});
  await f.store.apply({op:'checkpoint.add',title:'Recent',createdAt:iso(1)});
  await f.store.apply({op:'policy.set',retainDays:{checkpoints:30}});
  await f.store.applyRetention();
  assert.deepEqual(f.store.snapshot().checkpoints.map(x=>x.title),['Recent']);
  await f.store.apply({op:'forget',scope:'checkpoints'});
  assert.equal(f.store.snapshot().checkpoints.length,0);
  assert.equal(f.store.snapshot().capsuleMeta['project-1'].goals[0].text,'Finish review');
});

test('capacity eviction keeps the newest checkpoint dates instead of late imported old records', async () => {
  const f=fixture(); await f.store.load();
  // Seed a valid fixture envelope; all subsequent writes use the real atomic store.
  const envelope=JSON.parse(f.files.get(f.store.statePath));
  envelope.state.checkpoints=Array.from({length:1000},(_,i)=>({id:`seed-${i}`,title:`Seed ${i}`,note:'',createdAt:iso(1),refs:[]}));
  f.files.set(f.store.statePath,JSON.stringify(envelope));
  const loaded=f.make(); await loaded.load();
  await loaded.apply({op:'checkpoint.add',title:'Ancient import',createdAt:iso(400)});
  assert.equal(loaded.snapshot().checkpoints.length,1000);
  assert.equal(loaded.snapshot().checkpoints.some(x=>x.title==='Ancient import'),false);
  await loaded.apply({op:'checkpoint.add',title:'Newest'});
  assert.equal(loaded.snapshot().checkpoints.length,1000);
  assert.equal(loaded.snapshot().checkpoints.at(-1).title,'Newest');
});
