import { CommanderError } from 'commander';
import { buildProgram } from './program.ts';

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    process.exit(err.exitCode);
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(`错误: ${message}`);
  process.exit(1);
}
