import {mkdir,stat} from 'node:fs/promises';import {createWriteStream,createReadStream} from 'node:fs';import {pipeline} from 'node:stream/promises';import {Readable} from 'node:stream';import {createHash} from 'node:crypto';import path from 'node:path';
const dir=path.resolve('work/tools/ollama');await mkdir(dir,{recursive:true});const file=path.join(dir,'ollama-windows-amd64-v0.40.3.zip');
const expected='e5ecff02dfc7cae8ddf6d6b7a7ac5f727ffeedf4491f44ae75ff5b0820dbbbd5';
let exists=false;try{exists=(await stat(file)).size>0;}catch{}
if(!exists){const r=await fetch('https://github.com/ollama/ollama/releases/download/v0.40.3/ollama-windows-amd64.zip');if(!r.ok)throw Error('Official runtime download failed: HTTP '+r.status);await pipeline(Readable.fromWeb(r.body),createWriteStream(file));}
const hash=createHash('sha256');for await(const b of createReadStream(file))hash.update(b);if(hash.digest('hex')!==expected)throw Error('Ollama archive checksum mismatch; do not execute');console.log('Official Ollama v0.40.3 archive checksum verified.');
