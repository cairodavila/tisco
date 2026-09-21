import * as path from 'node:path';
import * as ui from '@clack/prompts';
import { Workspace, inFolder, validateFolder } from './workspace.js';
import { JEV_MODEL, OpenRouter } from './openrouter.js';
import { analyzeClip, answerLabel, clipQuestionIds, clipQuestionSignature, feasibilityFromRoute, modeFromRoute, recommend, referenceFromRoute, routeRequest, routeYes, scopeFromRoute } from './decisions.js';
import { buildPlan, executePlan, validateSuffix } from './plan.js';
import { chosenName, namingCandidates, suggestedStem, transcriptText, validateStem } from './naming.js';
import { findingLabel, findingLines, findingSummary } from './findings.js';
import { cachedDecision, decisionKey, saveDecision } from './cache.js';
import { approveReady, approveWithDependencies, blockedActions, blockedReason, executionOrder, readyActions, setApproved } from './actions.js';
import { cachedTranscript, checkMediaTools, exportReview, hostCapabilities, importAssemblyAI, transcribeClip } from './media.js';
import { ask, confirm, errorMessage, input, Cancelled } from './ask.js';
import { safeDisplay } from './types.js';
import type { Clip, Decision, Evidence, Mode, Rule, Unjudgeable } from './types.js';
import type { Plan, PlanAction } from './actions.js';
import type { PlanIntent, RenameSpec } from './plan.js';

export interface LoopDeps {
  workspace: Workspace;
  root: string;
  getClient: () => Promise<OpenRouter>;
  configureKey: () => Promise<void>;
  getContext: () => string;
  setContext: (value: string) => Promise<void>;
}

export async function chooseClips(clips: Clip[], message: string, initial: string[] = []): Promise<Clip[]> {
  if (!clips.length) throw new Error('No eligible video files.');
  const selected = await ask(ui.multiselect({
    message,
    options: clips.map(clip => ({ value: clip.path, label: safeDisplay(clip.path), hint: `${(clip.fingerprint.size / 1024 / 1024).toFixed(1)} MB` })),
    initialValues: initial, maxItems: 14, required: true,
  }));
  return clips.filter(clip => selected.includes(clip.path));
}

export async function loadEvidence(workspace: Workspace, clips: Clip[]): Promise<Evidence[]> {
  const result: Evidence[] = [];
  for (const clip of clips) {
    const transcript = await cachedTranscript(workspace, clip);
    if (transcript) result.push({ clip, transcript });
  }
  return result;
}

export interface TranscribeOptions {
  /** True when the caller already asked and was told yes, so the upload is not confirmed twice. */
  confirmed?: boolean;
}

export async function ensureTranscripts(workspace: Workspace, clips: Clip[], getClient: () => Promise<OpenRouter>, context: string, options: TranscribeOptions = {}): Promise<Evidence[]> {
  const known = await loadEvidence(workspace, clips);
  let missing = clips.filter(clip => !known.some(item => item.clip.path === clip.path));
  if (!missing.length) return known;
  const legacy: Clip[] = [];
  for (const clip of missing) if ((await workspace.sidecars(clip)).some(file => file.endsWith('.assemblyai.full.json'))) legacy.push(clip);
  if (legacy.length && await confirm(`Import ${legacy.length} existing AssemblyAI sidecars locally? No API call.`, true)) {
    for (const clip of legacy) {
      try {
        const transcript = await importAssemblyAI(workspace, clip);
        if (transcript) known.push({ clip, transcript });
      } catch (error) { ui.log.warn(`${safeDisplay(clip.path)}: ${errorMessage(error)}`); }
    }
    missing = clips.filter(clip => !known.some(item => item.clip.path === clip.path));
  }
  if (!missing.length) return known;
  await checkMediaTools();
  ui.note(`${missing.length} clip(s) need transcription. Cached clips are reused.\nAudio is extracted locally, then uploaded to OpenRouter / MAI Transcribe 2. This is billed.`, 'Before upload');
  const language = await ask(ui.text({ message: 'Speech language (ISO code, e.g. pt). Blank = auto.', validate: value => value && !/^[a-z]{2}$/.test(value) ? 'Use two lowercase letters, or leave blank.' : undefined }));
  if (!options.confirmed && !(await confirm('Upload audio from these selected clips to OpenRouter?'))) throw new Cancelled();
  const client = await getClient();
  let cancelled = false;
  const spinner = ui.spinner({ onCancel: () => { cancelled = true; } });
  spinner.start('Transcribing · Ctrl+C stops after the current request');
  const failures: string[] = [];
  try {
    for (const clip of missing) {
      if (cancelled) break;
      try {
        known.push({ clip, transcript: await transcribeClip(workspace, clip, client, context, language || undefined, message => {
          if (cancelled) throw new Cancelled();
          spinner.message(safeDisplay(message));
        }) });
      } catch (error) {
        if (error instanceof Cancelled) break;
        failures.push(`${safeDisplay(clip.path)}: ${errorMessage(error)}`);
      }
    }
  } finally { spinner.stop(`${known.length}/${clips.length} clips have complete transcripts.`); }
  for (const failure of failures) ui.log.warn(failure);
  if (cancelled) throw new Cancelled();
  if (known.length !== clips.length) throw new Error('Some transcripts failed. They were not labelled silent. Retry before judging this set.');
  return known;
}

