// M0-5.9 wiring:install 入口拒绝非规范名;doctor 对既有 legacy 名给迁移告警(不硬拒)。
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/core/doctor.ts';
import { installFromSource } from '../src/core/install.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-namewiring-'));
});

describe('M0-5.9 canonical name wiring', () => {
  it('install rejects a non-canonical (spaced) skill name without writing anything', async () => {
    const source = join(home, 'src');
    await mkdir(join(source, 'my skill'), { recursive: true });
    await writeFile(join(source, 'my skill', 'SKILL.md'), '---\nname: my skill\ndescription: harmless.\n---\nok\n');

    await expect(
      installFromSource(source, { home, agent: 'claude-code', mode: 'copy' }),
    ).rejects.toThrow(/规范命名|canonical/);
  });

  it('doctor surfaces legacy (non-canonical) declared names as a migration warning, not a hard error', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(
      join(home, '.skill-switch', 'skills.json'),
      JSON.stringify({
        version: 1,
        skills: [
          { name: 'legacy name', source: '/x', agents: ['claude-code'], enabled: false, mode: 'copy' },
          { name: 'good-skill', source: '/y', agents: ['claude-code'], enabled: false, mode: 'copy' },
        ],
      }),
    );

    const report = await runDoctor(home);
    expect(report.legacyNames).toContain('legacy name');
    expect(report.legacyNames).not.toContain('good-skill');
  });
});
