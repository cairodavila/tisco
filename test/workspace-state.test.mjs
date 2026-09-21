import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceSnapshot, workspaceState } from '../dist/workspace-state.js';

const fingerprint = { size: 12, mtimeMs: 1, ino: 2, dev: 3 };
const clips = [
  { path: 'A.MOV', fingerprint },
  { path: 'broll/B.MOV', fingerprint },
  { path: 'relevant/closeups/C.MOV', fingerprint },
];
const transcript = (text, words = []) => ({
  version: 1, model: 'stt', source: fingerprint, prompt: '', timeUnit: 'ms', status: 'complete',
  text, words, segments: [], durationMs: 1_000, timing: words.length ? 'word' : 'none', cost: 0,
});

test('workspace snapshot preserves the directory tree, clip membership and transcript evidence', () => {
  const snapshot = workspaceSnapshot(
    { clips, folders: ['broll', 'empty', 'relevant', 'relevant/closeups'] },
    [
      { clip: clips[0], transcript: transcript('Root dialogue.') },
      { clip: clips[2], transcript: transcript('A complete line.', [{ text: 'A', start: 0, end: 100 }]) },
    ],
  );

  assert.deepEqual(snapshot.folders, [
    { path: '.', folders: ['broll', 'empty', 'relevant'], videos: ['video_0'], all_videos: ['video_0', 'video_1', 'video_2'] },
    { path: 'broll', folders: [], videos: ['video_1'], all_videos: ['video_1'] },
    { path: 'empty', folders: [], videos: [], all_videos: [] },
    { path: 'relevant', folders: ['relevant/closeups'], videos: [], all_videos: ['video_2'] },
    { path: 'relevant/closeups', folders: [], videos: ['video_2'], all_videos: ['video_2'] },
  ]);
  assert.deepEqual(snapshot.videos.map(video => [video.id, video.path, video.folder, video.transcript.status]), [
    ['video_0', 'A.MOV', '.', 'complete'],
    ['video_1', 'broll/B.MOV', 'broll', 'missing'],
    ['video_2', 'relevant/closeups/C.MOV', 'relevant/closeups', 'complete'],
  ]);
  assert.deepEqual(snapshot.videos[2].transcript.words, [{ text: 'A', start_ms: 0, end_ms: 100 }]);
});

test('workspace decision state includes session relationships without absolute machine paths', () => {
  const snapshot = workspaceSnapshot({ clips, folders: ['broll', 'relevant', 'relevant/closeups'] }, []);
  const state = workspaceState(snapshot, {
    instruction: 'move the results where they belong',
    projectContext: 'campaign',
    session: { selection: ['A.MOV'], previousResult: ['A.MOV', 'broll/B.MOV'], uncertain: ['broll/B.MOV'] },
    selectedVideos: ['A.MOV'],
  });

  assert.equal(state.instruction, 'move the results where they belong');
  assert.deepEqual(state.session.previous_result, ['A.MOV', 'broll/B.MOV']);
  assert.deepEqual(state.selected_videos, ['A.MOV']);
  assert.equal(JSON.stringify(state).includes('/home/'), false);
  assert.match(state.evidence_policy, /evidence/i);
});