export async function undoLatest(workspace: Workspace): Promise<void> {
  const journals = await workspace.journals();
  const journal = journals.find(item => item.status === 'pending') ?? journals.find(item => item.status === 'applied');
  if (!journal) { ui.log.info('No move to undo.'); return; }
  ui.note(journal.entries.map(entry => `${safeDisplay(entry.to)} → ${safeDisplay(entry.from)}`).join('\n'), journal.status === 'pending' ? 'Recover interrupted move' : 'Undo latest move');
  if (await confirm('Restore these files? Any changed file or collision blocks recovery.')) {
    await workspace.undo(journal);
    ui.log.success('Original paths restored.');
  }
}

export interface SessionState {
  selection: string[];
  lastResult: string[];
  uncertain: string[];
  findings: Decision[];
  evidence: Evidence[];
  request: string;
}

const OPERATIONS = ['find', 'create', 'move', 'rename'] as const;
type Op = (typeof OPERATIONS)[number];

interface Interpretation {
  request: string;
  operations: Record<Op, boolean>;
  criterion: boolean;
  scope: string;
  reference: string | null;
  mode: Mode;
  folder?: string;
  suffix?: string;
  /** False when nothing the request asks for can be decided from what was said. */
  spoken: boolean;
  aspects: Unjudgeable[];
  /** True when the request asks only for things a transcript cannot decide: refuse it. */
  limited: boolean;
}

/** What a transcript cannot decide, in the words the user used when they asked for it. */
const ASPECT_LIMIT: Record<Unjudgeable, string> = {
  picture: 'how the footage looks — framing, focus, lighting, what is visible — which needs watching the picture',
  sound: 'how the footage sounds — noise, wind, echo, loudness — which needs listening to the audio',
  measured: 'a measurement of the files — duration, resolution, time of day — which is not part of this release',
  without_record: 'something that is in neither the footage nor the files — which clip was used before, or which take someone will like best',
};

function foldersIn(clips: Clip[]): string[] {
  return [...new Set(clips.flatMap(clip => {
    const parts = clip.path.split('/').slice(0, -1);
    return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  }))].sort();
}

function defaultFolder(mode: Mode): string {
  if (mode === 'quiet') return 'broll';
  if (mode === 'redundant') return 'redundant';
  if (mode === 'all') return 'selects';
  return 'falas';
}

export function resolveScope(clips: Clip[], scope: string, state: SessionState): { candidates: Clip[]; from: string } {
  const topLevel = clips.filter(clip => !clip.path.includes('/'));
  if (scope === 'all_here' || scope === 'root_only') return { candidates: topLevel, from: 'clips directly in this folder' };
  if (scope === 'include_subfolders') return { candidates: clips, from: 'clips here and in subfolders' };
  if (scope === 'current_selection') return { candidates: clips.filter(clip => state.selection.includes(clip.path)), from: 'the current selection' };
  if (scope === 'previous_result') return { candidates: clips.filter(clip => state.lastResult.includes(clip.path)), from: 'the previous result (review rows still need approval)' };
  if (/^folder_\d+$/.test(scope)) {
    const folder = foldersIn(clips)[Number(scope.slice('folder_'.length))];
    if (folder) return { candidates: clips.filter(clip => inFolder(clip.path, folder)), from: `the named folder ${JSON.stringify(folder)}` };
  }
  return { candidates: [], from: 'an unresolved scope' };
}

