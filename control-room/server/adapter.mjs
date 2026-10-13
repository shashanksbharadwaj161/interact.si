import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
const exec=promisify(execFile);
export class Orchestrator {
  constructor(dir, binary) {
    this.dir=path.join(dir,'orchestrator'); this.binary=binary; this.child=null;this.owned=false;
    this.env={...process.env,AO_DATA_DIR:this.dir,AO_RUN_FILE:path.join(this.dir,'running.json'),AO_PORT:'4318',AO_TELEMETRY_EVENTS:'off',AO_TELEMETRY_METRICS:'off',AO_TELEMETRY_REMOTE:'off',CLAUDE_CONFIG_DIR:path.join(dir,'claude')};
    for(const k of Object.keys(this.env)) if(/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_)/.test(k)) delete this.env[k];
  }
  async cli(args,timeout=20000) {
    try {const r=await exec(this.binary,args,{env:this.env,windowsHide:true,timeout,maxBuffer:4*1024*1024});return r.stdout.trim();}
    catch(e){throw new Error((e.stderr||e.stdout||'Orchestrator command failed').toString().slice(0,1500));}
  }
  async state() {try{return JSON.parse(await this.cli(['status','--json'],5000));}catch{return {state:'unavailable'};}}
  async start() {
    const s=await this.state(); if(s.state==='ready'){this.owned=true;return s;}
    await mkdir(this.dir,{recursive:true}); await mkdir(this.env.CLAUDE_CONFIG_DIR,{recursive:true});
    this.env.AO_PORT=String(await new Promise((resolve,reject)=>{const probe=net.createServer();probe.on('error',reject);probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});}));
    this.child=spawn(this.binary,['daemon'],{env:this.env,windowsHide:true,stdio:'ignore'});this.owned=true;
    let launchError=false; this.child.on('error',()=>launchError=true);
    for(let i=0;i<20;i++){if(launchError)throw new Error('Orchestrator executable unavailable'); await new Promise(r=>setTimeout(r,500)); const status=await this.state(); if(status.state==='ready')return status;}
    throw new Error('Orchestrator daemon did not become ready');
  }
  async api(route,options={}) {
    const info=JSON.parse(await readFile(this.env.AO_RUN_FILE,'utf8'));
    if(!Number.isInteger(info.port)||info.port<1)throw new Error('Invalid Orchestrator handshake');
    const res=await fetch(`http://127.0.0.1:${info.port}/api/v1/${route}`,{...options,headers:{'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(20000)});
    const text=await res.text();const json=text?JSON.parse(text):{ok:true}; if(!res.ok)throw new Error(json.error?.message||json.error||`Orchestrator returned ${res.status}`);
    return json.data??json;
  }
  async projects(){const x=JSON.parse(await this.cli(['project','ls','--json']));return x.projects??x;}
  async addProject(repo) {
    // Validate before AO can initialize/adopt anything. Registration never creates a repo.
    const r=await exec('git',['-C',repo,'rev-parse','--show-toplevel'],{windowsHide:true});
    if(path.resolve(r.stdout.trim()).toLowerCase()!==path.resolve(repo).toLowerCase())throw new Error('Choose the Git repository root');
    await exec('git',['-C',repo,'rev-parse','--verify','HEAD'],{windowsHide:true});
    await this.cli(['project','add','--path',path.resolve(repo),'--worker-agent','claude-code']);
    return this.projects();
  }
  async spawn(task, gateway) {
    // Dedicated daemon + project registry: never alter the user's existing AO projects.
    const projectData=JSON.parse(await this.cli(['project','get',task.projectId,'--json']));const project=projectData.project??projectData;
    const repo=project.path??project.repoPath;if(!repo)throw new Error('Orchestrator project did not provide its repository path');
    const branch=(await exec('git',['-C',repo,'symbolic-ref','--short','HEAD'],{windowsHide:true})).stdout.trim();
    const config={defaultBranch:branch,env:{ANTHROPIC_BASE_URL:gateway,ANTHROPIC_API_KEY:'control-room-broker',CLAUDE_CODE_EFFORT_LEVEL:task.effort||'high',CLAUDE_CONFIG_DIR:this.env.CLAUDE_CONFIG_DIR},worker:{agent:'claude-code'},agentConfig:{permissions:'accept-edits'}};
    await this.cli(['project','set-config',task.projectId,'--config-json',JSON.stringify(config)]);
    const out=await this.cli(['spawn','--project',task.projectId,'--harness','claude-code','--mode','chat','--model',task.model,'--name',task.name,'--prompt',task.prompt],120000);
    const id=out.match(/spawned session\s+(\S+)/)?.[1]; if(!id)throw new Error('Orchestrator did not return a worker ID'); return id;
  }
  async get(id){const x=JSON.parse(await this.cli(['session','get',id,'--json']));return x.session??x;}
  async cancel(id){return this.cli(['session','kill',id]);}
  async followup(id,message){return this.cli(['send','--session',id,'--message',message,'--steer']);}
  async resume(id){return this.cli(['session','resume-agent',id]);}
  async details(id){
    const results=await Promise.allSettled([this.api(`sessions/${encodeURIComponent(id)}/conversation`),this.api(`sessions/${encodeURIComponent(id)}/workspace/files`)]);
    return {conversation:results[0].status==='fulfilled'?results[0].value:null,files:results[1].status==='fulfilled'?results[1].value:null,limitations:results.filter(x=>x.status==='rejected').map(x=>x.reason.message)};
  }
  async diff(id,file){return this.api(`sessions/${encodeURIComponent(id)}/workspace/file?path=${encodeURIComponent(file)}`);}
  async stop(){if(this.owned){await this.cli(['stop']).catch(()=>{});this.child=null;this.owned=false;}}
}
