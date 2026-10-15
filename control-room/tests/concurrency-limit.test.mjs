import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../server/index.mjs';

test('settings accept thirty workers, reject invalid capacities without mutation or starting cloud work',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'room-concurrency-'));
 let spawns=0,providerCalls=0;
 const adapter={state:async()=>({state:'stopped'}),spawn:async()=>{spawns++;},stop:async()=>{}};
 const vault={cached:null,status:async()=>false};
 const server=await createServer({dir,port:0,adapter,vault,fetchProvider:async()=>{providerCalls++;throw new Error('No provider calls allowed');}});
 const settings=async body=>{
  const response=await fetch(`http://127.0.0.1:${server.room.port}/api/settings`,{method:'POST',headers:{Authorization:`Bearer ${server.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 try{
  for(const maxWorkers of [1,20,30]){const result=await settings({maxWorkers});assert.equal(result.status,200);assert.equal(result.body.maxWorkers,maxWorkers);assert.equal(result.body.online,false);}
  for(const maxWorkers of [0,-1,31,1.5,'30',null]){
   const result=await settings({maxWorkers,online:true});assert.equal(result.status,400);assert.match(result.body.error,/one to thirty/);assert.equal(server.room.maxWorkers,30);assert.equal(server.room.online,false);
  }
  const persisted=JSON.parse(await readFile(path.join(dir,'tasks.json'),'utf8'));assert.equal(persisted.maxWorkers,30);assert.equal(spawns,0);assert.equal(providerCalls,0);
 }finally{await server.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
