import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { audioProfile, extractAudio, hostCapabilities, probe, STT_RATE } from '../dist/media.js';

const exec = promisify(execFile);

async function makeSource(dir, name, args) {
  const file = path.join(dir, name);
  await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args, file]);
  return file;
}

const hasTools = (await hostCapabilities()).ffmpeg;

function audioArgs(extra = []) {
  return ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', ...extra];
}

test('answers what the source really has, so nothing is upsampled or upmixed', async () => {
  assert.deepEqual(audioProfile({ rate: 48_000, channels: 2 }), { rate: STT_RATE, channels: 1, bitrate: '64k' });
  assert.deepEqual(audioProfile({ rate: 8_000, channels: 1 }), { rate: 8_000, channels: 1, bitrate: '32k' });
  assert.deepEqual(audioProfile({ rate: 11_025, channels: 2 }), { rate: 11_025, channels: 1, bitrate: '32k' });
  assert.deepEqual(audioProfile({ rate: 0, channels: 0 }), { rate: STT_RATE, channels: 1, bitrate: '64k' });
});

test('a 48 kHz stereo source becomes mono 16 kHz mp3, far smaller, source untouched', { skip: !hasTools }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-audio-'));
  const source = await makeSource(dir, 'take.mov', [...audioArgs(), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le']);
  const before = await fs.stat(source);
  const info = await probe(source);
  assert.equal(info.audio.rate, 48_000);
  assert.equal(info.audio.channels, 2);
  assert.equal(info.audio.streams, 1);
  assert.equal(info.hasAudio, true);

  const profile = audioProfile(info.audio);
  const out = path.join(dir, 'chunk.mp3');
  await extractAudio(source, out, profile, { offset: 0, duration: info.duration });
  const sent = (await fs.stat(out)).size;
  const rawAudioBytes = info.duration * 48_000 * 2 * 2; // pcm_s16le, 2 channels
  assert.equal((await fs.stat(source)).size, before.size, 'the source is untouched');
  assert.ok(sent < rawAudioBytes / 20, `expected at least 20x smaller, got ${sent} vs ${rawAudioBytes}`);

  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate', '-of', 'json', out]);
  const stream = JSON.parse(stdout).streams[0];
  assert.equal(stream.codec_name, 'mp3', 'mp3 is what the STT endpoint accepts as format "mp3"');
  assert.equal(stream.sample_rate, '16000');
  assert.equal(stream.channels, 1);
  assert.equal(stream.bit_rate, '64000');
});

test('a narrow source is not inflated', { skip: !hasTools }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-audio-'));
  const source = await makeSource(dir, 'narrow.wav', [...audioArgs(), '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le']);
  const info = await probe(source);
  const profile = audioProfile(info.audio);
  assert.deepEqual(profile, { rate: 8_000, channels: 1, bitrate: '32k' });
  const out = path.join(dir, 'chunk.mp3');
  await extractAudio(source, out, profile, { offset: 0, duration: info.duration });
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,bit_rate', '-of', 'json', out]);
  assert.equal(JSON.parse(stdout).streams[0].sample_rate, '8000');
});

test('a second chunk starts at its own offset', { skip: !hasTools }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-audio-'));
  const source = await makeSource(dir, 'long.wav', ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=5', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le']);
  const profile = audioProfile({ rate: 48_000, channels: 2 });
  const out = path.join(dir, 'chunk1.mp3');
  await extractAudio(source, out, profile, { offset: 2, duration: 2 });
  const { duration } = await probe(out);
  assert.ok(Math.abs(duration - 2) < 0.2, `chunk duration ${duration}`);
});

test('footage named by TISCO_TEST_FOOTAGE is measured, never uploaded', { skip: !hasTools || !process.env.TISCO_TEST_FOOTAGE }, async () => {
  const root = process.env.TISCO_TEST_FOOTAGE;
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const videos = entries.filter(entry => entry.isFile() && /\.(mov|mp4|m4v|mts)$/i.test(entry.name));
  assert.ok(videos.length, 'no footage found');
  let sourceBytes = 0;
  let sentBytes = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-audio-'));
  for (const entry of videos) {
    const source = path.join(entry.parentPath ?? root, entry.name);
    const info = await probe(source);
    const profile = audioProfile(info.audio);
    const out = path.join(dir, path.basename(source) + '.mp3');
    await extractAudio(source, out, profile, { offset: 0, duration: info.duration });
    sourceBytes += (await fs.stat(source)).size;
    sentBytes += (await fs.stat(out)).size;
  }
  console.log(`${videos.length} clips: ${(sourceBytes / 1e6).toFixed(1)} MB of source -> ${(sentBytes / 1e6).toFixed(2)} MB of audio to send (${(100 * sentBytes / sourceBytes).toFixed(2)}%)`);
});
