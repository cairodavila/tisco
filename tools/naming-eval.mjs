import assert from 'node:assert/strict';
import { OpenRouter } from '../dist/openrouter.js';
import { scopeFromRoute, workspaceRouteRequest } from '../dist/decisions.js';
import { chosenName, namingCandidates } from '../dist/naming.js';
import { workspaceSnapshot, workspaceState } from '../dist/workspace-state.js';

const client = new OpenRouter(process.env.OPENROUTER_API_KEY);
const cases = [
  ['find the clips mentioning the warranty and put them in selects', 'selects', undefined, 'all_here'],
  ['move the results into "approved picks" and rename with _final', 'approved picks', '_final', 'previous_result'],
  ['mova os resultados para "falas aprovadas" e renomeie com o sufixo _final', 'falas aprovadas', '_final', 'previous_result'],
  ['create a folder called drafts', 'drafts', undefined, 'all_here'],
  ['move every clip into selects', 'selects', undefined, 'all_here'],
  ['find the clips that mention the price', undefined, undefined, 'all_here'],
  ['find the clips with clean audio where they explain the price', undefined, undefined, 'all_here'],
  ['rename the selected clips with _review', undefined, '_review', 'current_selection'],
  ['rename the selected clips with descriptive names', undefined, undefined, 'current_selection'],
  ['put those into "client/selects"', 'client/selects', undefined, 'previous_result'],
  ['from the falas folder, which clips have incomplete sentences?', undefined, undefined, 'folder_0'],
];
let failures = 0;
for (const [request, folder, suffix, scope] of cases) {
  const folders = ['falas'];
  const clip = { path: 'falas/A.MOV', fingerprint: { size: 1, mtimeMs: 1, ino: 1, dev: 1 } };
  const snapshot = workspaceSnapshot({ clips: [clip], folders }, []);
  const state = workspaceState(snapshot, { instruction: request, projectContext: '', session: { selection: [], previousResult: [], uncertain: [] } });
  const answers = await workspaceRouteRequest(client, state, request, folders);
  const candidates = namingCandidates(request);
  const actual = { folder: chosenName(answers, 'destination_name', candidates), suffix: chosenName(answers, 'rename_suffix', candidates), scope: scopeFromRoute(answers) };
  try { assert.deepEqual(actual, { folder, suffix, scope }); }
  catch { failures++; }
  console.log(JSON.stringify({ request, ...actual, folderProbability: answers.destination_name?.probabilities?.[answers.destination_name?.choice], suffixProbability: answers.rename_suffix?.probabilities?.[answers.rename_suffix?.choice] }));
}
console.log(`${cases.length} naming/scope fixtures · ${failures} misses`);
process.exitCode = failures ? 1 : 0;
