import {Orchestrator} from '../outputs/control-room/server/adapter.mjs';
import path from 'node:path';
const adapter=new Orchestrator(path.resolve('outputs/control-room/.controlroom'),path.join(process.env.LOCALAPPDATA,'Programs/agent-orchestrator/resources/daemon/ao.exe'));
const id=process.argv[2];const c=await adapter.api(`sessions/${encodeURIComponent(id)}/conversation`);console.log(JSON.stringify({controller:c.controller,settings:c.settings,turns:c.turns?.map(t=>({state:t.state,error:t.errorMessage})),account:c.account?.lastAuthFailureReason,activities:c.activities?.filter(x=>x.activityKind==='error'||((x.activityKind==='approval'||x.activityKind==='user_input')&&x.status==='pending')).map(x=>({id:x.id,requestId:x.requestId,kind:x.activityKind,summary:x.summary,status:x.status,detail:x.detail}))},null,2));const s=await adapter.get(id);console.log(JSON.stringify({path:s.path,workspace:s.workspacePath,worktree:s.worktreePath,sessionId:s.id,status:s.status}));

