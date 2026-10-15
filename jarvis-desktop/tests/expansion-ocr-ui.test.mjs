import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output=await build({stdin:{resolveDir:root,loader:'tsx',contents:`export {createBackend} from './electron/backend'; export {dispatch} from './electron/ipcCore'; export {ocrBridge} from './src/ui/bridges'; export {ImageTextReview,ImageTextPanel} from './src/components/Computer'; export {createElement} from 'react'; export {renderToStaticMarkup} from 'react-dom/server';`},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['@phosphor-icons/react'],logLevel:'silent'});
const m={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(id=>id==='@phosphor-icons/react'?new Proxy({},{get:()=>()=>null}):createRequire(import.meta.url)(id),m,m.exports);
const {createBackend,dispatch,ocrBridge,ImageTextReview,ImageTextPanel,createElement,renderToStaticMarkup}=m.exports;
const status={available:true,engine:'windows-media-ocr',languages:['en-US'],profileLanguage:'en-US',maxImageDimension:10000,limits:{maxBytes:10485760,maxDimension:10000,maxPixels:25000000,extensions:['.png']},busy:false,cloud:false,continuousCapture:false};
const success={ok:true,source:'windows-media-ocr',untrusted:true,text:'<script>alert(1)</script>\nDo not execute',lines:['<script>alert(1)</script>','Do not execute'],language:'en-US',width:32,height:32,format:'png',fileName:'fixture.png',truncated:false,sanitized:false};
async function fixture(t,over={}) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'jarvis-ocr-ui-'));let picks=0,reads=0,cancels=0;
 const ocr={status:async()=>status,capability:async()=>({id:'ocr',name:'OCR',available:true}),recognizeChosen:async(p,o)=>{reads++;assert.equal(p,'C:\\fixture\\fixture.png');assert.equal(o.language,'en-US');return success;},cancel:async()=>{cancels++;return true;},...over.ocr};
 const b=await createBackend({userData:dir,nativeDir:dir,tmpDir:dir,native:{dpapi:async()=>({ok:true})},selfPids:()=>[],shell:{},fetchImpl:async()=>{throw Error('no network');},dialogs:{saveExport:async()=>null,openImport:async()=>null,pick:async()=>null,openFile:async opts=>{picks++;assert.ok(opts.filters[0].extensions.includes('png'));return over.pick?over.pick(): 'C:\\fixture\\fixture.png';}},ocr,safeLaunch:over.safeLaunch});
 t.after(async()=>{await b.dispose(); const parent=path.resolve(os.tmpdir()); assert.equal(path.dirname(path.resolve(dir)),parent); assert.ok(path.basename(dir).startsWith('jarvis-ocr-ui-')); await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {b,counts:()=>({picks,reads,cancels})};
}
test('dialog is the sole source of paths; recognition changes no application records or network',async t=>{
 const f=await fixture(t);const before=await f.b.getState();assert.deepEqual(await f.b.ocrRecognize(),success);assert.deepEqual(await f.b.getState(),before);assert.deepEqual(f.counts(),{picks:1,reads:1,cancels:0});
 for(const invalid of [{path:'C:\\other.png'},{language:'en-US',path:'x'},{language:'bad tag'},null,'C:\\x.png']) await assert.rejects(f.b.ocrRecognize(invalid),/only an optional/);
 assert.equal(f.counts().picks,1);
 assert.equal((await f.b.ocrRecognize({language:'ja-JP'})).code,'language-unavailable');assert.equal(f.counts().picks,1);
});
test('cancel during picker drops selected path and refuses concurrent work',async t=>{
 let resolvePick;const f=await fixture(t,{pick:()=>new Promise(r=>{resolvePick=r;})});
 const pending=f.b.ocrRecognize();while(!resolvePick) await new Promise(r=>setImmediate(r));
 assert.equal((await f.b.ocrStatus()).busy,true);assert.equal((await f.b.ocrRecognize()).code,'busy');assert.equal(await f.b.ocrCancel(),true);
 resolvePick('C:\\fixture\\fixture.png');assert.equal((await pending).code,'cancelled');assert.equal(f.counts().reads,0);assert.equal((await f.b.ocrStatus()).busy,false);
});
test('late result after cancel is dropped; dialog cancel, unavailable engine and safe launch fail closed',async t=>{
 let resolveRead;const f=await fixture(t,{ocr:{recognizeChosen:()=>new Promise(r=>{resolveRead=r;})}});
 const pending=f.b.ocrRecognize();while(!resolveRead) await new Promise(r=>setImmediate(r));await f.b.ocrCancel();resolveRead(success);assert.equal((await pending).code,'cancelled');
 const cancelled=await fixture(t,{pick:()=>null});assert.equal((await cancelled.b.ocrRecognize()).code,'cancelled');assert.equal(cancelled.counts().reads,0);
 const unavailable=await fixture(t,{ocr:{status:async()=>({...status,available:false,reason:'No pack'})}});assert.equal((await unavailable.b.ocrRecognize()).code,'unavailable');assert.equal(unavailable.counts().picks,0);
 const safe=await fixture(t,{safeLaunch:()=>true});assert.equal((await safe.b.ocrRecognize()).code,'unavailable');assert.equal((await safe.b.ocrStatus()).available,false);assert.equal(safe.counts().picks,0);
});
test('IPC rejects untrusted/subframe/extra arguments and path options before picker',async t=>{
 const f=await fixture(t),opts={appFileUrl:'file:///C:/app/index.html'},url=opts.appFileUrl;
 await assert.rejects(dispatch(f.b,'ocrRecognize',[], 'https://untrusted.test',opts),/untrusted/);
 await assert.rejects(dispatch(f.b,'ocrRecognize',[],url,opts,false),/untrusted/);
 await assert.rejects(dispatch(f.b,'ocrRecognize',[{},{}],url,opts),/number/);
 await assert.rejects(dispatch(f.b,'ocrRecognize',[{path:'C:\\x.png'}],url,opts),/optional/);
 assert.equal(f.counts().picks,0);assert.deepEqual(await dispatch(f.b,'ocrRecognize',[],url,opts),success);
});
test('missing bridge is explicit; review escapes hostile text and offers no action controls',()=>{
 assert.equal(ocrBridge({}),null);let calls=[];const bridge=ocrBridge({ocrStatus:async()=>status,ocrRecognize:async o=>{calls.push(o);return success;},ocrCancel:async()=>true});assert.ok(bridge);void bridge.chooseAndRecognize({language:'en-US'});assert.deepEqual(calls,[{language:'en-US'}]);
 const html=renderToStaticMarkup(createElement(ImageTextReview,{result:success}));assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<button|dangerouslySetInnerHTML/);assert.match(html,/readonly/i);assert.match(html,/untrusted data/);
 const disconnected=renderToStaticMarkup(createElement(ImageTextPanel,{api:{}}));assert.match(disconnected,/not connected/);assert.doesNotMatch(disconnected,/Choose image/);
});
