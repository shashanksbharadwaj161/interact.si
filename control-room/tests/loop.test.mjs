import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {AgentLoop,validateDecision,validateLoopPath,resolveLoopPath,materializeLoopWorkspace,LOOP_MODELS} from '../server/loop.mjs';

const plan=(observationId,tasks=[{role:'voice',model:LOOP_MODELS[1],goalIds:['voice.local'],files:['src/voice.ts'],instructions:'Implement accessible local voice state with bounded resource cleanup.'}])=>({version:1,observationId,action:'dispatch',tasks,reason:'Implement independently testable local feature.'});
const marker={version:1,done:true,checks:[{command:'unit behavior check',exitCode:0}],summary:'Implemented local behavior',needs_review:false,blocked:false,limitations:[]};
const proof={passed:true,complete:false,checks:[{exitCode:0,outputRef:'trusted-output.txt',fingerprint:'pass'}],sourceFingerprint:'source-1'};
async function fixture(t,options={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'control-loop-')),repo=path.join(root,'repo'),stateDir=path.join(root,'private');
  await mkdir(path.join(repo,'docs/loop'),{recursive:true});await writeFile(path.join(repo,'docs/loop/GOAL.md'),'All approved local features; hardware acceptance stays blocked.');
  let remaining=100,seq=0,verifyCalls=[];const cancels=[];
  const room={online:true,maxWorkers:4,tasks:[],spending:{snapshot:()=>({limit:500,safety:50,remaining,committed:450-remaining})},task(id){const r=this.tasks.find(x=>x.id===id);if(!r)throw new Error('missing');return r;},active(){return this.tasks.filter(x=>x.authorized&&!['complete','failed','cancelled','queued'].includes(x.status));},async create(input){const workspace=path.join(root,'worker-'+ ++seq);await mkdir(path.join(workspace,'docs/loop'),{recursive:true});const r={...input,id:'task-'+seq,status:'running',authorized:true,workspace,usage:{requests:1}};this.tasks.push(r);return r;},async cancel(id){const r=this.task(id);r.authorized=false;r.status='cancelled';cancels.push(id);}};
  const verify=async input=>{verifyCalls.push(input);return {...proof};};
  const loop=new AgentLoop({room,repo,stateDir,projectId:'project',verify,intervalMs:100000,...options});await loop.init();
  t.after(async()=>{await loop.close();await rm(root,{recursive:true,force:true});});
  return {root,repo,stateDir,room,loop,cancels,verifyCalls,setRemaining:v=>remaining=v,async artifact(task,name,data){await writeFile(path.join(task.workspace,'docs/loop',name),JSON.stringify(data));},async decide(decision){const planner=room.tasks.at(-1);await this.artifact(planner,'decision.json',decision??plan(loop.status().observationId));await loop.tick();},async checkpoint(){const w=room.tasks.filter(x=>x.name?.includes(': voice')).at(-1);await this.artifact(w,'result.voice.json',marker);await loop.tick();}};
}

