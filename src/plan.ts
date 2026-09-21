import path from 'node:path';
import type { Clip } from './types.js';
import { safeDisplay } from './types.js';
import { validateStem } from './naming.js';
import type { FilePair, Plan, PlanAction } from './actions.js';
import { executionOrder, validatePlan } from './actions.js';
import { Workspace, exists, fingerprint, inFolder, validateFolder, type Journal, type MoveEntry } from './workspace.js';

export type RenameSpec =
  | { kind: 'append'; suffix: string }
  | { kind: 'names'; names: Record<string, string> };

export interface PlanIntent {
  /** `preselected: false` offers a clip the evidence was unsure about without accepting it. */
  clips: { clip: Clip; preselected: boolean }[];
  /** Destination folder relative to the authorized root. Omit for rename-in-place. */
  folder?: string;
  rename?: RenameSpec;
}

const message = (error: unknown) => safeDisplay(error instanceof Error ? error.message : 'Unexpected error.');

/** `IMG_3664.MOV` + `_brocolis` → `IMG_3664_brocolis.MOV` (extension preserved). */
export function appendSuffix(basename: string, suffix: string): string {
  const ext = path.posix.extname(basename);
  return `${basename.slice(0, basename.length - ext.length)}${suffix}${ext}`;
}

/** Sidecars are named after their video, so they must follow its new name. */
export function renamedSidecar(sidecar: string, video: string, renamed: string): string {
  if (sidecar.startsWith(video)) return `${renamed}${sidecar.slice(video.length)}`;
  const stem = video.slice(0, video.length - path.posix.extname(video).length);
  const renamedStem = renamed.slice(0, renamed.length - path.posix.extname(renamed).length);
  if (sidecar.startsWith(`${stem}.`)) return `${renamedStem}${sidecar.slice(stem.length)}`;
  return sidecar;
}

export function validateSuffix(suffix: string): void {
  if (!suffix) throw new Error('A rename needs a non-empty suffix.');
  if (suffix.length > 80) throw new Error('That suffix is too long.');
  if (/[\\/\x00-\x1f\x7f]/.test(suffix)) throw new Error('A suffix cannot contain path separators or control characters.');
  if (/[. ]$/.test(suffix)) throw new Error('A suffix cannot end with a dot or space.');
}

