import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const outBase = resolve(scriptDir, '..', 'src-tauri', 'bin', 'skill-switch-cli');
const rustToolchain = process.env.RUSTUP_TOOLCHAIN || '1.88.0';
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function rustcCandidates() {
  return ['rustc', resolve(homedir(), '.cargo', 'bin', 'rustc')];
}

function hostTriple() {
  for (const rustc of rustcCandidates()) {
    try {
      return execFileSync(rustc, ['--print', 'host-tuple'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, RUSTUP_TOOLCHAIN: rustToolchain },
      }).trim();
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Unable to determine Rust host tuple for Tauri sidecar naming.');
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
}

function runOptional(command, args, label) {
  try {
    run(command, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: ${label}: ${message}`);
  }
}

function postjectBin() {
  return resolve(scriptDir, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');
}

function postjectArgs(outfile, blobPath) {
  const args = [outfile, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', seaFuse];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  return args;
}

function seaNodeCandidates() {
  return [
    process.env.SKILL_SWITCH_SEA_NODE,
    process.execPath,
    resolve(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
  ].filter((candidate, index, candidates) => Boolean(candidate) && candidates.indexOf(candidate) === index);
}

function containsSeaFuse(candidate) {
  if (!existsSync(candidate)) return false;
  return readFileSync(candidate).includes(seaFuse);
}

function seaNodeExecutable() {
  for (const candidate of seaNodeCandidates()) {
    if (containsSeaFuse(candidate)) return candidate;
  }
  throw new Error(
    [
      'Unable to find a Node executable with the SEA fuse marker.',
      'Homebrew Node may be a small dynamic-link stub without the marker.',
      'Set SKILL_SWITCH_SEA_NODE to an official Node executable, then rerun pnpm --dir gui bundle:cli.',
    ].join(' '),
  );
}

const extension = process.platform === 'win32' ? '.exe' : '';
const outfile = `${outBase}-${hostTriple()}${extension}`;
const tempDir = await mkdtemp(join(tmpdir(), 'skill-switch-sea-'));
const nodeForSea = seaNodeExecutable();

await mkdir(dirname(outfile), { recursive: true });
const result = await build({
  entryPoints: [resolve(scriptDir, 'cli-sidecar-entry.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
  write: false,
});
const bundle = result.outputFiles[0]?.text;
if (!bundle) throw new Error('esbuild produced no sidecar output.');

try {
  const bundlePath = join(tempDir, 'skill-switch-cli.cjs');
  const seaConfigPath = join(tempDir, 'sea-config.json');
  const seaBlobPath = join(tempDir, 'skill-switch-cli.blob');

  await writeFile(bundlePath, bundle, 'utf8');
  await writeFile(
    seaConfigPath,
    `${JSON.stringify(
      {
        main: bundlePath,
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  run(nodeForSea, ['--experimental-sea-config', seaConfigPath]);
  await rm(outfile, { force: true });
  await copyFile(nodeForSea, outfile);
  await chmod(outfile, 0o755);

  if (process.platform === 'darwin') {
    runOptional('codesign', ['--remove-signature', outfile], 'could not remove an existing signature before SEA injection');
  }

  run(postjectBin(), postjectArgs(outfile, seaBlobPath));

  if (process.platform === 'darwin') {
    run('codesign', ['--sign', '-', '--force', outfile]);
  }

  await chmod(outfile, 0o755);
} finally {
  if (!process.env.SKILL_SWITCH_KEEP_SEA_TEMP) {
    await rm(tempDir, { recursive: true, force: true });
  } else {
    console.log(`Kept SEA temp directory: ${tempDir}`);
  }
}

console.log(`Bundled self-contained skill-switch CLI sidecar: ${outfile}`);
