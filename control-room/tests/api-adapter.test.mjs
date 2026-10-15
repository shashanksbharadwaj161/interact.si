import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {ApiWorkerAdapter} from '../server/api-adapter.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../jarvis-desktop');
const gateway='http://127.0.0.1:4319/anthropic/'+'a'.repeat(64);
const task={projectId:'jarvis-desktop',launchMode:'api-tools',fileOwnership:['docs/native-execution-proof.txt'],model:'claude-haiku-5-5',prompt:'Write a local execution marker.'};
async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'api-adapter-')),calls=[];
  const base=Object.fromEntries(['start','state','projects','addProject','api','cli','spawn','get','details','diff','cancel','followup','resume','stop'].map(method=>[method,async(...args)=>{calls.push([method,...args]);return method;} ]));
  const adapter=new ApiWorkerAdapter({base,dir,repo});
  t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,calls,base,adapter};
}
async function record(f,state){
  const id='api-00000000-0000-4000-8000-000000000000',privateDir=path.join(f.dir,'api-workers',id);await mkdir(privateDir,{recursive:true});
  const r={id,workspace:path.join(f.dir,'api-worktrees',id),stateFile:path.join(privateDir,'state.json'),child:{killed:false,kill(){this.killed=true;return true;}},terminal:null};
  await writeFile(r.stateFile,JSON.stringify(state));f.adapter.workers.set(id,r);return r;
}

