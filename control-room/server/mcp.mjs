import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir=process.env.CONTROL_ROOM_DIR||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.controlroom');
const server=new McpServer({name:'local-agent-control-room',version:'0.1.0'});
async function call(route,body){const c=JSON.parse(await readFile(path.join(dir,'connection.json'),'utf8'));if(!Number.isInteger(c.port)||c.port<1||c.port>65535)throw new Error('Invalid local connection');const r=await fetch(`http://127.0.0.1:${c.port}/api/${route}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${c.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(150000)});const x=await r.json();if(!r.ok)throw new Error(x.error);return {content:[{type:'text',text:JSON.stringify(x)}]};}
const register=(name,description,schema,fn)=>server.tool(name,description,schema,async args=>{try{return await fn(args);}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});
register('spawn','Start an explicitly authorized external worker. Real mode incurs API charges; online must already be enabled in the dashboard.',{name:z.string(),prompt:z.string(),model:z.string(),projectId:z.string().optional(),mode:z.enum(['demo','real']).default('demo'),budget:z.number().positive().max(500).default(5),rates:z.object({input:z.number().nonnegative().nullable().optional(),output:z.number().nonnegative().nullable().optional(),cacheRead:z.number().nonnegative().nullable().optional(),cacheWrite:z.number().nonnegative().nullable().optional()}).optional()},args=>call('tasks',args));
register('status','Inspect tasks and daemon status.',{id:z.string().optional()},args=>call(args.id?`tasks/${encodeURIComponent(args.id)}`:'status'));
register('results','Read reported conversation, activities and workspace files.',{id:z.string()},args=>call(`tasks/${encodeURIComponent(args.id)}/results`));
register('cancel','Revoke provider access and cancel a worker.',{id:z.string()},args=>call(`tasks/${encodeURIComponent(args.id)}/cancel`,{}));
register('followup','Send an authorized follow-up to an active worker; may incur API charges.',{id:z.string(),message:z.string().max(4096)},args=>call(`tasks/${encodeURIComponent(args.id)}/followup`,{message:args.message}));
await server.connect(new StdioServerTransport());
