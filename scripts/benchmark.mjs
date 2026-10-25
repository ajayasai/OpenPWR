// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runBenchmarks } from '../src/benchmarks.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const gitValue = args => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); }
  catch { return null; }
};
const started = performance.now();
const result = await runBenchmarks();
const report = {
  schema: 'openpwr-benchmarks/v1', version: pkg.version, generatedAt: new Date().toISOString(),
  runtime: `Node ${process.version} / ${process.platform} / ${process.arch}`,
  gitRevision: gitValue(['rev-parse', 'HEAD']), workingTreeDirty: Boolean(gitValue(['status', '--porcelain'])),
  ...result,
  passed: result.checks.filter(check => check.pass).length,
  wallTimeSeconds: (performance.now() - started) / 1000,
};
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await writeFile(resolve(root, 'artifacts/benchmarks.json'), JSON.stringify(report, null, 2) + '\n');
for (const check of report.checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`);
}
console.log(`${report.passed}/${report.checks.length} published benchmark checks passed in ${report.wallTimeSeconds.toFixed(2)} s.`);
console.log(report.scope);
if (report.passed !== report.checks.length) process.exitCode = 1;
