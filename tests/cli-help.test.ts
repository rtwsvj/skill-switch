import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('exposes a global --home override (S1.2)', () => {
    const program = buildProgram();
    expect(program.helpInformation()).toContain('--home <dir>');
  });

  it('exposes a name and description for --help output', () => {
    const program = buildProgram();
    expect(program.name()).toBe('skill-switch');
    expect(program.description()).not.toBe('');
    for (const command of program.commands) {
      expect(command.description()).not.toBe('');
    }
  });

  it('reports a version (-V/--version) that matches package.json', () => {
    const program = buildProgram();
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    // commander 的 .version() getter 返回已配置的版本号;须与 package.json 同步。
    expect(program.version()).toBe(pkg.version);
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
    // -V 与 --version 两个旗标都注册了
    expect(program.helpInformation()).toContain('--version');
  });
});
