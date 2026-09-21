import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OpenRouter, STT_MODEL } from './openrouter.js';
import { atomicJson, exists, readJson, Workspace } from './workspace.js';
import { number, object, sameFile, text, words } from './types.js';
import type { Clip, Transcript, Word } from './types.js';

const exec = promisify(execFile);
export const CHUNK_SECONDS = 120;

export async function checkMediaTools(): Promise<void> {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try { await exec(tool, ['-version'], { timeout: 10_000 }); }
    catch { throw new Error(`Install ${tool} and put it on PATH before transcribing.`); }
  }
}

export interface MediaInfo {
  duration: number;
  hasAudio: boolean;
  audio: { rate: number; channels: number; streams: number };
}

export async function probe(file: string): Promise<MediaInfo> {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type,sample_rate,channels', '-of', 'json', file], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const data = object(JSON.parse(stdout));
    const duration = number(Number(object(data.format).duration), 'media duration');
    if (duration <= 0) throw new Error('Empty media.');
    const streams = Array.isArray(data.streams) ? data.streams.map(object) : [];
    const audio = streams.filter(stream => stream.codec_type === 'audio');
    const first = audio[0] ?? {};
    return {
      duration,
      hasAudio: audio.length > 0,
      audio: { rate: Number(first.sample_rate) || 0, channels: Number(first.channels) || 0, streams: audio.length },
    };
  } catch { throw new Error('ffprobe could not read a valid media duration/audio stream.'); }
}

/** STT models are trained at 16 kHz mono. Sending more is waste; sending less is loss. */
export const STT_RATE = 16_000;
export interface AudioProfile { rate: number; channels: 1; bitrate: string }

/**
 * The smallest audio that still carries everything the model can use: mono, never
 * above 16 kHz, never upsampled from a lower-rate source, with a bitrate that fits
 * the resulting rate instead of inflating a narrow recording.
 */
export function audioProfile(source: { rate: number; channels: number }): AudioProfile {
  const rate = source.rate > 0 ? Math.min(source.rate, STT_RATE) : STT_RATE;
  return { rate, channels: 1, bitrate: rate >= STT_RATE ? '64k' : '32k' };
}

function parseAudio(raw: unknown): NonNullable<Transcript['audio']> {
  const data = object(raw);
  return {
    rate: number(data.rate, 'audio rate'), channels: number(data.channels, 'audio channels'), bitrate: text(data.bitrate, 'audio bitrate'),
    sourceRate: number(data.sourceRate, 'source rate'), sourceChannels: number(data.sourceChannels, 'source channels'), streams: number(data.streams, 'audio streams'),
  };
}

export function normalizeStt(raw: unknown, offsetMs: number, durationMs: number): Pick<Transcript, 'words' | 'segments' | 'text' | 'cost'> {
  const data = object(raw);
  const convert = (input: unknown, kind: 'word' | 'text'): Word[] => {
    if (input === undefined) return [];
    if (!Array.isArray(input)) throw new Error('Invalid STT timestamp array.');
    const converted = input.map(item => {
      const w = object(item);
      const start = Math.round(number(w.start, 'STT start') * 1000);
      const end = Math.round(number(w.end, 'STT end') * 1000);
      if (end > durationMs + 1500) throw new Error('STT timestamp exceeds audio chunk duration.');
      return { text: text(w[kind], 'STT word'), start: offsetMs + start, end: offsetMs + end };
    });
    return words(converted);
  };
  return {
    text: text(data.text, 'STT text'),
    words: convert(data.words, 'word'),
    segments: convert(data.segments, 'text'),
    cost: data.usage && object(data.usage).cost !== undefined ? number(object(data.usage).cost, 'STT cost') : 0,
  };
}

