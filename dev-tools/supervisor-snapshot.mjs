import {call} from './control-room-client.mjs';
import {Orchestrator} from '../outputs/control-room/server/adapter.mjs';
import path from 'node:path';
const adapter=new Orchestrator(path.resolve('outputs/control-room/.controlroom'),path.join(process.env.LOCALAPPDATA,'Programs/agent-orchestrator/resources/daemon/ao.exe'));
const state=await call('status');
const tasks=state.tasks.filter(t=>t.authorized&&t.sessionId);
const results=await Promise.allSettled(tasks.map(async task=>{
 const c=await adapter.api(`sessions/${encodeURIComponent(task.sessionId)}/conversation`);
 return {task:task.id,name:task.name,session:task.sessionId,status:task.status,controller:c.controller,turn:c.turns?.at(-1)?.state,pending:c.activities?.filter(a=>(a.activityKind==='approval'||a.activityKind==='user_input')&&a.status==='pending').map(a=>({request:a.requestId,kind:a.activityKind,input:a.detail?.input,decisions:a.detail?.decisions?.map(d=>d.id)}))};
}));
for(const result of results)console.log(JSON.stringify(result.status==='fulfilled'?result.value:{error:result.reason?.message}));
