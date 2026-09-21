import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approveAll, approveReady, approveWithDependencies, blockedActions, blockedReason, dependents,
  dependencyClosure, executionOrder, isReady, readyActions, setApproved, unapprove, validatePlan,
} from '../dist/actions.js';

const action = (id, extra = {}) => ({
  id, operation: 'move', title: id, afterPath: `out/${id}`, pairs: [], dependsOn: [], preselected: true, approved: false, ...extra,
});
const plan = (...actions) => ({ actions, skipped: [] });
// mkdir falas -> move into it -> rename the moved file: the canonical dependency chain.
const chain = () => plan(
  action('A1', { operation: 'mkdir', afterPath: 'falas' }),
  action('A2', { dependsOn: ['A1'] }),
  action('A3', { operation: 'rename', dependsOn: ['A2'] }),
);

test('an approved child with an unapproved parent is blocked, not silently retargeted', () => {
  const p = setApproved(chain(), 'A3', true);
  assert.equal(isReady(p, p.actions[2]), false);
  assert.equal(blockedReason(p, p.actions[2]), 'requires A2');
  assert.deepEqual(blockedActions(p).map(a => a.id), ['A3']);
  assert.deepEqual(readyActions(p).map(a => a.id), []);
});

test('approving prerequisites closes the whole chain', () => {
  const p = approveWithDependencies(chain(), 'A3');
  assert.deepEqual(p.actions.map(a => a.approved), [true, true, true]);
  assert.deepEqual(executionOrder(p).map(a => a.id), ['A1', 'A2', 'A3']);
});

test('dependencyClosure lists only unmet prerequisites', () => {
  const half = setApproved(chain(), 'A1', true);
  assert.deepEqual(dependencyClosure(half, 'A3'), ['A2']);
  assert.deepEqual(dependencyClosure(half, 'A1'), []);
});

test('unchecking a prerequisite keeps dependents blocked instead of rebasing them', () => {
  const p = unapprove(approveWithDependencies(chain(), 'A3'), 'A1', 'keep-blocked');
  assert.deepEqual(p.actions.map(a => a.approved), [false, true, true]);
  assert.equal(blockedReason(p, p.actions[1]), 'requires A1');
  assert.match(blockedReason(p, p.actions[2]) ?? '', /A2 is blocked \(requires A1\)/);
  assert.deepEqual(blockedActions(p).map(a => a.id), ['A2', 'A3']);
  assert.deepEqual(executionOrder(p), []);
});

test('unchecking with dependents clears the dependent approvals too', () => {
  const p = unapprove(approveWithDependencies(chain(), 'A3'), 'A1', 'unapprove');
  assert.deepEqual(p.actions.map(a => a.approved), [false, false, false]);
});

test('dependents are transitive', () => {
  assert.deepEqual(dependents(chain(), 'A1'), ['A2', 'A3']);
  assert.deepEqual(dependents(chain(), 'A3'), []);
});

test('exclusive options behave like radio buttons', () => {
  const p = plan(
    action('M1', { exclusiveGroup: 'dest' }),
    action('M2', { exclusiveGroup: 'dest' }),
  );
  const first = setApproved(p, 'M1', true);
  const second = setApproved(first, 'M2', true);
  assert.deepEqual(second.actions.map(a => a.approved), [false, true]);
  assert.deepEqual(validatePlan(second), []);
});

test('batch approve takes every runnable row and never loops on exclusives', () => {
  const p = approveReady(plan(
    action('A1', { operation: 'mkdir', afterPath: 'falas' }),
    action('A2', { dependsOn: ['A1'] }),
    action('B1', { exclusiveGroup: 'dest' }),
    action('B2', { exclusiveGroup: 'dest' }),
    action('C1', { blocked: 'destination collision: falas/C1' }),
  ));
  assert.deepEqual(p.actions.map(a => a.approved), [true, true, true, false, false]);
  assert.deepEqual(readyActions(p).map(a => a.id), ['A1', 'A2', 'B1']);
  assert.deepEqual(blockedActions(p).map(a => a.id), []);
});

test('a locally blocked row stays unapproved even on approve-all', () => {
  const p = approveAll(plan(action('A1'), action('A2', { blocked: 'source changed' })));
  assert.deepEqual(p.actions.map(a => a.approved), [true, false]);
  assert.equal(blockedReason(p, p.actions[1]), 'source changed');
});

test('executionOrder refuses a dependency cycle rather than guessing', () => {
  const p = approveAll(plan(action('A1', { dependsOn: ['A2'] }), action('A2', { dependsOn: ['A1'] })));
  assert.throws(() => executionOrder(p), /dependency cycle/);
});

test('validatePlan reports structural problems', () => {
  assert.deepEqual(validatePlan(chain()), []);
  const problems = validatePlan(plan(
    action('A1'),
    action('A1'),
    action('A2', { dependsOn: ['nope'] }),
  ));
  assert.ok(problems.some(p => p.includes('duplicate action id: A1')));
  assert.ok(problems.some(p => p.includes('depends on unknown nope')));
});

test('an unknown action id throws instead of being ignored', () => {
  assert.throws(() => setApproved(chain(), 'nope', true), /Unknown action/);
});
