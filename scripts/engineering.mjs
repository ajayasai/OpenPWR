// SPDX-License-Identifier: Apache-2.0
// Optional native toolchain launcher. The browser-only edition has no Python/FMI dependency.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2];
const extra = process.argv.slice(3);
const configPath = resolve(root, 'artifacts/engineering-runtime.json');
let runtime;
const probe = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
function execute(command, args, environment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...environment } });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
  });
}
function run(args, environment = {}) {
  return runtime.kind === 'wsl'
    ? execute('wsl.exe', ['-d', runtime.distribution, '--cd', runtime.root, '--', 'env', ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), ...args])
    : execute(args[0], args.slice(1), environment);
}
try {
  if (action === 'setup') {
    await mkdir(resolve(root, 'artifacts'), { recursive: true });
    if (!extra.includes('--wsl') && probe(process.env.OPENPWR_OMC || 'omc', ['--version']).status === 0) {
      runtime = { kind: 'native', root, python: process.platform === 'win32' ? 'python' : 'python3',
        venvPython: resolve(root, 'artifacts/engineering-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') };
    } else if (process.platform === 'win32') {
      const distribution = process.env.OPENPWR_WSL_DISTRO || 'Ubuntu';
      if (probe('wsl.exe', ['-d', distribution, '--', 'omc', '--version']).status !== 0) throw new Error('Install OpenModelica first (native or Ubuntu WSL). See docs/ENGINEERING.md.');
      const translated = probe('wsl.exe', ['-d', distribution, '--', 'wslpath', '-a', root.replaceAll('\\', '/')]);
      if (translated.status !== 0) throw new Error('Could not translate workspace path to WSL.');
      const linuxRoot = translated.stdout.trim();
      runtime = { kind: 'wsl', distribution, root: linuxRoot, python: 'python3', venvPython: `${linuxRoot}/artifacts/engineering-venv/bin/python` };
    } else throw new Error('OpenModelica omc is not on PATH. Install it first; see docs/ENGINEERING.md.');
    console.log(`Preparing isolated ${runtime.kind} engineering environment…`);
    await run([runtime.python, '-m', 'venv', 'artifacts/engineering-venv']);
    await run([runtime.venvPython, '-m', 'pip', 'install', '-r', 'backend/requirements.txt']);
    await writeFile(configPath, JSON.stringify(runtime, null, 2));
    console.log('Ready. Next: npm run engineering:build');
  } else {
    try { runtime = JSON.parse(await readFile(configPath, 'utf8')); }
    catch { throw new Error('Run npm run engineering:setup first.'); }
    if (action === 'build') {
      await run([runtime.venvPython, 'scripts/modelica/build.py', ...extra]);
      await run([runtime.venvPython, 'scripts/modelica/build.py', '--model', 'plant']);
      await run([runtime.venvPython, 'scripts/modelica/build.py', '--model', 'kinetics']);
      await run([runtime.venvPython, 'models/reference-checks.py', '--build']);
    }
    else if (action === 'build-plant') await run([runtime.venvPython, 'scripts/modelica/build.py', '--model', 'plant', ...extra]);
    else if (action === 'start') await run([runtime.venvPython, 'backend/server.py', ...extra]);
    else if (action === 'experiment') await run([runtime.venvPython, 'backend/experiments.py', ...extra]);
    else if (action === 'measured') await run([runtime.venvPython, 'validation/krsko2005/compare.py', ...extra]);
    else if (action === 'profile') await run([runtime.venvPython, 'models/performance-checks.py', ...extra]);
    else if (action === 'test') {
      await run([runtime.venvPython, '-m', 'unittest', 'discover', '-s', 'backend', '-p', 'test_*.py'], { OPENPWR_FMU: 'artifacts/modelica/PrimaryLoop.fmu', OPENPWR_PLANT_FMU: 'artifacts/modelica/CoupledPlant.fmu' });
      await run([runtime.venvPython, '-m', 'unittest', 'discover', '-s', 'validation/krsko2005', '-p', 'test_*.py']);
    }
    else if (action === 'verify') {
      await run([runtime.venvPython, 'backend/verify.py', ...extra]);
      await run([runtime.venvPython, 'models/reference-checks.py']);
    }
    else if (action === 'verify-plant') await run([runtime.venvPython, 'backend/verify_plant.py', ...extra]);
    else throw new Error('Choose setup, build, build-plant, start, test, verify, verify-plant, measured, experiment, or profile.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
