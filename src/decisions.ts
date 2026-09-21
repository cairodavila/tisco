import { OpenRouter } from './openrouter.js';
import { inFolder } from './workspace.js';
import { namingCandidates } from './naming.js';
import { admitted, after, all, always, never, questions, report, answerValue } from './gates.js';
import { clipQuestion, folderRelationQuestions as wireFolderRelationQuestions, routeQuestion, namingQuestions, workspaceClipQuestion } from './jev.js';
import type { Gate, QuestionReport, QuestionSpec } from './gates.js';
import type { Answer, Answers, Decision, Mode, Question, Rule, Unjudgeable } from './types.js';
import type { WorkspaceSnapshot } from './workspace-state.js';

export const MODES: Record<Mode, string> = {
  scripted: 'Prepared, audience-facing dialogue (at least one clean segment)',
  quiet: 'No transcribed speech or predominantly unclear fragments → b-roll candidates',
  redundant: 'Speech already in a retained folder, with no additional meaningful speech',
  custom: 'A custom editorial criterion or topic',
  all: 'Move all selected clips without content filtering',
};
/**
 * The gate table holds ids, tiers and dependencies. The wording is looked up by id in
 * jev.ts, so an id decides how it is asked and the table never spells prose. Route
 * questions use speculative fan-out: they all inspect the same instruction independently,
 * then code reads only the answers relevant to the requested operation.
 */
const ROUTE = 0;

const spec = (id: string, tier: 0 | 1 | 2, gate: Gate, consumes: string[], unlocks: string[]): QuestionSpec => ({
  id, tier, gate, consumes, unlocks,
  question: tier === 0 ? routeQuestion(id, []) : clipQuestion(id),
});
const yesNo = (condition: boolean, reason: string): Gate => (condition ? always : never(reason));

/** One Noul per operation, so a compound request is described rather than rejected. */
const operation = (id: string, unlocks: string[]): QuestionSpec => spec(id, ROUTE, always, ['instruction'], unlocks);

export function routeSpecs(folders: string[]): QuestionSpec[] {
  const specs: QuestionSpec[] = [
    operation('ops_find', ['clip.matches_request']),
    operation('ops_create', []),
    operation('ops_move', []),
    operation('ops_rename', []),
    spec('ops_extract', ROUTE, never('Extracting timestamped moments is not part of this release.'), ['instruction'], []),
    spec('criterion_requested', ROUTE, always, ['instruction'], ['clip.matches_request']),
    spec('target_set', ROUTE, always, ['instruction', 'inventory'], ['clip evidence questions']),
    // A transcript limitation can have several independent causes. Nouls let picture and
    // sound both be true; a Choice would force them to compete.
    spec('spoken_content_decides', ROUTE, always, ['instruction'], []),
    spec('needs_picture', ROUTE, always, ['instruction'], []),
    spec('needs_sound', ROUTE, always, ['instruction'], []),
    spec('needs_measurement', ROUTE, always, ['instruction'], []),
    spec('needs_external_record', ROUTE, always, ['instruction'], []),
  ];
  if (folders.length) specs.push(spec('reference_set', ROUTE, always, ['instruction', 'inventory'], ['clip.speech_already_in_reference', 'clip.other_speech_not_in_reference']));
  return specs.map(item => ({ ...item, question: routeQuestion(item.id, folders) }));
}

export function routeQuestions(folders: string[]): Record<string, Question> {
  return questions(routeSpecs(folders));
}

export interface ClipOptions {
  hasCriterion: boolean;
  hasReference: boolean;
}

/**
 * Tier 1 (per clip) and tier 2 (only for the subset tier 1 admits). Gates read earlier
 * answers, so a request with no criterion never pays for a criterion judgment, and a
 * clip with no prepared segment is never asked which take is cleanest.
 */
