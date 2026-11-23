// SPDX-License-Identifier: Apache-2.0
import { readFile, stat, writeFile } from 'node:fs/promises';
import { pairedRunCsv, runPairedExperiment, validatePairedRecipe } from '../src/paired-run.js';

const usage = 'Usage: node scripts/replay-pair.mjs <recipe.json> [results.csv]';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else {
  try {
    if (args.length < 1 || args.length > 2) throw new Error(usage);
    const [source, destination] = args;
    const file = await stat(source);
    if (!file.isFile() || file.size > 5_000_000) throw new Error('Expected a recipe file of at most 5 MB.');
    const { model, demand, durationS } = validatePairedRecipe(JSON.parse(await readFile(source, 'utf8')));
    const result = await runPairedExperiment(model, { demand, durationS });
    const csv = pairedRunCsv(result);
    if (destination) {
      // Never replace a recipe or an existing experiment's observations.
      await writeFile(destination, csv, { flag: 'wx' });
    } else {
      process.stdout.write(csv);
    }
    console.error(`Replayed ${result.rows.length} paired observations through ${result.elapsedS} simulated seconds.`);
    if (!result.complete) console.error(result.stopReason);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
