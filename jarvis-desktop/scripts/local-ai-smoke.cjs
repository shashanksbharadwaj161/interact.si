// Real loopback inference, isolated application data; no cloud API or desktop input.
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'companion-local-ai-')));
const deadline=setTimeout(()=>{console.error('LOCAL_AI_SMOKE_TIMEOUT');app.exit(1)},120000);
require('../dist-electron/main.cjs');
app.whenReady().then(async()=>{
 let win;for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading())break;await new Promise(r=>setTimeout(r,200));}
 if(!win)throw Error('Window missing');
 const started=Date.now();const result=await win.webContents.executeJavaScript(`(async()=>{const a=window.jarvis;await a.saveSettings({mode:'offline',localEndpoint:'http://127.0.0.1:11435',localModel:'qwen3.5:2b'});const reply=await a.chat('Answer only this arithmetic: 7 + 5. Keep your answer short.');if(reply.source!=='local'||!reply.text.includes('12'))throw Error('Actual local inference failed: '+reply.text);return {source:reply.source,reply:reply.text,cloudKeyConfigured:(await a.cloudKeyStatus()).configured};})()`);
 console.log('LOCAL_AI_SMOKE_PASS',JSON.stringify({...result,elapsedMs:Date.now()-started}));clearTimeout(deadline);app.exit(0);
}).catch(e=>{console.error(e.message);clearTimeout(deadline);app.exit(1)});
