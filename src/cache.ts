import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { Workspace, atomicJson, exists, readJson } from './workspace.js';
import { object } from './types.js';
import type { Decision } from './types.js';

/**
 * A judgment is reused only when everything that produced the model answer is unchanged:
 * the model, request, project context, preset, reference folder, exact question wording,
 * clip, and transcript fingerprints. The policy threshold is deliberately absent: code
 * can recompute a recommendation from the same probabilities without paying for inference.
 */
export interface DecisionKeyParts {
  model: string;
  request: string;
  context: string;
  mode: string;
  reference: string | null;
  /** Parts of the request no transcript can decide, when there are any. */
  unjudgeable?: string[];
  questions: string[];
  questionSignature: string;
  clip: Transcript;
  references: Transcript[];
}

export interface Transcript {
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}

export function decisionKey(parts: DecisionKeyParts): string {
  const canonical = { ...parts, unjudgeable: parts.unjudgeable ? [...parts.unjudgeable].sort((a, b) => a.localeCompare(b)) : undefined, questions: [...parts.questions].sort((a, b) => a.localeCompare(b)), references: [...parts.references].sort((a, b) => a.path.localeCompare(b.path)) };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

const dir = '.tisco/decisions';

export async function cachedDecision(workspace: Workspace, key: string): Promise<Decision | undefined> {
  const file = await workspace.resolve(`${dir}/${key}.json`);
  if (!(await exists(file))) return undefined;
  const value = object(await readJson(file));
  if (value.version !== 1 || value.key !== key) throw new Error('Invalid decision cache entry.');
  const decision = object(value.decision);
  if (typeof decision.path !== 'string' || typeof decision.recommendation !== 'string' || !['propose', 'review', 'keep'].includes(decision.recommendation) || typeof decision.reason !== 'string' || !decision.answers || typeof decision.answers !== 'object') {
    throw new Error('Invalid cached decision.');
  }
  // SAFETY: the cache key binds this record to locally validated provider answers, and
  // the required Decision fields were checked above before any value is returned.
  return { ...(decision as unknown as Decision), cached: true };
}

export async function saveDecision(workspace: Workspace, key: string, decision: Decision): Promise<void> {
  const at = await workspace.resolve(dir);
  await fs.mkdir(at, { recursive: true, mode: 0o700 });
  await atomicJson(await workspace.resolve(`${dir}/${key}.json`), { version: 1, key, decision: { ...decision, cached: undefined } });
}