async function interpretRequest(client: OpenRouter, request: string, clips: Clip[]): Promise<Interpretation> {
  const folders = foldersIn(clips);
  const route = await routeRequest(client, request, folders, clips.length);
  const operations = Object.fromEntries(OPERATIONS.map(op => [op, routeYes(route, `ops_${op}`)])) as Record<Op, boolean>;
  const reference = referenceFromRoute(route, folders);
  const feasibility = feasibilityFromRoute(route);
  const criterion = routeYes(route, 'criterion_requested') || operations.find;
  return {
    request, operations, criterion,
    scope: scopeFromRoute(route), reference, mode: modeFromRoute(route, reference),
    folder: chosenName(route, 'destination_name', namingCandidates(request)),
    suffix: chosenName(route, 'rename_suffix', namingCandidates(request)),
    spoken: feasibility.spoken, aspects: criterion ? feasibility.aspects : [], limited: criterion && feasibility.limited,
  };
}

const describe = (action: PlanAction): string => {
  if (action.operation === 'mkdir') return `CREATE ${safeDisplay(action.afterPath)}/`;
  return `${action.operation.toUpperCase()} ${safeDisplay(action.beforePath ?? '')} → ${safeDisplay(action.afterPath)}\n    ${safeDisplay(action.title)}`;
};

function previewPlan(plan: Plan): void {
  const ready = new Set(readyActions(plan).map(action => action.id));
  const blocked = new Map(plan.actions.flatMap(action => {
    const reason = action.blocked ?? (action.approved ? blockedReason(plan, action) : undefined);
    return reason ? [[action.id, reason] as const] : [];
  }));
  const offered = plan.actions.filter(action => !action.approved && !blocked.has(action.id));
  const lines = plan.actions.map(action => {
    const mark = blocked.has(action.id) ? '[!]' : ready.has(action.id) ? '[x]' : '[ ]';
    const reason = blocked.has(action.id) ? `\n    blocked: ${safeDisplay(blocked.get(action.id)!)}`
      : offered.some(item => item.id === action.id) ? '\n    unclear evidence · not accepted by Enter; approve this row to include it' : '';
    return `${mark} ${describe(action)}${reason}`;
  });
  if (plan.skipped.length) lines.push('', ...plan.skipped.map(item => `skipped ${safeDisplay(item.clip)}: ${safeDisplay(item.reason)}`));
  const summary = [`${ready.size} ready`, ...(offered.length ? [`${offered.length} unclear`] : []), `${blocked.size} blocked`, `${plan.skipped.length} skipped`];
  ui.note(lines.join('\n'), `Action preview · ${summary.join(' · ')}`);
}

async function explicitApproval(plan: Plan): Promise<Plan> {
  const picked = await ask(ui.multiselect({
    message: 'Approve actions · Space toggles · Enter continues',
    options: plan.actions.map(action => ({
      value: action.id,
      label: `[${action.operation}] ${safeDisplay(action.afterPath)}`,
      hint: action.blocked ? `blocked: ${safeDisplay(action.blocked)}` : describe(action),
    })),
    initialValues: plan.actions.filter(action => action.approved).map(action => action.id),
    maxItems: 14, required: false,
  }));
  let next: Plan = { ...plan, actions: plan.actions.map(action => ({ ...action, approved: false })) };
  for (const id of picked) next = setApproved(next, id, true);
  return next;
}

function reportDecisions(decisions: Decision[], evidence: Evidence[], showAll = false): void {
  const order = ['MATCH', 'REVIEW', 'NOT JUDGED', 'NO MATCH'];
  const sorted = [...decisions].sort((a, b) => order.indexOf(findingLabel(a)) - order.indexOf(findingLabel(b)));
  const visible = showAll ? sorted : sorted.slice(0, 12);
  ui.note(findingLines(visible, evidence), `Findings · ${findingSummary(decisions)}`);
  if (visible.length < sorted.length) ui.log.info(`Showing ${visible.length} of ${sorted.length} findings. /results shows every row; nothing is excluded from the count or evidence.`);
  ui.log.info('Transcripts, not picture or sound quality. Excerpts are openings, not model citations. /details shows full evidence; /select changes the selection.');
}

