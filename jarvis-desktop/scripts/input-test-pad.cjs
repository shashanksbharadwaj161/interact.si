// Disposable local target for manual computer-use verification. No files/accounts/network/API and no IPC bridge.
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'desktop-companion-input-pad-')));
app.whenReady().then(()=>{
  const w=new BrowserWindow({title:'Companion input test pad',width:760,height:490,x:80,y:120,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  w.webContents.on('will-navigate',e=>e.preventDefault());
  w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Companion input test pad</title><style>body{background:#121827;color:#eef2ff;font:17px Segoe UI;padding:32px}h1{font-size:25px}p{color:#b4c4df}textarea{box-sizing:border-box;width:100%;height:220px;border:1px solid #819ec2;border-radius:14px;background:#080e1b;color:#eef2ff;padding:20px;font:20px Segoe UI}</style></head><body><h1>Companion input test pad</h1><p>Disposable local document. No account, network or save operation.</p><label for="draft">Reviewed text lands here</label><textarea id="draft" aria-label="Reviewed text lands here" placeholder="Click here, then invoke the companion."></textarea><p>Verification target only. Nothing typed here is sent or saved.</p></body></html>`));
  w.on('closed',()=>app.quit());
});
