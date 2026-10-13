import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const PRICES={
 'claude-fable-5-1':{input:10,output:50,cacheRead:.25,cacheWrite:20},
 'claude-opus-5-5':{input:4,output:20,cacheRead:.2,cacheWrite:8},
 'claude-sonnet-5-5':{input:2,output:10,cacheRead:.1,cacheWrite:4},
 'claude-haiku-5-5':{input:.5,output:2.5,cacheRead:.05,cacheWrite:1}
};
// Cache writes conservatively priced at one-hour rate; Haiku at long-context rate.
export class Budget {
 constructor(dir){this.file=path.join(dir,'spending.json');this.state={limit:300,safety:10,requests:[]};this.serial=Promise.resolve();}
 async init(){try{const s=JSON.parse(await readFile(this.file,'utf8'));if(!Number.isFinite(s.limit)||s.limit<=0||s.limit>300||!Number.isFinite(s.safety)||s.safety<0||s.safety>=s.limit||!Array.isArray(s.requests)||s.requests.some(r=>!Number.isFinite(r.charge)||r.charge<0||!Number.isFinite(r.reserved)||r.reserved<0||!PRICES[r.model]||typeof r.id!=='string'))throw new Error('Invalid ledger');s.safety=Math.max(s.safety,s.limit/30);this.state=s;}catch(e){if(e.code!=='ENOENT')throw new Error('Spending ledger cannot be read; provider calls blocked');}}
 total(){return this.state.requests.reduce((s,r)=>s+r.charge,0);}
 snapshot(){return {limit:this.state.limit,safety:this.state.safety,committed:this.total(),remaining:Math.max(0,this.state.limit-this.state.safety-this.total()),uncertain:this.state.requests.filter(r=>!r.settled).length};}
 async transaction(fn){const job=this.serial.then(async()=>{const result=fn();await writeFile(this.file+'.tmp',JSON.stringify(this.state),{mode:0o600});for(let n=0;;n++){try{await rename(this.file+'.tmp',this.file);break;}catch(e){if(n>=5||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,100*(n+1)));}}return result;});this.serial=job.catch(()=>{});return job;}
 async reserve(task,model,input,maxOutput){const p=PRICES[model];if(!p)throw new Error('Model has no verified spending policy');if(!Number.isInteger(input)||input<0||input>250000)throw new Error('Token count unavailable or context exceeds development limit');if(!Number.isInteger(maxOutput)||maxOutput<1||maxOutput>16384||!Number.isFinite(task.budget)||task.budget<=0)throw new Error('Invalid output limit or task budget');
 const charge=((input*1.05+2048)*p.cacheWrite+maxOutput*p.output)/1e6+.02;
 return this.transaction(()=>{const used=this.total(),taskUsed=this.state.requests.filter(r=>r.taskId===task.id).reduce((n,r)=>n+r.charge,0);if(used+charge>this.state.limit-this.state.safety||taskUsed+charge>task.budget)throw new Error('Spending reservation denied: shared or task budget would be exceeded');const r={id:randomUUID(),taskId:task.id,model,charge,reserved:charge,settled:false,at:new Date().toISOString()};this.state.requests.push(r);return r.id;});}
 async settle(id,usage,complete){if(!complete)return;if(!usage||!['input_tokens','output_tokens'].every(k=>Number.isInteger(usage[k])&&usage[k]>=0)||['cache_read_input_tokens','cache_creation_input_tokens'].some(k=>usage[k]!==undefined&&(!Number.isInteger(usage[k])||usage[k]<0)))return;return this.transaction(()=>{const r=this.state.requests.find(x=>x.id===id);if(!r||r.settled)return;const p=PRICES[r.model];const actual=(usage.input_tokens*p.input+usage.output_tokens*p.output+(usage.cache_read_input_tokens||0)*p.cacheRead+(usage.cache_creation_input_tokens||0)*p.cacheWrite)/1e6;r.charge=Math.max(0,actual);r.settled=true;r.usage=usage;});}
}
