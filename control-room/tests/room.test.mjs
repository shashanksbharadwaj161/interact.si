import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../server/index.mjs';
import { Vault } from '../server/vault.mjs';
import { equal,redact } from '../server/security.mjs';
import { Room,deriveStatus } from '../server/room.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
class FakeAdapter {
  constructor(){this.started=false;this.cancelled=[];this.spawns=[];}
  async state(){return {state:this.started?'ready':'stopped'};}
  async start(){this.started=true;return this.state();}
  async projects(){return [{id:'test',name:'Test project'}];}
  async addProject(){return this.projects();}
  async spawn(task,url){this.spawns.push({task:task.id,url});return 'worker-'+task.id;}
  async get(){return {status:'working',activity:{state:'active'}};}
  async cancel(id){this.cancelled.push(id);}
  async followup(){}
  async resume(){}
  async details(){return {conversation:{messages:[{role:'assistant',text:'Completed a test change.'}],activities:[]},files:{files:[{path:'example.ts',status:'modified'}]},limitations:[]};}
  async diff(){return {diff:'-before\n+after'};}
  async stop(){}
}
class FakeVault {constructor(){this.cached='sk-ant-test-'+ 'x'.repeat(24);}async status(){return true;}async get(){return this.cached;}async save(k){this.cached=k;}async remove(){this.cached=null;}}
test('secret redaction and constant-time comparison handle hostile input',()=>{assert.equal(equal('é','a'),false);assert.equal(equal('x','x'),true);assert.equal(redact('token sk-ant-abcdefgh123456 bearer abc123'), 'token [REDACTED] bearer [REDACTED]');});
test('reported agent activity takes priority over stale session status',()=>{assert.equal(deriveStatus({status:'working',activity:{state:'idle'}}),'review');assert.equal(deriveStatus({status:'working',activity:{state:'blocked'}}),'awaiting input');assert.equal(deriveStatus({status:'idle',activity:{state:'active'}}),'running');assert.equal(deriveStatus({status:'no_signal'}),null);});
test('local API: access protection, demo lifecycle, real concurrency, gateway accounting, cancellation, persistence and MCP',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'control-room-test-'));const adapter=new FakeAdapter(),vault=new FakeVault();let requests=0;
 const s=await createServer({dir,port:0,adapter,vault,fetchProvider:async(url,opts)=>{requests++;assert.equal(opts.headers['x-api-key'],vault.cached);assert.equal(url,'https://api.anthropic.com/v1/messages');return new Response(JSON.stringify({model:'test-model',usage:{input_tokens:100,output_tokens:20},content:[]}),{headers:{'content-type':'application/json'}});}});
 const base=`http://127.0.0.1:${s.room.port}`;
 const call=async(route,body,extra={})=>{const r=await fetch(base+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${s.token}`,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
   assert.equal((await fetch(base+'/api/status')).status,401);
   assert.equal((await call('status',undefined,{Origin:'https://evil.example'})).status,403);
   assert.equal((await call('status',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
   const badHost=await new Promise((resolve,reject)=>{http.get(base+'/api/status',{headers:{Host:'attacker.example',Authorization:`Bearer ${s.token}`}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(badHost,403);
   const home=await fetch(base+'/');const cookie=home.headers.get('set-cookie').split(';')[0];assert.match(home.headers.get('set-cookie'),/HttpOnly/);assert.match(home.headers.get('set-cookie'),/SameSite=Strict/);
   assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({online:true})})).status,403);
   const create={name:'Test task',prompt:'Read the code',model:'test-model',mode:'demo'};
   const demo=await call('tasks',create);assert.equal(demo.status,200);assert.equal(requests,0);await wait(4900);assert.equal(s.room.task(demo.body.id).status,'review');
   assert.equal((await call(`tasks/${demo.body.id}/review`,{})).body.status,'complete');
   assert.equal((await call('tasks',{...create,mode:'real',projectId:'test'})).status,400);
   await call('settings',{online:true});
   const real=await call('tasks',{...create,mode:'real',projectId:'test',rates:{input:1,output:2},budget:1});
   const queued=await call('tasks',{...create,mode:'real',projectId:'test'});await wait(250);assert.equal(s.room.task(queued.body.id).status,'queued');
   const task=s.room.task(real.body.id);assert.equal(task.status,'running');const grant=task.grant;
   assert.equal((await fetch(base+`/anthropic/${grant}/v1/messages`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'})).status,403);
   const proxy=await fetch(base+`/anthropic/${grant}/v1/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(proxy.status,200);assert.equal(requests,1);assert.equal(task.usage.input,100);assert.equal(task.usage.output,20);assert.ok(Math.abs(task.cost-0.00014)<1e-10);
   const persisted=await readFile(path.join(dir,'tasks.json'),'utf8');assert.ok(!persisted.includes(vault.cached));assert.ok(!persisted.includes(grant));
   const restarted=new Room(dir,adapter,vault);await restarted.init();assert.equal(restarted.online,false);assert.equal(restarted.active().length,0);assert.equal(restarted.grants.size,0);
   assert.equal((await call(`tasks/${task.id}/results`)).body.files[0].path,'example.ts');
   await call(`tasks/${task.id}/followup`,{message:'Check the change'});await call(`tasks/${task.id}/cancel`,{});assert.equal(adapter.cancelled.length,1);
   assert.equal((await fetch(base+`/anthropic/${grant}/v1/messages`,{method:'POST',body:'{}'})).status,403);assert.equal(requests,1);
   await call('settings',{online:false});assert.equal(s.room.online,false);
   const mcp=new Client({name:'control-room-test',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('server/mcp.mjs')],env:{...process.env,CONTROL_ROOM_DIR:dir}});await mcp.connect(transport);assert.deepEqual((await mcp.listTools()).tools.map(t=>t.name).sort(),['cancel','followup','results','spawn','status']);const response=await mcp.callTool({name:'status',arguments:{}});assert.equal(response.isError,undefined);await mcp.close();
 }finally{await s.close();await rm(dir,{recursive:true,force:true});}
});
test('Windows DPAPI round trip stores no plaintext and deletes key', {skip:process.platform!=='win32'},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'control-room-vault-'));const key='sk-ant-test-'+ 'z'.repeat(30);try{const vault=new Vault(dir);await vault.save(key);const cipher=await readFile(vault.file,'utf8');assert.ok(!cipher.includes(key));assert.equal(await new Vault(dir).get(),key);await vault.save(key+'a');assert.equal(await new Vault(dir).get(),key+'a');await vault.remove();assert.equal(await vault.status(),false);}finally{await rm(dir,{recursive:true,force:true});}
});


