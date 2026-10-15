import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyStop, stopReport, RETRY } from '../server/status-errors.mjs';
import { Room, deriveStatus } from '../server/room.mjs';

const LAUNCH={kind:'service',text:'Orchestrator session worker-1 launched.'};
const BUDGET_EVENT={kind:'error',text:'Spending reservation denied: shared or task budget would be exceeded'};
const USAGE_EVENT={kind:'usage',text:'claude-sonnet-5-5: 34 input / 20 output tokens reported.'};

class FakeAdapter {
 constructor(){this.session={status:'working',activity:{state:'active'}};this.cancelled=[];}
 async state(){return {state:'ready'};}
 async get(){return this.session;}
 async cancel(id){this.cancelled.push(id);}
}
class FakeVault {constructor(){this.cached='sk-ant-test-'+'x'.repeat(24);}async get(){return this.cached;}}

async function fixture(session){
 const dir=await mkdtemp(path.join(os.tmpdir(),'control-room-status-'));
 const adapter=new FakeAdapter();adapter.session=session;
 const room=new Room(dir,adapter,new FakeVault());room.online=true;
 const task={id:'task-1',name:'Test task',prompt:'Do work',model:'claude-opus-5-5',effort:'high',projectId:'p',mode:'real',status:'running',createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z',events:[LAUNCH],sessionId:'worker-1',actualModel:null,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,requests:0},rates:{},cost:0,budget:5,reviewed:false,authorized:true,grant:'grant-1'};
 room.tasks.push(task);room.grants.set('grant-1','task-1');
 return {dir,room,task,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

test('classifier: clean idle has no stop evidence', () => {
 assert.deepEqual(classifyStop({status:'working',activity:{state:'idle'}},[LAUNCH]),{outcome:'success',kind:null,reason:null,retry:null});
 assert.equal(stopReport({activity:{state:'idle'}},[LAUNCH]),null);
});

test('classifier: budget denial blocks with readable reason and retry text', () => {
 const stop=classifyStop({activity:{state:'idle'}},[LAUNCH,BUDGET_EVENT]);
 assert.equal(stop.outcome,'blocked');
 assert.equal(stop.kind,'budget');
 assert.match(stop.reason,/Spending reservation denied/);
 assert.equal(stop.retry,RETRY.budget);
 assert.match(stop.retry,/Nothing was reset or raised/);
});

test('classifier: context limit blocks and says the worker cannot continue the conversation', () => {
 const stop=classifyStop({status:'idle',lastError:'Prompt is too long: 210432 tokens > 200000 maximum'},[LAUNCH]);
 assert.equal(stop.outcome,'blocked');
 assert.equal(stop.kind,'context');
 assert.equal(stop.retry,RETRY.context);
});

test('classifier: worker error is an error, not review-ready output', () => {
 const stop=classifyStop({status:'idle',errorMessage:'API Error: 500 overloaded'},[LAUNCH]);
 assert.equal(stop.outcome,'error');
 assert.equal(stop.kind,'worker-error');
 assert.equal(stop.retry,RETRY.error);
});

test('classifier: budget events before an explicit resume do not block the resumed worker', () => {
 const events=[LAUNCH,BUDGET_EVENT,{kind:'service',text:'Worker resumed explicitly.'}];
 assert.equal(classifyStop({activity:{state:'idle'}},events).outcome,'success');
});

test('classifier: a later completed response recovers a transient gateway failure', () => {
 const events=[LAUNCH,{kind:'error',text:'fetch failed'},USAGE_EVENT];
 assert.equal(classifyStop({status:'idle'},events).outcome,'success');
 assert.equal(deriveStatus({status:'idle'},events),'review');
 assert.equal(stopReport({status:'idle'},events),null);
});

test('classifier: recovery requires reported usage later than the error in this launch', () => {
 for(const events of [
  [LAUNCH,USAGE_EVENT,{kind:'error',text:'fetch failed'}],
  [LAUNCH,{kind:'error',text:'fetch failed'},{kind:'usage',text:'Request started'}],
  [USAGE_EVENT,LAUNCH,{kind:'error',text:'fetch failed'}]
 ])assert.equal(classifyStop({status:'idle'},events).outcome,'error');
});

test('classifier: successful usage does not clear explicit session errors or unrelated failures', () => {
 assert.equal(classifyStop({status:'idle',lastError:'fetch failed'},[LAUNCH,USAGE_EVENT]).outcome,'error');
 assert.equal(classifyStop({status:'idle'},[LAUNCH,{kind:'error',text:'Worker failed: test assertion'},USAGE_EVENT]).outcome,'error');
});

test('classifier: usage never clears unresolved spending or context stops', () => {
 assert.equal(classifyStop({status:'idle'},[LAUNCH,BUDGET_EVENT,USAGE_EVENT]).kind,'budget');
 const context={kind:'error',text:'Spending reservation denied: Token count unavailable or context exceeds development limit'};
 assert.equal(classifyStop({status:'idle'},[LAUNCH,context,USAGE_EVENT]).kind,'context');
 assert.equal(classifyStop({lastError:context.text},[LAUNCH]).kind,'context');
});

test('deriveStatus: idle is review only without stop evidence', () => {
 assert.equal(deriveStatus({status:'working',activity:{state:'idle'}}),'review');
 assert.equal(deriveStatus({status:'working',activity:{state:'idle'}},[LAUNCH]),'review');
 assert.equal(deriveStatus({status:'working',activity:{state:'idle'}},[LAUNCH,BUDGET_EVENT]),'awaiting input');
 assert.equal(deriveStatus({status:'idle',errorMessage:'Worker failed: timed out'},[LAUNCH]),'failed');
 assert.equal(deriveStatus({status:'idle',lastError:'context window limit reached'},[LAUNCH]),'awaiting input');
});

test('deriveStatus: blocked and active keep their existing meaning', () => {
 assert.equal(deriveStatus({status:'working',activity:{state:'blocked'}},[LAUNCH,BUDGET_EVENT]),'awaiting input');
 assert.equal(deriveStatus({status:'idle',activity:{state:'active'}},[LAUNCH,BUDGET_EVENT]),'running');
 assert.equal(deriveStatus({status:'no_signal'}),null);
});

test('poll: idle after budget denial stays blocked, is not review-ready, and loses gateway access', async () => {
 const f=await fixture({status:'idle',activity:{state:'idle'},error:'Spending reservation denied: shared or task budget would be exceeded'});
 try{
  await f.room.poll();
  const t=f.room.task('task-1');
  assert.equal(t.status,'awaiting input');
  assert.equal(t.stopReport.kind,'budget');
  assert.match(t.stopReport.reason,/Spending reservation denied/);
  assert.equal(t.stopReport.retry,RETRY.budget);
  assert.equal(t.authorized,false);
  assert.equal(f.room.grants.size,0);
  assert.ok(t.events.some(e=>e.kind==='budget'&&e.text.includes(RETRY.budget)));
  assert.equal(f.room.publicTask(t).grant,undefined);
  // Explicit resume cannot clear a budget stop; the message is the retry instruction.
  await assert.rejects(f.room.resume('task-1'),{message:RETRY.budget});
 }finally{await f.cleanup();}
});

test('poll: context limit is blocked with retry instructions and resume refuses it', async () => {
 const f=await fixture({status:'idle',activity:{state:'idle'},lastError:'Prompt is too long: 210432 tokens > 200000 maximum'});
 try{
  await f.room.poll();
  const t=f.room.task('task-1');
  assert.equal(t.status,'awaiting input');
  assert.equal(t.stopReport.kind,'context');
  assert.equal(t.authorized,false);
  await assert.rejects(f.room.resume('task-1'),{message:RETRY.context});
 }finally{await f.cleanup();}
});

test('poll: worker error becomes failed with a readable error event and revoked access', async () => {
 const f=await fixture({status:'idle',activity:{state:'idle'},errorMessage:'API Error: 500 overloaded'});
 try{
  await f.room.poll();
  const t=f.room.task('task-1');
  assert.equal(t.status,'failed');
  assert.equal(t.stopReport.kind,'worker-error');
  assert.equal(t.authorized,false);
  assert.ok(t.events.some(e=>e.kind==='error'&&e.text.includes('API Error')));
 }finally{await f.cleanup();}
});

test('poll: clean idle still reaches review with no stop report', async () => {
 const f=await fixture({status:'working',activity:{state:'idle'}});
 try{
  await f.room.poll();
  const t=f.room.task('task-1');
  assert.equal(t.status,'review');
  assert.equal(t.stopReport,null);
  assert.equal(t.authorized,true);
 }finally{await f.cleanup();}
});

test('poll: recovered transient error keeps access and requires review, never marks complete', async () => {
 const f=await fixture({status:'idle',activity:{state:'idle'}});
 try{
  f.task.events.push({kind:'error',text:'API Error: 503 overloaded'},USAGE_EVENT);
  await f.room.poll();
  assert.equal(f.task.status,'review');
  assert.equal(f.task.reviewed,false);
  assert.equal(f.task.stopReport,null);
  assert.equal(f.task.authorized,true);
  assert.equal(f.room.grants.size,1);
 }finally{await f.cleanup();}
});

test('poll: a blocked worker that becomes active again clears its stop report', async () => {
 const f=await fixture({status:'idle',activity:{state:'idle'},error:'Spending reservation denied: task budget would be exceeded'});
 try{
  await f.room.poll();
  assert.equal(f.room.task('task-1').status,'awaiting input');
  f.room.task('task-1').authorized=true;f.room.grants.set('grant-1','task-1');
  f.room.adapter.session={status:'working',activity:{state:'active'}};
  await f.room.poll();
  const t=f.room.task('task-1');
  assert.equal(t.status,'running');
  assert.equal(t.stopReport,null);
 }finally{await f.cleanup();}
});
test('provider credit/access rejection remains blocked rather than ready for review',()=>{for(const text of ['Provider HTTP 400: Your credit balance is too low to access the Anthropic API.','Provider HTTP 401: Authentication denied','Provider HTTP 403: Access denied']){const events=[LAUNCH,{kind:'error',text}];const result=classifyStop({activity:{state:'idle'}},events);assert.equal(result.outcome,'blocked');assert.equal(result.kind,'provider');assert.match(result.retry,/do not enable payments/);assert.equal(deriveStatus({status:'idle',activity:{state:'idle'}},events),'awaiting input');}});
test('malformed provider HTTP400 is an error; credit denial revokes idle worker grant',async()=>{assert.equal(classifyStop({activity:{state:'idle'}},[LAUNCH,{kind:'error',text:'Provider HTTP 400: messages.1.output_config: Extra inputs are not permitted'}]).outcome,'error');const f=await fixture({status:'idle',activity:{state:'idle'}});try{f.task.events.push({kind:'error',text:'Provider HTTP 400: Your credit balance is too low to access the Anthropic API.'});await f.room.poll();assert.equal(f.task.stopReport.kind,'provider');assert.equal(f.task.status,'awaiting input');assert.equal(f.task.authorized,false);assert.equal(f.room.grants.has('grant-1'),false);}finally{await f.cleanup();}});
