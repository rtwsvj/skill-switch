// S1.2:core/paths.ts 是自有代码解析目录的唯一入口。
// 最后一个用例做全仓库静态断言:src/ 下(vendor 除外)只有 paths.ts 允许调用 homedir()。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getAgentSkillsLocations,
  resolveGlobalSkillsDir,
  resolveHomeRoot,
} from '../src/core/paths.ts';

const FIXTURE_HOME = join(import.meta.dirname, 'fixtures', 'home-basic');
const SRC_ROOT = join(import.meta.dirname, '..', 'src');

function walkTsFiles(dir: string, skip: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full === skip) continue;
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full, skip));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('core/paths', () => {
  it('defaults to os.homedir() (sandboxed by tests/setup.ts)', () => {
    expect(resolveHomeRoot()).toBe(homedir());
    expect(homedir()).toContain('skill-switch-home-');
  });

  it('an injected home overrides the default', () => {
    expect(resolveHomeRoot(FIXTURE_HOME)).toBe(FIXTURE_HOME);
  });

  it('derives home-relative global skills dirs from the vendor agents map', () => {
    const locations = getAgentSkillsLocations();
    const byAgent = new Map(locations.map((l) => [l.agent, l.relGlobalSkillsDir]));

    expect(byAgent.get('claude-code')).toBe(join('.claude', 'skills'));
    expect(byAgent.get('gemini-cli')).toBe(join('.gemini', 'skills'));
    expect([...byAgent.values()]).toContain(join('.agents', 'skills'));

    for (const location of locations) {
      expect(location.relGlobalSkillsDir.startsWith('..'), location.agent).toBe(false);
      expect(location.relGlobalSkillsDir.startsWith('/'), location.agent).toBe(false);
    }
  });

  it('re-roots global skills dirs onto the injected home (fixture roundtrip)', () => {
    const claude = getAgentSkillsLocations().find((l) => l.agent === 'claude-code');
    expect(claude).toBeDefined();
    const dir = resolveGlobalSkillsDir(FIXTURE_HOME, claude!);
    expect(relative(FIXTURE_HOME, dir)).toBe(join('.claude', 'skills'));
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('no own src code bypasses paths.ts with a direct homedir() call', () => {
    const vendorDir = join(SRC_ROOT, 'vendor');
    const offenders = walkTsFiles(SRC_ROOT, vendorDir).filter((file) =>
      /\bhomedir\s*\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => relative(SRC_ROOT, f))).toEqual([join('core', 'paths.ts')]);
  });
});
