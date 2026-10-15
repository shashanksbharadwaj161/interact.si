import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Orchestrator} from '../server/adapter.mjs';
import {Room} from '../server/room.mjs';
const exec=promisify(execFile);
const models=['claude-fable-5-1','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5'];
const task={projectId:'fixture',name:'Synthetic worker',prompt:'Synthetic task',model:models[0],effort:'high'};
// Exercise the adapter's actual argv/env subprocess boundary, without a daemon,
// credentials, provider requests, real sessions, or worktree mutations.
async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'control-room-native-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const script=path.join(dir,'fake-ao.mjs'),log=path.join(dir,'calls.ndjson');
  await writeFile(script,`import fs from 'node:fs';
const a=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='fake-git')console.log('main');
else if(a[0]==='project'&&a[1]==='get')console.log(JSON.stringify({project:{path:process.env.FIXTURE_REPO}}));
else if(a[0]==='spawn')console.log('spawned session fixture-session');
else if(a[0]==='session'&&a[1]==='get')console.log(JSON.stringify({session:{status:'working',activity:{state:'active'}}}));
else console.log('ok');`);
  const adapter=new Orchestrator(dir,'fake-ao',{execute:(binary,args,opts)=>exec(process.execPath,[script,...(binary==='git'?['fake-git']:args)],{...opts,env:{...opts.env,FIXTURE_LOG:log,FIXTURE_REPO:dir}})});
  let refreshes=0;adapter.api=async()=>{refreshes++;return {};};
  return {adapter,dir,calls:async()=>(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),refreshes:()=>refreshes};
}
for(const model of models)test(`explicit native launch pins ${model} and avoids ACP`,async t=>{
  const f=await fixture(t);assert.equal(await f.adapter.spawn({...task,model,launchMode:'tui-native'},'http://127.0.0.1:4317/anthropic/synthetic-grant'),'fixture-session');
  assert.equal(f.refreshes(),0);const calls=await f.calls();
  const config=JSON.parse(calls.find(a=>a[1]==='set-config').at(-1));
  assert.equal(config.env.ANTHROPIC_MODEL,model);assert.equal(config.env.CLAUDE_CODE_EFFORT_LEVEL,'high');
  assert.equal(config.env.ANTHROPIC_API_KEY,'control-room-broker');assert.equal(config.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:4317/anthropic/synthetic-grant');
  assert.equal(config.agentConfig.model,'');assert.equal(config.agentConfig.effort,'');assert.equal(config.worker.agentConfig.model,'');assert.equal(config.worker.agentConfig.effort,'');
  const spawn=calls.find(a=>a[0]==='spawn');assert.equal(spawn[spawn.indexOf('--mode')+1],'tui');assert.ok(!spawn.includes('--model'));
  assert.equal((await f.adapter.get('fixture-session')).activity.state,'active');await f.adapter.cancel('fixture-session');await f.adapter.followup('fixture-session','Synthetic follow-up');
  const follow=await f.calls();assert.ok(follow.some(a=>a[0]==='session'&&a[1]==='kill'&&a[2]==='fixture-session'));assert.ok(follow.some(a=>a[0]==='send'&&a.includes('--steer')));
});
test('default Chat retains pinned argv and fails closed on stale discovery without fallback',async t=>{
  const f=await fixture(t);await f.adapter.spawn(task,'http://127.0.0.1:4317/anthropic/synthetic');assert.equal(f.refreshes(),1);
  const spawn=(await f.calls()).find(a=>a[0]==='spawn');assert.equal(spawn[spawn.indexOf('--mode')+1],'chat');assert.equal(spawn[spawn.indexOf('--model')+1],task.model);
  f.adapter.api=async()=>{throw new Error('Model catalog unavailable');};
  await assert.rejects(f.adapter.spawn(task,'http://127.0.0.1:4317/anthropic/synthetic'),/catalog unavailable/);
  assert.equal((await f.calls()).filter(a=>a[0]==='spawn').length,1);
});
test('unknown native model or mode rejected before subprocess/config mutation',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.adapter.spawn({...task,launchMode:'tui-native',model:'unverified-model'},'synthetic'),/approved pinned/);
  await assert.rejects(f.adapter.spawn({...task,launchMode:'auto-fallback'},'synthetic'),/Unsupported/);
  await assert.rejects(readFile(path.join(f.dir,'calls.ndjson')),e=>e.code==='ENOENT');
});
test('same project launch configuration cannot interleave distinct broker grants',async t=>{
  const f=await fixture(t);
  await Promise.all(['first','second'].map(grant=>f.adapter.spawn({...task,launchMode:'tui-native'},`http://127.0.0.1:4317/anthropic/${grant}`)));
  const calls=(await f.calls()).filter(a=>a[1]==='set-config'||a[0]==='spawn');
  assert.deepEqual(calls.map(a=>a[0]==='spawn'?'spawn':JSON.parse(a.at(-1)).env.ANTHROPIC_BASE_URL.split('/').at(-1)),['first','spawn','second','spawn']);
});
test('Room persists explicit mode, passes it through queue and cancels scoped grant',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'control-room-native-room-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let received;const cancelled=[];const adapter={start:async()=>{},spawn:async task=>{received=task;return 'synthetic';},cancel:async id=>cancelled.push(id)};
  const room=new Room(dir,adapter,{get:async()=>{},cached:null});room.online=true;room.port=4317;room.kick=()=>{};
  const created=await room.create({...task,model:'opus',launchMode:'tui-native',mode:'real',budget:2});
  assert.equal(created.launchMode,'tui-native');assert.equal(created.model,models[1]);await room.pump();assert.equal(received.launchMode,'tui-native');
  assert.ok(room.grants.size===1);assert.ok(!('grant' in room.publicTask(received)));await room.cancel(created.id);assert.equal(room.grants.size,0);assert.deepEqual(cancelled,['synthetic']);
  assert.equal(JSON.parse(await readFile(room.file,'utf8')).tasks[0].launchMode,'tui-native');
  await assert.rejects(room.create({...task,launchMode:'invalid',mode:'real'}),/launch mode/);
  const defaultTask=await room.create({...task,mode:'real'});assert.equal(defaultTask.launchMode,'chat');
});
test('loop materializer hook is restricted to trusted project and shared native loop tasks',async t=>{const f=await fixture(t);await assert.rejects(f.adapter.spawn({...task,projectId:'jarvis-desktop',name:'Loop 1: orchestrator',budgetMode:'shared',launchMode:'tui-native'},'http://127.0.0.1:4317/anthropic/synthetic'),/trusted application checkout/);assert.equal((await f.calls()).some(a=>a[0]==='spawn'),false);});