async function approvePlan(plan: Plan): Promise<Plan | 'edit' | undefined> {
  const ready = readyActions(plan).length;
  const blocked = blockedActions(plan);
  const offered = plan.actions.filter(action => !action.approved && action.blocked === undefined);
  const options = [
    ...(ready ? [{ value: 'ready', label: `Apply the ${ready} ready action(s)`, hint: 'unapproved rows are left alone' }] : []),
    { value: 'rows', label: 'Choose rows myself', hint: `${offered.length} unapproved row(s); you can also uncheck ready actions` },
    ...(blocked.length ? [{ value: 'deps', label: 'Approve prerequisites for the blocked rows', hint: blocked.map(action => action.id).join(', ') }] : []),
    { value: 'edit', label: 'Edit folder or file names', hint: 'rebuild the preview; nothing applied yet' },
    { value: 'cancel', label: 'Cancel' },
  ];
  const choice = await ask(ui.select({ message: `Apply these ${ready} action(s)? · ${offered.length} review row(s) not included`, options }));
  if (choice === 'cancel') return undefined;
  if (choice === 'edit') return 'edit';
  if (choice === 'rows') {
    const next = await explicitApproval(plan);
    previewPlan(next);
    return approvePlan(next);
  }
  if (choice === 'deps') {
    let next = plan;
    for (const action of blocked) next = approveWithDependencies(next, action.id);
    previewPlan(next);
    return approvePlan(next);
  }
  return plan;
}

async function suggestedInput(message: string, suggestion: string, validate: (value: string) => void): Promise<string> {
  const typed = await ask(ui.text({ message, placeholder: suggestion, validate: value => {
    try { validate((value ?? '').trim() || suggestion); } catch (error) { return errorMessage(error); }
    return undefined;
  } }));
  return typed.trim() || suggestion;
}

const destination = (name: string) => suggestedInput('Destination folder · Enter accepts suggestion; type to replace', name, validateFolder);

async function chooseScope(clips: Clip[], reason: string): Promise<Clip[]> {
  ui.note(`${reason}\nThese are inputs to inspect, NOT search results. Nothing has been judged or changed.`, 'Choose search scope');
  const choice = await ask(ui.select({ message: 'Where should I look?', options: [
    { value: 'all', label: `This folder and subfolders · ${clips.length} clips` },
    { value: 'pick', label: 'Choose input clips myself' },
    { value: 'cancel', label: 'Cancel this request' },
  ] }));
  if (choice === 'cancel') throw new Cancelled();
  return choice === 'all' ? clips : chooseClips(clips, 'Input clips to inspect · not findings');
}

async function chooseRename(workspace: Workspace, clips: Clip[], suffix?: string): Promise<RenameSpec> {
  const options = [
    { value: 'append', label: 'Append a suffix', hint: suffix ? `from your request: ${safeDisplay(suffix)}` : 'keep original names, e.g. A001_final.MOV' },
    { value: 'numbered', label: 'Numbered names', hint: '01-topic.MOV, 02-topic.MOV; sorted by source path' },
    { value: 'transcript', label: 'Names from transcript openings', hint: 'first seven words, not AI summaries; editable before apply' },
  ];
  const kind = await ask(ui.select({ message: 'How should files be named?', options, initialValue: suffix ? 'append' : 'numbered' }));
  if (kind === 'append') return { kind: 'append', suffix: await suggestedInput('Suffix before extension', suffix ?? '_final', validateSuffix) };
  const base = kind === 'numbered' ? await suggestedInput('Shared name after the number', 'clip', validateStem) : undefined;
  const names: Record<string, string> = {};
  for (const [index, clip] of [...clips].sort((a, b) => a.path.localeCompare(b.path)).entries()) {
    const transcript = kind === 'transcript' ? await cachedTranscript(workspace, clip) : null;
    names[clip.path] = suggestedStem(clip, index, transcript ?? undefined, base);
  }
  if (kind === 'transcript') ui.log.info('Uses cached transcript openings only; missing words fall back to original names. No uploads or generated summaries.');
  return { kind: 'names', names };
}

async function editNames(intent: PlanIntent): Promise<void> {
  for (;;) {
    const options = [
      ...(intent.folder ? [{ value: 'folder', label: `Folder: ${safeDisplay(intent.folder)}` }] : []),
      ...(intent.rename?.kind === 'append' ? [{ value: 'suffix', label: `Suffix: ${safeDisplay(intent.rename.suffix)}` }] : []),
      ...(intent.rename?.kind === 'names' ? Object.entries(intent.rename.names).map(([file, stem]) => ({ value: `file:${file}`, label: safeDisplay(file), hint: safeDisplay(stem + path.posix.extname(file)) })) : []),
      { value: 'done', label: 'Done · rebuild action preview' },
    ];
    const choice = await ask(ui.select({ message: 'Edit naming · nothing applied', options }));
    if (choice === 'done') return;
    if (choice === 'folder') intent.folder = await destination(intent.folder!);
    if (choice === 'suffix' && intent.rename?.kind === 'append') intent.rename.suffix = await suggestedInput('Suffix before extension', intent.rename.suffix, validateSuffix);
    if (choice.startsWith('file:') && intent.rename?.kind === 'names') {
      const file = choice.slice(5);
      intent.rename.names[file] = await suggestedInput(`New name for ${safeDisplay(file)} · extension kept automatically`, intent.rename.names[file]!, validateStem);
    }
  }
}

