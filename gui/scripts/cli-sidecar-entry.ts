import { CommanderError } from 'commander';
import { buildProgram } from '../../src/cli/program.ts';

function userArgs(): string[] {
  const launcher = process.argv[1] ?? '';
  if (launcher === process.argv[0] || launcher === process.execPath) return process.argv.slice(2);
  if (launcher === '-' || /\.[cm]?[jt]s$/.test(launcher)) return process.argv.slice(2);
  return process.argv.slice(1);
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(userArgs(), { from: 'user' });
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
