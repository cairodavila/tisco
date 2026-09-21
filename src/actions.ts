/**
 * Pure action graph. This module never touches the filesystem: `workspace.ts` resolves
 * real paths and preflight results, then the approval reducer here decides what the
 * user has actually authorised and what may run.
 *
 * The invariant that matters: approving a child never silently approves, retargets, or
 * removes its prerequisites. A dependency that is not approved leaves the child blocked.
 */
export type Operation = 'mkdir' | 'move' | 'rename';

import type { Fingerprint } from './types.js';

export interface FilePair {
  from: string;
  to: string;
  /** Preflight fingerprint of `from`; execution refuses pairs without one. */
  fingerprint?: Fingerprint;
}

export interface PlanAction {
  id: string;
  operation: Operation;
  title: string;
  beforePath?: string;
  afterPath: string;
  /** Files this action rewrites. Empty for mkdir. */
  pairs: FilePair[];
  dependsOn: string[];
  /** Radio semantics: at most one approved action per group. */
  exclusiveGroup?: string;
  /**
   * False when the evidence was inconclusive: the row is offered and can be approved
   * deliberately, but a blanket "accept everything ready" must not include it.
   */
  preselected: boolean;
  approved: boolean;
  /** Local preflight failure (collision, missing source, …). Never applyable. */
  blocked?: string;
}

export interface Plan {
  actions: PlanAction[];
  /** Targets the planner refused to plan for, with a reason. */
  skipped: { clip: string; reason: string }[];
}

export function emptyPlan(): Plan {
  return { actions: [], skipped: [] };
}

function find(plan: Plan, id: string): PlanAction | undefined {
  return plan.actions.find(action => action.id === id);
}

function requireAction(plan: Plan, id: string): PlanAction {
  const action = find(plan, id);
  if (!action) throw new Error(`Unknown action: ${id}`);
  return action;
}

function replace(plan: Plan, actions: PlanAction[]): Plan {
  return { actions, skipped: plan.skipped };
}

/** Prerequisites that exist in this plan but are not approved. */
export function unmetDependencies(plan: Plan, action: PlanAction): PlanAction[] {
  return action.dependsOn
    .map(id => find(plan, id))
    .filter((dep): dep is PlanAction => dep !== undefined && !dep.approved);
}

/** Prerequisites named by the action that are absent from the plan entirely. */
export function missingDependencies(plan: Plan, action: PlanAction): string[] {
  return action.dependsOn.filter(id => !find(plan, id));
}

/** Human-readable reason an approved action cannot run, or undefined when it can. */
export function blockedReason(plan: Plan, action: PlanAction): string | undefined {
  return blocker(plan, action, new Map(), new Set());
}

/**
 * Blockedness is a property of the node, not the path to it, so results are memoised.
 * Recursing matters: a prerequisite that is itself stuck must block its dependents,
 * otherwise a rename could run against a path the move never created.
 */
function blocker(plan: Plan, action: PlanAction, memo: Map<string, string | undefined>, visiting: Set<string>): string | undefined {
  if (action.blocked) return action.blocked;
  if (memo.has(action.id)) return memo.get(action.id);
  // A cycle is a structural error reported by validatePlan; don't recurse forever here.
  if (visiting.has(action.id)) return undefined;
  visiting.add(action.id);
  let result: string | undefined;
  const missing = missingDependencies(plan, action);
  if (missing.length) result = `missing prerequisite ${missing.join(', ')}`;
  else {
    const unmet = unmetDependencies(plan, action);
    if (unmet.length) result = `requires ${unmet.map(dep => dep.id).join(', ')}`;
    else {
      for (const depId of action.dependsOn) {
        const dep = find(plan, depId);
        if (!dep) continue;
        const reason = blocker(plan, dep, memo, visiting);
        if (reason) { result = `${depId} is blocked (${reason})`; break; }
      }
    }
  }
  visiting.delete(action.id);
  memo.set(action.id, result);
  return result;
}

export function isReady(plan: Plan, action: PlanAction): boolean {
  return action.approved && blockedReason(plan, action) === undefined;
}

export function readyActions(plan: Plan): PlanAction[] {
  return plan.actions.filter(action => isReady(plan, action));
}

/** Approved but stuck: the state the UI must show instead of quietly skipping. */
export function blockedActions(plan: Plan): PlanAction[] {
  return plan.actions.filter(action => action.approved && blockedReason(plan, action) !== undefined);
}

function groupTaken(plan: Plan, action: PlanAction): boolean {
  return action.exclusiveGroup !== undefined && plan.actions.some(
    other => other.id !== action.id && other.exclusiveGroup === action.exclusiveGroup && other.approved,
  );
}