export function parseTranscript(raw: unknown): Transcript {
  const data = object(raw);
  if (data.version !== 1 || data.timeUnit !== 'ms' || !['complete', 'no_audio'].includes(String(data.status))) throw new Error('Invalid tisco transcript format.');
  const source = object(data.source);
  const parsed: Transcript = {
    version: 1, model: text(data.model, 'model'),
    source: { size: number(source.size, 'size'), mtimeMs: number(source.mtimeMs, 'mtime'), ino: number(source.ino, 'inode'), dev: number(source.dev, 'device') },
    prompt: text(data.prompt, 'prompt'), timeUnit: 'ms',
    status: data.status as Transcript['status'], text: text(data.text, 'transcript'),
    words: words(data.words), segments: words(data.segments),
    durationMs: number(data.durationMs, 'duration'), timing: data.timing as Transcript['timing'],
    cost: number(data.cost, 'cost'),
    ...(data.audio ? { audio: parseAudio(data.audio) } : {}),
  };
  if (!['word', 'segment', 'none'].includes(parsed.timing)) throw new Error('Invalid timing precision.');
  if (parsed.status === 'no_audio' && (parsed.text.trim() || parsed.words.length || parsed.segments.length)) throw new Error('No-audio transcript contains speech.');
  return parsed;
}

export async function cachedTranscript(workspace: Workspace, clip: Clip): Promise<Transcript | null> {
  await workspace.verify(clip);
  const file = await workspace.resolve(`${clip.path}.tisco.json`);
  if (!(await exists(file))) return null;
  const value = parseTranscript(await readJson(file));
  return sameFile(value.source, clip.fingerprint) ? value : null;
}

export async function importAssemblyAI(workspace: Workspace, clip: Clip): Promise<Transcript | null> {
  const existing = await cachedTranscript(workspace, clip);
  if (existing) return existing;
  const legacy = (await workspace.sidecars(clip)).find(f => f.endsWith('.assemblyai.full.json'));
  if (!legacy) return null;
  const raw = object(await readJson(await workspace.resolve(legacy)));
  if (raw.status !== 'completed') throw new Error(`Legacy transcription is not completed: ${legacy}`);
  const compact = words(raw.words ?? []);
  const transcript: Transcript = {
    version: 1, model: 'imported/assemblyai', source: clip.fingerprint,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    timeUnit: 'ms', status: 'complete', text: text(raw.text, 'legacy text'),
    words: compact, segments: [], durationMs: number(raw.audio_duration ?? 0, 'legacy duration') * 1000,
    timing: compact.length ? 'word' : 'none', cost: 0,
  };
  await workspace.verify(clip);
  await atomicJson(await workspace.resolve(`${clip.path}.tisco.json`), transcript);
  return transcript;
}

export interface AudioChunk { offset: number; duration: number }

