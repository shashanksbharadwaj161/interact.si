import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve('outputs/control-room');
const c=JSON.parse(await readFile(path.join(root,'.controlroom/connection.json'),'utf8'));
export async function call(route,body,method){const r=await fetch(`http://127.0.0.1:${c.port}/api/${route}`,{method:method||(body===undefined?'GET':'POST'),headers:{Authorization:`Bearer ${c.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(150000)});const x=await r.json();if(!r.ok)throw new Error(x.error);return x;}
if(process.argv[1]===fileURLToPath(import.meta.url)&&process.argv[2]){const body=process.argv[3]?JSON.parse(process.argv[3]):undefined;console.log(JSON.stringify(await call(process.argv[2],body),null,2));}
