import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,lstat,realpath,readFile,writeFile,rename,symlink} from 'node:fs/promises';
import {materializeLoopWorkspace,resolveLoopPath,validateLoopPath,LOOP_MODELS} from './loop.mjs';

const executeDefault=promisify(execFile);
const fixedRepo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../jarvis-desktop');
const inside=(root,file)=>{const r=path.relative(root,file);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
const equal=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const clean=value=>String(value??'').replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g,'[redacted]').replace(/\/anthropic\/[A-Za-z0-9_-]+/g,'/anthropic/[redacted]').slice(0,12000);
// Only OS/runtime essentials cross the process boundary. In particular no
// provider, proxy, npm/node injection, token, or controller settings are inherited.
function workerEnv(){const env={};for(const k of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','ComSpec','PATH','Path','PATHEXT','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA','APPDATA'])if(process.env[k]!==undefined)env[k]=process.env[k];return env;}
async function safeRoot(root){
  root=path.resolve(root);const parts=[];let current=root;
  while(path.dirname(current)!==current){parts.unshift(current);current=path.dirname(current);}
  for(const part of parts){try{if((await lstat(part)).isSymbolicLink())throw new Error('API worker root cannot contain a reparse path');}catch(e){if(e.code!=='ENOENT')throw e;}}
  return root;
}
async function atomic(file,data){const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(data),{flag:'wx',mode:0o600});await rename(temp,file);}
function ownership(files){
  if(!Array.isArray(files)||!files.length||files.length>18)throw new Error('API worker requires exact fileOwnership');
  const seen=[];
  for(const f of files){
    if(typeof f!=='string'||!/^docs\/loop\/(?:decision|result\.[a-z][a-z0-9-]{0,39})\.json$/.test(f))validateLoopPath(f);
    // An extension is mandatory: folder ownership and shell-like names are denied.
    if(!/\.[a-z0-9]+$/i.test(f)||/[<>"|?*]/.test(f))throw new Error('API worker ownership must name exact source files');
    const lower=f.toLowerCase();if(seen.some(x=>x===lower||x.startsWith(lower+'/')||lower.startsWith(x+'/')))throw new Error('API worker ownership overlaps');seen.push(lower);
  }
  return [...files];
}

export class ApiWorkerAdapter {
  constructor({base,dir,repo,execute=executeDefault,launch=spawn}){
    if(!base||!dir||!repo||!equal(repo,fixedRepo))throw new Error('API workers require the fixed application repository');
    Object.assign(this,{base,dir:path.resolve(dir),repo:path.resolve(repo),execute,launch});this.workers=new Map();
  }
  start(...args){return this.base.start(...args);}
  state(...args){return this.base.state(...args);}
  projects(...args){return this.base.projects(...args);}
  addProject(...args){return this.base.addProject(...args);}
  api(...args){return this.base.api(...args);}
  cli(...args){return this.base.cli(...args);}
  async spawn(task,gateway){
    if(task.launchMode!=='api-tools')return this.base.spawn(task,gateway);
    const files=ownership(task.fileOwnership);
    if(task.projectId!=='jarvis-desktop'||!LOOP_MODELS.includes(task.model)||typeof task.prompt!=='string'||!task.prompt.trim()||task.prompt.length>64000)throw new Error('Invalid API worker task');
    let url;try{url=new URL(gateway);}catch{throw new Error('Invalid worker gateway');}
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||!/^\/anthropic\/[a-f0-9]{64}$/.test(url.pathname))throw new Error('API worker requires a local scoped gateway');
    await safeRoot(this.repo);await safeRoot(this.dir);
    if(inside(this.repo,this.dir)||inside(this.dir,this.repo))throw new Error('API worker state and source must be independent');
    for(const f of files){const target=await resolveLoopPath(this.repo,f);try{if(!(await lstat(target)).isFile())throw new Error('API ownership is not an exact file');}catch(e){if(e.code!=='ENOENT')throw e;}}
    const id='api-'+randomUUID(),workspace=path.join(this.dir,'api-worktrees',id),privateDir=path.join(this.dir,'api-workers',id),stateFile=path.join(privateDir,'state.json');
    await mkdir(path.dirname(workspace),{recursive:true,mode:0o700});await mkdir(privateDir,{recursive:true,mode:0o700});
    await safeRoot(workspace);await safeRoot(privateDir);
    try{
      await this.execute('git',['-C',this.repo,'worktree','add','--detach',workspace,'HEAD'],{windowsHide:true,timeout:120000,maxBuffer:1024*1024,env:workerEnv()});
      await materializeLoopWorkspace({repo:this.repo,workspace});
      const deps=path.join(this.repo,'node_modules');await safeRoot(deps);
      if(!(await lstat(deps)).isDirectory())throw new Error('Canonical dependencies are unavailable');
      const link=path.join(workspace,'node_modules');
      try{await lstat(link);throw new Error('Worktree dependency path already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
      await symlink(await realpath(deps),link,process.platform==='win32'?'junction':'dir');
      const config=path.join(privateDir,'config.json');
      await atomic(config,{workspace,gateway,model:task.model,prompt:task.prompt,files,stateFile,canonicalRepo:this.repo});
      const record={id,workspace,stateFile,child:null,terminal:null};this.workers.set(id,record);
      await atomic(stateFile,{status:'active',summary:'',events:[]});
      try{
        const child=this.launch(process.execPath,[path.join(path.dirname(fileURLToPath(import.meta.url)),'api-worker.mjs'),config],{cwd:workspace,env:workerEnv(),windowsHide:true,stdio:'ignore'});record.child=child;
        child.once('error',()=>{record.terminal={status:'failed',reason:'API worker process could not start'};});
        child.once('exit',(code,signal)=>{record.exit={code,signal};});
      }catch{record.terminal={status:'failed',reason:'API worker process could not start'};throw new Error('API worker process could not start');}
      return id;
    }catch{throw new Error('API worker provisioning or launch failed; retained workspace and private records for inspection');}
  }
  async readState(record){
    if(record.terminal)return record.terminal;
    let state;try{const file=await resolveLoopPath(path.dirname(record.stateFile),'state.json');if((await lstat(file)).size>1024*1024)throw new Error('large');state=JSON.parse(await readFile(file,'utf8'));}catch{return {status:'failed',reason:'API worker state unavailable'};}
    const status=state.status??state.state;
    if(!['active','idle','blocked','failed','terminated'].includes(status))return {status:'failed',reason:'API worker state invalid'};
    if(record.exit&&status==='active')return {status:'failed',reason:'API worker exited without a final result'};
    return {...state,status};
  }
  record(id){const r=this.workers.get(id);if(!r)throw new Error('API worker is not owned by this controller; retained worktrees require explicit new tasks');return r;}
  async get(id){
    if(!String(id).startsWith('api-'))return this.base.get(id);
    const r=this.record(id),s=await this.readState(r),status={active:'working',idle:'idle',blocked:'needs_input',failed:'failed',terminated:'terminated'}[s.status];
    return {id,status,workspacePath:r.workspace,activity:{state:s.status==='active'?'active':s.status==='blocked'?'blocked':s.status==='idle'?'idle':'exited'},...(['blocked','failed'].includes(s.status)?{error:clean(s.reason||s.error||'API worker stopped without a result')}: {})};
  }
  async details(id){
    if(!String(id).startsWith('api-'))return this.base.details(id);
    const s=await this.readState(this.record(id));
    const events=(Array.isArray(s.events)?s.events:[]).filter(e=>e&&typeof e==='object'&&e.activityKind!=='reasoning'&&e.type!=='reasoning'&&e.type!=='thinking').slice(-100);
    return {conversation:{messages:s.summary?[{role:'assistant',text:clean(s.summary)}]:[],activities:events.filter(e=>e.tool||e.activityKind==='tool'||e.type==='tool').map(e=>({activityKind:'tool',title:clean(e.tool||e.title||'Tool'),text:clean(e.text||e.summary||[e.path,e.check,Number.isInteger(e.exit)?'exit '+e.exit:null].filter(x=>x!==undefined&&x!==null).join(' — '))}))},files:{files:[]},limitations:['Source changes remain in the isolated worktree; use local review to inspect the diff.']};
  }
  async diff(id,file){if(!String(id).startsWith('api-'))return this.base.diff(id,file);this.record(id);throw new Error('Inspect API worker source changes through the retained local worktree');}
  async cancel(id){
    if(!String(id).startsWith('api-'))return this.base.cancel(id);
    const r=this.record(id);if(r.child&&!r.exit&&!r.child.killed){if(r.child.kill()===false)throw new Error('API worker termination could not be confirmed');}
    const previous=await this.readState(r);r.terminal={...previous,status:'terminated',reason:'Cancelled explicitly'};await atomic(r.stateFile,r.terminal);return {ok:true};
  }
  async followup(id,...args){if(!String(id).startsWith('api-'))return this.base.followup(id,...args);this.record(id);throw new Error('Create a new explicitly authorized API task for follow-up work');}
  async resume(id,...args){if(!String(id).startsWith('api-'))return this.base.resume(id,...args);this.record(id);throw new Error('Create a new explicitly authorized API task to resume work');}
  async stop(){const results=await Promise.allSettled([...this.workers.keys()].map(id=>this.cancel(id)));await this.base.stop();if(results.some(r=>r.status==='rejected'))throw new Error('Some API worker terminations could not be confirmed');}
}