export function clipSpecs(rule: Rule, options: ClipOptions): QuestionSpec[] {
  const filters = rule.mode !== 'all';
  const off = 'This request does not filter content; no judgment is needed.';
  const specs: QuestionSpec[] = [
    spec('matches_request', 1, yesNo(filters && options.hasCriterion, filters ? 'the request states no content criterion' : off), ['instruction', 'project_context', 'current_video', 'unjudgeable'], ['clip.cleanest_take']),
    spec('has_scripted_segment', 1, yesNo(filters, off), ['project_context', 'current_video'], ['clip.cleanest_take']),
    spec('has_incomplete_speech', 1, yesNo(filters, off), ['current_video'], []),
    spec('speech_kind', 1, yesNo(filters, off), ['current_video'], []),
    spec('speech_already_in_reference', 1, yesNo(filters && options.hasReference, 'no retained reference set was chosen'), ['current_video', 'reference_videos'], ['clip.duplicate_of']),
    spec('other_speech_not_in_reference', 1, yesNo(filters && options.hasReference, 'no retained reference set was chosen'), ['current_video', 'reference_videos'], []),
  ];
  rule.extra.forEach((_, index) => specs.push(spec(`extra_${index}`, 1, yesNo(filters, off), ['instruction', 'current_video'], [])));
  // Questions in one request are independent: they see the same state and never each other.
  // Tier 2 reads tier 1 only by being asked in a later request, once tier 1 has answered.
  // Extraction is not in this release, so these two stay shut and say why.
  const release = 'Extracting timestamped moments is not part of this release.';
  specs.push(spec('cleanest_take', 2, all(after('has_scripted_segment', ['yes']), never(release)), ['current_video'], []));
  specs.push(spec('duplicate_of', 2, all(after('speech_already_in_reference', ['yes']), never(release)), ['current_video', 'reference_videos'], []));
  return specs.map(item => ({ ...item, question: clipQuestion(item.id, item.id.startsWith('extra_') ? rule.extra[Number(item.id.slice(6))]?.text : undefined) }));
}

/** The exact ids this request would send for a clip; shown in gate reports and cache metadata. */
export function clipQuestionIds(rule: Rule, options: ClipOptions): string[] {
  return admitted(clipSpecs(rule, options), {}).filter(spec => spec.tier === 1).map(spec => spec.id).sort((a, b) => a.localeCompare(b));
}

export async function workspaceRouteRequest(client: OpenRouter, state: Record<string, unknown>, request: string, folders: string[]): Promise<Answers> {
  const asked = admitted(routeSpecs(folders), {});
  return client.decide(state, { ...questions(asked), ...namingQuestions(namingCandidates(request)) });
}

/**
 * The feasibility verdict, read fail-open: a missing answer never refuses a request.
 *
 * A request is `limited` when it asks for something reading what was said cannot decide
 * (a look, a sound, a measurement, history or taste) and the spoken part is not a
 * confident yes — the same reading the rest of the product gives an answer. Judging a
 * request like that would return nothing but near-ties, so it is refused with a reason
 * instead. Anything else is judged: with `limited` false and an aspect named, the request
 * does have a spoken part, and that part is judged while the rest is set aside.
 */
export const ASPECT_QUESTIONS: Record<Unjudgeable, string> = {
  picture: 'needs_picture',
  sound: 'needs_sound',
  measured: 'needs_measurement',
  without_record: 'needs_external_record',
};
export const ASPECTS = Object.keys(ASPECT_QUESTIONS) as Unjudgeable[];

export function feasibilityFromRoute(route: Answers, threshold = 0.8): { spoken: boolean; aspects: Unjudgeable[]; limited: boolean } {
  const spoken = route.spoken_content_decides;
  const decidable = !spoken || spoken.type !== 'noul' || spoken.noul >= threshold;
  const aspects = ASPECTS.filter(aspect => {
    const answer = route[ASPECT_QUESTIONS[aspect]];
    return answer?.type === 'noul' && answer.noul >= threshold;
  });
  return { spoken: decidable, aspects, limited: aspects.length > 0 && !decidable };
}

export const routeYes = (answers: Answers, id: string): boolean => answerValue(answers[id]) === 'yes';

