import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  ASPECT_QUESTIONS,
  clipQuestionIds,
  clipSpecs,
  clipState,
  feasibilityFromRoute,
  routeRequest,
  routeSpecs,
} from '../dist/decisions.js';
import { admitted, report } from '../dist/gates.js';
import { clipState as wireClipState } from '../dist/jev.js';

const folders = [];
const source = { path: 'a.mov', size: 1, mtimeMs: 1, ino: 1, dev: 1 };
const evidence = {
  clip: { path: 'a.mov', fingerprint: source },
  transcript: { path: 'a.mov', prompt: '', status: 'complete', timing: 'word', text: 'ok', words: [], source },
};
const noul = value => ({ type: 'noul', noul: value });
const aspectIds = Object.values(ASPECT_QUESTIONS);

function stub(script) {
  const calls = [];
  return {
    calls,
    async decide(state, questions) {
      calls.push({ state, ids: Object.keys(questions).sort() });
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        if (!(id in script)) throw new Error(`Not scripted for ${id}`);
        const answer = script[id];
        return [id, question.type === 'noul'
          ? noul(answer)
          : { type: 'choice', choice: answer, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === answer ? 0.9 : 0.02])) }];
      }));
    },
  };
}

const routeAnswers = {
  ops_find: 0.95,
  ops_create: 0.95,
  ops_move: 0.95,
  ops_rename: 0.05,
  criterion_requested: 0.95,
  target_set: 'all_here',
  destination_name: 'none',
  rename_suffix: 'none',
  spoken_content_decides: 0.95,
  needs_picture: 0.05,
  needs_sound: 0.05,
  needs_measurement: 0.05,
  needs_external_record: 0.05,
};

test('route uses one speculative fan-out call, including feasibility', async () => {
  const client = stub(routeAnswers);
  const answers = await routeRequest(client, 'find the clips where they explain the price', folders, 3);
  assert.equal(client.calls.length, 1);
  for (const id of ['spoken_content_decides', ...aspectIds]) assert.ok(client.calls[0].ids.includes(id), id);
  assert.deepEqual(Object.keys(client.calls[0].state).sort(), ['instruction', 'inventory']);
  assert.equal(answers.spoken_content_decides.noul, 0.95);
});

test('an unfiltered request still uses one route call and leaves relevance to code', async () => {
  const client = stub({ ...routeAnswers, ops_find: 0.05, criterion_requested: 0.05 });
  await routeRequest(client, 'move every clip into selects', folders, 3);
  assert.equal(client.calls.length, 1);
  for (const id of aspectIds) assert.ok(client.calls[0].ids.includes(id), id);
});

test('all feasibility questions are admitted independently', () => {
  const specs = routeSpecs(folders);
  const asked = admitted(specs, {});
  for (const id of ['spoken_content_decides', ...aspectIds]) {
    assert.ok(asked.some(spec => spec.id === id), id);
    assert.equal(report(specs.filter(spec => spec.id === id), {})[0].state, 'asked');
  }
  assert.ok(!asked.some(spec => spec.id === 'ops_extract'));
});

test('feasibility fails open when evidence is missing or inconclusive', () => {
  assert.deepEqual(feasibilityFromRoute({}), { spoken: true, aspects: [], limited: false });
  assert.deepEqual(feasibilityFromRoute({ spoken_content_decides: noul(0.02) }), { spoken: false, aspects: [], limited: false });
  assert.deepEqual(feasibilityFromRoute({ spoken_content_decides: noul(0.02), needs_sound: noul(0.79) }), { spoken: false, aspects: [], limited: false });
});

test('a request is refused only when a limitation is clear and the words are not', () => {
  const at = (spoken, sound) => ({ spoken_content_decides: noul(spoken), needs_sound: noul(sound) });
  assert.equal(feasibilityFromRoute(at(0.05, 0.95)).limited, true);
  assert.equal(feasibilityFromRoute(at(0.45, 0.95)).limited, true);
  assert.equal(feasibilityFromRoute(at(0.9, 0.95)).limited, false);
  assert.equal(feasibilityFromRoute(at(0.05, 0.45)).limited, false, 'an uncertain reason never blocks');
});

test('independent Nouls preserve multiple simultaneous limitations', () => {
  const result = feasibilityFromRoute({
    spoken_content_decides: noul(0.9),
    needs_picture: noul(0.94),
    needs_sound: noul(0.91),
    needs_measurement: noul(0.08),
    needs_external_record: noul(0.05),
  });
  assert.deepEqual(result, { spoken: true, aspects: ['picture', 'sound'], limited: false });
});

test('set-aside parts travel with only the question that needs them', () => {
  const rule = { request: 'well-lit clips with clean audio where they explain the price', context: '', mode: 'custom', destination: 'falas', reference: null, threshold: 0.8, extra: [] };
  const options = { hasCriterion: true, hasReference: false };
  const asked = admitted(clipSpecs(rule, options), {}).filter(spec => spec.tier === 1);
  assert.deepEqual(asked.filter(spec => spec.consumes.includes('unjudgeable')).map(spec => spec.id), ['matches_request']);
  assert.equal(clipQuestionIds(rule, options).length, asked.length);
  const consumes = asked.flatMap(spec => spec.consumes);
  assert.ok(!('unjudgeable' in clipState(evidence, [], rule, consumes)));
  const mixed = clipState(evidence, [], { ...rule, unjudgeable: ['picture', 'sound'] }, consumes);
  assert.deepEqual(mixed.unjudgeable, ['picture', 'sound']);
  assert.deepEqual(wireClipState(rule.request, '', {}, [], ['picture', 'sound']).unjudgeable, ['picture', 'sound']);
  assert.ok(!('unjudgeable' in wireClipState(rule.request, '', {}, [])));
});
