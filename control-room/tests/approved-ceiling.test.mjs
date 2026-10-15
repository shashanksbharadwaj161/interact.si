import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm,writeFile}from'node:fs/promises';import os from'node:os';import path from'node:path';import{Budget,MAX_APPROVED_BUDGET}from'../server/budget.mjs';
for(const [limit,safety] of [[350,35],[500,50],[550,55],[600,60]])test(`approved ${limit} ceiling persists while prior uncertain holds remain protected and overspend fails closed`,async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'room-approved-ceiling-'));
 try{
  const held=limit-safety-.2;
  const b=new Budget(dir);await b.init();await b.transaction(()=>{b.state.limit=limit;b.state.safety=safety;b.state.requests=[{id:'historical-hold',model:'claude-opus-5-5',taskId:'old',charge:held,reserved:held,settled:false}]});
  const restored=new Budget(dir);await restored.init();assert.equal(restored.snapshot().limit,limit);assert.equal(restored.snapshot().safety,safety);assert.equal(restored.snapshot().uncertain,1);assert.equal(restored.total(),held);
  await assert.rejects(restored.reserve({id:'new',budget:30},'claude-opus-5-5',25000,16384),/reservation denied/);assert.equal(restored.state.requests.length,1);
  await writeFile(path.join(dir,'spending.json'),JSON.stringify({...restored.state,limit:MAX_APPROVED_BUDGET+1}));await assert.rejects(new Budget(dir).init(),/provider calls blocked/);
 }finally{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test('new authorization does not automatically raise the default ledger or existing buffer',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'room-approved-default-'));
 try{const b=new Budget(dir);await b.init();assert.equal(b.snapshot().limit,300);assert.equal(b.snapshot().safety,30);}finally{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test('thirty simultaneous reservations serialize against one shared ceiling and preserve uncertain holds',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'room-approved-parallel-'));
 try{
  const b=new Budget(dir);await b.init();await b.transaction(()=>{b.state.limit=500;b.state.safety=50;b.state.requests=[{id:'historical-hold',model:'claude-opus-5-5',taskId:'old',charge:449,reserved:449,settled:false}]});
  const outcomes=await Promise.allSettled(Array.from({length:30},(_,i)=>b.reserve({id:`worker-${i}`,budget:10},'claude-opus-5-5',1000,1000)));
  assert.ok(outcomes.some(r=>r.status==='fulfilled'));assert.ok(outcomes.some(r=>r.status==='rejected'));assert.ok(b.total()<=450);
  assert.deepEqual(b.state.requests[0],{id:'historical-hold',model:'claude-opus-5-5',taskId:'old',charge:449,reserved:449,settled:false});
  const restored=new Budget(dir);await restored.init();assert.equal(restored.total(),b.total());assert.equal(restored.snapshot().uncertain,b.state.requests.length);
 }finally{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
