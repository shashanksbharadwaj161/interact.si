import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Budget} from '../server/budget.mjs';
test('restart preserves charges and raises a legacy buffer to thirty dollars',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'room-buffer-'));
 try{
  await writeFile(path.join(dir,'spending.json'),JSON.stringify({limit:300,safety:10,requests:[{id:'old',taskId:'old',model:'claude-opus-5-5',charge:269.9,reserved:269.9,settled:false}]}));
  const b=new Budget(dir);await b.init();
  assert.equal(b.snapshot().safety,30);assert.equal(b.total(),269.9);
  assert.equal(b.snapshot().uncertain,1);
  await assert.rejects(b.reserve({id:'new',budget:10},'claude-opus-5-5',10000,1000),/reservation denied/);
  assert.equal(b.total(),269.9);
 }finally{await rm(dir,{recursive:true,force:true});}
});
