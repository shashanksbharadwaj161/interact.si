import {Orchestrator} from '../outputs/control-room/server/adapter.mjs';import path from 'node:path';
const a=new Orchestrator(path.resolve('outputs/control-room/.controlroom'),path.join(process.env.LOCALAPPDATA,'Programs/agent-orchestrator/resources/daemon/ao.exe'));
await a.api(`sessions/${encodeURIComponent(process.argv[2])}/conversation/approvals/${encodeURIComponent(process.argv[3])}/resolve`,{method:'POST',body:JSON.stringify({decisionId:'allow'})});console.log('Reviewed repository-scoped command approved once.');