async function oneRequest(request: string, deps: LoopDeps, state: SessionState): Promise<void> {
  const clips = await deps.workspace.scan();
  if (!clips.length) { ui.log.warn('No eligible videos in this directory.'); return; }
  const client = await deps.getClient();
  const spin = ui.spinner();
  spin.start('Reading the request with Jev');
  let view: Interpretation;
  try { view = await interpretRequest(client, request, clips); }
  finally { spin.stop('Request interpreted'); }

  const ops = OPERATIONS.filter(op => view.operations[op]);
  ui.note(`“${safeDisplay(request)}”\n${view.criterion ? 'Find clips matching the spoken-content condition.' : 'Use the scoped clips without content filtering.'}\n${view.operations.move || view.operations.rename || view.operations.create ? `Then preview: ${ops.filter(op => op !== 'find').join(' + ')}. Approval is required before changing files.` : 'Find only: show results, leave files untouched.'}${view.reference ? `\nCompare against: ${safeDisplay(view.reference)}` : ''}`, 'Understood request');
  if (!ops.length) { ui.log.info('Nothing to plan. Rephrase the request, for example: move the prepared takes to falas.'); return; }

  // A request that asks only for something a transcript cannot decide is refused before
  // any transcript is paid for: judging it anyway would return nothing but near-ties, and
  // a plan built from those would be a guess dressed as evidence.
  const limits = view.aspects.map(aspect => ASPECT_LIMIT[aspect]);
  const limit = limits.join('; and ');
  if (view.limited) {
    ui.log.warn(`Nothing was judged and nothing was changed: this request asks for ${limit || 'something a transcript cannot decide'}.`);
    ui.log.info('Say what is said in the clips instead — "the takes where they explain the price" — or ask me to move every clip, and I will.');
    return;
  }
  if (limit) ui.log.info(`Part of this request asks for ${limit}. I judge what was said and leave those parts out.`);

  const scoped = resolveScope(clips, view.scope, state);
  let targets = scoped.candidates;
  const followup = view.scope === 'current_selection' || view.scope === 'previous_result';
  if (!targets.length && followup) { ui.log.warn('That selection is empty or no longer exists. Nothing was retargeted. Ask for clips in this folder, or use /select.'); return; }
  if (!targets.length || view.scope === 'missing') {
    targets = await chooseScope(clips, view.scope === 'missing' ? 'I could not identify the requested set.' : 'There are no eligible clips directly in this folder.');
    ui.log.info(`Search scope: ${targets.length} input clip(s), explicitly chosen.`);
  } else ui.log.info(`Search scope: ${targets.length} input clip(s) from ${scoped.from}.`);

  const inheritedUncertainty = followup ? state.uncertain : [];
  let selection: { clip: Clip; preselected: boolean }[] = targets.map(clip => ({ clip, preselected: !inheritedUncertainty.includes(clip.path) }));
  if (view.criterion || view.mode !== 'all') {
    const references = view.reference ? clips.filter(clip => inFolder(clip.path, view.reference ?? '')) : [];
    const evidence = await ensureTranscripts(deps.workspace, [...targets, ...references], deps.getClient, deps.getContext());
    const targetEvidence = evidence.filter(item => targets.some(clip => clip.path === item.clip.path));
    const referenceEvidence = evidence.filter(item => references.some(clip => clip.path === item.clip.path));
    const rule: Rule = { request, context: deps.getContext(), mode: view.mode, destination: '', reference: view.reference, threshold: 0.8, extra: [], unjudgeable: view.aspects };
    const options = { hasCriterion: view.criterion, hasReference: references.length > 0 };
    const questionIds = clipQuestionIds(rule, options);
    const questionSignature = clipQuestionSignature(rule, options);
    const referenceKeys = referenceEvidence.map(item => ({ path: item.clip.path, ...item.transcript.source }));
    const decisions: Decision[] = [];
    let reused = 0;
    const judge = ui.spinner();
    judge.start('Judging clips · only the questions their gates admit');
    try {
      // Keep one clip per Jev state to avoid context rot, but overlap four independent
      // requests so a real shoot does not wait one network round trip per clip.
      for (let start = 0; start < targetEvidence.length; start += 4) {
        const batch = targetEvidence.slice(start, start + 4);
        judge.message(`${start + 1}-${start + batch.length}/${targetEvidence.length}`);
        decisions.push(...await Promise.all(batch.map(async item => {
          try {
            const key = decisionKey({ model: JEV_MODEL, request, context: rule.context, mode: rule.mode, reference: rule.reference, unjudgeable: rule.unjudgeable, questions: questionIds, questionSignature, clip: { path: item.clip.path, ...item.transcript.source }, references: referenceKeys });
            const stored = await cachedDecision(deps.workspace, key);
            if (stored) { reused += 1; return { ...stored, ...recommend(stored.answers, rule), path: item.clip.path }; }
            const decision = await analyzeClip(client, item, referenceEvidence, rule, options);
            await saveDecision(deps.workspace, key, decision);
            return decision;
          } catch (error) { return { path: item.clip.path, answers: {}, recommendation: 'review', reason: 'Not judged.', error: errorMessage(error) } as Decision; }
        })));
      }
    } finally { judge.stop(`${decisions.length} clip(s) judged${reused ? ` · ${reused} reused from cache` : ''}`); }
    for (const decision of decisions) {
      if (decision.recommendation === 'propose' && inheritedUncertainty.includes(decision.path)) {
        decision.recommendation = 'review';
        decision.reason = 'Matches this question, but the previous result still needed review. Use /select to include it explicitly.';
      }
    }
    state.findings = decisions;
    state.evidence = targetEvidence;
    state.request = request;
    reportDecisions(decisions, targetEvidence);
    // Judged is not the same as excluded: proposed clips are accepted by Enter, unclear
    // ones are offered as unapproved rows the user can still take deliberately.
    selection = targets.flatMap(clip => {
      const decision = decisions.find(item => item.path === clip.path);
      if (!decision || decision.error || decision.recommendation === 'keep') return [];
      return [{ clip, preselected: decision.recommendation === 'propose' }];
    });
    const unclear = selection.filter(entry => !entry.preselected).length;
    if (decisions.some(item => item.error)) ui.log.warn('Clips that could not be judged are left out, not treated as negative.');
    if (!selection.length) { ui.log.info('No matching candidates. Files unchanged; /details explains the findings.'); state.lastResult = []; state.selection = []; state.uncertain = []; return; }
    if (unclear) ui.log.info(`${unclear} review candidate(s): NOT selected or approved. They remain optional in any follow-up plan.`);
  }

  state.selection = selection.filter(entry => entry.preselected).map(entry => entry.clip.path);
  state.lastResult = selection.map(entry => entry.clip.path);
  state.uncertain = selection.filter(entry => !entry.preselected).map(entry => entry.clip.path);
  if (!view.operations.move && !view.operations.create && !view.operations.rename) {
    ui.log.success(`Find only · ${state.selection.length} selected match(es), ${state.uncertain.length} review candidate(s). No files changed.`);
    ui.log.info('Ask another question, say “move the results into selects”, or use /select to choose explicitly. /results repeats these findings.');
    return;
  }

  let folder: string | undefined;
  if (view.operations.move || view.operations.create) {
    ui.log.info(view.folder ? `Folder from your request: ${safeDisplay(view.folder)}` : 'No exact folder name identified; showing a default you can replace. Quote multiword names for best results.');
    folder = await destination(view.folder ?? defaultFolder(view.mode));
  }
  const rename = view.operations.rename ? await chooseRename(deps.workspace, selection.map(entry => entry.clip), view.suffix) : undefined;
  const intent: PlanIntent = { clips: view.operations.move || view.operations.rename ? selection : [], folder, rename };
  for (;;) {
    const plan = approveReady(await buildPlan(deps.workspace, intent));
    if (!plan.actions.length) { ui.log.warn(`Nothing to plan: ${plan.skipped.map(item => safeDisplay(item.reason)).join('; ') || 'no matching clips'}.`); return; }
    previewPlan(plan);
    const approved = await approvePlan(plan);
    if (approved === 'edit') { await editNames(intent); continue; }
    if (!approved) { ui.log.info('Left unapplied. Nothing changed.'); return; }
    if (!readyActions(approved).length) { ui.log.info('No actions approved. Nothing changed.'); return; }
    const journal = await executePlan(deps.workspace, approved);
    const done = executionOrder(approved);
    ui.log.success(`${done.length} action(s) applied · journal .tisco/move-${journal.id}.json`);
    ui.log.info('Review the result with /export, or reverse it with /undo.');
    const final = new Set<string>();
    for (const action of done.filter(action => action.operation !== 'mkdir')) {
      if (action.beforePath) final.delete(action.beforePath);
      final.add(action.afterPath);
    }
    state.lastResult = [...final];
    state.selection = [...final];
    state.uncertain = [];
    return;
  }
}

