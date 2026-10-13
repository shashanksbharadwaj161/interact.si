import {Orchestrator} from '../outputs/control-room/server/adapter.mjs';import path from 'node:path';
const a=new Orchestrator(path.resolve('outputs/control-room/.controlroom'),path.join(process.env.LOCALAPPDATA,'Programs/agent-orchestrator/resources/daemon/ao.exe'));
const x=await a.api('agents/claude-code/models?projectId=jarvis-desktop');
console.log(JSON.stringify(x,(k,v)=>/baseurl|apikey|token|authorization|env/i.test(k)?'[OMITTED]':typeof v==='string'?v.replace(/\/anthropic\/[a-f0-9]{64}/g,'/anthropic/[CAPABILITY]'):v,2));
