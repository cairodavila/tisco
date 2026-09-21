/**
 * Wording evaluation for the Jev questions, scored through the real model.
 *
 * The prompt text in src/jev.ts is calibrated by measurement, not taste, and this is the
 * measurement. It reads the shipped wording out of dist/jev.js rather than keeping a copy,
 * so the product and this evaluation cannot drift apart.
 *
 *   pnpm build
 *   OPENROUTER_API_KEY=... node tools/wording-eval.mjs
 *
 * Needs network access and a paid key, so it is not part of `pnpm test`. Answers are read
 * the way the product reads them: >= 0.80 fires, <= 0.20 is a no, anything between lands in
 * the review band. For an operation question a review band means the operation does not
 * fire, so a labelled yes in that band is a miss and a labelled no is harmless.
 */
import { OpenRouter, JEV_MODEL } from '../dist/openrouter.js';
import { routeQuestion, clipQuestion } from '../dist/jev.js';
import { readFileSync } from 'node:fs';

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('Set OPENROUTER_API_KEY to run the wording evaluation.');
const client = new OpenRouter(key);
const read = value => (value >= 0.8 ? 'yes' : value <= 0.2 ? 'no' : 'review');

/** Route fixtures: what a user types, and what each question should say about it. */
const acts = { ops_find: 'yes', ops_create: 'yes', ops_move: 'yes', ops_rename: 'no', criterion_requested: 'yes' };
const reads = { ops_find: 'yes', ops_create: 'no', ops_move: 'no', ops_rename: 'no', criterion_requested: 'yes' };
// A condition that names no content: find fires, criterion_requested does not, and the
// feasibility question is what has to answer for it.
const conditions = { ops_find: 'yes', ops_create: 'no', ops_move: 'no', ops_rename: 'no', criterion_requested: 'no' };
const routeFixtures = [
  { request: 'find the clips with clean on-camera speech and put them in selects', expect: acts, target: 'all_here' },
  { request: 'encontre os clipes com fala limpa e coloque em selecionadas', expect: acts, target: 'all_here' },
  { request: 'separe os takes bons das falas e jogue o resto em broll', expect: acts, target: 'all_here' },
  { request: 'move all clips into broll', expect: { ops_find: 'no', ops_create: 'yes', ops_move: 'yes', ops_rename: 'no', criterion_requested: 'no' }, target: 'all_here' },
  { request: 'rename every clip with _final', expect: { ops_find: 'no', ops_create: 'no', ops_move: 'no', ops_rename: 'yes', criterion_requested: 'no' }, target: 'all_here' },
  { request: 'create a folder called drafts', expect: { ops_find: 'no', ops_create: 'yes', ops_move: 'no', ops_rename: 'no', criterion_requested: 'no' }, target: 'all_here' },
  { request: 'qual a previsão do tempo para amanhã?', expect: { ops_find: 'no', ops_create: 'no', ops_move: 'no', ops_rename: 'no', criterion_requested: 'no' }, target: 'missing' },
  // Feasibility fixtures. `spoken` says whether anything asked for lives in the words;
  // `aspects` are independent labels, because picture and sound can both be requested.
  { request: 'separate the clips where he is smiling into selects', expect: acts, target: 'all_here', feasibility: { spoken: 'no', aspects: ['picture'] } },
  { request: 'os clipes com áudio limpo e sem vento, coloque em selecionadas', expect: acts, target: 'all_here', feasibility: { spoken: 'no', aspects: ['sound'] } },
  { request: 'find the clips with clean audio where they explain the price and put them in falas', expect: acts, target: 'all_here', feasibility: { spoken: 'yes', aspects: ['sound'] } },
  { request: 'os clipes com mais de 20 segundos', expect: conditions, target: 'all_here', feasibility: { spoken: 'no', aspects: ['measured'] } },
  { request: 'the clips nobody has used before', expect: conditions, target: 'all_here', feasibility: { spoken: 'no', aspects: ['without_record'] } },
  { request: 'the well-lit clips where they explain the price', expect: reads, target: 'all_here', feasibility: { spoken: 'yes', aspects: ['picture'] } },
  { request: 'find the well-lit clips with clean audio where they explain the price', expect: reads, target: 'all_here', feasibility: { spoken: 'yes', aspects: ['picture', 'sound'] } },
  { request: 'separate the well-lit clips with clean audio', expect: reads, target: 'all_here', feasibility: { spoken: 'no', aspects: ['picture', 'sound'] } },
  // These two are about the spoken words, so they must not be refused. A stumble and a
  // clear explanation are judged from what was said, which is the boundary worth pinning.
  { request: 'the takes where he does not stumble on the line, put them in falas', expect: acts, target: 'all_here', feasibility: { spoken: 'yes', aspects: [] } },
  { request: 'the clips where the explanation of the price is clear', expect: reads, target: 'all_here', feasibility: { spoken: 'yes', aspects: [] } },
];

