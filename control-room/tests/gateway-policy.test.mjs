import test from 'node:test';
import assert from 'node:assert/strict';
import {routeRequest,countRequest} from '../server/gateway-policy.mjs';
import {Room} from '../server/room.mjs';
import {PRICES} from '../server/budget.mjs';

const task={model:'claude-opus-5-5',effort:'high'};
test('count preflight omits unsupported per-message effort and retains token-bearing content',()=>{
 const input={model:task.model,messages:[{role:'user',content:'Build it',output_config:{effort:'high'}},{role:'assistant',content:[{type:'tool_use',id:'a',name:'read',input:{path:'x'}}],output_config:{effort:'high'}}],system:'Instructions',thinking:{type:'adaptive'},output_config:{effort:'high'},max_tokens:1024};
 const body=countRequest(input);assert.equal(body.output_config,undefined);assert.equal(body.max_tokens,undefined);assert.equal(body.messages[0].output_config,undefined);assert.deepEqual(body.messages[1].content,input.messages[1].content);assert.equal(body.system,input.system);assert.equal(input.messages[0].output_config.effort,'high');
});
test('main requests retain assigned model/high effort without incompatible sampling',()=>{
 const input={model:'claude-sonnet-4-5',max_tokens:32000,temperature:0,top_p:1,top_k:4,speed:'fast',inference_geo:'us',service_tier:'priority',thinking:{type:'enabled',budget_tokens:1000},messages:[{role:'user',content:'Build it'}]};
 const body=routeRequest(input,task);assert.equal(body.model,task.model);assert.equal(body.output_config.effort,'high');assert.deepEqual(body.thinking,{type:'adaptive'});assert.equal(body.max_tokens,16384);
 for(const field of ['temperature','top_p','top_k','speed','inference_geo','service_tier'])assert.equal(field in body,false);
 assert.equal(input.temperature,0);assert.equal(input.model,'claude-sonnet-4-5');
});
test('forced-tool auxiliary requests use Haiku without weakening tool selection',()=>{
 for(const type of ['any','tool']){const choice={type,name:'summary'};const body=routeRequest({model:task.model,max_tokens:512,tool_choice:choice,tools:[{name:'summary',input_schema:{type:'object'}}],messages:[{role:'user',content:'Summarize',output_config:{effort:'max'}}]},task);assert.equal(body.model,'claude-haiku-5-5');assert.deepEqual(body.tool_choice,choice);assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.messages[0].output_config,undefined);assert.equal(body.output_config.effort,'high');assert.equal(body.max_tokens,512);}
});
test('legacy background Haiku is pinned but main Fable remains Fable',()=>{
 assert.equal(routeRequest({model:'claude-haiku-4-5-20251001',max_tokens:1024},task).model,'claude-haiku-5-5');
 const fable=routeRequest({model:'claude-fable-5-1',max_tokens:8192},{...task,model:'claude-fable-5-1'});assert.equal(fable.model,'claude-fable-5-1');assert.deepEqual(fable.thinking,{type:'adaptive'});assert.equal(PRICES[fable.model].cacheRead,.25);
});
test('unpriced models, remote services, billed tools and invalid limits fail closed',()=>{
 assert.throws(()=>routeRequest({}, {...task,model:'unknown'}),/verified/);
 for(const value of [0,-1,NaN,1.5])assert.throws(()=>routeRequest({max_tokens:value},task),/max_tokens/);
 for(const field of ['mcp_servers','container'])assert.throws(()=>routeRequest({[field]:{}},task),/excluded/);
 assert.throws(()=>routeRequest({tools:[{type:'web_search_20250305',name:'web_search'}]},task),/server-side/);
});
test('ordinary CLI context editing and empty remote descriptors are removed',()=>{
 const body=routeRequest({mcp_servers:[],container:null,context_management:{edits:[{type:'clear_thinking_20251015',keep:'all'}]},max_tokens:1024},task);
 for(const field of ['mcp_servers','container','context_management'])assert.equal(field in body,false);
 assert.equal(body.model,task.model);
 assert.throws(()=>routeRequest({mcp_servers:[{type:'url',url:'https://example.com'}]},task),/MCP/);
 assert.throws(()=>routeRequest({container:'container_123'},task),/containers/);
});
test('authorized review sessions retain a concurrency slot until reviewed or cancelled',()=>{
 const room=new Room('',{},{});room.tasks=[{id:'review',mode:'real',authorized:true,status:'review',sessionId:'one'},{id:'running',mode:'real',authorized:true,status:'running'},{id:'queued',mode:'real',authorized:true,status:'queued'},{id:'cancelled',mode:'real',authorized:false,status:'cancelled'}];
 assert.deepEqual(room.active().map(t=>t.id),['review','running']);
});
test('mixed main and auxiliary usage is priced per reported model, including history ledger',()=>{
 const room=new Room('',{},{});room.save=async()=>{};
 const item={id:'mixed',model:'claude-fable-5-1',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,requests:0},rates:PRICES['claude-fable-5-1'],cost:null,events:[],budget:100,authorized:true};room.tasks=[item];
 room.recordUsage('mixed','claude-fable-5-1',{input_tokens:1000,output_tokens:100});
 room.recordUsage('mixed','claude-haiku-5-5',{input_tokens:1000,output_tokens:100});
 assert.ok(Math.abs(item.cost-.01575)<1e-12);assert.equal(item.usageByModel['claude-haiku-5-5'].requests,1);assert.equal(item.usage.requests,2);
 room.spending={state:{requests:[{taskId:'mixed',settled:true,charge:.01},{taskId:'mixed',settled:true,charge:.001},{taskId:'mixed',settled:false,charge:1},{taskId:'other',settled:true,charge:5}]}};
 room.recordUsage('mixed','claude-haiku-5-5',{input_tokens:10,output_tokens:1});assert.equal(item.cost,.011);
});

test('native inference removes rejected message metadata while preserving content and caller input',()=>{const input={model:task.model,messages:[{role:'user',content:[{type:'text',text:'Original task',cache_control:{type:'ephemeral'}}],output_config:{effort:'max'}},{role:'assistant',content:[{type:'tool_use',id:'tool-1',name:'read',input:{path:'src/main.ts'}}],output_config:{effort:'low'}}],max_tokens:1024};const body=routeRequest(input,task);assert.equal(body.messages.every(m=>m.output_config===undefined),true);assert.deepEqual(body.messages.map(m=>m.content),input.messages.map(m=>m.content));assert.equal(body.output_config.effort,'high');assert.equal(input.messages[0].output_config.effort,'max');assert.deepEqual(countRequest(body).messages,body.messages);});
