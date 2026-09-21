import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportReview, hostCapabilities, probe } from '../dist/media.js';

const exec = promisify(execFile);

async function source(dir) {
  const file = path.join(dir, 'take.mov');
  await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  return file;
}

test('a review MP4 is portable, additive, and never overwrites', async () => {
  const caps = await hostCapabilities();
  if (!caps.ffmpeg || !caps.ffprobe || !caps.h264) return; // host without ffmpeg: nothing to check
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-export-'));
  const from = await source(dir);
  const before = await fs.stat(from);
  const to = path.join(dir, 'review', 'take.mp4');

  await exportReview(from, to, caps.h264);
  const { duration, hasAudio } = await probe(to);
  assert.ok(duration > 0.5 && duration < 1.6, `duration ${duration}`);
  assert.equal(hasAudio, true);
  const after = await fs.stat(from);
  assert.equal(after.size, before.size, 'the source is untouched');
  const head = (await fs.readFile(to)).subarray(4, 8).toString('latin1');
  assert.equal(head, 'ftyp', 'the output is an ISO media file');

  await assert.rejects(() => exportReview(from, to, caps.h264), /already exists/);
});