const routeIds = ['ops_find', 'ops_create', 'ops_move', 'ops_rename', 'criterion_requested', 'target_set'];

let failures = 0;
/** Iterating on one question should not pay for the whole table: TISCO_EVAL_ONLY=feasibility. */
const only = process.env.TISCO_EVAL_ONLY ?? '';
const selectedRouteIds = only === 'feasibility' ? [] : only ? routeIds.filter(id => id === only) : routeIds;
if (selectedRouteIds.length) console.log(`route questions (${routeFixtures.length} requests, shipped wording)\n`);
for (const id of selectedRouteIds) {
  const cells = [];
  for (const fixture of routeFixtures) {
    const question = routeQuestion(id, []);
    const answers = await client.decide({ instruction: fixture.request }, { [id]: question });
    const answer = answers[id];
    const expected = id === 'target_set' ? fixture.target : fixture.expect[id];
    const got = answer.type === 'noul' ? read(answer.noul) : answer.choice;
    const value = answer.type === 'noul' ? answer.noul.toFixed(2) : `${(answer.probabilities[answer.choice] ?? 0).toFixed(2)}`;
    // A labelled no that stays under the firing threshold is the safe outcome, not a miss.
    const ok = got === expected || (expected === 'no' && got === 'review');
    if (!ok) failures += 1;
    cells.push(`${ok ? ' ' : '!'}${expected}/${got === expected ? '' : got + ' '}${value}`);
  }
  console.log(`  ${id.padEnd(20)}${cells.join('  ')}`);
}

/**
 * Feasibility, asked exactly as the product asks it: one Noul for whether words decide
 * anything and one per independent limitation. A labelled yes in the review band is a
 * miss; a labelled no below the firing threshold is safe.
 */
const feasible = routeFixtures.filter(fixture => fixture.feasibility);
const aspectQuestions = { picture: 'needs_picture', sound: 'needs_sound', measured: 'needs_measurement', without_record: 'needs_external_record' };
console.log(`\nfeasibility (${feasible.length} requests, shipped wording)\n`);
for (const fixture of feasible) {
  const asked = Object.fromEntries(['spoken_content_decides', ...Object.values(aspectQuestions)].map(id => [id, routeQuestion(id, [])]));
  const answers = await client.decide({ instruction: fixture.request }, asked);
  const spoken = read(answers.spoken_content_decides.noul);
  const wantSpoken = fixture.feasibility.spoken;
  const okSpoken = spoken === wantSpoken || (wantSpoken === 'no' && spoken === 'review');
  let okAspects = true;
  const writtenAspects = Object.entries(aspectQuestions).map(([aspect, id]) => {
    const got = read(answers[id].noul);
    const expected = fixture.feasibility.aspects.includes(aspect) ? 'yes' : 'no';
    const ok = got === expected || (expected === 'no' && got === 'review');
    okAspects &&= ok;
    return `${ok ? '' : '!'}${aspect} ${answers[id].noul.toFixed(2)}`;
  });
  if (!okSpoken || !okAspects) failures += 1;
  const written = `${wantSpoken}/${spoken === wantSpoken ? '' : spoken} ${answers.spoken_content_decides.noul.toFixed(2)}`;
  console.log(`  ${okSpoken && okAspects ? ' ' : '!'}${fixture.request.slice(0, 54).padEnd(56)}spoken ${written.padEnd(14)}${writtenAspects.join(' · ')}`);
}

/**
 * Clip fixtures, opt-in: point TISCO_CLIP_FIXTURES at a JSON file of real transcripts.
 * Shape: [{ name, transcript, expect: 'yes'|'no' }] where transcript holds words/text and
 * `expect` is whether the clip contains a complete take prepared for an audience.
 */
const clipPath = process.env.TISCO_CLIP_FIXTURES;
if (clipPath) {
  const fixture = JSON.parse(readFileSync(clipPath, 'utf8'));
  console.log(`\nclip questions (${fixture.length} labelled clips, shipped wording)\n`);
  for (const carried of fixture) {
    const state = { instruction: carried.instruction ?? 'the clips with clean on-camera speech', project_context: carried.context ?? '', current_video: { video: carried.name, prompt: carried.prompt ?? '', status: 'complete', timing: 'word', time_unit: 'milliseconds', words: carried.words ?? [] }, reference_videos: [] };
    const asked = clipQuestion('has_scripted_segment');
    const answers = await client.decide(state, { has_scripted_segment: asked });
    const answer = answers.has_scripted_segment;
    const got = read(answer.noul);
    const ok = got === carried.expect || (carried.expect === 'no' && got === 'review');
    if (!ok) failures += 1;
    console.log(`  ${ok ? ' ' : '!'}${carried.name.padEnd(30)}expected ${carried.expect.padEnd(4)} got ${got.padEnd(7)}${answer.noul.toFixed(2)}`);
  }
}

console.log(`\nmodel ${JEV_MODEL} · ${failures ? `${failures} miss(es)` : 'no misses'}`);
process.exitCode = failures ? 1 : 0;
