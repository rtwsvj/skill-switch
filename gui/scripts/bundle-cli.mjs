import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const outBase = resolve(scriptDir, '..', 'src-tauri', 'bin', 'skill-switch-cli');
const rustToolchain = process.env.RUSTUP_TOOLCHAIN || '1.88.0';

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

const extension = process.platform === 'win32' ? '.exe' : '';
const outfile = `${outBase}-${hostTriple()}${extension}`;

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

await writeFile(
  outfile,
  `#!/bin/sh\nexec node - "$@" <<'__SKILL_SWITCH_CLI__'\n${bundle}\n__SKILL_SWITCH_CLI__\n`,
  'utf8',
);
await chmod(outfile, 0o755);

console.log(`Bundled skill-switch CLI sidecar: ${outfile}`);
