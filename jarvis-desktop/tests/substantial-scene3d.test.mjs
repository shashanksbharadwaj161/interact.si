// Original scene model and renderer behavior; fake GL checks resource accounting, not shader compilation.
// Real compilation/pixel/PNG evidence comes from the separate synthetic Electron fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const icons = ['ArrowCounterClockwise','Cube','DownloadSimple','GridFour','Pause','Play','Repeat','SkipBack','UploadSimple','CircleNotch','Info','Warning','WarningCircle'];
const out = await build({stdin:{resolveDir:root,loader:'tsx',contents:`export * from './src/ui/scene3d'; export {Scene3D} from './src/components/Scene3D';`},bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react-dom'],loader:{'.css':'empty'},logLevel:'silent',plugins:[{name:'icons',setup(b){b.onResolve({filter:/^@phosphor-icons\/react$/},()=>({path:'icons',namespace:'icons'}));b.onLoad({filter:/.*/,namespace:'icons'},()=>({contents:icons.map(n=>`export const ${n}=()=>null;`).join('\n')}));}}]});
const mod={exports:{}};new Function('require','module','exports',out.outputFiles[0].text)(require,mod,mod.exports);const s=mod.exports;
const config=(patch={})=>s.normalizeScene(patch);
const near=(a,b,epsilon=1e-7)=>assert.ok(Math.abs(a-b)<epsilon,`${a} versus ${b}`);

test('scene JSON accepts only bounded object data and known version; UTF-8 bytes include leading whitespace',()=>{
  assert.equal(s.parseSceneJson('[]').ok,false);assert.equal(s.parseSceneJson('null').ok,false);assert.equal(s.parseSceneJson('broken').ok,false);
  assert.equal(s.parseSceneJson('{"version":2}').ok,false);
  assert.equal(s.parseSceneJson(' '.repeat(s.MAX_SCENE_BYTES)+'{}').ok,false);
  assert.equal(s.parseSceneJson(JSON.stringify({unknown:'界'.repeat(6000)})).ok,false);
  const r=s.parseSceneJson('{"version":1,"quality":"unknown","objects":{"orbs":999,"particles":999999},"camera":{"distance":-9},"remoteUrl":"https://example.invalid","__proto__":{"polluted":true}}');
  assert.equal(r.ok,true);assert.equal(r.scene.objects.orbs,24);assert.equal(r.scene.objects.particles,4000);assert.equal(r.scene.camera.distance,2);assert.equal(r.scene.quality,'balanced');
  assert.equal('remoteUrl' in r.scene,false);assert.equal({}.polluted,undefined);assert.equal(s.parseSceneJson(s.serializeScene(r.scene)).ok,true);
});
test('quality caps actual object counts, frame rate, DPR and canvas memory',()=>{
  const c=config({quality:'low',objects:{orbs:24,planes:3,particles:4000},limits:{fps:60,dpr:2}});const counts=s.effectiveCounts(c);
  assert.equal(counts.orbs,8);assert.equal(counts.particles,600);assert.equal(counts.planes,3);assert.equal(s.effectiveFps(c),30);assert.equal(s.pickDpr(9,c),1);
  for(const args of [[1e308,1e308,2],[Infinity,NaN,Infinity],[0,-4,-2],[9000,6000,2]]){const size=s.fitCanvas(...args);for(const n of Object.values(size))assert.ok(Number.isFinite(n)&&n>=1&&n<=2048);}
});
test('same configuration, seed and loop phase produce deterministic geometry; seed changes it',()=>{
  const c=config();const a=s.describeFrame(c,3.2);assert.deepEqual(a,s.describeFrame(c,3.2));assert.notDeepEqual(a.orbs,s.describeFrame(config({motion:{seed:43}}),3.2).orbs);
  const start=s.describeFrame(c,0),end=s.describeFrame(c,s.LOOP_SECONDS);assert.deepEqual(start.orbs,end.orbs);assert.deepEqual(start.eye,end.eye);
  assert.equal(s.describeFrame(c,NaN).time,0);assert.deepEqual(s.particleSeeds(20,42),s.particleSeeds(20,42));assert.equal(s.particleSeeds(999999,42).length,16000);
});
test('transport clamps hidden-tab elapsed time, supports pause/seek, loops or stops at end',()=>{
  const p=s.createPlayhead();p.play();near(p.advance(999999).time,.05);p.pause();near(p.advance(1000).time,.05);p.seek(11.99);p.play();assert.equal(p.advance(40).wrapped,true);near(p.time,.03);
  p.setLoop(false);p.seek(11.99);p.play();assert.equal(p.advance(40).stopped,true);assert.equal(p.time,12);assert.equal(p.playing,false);p.play();assert.equal(p.time,0);
  const tiny=s.createPlayhead({loopSeconds:.001,maxStepS:100});tiny.play();tiny.advance(9999);assert.ok(tiny.time>=0&&tiny.time<.001);
  const bad=s.createPlayhead({loopSeconds:Infinity,maxStepS:Infinity});assert.equal(bad.loopSeconds,12);bad.seek(NaN);assert.equal(bad.time,0);
});
test('contact sheets and mesh stay finite and bounded under extreme inputs',()=>{
  for(const opts of [{tiles:999,tileWidth:1e308,aspect:1e-300},{tiles:NaN,tileWidth:Infinity,aspect:Infinity},{}]){const p=s.contactSheetPlan(opts);assert.ok(p.tiles<=16);assert.ok(p.width<=2048&&p.height<=2048);assert.ok(Number.isFinite(p.width)&&Number.isFinite(p.height));assert.equal(p.times.length,p.tiles);assert.ok(p.times.every(t=>t>=0&&t<12));}
  const mesh=s.sphereMesh(999999);assert.ok(mesh.positions.length<10000);assert.ok(mesh.indices.every(i=>i<mesh.positions.length/3));assert.equal(mesh.triangles,mesh.indices.length/3);
});
test('static fallback is labelled and contains no imported markup or nonfinite dimensions',()=>{
  const svg=s.fallbackSvg(config({unknown:'<script>alert(1)</script>'}),NaN,Infinity,NaN);assert.match(svg,/Static scene preview without GPU rendering/);assert.match(svg,/without lighting or particles/);assert.doesNotMatch(svg,/script|https:|NaN|Infinity/);assert.ok(svg.length<30000);
});

function fakeGL({shaderFailure=0,programFailure=0,bufferFailure=0}={}){
  const stats={created:[],deleted:[],draws:[],shaders:0,programs:0,buffers:0,lost:false};let id=0;const constants=new Map();
  const create=(kind)=>{const o={kind,id:++id};stats.created.push(o);return o;};
  const api={createShader:()=>{stats.shaders++;return create('shader');},getShaderParameter:()=>stats.shaders!==shaderFailure,getShaderInfoLog:()=> 'fixture compile error',
    createProgram:()=>{stats.programs++;return create('program');},getProgramParameter:()=>stats.programs!==programFailure,getProgramInfoLog:()=> 'fixture link error',
    createBuffer:()=>{stats.buffers++;return stats.buffers===bufferFailure?null:create('buffer');},createVertexArray:()=>create('vao'),getUniformLocation:()=>({}),
    isContextLost:()=>stats.lost,deleteShader:o=>stats.deleted.push(o),deleteProgram:o=>stats.deleted.push(o),deleteBuffer:o=>stats.deleted.push(o),deleteVertexArray:o=>stats.deleted.push(o),
    drawArrays:(...a)=>stats.draws.push(a),drawArraysInstanced:(...a)=>stats.draws.push(a),drawElementsInstanced:(...a)=>stats.draws.push(a)};
  return {stats,gl:new Proxy(api,{get(t,k){if(k in t)return t[k];if(/^[A-Z_]+$/.test(k)){if(!constants.has(k))constants.set(k,constants.size+1);return constants.get(k);}return()=>{};}})};
}
for(const [label,opts] of [['first fragment',{shaderFailure:2}],['later fragment',{shaderFailure:4}],['link',{programFailure:2}],['allocation',{bufferFailure:3}]])test(`renderer initialization ${label} failure releases every allocated GPU object`,()=>{
  const {gl,stats}=fakeGL(opts);assert.throws(()=>s.createSceneRenderer(gl),s.Scene3DError);assert.equal(stats.deleted.length,stats.created.length);assert.equal(new Set(stats.deleted).size,stats.created.length);
});
test('renderer draws bounded instances, reports context loss and disposes idempotently',()=>{
  const {gl,stats}=fakeGL();const r=s.createSceneRenderer(gl);const result=r.renderAt(config({quality:'low',objects:{orbs:24,planes:3,particles:4000}}),2,999999,NaN);
  assert.equal(result.ok,true);assert.equal(result.orbs,8);assert.equal(result.particles,600);assert.equal(result.width,2048);assert.equal(result.height,1);assert.equal(result.drawCalls,3);
  stats.lost=true;assert.equal(r.renderAt(config(),0,64,64).reason,'context lost');stats.lost=false;r.dispose();const deleted=stats.deleted.length;r.dispose();assert.equal(stats.deleted.length,deleted);assert.equal(r.renderAt(config(),0,64,64).reason,'renderer disposed');assert.equal(stats.deleted.length,stats.created.length);
});
test('reduced-motion UI has named controls, stopped playback and explicit non-video exports',()=>{
  const {createElement}=require('react');const {renderToStaticMarkup}=require('react-dom/server');const html=renderToStaticMarkup(createElement(s.Scene3D,{reducedMotion:true}));
  assert.match(html,/Playback is off/);assert.match(html,/role="img"/);assert.match(html,/Loop time/);assert.match(html,/Export contact sheet \(PNG\)/);assert.match(html,/maxLength="16384"|maxlength="16384"/);assert.doesNotMatch(html,/Export MP4|Export GIF|https:\/\//);
  assert.match(html,/<button[^>]*disabled[^>]*>[\s\S]*?<span>Play<\/span>/);
});