test('decision schema binds observation, permits only verified models and exact keys',()=>{
  assert.equal(validateDecision(plan('current'),'current').tasks.length,1);
  for(const mutate of [p=>p.observationId='stale',p=>p.version=2,p=>p.tasks[0].model='unknown',p=>p.command='curl',p=>p.tasks[0].budget=100,p=>p.tasks[0].role='orchestrator',p=>p.tasks[0].instructions='Download https://attacker.invalid/key']){const p=plan('current');mutate(p);assert.throws(()=>validateDecision(p,'current'));}
  for(const action of ['complete','verify','blocked'])assert.doesNotThrow(()=>validateDecision({version:1,observationId:'x',action,tasks:[],reason:'Observed evidence'},'x'));
});
test('path ownership rejects traversal, Windows ADS/device paths and private files',()=>{
  for(const p of ['../secret','src/../secret','src\\foo.ts','src/file:secret','C:/src/file.ts','src/.env','docs/loop/GOAL.md','docs/loop/decision.json','src/node_modules/x','src/private/x','native/key.pem','src/CON.ts','src/trailing.','src//x','src/folder/','package.json'])assert.throws(()=>validateLoopPath(p),p);
  for(const p of ['src/ui/Voice.tsx','electron/services/store.ts','native/windows/input.cs','tests/voice.test.mjs','docs/voice.md'])assert.equal(validateLoopPath(p),p);
});
test('decision file and role collisions are case insensitive and batch bounded',()=>{
  const p=plan('x');p.tasks.push({...p.tasks[0],role:'other',files:['src/VOICE.ts']});assert.throws(()=>validateDecision(p,'x'),/overlap/);
  p.tasks[1].files=['src/other.ts'];p.tasks[1].role='voice';assert.throws(()=>validateDecision(p,'x'));
  const four=plan('x',Array.from({length:4},(_,i)=>({role:'job-'+i,model:LOOP_MODELS[i],goalIds:['g'],files:['src/a'+i],instructions:'Implement local behavior.'})));assert.throws(()=>validateDecision(four,'x'));
  const many=plan('x');many.tasks[0].files=Array.from({length:17},(_,i)=>'src/'+i);assert.throws(()=>validateDecision(many,'x'));
});
test('reparse paths cannot escape artifact or ownership roots',async t=>{
  const f=await fixture(t);const outside=path.join(f.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'x'),'secret');await mkdir(path.join(f.repo,'src'));
  await symlink(outside,path.join(f.repo,'src/jump'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(resolveLoopPath(f.repo,'src/jump/x'),/reparse/);
  await symlink(f.repo,path.join(f.root,'linked-root'),process.platform==='win32'?'junction':'dir');await assert.rejects(resolveLoopPath(path.join(f.root,'linked-root'),'docs/loop/GOAL.md'),/reparse/);
});
test('init/restart never launches, approves, or reauthorizes native workers',async t=>{
  const f=await fixture(t);assert.equal(f.room.tasks.length,0);await assert.rejects(f.loop.start(),/pilot/);
  await f.loop.start({nativeReady:true});assert.equal(f.room.tasks.length,1);await f.loop.stop();
  const copy=new AgentLoop({room:f.room,repo:f.repo,stateDir:f.stateDir,projectId:'project',verify:async()=>proof});await copy.init();assert.equal(copy.status().status,'paused');assert.equal(f.room.tasks.length,1);assert.equal(copy.status().timerActive,false);
});
test('planner and workers use shared global guard with high effort, no financial task cap',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});const planner=f.room.tasks[0];assert.equal(planner.model,'claude-fable-5-1');assert.equal(planner.budgetMode,'shared');assert.equal(planner.budget,undefined);assert.equal(planner.launchMode,'tui-native');assert.equal(planner.effort,'high');
  await f.decide();const worker=f.room.tasks[1];assert.equal(worker.model,'claude-opus-5-5');assert.equal(worker.budgetMode,'shared');assert.equal(worker.budget,undefined);assert.equal(worker.launchMode,'tui-native');assert.match(worker.prompt,/ONLY these exact files/);assert.equal(f.loop.status().phase,'workers');assert.deepEqual(f.cancels,['task-1']);
});
test('worker marker is only a checkpoint; independent verifier gets exact scope and raw output is recorded',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});await f.decide();await f.checkpoint();
  assert.equal(f.verifyCalls.length,1);assert.deepEqual(f.verifyCalls[0].workers[0].files,['src/voice.ts']);assert.equal(f.verifyCalls[0].workers[0].workspace,f.room.tasks[1].workspace);assert.equal(f.loop.status().status,'running');
  const observation=JSON.parse(await readFile(path.join(f.repo,'docs/loop/OBSERVATIONS.json')));assert.equal(observation.verification.checks[0].outputRef,'trusted-output.txt');assert.equal(observation.verification.checks[0].exitCode,0);assert.equal(f.loop.status().phase,'idle');await f.loop.tick();assert.equal(f.room.tasks.length,3);
});
test('only trusted verifier can converge, never a Fable complete declaration',async t=>{
  let calls=0;const f=await fixture(t,{verify:async()=>{calls++;return {...proof,complete:true};}});await f.loop.start({nativeReady:true});await f.decide({version:1,observationId:f.loop.status().observationId,action:'complete',tasks:[],reason:'Planner considers goal done'});
  assert.equal(f.loop.status().status,'running');assert.equal(calls,0);await f.loop.tick();assert.equal(calls,1);assert.equal(f.loop.status().status,'complete');assert.equal(f.loop.status().timerActive,false);
});
test('empty verifier checks cannot declare convergence',async t=>{
  const f=await fixture(t,{verify:async()=>({passed:true,complete:true,checks:[]})});await f.loop.start({nativeReady:true});await f.decide({version:1,observationId:f.loop.status().observationId,action:'complete',tasks:[],reason:'Claim done'});await f.loop.tick();assert.notEqual(f.loop.status().status,'complete');
});
test('budget exhaustion stops owned workers and preserves global settings',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});f.setRemaining(0);await f.loop.tick();assert.equal(f.loop.status().status,'budget_exhausted');assert.equal(f.room.tasks[0].authorized,false);assert.equal(f.room.maxWorkers,4);assert.equal(f.room.online,true);assert.equal(f.loop.status().budget.limit,500);assert.equal(f.loop.status().budget.safety,50);
});
test('stop kill switch scopes cancellation to loop-owned task IDs and clears timer',async t=>{
  const f=await fixture(t);const unrelated=await f.room.create({name:'Unrelated existing task'});await f.loop.start({nativeReady:true});await f.loop.stop('Pause requested');assert.equal(unrelated.authorized,true);assert.equal(f.loop.status().timerActive,false);assert.equal(f.loop.status().status,'stopped');const count=f.room.tasks.length;await f.loop.tick();assert.equal(f.room.tasks.length,count);assert.equal(f.cancels.includes(unrelated.id),false);
});
test('overlapping ticks do not duplicate Fable work or cloud planning without observation change',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});await Promise.all(Array.from({length:20},()=>f.loop.tick()));assert.equal(f.room.tasks.length,1);assert.equal(f.loop.status().phase,'planning');
});
test('second controller cannot write or start while first holds lock',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});const before=await readFile(f.loop.file,'utf8');const other=new AgentLoop({room:f.room,repo:f.repo,stateDir:f.stateDir,projectId:'project',verify:async()=>proof});await other.init();assert.equal(await readFile(f.loop.file,'utf8'),before);await assert.rejects(other.start({nativeReady:true}),/owns this state/);
});
test('bounded artifact reads reject oversized planner output',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});const planner=f.room.tasks[0];await writeFile(path.join(planner.workspace,'docs/loop/decision.json'),'x'.repeat(131073));planner.status='review';await f.loop.tick();assert.match(JSON.parse(await readFile(path.join(f.repo,'docs/loop/OBSERVATIONS.json'))).error,/exceeds bound/);assert.equal(f.loop.status().phase,'idle');
});
test('zero-inference review at native startup waits for the actual planner checkpoint',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});f.room.tasks[0].usage.requests=0;f.room.tasks[0].status='review';await f.loop.tick();assert.equal(f.loop.status().status,'running');assert.equal(f.loop.status().phase,'planning');assert.equal(f.room.tasks.length,1);await f.decide();assert.equal(f.loop.status().phase,'workers');
});
test('hardware/account/review markers block without integration or false completion',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});await f.decide();await f.artifact(f.room.tasks[1],'result.voice.json',{...marker,needs_review:true,summary:'Real microphone consent acceptance required'});await f.loop.tick();assert.equal(f.loop.status().status,'blocked');assert.match(f.loop.status().reason,/microphone/);assert.equal(f.verifyCalls.length,0);
});
test('three identical verification signatures halt no-progress, without an iteration cap',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});
  for(let i=0;i<3;i++){await f.decide({version:1,observationId:f.loop.status().observationId,action:'verify',tasks:[],reason:'Verify current local state'});await f.loop.tick();if(i<2)await f.loop.tick();}
  assert.equal(f.loop.status().status,'blocked');assert.match(f.loop.status().reason,/three identical/);assert.equal(f.room.tasks.length,3);
});
test('same planner failure permits only two retries, then blocks',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});
  for(let i=0;i<3;i++){await f.artifact(f.room.tasks.at(-1),'decision.json',{bad:'schema'});await f.loop.tick();if(i<2)await f.loop.tick();}
  assert.equal(f.loop.status().status,'blocked');assert.match(f.loop.status().reason,/same failure three times/);assert.equal(f.room.tasks.length,3);
});
test('room concurrency is respected without changing room policy or dispatching overflow',async t=>{
  const f=await fixture(t);f.room.maxWorkers=1;await f.loop.start({nativeReady:true});const p=plan(f.loop.status().observationId);p.tasks.push({...p.tasks[0],role:'motion',files:['src/motion.ts']});await f.decide(p);assert.equal(f.loop.status().phase,'waiting_capacity');assert.equal(f.room.tasks.length,1);f.room.maxWorkers=2;await f.loop.tick();assert.equal(f.room.tasks.length,3);assert.equal(f.room.tasks.filter(t=>t.authorized).length,2);
});
test('stop racing create cancels the just-created task without subsequent dispatch',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});const original=f.room.create.bind(f.room);let release,entered;const gate=new Promise(r=>release=r),enteredGate=new Promise(r=>entered=r);
  f.room.create=async input=>{entered();await gate;return original(input);};await f.artifact(f.room.tasks[0],'decision.json',plan(f.loop.status().observationId));const ticking=f.loop.tick();await enteredGate;const stopping=f.loop.stop();release();await Promise.all([ticking,stopping]);assert.equal(f.loop.status().status,'stopped');assert.equal(f.room.tasks.filter(x=>x.authorized).length,0);assert.equal(f.room.tasks.length,2);
});
test('trusted verification must return actual exit codes and raw log references',async t=>{
  const f=await fixture(t,{verify:async()=>({passed:true,complete:true,checks:[{summary:'It passed'}]})});await f.loop.start({nativeReady:true});await f.decide({version:1,observationId:f.loop.status().observationId,action:'verify',tasks:[],reason:'Check local state'});await f.loop.tick();assert.notEqual(f.loop.status().status,'complete');assert.match(JSON.parse(await readFile(path.join(f.repo,'docs/loop/OBSERVATIONS.json'))).error,/actual exit codes/);
});
test('free timer does not spawn repeated planners while waiting for an active worker',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true,intervalMs:20});await new Promise(r=>setTimeout(r,85));assert.equal(f.room.tasks.length,1);await f.loop.stop();assert.equal(f.loop.status().timerActive,false);
});
test('incomplete live checkpoint waits; it never triggers integration',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});await f.decide();await f.artifact(f.room.tasks[1],'result.voice.json',{version:1,done:false,checks:[]});await f.loop.tick();assert.equal(f.loop.status().phase,'workers');assert.equal(f.verifyCalls.length,0);await f.checkpoint();assert.equal(f.verifyCalls.length,1);
});
test('native timeouts and pending input stop rather than autoapprove or spin',async t=>{
  let now=1000;const f=await fixture(t,{now:()=>now,timeoutMs:1000});await f.loop.start({nativeReady:true});now=2001;await f.loop.tick();assert.equal(f.loop.status().status,'blocked');assert.match(f.loop.status().reason,/timed out/);assert.equal(f.room.tasks[0].authorized,false);
});
test('trusted verifier hardware gate cannot become completion even with passing checks',async t=>{
  const f=await fixture(t,{verify:async()=>({...proof,complete:true,blocked:true,reason:'Account OAuth acceptance still required'})});await f.loop.start({nativeReady:true});await f.decide({version:1,observationId:f.loop.status().observationId,action:'complete',tasks:[],reason:'Looks complete'});await f.loop.tick();assert.equal(f.loop.status().status,'blocked');assert.match(f.loop.status().reason,/OAuth/);
});
test('unconfirmed cancellation halts retries instead of overlapping a replacement',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});const cancel=f.room.cancel.bind(f.room);f.room.cancel=async()=>{throw new Error('Native worker not confirmed terminated');};await f.artifact(f.room.tasks[0],'decision.json',{invalid:true});await f.loop.tick();assert.equal(f.loop.status().status,'blocked');assert.equal(f.room.tasks.length,1);assert.equal(f.loop.status().cancelErrors.length,1);f.room.cancel=cancel;
});
test('stop during verification cannot publish late completion',async t=>{
  let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);const f=await fixture(t,{verify:async()=>{enter();await gate;return {...proof,complete:true};}});await f.loop.start({nativeReady:true});await f.decide({version:1,observationId:f.loop.status().observationId,action:'verify',tasks:[],reason:'Check all goals'});const tick=f.loop.tick();await entered;const stop=f.loop.stop();release();await Promise.all([tick,stop]);assert.equal(f.loop.status().status,'stopped');assert.equal(f.loop.status().timerActive,false);
});
test('native workers reporting review early wait for result artifacts without retries or false integration',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});await f.decide();f.room.tasks[1].usage.requests=0;f.room.tasks[1].status='review';await f.loop.tick();assert.equal(f.loop.status().phase,'workers');assert.equal(f.room.tasks.length,2);assert.equal(f.verifyCalls.length,0);await f.checkpoint();assert.equal(f.verifyCalls.length,1);
});
test('actual failed/cancelled native workers still fail promptly despite startup grace',async t=>{
  const f=await fixture(t);await f.loop.start({nativeReady:true});f.room.tasks[0].status='failed';await f.loop.tick();assert.equal(f.loop.status().phase,'idle');assert.match(JSON.parse(await readFile(path.join(f.repo,'docs/loop/OBSERVATIONS.json'))).error,/stopped: failed/);
});
test('zero-inference review without a checkpoint eventually stops at trusted timeout',async t=>{
  let now=0;const f=await fixture(t,{now:()=>now,timeoutMs:1000});await f.loop.start({nativeReady:true});f.room.tasks[0].usage.requests=0;f.room.tasks[0].status='review';now=900;await f.loop.tick();assert.equal(f.loop.status().status,'running');now=1001;await f.loop.tick();assert.equal(f.loop.status().status,'blocked');assert.match(f.loop.status().reason,/zero provider calls/);
});

