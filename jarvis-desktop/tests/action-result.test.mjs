import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../src/ui/action-result.ts',import.meta.url));
const out=await build({entryPoints:[source],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {actionOutcome,listedWindows,buildAction}=await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const form=(type,fields={})=>({type,target:'',text:'',x:'',y:'',width:'',height:'',...fields});

test('native refusals never become successful outcomes merely because IPC resolved',()=>{
  for(const reason of ['Not approved','Rate limit reached','The approved window no longer exists','Native confirmation declined']){
    assert.deepEqual(actionOutcome({executed:false,reason},true),{kind:'not-run',message:reason});
  }
  const success={executed:true,typed:12};
  assert.deepEqual(actionOutcome(success,true),{kind:'ran',value:success});
  assert.equal(actionOutcome(undefined,true).kind,'unconfirmed');
  assert.equal(actionOutcome({executed:'true'},true).kind,'unconfirmed');
});
test('user rejection takes precedence over any contradictory result payload',()=>{
  assert.equal(actionOutcome({executed:true},false).kind,'rejected');
  assert.match(actionOutcome(null,false).message,/You rejected/);
});
test('window results are read from the executed envelope and keep selection identity and protection',()=>{
  const rows=listedWindows({executed:true,windows:[{hwnd:72,title:'Notes',process:'notepad',width:800,height:600,x:-10,y:20,protected:false},{hwnd:81,title:'Admin',process:'pwsh',protected:true}]});
  assert.equal(rows.length,2);assert.equal(rows[0].hwnd,'72');assert.equal(rows[0].width,800);assert.equal(rows[0].x,-10);assert.equal(rows[1].protected,true);
  assert.deepEqual(listedWindows({executed:true,windows:[]}),[]);
  assert.equal(listedWindows({executed:false,windows:[{hwnd:72}]}),null);
  assert.equal(listedWindows([{hwnd:72}]),null);
  const malformed=listedWindows({executed:true,windows:[null,{hwnd:-1,width:Infinity},{hwnd:'hwnd:1'},{hwnd:'123'}]});
  assert.equal(malformed.length,3);assert.equal(malformed[0].hwnd,null);assert.equal(malformed[0].width,null);assert.equal(malformed[1].hwnd,null);assert.equal(malformed[2].hwnd,'123');
});
test('typing and clicks require an explicit window and preserve complete approval text',()=>{
  assert.ok(buildAction(form('type-text',{text:'hello'})).errors.target);
  assert.ok(buildAction(form('click',{x:'10',y:'20'})).errors.target);
  const text='x'.repeat(1997)+'\n\tZ';
  const built=buildAction(form('type-text',{target:'hwnd:72',text}));
  assert.equal(built.action.text,text);assert.equal(built.action.text.length,2000);assert.equal(built.action.target,'hwnd:72');
  assert.ok(buildAction(form('type-text',{target:'hwnd:72',text:text+'x'})).errors.text);
  assert.ok(buildAction(form('click',{target:'hwnd:72',x:'3.5',y:'2'})).errors.x);
  assert.deepEqual(buildAction(form('list-windows')).action,{type:'list-windows'});
});