function destination(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/**
 * Turns intent plus the current filesystem into an approval-ready graph. Nothing is
 * thrown for per-clip problems: a clip that cannot be planned becomes a `skipped`
 * entry, and an action that cannot run carries a `blocked` reason.
 */
export async function buildPlan(workspace: Workspace, intent: PlanIntent): Promise<Plan> {
  if (!intent.folder && !intent.rename) throw new Error('A plan needs a destination folder, a rename, or both.');
  if (intent.folder) validateFolder(intent.folder);
  if (intent.rename?.kind === 'append') validateSuffix(intent.rename.suffix);
  if (intent.rename?.kind === 'names') for (const stem of Object.values(intent.rename.names)) validateStem(stem);

  const skipped: Plan['skipped'] = [];
  const actions: PlanAction[] = [];
  const dirs = intent.folder ? await workspace.missingAncestors(intent.folder) : [];
  const mkdirId = intent.folder && dirs.length ? `mkdir:${intent.folder}` : undefined;
  if (mkdirId && intent.folder) {
    actions.push({ id: mkdirId, operation: 'mkdir', title: `Create ${intent.folder}/`, afterPath: intent.folder, pairs: [], dependsOn: [], preselected: true, approved: false });
  }

  const claimed = new Set<string>();
  const seen = new Set<string>();
  for (const entry of intent.clips) {
    const clip = entry.clip;
    if (seen.has(clip.path)) continue;
    seen.add(clip.path);
    if (intent.folder && inFolder(clip.path, intent.folder) && !intent.rename) {
      skipped.push({ clip: clip.path, reason: `already inside ${intent.folder}/` });
      continue;
    }
    let sidecars: string[];
    try { sidecars = await workspace.sidecars(clip); }
    catch (error) { skipped.push({ clip: clip.path, reason: message(error) }); continue; }

    const basename = path.posix.basename(clip.path);
    const moving = intent.folder && !inFolder(clip.path, intent.folder) ? intent.folder : undefined;
    const targetDir = moving ?? (path.posix.dirname(clip.path) === '.' ? '' : path.posix.dirname(clip.path));
    const placedPath = destination(targetDir, basename);
    const pairs: FilePair[] = [];
    let blocked: string | undefined;
    for (const from of [clip.path, ...sidecars]) {
      const to = destination(targetDir, path.posix.basename(from));
      if (claimed.has(to)) { blocked ??= `two selected files would both become ${to}`; continue; }
      claimed.add(to);
      try {
        if (moving && await exists(await workspace.resolve(to))) blocked ??= `destination already exists: ${to}`;
        pairs.push({ from, to, fingerprint: await fingerprint(await workspace.resolve(from)) });
      } catch (error) { blocked ??= message(error); }
    }

    const moveId = `move:${clip.path}`;
    if (moving) {
      actions.push({
        id: moveId, operation: 'move',
        title: `Move ${basename}${sidecars.length ? ` + ${sidecars.length} sidecar(s)` : ''}`,
        beforePath: clip.path, afterPath: placedPath, pairs, dependsOn: mkdirId ? [mkdirId] : [], preselected: entry.preselected, approved: false, blocked,
      });
    }

    if (!intent.rename) continue;
    const stem = intent.rename.kind === 'names' ? intent.rename.names[clip.path] : undefined;
    if (intent.rename.kind === 'names' && !stem) { skipped.push({ clip: clip.path, reason: 'no replacement name supplied' }); continue; }
    const renamed = intent.rename.kind === 'append' ? appendSuffix(basename, intent.rename.suffix) : `${stem}${path.posix.extname(basename)}`;
    if (renamed === basename) { skipped.push({ clip: clip.path, reason: 'filename unchanged' }); continue; }
    const renamePairs: FilePair[] = [];
    let renameBlocked: string | undefined = moving ? undefined : blocked;
    for (const pair of pairs) {
      const name = path.posix.basename(pair.to);
      const to = destination(targetDir, name === basename ? renamed : renamedSidecar(name, basename, renamed));
      if (claimed.has(to)) renameBlocked ??= `two planned files would both become ${to}`;
      claimed.add(to);
      try {
        if (await exists(await workspace.resolve(to))) renameBlocked ??= `destination already exists: ${to}`;
        renamePairs.push({ from: pair.to, to, fingerprint: pair.fingerprint });
      } catch (error) { renameBlocked ??= message(error); }
    }
    actions.push({
      id: `rename:${clip.path}`, operation: 'rename',
      title: `Rename ${basename}${sidecars.length ? ` + ${sidecars.length} sidecar(s)` : ''}`,
      beforePath: placedPath, afterPath: destination(targetDir, renamed), pairs: renamePairs,
      dependsOn: moving ? [moveId] : [], preselected: entry.preselected, approved: false, blocked: renameBlocked,
    });
  }

  return { actions, skipped };
}

/** Runs exactly the approved, unblocked subset, in dependency order, as one journal. */
export async function executePlan(workspace: Workspace, plan: Plan): Promise<Journal> {
  const problems = validatePlan(plan);
  if (problems.length) throw new Error(problems[0]);
  const ordered = executionOrder(plan);
  if (!ordered.length) throw new Error('No approved actions to run.');
  const dirs = ordered.filter(action => action.operation === 'mkdir').map(action => action.afterPath);
  const entries: MoveEntry[] = [];
  for (const action of ordered) {
    for (const pair of action.pairs) {
      if (!pair.fingerprint) throw new Error(`Action ${action.id} has no preflight fingerprint.`);
      entries.push({ from: pair.from, to: pair.to, fingerprint: pair.fingerprint });
    }
  }
  return workspace.apply(entries, dirs);
}