test('ordinary AO methods and non-API launches delegate unchanged',async t=>{
  const f=await fixture(t),ordinary={launchMode:'tui-native'};
  assert.equal(await f.adapter.spawn(ordinary,'gateway'),'spawn');
  for(const method of ['start','state','projects','addProject','api','cli','get','details','diff','cancel','followup','resume'])assert.equal(await f.adapter[method]('native-session','x'),method);
  await f.adapter.stop();assert.deepEqual(f.calls[0],['spawn',ordinary,'gateway']);assert.equal(f.calls.at(-1)[0],'stop');
});
test('fixed canonical repository and exact source ownership are mandatory',async t=>{
  const f=await fixture(t);assert.throws(()=>new ApiWorkerAdapter({base:f.base,dir:f.dir,repo:f.dir}),/fixed/);
  let executions=0;f.adapter.execute=async()=>{executions++;throw new Error('unexpected');};
  for(const files of [undefined,[],['src'],['src/folder/'],['src/../escape.ts'],['src\\bad.ts'],['src/private/key.ts'],['src/CON.ts'],['src/secret.pem'],['package.json'],['docs/loop/GOAL.md'],['src/one.ts','src/ONE.ts'],['src/folder.ts','src/folder.ts/child.ts'],['src/a*.ts']])await assert.rejects(f.adapter.spawn({...task,fileOwnership:files},gateway));
  assert.equal(executions,0);
});
test('gateway requires local grant scope and approved task metadata before git',async t=>{
  const f=await fixture(t);let executions=0;f.adapter.execute=async()=>{executions++;throw new Error('unexpected');};
  for(const bad of ['https://example.com/anthropic/'+'a'.repeat(64),'http://localhost:4319/anthropic/'+'a'.repeat(64),gateway+'?key=secret',gateway+'#x','http://user:pass@127.0.0.1:4319/anthropic/'+'a'.repeat(64)])await assert.rejects(f.adapter.spawn(task,bad));
  for(const override of [{projectId:'other'},{model:'unverified'},{prompt:''}])await assert.rejects(f.adapter.spawn({...task,...override},gateway));
  assert.equal(executions,0);
});
test('provision failure never launches a child, and git uses detached worktree without inherited credentials',async t=>{
  const f=await fixture(t);let call,launches=0;f.adapter.execute=async(...args)=>{call=args;throw new Error('sensitive backend output');};f.adapter.launch=()=>{launches++;};
  process.env.API_ADAPTER_TEST_TOKEN='never inherit';process.env.ANTHROPIC_API_KEY='never inherit';process.env.NODE_OPTIONS='--require=bad';
  try{await assert.rejects(f.adapter.spawn(task,gateway),/retained workspace/);}finally{delete process.env.API_ADAPTER_TEST_TOKEN;delete process.env.ANTHROPIC_API_KEY;delete process.env.NODE_OPTIONS;}
  assert.equal(launches,0);assert.equal(call[0],'git');assert.deepEqual(call[1].slice(0,5),['-C',repo,'worktree','add','--detach']);assert.equal(call[1].at(-1),'HEAD');
  assert.equal(call[2].windowsHide,true);assert.equal(call[2].env.ANTHROPIC_API_KEY,undefined);assert.equal(call[2].env.API_ADAPTER_TEST_TOKEN,undefined);assert.equal(call[2].env.NODE_OPTIONS,undefined);
});
test('planner exception is exact, and symlink state roots are rejected before git',async t=>{
  const f=await fixture(t);let executions=0;f.adapter.execute=async()=>{executions++;throw new Error('stop');};
  await assert.rejects(f.adapter.spawn({...task,fileOwnership:['docs/loop/decision.json']},gateway),/retained workspace/);assert.equal(executions,1);
  await assert.rejects(f.adapter.spawn({...task,fileOwnership:['docs/loop/Decision.json']},gateway));assert.equal(executions,1);
  const target=path.join(f.dir,'target'),link=path.join(f.dir,'linked');await mkdir(target);await symlink(target,link,process.platform==='win32'?'junction':'dir');f.adapter.dir=link;
  await assert.rejects(f.adapter.spawn(task,gateway),/reparse/);assert.equal(executions,1);
});
test('loop workers accept sixteen exact source files plus their result marker',async t=>{
  const f=await fixture(t);let executions=0;f.adapter.execute=async()=>{executions++;throw new Error('stop');};
  const files=Array.from({length:16},(_,i)=>'src/api-adapter-fixture-'+i+'.ts');files.push('docs/loop/result.voice-worker.json');
  await assert.rejects(f.adapter.spawn({...task,fileOwnership:files},gateway),/retained workspace/);assert.equal(executions,1);
  for(const marker of ['docs/loop/result.Voice.json','docs/loop/result..json','docs/loop/other.json','docs/loop/result.voice/escape.json'])await assert.rejects(f.adapter.spawn({...task,fileOwnership:[marker]},gateway));
  await assert.rejects(f.adapter.spawn({...task,fileOwnership:Array.from({length:19},(_,i)=>'src/api-adapter-fixture-'+i+'.ts')},gateway));assert.equal(executions,1);
});
test('worker state aliases map to Room states, retain workspace, and report stop reason',async t=>{
  const f=await fixture(t),r=await record(f,{state:'active',summary:'progress'});
  assert.equal((await f.adapter.get(r.id)).status,'working');assert.equal((await f.adapter.get(r.id)).workspacePath,r.workspace);
  for(const [state,status,activity] of [['idle','idle','idle'],['blocked','needs_input','blocked'],['failed','failed','exited']]){
    await writeFile(r.stateFile,JSON.stringify({state,reason:'Context limit reached'}));const s=await f.adapter.get(r.id);assert.equal(s.status,status);assert.equal(s.activity.state,activity);if(state!=='idle')assert.equal(s.error,'Context limit reached');
  }
  await writeFile(r.stateFile,JSON.stringify({state:'active'}));r.exit={code:0};assert.match((await f.adapter.get(r.id)).error,/without a final result/);
  await writeFile(r.stateFile,JSON.stringify({state:'idle',summary:'Finished'}));assert.equal((await f.adapter.get(r.id)).status,'idle');
});
test('details expose only reported summary and tool text; raw hidden fields are discarded',async t=>{
  const f=await fixture(t),r=await record(f,{state:'idle',summary:'Result',thinking:'hidden',events:[{type:'thinking',text:'private'},{activityKind:'reasoning',text:'private'},{tool:'read_file',text:'Read source',input:'private',thinking:'private'},{type:'tool',title:'check',summary:'Passed'}]});
  const details=await f.adapter.details(r.id),serialized=JSON.stringify(details);assert.ok(!serialized.includes('private'));assert.ok(!serialized.includes('hidden'));assert.equal(details.conversation.activities.length,2);assert.equal(details.conversation.messages[0].text,'Result');
  await assert.rejects(f.adapter.diff(r.id,'src/a.ts'),/retained local worktree/);await assert.rejects(f.adapter.resume(r.id),/new explicitly/);
});
test('cancel kills only the owned child and persists termination; unknown API IDs never reach AO',async t=>{
  const f=await fixture(t),r=await record(f,{state:'active'});await f.adapter.cancel(r.id);assert.equal(r.child.killed,true);assert.equal((await f.adapter.get(r.id)).status,'terminated');assert.equal(JSON.parse(await readFile(r.stateFile)).status,'terminated');
  await assert.rejects(f.adapter.cancel('api-unowned'),/not owned/);assert.equal(f.calls.length,0);await f.adapter.stop();assert.equal(f.calls.at(-1)[0],'stop');
});
