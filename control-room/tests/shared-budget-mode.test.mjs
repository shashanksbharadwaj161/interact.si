import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Budget} from '../server/budget.mjs';
import {Room} from '../server/room.mjs';
const model='claude-opus-5-5';
async function fixture(run){const dir=await mkdtemp(path.join(os.tmpdir(),'shared-budget-'));try{await run(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}}
test('shared mode ignores worker cap while legacy and explicit task modes retain caps',()=>fixture(async dir=>{
 const b=new Budget(dir);await b.init();
 await assert.rejects(b.reserve({id:'legacy',budget:.01},model,1000,1000),/reservation denied/);
 await assert.rejects(b.reserve({id:'explicit',budget:.01,budgetMode:'task'},model,1000,1000),/reservation denied/);
 await b.reserve({id:'shared',budget:.01,budgetMode:'shared'},model,1000,1000);
 assert.ok(b.total()>.01);assert.equal(b.state.requests.length,1);
}));
test('thirty mixed workers serialize under the global ceiling and retain unknown holds after reload',()=>fixture(async dir=>{
 const b=new Budget(dir);await b.init();
 const held={id:'unknown',model,taskId:'old',charge:449,reserved:449,settled:false};
 await b.transaction(()=>{b.state.limit=500;b.state.safety=50;b.state.requests=[held];});
 const outcomes=await Promise.allSettled(Array.from({length:30},(_,i)=>b.reserve({id:`worker-${i}`,budget:i%2?10:.001,budgetMode:i%2?'task':'shared'},model,1000,1000)));
 assert.ok(outcomes.some(x=>x.status==='fulfilled'));assert.ok(outcomes.some(x=>x.status==='rejected'));assert.ok(b.total()<=450);assert.deepEqual(b.state.requests[0],held);
 const restored=new Budget(dir);await restored.init();assert.equal(restored.total(),b.total());assert.equal(restored.snapshot().uncertain,b.state.requests.length);assert.equal(restored.snapshot().safety,50);
}));
test('shared reservations fail closed for invalid modes, amounts, models, and token bounds',()=>fixture(async dir=>{
 const b=new Budget(dir);await b.init();
 for(const budgetMode of [null,'unlimited',false,{},0])await assert.rejects(b.reserve({id:'a',budget:500,budgetMode},model,1,1),/budget mode/);
 for(const budget of [null,NaN,Infinity,-1,0,501,'500'])await assert.rejects(b.reserve({id:'a',budget,budgetMode:'shared'},model,1,1),/task budget/);
 for(const bad of ['unknown','toString','__proto__'])await assert.rejects(b.reserve({id:'a',budget:500,budgetMode:'shared'},bad,1,1),/spending policy/);
 await assert.rejects(b.reserve({id:'a',budget:500,budgetMode:'shared'},model,250001,1),/context/);
 await assert.rejects(b.reserve({id:'a',budget:500,budgetMode:'shared'},model,1,16385),/output limit/);
 assert.equal(b.state.requests.length,0);
}));
test('Room creation exposes finite shared policy and rejects malformed budgets without queueing',()=>fixture(async dir=>{
 const room=new Room(dir,{}, {get:async()=>'',cached:''});room.kick=()=>{};await room.init();room.online=true;
 const base={name:'Worker',prompt:'Local feature',model:'opus',projectId:'p',mode:'real',launchMode:'tui-native'};
 const shared=await room.create({...base,budgetMode:'shared'});assert.equal(shared.budgetMode,'shared');assert.equal(shared.budget,500);assert.equal(shared.launchMode,'tui-native');assert.equal(shared.effort,'high');
 const legacy=await room.create(base);assert.equal(legacy.budgetMode,'task');assert.equal(legacy.budget,5);
 for(const budget of [null,'',false,[],{},Infinity,'NaN',0,501])await assert.rejects(room.create({...base,budgetMode:'shared',budget}),/budget/);
 await assert.rejects(room.create({...base,budgetMode:'unlimited'}),/budget mode/);
 await assert.rejects(room.create({...base,launchMode:'anything',budgetMode:'shared'}),/launch mode/);
 await assert.rejects(room.create({...base,model:'unknown',budgetMode:'shared'}),/verified development/);
 assert.equal(room.tasks.length,2);
}));
test('usage reporting and resume do not enforce a worker cap in shared mode',()=>fixture(async dir=>{
 let resumed=0;
 const room=new Room(dir,{resume:async()=>{resumed++;}}, {get:async()=>'',cached:''});room.kick=()=>{};await room.init();room.online=true;
 const task=await room.create({name:'Worker',prompt:'Task',model:'opus',projectId:'p',budgetMode:'shared',budget:.001});
 const t=room.task(task.id);room.recordUsage(t.id,model,{input_tokens:1000,output_tokens:1000});assert.ok(t.cost>t.budget);assert.equal(t.authorized,true);
 await room.persist;t.status='review';t.sessionId='s';t.grant='g';room.grants.set('g',t.id);await room.resume(t.id);assert.equal(resumed,1);assert.equal(t.status,'running');
 t.budgetMode='task';t.status='review';await assert.rejects(room.resume(t.id),/Task budget exhausted/);
}));
