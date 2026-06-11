import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program.ts';

const EXPECTED_SUBCOMMANDS = [
  'scan',
  'audit',
  'install',
  'lock',
  'toggle',
  'lint',
  'doctor',
  'drift',
  'stats',
];

describe('cli program', () => {
  it('registers every governance subcommand from the roadmap', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    for (const name of EXPECTED_SUBCOMMANDS) {
      expect(names).toContain(name);
    }
  });

  it('exposes a name and description for --help output', () => {
    const program = buildProgram();
    expect(program.name()).toBe('skill-switch');
    expect(program.description()).not.toBe('');
    for (const command of program.commands) {
      expect(command.description()).not.toBe('');
    }
  });
});
