import test from 'node:test';
import assert from 'node:assert/strict';
import {displayStatus, taskStatusLabel} from '../src/task-status.mjs';

for (const kind of ['budget', 'context']) {
  test(`${kind} stop is blocked, never needs input or review`, () => {
    for (const status of ['awaiting input', 'review', 'failed', 'running']) {
      const task = {status, stopReport: {kind}};
      assert.equal(displayStatus(task), 'blocked');
      assert.equal(taskStatusLabel(task), `Blocked: ${kind}`);
    }
  });
}
test('genuine approvals and clean review remain distinct', () => {
  assert.equal(displayStatus({status: 'awaiting input'}), 'awaiting input');
  assert.equal(taskStatusLabel({status: 'awaiting input'}), 'Needs input');
  assert.equal(taskStatusLabel({status: 'review', stopReport: null}), 'Ready for review');
  assert.equal(displayStatus({status: 'failed', stopReport: {kind: 'worker-error'}}), 'failed');
});
test('completed and cancelled tasks are not relabelled by old stop reports', () => {
  for (const status of ['complete', 'cancelled']) {
    assert.equal(displayStatus({status, stopReport: {kind: 'budget'}}), status);
  }
});
