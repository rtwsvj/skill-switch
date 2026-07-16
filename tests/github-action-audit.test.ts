import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ActionInputError,
  tokenizeExtraArgs,
  validateFormat,
  validateOutputPath,
  validateVersion,
} from '../scripts/github-action-audit.mjs';

const ROOT = join(import.meta.dirname, '..');
const WRAPPER = join(ROOT, 'scripts', 'github-action-audit.mjs');
const ACTION = join(ROOT, 'action.yml');

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'skill-switch-action-'));
  const bin = join(workspace, 'bin');
  const argvLog = join(workspace, 'argv.json');
  const githubOutput = join(workspace, 'github-output.txt');
  const fakeNpx = join(bin, 'npx');
  mkdirSync(bin);
  writeFileSync(
    fakeNpx,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write('fake audit output\\n');
process.stderr.write('fake audit stderr\\n');
process.exit(Number(process.env.FAKE_EXIT_CODE || '0'));
`,
  );
  chmodSync(fakeNpx, 0o755);
  writeFileSync(githubOutput, '');
  return { workspace, argvLog, githubOutput };
}

describe('GitHub Action audit wrapper', () => {
  it('tokenizes quotes and escapes without performing shell expansion', () => {
    expect(tokenizeExtraArgs(`--configs --label "two words" '' semi\\;colon $HOME $(touch marker) \`id\``)).toEqual([
      '--configs',
      '--label',
      'two words',
      '',
      'semi;colon',
      '$HOME',
      '$(touch',
      'marker)',
      '`id`',
    ]);
    expect(() => tokenizeExtraArgs("'unterminated")).toThrow(ActionInputError);
    expect(() => tokenizeExtraArgs('dangling\\')).toThrow(ActionInputError);
  });

  it('passes hostile input as literal argv and preserves audit exit/output behavior', () => {
    const { workspace, argvLog, githubOutput } = fixture();
    const marker = join(workspace, 'SHOULD_NOT_EXIST');
    const output = join(workspace, 'audit.json');
    const hostile = `--configs ;\ntouch ${marker} $(touch ${marker}) \`touch ${marker}\` "quoted value"`;
    const result = spawnSync(process.execPath, [WRAPPER], {
      cwd: workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(workspace, 'bin')}${delimiter}${process.env.PATH}`,
        ARGV_LOG: argvLog,
        FAKE_EXIT_CODE: '1',
        GITHUB_OUTPUT: githubOutput,
        GITHUB_WORKSPACE: workspace,
        SKILL_SWITCH_ARGS: hostile,
        SKILL_SWITCH_FORMAT: 'json',
        SKILL_SWITCH_OUTPUT: 'audit.json',
        SKILL_SWITCH_PATH: '.',
        SKILL_SWITCH_VERSION: '0.9.0',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('fake audit output');
    expect(result.stdout).toContain('skill-switch audit exit code: 1');
    expect(result.stderr).toContain('fake audit stderr');
    expect(readFileSync(githubOutput, 'utf8')).toBe('exit-code=1\n');
    expect(() => readFileSync(marker)).toThrow();

    const argv = JSON.parse(readFileSync(argvLog, 'utf8')) as string[];
    expect(argv.slice(0, 7)).toEqual([
      '--yes',
      '--package',
      '@rtwsvj/skill-switch@0.9.0',
      '--',
      'skill-switch',
      'audit',
      '.',
    ]);
    expect(argv).toContain(';');
    expect(argv).toContain('touch');
    expect(argv).toContain(`$(touch`);
    expect(argv).toContain('quoted value');
    expect(readFileSync(output, 'utf8')).toBe('fake audit output\n');
  });

  it('rejects unsafe configuration before starting npx', () => {
    const { workspace, argvLog, githubOutput } = fixture();
    const baseEnv = {
      ...process.env,
      PATH: `${join(workspace, 'bin')}${delimiter}${process.env.PATH}`,
      ARGV_LOG: argvLog,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_WORKSPACE: workspace,
      SKILL_SWITCH_ARGS: '',
      SKILL_SWITCH_FORMAT: 'sarif',
      SKILL_SWITCH_OUTPUT: 'result.sarif',
      SKILL_SWITCH_PATH: '.',
      SKILL_SWITCH_VERSION: '0.9.0',
    };

    for (const override of [
      { SKILL_SWITCH_FORMAT: 'sarif; touch marker' },
      { SKILL_SWITCH_VERSION: 'latest' },
      { SKILL_SWITCH_OUTPUT: '../outside.sarif' },
    ]) {
      const result = spawnSync(process.execPath, [WRAPPER], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...baseEnv, ...override },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('::error::');
      expect(() => readFileSync(argvLog)).toThrow();
    }
  });

  it('validates the public input helpers', () => {
    expect(validateFormat('github')).toBe('github');
    expect(() => validateFormat('xml')).toThrow(ActionInputError);
    expect(validateVersion('1.2.3-beta.1+build.9')).toBe('1.2.3-beta.1+build.9');
    expect(() => validateVersion('1.2')).toThrow(ActionInputError);

    const workspace = mkdtempSync(join(tmpdir(), 'skill-switch-output-'));
    expect(validateOutputPath('result.sarif', workspace)).toBe(join(realpathSync(workspace), 'result.sarif'));
    expect(() => validateOutputPath('../result.sarif', workspace)).toThrow(ActionInputError);
  });

  it('pins the Action default to the package release version', () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const action = readFileSync(ACTION, 'utf8');
    const versionDefault = /\n {2}version:[\s\S]*?\n {4}default: '([^']+)'/.exec(action)?.[1];
    expect(versionDefault).toBe(packageJson.version);
  });
});
