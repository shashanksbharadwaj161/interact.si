import http from 'node:http';import path from 'node:path';
import {Vault} from '../outputs/control-room/server/vault.mjs';import {Orchestrator} from '../outputs/control-room/server/adapter.mjs';import {call} from './control-room-client.mjs';
const vault=new Vault(path.resolve('outputs/control-room/.controlroom'));const key=await vault.get();
// Short-lived catalog-only gateway: no inference, prompts, browser origin, credentials returned, or remote access.
const server=http.createServer(async(req,res)=>{if(req.headers.host!==`127.0.0.1:${server.address().port}`||req.headers.origin||req.method!=='GET'||new URL(req.url,'http://local').pathname!=='/v1/models'){res.writeHead(403);res.end();return;}try{const r=await fetch('https://api.anthropic.com/v1/models?limit=100',{headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},signal:AbortSignal.timeout(15000)});res.writeHead(r.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await r.text());}catch{res.writeHead(502);res.end('{}');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const a=new Orchestrator(path.resolve('outputs/control-room/.controlroom'),path.join(process.env.LOCALAPPDATA,'Programs/agent-orchestrator/resources/daemon/ao.exe'));
try{
const config={defaultBranch:'main',env:{ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'control-room-broker',ANTHROPIC_DEFAULT_OPUS_MODEL:'claude-opus-5-5',ANTHROPIC_DEFAULT_SONNET_MODEL:'claude-sonnet-5-5',ANTHROPIC_DEFAULT_HAIKU_MODEL:'claude-haiku-5-5',ANTHROPIC_SMALL_FAST_MODEL:'claude-haiku-5-5',ANTHROPIC_DEFAULT_FABLE_MODEL:'claude-fable-5-1',CLAUDE_CODE_EFFORT_LEVEL:'high',CLAUDE_CONFIG_DIR:a.env.CLAUDE_CONFIG_DIR},worker:{agent:'claude-code'},agentConfig:{permissions:'accept-edits'}};
await a.cli(['project','set-config','jarvis-desktop','--config-json',JSON.stringify(config)]);
const fresh=await a.api('agents/claude-code/models/refresh?projectId=jarvis-desktop&revalidate=true',{method:'POST',body:'{}'});console.log(JSON.stringify({catalogFresh:!fresh.stale,source:fresh.source,models:fresh.models?.map(m=>m.id)}));
if(fresh.stale)throw Error('Catalog still stale');
const s=await call('status');for(const t of s.tasks.filter(t=>t.status==='failed'&&!t.sessionId&&t.events.at(-1)?.text.includes('MODEL_CAPABILITIES_UNAVAILABLE'))){const n=await call('tasks',{name:t.name,prompt:t.prompt,model:t.model,budget:t.budget,effort:t.effort,projectId:t.projectId,mode:'real'});console.log('Requeued '+n.name);}
// Spawn/configuration is asynchronous; keep catalog-only proxy alive briefly for its initial discovery.
await new Promise(r=>setTimeout(r,45000));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
