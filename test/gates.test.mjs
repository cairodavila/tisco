import test from 'node:test';
import assert from 'node:assert/strict';
import { admitted, all, always, any, after, gateInputs, gateReason, gateSatisfied, never, questions, report } from '../dist/gates.js';
import { clipSpecs, modeFromRoute, referenceFromRoute, routeSpecs, scopeFromRoute, workspaceDecisions, workspaceQuestionBatch } from '../dist/decisions.js';
import { workspaceSnapshot } from '../dist/workspace-state.js';

const noul = (id, noul, gate = always, extra = {}) => ({ id, tier: extra.tier ?? 1, gate, question: { type: 'noul', instructions: id, criteria: { true: 'yes', false: 'no' } }, consumes: [], unlocks: [], ...extra });
const choice = (id, options, gate = always) => ({ id, tier: 0, gate, question: { type: 'choice', instructions: id, criteria: Object.fromEntries(options.map(o => [o, o])) }, consumes: [], unlocks: [] });
const a = (id, value) => ({ [id]: { type: 'noul', noul: value } });
const pick = (id, value) => ({ [id]: { type: 'choice', choice: value, probabilities: { [value]: 1 }, confidence: 1 } });

const rule = (extra = []) => ({ request: 'Keep the prepared lines.', context: 'Food brand', mode: 'scripted', destination: 'falas', reference: null, threshold: 0.8, extra });

test('gate kinds evaluate against earlier answers only', () => {
  assert.equal(gateSatisfied(always, {}), true);
  assert.equal(gateSatisfied(never('off'), {}), false);
  assert.equal(gateSatisfied(after('x', ['yes']), {}), false, 'unanswered gates are shut');
  assert.equal(gateSatisfied(after('x', ['yes']), a('x', 0.9)), true);
  assert.equal(gateSatisfied(after('x', ['yes']), a('x', 0.1)), false);
  assert.equal(gateSatisfied(after('x', ['folder_0']), pick('x', 'folder_0')), true);
  assert.equal(gateSatisfied(all(after('x', ['yes']), after('y', ['yes'])), { ...a('x', 0.9), ...a('y', 0.9) }), true);
  assert.equal(gateSatisfied(all(after('x', ['yes']), after('y', ['yes'])), a('x', 0.9)), false);
  assert.equal(gateSatisfied(any(after('x', ['yes']), after('y', ['yes'])), a('y', 0.9)), true);
});

test('a shut gate explains itself and a skipped question is not a no', () => {
  const shut = after('speech_already_in_reference', ['yes']);
  assert.equal(gateReason(shut, {}), 'speech_already_in_reference was not answered');
  assert.equal(gateReason(shut, a('speech_already_in_reference', 0.1)), 'speech_already_in_reference is no');
  const rows = report([noul('dup', 0, shut)], {});
  assert.deepEqual(rows[0].state, 'skipped');
  assert.equal(Object.hasOwn({}, 'dup'), false, 'a skipped question leaves no answer behind');
});

test('admitted keeps gate order and drops tier-2 rows whose gate is shut', () => {
  const specs = [noul('base', 0), noul('before', 0, after('base', ['no'])), noul('after', 0, after('base', ['yes']))];
  assert.deepEqual(admitted(specs, a('base', 0.95)).map(s => s.id), ['base', 'after']);
  assert.deepEqual(admitted(specs, a('base', 0.05)).map(s => s.id), ['base', 'before']);
  assert.deepEqual(gateInputs(any(after('a', ['yes']), all(after('b', ['no'])))), ['a', 'b']);
});

test('route specs fan out independent operation, scope and feasibility questions', () => {
  const ids = routeSpecs(['falas']).map(s => s.id);
  const feasibility = ['spoken_content_decides', 'needs_picture', 'needs_sound', 'needs_measurement', 'needs_external_record'];
  for (const id of ['ops_find', 'ops_create', 'ops_move', 'ops_rename', 'ops_extract', 'criterion_requested', 'target_set', 'reference_set', ...feasibility]) assert.ok(ids.includes(id), id);
  assert.deepEqual(ids.filter(id => id === 'reference_set'), ['reference_set']);
  assert.equal(routeSpecs([]).some(s => s.id === 'reference_set'), false, 'no folders means no reference question');
  const target = routeSpecs(['broll', 'falas']).find(s => s.id === 'target_set').question;
  assert.match(target.criteria.folder_0, /broll/);
  assert.match(target.criteria.folder_1, /falas/);
  const asked = admitted(routeSpecs(['falas']), {});
  assert.equal(asked.some(s => s.id === 'ops_extract'), false);
  for (const id of feasibility) assert.ok(asked.some(s => s.id === id), `${id} is speculative, not a dependent round`);
  assert.equal(Object.keys(questions(routeSpecs([]))).length, 12);
});

test('route answers drive scope, reference and preset', () => {
  const folders = ['falas', 'broll'];
  assert.equal(referenceFromRoute(pick('reference_set', 'none'), folders), null);
  assert.equal(referenceFromRoute(pick('reference_set', 'folder_1'), folders), 'broll');
  assert.equal(scopeFromRoute(pick('target_set', 'root_only')), 'root_only');
  assert.equal(scopeFromRoute(pick('target_set', 'folder_1')), 'folder_1');
  assert.equal(scopeFromRoute({}), 'missing');
  assert.equal(modeFromRoute(a('criterion_requested', 0.1), null), 'all');
  assert.equal(modeFromRoute(a('criterion_requested', 0.9), null), 'custom');
  assert.equal(modeFromRoute(a('criterion_requested', 0.9), 'falas'), 'redundant');
  assert.equal(modeFromRoute(a('ops_find', 0.9), null), 'custom');
});

