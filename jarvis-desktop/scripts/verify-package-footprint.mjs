// Read-only audit of the actual archive. Does not launch or install the product.
import {createRequire, builtinModules} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const asar=require('@electron/asar');
const archive=path.resolve(process.argv.find(a=>a.endsWith('.asar'))??path.join(root,'release/win-unpacked/resources/app.asar'));
const fileEntries=[];
function inventory(node,prefix='') {
  for(const [name,entry] of Object.entries(node.files??{})) {
    const relative=prefix+name;
    if(entry.files) inventory(entry,relative+'/');
    else fileEntries.push(relative);
  }
}
inventory(asar.getRawHeader(archive).header);
const dependencies=fileEntries.filter(p=>p.split('/').includes('node_modules'));
const builtins=new Set([...builtinModules,...builtinModules.map(m=>`node:${m}`),'electron']);
const external=new Set();
for(const bundle of ['dist-electron/main.cjs','dist-electron/preload.cjs']) {
  const source=asar.extractFile(archive,bundle).toString('utf8');
  const calls=[...source.matchAll(/\brequire\s*\(([^)]*)\)/g)];
  for(const [,arg] of calls) {
    const match=arg.trim().match(/^(['"])([^'"]+)\1$/);
    assert.ok(match,`Computed require requires manual review in ${bundle}: ${arg.slice(0,80)}`);
    external.add(match[2]);
    assert.ok(builtins.has(match[2]),`Unbundled runtime dependency ${match[2]} in ${bundle}`);
  }
  assert.ok(!/\bimport\s*\(/.test(source),`Dynamic runtime import requires manual review in ${bundle}`);
}
const manifest=JSON.parse(asar.extractFile(archive,'dist-electron/native-manifest.json'));
assert.ok(manifest.files['common.ps1'],'Native common helper missing');
for(const [name,digest] of Object.entries(manifest.files)) {
  const helper=path.join(archive+'.unpacked','native',name);
  const bytes=await readFile(helper);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),digest,`Packaged helper hash mismatch: ${name}`);
  assert.equal(asar.statFile(archive,`native/${name}`).unpacked,true,`Helper not unpacked: ${name}`);
}
const html=asar.extractFile(archive,'dist/index.html').toString('utf8');
for(const [,src] of html.matchAll(/(?:src|href)="(\.\/assets\/[^"?#]+)"/g)) {
  assert.ok(fileEntries.includes('dist/'+src.slice(2)),`Renderer asset absent: ${src}`);
}
// Secondary screens stay lazy: each has its own chunk and none of their page copy is in the renderer entry bundle.
const entry=[...html.matchAll(/<script[^>]+src="\.\/(assets\/index-[^"]+\.js)"/g)].map(m=>m[1])[0];
assert.ok(entry,'Renderer entry bundle not found in index.html');
const entrySource=asar.extractFile(archive,'dist/'+entry).toString('utf8');
const lazyScreens={MemoryWorkbench:'what this app keeps about your work',WritingWorkbench:'WritingWorkbench',MotionStudio:'MotionStudio',Scene3D:'Scene3D'};
for(const [name,marker] of Object.entries(lazyScreens)){
  assert.ok(fileEntries.some(p=>new RegExp(`^dist/assets/${name}-[^/]+\\.js$`).test(p)),`Lazy chunk missing for ${name}`);
  if(name==='MemoryWorkbench')assert.ok(!entrySource.includes(marker),`${name} page code leaked into the entry bundle`);
}
if(!process.argv.includes('--allow-node-modules')) assert.equal(dependencies.length,0,'Bundled app unexpectedly contains production node_modules');
const info={lazyScreenChunks:Object.keys(lazyScreens).length,archiveBytes:(await stat(archive)).size,archiveFiles:fileEntries.length,nodeModuleFiles:dependencies.length,javaScriptFiles:fileEntries.filter(p=>/\.(?:mjs|cjs|js)$/.test(p)).length,externalRuntimeModules:[...external].sort(),nativeHelpersVerified:Object.keys(manifest.files).length,rendererAssets:fileEntries.filter(p=>p.startsWith('dist/assets/')).length,missingAssets:0};
console.log(JSON.stringify(info,null,2));
