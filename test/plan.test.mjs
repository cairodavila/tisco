import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace, exists } from '../dist/workspace.js';
import { approveReady, blockedActions, executionOrder, readyActions, setApproved, validatePlan } from '../dist/actions.js';
import { appendSuffix, buildPlan, executePlan, renamedSidecar } from '../dist/plan.js';

/** Every clip the evidence supported; `preselected: false` is the unclear case. */
const take = (clips, preselected = true) => clips.map(clip => ({ clip, preselected }));

async function sandbox(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-plan-'));
  for (const name of files) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `bytes of ${name}`);
  }
  const workspace = new Workspace(root);
  await workspace.initialize();
  const clips = await workspace.scan();
  return { root, workspace, clips };
}

const read = async (root, name) => fs.readFile(path.join(root, name), 'utf8');
const listing = async (root) => (await fs.readdir(root, { recursive: true, })).filter(n => !n.startsWith('.')).sort();

test('name helpers keep the extension and follow the video for sidecars', () => {
  assert.equal(appendSuffix('IMG_3664.MOV', '_brocolis'), 'IMG_3664_brocolis.MOV');
  assert.equal(renamedSidecar('IMG_3664.MOV.tisco.json', 'IMG_3664.MOV', 'IMG_3664_brocolis.MOV'), 'IMG_3664_brocolis.MOV.tisco.json');
  assert.equal(renamedSidecar('IMG_3664.assemblyai.full.json', 'IMG_3664.MOV', 'IMG_3664_brocolis.MOV'), 'IMG_3664_brocolis.assemblyai.full.json');
  assert.equal(renamedSidecar('notes.txt', 'IMG_3664.MOV', 'IMG_3664_brocolis.MOV'), 'notes.txt');
});

test('moving into an existing folder needs no create step', async () => {
  const { workspace, clips } = await sandbox(['IMG_1.MOV', 'falas/.keep']);
  const plan = await buildPlan(workspace, { clips: take(clips), folder: 'falas' });
  assert.deepEqual(plan.actions.map(a => a.id), ['move:IMG_1.MOV']);
  assert.deepEqual(plan.actions[0].dependsOn, []);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(validatePlan(approveReady(plan)), []);
});

test('a new folder is created first and undone when empty', async () => {
  const { root, workspace, clips } = await sandbox(['IMG_1.MOV', 'IMG_1.MOV.tisco.json']);
  const plan = await buildPlan(workspace, { clips: take(clips), folder: 'falas' });
  assert.deepEqual(plan.actions.map(a => a.id), ['mkdir:falas', 'move:IMG_1.MOV']);
  assert.deepEqual(plan.actions[1].dependsOn, ['mkdir:falas']);
  const approved = approveReady(plan);
  assert.deepEqual(executionOrder(approved).map(a => a.id), ['mkdir:falas', 'move:IMG_1.MOV']);
  await executePlan(workspace, approved);
  assert.equal(await read(root, 'falas/IMG_1.MOV'), 'bytes of IMG_1.MOV');
  assert.equal(await read(root, 'falas/IMG_1.MOV.tisco.json'), 'bytes of IMG_1.MOV.tisco.json');
  assert.equal(await exists(path.join(root, 'IMG_1.MOV')), false);
  const journal = (await workspace.journals())[0];
  assert.deepEqual(journal.dirs, ['falas']);
  await workspace.undo(journal);
  assert.equal(await read(root, 'IMG_1.MOV'), 'bytes of IMG_1.MOV');
  assert.equal(await exists(path.join(root, 'falas')), false, 'a folder this run created is removed when empty');
});