export function referenceFromRoute(route: Answers, folders: string[]): string | null {
  const answer = route.reference_set;
  if (!answer || answer.type !== 'choice' || answer.choice === 'none') return null;
  const index = Number(answer.choice.replace('folder_', ''));
  return folders[index] ?? null;
}

export type RouteScope = 'all_here' | 'root_only' | 'include_subfolders' | 'current_selection' | 'previous_result' | `folder_${number}` | 'missing';

export function scopeFromRoute(route: Answers): RouteScope {
  const answer = route.target_set;
  return answer && answer.type === 'choice' ? answer.choice as RouteScope : 'missing';
}

/** Default preset from the request itself; the user can change it before any judgment runs. */
export function modeFromRoute(route: Answers, reference: string | null): Mode {
  const criterion = routeYes(route, 'criterion_requested') || routeYes(route, 'ops_find');
  if (!criterion) return 'all';
  return reference ? 'redundant' : 'custom';
}

export function p(answers: Answers, key: string): number {
  const answer = answers[key];
  if (!answer || answer.type !== 'noul') throw new Error(`Missing Noul answer: ${key}`);
  return answer.noul;
}

/** A skipped question contributes no check. It is not evidence for or against a clip. */
function optional(answers: Answers, key: string): number | undefined {
  const answer = answers[key];
  return answer && answer.type === 'noul' ? answer.noul : undefined;
}

export function recommend(answers: Answers, rule: Rule): Pick<Decision, 'recommendation' | 'reason'> {
  if (!(rule.threshold > 0.5 && rule.threshold < 1)) throw new Error('Threshold must be between 0.5 and 1 (exclusive).');
  const yes = rule.threshold;
  const no = 1 - yes;
  const checks: number[] = [];
  const push = (value: number | undefined) => { if (value !== undefined) checks.push(value); };
  if (rule.mode === 'scripted') { push(optional(answers, 'has_scripted_segment')); push(optional(answers, 'matches_request')); }
  if (rule.mode === 'custom') push(optional(answers, 'matches_request'));
  if (rule.mode === 'redundant') { push(optional(answers, 'speech_already_in_reference')); const novel = optional(answers, 'other_speech_not_in_reference'); if (novel !== undefined) checks.push(1 - novel); }
  if (rule.mode === 'quiet') {
    const speech = answers.speech_kind;
    if (!speech || speech.type !== 'choice') throw new Error('Missing speech kind.');
    checks.push((speech.probabilities.no_transcribed_speech ?? 0) + (speech.probabilities.unclear ?? 0));
    const scripted = optional(answers, 'has_scripted_segment');
    if (scripted !== undefined) checks.push(1 - scripted);
  }
  rule.extra.forEach((q, i) => {
    if (q.gate === 'info') return;
    const value = optional(answers, `extra_${i}`);
    if (value !== undefined) checks.push(q.gate === 'yes' ? value : 1 - value);
  });
  if (!checks.length) return { recommendation: 'review', reason: 'No gated question applies to this request; nothing was judged.' };
  if (checks.every(value => value >= yes - 1e-9)) return { recommendation: 'propose', reason: `All required signals meet ${yes.toFixed(2)}. Preview only; confirmation required.` };
  if (checks.some(value => value <= no + 1e-9)) return { recommendation: 'keep', reason: `At least one required signal is ≤ ${no.toFixed(2)}.` };
  return { recommendation: 'review', reason: `Evidence falls between ${no.toFixed(2)} and ${yes.toFixed(2)}; not auto-selected.` };
}

export interface WorkspaceQuestionEntry {
  path: string;
  videoId: string;
  videoIndex: number;
  specs: QuestionSpec[];
}

export interface WorkspaceQuestionBatch {
  questions: Record<string, Question>;
  entries: WorkspaceQuestionEntry[];
}

