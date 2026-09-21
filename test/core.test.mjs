import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Workspace, fingerprint, validateFolder, exists, atomicJson } from '../dist/workspace.js';
import { OpenRouter, JEV_MODEL, STT_MODEL } from '../dist/openrouter.js';
import { normalizeStt, cachedTranscript, importAssemblyAI, transcribeClip } from '../dist/media.js';
import { recommend, routeQuestions, workspaceDecisions, workspaceQuestionBatch } from '../dist/decisions.js';
import { workspaceSnapshot, workspaceState } from '../dist/workspace-state.js';
import { safeDisplay } from '../dist/types.js';

const exec = promisify(execFile);
const rule = (mode = 'scripted') => ({ request: 'Keep prepared lines even when there are retakes.', context: 'Portuguese food brand', mode, destination: 'falas', reference: null, threshold: 0.8, extra: [] });
const transcript = source => ({ version: 1, model: STT_MODEL, source, prompt: 'Food', timeUnit: 'ms', status: 'complete', text: 'Hoje eu vou ensinar. Errei!', words: [{ text: 'Hoje', start: 0, end: 300 }], segments: [], durationMs: 1500, timing: 'word', cost: 0.001 });
const noul = n => ({ type: 'noul', noul: n });
const choice = (value, distribution) => ({ type: 'choice', choice: value, probabilities: distribution, confidence: distribution[value] });
const answers = () => ({ matches_request: noul(0.9), has_scripted_segment: noul(0.91), has_incomplete_speech: noul(0.08), speech_already_in_reference: noul(0.1), other_speech_not_in_reference: noul(0.9), speech_kind: choice('actual_speech', { actual_speech: 0.9, on_set: 0.05, unclear: 0.03, no_transcribed_speech: 0.02 }) });

async function fixture(t, names = ['A.MOV', 'B.MOV']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), `media ${name}`);
  }
  const workspace = new Workspace(root);
  await workspace.initialize();
  return { root, workspace, clips: await workspace.scan() };
}

test('CLI version comes from the package manifest', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const { stdout } = await exec(process.execPath, ['dist/cli.js', '--version']);
  assert.equal(stdout.trim(), pkg.version);
});

test('model client uses only OpenRouter decisions with the pinned Jev and batched workspace questions', async () => {
  const clip = { path: 'A.MOV', fingerprint: { size: 1, mtimeMs: 1, ino: 1, dev: 1 } };
  const evidence = { clip, transcript: transcript(clip.fingerprint) };
  const snapshot = workspaceSnapshot({ clips: [clip], folders: [] }, [evidence]);
  const batch = workspaceQuestionBatch(snapshot, [clip.path], rule(), { hasCriterion: true, hasReference: false });
  let called = 0;
  const client = new OpenRouter('private-test-key', async (url, init) => {
    called++;
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(init.headers.Authorization, 'Bearer private-test-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, JEV_MODEL);
    assert.deepEqual(Object.keys(body.questions), Object.keys(batch.questions));
    assert.equal(body.state.workspace.videos[0].transcript.text, transcript(clip.fingerprint).text);
    assert.equal(JSON.stringify(body).includes('private-test-key'), false);
    for (const [id, question] of Object.entries(body.questions)) {
      assert.ok(question.instructions.length > 0, `${id} has no instructions`);
      const branches = question.type === 'noul' ? [question.criteria.true, question.criteria.false] : Object.values(question.criteria);
      assert.ok(branches.length > 1 && branches.every(branch => typeof branch === 'string' && branch.length > 0), `${id} does not commit to every branch`);
      assert.match(question.instructions, /workspace\.videos\[0\]/, `${id} never identifies its clip`);
    }
    const local = answers();
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, local[id.split('__')[1]]])) });
  });
  const state = workspaceState(snapshot, { instruction: rule().request, projectContext: rule().context, session: { selection: [], previousResult: [], uncertain: [] } });
  const result = workspaceDecisions(batch, await client.decide(state, batch.questions), rule())[0];
  assert.equal(result.answers.has_scripted_segment.noul, 0.91);
  assert.equal(called, 1);
});

