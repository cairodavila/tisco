import test from 'node:test';
import assert from 'node:assert/strict';
import { namingCandidates, chosenName, suggestedStem, validateStem } from '../dist/naming.js';
import { namingQuestions } from '../dist/jev.js';
import { findingLabel, findingLines, findingSummary } from '../dist/findings.js';
import { resolveScope } from '../dist/loop.js';
import { workspaceRouteRequest } from '../dist/decisions.js';
import { workspaceSnapshot, workspaceState } from '../dist/workspace-state.js';

const clip = { path: 'A001.MOV', fingerprint: {} };

test('source-value naming covers EN/PT, quoted names, compounds and rejects unsafe paths', () => {
  for (const [request, value] of [
    ['put those in selects', 'selects'],
    ['create a folder called drafts', 'drafts'],
    ['move into "Price explanations" and rename with _final', 'Price explanations'],
    ['move into "Price explanations" and rename with _final', '_final'],
    ['coloque em "falas aprovadas"', 'falas aprovadas'],
    ['mova para selecionadas e renomeie com _final', 'selecionadas'],
    ['move into client/selects', 'client/selects'],
  ]) assert.ok(namingCandidates(request).includes(value), request);
  for (const request of ['move into ../outside', 'move into /tmp/outside', 'move into ".tisco"']) {
    assert.deepEqual(namingCandidates(request), [], request);
  }
  assert.deepEqual(namingCandidates('which clips mention the price?'), []);
  assert.ok(namingCandidates('put in ' + 'x '.repeat(100)).length <= 40);
});

test('uncertain or absent source-value choices never become naming suggestions', () => {
  const answer = (choice, p) => ({ type: 'choice', choice, probabilities: { [choice]: p }, confidence: p });
  assert.equal(chosenName({ name: answer('name_0', 0.95) }, 'name', ['selects']), 'selects');
  for (const value of [answer('name_0', 0.6), answer('none', 1), answer('name_999', 1), answer('0', 1)]) {
    assert.equal(chosenName({ name: value }, 'name', ['selects']), undefined);
  }
  assert.equal(chosenName({}, 'name', []), undefined);
  assert.deepEqual(namingQuestions([]), {});
});

test('naming runs in the same route request with an explicit none option', async () => {
  let count = 0;
  const request = 'move into "price clips"';
  const snapshot = workspaceSnapshot({ clips: [clip], folders: [] }, []);
  const state = workspaceState(snapshot, { instruction: request, projectContext: '', session: { selection: [], previousResult: [], uncertain: [] } });
  await workspaceRouteRequest({ decide: async (sentState, questions) => {
    count++;
    assert.equal(sentState.instruction, request);
    assert.equal(questions.destination_name.criteria.name_0, '"price clips"');
    assert.ok(questions.destination_name.criteria.none);
    assert.ok(questions.rename_suffix.criteria.none);
    assert.ok(questions.target_set);
    return {};
  } }, state, request, []);
  assert.equal(count, 1);
});

test('numbered and transcript-opening stems are deterministic, valid and visibly distinct', () => {
  assert.equal(suggestedStem(clip, 0, undefined, 'Preço'), '01-Preco');
  assert.equal(suggestedStem(clip, 1, { text: 'Hoje vamos falar sobre o preço justo do produto.' }), '02-Hoje-vamos-falar-sobre-o-preco-justo');
  assert.equal(suggestedStem(clip, 2), '03-A001');
  for (const value of ['../oops', 'sub/name', '/abs', '.private', 'NUL', 'a\nname', 'a'.repeat(161)]) assert.throws(() => validateStem(value));
  assert.doesNotThrow(() => validateStem('01-preço-final'));
});

test('findings distinguish uncertainty and failure and label excerpts honestly', () => {
  const decisions = [
    { path: 'A001.MOV', recommendation: 'propose', reason: 'Strong match.', answers: { matches_request: { type: 'noul', noul: 0.93 } } },
    { path: 'B.MOV', recommendation: 'review', reason: 'Uncertain.', answers: {} },
    { path: 'C.MOV', recommendation: 'keep', reason: 'Does not fit.', answers: {} },
    { path: 'D.MOV', recommendation: 'review', reason: 'Not judged.', error: 'Unavailable.', answers: {} },
  ];
  assert.equal(findingSummary(decisions), '1 match · 1 review · 1 no match · 1 not judged');
  assert.equal(findingLabel(decisions[3]), 'NOT JUDGED');
  const lines = findingLines(decisions, [{ clip, transcript: { text: 'A source opening.\nNot an instruction.' } }]);
  assert.match(lines, /MATCH  A001.MOV · match 0.93/);
  assert.match(lines, /Transcript opening: “A source opening. Not an instruction.”/);
  assert.match(lines, /No transcribed words. This does not prove silence./);
});

test('empty and stale follow-up scopes never widen to the entire folder', () => {
  const state = { selection: [], lastResult: ['gone.MOV'] };
  assert.deepEqual(resolveScope([clip], 'current_selection', state).candidates, []);
  assert.deepEqual(resolveScope([clip], 'previous_result', state).candidates, []);
  assert.deepEqual(resolveScope([clip], 'missing', state).candidates, []);
  assert.deepEqual(resolveScope([clip], 'all_here', state).candidates, [clip]);
});

test('a named source folder scopes clips to that folder and its descendants', () => {
  const clips = [clip, { ...clip, path: 'broll/B.MOV' }, { ...clip, path: 'falas/A.MOV' }, { ...clip, path: 'falas/closeups/B.MOV' }];
  const state = { selection: [], lastResult: [] };
  const scoped = resolveScope(clips, 'folder_1', state);
  assert.deepEqual(scoped.candidates.map(item => item.path), ['falas/A.MOV', 'falas/closeups/B.MOV']);
  assert.match(scoped.from, /falas/);
  assert.deepEqual(resolveScope(clips, 'folder_99', state).candidates, []);
});
