import test from 'node:test';
import assert from 'node:assert/strict';
import {
  folderRelationBatch,
  folderSuggestion,
  workspaceDecisions,
  workspaceQuestionBatch,
} from '../dist/decisions.js';
import { workspaceSnapshot } from '../dist/workspace-state.js';
import { suggestRelatedFolder, workspaceDecisionBatches } from '../dist/loop.js';
import { JEV_MODEL, MAX_DECISION_BYTES, MAX_STATE_BYTES } from '../dist/openrouter.js';

const fingerprint = { size: 12, mtimeMs: 1, ino: 2, dev: 3 };
const clips = [
  { path: 'A.MOV', fingerprint },
  { path: 'broll/B.MOV', fingerprint },
  { path: 'relevant/C.MOV', fingerprint },
];
const transcript = text => ({
  version: 1, model: 'stt', source: fingerprint, prompt: '', timeUnit: 'ms', status: 'complete',
  text, words: [], segments: [], durationMs: 1_000, timing: 'none', cost: 0,
});
const evidence = clips.map((clip, index) => ({ clip, transcript: transcript(['A new warranty explanation.', 'Quiet room tone.', 'Existing warranty discussion.'][index]) }));
const snapshot = workspaceSnapshot({ clips, folders: ['broll', 'relevant'] }, evidence);
const rule = { request: 'find warranty explanations', context: 'campaign', mode: 'custom', destination: '', reference: null, threshold: 0.8, extra: [] };
const noul = value => ({ type: 'noul', noul: value });
const choice = (selected, options, probability = 0.9) => ({
  type: 'choice', choice: selected, confidence: probability,
  probabilities: Object.fromEntries(options.map(option => [option, option === selected ? probability : (1 - probability) / (options.length - 1)])),
});

test('workspace batch asks several independent questions per clip against shared directory state', () => {
  const batch = workspaceQuestionBatch(snapshot, ['A.MOV', 'relevant/C.MOV'], rule, { hasCriterion: true, hasReference: false });
  assert.deepEqual(batch.entries.map(entry => entry.path), ['A.MOV', 'relevant/C.MOV']);
  for (const entry of batch.entries) {
    for (const id of ['matches_request', 'has_scripted_segment', 'has_incomplete_speech', 'speech_kind']) {
      const question = batch.questions[`${entry.videoId}__${id}`];
      assert.ok(question, `${entry.path}: ${id}`);
      assert.match(question.instructions, new RegExp(`workspace\\.videos\\[${entry.videoIndex}\\]`));
      assert.equal(question.instructions.includes('current_video'), false);
    }
  }
});

test('workspace answers are separated back into one decision per clip', () => {
  const batch = workspaceQuestionBatch(snapshot, ['A.MOV'], rule, { hasCriterion: true, hasReference: false });
  const prefix = batch.entries[0].videoId;
  const answers = {
    [`${prefix}__matches_request`]: noul(0.93),
    [`${prefix}__has_scripted_segment`]: noul(0.91),
    [`${prefix}__has_incomplete_speech`]: noul(0.08),
    [`${prefix}__speech_kind`]: choice('actual_speech', ['actual_speech', 'on_set', 'unclear', 'no_transcribed_speech']),
  };
  const [decision] = workspaceDecisions(batch, answers, rule);
  assert.equal(decision.path, 'A.MOV');
  assert.equal(decision.recommendation, 'propose');
  assert.equal(decision.answers.matches_request.noul, 0.93);
  assert.ok(decision.answers.has_incomplete_speech);
});

test('oversized workspace evidence is split without dropping a target transcript', () => {
  const largeEvidence = clips.map((clip, index) => ({ clip, transcript: transcript(`${index} ${'dialogue '.repeat(6_000)}`) }));
  const large = workspaceSnapshot({ clips, folders: ['broll', 'relevant'] }, largeEvidence);
  const batches = workspaceDecisionBatches(large, clips.map(clip => clip.path), rule, { hasCriterion: true, hasReference: false }, {
    instruction: rule.request,
    projectContext: rule.context,
    session: { selection: [], previousResult: [], uncertain: [] },
  });

  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flatMap(batch => batch.questions.entries.map(entry => entry.path)), clips.map(clip => clip.path));
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(JSON.stringify(batch.state)) <= MAX_STATE_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify({ model: JEV_MODEL, state: batch.state, questions: batch.questions.questions })) <= MAX_DECISION_BYTES);
    assert.equal(batch.state.evidence_coverage.complete, false);
  }
});

test('dependent folder inference receives selected clips and the existing folder contents', async () => {
  const calls = [];
  const client = { async decide(state, questions) {
    calls.push({ state, questions });
    return {
      destination_folder: choice('folder_1', Object.keys(questions.destination_folder.criteria), 0.9),
      folder_0_related: noul(0.04),
      folder_1_related: noul(0.94),
    };
  } };
  const suggestion = await suggestRelatedFolder(client, snapshot, ['A.MOV'], {
    instruction: 'move the results where they belong', projectContext: 'campaign',
    session: { selection: ['A.MOV'], previousResult: ['A.MOV'], uncertain: [] },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].state.selected_videos, ['A.MOV']);
  assert.deepEqual(calls[0].state.workspace.folders.find(folder => folder.path === 'relevant').all_videos, ['video_2']);
  assert.equal(calls[0].state.workspace.videos[2].transcript.text, 'Existing warranty discussion.');
  assert.equal(suggestion.folder, 'relevant');
});

test('folder suggestion requires a relative Choice winner and an absolute relation signal', () => {
  const batch = folderRelationBatch(snapshot, ['A.MOV']);
  assert.deepEqual(batch.folders, ['broll', 'relevant']);
  assert.deepEqual(Object.keys(batch.questions.destination_folder.criteria), ['none', 'folder_0', 'folder_1']);
  assert.match(batch.questions.destination_folder.instructions, /selected_videos/);
  assert.match(batch.questions.folder_1_related.instructions, /workspace\.folders/);

  const options = Object.keys(batch.questions.destination_folder.criteria);
  const confident = {
    destination_folder: choice('folder_1', options, 0.9),
    folder_0_related: noul(0.05),
    folder_1_related: noul(0.94),
  };
  assert.deepEqual(folderSuggestion(batch, confident), { folder: 'relevant', choiceProbability: 0.9, relationProbability: 0.94 });
  assert.equal(folderSuggestion(batch, { ...confident, folder_1_related: noul(0.6) }), undefined);
});
