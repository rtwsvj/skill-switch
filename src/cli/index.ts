import { realpathSync } from 'node:fs';
import { isSea } from 'node:sea';
import { CommanderError } from 'commander';
import { buildProgram } from './program.ts';

function sameExecutablePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  if (left === right) return true;

  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
}

function seaUserArgs(argv: string[]): string[] {
  const maybeExecutableArg = argv[1];
  if (sameExecutablePath(maybeExecutableArg, argv[0]) || sameExecutablePath(maybeExecutableArg, process.execPath)) {
    return argv.slice(2);
  }
  return argv.slice(1);
}

async function main(): Promise<void> {
  try {
    if (isSea()) {
      await buildProgram().parseAsync(seaUserArgs(process.argv), { from: 'user' });
    } else {
      await buildProgram().parseAsync(process.argv);
    }
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error(`错误: ${message}`);
    process.exit(1);
  }
}

void main();