const HELP = [
  'Type any request in plain language; Enter accepts the plan it produces.',
  '',
  '  /results     repeat the last findings (no API call)',
  '  /details     inspect a finding, probabilities and full transcript',
  '  /select      explicitly choose clips from the last findings',
  '  /undo        restore the last applied plan',
  '  /export      write a portable review MP4 of the last result (source preserved)',
  '  /transcribe  transcribe clips now so a later request is faster',
  '  /context     set the project context Jev reads with each request',
  '  /key         set or replace the OpenRouter key for this session',
  '  /help        this list',
  '  /quit        leave',
].join('\n');

/** The review copy is additive: nothing here replaces or removes the source. */
async function exportLatest(deps: LoopDeps, state: SessionState): Promise<void> {
  const clips = await deps.workspace.scan();
  const again = clips.filter(clip => state.selection.includes(clip.path));
  const pool = clips.filter(clip => !inFolder(clip.path, 'review'));
  const chosen = again.length ? again : await chooseClips(pool, 'Which clips should get a portable review MP4?');
  if (!chosen.length) { ui.log.warn('No clips to export.'); return; }
  const caps = await hostCapabilities();
  if (!caps.ffmpeg || !caps.ffprobe || !caps.h264) {
    ui.log.warn(`Review export needs ffmpeg, ffprobe and an H.264 encoder. This host has ffmpeg ${caps.ffmpeg ? 'yes' : 'no'}, ffprobe ${caps.ffprobe ? 'yes' : 'no'}, H.264 ${caps.h264 ?? 'none'}. Sources are untouched.`);
    return;
  }
  const spin = ui.spinner();
  let written = 0;
  spin.start(`Review · 0/${chosen.length}`);
  for (const [index, clip] of chosen.entries()) {
    const stem = path.basename(clip.path).replace(/\.[^.]+$/, '');
    spin.message(`Review ${index + 1}/${chosen.length} · ${safeDisplay(clip.path)}`);
    try {
      await exportReview(await deps.workspace.resolve(clip.path), await deps.workspace.resolve(`review/${stem}.mp4`), caps.h264);
      written += 1;
    } catch (error) { ui.log.warn(`${safeDisplay(clip.path)}: ${errorMessage(error)}`); }
  }
  spin.stop(`${written} review file(s) in review/ · sources untouched`);
}