async function snapshotFixture(t){
  const f=await fixture(t),workspace=path.join(f.root,'fresh-worktree'),gitDir=path.join(f.repo,'.git/worktrees/worker');await mkdir(workspace);await mkdir(gitDir,{recursive:true});await writeFile(path.join(workspace,'.git'),'gitdir: '+gitDir+'\n');await writeFile(path.join(gitDir,'gitdir'),path.join(workspace,'.git')+'\n');await mkdir(path.join(f.repo,'src/shared'),{recursive:true});await writeFile(path.join(f.repo,'package.json'),'{"name":"app"}');await writeFile(path.join(f.repo,'src/shared/feature-registry.json'),'{"features":[{"id":"g1"}]}');await writeFile(path.join(f.repo,'src/current.ts'),'export const version = 2;');return {...f,workspace};
}
test('trusted prelaunch materialization inherits canonical dirty/untracked source without dependencies, keys, outputs or active markers',async t=>{
  const f=await snapshotFixture(t);await mkdir(path.join(f.repo,'node_modules'));await writeFile(path.join(f.repo,'node_modules/huge.js'),'dependency');await mkdir(path.join(f.repo,'release'));await writeFile(path.join(f.repo,'release/installer.exe'),'binary');await writeFile(path.join(f.repo,'.env'),'secret');await writeFile(path.join(f.repo,'docs/loop/decision.json'),'old decision');await writeFile(path.join(f.repo,'docs/loop/result.old.json'),'old marker');await mkdir(path.join(f.workspace,'src/shared'),{recursive:true});await writeFile(path.join(f.workspace,'src/stale.ts'),'deleted canonical');await writeFile(path.join(f.workspace,'src/current.ts'),'old head');
  const receipt=await materializeLoopWorkspace({repo:f.repo,workspace:f.workspace});assert.equal(await readFile(path.join(f.workspace,'src/current.ts'),'utf8'),'export const version = 2;');assert.equal(await readFile(path.join(f.workspace,'docs/loop/GOAL.md'),'utf8'),await readFile(path.join(f.repo,'docs/loop/GOAL.md'),'utf8'));assert.equal(receipt.removed,1);assert.ok(receipt.files>=4);
  for(const p of ['node_modules/huge.js','release/installer.exe','.env','src/stale.ts','docs/loop/decision.json','docs/loop/result.old.json'])await assert.rejects(readFile(path.join(f.workspace,p)),{code:'ENOENT'});
});
test('materialization rejects unrelated destination, reparse source and credential-like contents before writing source',async t=>{
  const f=await snapshotFixture(t);await writeFile(path.join(f.repo,'src/key.ts'),'const key="sk-ant-api03-'+ 'a'.repeat(80)+'";');await assert.rejects(materializeLoopWorkspace({repo:f.repo,workspace:f.workspace}),/credential-like/);await assert.rejects(readFile(path.join(f.workspace,'src/current.ts')),{code:'ENOENT'});await rm(path.join(f.repo,'src/key.ts'));
  const outside=path.join(f.root,'outside');await mkdir(outside);await symlink(outside,path.join(f.repo,'src/linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(materializeLoopWorkspace({repo:f.repo,workspace:f.workspace}),/Reparse/);await rm(path.join(f.repo,'src/linked'));
  await writeFile(path.join(f.workspace,'.git'),'gitdir: '+outside+'\n');await assert.rejects(materializeLoopWorkspace({repo:f.repo,workspace:f.workspace}),/does not belong/);
});
test('API loop owns exact artifacts and waits for worker idle before cancelling settled calls',async t=>{const f=await fixture(t,{launchMode:'api-tools'});await f.loop.start({nativeReady:true});const planner=f.room.tasks[0];assert.equal(planner.launchMode,'api-tools');assert.deepEqual(planner.fileOwnership,['docs/loop/decision.json']);await f.artifact(planner,'decision.json',plan(f.loop.status().observationId));await f.loop.tick();assert.equal(f.loop.status().phase,'planning');assert.equal(f.cancels.length,0);planner.status='review';await f.loop.tick();const worker=f.room.tasks.at(-1);assert.deepEqual(worker.fileOwnership,['src/voice.ts','docs/loop/result.voice.json']);await f.artifact(worker,'result.voice.json',marker);await f.loop.tick();assert.equal(f.verifyCalls.length,0);worker.status='review';await f.loop.tick();assert.equal(f.verifyCalls.length,1);});
test('failed round checkpoints cannot leak into the next integration attempt',async t=>{const f=await fixture(t);await f.loop.start({nativeReady:true});const p=plan(f.loop.status().observationId);p.tasks.push({...p.tasks[0],role:'other',files:['src/other.ts']});await f.decide(p);const [voice,other]=f.room.tasks.slice(-2);await f.artifact(voice,'result.voice.json',marker);await f.loop.tick();assert.equal(f.loop.state.ownTasks.find(r=>r.taskId===voice.id).result.done,true);const oldRound=f.loop.status().round;other.status='failed';await f.loop.tick();assert.equal(f.loop.status().round,oldRound+1);assert.equal(f.loop.state.decision,undefined);assert.ok(f.loop.state.ownTasks.filter(r=>r.result).every(r=>r.round<f.loop.status().round));});