test('clip gates open only on the answers that unlock them', () => {
  const noReference = clipSpecs(rule(), { hasCriterion: true, hasReference: false });
  assert.deepEqual(admitted(noReference, {}).filter(s => s.tier === 1).map(s => s.id), ['matches_request', 'has_scripted_segment', 'has_incomplete_speech', 'speech_kind']);
  assert.match(report(noReference, {}).find(r => r.id === 'speech_already_in_reference').reason, /no retained reference set/);
  const withReference = clipSpecs(rule(), { hasCriterion: true, hasReference: true });
  assert.deepEqual(admitted(withReference, {}).filter(s => s.tier === 1).map(s => s.id), ['matches_request', 'has_scripted_segment', 'has_incomplete_speech', 'speech_kind', 'speech_already_in_reference', 'other_speech_not_in_reference']);
  const noCriterion = clipSpecs(rule(), { hasCriterion: false, hasReference: true });
  assert.deepEqual(admitted(noCriterion, {}).filter(s => s.tier === 1).map(s => s.id).includes('matches_request'), false);
});

test('a request that filters nothing asks Jev nothing', () => {
  const specs = clipSpecs({ ...rule(), mode: 'all' }, { hasCriterion: true, hasReference: true });
  assert.deepEqual(admitted(specs, {}), []);
  assert.match(report(specs, {})[0].reason, /does not filter content/);
});

test('tier-2 questions unlock from tier-1 answers but stay off in this release', () => {
  const specs = clipSpecs(rule(), { hasCriterion: true, hasReference: true });
  const clean = specs.find(s => s.id === 'cleanest_take');
  assert.equal(clean.tier, 2);
  assert.deepEqual(gateInputs(clean.gate), ['has_scripted_segment']);
  assert.match(gateReason(clean.gate, a('has_scripted_segment', 0.05)), /has_scripted_segment is no/);
  assert.match(gateReason(clean.gate, a('has_scripted_segment', 0.95)), /not part of this release/);
  assert.equal(admitted(specs, a('has_scripted_segment', 0.95)).some(s => s.id === 'cleanest_take'), false);
});

test('user questions are gated with the built-ins and never run on an unfiltered request', () => {
  const withExtras = clipSpecs(rule([{ text: 'Mentions the brand?', gate: 'yes' }, { text: 'Gibberish?', gate: 'no' }]), { hasCriterion: true, hasReference: false });
  assert.deepEqual(admitted(withExtras, {}).filter(s => s.tier === 1).map(s => s.id), ['matches_request', 'has_scripted_segment', 'has_incomplete_speech', 'speech_kind', 'extra_0', 'extra_1']);
  assert.deepEqual(admitted(clipSpecs({ ...rule([{ text: 'x', gate: 'yes' }]), mode: 'all' }, { hasCriterion: true, hasReference: false }), {}), []);
});

test('workspace decisions separate prefixed answers back into one clip report', () => {
  const clip = { path: 'A.MOV', fingerprint: { size: 1, mtimeMs: 1, ino: 1, dev: 1 } };
  const transcript = { version: 1, model: 'stt', source: clip.fingerprint, prompt: 'p', timeUnit: 'ms', status: 'complete', timing: 'word', words: [], segments: [], text: '', durationMs: 1, cost: 0 };
  const snapshot = workspaceSnapshot({ clips: [clip], folders: [] }, [{ clip, transcript }]);
  const batch = workspaceQuestionBatch(snapshot, [clip.path], rule(), { hasCriterion: true, hasReference: false });
  assert.deepEqual(Object.keys(batch.questions), ['video_0__matches_request', 'video_0__has_scripted_segment', 'video_0__has_incomplete_speech', 'video_0__speech_kind']);
  const [decision] = workspaceDecisions(batch, {
    video_0__matches_request: { type: 'noul', noul: 0.9 },
    video_0__has_scripted_segment: { type: 'noul', noul: 0.9 },
    video_0__has_incomplete_speech: { type: 'noul', noul: 0.1 },
    video_0__speech_kind: { type: 'choice', choice: 'actual_speech', probabilities: { actual_speech: 1 }, confidence: 1 },
  }, rule());
  assert.equal(decision.recommendation, 'propose');
  const skipped = decision.skipped.filter(r => r.state === 'skipped').map(r => r.id);
  assert.deepEqual(skipped.filter(id => id.startsWith('speech_already')), ['speech_already_in_reference']);
  assert.ok(skipped.includes('cleanest_take'));
  assert.ok(!skipped.includes('has_scripted_segment'));
});

test('workspace decisions make no provider questions when nothing is gated in', () => {
  const clip = { path: 'A.MOV', fingerprint: { size: 1, mtimeMs: 1, ino: 1, dev: 1 } };
  const snapshot = workspaceSnapshot({ clips: [clip], folders: [] }, []);
  const batch = workspaceQuestionBatch(snapshot, [clip.path], { ...rule(), mode: 'all' }, { hasCriterion: true, hasReference: false });
  assert.deepEqual(batch.questions, {});
});