test('STT requests verbose word timestamps without an ignored generic prompt', async () => {
  const client = new OpenRouter('key', async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/transcriptions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, STT_MODEL);
    assert.deepEqual(body.input_audio, { data: Buffer.from('mp3').toString('base64'), format: 'mp3' });
    assert.equal(body.language, 'pt');
    assert.equal(body.response_format, 'verbose_json');
    assert.deepEqual(body.timestamp_granularities, ['word', 'segment']);
    assert.equal(body.prompt, undefined);
    return Response.json({ text: 'Olá' });
  });
  assert.equal((await client.transcribe(Buffer.from('mp3'), 'pt')).text, 'Olá');
});

test('invalid, missing, out-of-range and unknown answers fail closed', async () => {
  for (const invalid of [{}, { a: { type: 'noul', noul: 1.1 } }, { a: { type: 'noul', noul: null } }]) {
    const client = new OpenRouter('key', async () => Response.json({ answers: invalid }));
    await assert.rejects(client.decide({}, { a: { type: 'noul', instructions: '?', criteria: { true: 'yes', false: 'no' } } }));
  }
  const client = new OpenRouter('key', async () => Response.json({ answers: { target_set: { type: 'choice', choice: 'delete', confidence: 1, probabilities: { delete: 1 } } } }));
  await assert.rejects(client.decide({}, { target_set: routeQuestions([]).target_set }), /Unknown choice/);
});

test('context budget never silently truncates or makes a partial call', async () => {
  const questions = { a: { type: 'noul', instructions: 'Does `state` contain words?', criteria: { true: 'yes', false: 'no' } } };
  const client = new OpenRouter('key', async () => { assert.fail('Must not call provider'); });
  await assert.rejects(client.decide({ words: 'á'.repeat(55_000) }, questions), /nothing was truncated/);
  const remote = new OpenRouter('key', async () => new Response('{"error":"max_tokens_exceeded"}', { status: 400 }));
  await assert.rejects(remote.decide({}, questions), /no transcript was truncated/);
});

test('provider errors never expose raw bodies or credentials; failed POST is not replayed', async () => {
  const client = new OpenRouter('secret', async () => new Response('secret raw private transcript', { status: 401 }));
  await assert.rejects(client.decide({}, {}), e => !e.message.includes('secret') && !e.message.includes('private transcript') && e.message.includes('401'));
  let calls = 0;
  const timeout = new OpenRouter('secret', async () => { calls++; throw new Error('secret'); });
  await assert.rejects(timeout.decide({}, {}), /may have been billed/);
  assert.equal(calls, 1);
});

test('timestamp conversion uses milliseconds and adds chunk offsets', () => {
  const value = normalizeStt({ text: 'Olá', words: [{ word: 'Olá', start: 0.25, end: 0.9 }], segments: [{ text: 'Olá', start: 0.2, end: 1 }], usage: { cost: 0.002 } }, 120_000, 10_000);
  assert.deepEqual(value.words, [{ text: 'Olá', start: 120_250, end: 120_900 }]);
  assert.equal(value.cost, 0.002);
  assert.throws(() => normalizeStt({ text: 'broken', words: [{ word: 'bad', start: 2, end: 1 }] }, 0, 5000));
  assert.throws(() => normalizeStt({ text: 'broken', words: [{ word: 'bad', start: 2, end: 99 }] }, 0, 5000));
});

test('workspace state preserves target/reference words, paths and folder membership', () => {
  const clip = { path: 'A.MOV', fingerprint: { size: 1, mtimeMs: 1, ino: 1, dev: 1 } };
  const target = { clip, transcript: transcript(clip.fingerprint) };
  const retained = { clip: { ...clip, path: 'falas/B.MOV' }, transcript: transcript(clip.fingerprint) };
  const snapshot = workspaceSnapshot({ clips: [target.clip, retained.clip], folders: ['falas'] }, [target, retained]);
  const state = workspaceState(snapshot, { instruction: rule().request, projectContext: rule().context, session: { selection: [], previousResult: [], uncertain: [] }, referenceFolder: 'falas' });
  assert.deepEqual(state.workspace.videos[0].transcript.words, [{ text: 'Hoje', start_ms: 0, end_ms: 300 }]);
  assert.equal(state.workspace.videos[1].path, 'falas/B.MOV');
  assert.deepEqual(state.workspace.folders[1].all_videos, ['video_1']);
  assert.equal(state.reference_folder, 'falas');
});

