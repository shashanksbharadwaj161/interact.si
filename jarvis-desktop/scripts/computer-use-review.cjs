// Manual Windows journey launcher. Real production main/preload/renderer, isolated offline profile, NO auto-approval.
// Run with the installed Electron CLI. Close via this process after review; no personal profile/key is used.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const root=path.join(__dirname,'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-companion-review-'));
app.setPath('userData',profile);delete process.env.JARVIS_TEST_MODE;
const evidenceArg=process.argv.find(a=>a.startsWith('--out='));
const out=evidenceArg?path.resolve(root,evidenceArg.slice(6)):path.join(root,'../planning/ui-revamp/computer-use-2026-10-19');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'review-process.json'),JSON.stringify({pid:process.pid,isolatedProfile:true,autoApproval:false,liveProvider:false},null,2));
require(path.join(root,'dist-electron/main.cjs'));
const timer=setTimeout(async()=>{for(const w of BrowserWindow.getAllWindows()){if(!w.isDestroyed()&&!w.webContents.isLoading())try{const name=/companion\.html$/.test(w.webContents.getURL())?'island':'hub';fs.writeFileSync(path.join(out,`last-${name}.png`),(await w.webContents.capturePage()).toPNG());}catch{}}app.exit();},15*60*1000);timer.unref();
