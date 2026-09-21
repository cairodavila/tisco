#!/usr/bin/env node
import * as ui from '@clack/prompts';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { OpenRouter } from './openrouter.js';
import { Workspace, atomicJson, configDir, exists, readJson, saveSettings, settings } from './workspace.js';
import { runLoop, undoLatest } from './loop.js';
import { hostCapabilities } from './media.js';
import { ask, confirm, errorMessage, Cancelled } from './ask.js';
import { object, safeDisplay } from './types.js';

const { version: VERSION } = createRequire(import.meta.url)('../package.json') as { version: string };
const HELP = `tisco ${VERSION}
quick, reversible clip organization

Usage: tisco [directory] [options]

Start it in an authorized shoot folder and type what you want:

  which clips mention the price?
  move the results into "price clips"
  rename the selected clips with _final

Findings explain matches and review candidates before any action.
/results repeats them; /details shows transcripts; /select changes the selection.
Folder and file names are editable in the preview. Enter applies only ready actions.
Moves and renames can be undone with /undo.

  --configure         Set/replace the OpenRouter key (masked, optional persistence)
  --forget-key        Remove the saved key (OPENROUTER_API_KEY remains independent)
  --forget-directory  Revoke authorization for this exact directory
  --undo              Restore the latest applied plan / recover an interrupted one
  --check             Report host ffmpeg/ffprobe and H.264 support, then exit
  --unlock            Remove a verified dead local process lock after a crash
  --help              Show this help without reading directory contents
  --version           Show version

Needs Node 22.13+; ffmpeg and ffprobe on PATH for new transcriptions.
Models: microsoft/mai-transcribe-2 and typesafe/jev-1.13, via OpenRouter only.
Key: OPENROUTER_API_KEY or interactive setup. Nothing is uploaded before consent.
Moves are previewed, never overwrite, and can be undone. No editorial deletion.
`;

async function apiClient(force = false): Promise<OpenRouter> {
  const config = await settings();
  const existing = process.env.OPENROUTER_API_KEY || config.apiKey;
  if (existing && !force) return new OpenRouter(existing);
  ui.note('Only OpenRouter is contacted. Your key is never sent to Jev as state or stored with media.\nSaving locally is optional (private config file, not an OS keychain).', 'One provider · two models');
  const key = (await ask(ui.password({ message: 'OpenRouter API key', validate: value => !value?.trim() || /\s/.test(value) ? 'Enter a non-empty key without whitespace.' : undefined }))).trim();
  const remember = await confirm(`Remember key in ${configDir()}/config.json?`);
  if (remember) { config.apiKey = key; await saveSettings(config); }
  else if (force && config.apiKey) { delete config.apiKey; await saveSettings(config); }
  return new OpenRouter(key);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, version: { type: 'boolean' }, check: { type: 'boolean' }, configure: { type: 'boolean' }, undo: { type: 'boolean' }, unlock: { type: 'boolean' }, 'forget-key': { type: 'boolean' }, 'forget-directory': { type: 'boolean' },
  } });
  if (values.help) { console.log(HELP); return; }
  if (values.version) { console.log(VERSION); return; }
  if (values.check) {
    const caps = await hostCapabilities();
    console.log(`ffmpeg   ${caps.ffmpeg ? 'yes' : 'no'}\nffprobe  ${caps.ffprobe ? 'yes' : 'no'}\nH.264    ${caps.h264 ?? 'none'}\naac      ${caps.aac ? 'yes' : 'no'}`);
    if (!caps.ffmpeg || !caps.ffprobe) { console.error('Transcription and review export need ffmpeg and ffprobe on PATH.'); process.exitCode = 1; }
    return;
  }
  if (positionals.length > 1) throw new Error('Pass at most one directory. See tisco --help.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required. Use --help for usage.');
  ui.intro('tisco');
  if (values['forget-key']) {
    const config = await settings(); delete config.apiKey; await saveSettings(config); ui.outro('Saved key removed.'); return;
  }
  if (values.configure) { await apiClient(true); ui.outro('OpenRouter configured.'); return; }
  const root = await fs.realpath(path.resolve(positionals[0] ?? process.cwd()));
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error('Choose a directory.');
  const config = await settings();
  if (values['forget-directory']) {
    delete config.directories?.[root]; await saveSettings(config); ui.outro('Directory authorization revoked. Local transcripts and journals remain.'); return;
  }
  const trust = config.directories?.[root];
  if (!trust || trust.dev !== stat.dev || trust.ino !== stat.ino) {
    ui.note(`${safeDisplay(root)}\n\nAllow tisco to list videos in this directory and visible subfolders, read matching\ntranscript sidecars, extract audio, and write local transcripts/.tisco records?\n\nHidden directories and symlinks are skipped. Uploads and moves require separate\nconfirmation. Authorization is stored for this exact directory only.`, 'Directory access · first run');
    if (!(await confirm('Authorize this directory?'))) { ui.outro('Not authorized. No contents scanned.'); return; }
    config.directories = { ...config.directories, [root]: { dev: stat.dev, ino: stat.ino } };
    await saveSettings(config);
  }
  const workspace = new Workspace(root);
  await workspace.initialize();
  if (values.unlock) { await workspace.unlock(); ui.outro('Stale lock cleared, if present.'); return; }
  const release = await workspace.lock();
  let client: OpenRouter | undefined;
  try {
    if (values.undo) { await undoLatest(workspace); return; }
    const projectFile = await workspace.resolve('.tisco/project.json');
    const saved = await exists(projectFile) ? object(await readJson(projectFile)) : {};
    let context = typeof saved.context === 'string' ? saved.context : '';
    if ((await workspace.journals()).some(journal => journal.status === 'pending')) {
      ui.log.warn('An interrupted plan must be recovered before continuing.');
      await undoLatest(workspace);
      if ((await workspace.journals()).some(journal => journal.status === 'pending')) return;
    }
    await runLoop({
      workspace, root,
      getClient: async () => client ??= await apiClient(),
      configureKey: async () => { client = await apiClient(true); },
      getContext: () => context,
      setContext: async value => { context = value; await atomicJson(projectFile, { context }); },
    });
  } finally { await release(); }
  ui.outro('Nothing moves without your say-so.');
}

main().catch(error => {
  if (error instanceof Cancelled) { ui.cancel('Cancelled.'); process.exitCode = 0; }
  else { console.error(`tisco: ${errorMessage(error)}`); process.exitCode = 1; }
});
