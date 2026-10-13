import {readFile} from 'node:fs/promises';
const {port,token}=JSON.parse(await readFile('.controlroom/connection.json','utf8'));
async function api(route,body){const r=await fetch(`http://127.0.0.1:${port}/api/${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const x=await r.json();if(!r.ok)throw new Error(x.error);return x;}
console.log('Daemon:',await api('orchestrator/start',{}));console.log('Project registry:',await api('projects'));console.log('No workers spawned; no paid inference.');
