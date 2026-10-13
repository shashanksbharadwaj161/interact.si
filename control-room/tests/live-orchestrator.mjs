// Real AO + Claude harness, isolated fixture, synthetic model server: no paid API calls.
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../server/index.mjs';
const exec=promisify(execFile),dir=await mkdtemp(path.join(os.tmpdir(),'control-room-live-'));
const repo=path.join(dir,'fixture');await mkdir(repo);await writeFile(path.join(repo,'README.md'),'Synthetic control room harness verification.\n');
await exec('git',['init',repo],{windowsHide:true});await exec('git',['-C',repo,'add','README.md'],{windowsHide:true});await exec('git',['-C',repo,'-c','user.name=Control Room Test','-c','user.email=test@localhost','commit','-m','Test fixture'],{windowsHide:true});
const model='claude-sonnet-4-5-20250929';let inference=0;
const s=await createServer({dir:path.join(dir,'state'),port:0,vault:{cached:null,status:async()=>true,get:async()=> 'sk-ant-synthetic-test-only'},fetchProvider:async(url,opts)=>{
 if(url.endsWith('/v1/models'))return new Response(JSON.stringify({data:[{id:model,type:'model',display_name:'Synthetic Sonnet',created_at:'2025-09-29T00:00:00Z'}],has_more:false}),{headers:{'content-type':'application/json'}});
 inference++;const request=JSON.parse(opts.body);console.log('Synthetic inference request',inference,request.model);
 const message={id:'msg_synthetic_'+inference,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}};
 const events=[{type:'message_start',message},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Synthetic harness test complete. No real model request was made.'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:12}},{type:'message_stop'}];
 if(request.stream)return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 return new Response(JSON.stringify({...message,content:[{type:'text',text:'Synthetic harness test complete.'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:12}}),{headers:{'content-type':'application/json'}});
}});
try{
 console.log('Starting isolated AO daemon');console.log((await s.room.adapter.start()).state);
 const projects=await s.room.adapter.addProject(repo);const project=projects.find(p=>(p.path??p.repoPath)?.toLowerCase()===repo.toLowerCase())||projects[0];console.log('Registered isolated fixture:',project?.id);
 s.room.online=true;const task=await s.room.create({name:'Synthetic harness verification',prompt:'Reply with a short completion message. Do not use tools or change files.',model,mode:'real',projectId:project.id});
 for(let i=0;i<35;i++){await new Promise(r=>setTimeout(r,1500));const t=s.room.task(task.id);if(i%5===0)console.log('Worker:',t.status,t.sessionId||'launching');if(t.status==='failed')throw new Error(t.events.at(-1).text);if(inference>0&&t.sessionId){const d=await s.room.details(t.id);if(d.messages.some(m=>m.role==='assistant'&&m.text.includes('Synthetic'))){console.log('PASS: real isolated worker, synthetic inference, conversation and usage',JSON.stringify(t.usage));await s.room.cancel(t.id);break;}}if(i===34)throw new Error('Harness test timed out: '+JSON.stringify(s.room.publicTask(t)));}
}finally{await s.room.disableOnline();await s.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