test('move + rename chains, and the rename target does not exist at preflight', async () => {
  const { root, workspace, clips } = await sandbox(['IMG_1.MOV', 'IMG_1.MOV.tisco.json', 'IMG_1.assemblyai.full.json', 'IMG_2.MOV']);
  const plan = await buildPlan(workspace, {
    clips: take(clips.filter(c => c.path === 'IMG_1.MOV')),
    folder: 'falas',
    rename: { kind: 'append', suffix: '_brocolis' },
  });
  assert.deepEqual(plan.actions.map(a => a.id), ['mkdir:falas', 'move:IMG_1.MOV', 'rename:IMG_1.MOV']);
  const rename = plan.actions[2];
  assert.deepEqual(rename.dependsOn, ['move:IMG_1.MOV']);
  assert.deepEqual(rename.pairs.map(p => p.to), [
    'falas/IMG_1_brocolis.MOV',
    'falas/IMG_1_brocolis.MOV.tisco.json',
    'falas/IMG_1_brocolis.assemblyai.full.json',
  ]);
  await executePlan(workspace, approveReady(plan));
  assert.equal(await read(root, 'falas/IMG_1_brocolis.MOV'), 'bytes of IMG_1.MOV');
  assert.equal(await read(root, 'falas/IMG_1_brocolis.assemblyai.full.json'), 'bytes of IMG_1.assemblyai.full.json');
  assert.equal(await exists(path.join(root, 'falas/IMG_1.MOV')), false, 'the intermediate name is gone');
  assert.equal(await read(root, 'IMG_2.MOV'), 'bytes of IMG_2.MOV', 'unselected clips are untouched');
});

test('undo reverses a move + rename chain and restores original names', async () => {
  const { root, workspace, clips } = await sandbox(['IMG_1.MOV', 'IMG_1.MOV.tisco.json']);
  const plan = await buildPlan(workspace, { clips: take(clips), folder: 'falas', rename: { kind: 'append', suffix: '_brocolis' } });
  await executePlan(workspace, approveReady(plan));
  const journal = (await workspace.journals())[0];
  await workspace.undo(journal);
  assert.equal(await read(root, 'IMG_1.MOV'), 'bytes of IMG_1.MOV');
  assert.equal(await read(root, 'IMG_1.MOV.tisco.json'), 'bytes of IMG_1.MOV.tisco.json');
  assert.deepEqual(await listing(root), ['IMG_1.MOV', 'IMG_1.MOV.tisco.json']);
});

test('an existing destination blocks that row instead of throwing', async () => {
  const { workspace, clips } = await sandbox(['IMG_1.MOV', 'falas/IMG_1.MOV', 'IMG_2.MOV']);
  const plan = await buildPlan(workspace, { clips: take(clips), folder: 'falas' });
  const move = plan.actions.find(a => a.id === 'move:IMG_1.MOV');
  assert.match(move.blocked, /destination already exists/);
  const approved = approveReady(plan);
  assert.deepEqual(blockedActions(approved).map(a => a.id), []);
  assert.deepEqual(executionOrder(approved).map(a => a.id), ['move:IMG_2.MOV']);
});

test('clips already in the destination are skipped with a reason', async () => {
  const { workspace, clips } = await sandbox(['falas/IMG_1.MOV', 'IMG_2.MOV']);
  const plan = await buildPlan(workspace, { clips: take(clips), folder: 'falas' });
  assert.deepEqual(plan.skipped, [{ clip: 'falas/IMG_1.MOV', reason: 'already inside falas/' }]);
  assert.deepEqual(plan.actions.map(a => a.id), ['move:IMG_2.MOV']);
});

test('rename in place keeps the clip where it is', async () => {
  const { root, workspace, clips } = await sandbox(['IMG_1.MOV']);
  const plan = await buildPlan(workspace, { clips: take(clips), rename: { kind: 'append', suffix: '_final' } });
  assert.deepEqual(plan.actions.map(a => a.id), ['rename:IMG_1.MOV']);
  assert.deepEqual(plan.actions[0].pairs.map(p => [p.from, p.to]), [['IMG_1.MOV', 'IMG_1_final.MOV']]);
  await executePlan(workspace, approveReady(plan));
  assert.equal(await read(root, 'IMG_1_final.MOV'), 'bytes of IMG_1.MOV');
  assert.deepEqual(await listing(root), ['IMG_1_final.MOV']);
});