test('scripted clips survive retakes; policy can re-read the same probabilities', () => {
  assert.equal(recommend(answers(), rule()).recommendation, 'propose');
  const a = answers(); a.has_scripted_segment = noul(0.7);
  assert.equal(recommend(a, rule()).recommendation, 'review');
  a.has_scripted_segment = noul(0.1);
  assert.equal(recommend(a, rule()).recommendation, 'keep');
  const borderline = answers(); borderline.matches_request = noul(0.85); borderline.has_scripted_segment = noul(0.85);
  assert.equal(recommend(borderline, { ...rule(), threshold: 0.8 }).recommendation, 'propose');
  assert.equal(recommend(borderline, { ...rule(), threshold: 0.9 }).recommendation, 'review');
});

test('redundancy needs overlap AND absence of novel speech, not lack of scriptedness', () => {
  const a = answers();
  assert.equal(recommend(a, rule('redundant')).recommendation, 'keep');
  a.speech_already_in_reference = noul(0.95);
  assert.equal(recommend(a, rule('redundant')).recommendation, 'keep');
  a.other_speech_not_in_reference = noul(0.2);
  assert.equal(recommend(a, rule('redundant')).recommendation, 'propose');
});

test('quiet mode distinguishes readable production cues from unclear/no transcript', () => {
  const a = answers();
  a.has_scripted_segment = noul(0.05);
  a.speech_kind = choice('on_set', { actual_speech: 0.01, on_set: 0.95, unclear: 0.03, no_transcribed_speech: 0.01 });
  assert.equal(recommend(a, rule('quiet')).recommendation, 'keep');
  a.speech_kind = choice('no_transcribed_speech', { actual_speech: 0.01, on_set: 0, unclear: 0.04, no_transcribed_speech: 0.95 });
  assert.equal(recommend(a, rule('quiet')).recommendation, 'propose');
});

test('user questions run together and gate independently', () => {
  const r = rule(); r.extra = [{ text: 'Mentions the brand?', gate: 'yes' }, { text: 'Contains a false start?', gate: 'info' }, { text: 'Only gibberish?', gate: 'no' }];
  const clip = { path: 'A.MOV', fingerprint: { size: 1, mtimeMs: 1, ino: 1, dev: 1 } };
  const snapshot = workspaceSnapshot({ clips: [clip], folders: [] }, [{ clip, transcript: transcript(clip.fingerprint) }]);
  assert.equal(Object.keys(workspaceQuestionBatch(snapshot, [clip.path], r, { hasCriterion: true, hasReference: false }).questions).length, 7);
  const a = { ...answers(), extra_0: noul(0.4), extra_1: noul(0.99), extra_2: noul(0.01) };
  assert.equal(recommend(a, r).recommendation, 'review');
  a.extra_0 = noul(0.9);
  assert.equal(recommend(a, r).recommendation, 'propose');
});

test('inventory skips hidden files and symlinks, keeps nested videos', async t => {
  const { root, workspace } = await fixture(t, ['A.MOV', 'falas/B.mp4', '.hidden/C.MOV']);
  await fs.symlink(path.join(root, 'A.MOV'), path.join(root, 'link.MOV'));
  assert.deepEqual((await workspace.scan()).map(c => c.path), ['A.MOV', 'falas/B.mp4']);
  await assert.rejects(workspace.resolve('link.MOV'), /Symlink/);
});

test('folder paths reject traversal, absolute paths, controls, hidden and Windows escape forms', () => {
  for (const name of ['../x', '/tmp/x', 'x/../../y', 'C:\\tmp', 'x\ny', '.tisco', 'x/.private', 'a//b', 'a/./b', 'NUL', 'trailing.']) assert.throws(() => validateFolder(name));
  for (const name of ['falas', 'b roll', 'selects/ação']) assert.doesNotThrow(() => validateFolder(name));
  assert.equal(safeDisplay('\x1b[31mBad\nline'), ' [31mBad line');
});

test('workspace locks prevent concurrent mutation and refuse to unlock a live owner', async t => {
  const { workspace } = await fixture(t);
  const release = await workspace.lock();
  await assert.rejects(workspace.lock(), /locked/);
  await assert.rejects(workspace.unlock(), /still running/);
  await release();
  await (await workspace.lock())();
});

