/**
 * Declarative question gates. Jev answers questions; it never decides whether a
 * question should be asked. Code owns the gate, so a model cannot widen its own scope.
 *
 * A gate is a condition on earlier answers. Tier 0 decides what to ask per clip;
 * Tier 1 answers unlock Tier 2. A question whose gate is shut is reported as
 * not_applicable — which is not `no`, and must never be read as negative evidence.
 */
import type { Answer, Answers, Question } from './types.js';

export type Gate =
  | { kind: 'always' }
  | { kind: 'never'; reason: string }
  | { kind: 'after'; id: string; values: string[] }
  | { kind: 'all'; gates: Gate[] }
  | { kind: 'any'; gates: Gate[] };

export const always: Gate = { kind: 'always' };
export const never = (reason: string): Gate => ({ kind: 'never', reason });
export const after = (id: string, values: string[]): Gate => ({ kind: 'after', id, values });
export const all = (...gates: Gate[]): Gate => ({ kind: 'all', gates });
export const any = (...gates: Gate[]): Gate => ({ kind: 'any', gates });

export interface QuestionSpec {
  id: string;
  tier: 0 | 1 | 2;
  gate: Gate;
  question: Question;
  /** States this question reads. */
  consumes: string[];
  /** What answering it makes askable. */
  unlocks: string[];
}

export interface QuestionReport {
  id: string;
  tier: 0 | 1 | 2;
  state: 'asked' | 'skipped';
  reason: string;
}

/** 'yes'/'no' for a Noul, the chosen option for a Choice. */
export function answerValue(answer: Answer | undefined): string | undefined {
  if (!answer) return undefined;
  if (answer.type === 'choice') return answer.choice;
  return answer.noul >= 0.5 ? 'yes' : 'no';
}

export function gateSatisfied(gate: Gate, answers: Answers): boolean {
  switch (gate.kind) {
    case 'always': return true;
    case 'never': return false;
    case 'after': {
      const value = answerValue(answers[gate.id]);
      return value !== undefined && gate.values.includes(value);
    }
    case 'all': return gate.gates.every((child) => gateSatisfied(child, answers));
    case 'any': return gate.gates.some((child) => gateSatisfied(child, answers));
  }
}

/** Why a gate is shut, for display. */
export function gateReason(gate: Gate, answers: Answers): string | undefined {
  switch (gate.kind) {
    case 'always': return undefined;
    case 'never': return gate.reason;
    case 'after': {
      const value = answerValue(answers[gate.id]);
      if (value === undefined) return `${gate.id} was not answered`;
      return gate.values.includes(value) ? undefined : `${gate.id} is ${value}`;
    }
    case 'all': {
      for (const child of gate.gates) {
        const reason = gateReason(child, answers);
        if (reason) return reason;
      }
      return undefined;
    }
    case 'any': {
      if (gate.gates.some((child) => gateSatisfied(child, answers))) return undefined;
      return gate.gates.map((child) => gateReason(child, answers) ?? 'not met').join(' and ');
    }
  }
}

export function admitted(specs: QuestionSpec[], answers: Answers): QuestionSpec[] {
  return specs.filter((spec) => gateSatisfied(spec.gate, answers));
}

export function report(specs: QuestionSpec[], answers: Answers): QuestionReport[] {
  return specs.map((spec) => {
    const reason = gateReason(spec.gate, answers);
    return { id: spec.id, tier: spec.tier, state: reason === undefined ? 'asked' : 'skipped', reason: reason ?? 'gate met' };
  });
}

export function questions(specs: QuestionSpec[]): Record<string, Question> {
  return Object.fromEntries(specs.map((spec) => [spec.id, spec.question]));
}

export function byTier(specs: QuestionSpec[], tier: 0 | 1 | 2): QuestionSpec[] {
  return specs.filter((spec) => spec.tier === tier);
}

/** Every question id a gate tree reads. */
export function gateInputs(gate: Gate): string[] {
  switch (gate.kind) {
    case 'after': return [gate.id];
    case 'all':
    case 'any': return gate.gates.flatMap(gateInputs);
    default: return [];
  }
}
