import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { redact } from './security.mjs';
import {PRICES,MAX_APPROVED_BUDGET,taskBudgetPolicy} from './budget.mjs';
import {classifyStop,stopReport} from './status-errors.mjs';
import {validateLoopPath} from './loop.mjs';
const terminal=new Set(['complete','failed','cancelled']);
export const stages=['queued','running','awaiting input','review','complete','failed','cancelled'];
// An idle or exited worker is ready for review only when no stop evidence exists.
// Budget and context denials stay blocked; worker errors become failed.
export function deriveStatus(session,events=[]){
  if(session.provisionState==='failed'||session.status==='failed')return 'failed';
  const activity=session.activity?.state??session.agentActivity?.state;
  if(['blocked','waiting_input'].includes(activity)||session.status==='needs_input')return 'awaiting input';
  if(activity==='active')return 'running';
  if(['idle','exited'].includes(activity)||['idle','exited','terminated','pr_open','draft','ci_failed','review_pending','changes_requested','commented','approved','mergeable','merged'].includes(session.status)){
    const stop=classifyStop(session,events);
    if(stop.outcome==='blocked')return 'awaiting input';
    if(stop.outcome==='error')return 'failed';
    return 'review';
  }
  if(['working','spawning','running'].includes(session.status))return 'running';
  return null;
}
export class Room extends EventEmitter {
  constructor(dir,adapter,vault) {
    super(); this.dir=dir; this.file=path.join(dir,'tasks.json');this.adapter=adapter;this.vault=vault;
    this.tasks=[];this.grants=new Map();this.controllers=new Map();this.demoTimers=new Map();this.launching=false;this.maxWorkers=1;this.online=false;this.orchestrator={state:'stopped'};this.updatedAt=null;this.polling=false;this.persist=Promise.resolve();
  }
  async init(){await mkdir(this.dir,{recursive:true});try{const x=JSON.parse(await readFile(this.file,'utf8'));this.tasks=x.tasks||[];this.maxWorkers=x.maxWorkers||1;for(const t of this.tasks){t.authorized=false;delete t.grant;if(!terminal.has(t.status)){t.status='awaiting input';this.log(t,'service','Dashboard restarted. Resume explicitly; no automatic cloud calls.');}}}catch(e){if(e.code!=='ENOENT')throw new Error('Task history cannot be read; preserve tasks.json and repair it before starting');}}
  kick(){this.pump().catch(e=>{this.serviceError=redact(e.message,[this.vault.cached,...this.grants.keys()]);this.emit('change');});}
  log(task,kind,text){task.events.push({id:randomUUID(),at:new Date().toISOString(),kind,text:redact(text,[this.vault.cached,...this.grants.keys()])});task.events=task.events.slice(-250);task.updatedAt=new Date().toISOString();}
  async save(){const snapshot=redact(JSON.stringify({tasks:this.tasks,maxWorkers:this.maxWorkers}),[this.vault.cached,...this.grants.keys()]);this.persist=this.persist.catch(()=>{}).then(async()=>{await writeFile(this.file+'.tmp',snapshot,{mode:0o600});for(let i=0;;i++){try{await rename(this.file+'.tmp',this.file);break;}catch(e){if(i>=6||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,100*(i+1)));}}});await this.persist;this.emit('change');}
  publicTask(t){const {grant,...safe}=t;const receipts=this.spending?.state?.requests?.filter(r=>r.taskId===t.id&&r.settled);if(receipts?.length)safe.cost=receipts.reduce((sum,r)=>sum+r.charge,0);return safe;}
  snapshot(){return {tasks:this.tasks.map(t=>this.publicTask(t)),maxWorkers:this.maxWorkers,online:this.online,spending:this.spending?.snapshot()||null,orchestrator:this.orchestrator,updatedAt:this.updatedAt,serviceError:this.serviceError||null,at:new Date().toISOString()};}
  task(id){const t=this.tasks.find(x=>x.id===id);if(!t)throw new Error('Task not found');return t;}
  async create(input) {
    for(const k of ['name','prompt','model'])if(typeof input[k]!=='string'||!input[k].trim())throw new Error(`${k} is required`);
    if(input.name.length>100||input.prompt.length>16000||input.model.length>256)throw new Error('Task exceeds supported length');
    const mode=input.mode==='demo'?'demo':'real';
    const launchMode=input.launchMode??'chat';
    if(!['chat','tui-native','api-tools'].includes(launchMode))throw new Error('Worker launch mode must be chat, tui-native or api-tools');
    let fileOwnership;
    if(launchMode==='api-tools'){
      if(!Array.isArray(input.fileOwnership)||!input.fileOwnership.length||input.fileOwnership.length>18)throw new Error('API workers require exact file ownership');
      fileOwnership=input.fileOwnership.map(f=>{
        if(typeof f==='string'&&/^docs\/(?:native-execution-proof\.txt|loop\/(?:decision|result\.[a-z][a-z0-9-]{0,39})\.json)$/.test(f))return f;
        return validateLoopPath(f);
      });
      if(new Set(fileOwnership.map(f=>f.toLowerCase())).size!==fileOwnership.length)throw new Error('Duplicate file ownership');
    }
    if(mode==='real'){const aliases={fable:'claude-fable-5-1',opus:'claude-opus-5-5',sonnet:'claude-sonnet-5-5',haiku:'claude-haiku-5-5'};input={...input,model:aliases[input.model]||input.model};if(!Object.hasOwn(PRICES,input.model)&&!this.allowUnverifiedModels)throw new Error('Use Fable 5.1, Opus 5.5, Sonnet 5.5 or Haiku 5.5 under the verified development spending policy');}
    if(mode==='real' && !this.online)throw new Error('Enable online development in Providers before starting a real worker');
    if(mode==='real' && !input.projectId)throw new Error('Register and select a Git project');
    if(mode==='real')await this.vault.get();
    const rates={};for(const k of ['input','output','cacheRead','cacheWrite']){const v=input.rates?.[k];rates[k]=v===null||v===undefined||v===''?null:Number(v);if(rates[k]!==null&&(!Number.isFinite(rates[k])||rates[k]<0))throw new Error('Pricing must be nonnegative');}
    if(mode==='real'&&PRICES[input.model])Object.assign(rates,PRICES[input.model]);
    const budgetMode=input.budgetMode===undefined?'task':input.budgetMode;
    const rawBudget=input.budget===undefined?(budgetMode==='shared'?MAX_APPROVED_BUDGET:5):input.budget;
    if(!['number','string'].includes(typeof rawBudget)||(typeof rawBudget==='string'&&!rawBudget.trim()))throw new Error('Invalid task budget');
    const budget=Number(rawBudget);taskBudgetPolicy({budgetMode,budget});
    const t={id:randomUUID(),name:redact(input.name),prompt:redact(input.prompt),model:input.model,effort:['high','medium','low'].includes(input.effort)?input.effort:'high',projectId:input.projectId||'',mode,launchMode,status:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[],sessionId:null,actualModel:null,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,requests:0},rates,cost:null,budget,budgetMode,reviewed:false,authorized:true};
    if(fileOwnership)t.fileOwnership=fileOwnership;
    this.tasks.unshift(t);this.log(t,'service',mode==='demo'?'Simulation queued. No provider requests or actual code edits.':'Worker queued by explicit request.');await this.save();this.kick();return this.publicTask(t);
  }
  active(){return this.tasks.filter(t=>t.mode==='real'&&t.authorized&&!terminal.has(t.status)&&t.status!=='queued');}
  async pump(){
    if(this.launching)return;this.launching=true;
    try{for(const t of [...this.tasks].reverse()){
      if(t.status!=='queued'||!t.authorized)continue;
      if(t.mode==='demo'){this.runDemo(t);continue;}
      if(!this.online||this.active().length>=this.maxWorkers)continue;
      t.status='running';this.log(t,'service','Launching isolated Orchestrator worker.');await this.save();
      if(!t.authorized||!this.online)continue;
      const grant=randomBytes(32).toString('hex');this.grants.set(grant,t.id);t.grant=grant;
      try{await this.adapter.start();if(!t.authorized||!this.online){this.grants.delete(grant);continue;}t.sessionId=await this.adapter.spawn(t,`http://127.0.0.1:${this.port}/anthropic/${grant}`);if(!t.authorized||!this.online){await this.adapter.cancel(t.sessionId);t.status='cancelled';}this.log(t,'service',`Orchestrator session ${t.sessionId} launched.`);}
      catch(e){if(t.status!=='cancelled')t.status='failed';t.authorized=false;this.grants.delete(grant);this.log(t,'error',e.message);}
      await this.save();
    }}finally{this.launching=false;}
  }
  runDemo(t){
    t.status='running';this.log(t,'simulation','Demo worker started in simulated workspace.');this.emit('change');
    const events=[[1000,'simulation','Inspecting the requested task and repository layout.'],[2500,'simulation','Tool event: simulated file inspection.'],[4500,'simulation','Draft result ready. No real files changed.']];
    const timers=events.map(([delay,kind,msg],i)=>setTimeout(async()=>{if(t.status!=='running')return;this.log(t,kind,msg);if(i===events.length-1){t.status='review';t.result='Simulation finished. This demonstrates task tracking and review; no AI calls were made.';t.authorized=false;}await this.save();},delay));this.demoTimers.set(t.id,timers);
  }
  async cancel(id,{checkpoint=false}={}){const t=this.task(id);if(terminal.has(t.status))return this.publicTask(t);t.authorized=false;this.grants.delete(t.grant);for(const c of this.controllers.get(id)||[])c.abort();for(const timer of this.demoTimers.get(id)||[])clearTimeout(timer);if(t.sessionId){try{await this.adapter.cancel(t.sessionId);}catch(e){this.log(t,'error',`Cancel not confirmed: ${e.message}`);t.status='awaiting input';await this.save();throw new Error('Cloud access revoked, but worker termination could not be confirmed');}}t.status='cancelled';if(checkpoint){t.checkpointStoppedAt=new Date().toISOString();t.checkpointKind=checkpoint==='planner'?'planner':'worker';}this.log(t,'service',checkpoint?'Checkpoint worker stopped for independent verification. Provider access revoked.':'Cancelled. Provider access revoked.');await this.save();this.kick();return this.publicTask(t);}
  // Internal trusted-verifier handoff only; never exposed as an API action.
  async recordVerifiedCompletion(id,evidence){
    const t=this.task(id);
    if(!evidence||evidence.passed!==true||evidence.blocked||evidence.needs_review||!Number.isInteger(evidence.round)||evidence.round<1||typeof evidence.observationId!=='string'||!evidence.observationId||!Array.isArray(evidence.checks)||!evidence.checks.length||evidence.checks.some(c=>!c||c.exitCode!==0||typeof c.outputRef!=='string'||!c.outputRef.trim()))throw new Error('Independent passing verification evidence is required');
    if(t.authorized||!t.checkpointStoppedAt||t.checkpointKind==='planner'||!['cancelled','complete'].includes(t.status))throw new Error('Only a checkpoint-stopped, unauthorized worker can receive verified completion');
    if(t.status==='complete'){
      if(t.verification?.observationId!==evidence.observationId||t.verification?.round!==evidence.round)throw new Error('Completion already recorded for different verification');
      return this.publicTask(t);
    }
    t.verification=JSON.parse(redact(JSON.stringify({round:evidence.round,observationId:evidence.observationId,sourceFingerprint:evidence.sourceFingerprint??null,checks:evidence.checks.map(c=>({command:c.command??null,exitCode:c.exitCode,outputRef:c.outputRef})),at:new Date().toISOString(),softwareChecksPassed:true,featuresFullyAccepted:false}),[this.vault.cached,...this.grants.keys()]));
    t.status='complete';t.reviewed=true;
    this.log(t,'review','Worker slice independently verified and integrated. Full feature acceptance may still require hardware/account review.');
    await this.save();return this.publicTask(t);
  }
  async recordPlannerCompletion(id,evidence){
    const t=this.task(id);
    if(!evidence||!Number.isInteger(evidence.round)||evidence.round<1||typeof evidence.observationId!=='string'||!evidence.observationId||!['dispatch','verify','blocked','complete'].includes(evidence.action)||!Number.isInteger(evidence.taskCount)||evidence.taskCount<0||evidence.taskCount>3)throw new Error('Validated planner decision evidence is required');
    if(t.authorized||!t.checkpointStoppedAt||t.checkpointKind!=='planner'||!['cancelled','complete'].includes(t.status))throw new Error('Only a stopped, unauthorized planner checkpoint can complete');
    if(t.status==='complete'){
      if(t.plannerResult?.observationId!==evidence.observationId||t.plannerResult?.round!==evidence.round)throw new Error('Planner completion already recorded for different observation');
      return this.publicTask(t);
    }
    t.plannerResult={kind:'plan-validated',round:evidence.round,observationId:evidence.observationId,action:evidence.action,taskCount:evidence.taskCount,at:new Date().toISOString(),softwareVerified:false,featuresIntegrated:false};
    t.status='complete';
    this.log(t,'service','Planner decision validated. Planning task complete; no software verification or feature integration claimed.');
    await this.save();return this.publicTask(t);
  }
  async followup(id,message){const t=this.task(id);if(typeof message!=='string'||!message.trim()||message.length>4096)throw new Error('Follow-up must be 1–4096 characters');if(t.mode==='real'){if(!this.online||!t.sessionId||!t.authorized)throw new Error('Resume the worker with online mode enabled first');if(this.active().filter(x=>x.id!==id).length>=this.maxWorkers)throw new Error('Worker concurrency limit reached');await this.adapter.followup(t.sessionId,message);}else if(terminal.has(t.status)||t.status==='review'){throw new Error('Resume the demo before sending a follow-up');}this.log(t,'user',message);await this.save();return this.publicTask(t);}
  async resume(id){const t=this.task(id);if(t.mode==='demo'){for(const timer of this.demoTimers.get(id)||[])clearTimeout(timer);t.authorized=true;this.runDemo(t);await this.save();return this.publicTask(t);}if(!this.online)throw new Error('Enable online development first');if(t.authorized&&['running','queued'].includes(t.status))throw new Error('Worker is already active');if(this.active().filter(x=>x.id!==id).length>=this.maxWorkers)throw new Error('Worker concurrency limit reached');if(taskBudgetPolicy(t)==='task'&&t.cost!==null&&t.cost>=t.budget)throw new Error('Task budget exhausted; start a new explicitly budgeted task');if(['budget','context'].includes(t.stopReport?.kind))throw new Error(t.stopReport.retry);await this.vault.get();
    // Grants do not survive restarts. Old sessions are not silently reauthorized with a stale gateway.
    if(!t.sessionId||!this.grants.has(t.grant))throw new Error('This session’s gateway expired. Create a new task with the saved instructions; existing worktree remains in Orchestrator.');
    t.authorized=true;try{await this.adapter.resume(t.sessionId);t.status='running';this.log(t,'service','Worker resumed explicitly.');}catch(e){t.authorized=false;throw e;}await this.save();return this.publicTask(t);
  }
  async review(id){const t=this.task(id);if(t.status!=='review')throw new Error('Only review-ready tasks can be marked complete');if(t.sessionId)await this.adapter.cancel(t.sessionId);t.status='complete';t.reviewed=true;t.authorized=false;this.grants.delete(t.grant);this.log(t,'review','Marked reviewed; worker stopped. No merge or commit performed.');await this.save();this.kick();return this.publicTask(t);}
  async poll(){if(this.polling)return;this.polling=true;try{this.orchestrator=await this.adapter.state();if(this.orchestrator.state==='ready')for(const t of this.tasks.filter(x=>x.sessionId&&!terminal.has(x.status))){try{const s=await this.adapter.get(t.sessionId);if(terminal.has(t.status))continue;t.reportedState=s.status;t.activity=s.agentActivity??s.activity??null;t.workspace=s.worktreePath??s.workspacePath??null;delete t.connectionError;const next=deriveStatus(s,t.events);const report=next==='running'?null:stopReport(s,t.events);t.stopReport=report&&{...report,reason:redact(report.reason,[this.vault.cached,...this.grants.keys()])};
        if(next){if(next!==t.status){if(next==='review')this.log(t,'service','Worker idle/stopped with no stop reason. Inspect results before marking complete.');else if(report)this.log(t,report.kind==='budget'?'budget':'error',`Blocked: ${t.stopReport.reason}. ${report.retry}`);else if(next==='failed')this.log(t,'error','Worker stopped with an error. Resume explicitly or create a new task.');}t.status=next;if(next==='failed'||['budget','context','provider'].includes(report?.kind)){t.authorized=false;this.grants.delete(t.grant);}}
      }catch(e){t.connectionError=redact(e.message);}}
      this.updatedAt=new Date().toISOString();await this.save();this.kick();
    }finally{this.polling=false;}}
  async details(id){const t=this.task(id);if(t.mode==='demo')return {messages:t.events.map(e=>({role:e.kind==='user'?'user':'assistant',text:e.text})),activities:[],files:[],result:t.result||'',limitations:['Simulation: no real files or provider usage.']};if(!t.sessionId)return {messages:[],files:[],activities:[],limitations:['Worker has not launched.']};const d=await this.adapter.details(t.sessionId);const c=d.conversation?.conversation??d.conversation?.snapshot??d.conversation;const messages=(c?.messages||[]).map(m=>({role:m.role,text:redact(m.text||'', [this.vault.cached,...this.grants.keys()]),at:m.createdAt}));return {messages,activities:JSON.parse(redact((c?.activities||[]).filter(a=>a.activityKind!=='reasoning'),[this.vault.cached,...this.grants.keys()])),files:JSON.parse(redact(d.files?.files??[],[this.vault.cached,...this.grants.keys()])),limitations:d.limitations};}
  async decide(id,requestId,decisionId){const t=this.task(id);if(!this.online||!t.authorized||!t.sessionId)throw new Error('Worker is not authorized');const d=await this.details(id);const request=d.activities.find(a=>a.activityKind==='approval'&&a.requestId===requestId&&a.status==='pending');if(!request||!request.detail?.decisions?.some(x=>x.id===decisionId))throw new Error('Approval is stale or the decision is unsupported');await this.adapter.api(`sessions/${encodeURIComponent(t.sessionId)}/conversation/approvals/${encodeURIComponent(requestId)}/resolve`,{method:'POST',body:JSON.stringify({decisionId})});this.log(t,'user',`Explicit approval decision: ${decisionId}`);await this.save();return {ok:true};}
  recordUsage(taskId,model,usage){const t=this.task(taskId);t.actualModel=model||t.actualModel;t.usage.input+=Number(usage.input_tokens||0);t.usage.output+=Number(usage.output_tokens||0);t.usage.cacheRead+=Number(usage.cache_read_input_tokens||0);t.usage.cacheWrite+=Number(usage.cache_creation_input_tokens||0);t.usage.requests++;
    const actual=model||t.model,rates=PRICES[actual]||t.rates;
    const delta={input:Number(usage.input_tokens||0),output:Number(usage.output_tokens||0),cacheRead:Number(usage.cache_read_input_tokens||0),cacheWrite:Number(usage.cache_creation_input_tokens||0)};
    t.usageByModel??={};const bucket=t.usageByModel[actual]??={input:0,output:0,cacheRead:0,cacheWrite:0,requests:0};
    for(const key of Object.keys(delta))bucket[key]+=delta[key];bucket.requests++;
    const priced=Object.keys(delta).every(key=>!delta[key]||rates[key]!==null&&rates[key]!==undefined);
    const requestCost=priced?Object.keys(delta).reduce((sum,key)=>sum+delta[key]*(rates[key]||0)/1e6,0):null;
    // The gateway settles its persisted reservation before reporting usage.
    // Rebuild from that ledger when available, including pre-upgrade history.
    const settled=this.spending?.state?.requests?.filter(q=>q.taskId===taskId&&q.settled)||[];
    if(settled.length)t.cost=settled.reduce((sum,q)=>sum+q.charge,0);
    else t.cost=requestCost===null?null:(t.cost??0)+requestCost;
    this.log(t,'usage',`${model||t.model}: ${usage.input_tokens||0} input / ${usage.output_tokens||0} output tokens reported.`);
    if(taskBudgetPolicy(t)==='task'&&t.cost!==null&&t.cost>=t.budget){t.authorized=false;this.log(t,'budget','Estimated task budget reached. Further requests blocked; the last request can overshoot.');}
    this.save().catch(e=>{this.serviceError=redact(e.message);this.emit('change');});
  }
  async disableOnline(){this.online=false;for(const t of this.tasks.filter(x=>x.mode==='real'&&x.authorized)){await this.cancel(t.id).catch(()=>{});}await this.save();}
  async close(){for(const timers of this.demoTimers.values())for(const timer of timers)clearTimeout(timer);for(const list of this.controllers.values())for(const c of list)c.abort();await this.adapter.stop();await this.persist;}
}



