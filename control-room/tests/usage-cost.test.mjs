import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {usageCost,PRICING_VERSION} from '../server/usage-cost.mjs';
import {Budget,PRICES} from '../server/budget.mjs';
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-12, `${a} != ${b}`);

test('Haiku threshold includes input plus both cache categories at 100000/100001',()=>{
 const usage={input_tokens:20000,output_tokens:1000,cache_read_input_tokens:60000,cache_creation_input_tokens:20000,cache_creation:{ephemeral_5m_input_tokens:10000,ephemeral_1h_input_tokens:10000}};
 close(usageCost('claude-haiku-5-5',usage),(.1*20000+.5*1000+.01*60000+.125*10000+.2*10000)/1e6);
 close(usageCost('claude-haiku-5-5',{...usage,cache_read_input_tokens:60001}),(.5*20000+2.5*1000+.05*60001+.625*10000+1*10000)/1e6);
});
test('mixed TTL writes use each model rate',()=>{
 const usage={input_tokens:1000,output_tokens:1000,cache_read_input_tokens:1000,cache_creation_input_tokens:3000,cache_creation:{ephemeral_5m_input_tokens:1000,ephemeral_1h_input_tokens:2000}};
 for(const [model,input,output,read,five,hour] of [['claude-fable-5-1',10,50,.25,12.5,20],['claude-opus-5-5',4,20,.2,5,8],['claude-sonnet-5-5',2,10,.1,2.5,4]])close(usageCost(model,usage),(1000*(input+output+read+five)+2000*hour)/1e6);
});
test('absent or malformed TTL split retains original conservative aggregate write rate',()=>{
 const base={input_tokens:0,output_tokens:0,cache_creation_input_tokens:1000};
 for(const split of [undefined,{ephemeral_5m_input_tokens:999,ephemeral_1h_input_tokens:0},{ephemeral_5m_input_tokens:-1,ephemeral_1h_input_tokens:1001},{ephemeral_5m_input_tokens:1000}]){
  close(usageCost('claude-haiku-5-5',{...base,cache_creation:split}),.001);
  close(usageCost('claude-opus-5-5',{...base,cache_creation:split}),.008);
 }
});
test('invalid core receipts and unsupported modifiers fail closed',()=>{
 for(const usage of [null,{}, {input_tokens:-1,output_tokens:0},{input_tokens:0,output_tokens:NaN},{input_tokens:0,output_tokens:0,cache_creation_input_tokens:null},{input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:0,cache_read_input_tokens:1}])assert.equal(usageCost('claude-opus-5-5',usage),null);
 const usage={input_tokens:100,output_tokens:100};
 assert.equal(usageCost('unknown',usage),null);
 assert.equal(usageCost('claude-opus-5-5',usage,{serviceTier:'fast',inferenceGeo:'global'}),null);
 assert.equal(usageCost('claude-opus-5-5',{...usage,inference_geo:'us'}),null);
 assert.equal(usageCost('claude-opus-5-5',{...usage,service_tier:'priority'}),null);
});
test('migration is atomic, audited, preserves uncertain/invalid charges and is restart-idempotent',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'receipt-migration-'));
 try{
  const file=path.join(dir,'spending.json');
  const settled={id:'settled',taskId:'a',model:'claude-haiku-5-5',charge:.1,reserved:2,settled:true,usage:{input_tokens:100000,output_tokens:0}};
  const pending={id:'pending',taskId:'a',model:'claude-opus-5-5',charge:2,reserved:2,settled:false};
  const invalid={id:'invalid',taskId:'a',model:'claude-opus-5-5',charge:3,reserved:3,settled:true,usage:{}};
  await writeFile(file,JSON.stringify({limit:300,safety:30,requests:[settled,pending,invalid]}));
  const b=new Budget(dir);await b.init();
  close(b.state.requests[0].charge,.01);assert.equal(b.state.requests[0].pricingOriginalCharge,.1);assert.equal(b.state.requests[0].pricingVersion,PRICING_VERSION);
  assert.deepEqual(b.state.requests[1],pending);assert.deepEqual(b.state.requests[2],invalid);
  assert.equal(b.state.limit,300);assert.equal(b.state.safety,30);assert.equal(b.state.pricingAudits.length,1);assert.equal(b.state.pricingAudits[0].count,1);assert.equal(b.state.pricingAudits[0].uncertainCount,1);
  close(b.state.pricingAudits[0].totalBefore,5.1);close(b.state.pricingAudits[0].totalAfter,5.01);
  const first=await readFile(file,'utf8');const restart=new Budget(dir);await restart.init();assert.equal(await readFile(file,'utf8'),first);assert.deepEqual(restart.state,b.state);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('settlement keeps full reserve for invalid usage and records scope for valid receipts',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'receipt-settlement-'));
 try{
  const b=new Budget(dir);await b.init();const id=await b.reserve({id:'a',budget:10},'claude-haiku-5-5',100000,1000);const initial=b.total();
  assert.equal(PRICES['claude-haiku-5-5'].cacheWrite,1);
  await b.settle(id,{},true);assert.equal(b.total(),initial);assert.equal(b.state.requests[0].settled,false);
  await b.settle(id,{input_tokens:100000,output_tokens:0},false);assert.equal(b.total(),initial);
  await b.settle(id,{input_tokens:100000,output_tokens:0},true);close(b.total(),.01);assert.equal(b.state.requests[0].pricingVersion,PRICING_VERSION);assert.deepEqual(b.state.requests[0].pricingScope,{serviceTier:'standard',inferenceGeo:'global'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
