import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes,createHash } from 'node:crypto';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Vault,protectDirectory } from './vault.mjs';
import { gate,redact } from './security.mjs';
import { Orchestrator } from './adapter.mjs';
import { Room } from './room.mjs';
import { Budget,PRICES } from './budget.mjs';
import {ownDirectory} from './ownership.mjs';
import {routeRequest,countRequest,auxiliaryRequest} from './gateway-policy.mjs';
import {providerErrorResponse} from './provider-errors.mjs';
import {AgentLoop,resolveLoopPath} from './loop.mjs';
import {createLoopVerifier} from './loop-verifier.mjs';
import {ApiWorkerAdapter} from './api-adapter.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function createServer(options={}) {
  const dir=options.dir||process.env.CONTROL_ROOM_DIR||path.join(root,'.controlroom');await mkdir(dir,{recursive:true});if(process.platform==='win32')await protectDirectory(dir);
  const releaseOwnership=await ownDirectory(dir);
  const vault=options.vault||new Vault(dir);const binary=process.env.AO_BINARY||path.join(process.env.LOCALAPPDATA||'', 'Programs','agent-orchestrator','resources','daemon','ao.exe');
  const adapter=options.adapter||new ApiWorkerAdapter({base:new Orchestrator(dir,binary),dir,repo:path.resolve(root,'../jarvis-desktop')});const room=new Room(dir,adapter,vault);await room.init();
  const budget=new Budget(dir);await budget.init();room.spending=budget;room.allowUnverifiedModels=!!options.fetchProvider;
  const app=express(),token=randomBytes(32).toString('hex');const port=options.port??Number(process.env.CONTROL_ROOM_PORT||4317);room.port=port;
  let agentLoop=null;
  const loopRepo=path.resolve(root,'../jarvis-desktop'),loopState=path.join(dir,'loop');
  const ensureLoop=async()=>{
    if(agentLoop)return agentLoop;
    const verify=await createLoopVerifier({repo:loopRepo,stateDir:loopState});
    agentLoop=new AgentLoop({room,adapter,repo:loopRepo,projectId:'jarvis-desktop',stateDir:loopState,verify,launchMode:'api-tools',
      workspaceForTask:async t=>{if(!/^api-[a-f0-9-]{36}$/.test(t?.sessionId??''))throw Error('Worker worktree is not available');return path.join(dir,'api-worktrees',t.sessionId);}});
    await agentLoop.init();return agentLoop;
  };
  // Worker gateway has capability auth; browser API uses a separate session/CSRF token.
  app.use((req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});next();});
  app.use('/anthropic/:grant',express.raw({type:()=>true,limit:'24mb'}),async(req,res)=>{
    const taskId=room.grants.get(req.params.grant);const task=taskId&&room.tasks.find(t=>t.id===taskId);
    if(req.headers.host!==`127.0.0.1:${room.port}`||req.headers.origin||!task||!task.authorized||!room.online)return res.status(403).json({error:{type:'authentication_error',message:'Worker provider access is disabled'}});
    const requestPath=req.path;
    if(!((req.method==='POST'&&requestPath==='/v1/messages')||(req.method==='GET'&&requestPath==='/v1/models')))return res.status(403).json({error:{message:'Unsupported provider operation'}});
    const controller=new AbortController();const controls=room.controllers.get(task.id)||new Set();controls.add(controller);room.controllers.set(task.id,controls);
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    let reservation=null,auxiliary=false,routedModel=null;
    try{
      const key=await vault.get();const headers={'x-api-key':key,'anthropic-version':req.headers['anthropic-version']||'2023-06-01','content-type':'application/json'};
      if(req.headers['anthropic-beta']){const allowed=['prompt-caching-2024-07-31','interleaved-thinking-2025-05-14','context-1m-2025-08-07'];const flags=req.headers['anthropic-beta'].split(',').map(s=>s.trim()).filter(s=>allowed.includes(s));if(flags.length)headers['anthropic-beta']=flags.join(',');}
      const providerFetch=options.fetchProvider||fetch;let payload=req.body;
      if(requestPath==='/v1/messages'&&PRICES[task.model]){
        let input;try{input=JSON.parse(req.body.toString());}catch{throw new Error('Invalid Messages JSON');}
        auxiliary=auxiliaryRequest(input,task);
        const body=routeRequest(input,task);routedModel=body.model;
        if(body.mcp_servers||body.container||body.context_management)throw new Error('Unverified remote/experimental services are excluded from this budget');
        if((body.tools||[]).some(t=>t.type&&t.type!=='custom'))throw new Error('Paid server-side tools are excluded from this budget');
        const countBody=countRequest(body);
        const counted=await providerFetch('https://api.anthropic.com/v1/messages/count_tokens',{method:'POST',headers,body:JSON.stringify(countBody),signal:controller.signal});if(!counted.ok){const failure=await counted.json().catch(()=>({}));throw new Error('Preflight HTTP '+counted.status+': '+redact(String(failure.error?.message||'token count failed').slice(0,400),[key,...room.grants.keys()]));}const count=await counted.json();reservation=await budget.reserve(task,body.model,count.input_tokens,body.max_tokens);payload=Buffer.from(JSON.stringify(body));
      }else if(requestPath==='/v1/messages'&&!options.fetchProvider)throw new Error('Real inference requires a verified model budget policy');
      const upstream=await providerFetch(`https://api.anthropic.com${requestPath}`,{method:req.method,headers,body:req.method==='POST'?payload:undefined,signal:controller.signal});
      if(!upstream.ok){
        const raw=await upstream.text();let failure={};try{failure=JSON.parse(raw);}catch{}
        const message=String(failure.error?.message??'').slice(0,600);
        room.log(task,auxiliary?'background-error':[429,500,502,503,504].includes(upstream.status)?'transport-warning':'error',`Provider HTTP ${upstream.status} (${routedModel??'catalog'}; ${auxiliary?'auxiliary':'main'}): ${redact(message,[key,...room.grants.keys()])}`);await room.save();
        if(reservation)await budget.settle(reservation,null,false);
        return res.status(upstream.status).type('application/json').send(raw);
      }
      res.status(upstream.status);res.set('Content-Type',upstream.headers.get('content-type')||'application/json');
      if(upstream.headers.get('content-type')?.includes('text/event-stream')){
        let pending='',usage={},model=null,complete=false;const decoder=new TextDecoder();
        for await(const chunk of Readable.fromWeb(upstream.body)){
          pending+=decoder.decode(chunk,{stream:true});let ix;
          while((ix=pending.indexOf('\n'))>=0){const line=pending.slice(0,ix).trim();pending=pending.slice(ix+1);if(line.startsWith('data: ')){try{const event=JSON.parse(line.slice(6));if(event.type==='message_start'){usage={...usage,...event.message?.usage};model=event.message?.model;}if(event.type==='message_delta')usage={...usage,...event.usage};if(event.type==='message_stop')complete=true;}catch{}}}
          if(pending.length>2*1024*1024)throw new Error('Provider event exceeded supported size');
          if(!res.write(chunk))await new Promise(r=>res.once('drain',r));
        }
        if(reservation)await budget.settle(reservation,usage,upstream.ok&&complete);if(upstream.ok&&Object.keys(usage).length)room.recordUsage(task.id,model,usage);res.end();
      }else{const body=await upstream.text();try{const json=JSON.parse(body);if(reservation)await budget.settle(reservation,json.usage,upstream.ok&&!!json.usage);if(upstream.ok&&json.usage)room.recordUsage(task.id,json.model,json.usage);}catch{}res.send(body);}
    }catch(e){const failure=providerErrorResponse(e);room.log(task,[429,500,502,503,504].includes(failure.status)?'transport-warning':'error',e.message);room.save().catch(()=>{});if(!res.headersSent){res.status(failure.status).json({error:{type:failure.type,message:redact(e.message,[vault.cached,...room.grants.keys()])}});}else res.end();}finally{controls.delete(controller);}
  });
  app.use((req,res,next)=>gate(room.port,token)(req,res,next));app.use(express.json({limit:'64kb'}));
  const route=(method,url,fn)=>app[method](url,async(req,res,next)=>{try{res.json(await fn(req,res));}catch(e){next(e);}});
  route('get','/api/bootstrap',async()=>({token,...room.snapshot(),provider:{configured:await vault.status(),online:room.online},root}));
  route('get','/api/status',async()=>room.snapshot());
  route('get','/api/loop',async()=>{
    if(agentLoop)return agentLoop.status();
    return {status:'paused',phase:'idle',workerMode:'api-tools',round:0,reason:'Direct API worker path selected. A real tool execution check is required before loop start.',budget:budget.snapshot(),history:[],ownTasks:[]};
  });
  route('post','/api/loop/start',async()=>{
    const proof=JSON.parse(await readFile(path.join(loopState,'worker-pilot.json'),'utf8').catch(()=>{throw Error('API worker tool execution is not verified. Loop remains paused.');}));
    const pilot=room.task(proof.taskId);
    if(proof.version!==1||proof.toolExecution!==true||proof.launchMode!=='api-tools'||pilot.launchMode!=='api-tools'||proof.model!==pilot.model||!/^api-[a-f0-9-]{36}$/.test(pilot.sessionId??'')||!budget.state.requests.some(r=>r.taskId===pilot.id&&r.settled&&r.model===proof.model))throw Error('API worker pilot evidence is incomplete');
    const marker=await readFile(await resolveLoopPath(path.join(dir,'api-worktrees',pilot.sessionId),'docs/native-execution-proof.txt'));
    if(marker.toString().trim()!=='NATIVE_WORKER_EXECUTED'||createHash('sha256').update(marker).digest('hex')!==proof.resultSha256)throw Error('API worker marker evidence does not match');
    return (await ensureLoop()).start({nativeReady:true});
  });
  route('post','/api/loop/stop',async()=>agentLoop?agentLoop.stop():{status:'paused',phase:'idle',round:0});
  app.get('/api/events',(req,res)=>{res.set({'Content-Type':'text/event-stream','Connection':'keep-alive'});res.flushHeaders();const send=()=>res.write(`data: ${JSON.stringify(room.snapshot())}\n\n`);send();room.on('change',send);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),10000);req.on('close',()=>{room.off('change',send);clearInterval(heartbeat);});});
  route('post','/api/provider',async req=>{if(room.active().length)throw new Error('Cancel active real workers before replacing credentials');await vault.save(req.body.key);return {configured:true};});
  route('delete','/api/provider',async()=>{await room.disableOnline();await vault.remove();return {configured:false};});
  route('post','/api/provider/test',async()=>{if(!room.online)throw new Error('Enable online development to test authentication');const key=await vault.get();const r=await fetch('https://api.anthropic.com/v1/models?limit=20',{headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`Anthropic authentication check returned HTTP ${r.status}`);const x=await r.json();return {ok:true,models:(x.data||[]).map(m=>({id:m.id,name:m.display_name}))};});
  route('post','/api/settings',async req=>{if(req.body.maxWorkers!==undefined){if(!Number.isInteger(req.body.maxWorkers)||req.body.maxWorkers<1||req.body.maxWorkers>30)throw new Error('Concurrency must be from one to thirty');room.maxWorkers=req.body.maxWorkers;}if(req.body.online===false)await room.disableOnline();if(req.body.online===true)room.online=true;await room.save();room.pump();return room.snapshot();});
  route('post','/api/orchestrator/start',async()=>{room.orchestrator=await adapter.start();await room.save();return room.orchestrator;});
  route('get','/api/projects',async()=>adapter.projects());
  route('post','/api/projects',async req=>{if(typeof req.body.path!=='string'||!path.isAbsolute(req.body.path))throw new Error('Enter an absolute repository path');return adapter.addProject(req.body.path);});
  route('post','/api/tasks',async req=>room.create(req.body));
  route('get','/api/tasks/:id',async req=>room.publicTask(room.task(req.params.id)));
  route('get','/api/tasks/:id/results',async req=>room.details(req.params.id));
  route('get','/api/tasks/:id/diff',async req=>{const t=room.task(req.params.id);if(!t.sessionId)throw new Error('No real worker workspace');if(typeof req.query.path!=='string')throw new Error('File path required');return JSON.parse(redact(await adapter.diff(t.sessionId,req.query.path),[vault.cached,...room.grants.keys()]));});
  route('post','/api/tasks/:id/cancel',async req=>room.cancel(req.params.id));
  route('post','/api/tasks/:id/followup',async req=>room.followup(req.params.id,req.body.message));
  route('post','/api/tasks/:id/resume',async req=>room.resume(req.params.id));
  route('post','/api/tasks/:id/review',async req=>room.review(req.params.id));
  route('post','/api/tasks/:id/approval',async req=>room.decide(req.params.id,req.body.requestId,req.body.decisionId));
  route('post','/api/shutdown',async()=>{await room.disableOnline();setTimeout(()=>close().catch(()=>{}),100);return {ok:true};});
  app.use(express.static(path.join(root,'dist'),{index:false}));app.get('/',(req,res)=>res.sendFile(path.join(root,'dist','index.html')));
  app.use((e,req,res,next)=>{if(res.headersSent)return next(e);res.status(400).json({error:redact(e.message,[vault.cached,...room.grants.keys()])});});
  const server=await new Promise((resolve,reject)=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));s.on('error',reject);});room.port=server.address().port;
  await writeFile(path.join(dir,'connection.json'),JSON.stringify({port:room.port,token,pid:process.pid}),{mode:0o600});
  const poll=setInterval(()=>room.poll().catch(()=>{}),4000);poll.unref();await room.poll();
  const close=async()=>{clearInterval(poll);if(agentLoop)await agentLoop.close();await room.close();server.closeAllConnections();await new Promise(r=>server.close(r));await releaseOwnership();};
  return {app,server,room,token,dir,close};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const service=await createServer();console.log(`Control Room ready: http://127.0.0.1:${service.room.port}`);
  let stopping=false;const shutdown=async()=>{if(stopping)return;stopping=true;await service.close();process.exit(0);};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
