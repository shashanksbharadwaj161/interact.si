import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {resolveLoopPath,validateLoopPath} from './loop.mjs';
const exec=promisify(execFile), sha=b=>createHash('sha256').update(b).digest('hex');
const GOALS='src/shared/feature-registry.json';
const protectedFile=f=> /^(?:tests\/|scripts\/|native\/)/.test(f)||f===GOALS||/^docs\/(?:product-roadmap|loop\/(?:GOAL|LOOP|VERIFIER))/i.test(f)||/(?:^|\/)(?:package(?:-lock)?\.json|[^/]*config[^/]*|[^/]*lock[^/]*)$/i.test(f);
const clean=s=>String(s??'').replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g,'[redacted]').replace(/authorization\s*[:=][^\r\n]*/gi,'authorization=[redacted]').replace(/bearer\s+\S+/gi,'bearer [redacted]').replace(/(?:api[-_]?key|password|token)\s*[:=]\s*\S+/gi,'credential=[redacted]').slice(0,262144);
async function git(repo,args){return (await exec('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:8*1024*1024,windowsHide:true})).stdout;}
async function bytes(root,file,max=10*1024*1024){const p=await resolveLoopPath(root,file);const s=await lstat(p);if(!s.isFile()||s.size>max)throw Error('Not a bounded regular file: '+file);const b=await readFile(p);if(b.length>max||b.includes(0))throw Error('Binary or oversized file: '+file);return b;}
async function maybe(root,file){try{return await bytes(root,file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function atomic(root,file,b){const p=await resolveLoopPath(root,file);await mkdir(path.dirname(p),{recursive:true});await resolveLoopPath(root,file);const tmp=p+'.'+randomUUID()+'.tmp';await writeFile(tmp,b,{flag:'wx'});await rename(tmp,p);}
async function defaultRun({command,args,cwd}){
 const cli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 await lstat(cli); // No PATH/shell fallback: install a trusted bundled npm if unavailable.
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(?:secret|token|api.?key|anthropic|openai|aws_|azure_)/i.test(k)));
 return await new Promise((resolve,reject)=>{let stdout='',stderr='';const p=spawn(process.execPath,[cli,...args],{cwd,windowsHide:true,shell:false,env});p.stdout.on('data',b=>stdout=(stdout+b).slice(-262144));p.stderr.on('data',b=>stderr=(stderr+b).slice(-262144));p.on('error',reject);const timer=setTimeout(()=>p.kill(),600000);p.on('close',exitCode=>{clearTimeout(timer);resolve({exitCode:exitCode??1,stdout,stderr});});});
}
/** Ingestion/verification boundary, not an OS sandbox. Same-user CLI workers
 * could write elsewhere; pinned snapshots and exact diff audit detect tampering
 * in checked inputs, but do not claim filesystem isolation against that user. */
export async function createLoopVerifier({repo,stateDir,baselineCommit,run=defaultRun}){
 repo=path.resolve(repo);stateDir=path.resolve(stateDir);await mkdir(stateDir,{recursive:true});
 if((await lstat(stateDir)).isSymbolicLink())throw Error('Verifier state directory is a reparse path');
 if((await realpath(repo))!==repo&&process.platform!=='win32')throw Error('Repository root is a reparse path');
 await resolveLoopPath(repo,GOALS);
 const snapshotPath=path.join(stateDir,'verifier-baseline.json');let base;
 try{base=JSON.parse(await readFile(snapshotPath,'utf8'));if(base.version!==1||base.repo!==repo||!base.protected||!Array.isArray(base.goalIds))throw Error('Invalid saved verifier baseline');}
 catch(e){if(e.code!=='ENOENT')throw e;
  const head=(await git(repo,['rev-parse','HEAD'])).trim();if(baselineCommit&&head!==baselineCommit)throw Error('Baseline commit does not match original HEAD');
  const tracked=[...new Set([...(await git(repo,['ls-files','-z'])).split('\0'),...(await git(repo,['ls-files','--others','--exclude-standard','-z'])).split('\0')].filter(Boolean))], protectedHashes={},sourceHashes={};
  for(const f of tracked.filter(protectedFile))protectedHashes[f]=sha(await bytes(repo,f));
  for(const f of tracked.filter(f=>/^(?:src|electron)\//.test(f)&&!protectedFile(f)))sourceHashes[f]=sha(await bytes(repo,f));
  const g=JSON.parse((await bytes(repo,GOALS)).toString());const ids=(g.entries??g.features??[]).map(x=>String(x.id));if(!ids.length||new Set(ids).size!==ids.length)throw Error('Missing or duplicate baseline goals');
  base={version:1,repo,head,protected:protectedHashes,sourceHashes,goalIds:ids,goalsFingerprint:sha(JSON.stringify(g))};await writeFile(snapshotPath,JSON.stringify(base,null,2),{flag:'wx',mode:0o600});
 }
 const baselineDigest=sha(JSON.stringify(base));let busy=false;
 const acceptedPath=path.join(stateDir,'verifier-accepted-source.json');let accepted={baselineDigest,files:{}};
 try{accepted=JSON.parse(await readFile(acceptedPath,'utf8'));if(accepted.baselineDigest!==baselineDigest||!accepted.files||typeof accepted.files!=='object')throw Error('Accepted source baseline mismatch');}catch(e){if(e.code!=='ENOENT')throw e;}
 return async function verify({workers=[],decision={},observationId}){
  const checks=[], backups=new Map(), integrated=new Map();let sourceFingerprint=null;
  if(busy)return {passed:false,complete:false,checks,blocked:true,reason:'Verifier already running'};busy=true;
  try{
   if(sha(JSON.stringify(JSON.parse(await readFile(snapshotPath,'utf8'))))!==baselineDigest)throw Error('Private verifier baseline changed');
   if((await git(repo,['rev-parse','HEAD'])).trim()!==base.head)throw Error('Original repository HEAD changed; explicit baseline reconciliation required');
   for(const [f,h] of Object.entries(base.protected))if(sha(await bytes(repo,f))!==h)throw Error('Pinned test/config/goal/native baseline changed: '+f);
   for(const t of decision.tasks??[])for(const id of t.goalIds??[])if(!base.goalIds.includes(String(id)))throw Error('Unknown baseline goal ID: '+id);
   const candidates=new Map();let total=0;
   const originalDirty=new Set((await git(repo,['diff','--name-only','-z','HEAD','--'])).split('\0').filter(Boolean));
   for(const w of workers){
    if(!/^[a-z][a-z0-9-]{0,39}$/.test(w.role??''))throw Error('Invalid worker role');
    if(path.resolve(w.workspace)===repo)throw Error('Worker must have isolated workspace');
    await resolveLoopPath(w.workspace,GOALS);
    if((await git(w.workspace,['rev-parse','HEAD'])).trim()!==base.head)throw Error('Worker committed or changed its pinned HEAD');
    for(const forbidden of ['.env','.env.local','.env.production','.controlroom/connection.json'])if(await maybe(w.workspace,forbidden))throw Error('Private credential artifact in worker workspace');
    const ignoredSource=(await git(w.workspace,['ls-files','--others','--ignored','--exclude-standard','-z','--','src','electron','native','docs','tests'])).split('\0').filter(Boolean);
    if(ignoredSource.length)throw Error('Ignored untracked source must be reviewed: '+ignoredSource[0]);
    const allowed=new Set((w.files??[]).map(validateLoopPath)), marker=`docs/loop/result.${w.role}.json`;
    const files=[...new Set([...(await git(w.workspace,['diff','--name-only','-z','HEAD','--'])).split('\0'),...(await git(w.workspace,['ls-files','--others','--exclude-standard','-z'])).split('\0')].filter(Boolean))];
    for(const f of files){
     const b=await maybe(w.workspace,f);if(!b)throw Error('Worker deletion rejected: '+f);
     if(f===marker){if(b.length>131072)throw Error('Oversized result marker');continue;}
     // Controller-generated observation/goal context is tolerated only unchanged.
     if(/^docs\/loop\//.test(f)){const original=await maybe(repo,f);if(original&&sha(original)===sha(b))continue;throw Error('Changed controller context: '+f);}
     // Prelaunch materialization supplies canonical dirty context as well as
     // accepted rounds. Identical bytes introduce no candidate or permission.
     {const original=await maybe(repo,f);if(original&&sha(original)===sha(b))continue;}
     // A trusted source snapshot inherited from an earlier accepted round is
     // context, not new ownership. Any byte change still requires ownership.
     if(accepted.files[f]===sha(b)){const original=await maybe(repo,f);if(original&&sha(original)===sha(b))continue;}
     if(!allowed.has(f))throw Error('Out-of-scope worker change: '+f);
     validateLoopPath(f);
     if(Object.hasOwn(base.protected,f)||protectedFile(f)&&!f.startsWith('tests/'))throw Error('Protected baseline path: '+f);
     if(!/\.(?:tsx?|jsx?|mjs|cjs|css|json|md|txt|ps1)$/i.test(f))throw Error('Unapproved source extension: '+f);
     if(candidates.has(f.toLowerCase()))throw Error('Duplicate worker ownership: '+f);
     total+=b.length;if(total>30*1024*1024)throw Error('Combined source exceeds bound');
     const original=await maybe(repo,f);
     // New tests must be additive, never overwrite a prior/current test.
     if(f.startsWith('tests/')&&original)throw Error('Existing tests cannot be replaced: '+f);
     const tracked=await git(repo,['ls-files','--error-unmatch','--',f]).then(()=>true,()=>false);
     const previouslyAccepted=original&&(accepted.files[f]===sha(original)||base.sourceHashes?.[f]===sha(original));
     if(original&&originalDirty.has(f)&&sha(original)!==sha(b)&&!previouslyAccepted)throw Error('Original dirty source conflict: '+f);
     if(original&&!tracked&&sha(original)!==sha(b)&&!previouslyAccepted)throw Error('Original untracked source conflict: '+f);
     candidates.set(f.toLowerCase(),{f,b,old:original});
    }
   }
   for(const {f,b,old} of candidates.values()){
    const current=await maybe(repo,f);if((current?sha(current):null)!==(old?sha(old):null))throw Error('Stale original input: '+f);
    backups.set(f,old);await atomic(repo,f,b);integrated.set(f,sha(b));
   }
   sourceFingerprint=sha([...candidates.values()].map(x=>[x.f,sha(x.b)]).sort().flat().join('\n'));
   const evidenceDir=path.join(stateDir,'evidence');await mkdir(evidenceDir,{recursive:true});
   for(const args of [['test'],['run','build'],['run','smoke']]){
    // Recheck pinned tests/scripts before every executable gate.
    for(const [f,h] of Object.entries(base.protected))if(sha(await bytes(repo,f))!==h)throw Error('Pinned gate changed during verification: '+f);
    const command='npm '+args.join(' ');const r=await run({command,args,cwd:repo});const exitCode=Number.isInteger(r.exitCode)?r.exitCode:1;
    const raw=clean((r.stdout??'')+'\n'+(r.stderr??''));const fingerprint=sha(raw);const outputRef=path.join(evidenceDir,Date.now()+'-'+randomUUID()+'.log');await writeFile(outputRef,raw,{mode:0o600});checks.push({command,exitCode,outputRef,fingerprint,...(exitCode!==0?{diagnostic:raw.slice(-10000)}:{})});
    if(exitCode!==0)throw Error('Independent gate failed: '+command);
   }
   for(const [f,h] of Object.entries(base.protected))if(sha(await bytes(repo,f))!==h)throw Error('Pinned baseline changed during gates: '+f);
   for(const [f,h] of integrated)if(sha(await bytes(repo,f))!==h)throw Error('Integrated source changed during gates: '+f);
   const nextAccepted={baselineDigest,files:{...accepted.files,...Object.fromEntries(integrated)}};
   const acceptedTmp=acceptedPath+'.'+randomUUID()+'.tmp';await writeFile(acceptedTmp,JSON.stringify(nextAccepted),{flag:'wx',mode:0o600});await rename(acceptedTmp,acceptedPath);accepted=nextAccepted;
   // Completion is deliberately fail closed. A worker cannot author operator
   // acceptance for hardware/accounts/signing; root controller must supply that.
   const full=['complete','verify'].includes(decision.action);
   return {passed:true,complete:false,checks,sourceFingerprint,...(full?{blocked:true,reason:'Operator acceptance missing: real hardware, accounts/integrations, installer/signing and full baseline-goal acceptance remain unverified'}:{reason:'Independent software gates passed; continue baseline goals'})};
  }catch(e){
   let rollbackIssue=false;
   for(const [f,old] of [...backups].reverse())try{const current=await maybe(repo,f);if(current&&sha(current)!==integrated.get(f)){rollbackIssue=true;continue;}if(old)await atomic(repo,f,old);else await unlink(await resolveLoopPath(repo,f));}catch{rollbackIssue=true;}
   const repairable=/^Independent gate failed: /.test(e.message)&&!rollbackIssue;
   return {passed:false,complete:false,checks,sourceFingerprint,blocked:!repairable,reason:clean(e.message)+(rollbackIssue?'; rollback conflict preserved for review':'')};
  }finally{busy=false;}
 };
}
