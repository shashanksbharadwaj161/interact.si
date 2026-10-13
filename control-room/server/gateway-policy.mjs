import {PRICES} from './budget.mjs';

// Token counting has a narrower message schema than inference. Effort changes
// generation, not prompt text; omit its per-message wrapper for this endpoint.
export function countRequest(body) {
  const result=Object.fromEntries(['model','messages','system','tools','tool_choice','thinking'].filter(key=>body[key]!==undefined).map(key=>[key,structuredClone(body[key])]));
  if(Array.isArray(result.messages))for(const message of result.messages)delete message.output_config;
  return result;
}

// Claude Code makes auxiliary forced-tool requests. The main 5.5 models and
// Fable cannot accept those; Haiku supports them without changing tool intent.
export function routeRequest(input,task) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid Messages request');
  if(!PRICES[task.model])throw new Error('Model has no verified spending policy');
  const body=structuredClone(input);
  if(body.mcp_servers!==undefined&&(!Array.isArray(body.mcp_servers)||body.mcp_servers.length))throw new Error('Unverified remote MCP services are excluded from this budget');
  if(body.container!==undefined&&body.container!==null&&body.container!=='')throw new Error('Unverified remote containers are excluded from this budget');
  // Current Claude Code adds context-editing metadata to ordinary requests.
  // Drop it rather than enable API compaction or turn a local coding turn into
  // a remote-service rejection/retry loop. Empty remote descriptors are inert.
  delete body.context_management;delete body.mcp_servers;delete body.container;
  if((body.tools||[]).some(t=>t.type&&t.type!=='custom'))throw new Error('Paid server-side tools are excluded from this budget');
  const forced=['any','tool'].includes(body.tool_choice?.type);
  const auxiliary=forced||/^claude-haiku(?:-|$)/.test(body.model||'')||body.model==='haiku';
  body.model=auxiliary?'claude-haiku-5-5':task.model;
  const limit=Number(body.max_tokens??8192);
  if(!Number.isInteger(limit)||limit<1)throw new Error('Invalid max_tokens');
  body.max_tokens=Math.min(16384,limit);
  const effort=['low','medium','high'].includes(task.effort)?task.effort:'high';
  body.thinking=forced?{type:'disabled'}:{type:'adaptive'};
  body.output_config={...body.output_config,effort};
  // Sampling values copied from older model requests cause 400s on 5.5.
  for(const key of ['temperature','top_p','top_k','speed','inference_geo','service_tier'])delete body[key];
  // Disabled thinking requires consistent effort across message overrides.
  if(forced)for(const message of body.messages||[]){if(message.output_config?.effort!==undefined)message.output_config={...message.output_config,effort};}
  return body;
}