export function workspaceQuestionBatch(snapshot: WorkspaceSnapshot, paths: string[], rule: Rule, options: ClipOptions): WorkspaceQuestionBatch {
  if (rule.reference && paths.some(path => inFolder(path, rule.reference!))) throw new Error('A retained reference cannot also be a move target.');
  if (rule.mode === 'redundant' && (!rule.reference || !snapshot.videos.some(video => inFolder(video.path, rule.reference!)))) throw new Error('Redundancy requires a complete retained reference set.');
  const wanted = new Set(paths);
  const entries = snapshot.videos.flatMap((video, videoIndex): WorkspaceQuestionEntry[] => {
    if (!wanted.has(video.path)) return [];
    const specs = admitted(clipSpecs(rule, options), {}).filter(spec => spec.tier === 1);
    return [{ path: video.path, videoId: video.id, videoIndex, specs }];
  });
  const found = new Set(entries.map(entry => entry.path));
  const missing = paths.filter(path => !found.has(path));
  if (missing.length) throw new Error(`Workspace state is missing selected clips: ${missing.join(', ')}`);
  return {
    entries,
    questions: Object.fromEntries(entries.flatMap(entry => entry.specs.map(spec => [
      `${entry.videoId}__${spec.id}`,
      workspaceClipQuestion(spec.id, entry.videoIndex, spec.id.startsWith('extra_') ? rule.extra[Number(spec.id.slice(6))]?.text : undefined),
    ]))),
  };
}

export function workspaceDecisions(batch: WorkspaceQuestionBatch, answers: Answers, rule: Rule): Decision[] {
  return batch.entries.map(entry => {
    const local = Object.fromEntries(entry.specs.map(spec => {
      const answer = answers[`${entry.videoId}__${spec.id}`];
      if (!answer) throw new Error(`Missing workspace answer for ${entry.path}: ${spec.id}`);
      return [spec.id, answer];
    }));
    return { path: entry.path, answers: local, ...recommend(local, rule), skipped: report(clipSpecs(rule, {
      hasCriterion: entry.specs.some(spec => spec.id === 'matches_request'),
      hasReference: entry.specs.some(spec => spec.id === 'speech_already_in_reference'),
    }), local) };
  });
}

export interface FolderRelationBatch {
  folders: string[];
  questions: Record<string, Question>;
}

export function folderRelationBatch(snapshot: WorkspaceSnapshot, selectedPaths: string[], candidates?: string[]): FolderRelationBatch {
  const selected = new Set(selectedPaths);
  const byId = new Map(snapshot.videos.map(video => [video.id, video.path]));
  const available = snapshot.folders.filter(folder => folder.path !== '.' && folder.all_videos.length > 0)
    .filter(folder => !folder.all_videos.every(id => selected.has(byId.get(id) ?? '')))
    .map(folder => folder.path);
  const folders = candidates ? candidates.filter(folder => available.includes(folder)) : available;
  return { folders, questions: wireFolderRelationQuestions(folders) };
}

export function folderSuggestion(batch: FolderRelationBatch, answers: Answers, threshold = 0.8): { folder: string; choiceProbability: number; relationProbability: number } | undefined {
  const choice = answers.destination_folder;
  if (!choice || choice.type !== 'choice' || choice.choice === 'none') return undefined;
  const match = /^folder_(\d+)$/.exec(choice.choice);
  if (!match) return undefined;
  const index = Number(match[1]);
  const relation = answers[`folder_${index}_related`];
  const choiceProbability = choice.probabilities[choice.choice] ?? 0;
  const relationProbability = relation?.type === 'noul' ? relation.noul : 0;
  const folder = batch.folders[index];
  return folder && choiceProbability >= threshold && relationProbability >= threshold ? { folder, choiceProbability, relationProbability } : undefined;
}

export function answerLabel(answer: Answer): string {
  return answer.type === 'noul' ? answer.noul.toFixed(2) : `${answer.choice} (${(answer.probabilities[answer.choice] ?? 0).toFixed(2)})`;
}

export function questionReport(specs: QuestionSpec[], answers: Answers): QuestionReport[] {
  return report(specs, answers);
}
