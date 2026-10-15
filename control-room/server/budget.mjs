import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {usageCost,PRICING_VERSION} from './usage-cost.mjs';
// Explicit user-approved ceiling for this development session. Persisted lower limits remain lower.
export const MAX_APPROVED_BUDGET=600;
export function taskBudgetPolicy(task){
 const budgetMode=task.budgetMode===undefined?'task':task.budgetMode;
 if(!['task','shared'].includes(budgetMode))throw new Error('Invalid task budget mode');
 if(!Number.isFinite(task.budget)||task.budget<=0||task.budget>MAX_APPROVED_BUDGET)throw new Error('Invalid task budget');
 return budgetMode;
}
export const PRICES={
 'claude-fable-5-1':{input:10,output:50,cacheRead:.25,cacheWrite:20},
 'claude-opus-5-5':{input:4,output:20,cacheRead:.2,cacheWrite:8},
 'claude-sonnet-5-5':{input:2,output:10,cacheRead:.1,cacheWrite:4},
 'claude-haiku-5-5':{input:.5,output:2.5,cacheRead:.05,cacheWrite:1}
};
// Cache writes conservatively priced at one-hour rate; Haiku at long-context rate.
export class Budget {
 constructor(dir){this.file=path.join(dir,'spending.json');this.state={limit:300,safety:30,requests:[]};this.serial=Promise.resolve();}
 async init(){try{const s=JSON.parse(await readFile(this.file,'utf8'));if(!Number.isFinite(s.limit)||s.limit<=0||s.limit>MAX_APPROVED_BUDGET||!Number.isFinite(s.safety)||s.safety<0||s.safety>=s.limit||!Array.isArray(s.requests)||s.requests.some(r=>!Number.isFinite(r.charge)||r.charge<0||!Number.isFinite(r.reserved)||r.reserved<0||!Object.hasOwn(PRICES,r.model)||typeof r.id!=='string')||(s.pricingAudits!==undefined&&!Array.isArray(s.pricingAudits)))throw new Error('Invalid ledger');s.safety=Math.max(s.safety,s.limit/10);this.state=s;await this.migrateReceiptPricing();}catch(e){if(e.code!=='ENOENT')throw new Error('Spending ledger cannot be read; provider calls blocked');}}
 async migrateReceiptPricing(){const updates=this.state.requests.filter(r=>r.settled===true&&r.pricingVersion!==PRICING_VERSION).map(r=>({r,cost:usageCost(r.model,r.usage,r.pricingScope)})).filter(x=>x.cost!==null);if(!updates.length)return;await this.transaction(()=>{const before=this.total(),originalCharges=updates.reduce((n,{r})=>n+r.charge,0);for(const {r,cost} of updates){if(r.pricingOriginalCharge===undefined)r.pricingOriginalCharge=r.charge;r.charge=cost;r.pricingVersion=PRICING_VERSION;}const audit={version:PRICING_VERSION,at:new Date().toISOString(),count:updates.length,originalCharges,correctedCharges:updates.reduce((n,{cost})=>n+cost,0),totalBefore:before,totalAfter:this.total(),uncertainCount:this.state.requests.filter(r=>!r.settled).length};this.state.pricingAudits??=[];this.state.pricingAudits.push(audit);});}
 total(){return this.state.requests.reduce((s,r)=>s+r.charge,0);}
 snapshot(){return {limit:this.state.limit,safety:this.state.safety,committed:this.total(),remaining:Math.max(0,this.state.limit-this.state.safety-this.total()),uncertain:this.state.requests.filter(r=>!r.settled).length};}
 async transaction(fn){const job=this.serial.then(async()=>{const result=fn();await writeFile(this.file+'.tmp',JSON.stringify(this.state),{mode:0o600});for(let n=0;;n++){try{await rename(this.file+'.tmp',this.file);break;}catch(e){if(n>=5||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,100*(n+1)));}}return result;});this.serial=job.catch(()=>{});return job;}
 async reserve(task,model,input,maxOutput){const budgetMode=taskBudgetPolicy(task);const p=Object.hasOwn(PRICES,model)?PRICES[model]:null;if(!p)throw new Error('Model has no verified spending policy');if(!Number.isInteger(input)||input<0||input>250000)throw new Error('Token count unavailable or context exceeds development limit');if(!Number.isInteger(maxOutput)||maxOutput<1||maxOutput>16384)throw new Error('Invalid output limit or task budget');
 const charge=((input*1.05+2048)*p.cacheWrite+maxOutput*p.output)/1e6+.02;
 return this.transaction(()=>{const used=this.total(),taskUsed=this.state.requests.filter(r=>r.taskId===task.id).reduce((n,r)=>n+r.charge,0);if(used+charge>this.state.limit-this.state.safety||(budgetMode==='task'&&taskUsed+charge>task.budget))throw new Error('Spending reservation denied: shared or task budget would be exceeded');const r={id:randomUUID(),taskId:task.id,model,charge,reserved:charge,settled:false,pricingScope:{serviceTier:'standard',inferenceGeo:'global'},at:new Date().toISOString()};this.state.requests.push(r);return r.id;});}
 async settle(id,usage,complete){if(!complete)return;return this.transaction(()=>{const r=this.state.requests.find(x=>x.id===id);if(!r||r.settled)return;const actual=usageCost(r.model,usage,r.pricingScope);if(actual===null)return;r.charge=actual;r.settled=true;r.usage=usage;r.pricingVersion=PRICING_VERSION;});}
}
