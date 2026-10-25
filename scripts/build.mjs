// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
try {
  await cp(resolve(root, 'artifacts/verification.json'), resolve(output, 'verification.json'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  throw new Error('Verification evidence missing. Run npm run verify before building.');
}
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await writeFile(resolve(output, '.nojekyll'), '');
await writeFile(resolve(output, 'version.json'), JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2));
console.log(`Built ${pkg.name} ${pkg.version} in ${output}. No dependencies or network requests required.`);
