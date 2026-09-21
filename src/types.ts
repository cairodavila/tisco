export interface Word { text: string; start: number; end: number }
export interface Fingerprint { size: number; mtimeMs: number; ino: number; dev: number }
export interface Clip { path: string; fingerprint: Fingerprint }
export interface Transcript {
  version: 1;
  model: string;
  source: Fingerprint;
  prompt: string;
  timeUnit: 'ms';
  status: 'complete' | 'no_audio';
  text: string;
  words: Word[];
  segments: Word[];
  durationMs: number;
  timing: 'word' | 'segment' | 'none';
  cost: number;
  /** Exactly what audio was sent to the STT model, and what the source actually had. */
  audio?: { rate: number; channels: number; bitrate: string; sourceRate: number; sourceChannels: number; streams: number };
}
export type Question =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
export type Answers = Record<string, Answer>;
export type Mode = 'scripted' | 'quiet' | 'redundant' | 'custom' | 'all';

/**
 * What a request can ask for that reading what was said cannot decide. Named so the
 * limitation is reported to the user in their own terms instead of a generic "not sure".
 */
export type Unjudgeable = 'picture' | 'sound' | 'measured' | 'without_record';
export interface ExtraQuestion { text: string; gate: 'yes' | 'no' | 'info' }
export interface Rule {
  request: string;
  context: string;
  mode: Mode;
  destination: string;
  reference: string | null;
  threshold: number;
  extra: ExtraQuestion[];
  /** Parts of the request no transcript can decide, when the request mixes them in. */
  unjudgeable?: Unjudgeable[];
}
export interface Evidence { clip: Clip; transcript: Transcript }
export interface Decision {
  path: string;
  answers: Answers;
  recommendation: 'propose' | 'review' | 'keep';
  reason: string;
  error?: string;
  /** Questions whose gate was shut for this clip. Skipped is not `no`. */
  skipped?: { id: string; tier: 0 | 1 | 2; state: 'asked' | 'skipped'; reason: string }[];
  /** True when this judgment was reused from the local decision cache. */
  cached?: boolean;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}
export function probability(value: unknown): number {
  const n = number(value, 'probability');
  if (n > 1) throw new Error('Probability is outside [0, 1].');
  return n;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}.`);
  return value;
}
export function words(value: unknown): Word[] {
  if (!Array.isArray(value)) throw new Error('Expected a timestamp array.');
  let previous = -1;
  return value.map(item => {
    const row = object(item);
    const start = number(row.start, 'start time');
    const end = number(row.end, 'end time');
    if (end < start || start < previous) throw new Error('Invalid timestamp order.');
    previous = start;
    return { text: text(row.text, 'word text'), start, end };
  });
}
export function sameFile(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
}
export function safeDisplay(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
