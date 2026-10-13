import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const out = await build({stdin: {contents: `export {createBackend} from './electron/backend'; export {ActionService,resolveExecutable} from './electron/services/actions'; export {restoreCapsule} from './electron/services/capsules'; export {DEFAULT_SETTINGS} from './electron/services/validation';`, resolveDir: process.cwd(), loader: 'ts'}, bundle:true, write:false, platform:'node', format:'cjs'});
const mod = {exports:{}};
new Function('require','module','exports',out.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {createBackend,ActionService,restoreCapsule,DEFAULT_SETTINGS,resolveExecutable}=mod.exports;
const win={hwnd:12,pid:23,process:'notepad.exe',title:'Note',x:0,y:0,width:500,height:500,foreground:true,minimized:false,maximized:false,elevated:0};
function fixture(confirm) {
 let calls=0, id=0, exe='C:\\Windows\\notepad.exe';
 const native={listWindows:async()=>[win],focusWindow:async()=>({focused:true}),typeText:async()=>{calls++;return {typed:1};},moveWindow:async()=>{calls++;return {};},dpapi:async()=>({ok:true})};
 const shell={spawnApp:async()=>{calls++;},openPath:async()=>{calls++;return '';},openExternal:async()=>{calls++;}};
 const actions=new ActionService({settings:()=>({...DEFAULT_SETTINGS,approvedApps:['notepad.exe']}),native,shell,activity:async()=>{},selfPids:()=>[],safeLaunch:()=>false,newId:()=>String(++id),resolveExecutable:async()=>exe,confirm});
 return {actions,native,shell,calls:()=>calls,setExe:(p)=>exe=p};
}
test('renderer approval cannot bypass missing or declined native confirmation',async()=>{
 for(const confirm of [undefined,async()=>false]) {
  const f=fixture(confirm); const p=await f.actions.preview({type:'launch',target:'notepad.exe'});
  assert.equal((await f.actions.execute(p.id,true)).executed,false);assert.equal(f.calls(),0);
  await assert.rejects(f.actions.execute(p.id,true),/already used/);
 }
});
test('native dialog sees full typed text and resolved path; changed path refused after dialog',async()=>{
 let detail=''; const f=fixture(async(_s,d)=>{detail=d;return true;});
 let p=await f.actions.preview({type:'type-text',target:'hwnd:12',text:'secret-looking test\ntext\tfull'});
 assert.match(p.summary,/test⏎text⇥full/);
 assert.equal((await f.actions.execute(p.id,true)).executed,true);assert.match(detail,/test⏎\ntext⇥full/);
 p=await f.actions.preview({type:'launch',target:'notepad.exe'});assert.match(p.summary,/C:\\Windows\\notepad.exe/);
 f.setExe('C:\\Windows\\different.exe');assert.equal((await f.actions.execute(p.id,true)).executed,false);assert.equal(f.calls(),1);
});
test('newline input into terminals denied before confirmation',async()=>{
 const f=fixture(async()=>{throw Error('must not confirm');});
 f.native.listWindows=async()=>[{...win,process:'pwsh.exe'}];
 const p=await f.actions.preview({type:'type-text',text:'run-command\n'});assert.equal(p.allowed,false);
});
test('background target preview sends no input; execution focuses only approved identity and refuses failed focus',async()=>{
 const f=fixture(async()=>true);let foreground=false,focused=0;
 f.native.listWindows=async()=>[{...win,foreground}];
 f.native.focusWindow=async target=>{assert.deepEqual(target,{hwnd:12,pid:23});focused++;foreground=true;return {focused:true};};
 const p=await f.actions.preview({type:'type-text',target:'hwnd:12',text:'hello'});
 assert.equal(p.allowed,true);assert.equal(focused,0);assert.equal(f.calls(),0);
 assert.equal((await f.actions.execute(p.id,true)).executed,true);assert.equal(focused,1);assert.equal(f.calls(),1);
 foreground=false;f.native.focusWindow=async()=>({focused:false});
 const p2=await f.actions.preview({type:'type-text',target:'hwnd:12',text:'hello'});
 assert.equal((await f.actions.execute(p2.id,true)).executed,false);assert.equal(f.calls(),1);
});
test('bare executable lookup ignores user PATH entries',async()=>{
 const touched=[]; const found=await resolveExecutable('tool.exe',{SystemRoot:'C:\\Windows',PATH:'C:\\Writable'},{stat:async p=>{touched.push(p);return {isFile:()=>p==='C:\\Writable\\tool.exe'};}});
 assert.equal(found,null);assert.ok(touched.every(p=>!p.includes('Writable')));
});
test('capsule decline and safe launch never open or move anything; single full-target confirmation',async()=>{
 const f=fixture(async()=>true); const capsule={id:'c',name:'Test',items:[{kind:'app',target:'notepad.exe'}],windows:[{process:'notepad.exe',title:'Note',x:1,y:2,width:100,height:100}]};
 let shown=''; const deps={state:()=>({capsules:[capsule]}),actions:f.actions,native:f.native,selfPids:()=>[],activity:async()=>{},confirm:async(_s,d)=>{shown=d;return false;}};
 const r=await restoreCapsule(deps,'c');assert.equal(r.opened.length,0);assert.equal(f.calls(),0);assert.match(shown,/C:\\\\Windows/);assert.match(shown,/Move window/);
 deps.safeLaunch=()=>true;deps.confirm=async()=>{throw Error('should not show');};await restoreCapsule(deps,'c');assert.equal(f.calls(),0);
});
test('capsule launches share limiter, and safe launch enabled during confirmation prevents all actions',async()=>{
 const f=fixture(async()=>true);
 const capsule={id:'c',name:'Burst',items:Array.from({length:35},()=>({kind:'app',target:'notepad.exe'})),windows:[]};
 const deps={state:()=>({capsules:[capsule]}),actions:f.actions,native:f.native,selfPids:()=>[],activity:async()=>{},confirm:async()=>true};
 const r=await restoreCapsule(deps,'c');assert.equal(r.opened.length,30);assert.equal(r.failed.length,5);assert.equal(f.calls(),30);
 let safe=false;const f2=fixture(async()=>true);deps.actions=f2.actions;deps.native=f2.native;deps.safeLaunch=()=>safe;deps.confirm=async()=>{safe=true;return true;};
 const stopped=await restoreCapsule(deps,'c');assert.equal(stopped.opened.length,0);assert.equal(f2.calls(),0);
});
test('refused foreground focus prevents typed input even after native approval',async()=>{
 const f=fixture(async()=>true);f.native.focusWindow=async()=>({focused:false});
 const p=await f.actions.preview({type:'type-text',target:'hwnd:12',text:'test'});
 const r=await f.actions.execute(p.id,true);assert.equal(r.executed,false);assert.equal(f.calls(),0);
});
test('settings decline leaves state unchanged; import retains permissions and forces offline',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'companion-approval-'));
 const f=fixture(async()=>false); let importFile=null;
 const b=await createBackend({userData:dir,nativeDir:dir,tmpDir:dir,native:f.native,shell:f.shell,selfPids:()=>[],confirm:async()=>false,dialogs:{openImport:async()=>importFile,pick:async()=>null,saveExport:async()=>null}});
 try {
  await assert.rejects(b.saveSettings({mode:'online',approvedApps:['notepad.exe']}),/Native confirmation/);
  assert.equal((await b.getState()).settings.mode,'offline');assert.deepEqual((await b.getState()).settings.approvedApps,[]);
  const doc=JSON.parse(b.store.exportDocument());doc.state.settings.mode='online';doc.state.settings.approvedApps=['notepad.exe'];doc.state.settings.localEndpoint='http://127.0.0.1:9999';
  importFile=path.join(dir,'import.json');await writeFile(importFile,JSON.stringify(doc));
  const state=await b.importData();assert.equal(state.settings.mode,'offline');assert.deepEqual(state.settings.approvedApps,[]);assert.equal(state.settings.localEndpoint,DEFAULT_SETTINGS.localEndpoint);
 } finally {await b.dispose();await rm(dir,{recursive:true,force:true});}
});
