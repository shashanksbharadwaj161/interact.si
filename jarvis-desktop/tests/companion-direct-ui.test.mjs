import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const built=await build({stdin:{contents:`export {Command,AnswerView} from './src/companion/surfaces';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',logLevel:'silent',loader:{'.css':'empty'},banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(new URL('../package.json',import.meta.url).href)});`}});
const m=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const nop=()=>{};
const base={status:{readiness:{ready:false,reason:'AI requests are off'}},text:'Reviewed draft',setText:nop,region:null,note:null,options:null,showOptions:false,onToggleOptions:nop,onAsk:nop,onInsert:nop,onRegion:nop,onRemoveRegion:nop,onHub:nop,onClose:nop,target:{process:'notepad.exe',title:'Sample document'}};
const command=p=>m.renderToStaticMarkup(m.createElement(m.Command,{...base,...p}));
test('offline composer permits reviewing and inserting text while Ask remains disabled',()=>{
  const html=command({});assert.match(html,/>Type into notepad<\/button>/);assert.match(html,/No AI request/);
  assert.doesNotMatch(html,/<textarea[^>]*disabled/);assert.match(html,/<button[^>]*disabled[^>]*>Ask<\/button>/);
  assert.doesNotMatch(html,/<button[^>]*disabled[^>]*>Type into/);
});
test('direct insertion requires a target and nonempty text, and is blocked while recording/transcribing',()=>{
  assert.doesNotMatch(command({target:null}),/>Type into/);
  assert.match(command({text:'  '}),/<button[^>]*disabled[^>]*>Type into/);
  assert.match(command({inputBusy:true}),/<textarea[^>]*disabled/);
  assert.match(command({inputBusy:true}),/<button[^>]*disabled[^>]*>Type into/);
});
test('a local action receipt never claims a Claude call',()=>{
  const html=m.renderToStaticMarkup(m.createElement(m.AnswerView,{answer:{type:'answer',text:'Typed 4 characters. Not read back.',citations:[],steps:0},steps:[],undone:{},onUndo:nop,onOpen:nop,onFollow:nop,onDone:nop}));
  assert.match(html,/Action result/);assert.match(html,/On this computer · no AI request/);assert.doesNotMatch(html,/Claude · 0/);
});
