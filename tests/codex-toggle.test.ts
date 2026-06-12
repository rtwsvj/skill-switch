// S4.2:Codex 原生开关 — config.toml 行级手术式编辑(保留用户内容)+ sync 集成:
// codex 的 disable 不删文件,写 [[skills.config]] enabled=false。
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCodexConfigPath,
  readCodexSkillEnabled,
  setCodexSkillEnabled,
} from '../src/core/codex-toggle.ts';
import { applySync, type SkillsDeclarationFile } from '../src/core/sync.ts';

let home: string;
let config: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-codex-'));
  config = getCodexConfigPath(home);
});

describe('core/codex-toggle (toml surgery)', () => {
  it('creates the config with a [[skills.config]] section when missing', async () => {
    const { changed } = await setCodexSkillEnabled(config, '/x/skills/foo', false);
    expect(changed).toBe(true);
    const text = await readFile(config, 'utf8');
    expect(text).toContain('[[skills.config]]');
    expect(text).toContain('path = "/x/skills/foo"');
    expect(text).toContain('enabled = false');
  });

  it('preserves unrelated user content byte-for-byte', async () => {
    const seed = `# my codex config\nmodel = "o5"\n\n[profiles.fast]\nmodel = "o5-mini"  # quick\n`;
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(config, seed);

    await setCodexSkillEnabled(config, '/x/skills/foo', false);
    const text = await readFile(config, 'utf8');
    expect(text.startsWith(seed)).toBe(true);
  });

  it('updates enabled in place without duplicating sections', async () => {
    await setCodexSkillEnabled(config, '/x/skills/foo', false);
    await setCodexSkillEnabled(config, '/x/skills/foo', true);
    const text = await readFile(config, 'utf8');
    expect(text.match(/\[\[skills\.config\]\]/g)).toHaveLength(1);
    expect(text).toContain('enabled = true');
    expect(text).not.toContain('enabled = false');
  });

  it('is idempotent: same state twice → unchanged content', async () => {
    await setCodexSkillEnabled(config, '/x/skills/foo', false);
    const first = await readFile(config, 'utf8');
    const { changed } = await setCodexSkillEnabled(config, '/x/skills/foo', false);
    expect(changed).toBe(false);
    expect(await readFile(config, 'utf8')).toBe(first);
  });

  it('reads back undefined / false / true', async () => {
    expect(await readCodexSkillEnabled(config, '/x/skills/foo')).toBeUndefined();
    await setCodexSkillEnabled(config, '/x/skills/foo', false);
    expect(await readCodexSkillEnabled(config, '/x/skills/foo')).toBe(false);
    await setCodexSkillEnabled(config, '/x/skills/foo', true);
    expect(await readCodexSkillEnabled(config, '/x/skills/foo')).toBe(true);
  });

  it('handles multiple sections, touching only the matching path', async () => {
    await setCodexSkillEnabled(config, '/x/skills/foo', false);
    await setCodexSkillEnabled(config, '/x/skills/bar', false);
    await setCodexSkillEnabled(config, '/x/skills/foo', true);
    expect(await readCodexSkillEnabled(config, '/x/skills/foo')).toBe(true);
    expect(await readCodexSkillEnabled(config, '/x/skills/bar')).toBe(false);
  });
});

describe('sync integration: codex disable keeps files, writes config', () => {
  async function makeStoreSkill(name: string): Promise<string> {
    const dir = join(home, '.skill-switch', 'store', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d.\n---\nB.\n`);
    return dir;
  }

  it('enabled→disabled→re-enabled roundtrip', async () => {
    const src = await makeStoreSkill('gamma');
    const target = join(home, '.codex', 'skills', 'gamma');

    const enabled: SkillsDeclarationFile = {
      version: 1,
      skills: [{ name: 'gamma', source: src, agents: ['codex'], enabled: true, mode: 'copy' }],
    };
    let res = await applySync(home, enabled);
    expect(res.actions.map((a) => a.kind)).toEqual(['create']);
    await lstat(target); // 文件就位

    const disabled: SkillsDeclarationFile = {
      version: 1,
      skills: [{ name: 'gamma', source: src, agents: ['codex'], enabled: false, mode: 'copy' }],
    };
    res = await applySync(home, disabled);
    expect(res.actions.map((a) => a.kind)).toEqual(['config-disable']);
    await lstat(target); // 文件仍在(不删)
    expect(await readCodexSkillEnabled(getCodexConfigPath(home), target)).toBe(false);

    // 幂等
    res = await applySync(home, disabled);
    expect(res.actions.every((a) => a.kind === 'noop')).toBe(true);

    // 重新启用:config 翻回 true,文件 noop
    res = await applySync(home, enabled);
    expect(res.actions.map((a) => a.kind).sort()).toEqual(['config-enable', 'noop']);
    expect(await readCodexSkillEnabled(getCodexConfigPath(home), target)).toBe(true);
  });
});