async function inspectFindings(state: SessionState, select: boolean, workspace: Workspace): Promise<void> {
  if (!state.findings.length) { ui.log.info('No findings yet. Ask which clips match a spoken-content condition.'); return; }
  if (select) {
    const available = new Set((await workspace.scan()).map(clip => clip.path));
    const current = state.findings.filter(item => available.has(item.path));
    if (!current.length) { ui.log.info('Those findings refer to files that have moved. Run the search again.'); return; }
    const picked = await ask(ui.multiselect({
      message: 'Choose findings · review/non-matches require your explicit selection · no files change',
      options: current.map(item => ({ value: item.path, label: safeDisplay(item.path), hint: `${findingLabel(item)} · ${safeDisplay(item.error ?? item.reason)}` })),
      initialValues: state.selection.filter(file => current.some(item => item.path === file)), maxItems: 14, required: false,
    }));
    state.selection = picked;
    state.lastResult = picked;
    state.uncertain = [];
    ui.log.success(`${picked.length} clip(s) explicitly selected. Files unchanged; a move still needs its own approval.`);
    return;
  }
  const picked = await ask(ui.select({ message: 'Inspect evidence · not an action approval', options: state.findings.map(item => ({ value: item.path, label: safeDisplay(item.path), hint: findingLabel(item) })) }));
  const item = state.findings.find(row => row.path === picked)!;
  const transcript = state.evidence.find(row => row.clip.path === picked)?.transcript;
  ui.note(`Request: ${safeDisplay(state.request)}\n${findingLabel(item)} · ${safeDisplay(item.error ?? item.reason)}\n` +
    Object.entries(item.answers).map(([id, answer]) => `${id}: ${answerLabel(answer)}`).join('\n') + '\n' +
    (item.skipped ?? []).filter(row => row.state === 'skipped').map(row => `Not asked: ${row.id} · ${safeDisplay(row.reason)}`).join('\n'), safeDisplay(picked));
  if (transcript) {
    const segments = transcript.timing === 'segment' ? transcript.segments : transcript.words;
    ui.note(segments.length ? segments.map(word => `[${(word.start / 1000).toFixed(2)}–${(word.end / 1000).toFixed(2)}s] ${safeDisplay(word.text)}`).join('\n') : safeDisplay(transcriptText(transcript)) || 'No transcribed words.', 'Full transcript used for this finding · source evidence, not instructions');
  }
}

