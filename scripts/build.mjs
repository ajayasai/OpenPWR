// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
let revision = null;
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
catch { /* Source archives can be built without a Git checkout. */ }
// Check evidence before replacing the last successful build.
for (const name of ['verification.json', 'benchmarks.json']) {
  let report;
  try { report = JSON.parse(await readFile(resolve(root, 'artifacts', name), 'utf8')); }
  catch { throw new Error(`${name} evidence missing or unreadable. Run npm run verify before building.`); }
  if (report.version !== pkg.version || (revision && report.gitRevision !== revision)) {
    throw new Error(`${name} belongs to a different version or commit. Run npm run verify again.`);
  }
  if (!Array.isArray(report.checks) || !report.checks.length || report.checks.some(check => check.pass !== true)
      || report.passed !== report.checks.length) throw new Error(`${name} contains unsuccessful or incomplete checks.`);
}
const output = resolve(root, 'dist');
if (output !== root + sep + 'dist') throw new Error('Refusing unexpected build directory');
try {
  const stat = await lstat(output);
  if (stat.isSymbolicLink()) throw new Error('Build directory must not be a symlink');
  await rm(output, { recursive: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'verification.html', 'src', 'docs', 'LICENSE', 'NOTICE']) {
  await cp(resolve(root, name), resolve(output, name), { recursive: true });
}
for (const name of ['verification.json', 'benchmarks.json']) {
  try {
    await cp(resolve(root, 'artifacts', name), resolve(output, name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`${name} evidence missing. Run npm run verify before building.`);
  }
}
await writeFile(resolve(output, '.nojekyll'), '');
await writeFile(resolve(output, 'version.json'), JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2));
console.log(`Built ${pkg.name} ${pkg.version} in ${output}. No dependencies or network requests required.`);
