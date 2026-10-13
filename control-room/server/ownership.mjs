import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';import {open,unlink} from 'node:fs/promises';import path from 'node:path';
export async function ownDirectory(dir){
 if(process.platform!=='win32'){const file=path.join(dir,'service.lock');const handle=await open(file,'wx');return async()=>{await handle.close();await unlink(file);};}
 const name='Local\\JarvisControlRoom_'+createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex');
 const script=`$ErrorActionPreference='Stop'; $m=[System.Threading.Mutex]::new($false,'${name}'); $owned=$false; try{try{$owned=$m.WaitOne(0)}catch [System.Threading.AbandonedMutexException]{$owned=$true}; if(-not $owned){[Console]::Out.WriteLine('BUSY');exit 2};[Console]::Out.WriteLine('READY');[Console]::Out.Flush();[Console]::In.ReadToEnd()|Out-Null}finally{if($owned){$m.ReleaseMutex()};$m.Dispose()}`;
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
 await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>{child.kill();reject(new Error('Service ownership timeout'));},10000);child.stdout.on('data',b=>{text+=b;if(text.includes('READY')){clearTimeout(timer);resolve();}else if(text.includes('BUSY')){clearTimeout(timer);reject(new Error('Another Control Room owns this state directory'));}});child.on('error',()=>{clearTimeout(timer);reject(new Error('Service ownership unavailable'));});child.on('exit',code=>{clearTimeout(timer);if(!text.includes('READY'))reject(new Error('Service ownership unavailable'));});});
 return async()=>{child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},2000).unref();});};
}