test('move carries own and legacy transcripts and undo restores all original bytes', async t => {
  const { workspace, root, clips } = await fixture(t);
  const clip = clips[0];
  await atomicJson(path.join(root, 'A.MOV.tisco.json'), transcript(clip.fingerprint));
  await fs.writeFile(path.join(root, 'A.assemblyai.full.json'), '{}');
  const entries = await workspace.planMoves([clip], 'falas');
  assert.equal(entries.length, 3);
  const journal = await workspace.apply(entries);
  assert.equal(await exists(path.join(root, 'A.MOV')), false);
  assert.equal(await fs.readFile(path.join(root, 'falas/A.MOV'), 'utf8'), 'media A.MOV');
  assert.equal((await workspace.journals())[0].status, 'applied');
  await workspace.undo(journal);
  assert.equal(await fs.readFile(path.join(root, 'A.MOV'), 'utf8'), 'media A.MOV');
  assert.equal(await exists(path.join(root, 'falas/A.MOV')), false);
  assert.equal((await workspace.journals())[0].status, 'undone');
});

test('destination collision blocks entire batch, including a collision introduced after preview', async t => {
  const { workspace, root, clips } = await fixture(t);
  const entries = await workspace.planMoves(clips, 'falas');
  await fs.mkdir(path.join(root, 'falas'));
  await fs.writeFile(path.join(root, 'falas/B.MOV'), 'precious');
  await assert.rejects(workspace.apply(entries), /collision/);
  assert.equal(await exists(path.join(root, 'A.MOV')), true);
  assert.equal(await fs.readFile(path.join(root, 'falas/B.MOV'), 'utf8'), 'precious');
});

test('changed sources invalidate preview and cached transcription', async t => {
  const { workspace, root, clips } = await fixture(t);
  await atomicJson(path.join(root, 'A.MOV.tisco.json'), transcript(clips[0].fingerprint));
  assert.ok(await cachedTranscript(workspace, clips[0]));
  await fs.appendFile(path.join(root, 'A.MOV'), 'changed');
  await assert.rejects(workspace.planMoves(clips, 'falas'), /changed/);
  assert.equal(await cachedTranscript(workspace, (await workspace.scan())[0]), null);
});

test('crash between link and unlink is recoverable without losing the source', async t => {
  const { workspace, root, clips } = await fixture(t);
  const entries = await workspace.planMoves(clips, 'broll');
  const journal = { version: 1, id: 'test-crash', root, status: 'pending', entries };
  await workspace.saveJournal(journal);
  await fs.mkdir(path.join(root, 'broll'));
  await fs.link(path.join(root, 'A.MOV'), path.join(root, 'broll/A.MOV'));
  await assert.rejects(workspace.apply(entries), /pending/);
  await workspace.undo((await workspace.journals())[0]);
  assert.equal(await exists(path.join(root, 'A.MOV')), true);
  assert.equal(await exists(path.join(root, 'broll/A.MOV')), false);
});

test('partially moved batches restore moved files and leave untouched files alone', async t => {
  const { workspace, root, clips } = await fixture(t);
  const entries = await workspace.planMoves(clips, 'broll');
  const journal = { version: 1, id: 'test-partial', root, status: 'pending', entries };
  await workspace.saveJournal(journal);
  await fs.mkdir(path.join(root, 'broll'));
  await fs.rename(path.join(root, 'A.MOV'), path.join(root, 'broll/A.MOV'));
  await workspace.undo(journal);
  assert.equal(await exists(path.join(root, 'A.MOV')), true);
  assert.equal(await exists(path.join(root, 'B.MOV')), true);
});

test('undo refuses changed footage before touching any other file', async t => {
  const { workspace, root, clips } = await fixture(t);
  const journal = await workspace.apply(await workspace.planMoves(clips, 'broll'));
  await fs.appendFile(path.join(root, 'broll/B.MOV'), 'edited');
  await assert.rejects(workspace.undo(journal), /changed file/);
  assert.equal(await exists(path.join(root, 'A.MOV')), false);
});

