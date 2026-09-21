import * as fs from 'node:fs/promises';
import path from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { object, sameFile } from './types.js';
import type { Clip, Fingerprint } from './types.js';

const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts', '.mxf']);
export const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'tisco');
export interface Settings { apiKey?: string; directories?: Record<string, { dev: number; ino: number }> }

export async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

export async function readJson(file: string): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
  if (stat.size > 32 * 1024 * 1024) throw new Error(`JSON file is too large: ${file}`);
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

export async function atomicJson(file: string, data: unknown): Promise<void> {
  if (await exists(file)) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing to replace a non-regular JSON file.');
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

export async function settings(): Promise<Settings> {
  const file = path.join(configDir(), 'config.json');
  if (!(await exists(file))) return {};
  const dir = await fs.lstat(configDir());
  if (dir.isSymbolicLink() || !dir.isDirectory()) throw new Error('Unsafe tisco config directory.');
  const raw = object(await readJson(file));
  if (raw.apiKey !== undefined && typeof raw.apiKey !== 'string') throw new Error('Invalid stored API key.');
  const directories: Settings['directories'] = {};
  if (raw.directories) {
    for (const [key, entry] of Object.entries(object(raw.directories))) {
      const d = object(entry);
      if (typeof d.dev !== 'number' || typeof d.ino !== 'number') throw new Error('Invalid directory authorization.');
      directories[key] = { dev: d.dev, ino: d.ino };
    }
  }
  return { apiKey: raw.apiKey as string | undefined, directories };
}

export async function saveSettings(value: Settings): Promise<void> {
  const dir = configDir();
  if (await exists(dir)) {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe tisco config directory.');
  } else await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await atomicJson(path.join(dir, 'config.json'), value);
}

export function validateRelative(relative: string): void {
  if (!relative || path.isAbsolute(relative) || /[\\\x00-\x1f\x7f:]/.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Use a relative path inside the authorized directory; no traversal or control characters.');
  }
}
export function validateFolder(folder: string): void {
  validateRelative(folder);
  if (folder.split('/').some(p => p.startsWith('.') || /[<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error('Use a visible, portable folder name (for example falas or selects/interviews).');
  }
}
export function validateFileName(name: string): void {
  if (!name || name === '.' || name === '..' || name.startsWith('.') || /[<>"|?*\\\x00-\x1f\x7f:]/.test(name) || /[. ]$/.test(name)) {
    throw new Error('Use a plain file name without control characters, a leading dot, or a trailing dot/space.');
  }
}
/** Folder rules for directories, file rules for the last segment. Used for move/rename destinations. */
export function validateMediaPath(relative: string): void {
  validateRelative(relative);
  const parts = relative.split('/');
  const name = parts.pop();
  if (name === undefined) throw new Error('Missing file name.');
  for (const part of parts) if (part.startsWith('.')) throw new Error('Hidden folders are not used for media.');
  validateFileName(name);
}
export function inFolder(file: string, folder: string): boolean { return file.startsWith(`${folder}/`); }

export async function fingerprint(file: string): Promise<Fingerprint> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
  return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev };
}

export interface MoveEntry { from: string; to: string; fingerprint: Fingerprint }
export interface Journal { version: 1; id: string; root: string; status: 'pending' | 'applied' | 'undone'; dirs: string[]; entries: MoveEntry[] }

export class Workspace {
  constructor(readonly root: string) {}

  async resolve(relative: string): Promise<string> {
    validateRelative(relative);
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Authorized root was replaced or is a symlink.');
    let current = this.root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (await exists(current)) {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${relative}`);
      }
    }
    return current;
  }

  async initialize(): Promise<void> {
    const dir = await this.resolve('.tisco');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async lock(): Promise<() => Promise<void>> {
    const file = await this.resolve('.tisco/lock.json');
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Workspace locked. Close the other tisco session, or use --unlock after a crash.');
      throw e;
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
    await handle.close();
    return async () => { await fs.unlink(file); };
  }

  async unlock(): Promise<void> {
    const file = await this.resolve('.tisco/lock.json');
    if (!(await exists(file))) return;
    const data = object(await readJson(file));
    if (data.host !== hostname() || typeof data.pid !== 'number' || !Number.isInteger(data.pid) || data.pid <= 0) throw new Error('Cannot verify lock owner. Inspect .tisco/lock.json manually.');
    try { process.kill(data.pid, 0); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await fs.unlink(file); return; }
      throw e;
    }
    throw new Error('Lock owner is still running. Refusing to unlock.');
  }

  async scan(): Promise<Clip[]> {
    const result: Clip[] = [];
    const walk = async (relative: string) => {
      const dir = relative ? await this.resolve(relative) : this.root;
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.name === 'node_modules' || /[\\\x00-\x1f\x7f:]/.test(item.name)) continue;
        const name = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory()) await walk(name);
        else if (item.isFile() && VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())) {
          result.push({ path: name, fingerprint: await fingerprint(await this.resolve(name)) });
        }
      }
    };
    await walk('');
    return result.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  async verify(clip: Clip): Promise<void> {
    if (!sameFile(clip.fingerprint, await fingerprint(await this.resolve(clip.path)))) throw new Error(`Source changed; rescan before continuing: ${clip.path}`);
  }

  async sidecars(clip: Clip): Promise<string[]> {
    const stem = clip.path.slice(0, -path.extname(clip.path).length);
    const candidates = [`${clip.path}.tisco.json`, `${clip.path}.srt`, `${stem}.assemblyai.full.json`];
    const siblings = await fs.readdir(path.dirname(await this.resolve(clip.path)));
    if (siblings.filter(n => n.startsWith(path.basename(stem) + '.') && VIDEO_EXTENSIONS.has(path.extname(n).toLowerCase())).length > 1) {
      if (await exists(await this.resolve(`${stem}.assemblyai.full.json`))) throw new Error(`Ambiguous legacy sidecar for ${clip.path}; multiple videos share this stem.`);
    }
    const found = [];
    for (const rel of candidates) if (await exists(await this.resolve(rel))) { await fingerprint(await this.resolve(rel)); found.push(rel); }
    return found;
  }

  async planMoves(clips: Clip[], folder: string): Promise<MoveEntry[]> {
    validateFolder(folder);
    await this.resolve(folder);
    const entries: MoveEntry[] = [];
    const destinations = new Set<string>();
    for (const clip of clips) {
      await this.verify(clip);
      if (inFolder(clip.path, folder)) throw new Error(`Already in destination: ${clip.path}`);
      for (const from of [clip.path, ...await this.sidecars(clip)]) {
        const to = `${folder}/${path.basename(from)}`;
        if (destinations.has(to.toLowerCase()) || await exists(await this.resolve(to))) throw new Error(`Destination collision: ${to}`);
        destinations.add(to.toLowerCase());
        entries.push({ from, to, fingerprint: await fingerprint(await this.resolve(from)) });
      }
    }
    return entries;
  }

  /** Directories this run would create, existing ones omitted. Order is shallowest first. */
  async missingAncestors(folder: string): Promise<string[]> {
    validateFolder(folder);
    const missing: string[] = [];
    const parts = folder.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const candidate = parts.slice(0, index + 1).join('/');
      if (!(await exists(await this.resolve(candidate)))) missing.push(candidate);
    }
    return missing;
  }

  /**
   * Preflight every entry against a simulated filesystem state, in order. Chained
   * actions (rename the file a move just created) only verify correctly if earlier
   * entries are applied to the model first, so a nonexistent source is not a failure
   * when a previous action produced it.
   */
  async affordPlan(entries: MoveEntry[], dirs: string[], ignoreJournalId?: string): Promise<void> {
    if ((await this.journals()).some(j => j.status === 'pending' && j.id !== ignoreJournalId)) throw new Error('Recover the pending journal before moving more files.');
    const state = new Map<string, Fingerprint | null>();
    const current = async (relative: string): Promise<Fingerprint | null> => {
      if (state.has(relative)) return state.get(relative) ?? null;
      const at = await this.resolve(relative);
      return await exists(at) ? await fingerprint(at) : null;
    };
    for (const entry of entries) {
      validateMediaPath(entry.to);
      const source = await current(entry.from);
      if (source === null) throw new Error(`Missing source: ${entry.from}`);
      if (!sameFile(entry.fingerprint, source)) throw new Error(`Source changed: ${entry.from}`);
      if (await current(entry.to) !== null) throw new Error(`Destination collision: ${entry.to}`);
      state.set(entry.from, null);
      state.set(entry.to, entry.fingerprint);
    }
    for (const dir of dirs) validateFolder(dir);
  }

  async apply(entries: MoveEntry[], dirs: string[] = []): Promise<Journal> {
    if (!entries.length && !dirs.length) throw new Error('Nothing selected to move.');
    const journal: Journal = { version: 1, id: `${Date.now()}-${randomUUID()}`, root: this.root, status: 'pending', dirs, entries };
    await this.affordPlan(entries, dirs);
    await this.saveJournal(journal);
    return this.applyJournal(journal);
  }

  /** Runs a journal that was already saved, so the write-ahead record exists before any change. */
  async applyJournal(journal: Journal): Promise<Journal> {
    if (journal.root !== this.root || journal.status !== 'pending') throw new Error('Journal is not pending for this workspace.');
    await this.affordPlan(journal.entries, journal.dirs, journal.id);
    for (const dir of journal.dirs) await fs.mkdir(await this.resolve(dir), { recursive: true, mode: 0o755 });
    // link + unlink gives no-clobber moves on one filesystem. A pending journal
    // handles interruption between them; cross-device moves fail without deleting sources.
    for (const entry of journal.entries) {
      const source = await this.resolve(entry.from);
      const dest = await this.resolve(entry.to);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (!sameFile(entry.fingerprint, await fingerprint(source))) throw new Error(`Source changed: ${entry.from}`);
      await fs.link(source, dest);
      await fs.unlink(source);
    }
    journal.status = 'applied';
    await this.saveJournal(journal);
    return journal;
  }

  async saveJournal(journal: Journal): Promise<void> {
    await atomicJson(await this.resolve(`.tisco/move-${journal.id}.json`), journal);
  }

  async journals(): Promise<Journal[]> {
    const dir = await this.resolve('.tisco');
    if (!(await exists(dir))) return [];
    const result: Journal[] = [];
    for (const file of (await fs.readdir(dir)).filter(n => /^move-[\w-]+\.json$/.test(n)).sort().reverse()) {
      const value = object(await readJson(await this.resolve(`.tisco/${file}`)));
      if (value.version !== 1 || value.root !== this.root || !Array.isArray(value.entries) || !['pending', 'applied', 'undone'].includes(String(value.status)) || file !== `move-${value.id}.json`) throw new Error(`Invalid move journal: ${file}`);
      const dirs = value.dirs === undefined ? [] : value.dirs;
      if (!Array.isArray(dirs)) throw new Error('Invalid journal directories.');
      const seenDirs = new Set<string>();
      for (const dir of dirs) {
        if (typeof dir !== 'string') throw new Error('Invalid journal directory.');
        validateFolder(dir);
        if (seenDirs.has(dir)) throw new Error('Duplicate journal directory.');
        seenDirs.add(dir);
      }
      // A path may legitimately appear as one action's output and a later action's
      // input (rename after move). What must never repeat is a destination.
      const destinations = new Set<string>();
      for (const raw of value.entries) {
        const entry = object(raw);
        if (typeof entry.from !== 'string' || typeof entry.to !== 'string') throw new Error('Invalid journal paths.');
        for (const name of [entry.from, entry.to]) {
          validateRelative(name);
          if (name.split('/').some(p => p.startsWith('.'))) throw new Error('Invalid journal path.');
        }
        if (entry.from === entry.to) throw new Error('A journal entry cannot be its own destination.');
        const key = entry.to.toLowerCase();
        if (destinations.has(key)) throw new Error('Two journal entries share one destination.');
        destinations.add(key);
        const f = object(entry.fingerprint);
        if (!['size', 'mtimeMs', 'ino', 'dev'].every(k => typeof f[k] === 'number' && Number.isFinite(f[k]))) throw new Error('Invalid journal fingerprint.');
      }
      result.push({ ...(value as unknown as Journal), dirs });
    }
    return result;
  }

  async undo(journal: Journal): Promise<void> {
    if (journal.root !== this.root || journal.status === 'undone') throw new Error('Journal is not eligible for undo.');
    const state = new Map<string, Fingerprint | null>();
    const current = async (relative: string): Promise<Fingerprint | null> => {
      if (state.has(relative)) return state.get(relative) ?? null;
      const at = await this.resolve(relative);
      return (await exists(at)) ? await fingerprint(at) : null;
    };
    // Preflight on a simulated state, in reverse order: undoing the last action recreates
    // the path the previous action left behind, so a missing intermediate is expected.
    // Every file is checked before any of them is touched.
    const reversible: MoveEntry[] = [];
    for (const entry of [...journal.entries].reverse()) {
      const to = await current(entry.to);
      const from = await current(entry.from);
      if (to !== null && !sameFile(entry.fingerprint, to)) throw new Error(`Undo blocked by changed file or collision: ${entry.to}`);
      if (from !== null && !sameFile(entry.fingerprint, from)) throw new Error(`Undo blocked by changed file or collision: ${entry.from}`);
      if (to === null && from === null) throw new Error(`Undo cannot find either copy: ${entry.from}`);
      if (to === null) continue;
      reversible.push(entry);
      state.set(entry.to, null);
      state.set(entry.from, entry.fingerprint);
    }
    for (const entry of reversible) {
      const from = await this.resolve(entry.from);
      const to = await this.resolve(entry.to);
      if (!(await exists(to))) continue;
      if (!(await exists(from))) {
        await fs.mkdir(path.dirname(from), { recursive: true });
        await fs.link(to, from);
      }
      await fs.unlink(to);
    }
    // Only folders this run created are considered, and only while still empty.
    for (const dir of [...(journal.dirs ?? [])].reverse()) {
      const target = await this.resolve(dir);
      if (!(await exists(target))) continue;
      if (!(await fs.readdir(target)).length) await fs.rmdir(target);
    }
    journal.status = 'undone';
    await this.saveJournal(journal);
  }
}