/** One chunk of the source, turned into the smallest audio the STT model can use. */
export async function extractAudio(source: string, destination: string, profile: AudioProfile, chunk: AudioChunk): Promise<void> {
  try {
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-ss', String(chunk.offset), '-i', source, '-t', String(chunk.duration), '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', String(profile.channels), '-ar', String(profile.rate), '-c:a', 'libmp3lame', '-b:a', profile.bitrate, '-y', destination], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  } catch { throw new Error('FFmpeg audio extraction failed. Source was not changed.'); }
  if (!(await exists(destination))) throw new Error('FFmpeg reported success without writing audio.');
}

export async function transcribeClip(
  workspace: Workspace, clip: Clip, client: OpenRouter,
  context: string, language: string | undefined,
  progress: (message: string) => void = () => {},
): Promise<Transcript> {
  const cached = await cachedTranscript(workspace, clip);
  if (cached) return cached;
  await workspace.verify(clip);
  const source = await workspace.resolve(clip.path);
  const info = await probe(source);
  const profile = audioProfile(info.audio);
  const transcript: Transcript = {
    version: 1, model: STT_MODEL, source: clip.fingerprint, prompt: context,
    timeUnit: 'ms', status: info.hasAudio ? 'complete' : 'no_audio',
    text: '', words: [], segments: [], durationMs: Math.round(info.duration * 1000), timing: 'none', cost: 0,
    audio: { ...profile, sourceRate: info.audio.rate, sourceChannels: info.audio.channels, streams: info.audio.streams },
  };
  let missingWords = false;
  let missingSegments = false;
  if (info.hasAudio) {
    const temp = await fs.mkdtemp(path.join(tmpdir(), 'tisco-'));
    const cacheKey = createHash('sha256').update(JSON.stringify([clip.fingerprint, STT_MODEL, language ?? '', context, CHUNK_SECONDS, profile.rate, profile.bitrate])).digest('hex');
    try {
      const count = Math.ceil(info.duration / CHUNK_SECONDS);
      for (let index = 0; index < count; index++) {
        progress(`${clip.path} · part ${index + 1}/${count}`);
        const offset = index * CHUNK_SECONDS;
        const duration = Math.min(CHUNK_SECONDS, info.duration - offset);
        const cache = await workspace.resolve(`.tisco/chunk-${cacheKey}-${index}.json`);
        let response: unknown;
        if (await exists(cache)) response = await readJson(cache);
        else {
          const audio = path.join(temp, `${index}.mp3`);
          await extractAudio(source, audio, profile, { offset, duration });
          const buffer = await fs.readFile(audio);
          if (buffer.length > 12 * 1024 * 1024) throw new Error('Extracted audio exceeds chunk size guard.');
          // A chunk with no audio (container longer than its audio track) is skipped, not sent.
          if (buffer.length >= 1024) {
            response = await client.transcribe(buffer, language);
            normalizeStt(response, offset * 1000, duration * 1000);
            await atomicJson(cache, response);
          }
          await fs.unlink(audio);
        }
        const part = response === undefined ? { text: '', words: [], segments: [], cost: 0 } : normalizeStt(response, offset * 1000, duration * 1000);
        if (part.text.trim() && !part.words.length) missingWords = true;
        if (part.text.trim() && !part.segments.length) missingSegments = true;
        transcript.text += (transcript.text ? ' ' : '') + part.text;
        transcript.words.push(...part.words);
        transcript.segments.push(...part.segments);
        transcript.cost += part.cost;
      }
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  // Preserve returned timings, but partial coverage needs full-text context too.
  transcript.timing = transcript.words.length && !missingWords ? 'word' : transcript.segments.length && !missingSegments ? 'segment' : 'none';
  await workspace.verify(clip);
  await atomicJson(await workspace.resolve(`${clip.path}.tisco.json`), transcript);
  return transcript;
}

export interface HostCapabilities {
  ffmpeg: boolean;
  ffprobe: boolean;
  h264: string | null;
  aac: boolean;
}

/** What this machine can actually do, probed once so a request never fails halfway. */
export async function hostCapabilities(): Promise<HostCapabilities> {
  const has = async (tool: string): Promise<boolean> => {
    try { await exec(tool, ['-version'], { timeout: 10_000, maxBuffer: 1 << 20 }); return true; }
    catch { return false; }
  };
  const ffmpeg = await has('ffmpeg');
  const ffprobe = await has('ffprobe');
  let encoders = '';
  if (ffmpeg) {
    try { encoders = (await exec('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 20_000, maxBuffer: 8 << 20 })).stdout; }
    catch { encoders = ''; }
  }
  const h264 = ['libx264', 'h264_videotoolbox', 'h264_nvenc', 'h264_qsv'].find(name => new RegExp(`\\s${name}\\s`).test(encoders)) ?? null;
  return { ffmpeg, ffprobe, h264, aac: /\saac\s/.test(encoders) };
}

/**
 * A review copy: H.264/AAC MP4 that plays anywhere. The source is opened read-only and
 * never replaced; an existing destination is refused rather than overwritten.
 */
export async function exportReview(source: string, destination: string, encoder: string): Promise<void> {
  if (await exists(destination)) throw new Error(`${destination} already exists; it was left untouched.`);
  const { duration } = await probe(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const video = encoder === 'libx264' ? ['-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast'] : ['-c:v', encoder, '-b:v', '12M'];
  await exec('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', source,
    '-map', '0:v:0', '-map', '0:a:0?', ...video, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', destination,
  ], { timeout: Math.max(600_000, duration * 4000), maxBuffer: 1 << 20 });
  if (!(await exists(destination))) throw new Error('ffmpeg reported success without writing the review file.');
}
