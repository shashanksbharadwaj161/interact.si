import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDecision} from '../server/loop.mjs';
const task={role:'first',model:'claude-opus-5-5',goalIds:['1'],files:['src/first.ts'],instructions:'Implement a bounded slice'};
const decision=tasks=>({version:1,observationId:'obs',action:'dispatch',reason:'Complete existing gaps',tasks});
test('planner receives actionable URL and instruction size feedback without relaxing validation',()=>{
 assert.throws(()=>validateDecision(decision([{...task,instructions:'Use https://example.invalid'}]),'obs'),/must omit URLs/);
 assert.throws(()=>validateDecision(decision([{...task,instructions:'x'.repeat(9001)}]),'obs'),/exceed 9000/);
 assert.deepEqual(validateDecision(decision([task]),'obs'),decision([task]));
});
test('planner feedback identifies conflicting shared file ownership',()=>{
 assert.throws(()=>validateDecision(decision([task,{...task,role:'second'}]),'obs'),/ownership overlaps: src\/first.ts/);
});
