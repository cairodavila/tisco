import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../dist/workspace.js';
import { cachedDecision, decisionKey, saveDecision } from '../dist/cache.js';

const parts = (over = {}) => ({ model: 'typesafe/jev-1.13', request: 'move prepared takes', context: 'brand', mode: 'custom', reference: null, questions: ['matches_request', 'has_scripted_segment'], questionSignature: 'v1 wording', clip: { path: 'A.MOV', size: 1, mtimeMs: 2, ino: 3, dev: 4 }, references: [], ...over });
const decision = { path: 'A.MOV', answers: {}, recommendation: 'propose', reason: 'meets 0.80' };

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-cache-'));
  const ws = new Workspace(root);
  await ws.initialize();
  return ws;
}

test('the same request and evidence reuse a decision, anything else does not', async () => {
  const ws = await workspace();
  const key = decisionKey(parts());
  assert.equal(await cachedDecision(ws, key), undefined);
  await saveDecision(ws, key, decision);
  const stored = await cachedDecision(ws, key);
  assert.equal(stored.recommendation, 'propose');
  assert.equal(stored.cached, true);

  for (const change of [
    { model: 'typesafe/jev-1.14' }, { request: 'move b-roll' }, { context: 'other brand' }, { mode: 'scripted' },
    { reference: 'falas' }, { questions: ['has_scripted_segment'] }, { questionSignature: 'changed wording' }, { unjudgeable: ['sound'] },
    { clip: { path: 'B.MOV', size: 1, mtimeMs: 2, ino: 3, dev: 4 } },
    { clip: { path: 'A.MOV', size: 99, mtimeMs: 2, ino: 3, dev: 4 } },
    { references: [{ path: 'falas/A.MOV', size: 1, mtimeMs: 2, ino: 3, dev: 4 }] },
    { references: [{ path: 'falas/B.MOV', size: 1, mtimeMs: 2, ino: 9, dev: 4 }] },
  ]) {
    assert.notEqual(decisionKey(parts(change)), key, JSON.stringify(change));
    assert.equal(await cachedDecision(ws, decisionKey(parts(change))), undefined);
  }
});

test('two clips never share a judgment', () => {
  const a = decisionKey(parts({ clip: { path: 'A.MOV', size: 1, mtimeMs: 2, ino: 3, dev: 4 } }));
  const b = decisionKey(parts({ clip: { path: 'B.MOV', size: 1, mtimeMs: 2, ino: 3, dev: 4 } }));
  assert.notEqual(a, b);
});

test('key order of questions, limitations and references does not change the key', () => {
  const reordered = parts({
    questions: ['has_scripted_segment', 'matches_request'],
    unjudgeable: ['sound', 'picture'],
    references: [{ path: 'z', size: 1, mtimeMs: 1, ino: 1, dev: 1 }, { path: 'a', size: 1, mtimeMs: 1, ino: 1, dev: 1 }],
  });
  const straight = parts({
    unjudgeable: ['picture', 'sound'],
    references: [{ path: 'a', size: 1, mtimeMs: 1, ino: 1, dev: 1 }, { path: 'z', size: 1, mtimeMs: 1, ino: 1, dev: 1 }],
  });
  assert.equal(decisionKey(reordered), decisionKey(straight));
});


test('a tampered cache entry is refused instead of trusted', async () => {
  const ws = await workspace();
  const key = decisionKey(parts());
  await fs.mkdir(path.join(ws.root, '.tisco/decisions'), { recursive: true });
  const file = path.join(ws.root, '.tisco/decisions', `${key}.json`);
  await fs.writeFile(file, JSON.stringify({ version: 1, key: 'other', decision }));
  await assert.rejects(() => cachedDecision(ws, key), /Invalid decision cache entry/);
  await fs.writeFile(file, JSON.stringify({ version: 1, key, decision: { path: 'A.MOV' } }));
  await assert.rejects(() => cachedDecision(ws, key), /Invalid cached decision/);
});