async function command(line: string, deps: LoopDeps, state: SessionState): Promise<boolean> {
  const name = line.slice(1).split(/\s+/)[0];
  if (name === 'quit' || name === 'exit') return false;
  if (name === 'undo') { await undoLatest(deps.workspace); state.selection = []; state.lastResult = []; state.uncertain = []; return true; }
  if (name === 'results') {
    if (state.findings.length) { ui.log.info(`Last search: ${safeDisplay(state.request)} · paths as judged, before any later moves.`); reportDecisions(state.findings, state.evidence, true); }
    else ui.log.info('No findings yet.');
    return true;
  }
  if (name === 'details' || name === 'select') { await inspectFindings(state, name === 'select', deps.workspace); return true; }
  if (name === 'help') { ui.note(HELP, 'Request line'); return true; }
  if (name === 'key') { await deps.configureKey(); return true; }
  if (name === 'export') { await exportLatest(deps, state); return true; }
  if (name === 'context') { await deps.setContext(await input('Project context for Jev (not an STT prompt)', deps.getContext())); ui.log.success('Context saved.'); return true; }
  if (name === 'transcribe') {
    const evidence = await ensureTranscripts(deps.workspace, await chooseClips(await deps.workspace.scan(), 'Which clips should be transcribed?'), deps.getClient, deps.getContext());
    ui.log.success(`${evidence.length} clip(s) now have transcripts.`);
    return true;
  }
  ui.log.warn(`Unknown command ${safeDisplay(name ?? '')}. Try /help.`);
  return true;
}

/**
 * Transcription is the first thing a project needs, because nothing can be judged from a
 * clip until the words exist. Transcription and new Jev calls are billed. Offering it here
 * keeps the first request fast instead of stopping in the middle of it to upload.
 */
async function offerTranscripts(deps: LoopDeps): Promise<void> {
  const clips = await deps.workspace.scan();
  if (!clips.length) return;
  const known = await loadEvidence(deps.workspace, clips);
  const missing = clips.length - known.length;
  if (!missing) { ui.log.info(`Transcripts ready · ${clips.length} clip(s).`); return; }
  ui.log.info(`${missing} of ${clips.length} clip(s) have no transcript yet. Judging a request needs to know what was said in the clips.`);
  if (!(await confirm(`Transcribe ${missing} clip(s) now? Uploads are billed.`))) {
    ui.log.info('Fine. The first request that needs a judgment asks again.');
    return;
  }
  try {
    const evidence = await ensureTranscripts(deps.workspace, clips, deps.getClient, deps.getContext(), { confirmed: true });
    ui.log.success(`${evidence.length} clip(s) have complete transcripts.`);
  } catch (error) {
    if (error instanceof Cancelled) { ui.log.info('No transcripts were written. The next request asks again.'); return; }
    throw error;
  }
}

/** request → plan → accept → boom, with depth available but never required. */
export async function runLoop(deps: LoopDeps): Promise<void> {
  const state: SessionState = { selection: [], lastResult: [], uncertain: [], findings: [], evidence: [], request: '' };
  ui.note('root: ' + safeDisplay(deps.root) + '\ntype a request in plain language. /help lists commands. Esc leaves without changes.', 'workspace');
  await offerTranscripts(deps);
  for (;;) {
    const answer = await ask(ui.text({ message: 'what now?', placeholder: 'separate the prepared takes and put them in falas' }));
    const request = answer.trim();
    if (!request) continue;
    try {
      if (request.startsWith('/')) { if (!(await command(request, deps, state))) break; }
      else await oneRequest(request, deps, state);
    }
    catch (error) {
      if (error instanceof Cancelled) { ui.log.info('Cancelled. Nothing was changed.'); continue; }
      ui.log.error(errorMessage(error));
    }
  }
}