test('unapproved rows cannot run', async () => {
  const { workspace, clips } = await sandbox(['IMG_1.MOV']);
  const plan = await buildPlan(workspace, { clips: take(clips), folder: 'falas' });
  await assert.rejects(() => executePlan(workspace, plan), /No approved actions to run/);
  assert.equal(await exists(path.join(workspace.root, 'falas')), false);
});

test('an unclear clip is offered as an unapproved row, not accepted by a blanket yes', async () => {
  const { workspace, clips } = await sandbox(['IMG_1.MOV', 'IMG_2.MOV']);
  const plan = await buildPlan(workspace, { clips: [{ clip: clips[0], preselected: true }, { clip: clips[1], preselected: false }], folder: 'falas' });
  const offered = plan.actions.filter(action => action.operation === 'move');
  assert.deepEqual(offered.map(action => [action.afterPath, action.preselected]), [['falas/IMG_1.MOV', true], ['falas/IMG_2.MOV', false]]);

  const moves = state => readyActions(state).filter(action => action.operation === 'move').map(action => action.afterPath);
  const batch = approveReady(plan);
  assert.deepEqual(moves(batch), ['falas/IMG_1.MOV'], 'Enter takes only what the evidence supported');
  assert.deepEqual(blockedActions(batch), [], 'an unapproved offer is not a blocked row');

  const chosen = setApproved(batch, 'move:IMG_2.MOV', true);
  assert.deepEqual(moves(chosen), ['falas/IMG_1.MOV', 'falas/IMG_2.MOV'], 'approving the offer includes it');
});

test('explicit replacement stems preserve extensions and both sidecar formats through undo', async () => {
  const { root, workspace, clips } = await sandbox(['A.MOV', 'A.MOV.tisco.json', 'A.assemblyai.full.json']);
  const intent = { clips: take(clips), folder: 'selects', rename: { kind: 'names', names: { 'A.MOV': '01-price' } } };
  const plan = approveReady(await buildPlan(workspace, intent));
  assert.deepEqual(plan.actions.at(-1).pairs.map(pair => pair.to), ['selects/01-price.MOV', 'selects/01-price.MOV.tisco.json', 'selects/01-price.assemblyai.full.json']);
  const journal = await executePlan(workspace, plan);
  assert.equal(await read(root, 'selects/01-price.MOV'), 'bytes of A.MOV');
  await workspace.undo(journal);
  assert.equal(await read(root, 'A.MOV.tisco.json'), 'bytes of A.MOV.tisco.json');
});

test('replacement collisions and unsafe names cannot apply', async () => {
  const { workspace, clips } = await sandbox(['A.MOV', 'B.MOV']);
  const plan = await buildPlan(workspace, { clips: take(clips), rename: { kind: 'names', names: { 'A.MOV': 'same', 'B.MOV': 'same' } } });
  assert.match(plan.actions[1].blocked, /two planned files/);
  for (const stem of ['../out', 'dir/name', '.hidden', 'NUL']) {
    await assert.rejects(buildPlan(workspace, { clips: take(clips), rename: { kind: 'names', names: { 'A.MOV': stem } } }));
  }
});

test('rename still works inside an existing destination and unchanged names are skipped', async () => {
  const { root, workspace, clips } = await sandbox(['selects/A.MOV', 'selects/A.MOV.tisco.json']);
  const plan = approveReady(await buildPlan(workspace, { clips: take(clips), folder: 'selects', rename: { kind: 'names', names: { 'selects/A.MOV': '01-price' } } }));
  assert.deepEqual(plan.actions.map(action => action.operation), ['rename']);
  const journal = await executePlan(workspace, plan);
  assert.equal(await read(root, 'selects/01-price.MOV'), 'bytes of selects/A.MOV');
  await workspace.undo(journal);
  const unchanged = await buildPlan(workspace, { clips: take(await workspace.scan()), rename: { kind: 'names', names: { 'selects/A.MOV': 'A' } } });
  assert.equal(unchanged.actions.length, 0);
  assert.equal(unchanged.skipped[0].reason, 'filename unchanged');
});