function mutate(plan: Plan, id: string, change: (action: PlanAction) => PlanAction): Plan {
  let found = false;
  const actions = plan.actions.map(action => {
    if (action.id !== id) return action;
    found = true;
    return change(action);
  });
  if (!found) throw new Error(`Unknown action: ${id}`);
  return replace(plan, actions);
}

/** Approve or unapprove one row. Approving an exclusive option releases its siblings. */
export function setApproved(plan: Plan, id: string, approved: boolean): Plan {
  const target = requireAction(plan, id);
  const next = mutate(plan, id, action => ({ ...action, approved }));
  if (!approved || target.exclusiveGroup === undefined) return next;
  return replace(next, next.actions.map(action => (
    action.id !== id && action.exclusiveGroup === target.exclusiveGroup ? { ...action, approved: false } : action
  )));
}

/** Transitive prerequisites of an action that are currently unapproved. */
export function dependencyClosure(plan: Plan, id: string): string[] {
  const needed: string[] = [];
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const depId of requireAction(plan, current).dependsOn) {
      if (seen.has(depId)) continue;
      seen.add(depId);
      const dep = find(plan, depId);
      if (!dep) continue;
      if (!dep.approved) needed.push(depId);
      queue.push(depId);
    }
  }
  return needed;
}

/** "Also approve prerequisites" — the explicit closure, never an implicit one. */
export function approveWithDependencies(plan: Plan, id: string): Plan {
  let next = plan;
  for (const depId of dependencyClosure(plan, id)) next = setApproved(next, depId, true);
  return setApproved(next, id, true);
}

/** Approved actions that (transitively) consume this action's output. */
export function dependents(plan: Plan, id: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const action of plan.actions) {
      if (seen.has(action.id) || !action.dependsOn.includes(current)) continue;
      seen.add(action.id);
      found.push(action.id);
      queue.push(action.id);
    }
  }
  return found;
}

/**
 * Unapprove `id`. "keep-blocked" leaves dependents approved but visibly stuck;
 * "unapprove" clears them too. Neither ever rebases a dependent onto another target.
 */
export function unapprove(plan: Plan, id: string, dependentsMode: 'keep-blocked' | 'unapprove'): Plan {
  const affected = dependents(plan, id);
  let next = setApproved(plan, id, false);
  if (dependentsMode === 'unapprove') for (const depId of affected) next = setApproved(next, depId, false);
  return next;
}

/**
 * Approve every row that can actually run: dependencies satisfied, not locally blocked,
 * and not a losing member of an already-decided exclusive group. This is the batch consent
 * behind one Enter press in the fast loop.
 */
export function approveReady(plan: Plan): Plan {
  let next = plan;
  for (;;) {
    const candidate = next.actions.find(action => (
      !action.approved
      && action.preselected
      && action.blocked === undefined
      && !groupTaken(next, action)
      && missingDependencies(next, action).length === 0
      && unmetDependencies(next, action).length === 0
    ));
    if (!candidate) return next;
    next = setApproved(next, candidate.id, true);
  }
}

/** Approve everything the user can see, including rows that stay blocked. */
export function approveAll(plan: Plan): Plan {
  let next = plan;
  for (const action of plan.actions) {
    if (action.blocked !== undefined || groupTaken(next, action)) continue;
    next = setApproved(next, action.id, true);
  }
  return next;
}

/** Topological order over the ready subset. Throws on a cycle rather than guessing. */
export function executionOrder(plan: Plan): PlanAction[] {
  const pending = new Map(readyActions(plan).map(action => [action.id, action]));
  const done = new Set<string>();
  const ordered: PlanAction[] = [];
  while (pending.size) {
    const next = [...pending.values()].find(action => action.dependsOn.every(dep => done.has(dep) || !pending.has(dep)));
    if (!next) throw new Error('Action plan has a dependency cycle.');
    pending.delete(next.id);
    done.add(next.id);
    ordered.push(next);
  }
  return ordered;
}

/** Structural errors worth refusing to execute on, independent of user approval. */
export function validatePlan(plan: Plan): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const action of plan.actions) {
    if (ids.has(action.id)) problems.push(`duplicate action id: ${action.id}`);
    ids.add(action.id);
  }
  for (const action of plan.actions) {
    for (const missing of missingDependencies(plan, action)) problems.push(`${action.id} depends on unknown ${missing}`);
  }
  for (const group of new Set(plan.actions.map(a => a.exclusiveGroup).filter((g): g is string => g !== undefined))) {
    if (plan.actions.filter(a => a.exclusiveGroup === group && a.approved).length > 1) problems.push(`exclusive group ${group} has more than one approved action`);
  }
  try { executionOrder(plan); }
  catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  return problems;
}
