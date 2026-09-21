import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprint, atomicJson } from '../dist/workspace.js';

const seedOnly = process.argv[2] === '--seed';
const root = seedOnly ? path.resolve(process.argv[3]) : await fs.mkdtemp(path.join(os.tmpdir(), 'tisco-demo-'));
await fs.mkdir(root, { recursive: true });
const examples = [
  ['01-intro.MOV', 'Hoje eu vou ensinar uma receita saudável. Errei! Hoje eu vou ensinar uma receita saudável.'],
  ['02-setup.MOV', 'Pode? Espera, deixa eu cortar aqui. Vai.'],
  ['03-detail.MOV', ''],
];
for (const [name, text] of examples) {
  await fs.writeFile(path.join(root, name), 'DEMO FILE, not playable footage.');
  const words = text ? text.split(' ').map((text, i) => ({ text, start: i * 300, end: i * 300 + 250 })) : [];
  await atomicJson(path.join(root, `${name}.tisco.json`), {
    version: 1, model: 'demo/fixture', source: await fingerprint(path.join(root, name)), prompt: 'Demo food brand',
    timeUnit: 'ms', status: 'complete', text, words, segments: [], durationMs: Math.max(1000, words.length * 300), timing: words.length ? 'word' : 'none', cost: 0,
  });
}
console.log(`Offline demo workspace: ${root}`);
console.log('Synthetic files and judgments. No real credentials or network. Try organizing scripted lines into falas.');
if (!seedOnly) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, ['--import', path.join(here, 'mock-network.mjs'), path.join(here, '../dist/cli.js'), root], {
    stdio: 'inherit', env: { ...process.env, OPENROUTER_API_KEY: 'demo-only', XDG_CONFIG_HOME: path.join(root, 'config') },
  });
  child.on('exit', code => { console.log(`Demo files remain at ${root}`); process.exitCode = code ?? 1; });
}
