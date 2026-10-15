// Runs only inside Electron, in a temporary user-data directory. No real desktop actions: JARVIS_TEST_MODE is honoured by the app
// only for a jarvis-smoke-* folder directly inside the OS temp directory, which is exactly what is created here.
const {app,BrowserWindow,session}=require('electron');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-smoke-'));app.setPath('userData',data);process.env.JARVIS_TEST_MODE='1';
const timeout=setTimeout(()=>{console.error('Electron smoke timed out');app.exit(1);},120000);
const finish=(code)=>{clearTimeout(timeout);try{fs.rmSync(data,{recursive:true,force:true});}catch{}app.exit(code);};
// Every request that completed or failed, to prove nothing left the machine (file:, data: and blob: are local).
const seen=[];const record=(d)=>seen.push(d.url);
const packaged=process.argv.includes('--packaged');
const smokeRoot=packaged?path.join(__dirname,'..','release','win-unpacked','resources','app.asar'):path.join(__dirname,'..');
require(path.join(smokeRoot,'dist-electron','main.cjs'));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onCompleted(record);session.defaultSession.webRequest.onErrorOccurred(record);
 let win;for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading())break;await new Promise(r=>setTimeout(r,200));}if(!win)throw new Error('Window missing');
 // Renderer errors are collected for the whole run; any error-level console message fails the route sweep.
 const rendererErrors=[];win.webContents.on('console-message',(e,level,message)=>{const lv=e&&e.level!==undefined?e.level:level;const msg=e&&e.message!==undefined?e.message:message;if(lv==='error'||lv===3)rendererErrors.push(String(msg).slice(0,200));});
 win.webContents.on('render-process-gone',(_e,d)=>rendererErrors.push('renderer gone: '+d.reason));
 // Window hardening (B1) and navigation/window-open denial (B3).
 const wp=win.webContents.getLastWebPreferences();
 if(!(wp.contextIsolation&&wp.sandbox&&wp.webSecurity&&!wp.nodeIntegration))throw new Error('Window is not hardened: '+JSON.stringify({contextIsolation:wp.contextIsolation,sandbox:wp.sandbox,webSecurity:wp.webSecurity,nodeIntegration:wp.nodeIntegration}));
 const appUrl=win.webContents.getURL();
 const opened=await win.webContents.executeJavaScript(`window.open('https://example.com')===null`);if(!opened)throw new Error('window.open was not denied');
 await win.webContents.executeJavaScript(`setTimeout(()=>{location.href='https://example.com/'},0)`);await new Promise(r=>setTimeout(r,800));
 if(win.webContents.getURL()!==appUrl)throw new Error('Navigation away from the app was not blocked: '+win.webContents.getURL());
 // Helper integrity: the embedded build manifest must describe the scripts that ship next to the bundle.
 const nativeDir=path.join(smokeRoot,'native');const manifest=JSON.parse(fs.readFileSync(path.join(smokeRoot,'dist-electron','native-manifest.json'),'utf8'));
 for(const [name,digest] of Object.entries(manifest.files)){const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(nativeDir,name))).digest('hex');if(actual!==digest)throw new Error('Helper integrity manifest is stale for '+name+'; rebuild');}
 const result=await win.webContents.executeJavaScript(`(async()=>{const a=window.jarvis;if(!a)throw Error('Preload bridge missing');const s=await a.getState();if(s.settings.mode!=='offline')throw Error('Must default offline');await a.saveNote({title:'Smoke note',body:'Local test',tags:['smoke']});await a.saveTask({title:'Smoke task'});const c=await a.saveCapsule({name:'Smoke capsule',description:'empty safe capsule',scene:'graphite',items:[]});const after=await a.getState();if(!after.notes.some(n=>n.title==='Smoke note')||!after.tasks.some(t=>t.title==='Smoke task')||!after.capsules.some(c=>c.name==='Smoke capsule'))throw Error('CRUD persistence failed');const cap=after.capsules.find(c=>c.name==='Smoke capsule');const restored=await a.restoreCapsule(cap.id);const k=await a.cloudKeyStatus();const info=await a.getSystemInfo();return {mode:after.settings.mode,notes:after.notes.length,tasks:after.tasks.length,capsules:after.capsules.length,keyConfigured:k.configured,capabilities:info.capabilities,restore:restored};})()`);
 // Finish onboarding through the same bridge the UI uses (mode stays offline), then reload into the main shell.
 await win.webContents.executeJavaScript(`(async()=>{const s=await window.jarvis.getState();await window.jarvis.saveSettings({...s.settings,onboarded:true});})()`);
 await new Promise((r)=>{win.webContents.once('did-finish-load',r);win.webContents.reload();});await new Promise(r=>setTimeout(r,1200));
 // Route sweep: every navigation entry the shell renders must mount a non-empty main region without renderer errors.
 const routes=await win.webContents.executeJavaScript(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));const links=[...document.querySelectorAll('nav a[href^="#"]')].map(a=>a.getAttribute('href')).filter((h,i,all)=>h.length>2&&all.indexOf(h)===i);const out=[];for(const h of links){location.hash=h.slice(1);await wait(450);const m=document.getElementById('main');const text=m?m.innerText.trim():'';out.push({route:h,label:m?m.getAttribute('aria-label'):null,chars:text.length,current:!!document.querySelector('nav a[aria-current="page"][href="'+h+'"]')});}location.hash='';await wait(200);return out;})()`);
 if(routes.length<10)throw new Error('Route sweep found too few navigation links: '+routes.length);
 const broken=routes.filter((r)=>!r.label||r.chars<20||!r.current);if(broken.length)throw new Error('Route(s) did not render: '+JSON.stringify(broken.slice(0,4)));
 // Optional owned-fixture review: --shots=<dir> shows this smoke window without focus (hidden windows pause CSS entrance
 // animations) and saves PNGs of this app window only, never the desktop, for every route.
 const shotsArg=process.argv.find((a)=>a.startsWith('--shots='));let shots=0;
 if(shotsArg){const dir=path.resolve(shotsArg.slice(8));fs.mkdirSync(dir,{recursive:true});win.setSize(1280,820);win.showInactive();await new Promise(r=>setTimeout(r,500));for(const h of routes.map((r)=>r.route)){await win.webContents.executeJavaScript(`location.hash=${JSON.stringify(h.slice(1))}`);await new Promise(r=>setTimeout(r,700));const img=await win.webContents.capturePage();fs.writeFileSync(path.join(dir,(packaged?'packaged-':'')+h.replace(/[^a-z0-9]+/gi,'_').replace(/^_+/,'')+'.png'),img.toPNG());shots++;}win.hide();await win.webContents.executeJavaScript(`location.hash=''`);}
 if(rendererErrors.length)throw new Error('Renderer console errors: '+rendererErrors.slice(0,3).join(' | '));
 const external=seen.filter((u)=>!/^(file|data|blob|devtools):/i.test(u));
 if(external.length)throw new Error('Unexpected non-local request(s): '+external.slice(0,3).join(', '));
 const metrics=app.getAppMetrics();const footprint={processes:metrics.length,workingSetMb:Math.round(metrics.reduce((n,m)=>n+(m.memory?.workingSetSize??0),0)/1024)};
 console.log('ELECTRON_SMOKE_PASS',JSON.stringify({...result,routes:routes.map((r)=>r.route),rendererErrors:rendererErrors.length,hardened:true,navigationBlocked:true,helperManifestFiles:Object.keys(manifest.files).length,externalRequests:external.length,shots,footprint}));finish(0);
}).catch(e=>{console.error(e.message);finish(1);});