test('symlink destination cannot escape authorization', async t => {
  const { workspace, root, clips } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'broll'));
  await assert.rejects(workspace.planMoves(clips, 'broll'), /Symlink/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('legacy imports are explicit and preserve compact millisecond words', async t => {
  const { workspace, root, clips } = await fixture(t);
  await atomicJson(path.join(root, 'A.assemblyai.full.json'), { status: 'completed', text: 'Olá', words: [{ text: 'Olá', start: 300, end: 800, confidence: 0.9 }], audio_duration: 2, prompt: 'Olá, Genuíno' });
  assert.equal(await cachedTranscript(workspace, clips[0]), null);
  const imported = await importAssemblyAI(workspace, clips[0]);
  assert.deepEqual(imported.words, [{ text: 'Olá', start: 300, end: 800 }]);
  assert.equal(imported.model, 'imported/assemblyai');
  await atomicJson(path.join(root, 'B.assemblyai.full.json'), { status: 'error', text: '', words: [] });
  await assert.rejects(importAssemblyAI(workspace, clips[1]), /not completed/);
});

test('ambiguous shared-stem transcripts are never assigned or moved silently', async t => {
  const { workspace, root, clips } = await fixture(t, ['A.MOV', 'A.mp4']);
  await fs.writeFile(path.join(root, 'A.assemblyai.full.json'), '{}');
  await assert.rejects(workspace.planMoves(clips, 'broll'), /Ambiguous/);
});

test('retained reference clips cannot be classified as move targets', () => {
  const fingerprint = { size: 1, mtimeMs: 1, ino: 1, dev: 1 };
  const target = { path: 'falas/A.MOV', fingerprint };
  const snapshot = workspaceSnapshot({ clips: [target], folders: ['falas'] }, [{ clip: target, transcript: transcript(fingerprint) }]);
  const r = { ...rule('redundant'), reference: 'falas' };
  assert.throws(() => workspaceQuestionBatch(snapshot, [target.path], r, { hasCriterion: true, hasReference: true }), /retained reference/);
  const outside = { ...target, path: 'A.MOV' };
  const noReference = workspaceSnapshot({ clips: [outside], folders: [] }, [{ clip: outside, transcript: transcript(fingerprint) }]);
  assert.throws(() => workspaceQuestionBatch(noReference, [outside.path], r, { hasCriterion: true, hasReference: false }), /complete retained/);
});

test('real FFmpeg extraction + mocked MAI + Jev + moves + undo end-to-end', async t => {
  try { await exec('ffmpeg', ['-version']); } catch { t.skip('ffmpeg not installed'); return; }
  const { workspace, root } = await fixture(t, []);
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', path.join(root, 'A.mp4')]);
  const [clip] = await workspace.scan();
  let sttCalls = 0;
  const client = new OpenRouter('fake', async (url, init) => {
    if (url.endsWith('/transcriptions')) {
      sttCalls++;
      const body = JSON.parse(init.body);
      assert.ok(Buffer.from(body.input_audio.data, 'base64').length > 100);
      return Response.json({ text: 'Hoje vou ensinar.', words: [{ word: 'Hoje', start: 0, end: 0.2 }, { word: 'vou', start: 0.2, end: 0.4 }, { word: 'ensinar.', start: 0.4, end: 0.9 }], usage: { cost: 0.001 } });
    }
    const body = JSON.parse(init.body);
    const local = answers();
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, local[id.split('__')[1]]])) });
  });
  const first = await transcribeClip(workspace, clip, client, 'Food', 'pt');
  assert.equal(first.words[2].end, 900);
  await transcribeClip(workspace, clip, client, 'Food', 'pt');
  assert.equal(sttCalls, 1);
  const evidence = { clip, transcript: first };
  const snapshot = workspaceSnapshot({ clips: [clip], folders: [] }, [evidence]);
  const batch = workspaceQuestionBatch(snapshot, [clip.path], rule(), { hasCriterion: true, hasReference: false });
  const state = workspaceState(snapshot, { instruction: rule().request, projectContext: rule().context, session: { selection: [], previousResult: [], uncertain: [] } });
  const judgment = workspaceDecisions(batch, await client.decide(state, batch.questions), rule())[0];
  assert.equal(judgment.recommendation, 'propose');
  const journal = await workspace.apply(await workspace.planMoves([clip], 'falas'));
  const [moved] = await workspace.scan();
  assert.ok(await cachedTranscript(workspace, moved));
  await workspace.undo(journal);
  assert.equal(await exists(path.join(root, 'A.mp4')), true);
});
