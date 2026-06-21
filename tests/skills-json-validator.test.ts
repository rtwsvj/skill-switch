// Tests for src/core/lint/skills-json-validator.ts
// Covers: valid file passes; invalid structures produce expected findings;
// also verifies lintHome wires in the validator and that existing lint tests stay green.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateSkillsJson } from '../src/core/lint/skills-json-validator.ts';
import { lintHome } from '../src/core/lint/lint-home.ts';

// ---------------------------------------------------------------------------
// Pure unit tests — validateSkillsJson
// ---------------------------------------------------------------------------

const VALID: unknown = {
  version: 1,
  skills: [
    {
      name: 'my-skill',
      source: '/home/user/.skills/my-skill',
      agents: ['claude-code'],
      enabled: true,
      mode: 'symlink',
    },
  ],
};

describe('validateSkillsJson: valid input', () => {
  it('returns no findings for a well-formed skills.json', () => {
    expect(validateSkillsJson(VALID)).toEqual([]);
  });

  it('returns no findings when skills array is empty', () => {
    expect(validateSkillsJson({ version: 1, skills: [] })).toEqual([]);
  });

  it('returns no findings when optional agentSources is present and valid', () => {
    const withOverride: unknown = {
      version: 1,
      skills: [
        {
          name: 'my-skill',
          source: '/path/a',
          agents: ['claude-code', 'codex'],
          enabled: false,
          mode: 'copy',
          agentSources: {
            'claude-code': { source: '/path/b', mode: 'symlink' },
          },
        },
      ],
    };
    expect(validateSkillsJson(withOverride)).toEqual([]);
  });
});

describe('validateSkillsJson: top-level shape errors', () => {
  it('rejects non-object root (array)', () => {
    const findings = validateSkillsJson([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('skills-json/invalid-root');
    expect(findings[0]!.severity).toBe('error');
  });

  it('rejects non-object root (string)', () => {
    const findings = validateSkillsJson('bad');
    expect(findings[0]!.rule).toBe('skills-json/invalid-root');
  });

  it('rejects missing version field', () => {
    const findings = validateSkillsJson({ skills: [] });
    expect(findings.some((f) => f.rule === 'skills-json/missing-version')).toBe(true);
  });

  it('rejects version !== 1', () => {
    const findings = validateSkillsJson({ version: 2, skills: [] });
    expect(findings.some((f) => f.rule === 'skills-json/bad-version')).toBe(true);
    expect(findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it('rejects version as string "1"', () => {
    const findings = validateSkillsJson({ version: '1', skills: [] });
    expect(findings.some((f) => f.rule === 'skills-json/bad-version')).toBe(true);
  });

  it('rejects missing skills field', () => {
    const findings = validateSkillsJson({ version: 1 });
    expect(findings.some((f) => f.rule === 'skills-json/missing-skills')).toBe(true);
  });

  it('rejects skills as non-array', () => {
    const findings = validateSkillsJson({ version: 1, skills: {} });
    expect(findings.some((f) => f.rule === 'skills-json/skills-not-array')).toBe(true);
  });
});

describe('validateSkillsJson: per-skill field errors', () => {
  function skillWith(overrides: Record<string, unknown>): unknown {
    return {
      version: 1,
      skills: [
        {
          name: 'my-skill',
          source: '/path/to/skill',
          agents: ['claude-code'],
          enabled: true,
          mode: 'symlink',
          ...overrides,
        },
      ],
    };
  }

  it('rejects missing name', () => {
    const obj: Record<string, unknown> = {
      source: '/path', agents: ['claude-code'], enabled: true, mode: 'symlink',
    };
    const findings = validateSkillsJson({ version: 1, skills: [obj] });
    expect(findings.some((f) => f.rule === 'skills-json/skill-missing-name')).toBe(true);
  });

  it('rejects empty name', () => {
    const findings = validateSkillsJson(skillWith({ name: '  ' }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-bad-name')).toBe(true);
  });

  it('rejects non-string name', () => {
    const findings = validateSkillsJson(skillWith({ name: 42 }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-bad-name')).toBe(true);
  });

  it('rejects missing source', () => {
    // Spread with undefined leaves key present but undefined — build without the key instead
    const obj: Record<string, unknown> = { name: 'x', agents: ['claude-code'], enabled: true, mode: 'symlink' };
    const r = validateSkillsJson({ version: 1, skills: [obj] });
    expect(r.some((f) => f.rule === 'skills-json/skill-missing-source')).toBe(true);
  });

  it('rejects empty source string', () => {
    const findings = validateSkillsJson(skillWith({ source: '' }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-bad-source')).toBe(true);
  });

  it('rejects missing agents', () => {
    const obj: Record<string, unknown> = { name: 'x', source: '/p', enabled: true, mode: 'symlink' };
    const findings = validateSkillsJson({ version: 1, skills: [obj] });
    expect(findings.some((f) => f.rule === 'skills-json/skill-missing-agents')).toBe(true);
  });

  it('rejects agents as non-array', () => {
    const findings = validateSkillsJson(skillWith({ agents: 'claude-code' }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-agents-not-array')).toBe(true);
  });

  it('rejects empty agents array', () => {
    const findings = validateSkillsJson(skillWith({ agents: [] }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-agents-empty')).toBe(true);
  });

  it('rejects agent entry that is not a string', () => {
    const findings = validateSkillsJson(skillWith({ agents: [123] }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-agent-not-string')).toBe(true);
  });

  it('warns for unknown agent name (forward-compat)', () => {
    const findings = validateSkillsJson(skillWith({ agents: ['totally-new-agent'] }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-unknown-agent' && f.severity === 'warning')).toBe(true);
    // Should not be an error — forward-compat
    expect(findings.every((f) => f.severity !== 'error')).toBe(true);
  });

  it('rejects missing enabled', () => {
    const obj: Record<string, unknown> = { name: 'x', source: '/p', agents: ['claude-code'], mode: 'symlink' };
    const findings = validateSkillsJson({ version: 1, skills: [obj] });
    expect(findings.some((f) => f.rule === 'skills-json/skill-missing-enabled')).toBe(true);
  });

  it('rejects enabled as non-boolean', () => {
    const findings = validateSkillsJson(skillWith({ enabled: 'yes' }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-bad-enabled')).toBe(true);
  });

  it('rejects missing mode', () => {
    const obj: Record<string, unknown> = { name: 'x', source: '/p', agents: ['claude-code'], enabled: true };
    const findings = validateSkillsJson({ version: 1, skills: [obj] });
    expect(findings.some((f) => f.rule === 'skills-json/skill-missing-mode')).toBe(true);
  });

  it('rejects invalid mode value', () => {
    const findings = validateSkillsJson(skillWith({ mode: 'hardlink' }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-bad-mode')).toBe(true);
    expect(findings.some((f) => f.message.includes('hardlink'))).toBe(true);
  });

  it('accepts both valid mode values', () => {
    expect(validateSkillsJson(skillWith({ mode: 'symlink' }))).toEqual([]);
    expect(validateSkillsJson(skillWith({ mode: 'copy' }))).toEqual([]);
  });
});

describe('validateSkillsJson: agentSources validation', () => {
  function withAgentSources(agentSources: unknown): unknown {
    return {
      version: 1,
      skills: [
        {
          name: 'x',
          source: '/p',
          agents: ['claude-code'],
          enabled: true,
          mode: 'symlink',
          agentSources,
        },
      ],
    };
  }

  it('rejects agentSources as non-object (array)', () => {
    const findings = validateSkillsJson(withAgentSources([]));
    expect(findings.some((f) => f.rule === 'skills-json/skill-bad-agentSources')).toBe(true);
  });

  it('rejects agentSources entry with empty source', () => {
    const findings = validateSkillsJson(withAgentSources({ 'claude-code': { source: '', mode: 'copy' } }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-agentSource-bad-source')).toBe(true);
  });

  it('rejects agentSources entry with bad mode', () => {
    const findings = validateSkillsJson(withAgentSources({ 'claude-code': { source: '/p', mode: 'bad' } }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-agentSource-bad-mode')).toBe(true);
  });

  it('warns for unknown agent key in agentSources', () => {
    const findings = validateSkillsJson(withAgentSources({ 'new-bot': { source: '/p', mode: 'copy' } }));
    expect(findings.some((f) => f.rule === 'skills-json/skill-unknown-agent' && f.severity === 'warning')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: lintHome wires in skills.json validation
// ---------------------------------------------------------------------------

describe('lintHome: skills.json findings surface in HomeLintReport', () => {
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'skill-switch-lint-'));
    await mkdir(join(home, '.skill-switch'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('reports no skillsJsonFindings when skills.json is absent', async () => {
    const report = await lintHome(home, 'claude-code');
    expect(report.skillsJsonFindings).toEqual([]);
    // absence alone does not cause hasErrors
    expect(report.hasErrors).toBe(false);
  });

  it('reports no skillsJsonFindings for a valid skills.json', async () => {
    await writeFile(
      join(home, '.skill-switch', 'skills.json'),
      JSON.stringify({ version: 1, skills: [] }),
    );
    const report = await lintHome(home, 'claude-code');
    expect(report.skillsJsonFindings).toEqual([]);
  });

  it('reports parse error finding when skills.json is not valid JSON', async () => {
    await writeFile(join(home, '.skill-switch', 'skills.json'), '{ broken json }');
    const report = await lintHome(home, 'claude-code');
    expect(report.skillsJsonFindings.some((f) => f.rule === 'skills-json/parse-error')).toBe(true);
    expect(report.skillsJsonFindings.some((f) => f.severity === 'error')).toBe(true);
    expect(report.hasErrors).toBe(true);
  });

  it('surfaces version error when version is wrong', async () => {
    await writeFile(
      join(home, '.skill-switch', 'skills.json'),
      JSON.stringify({ version: 99, skills: [] }),
    );
    const report = await lintHome(home, 'claude-code');
    expect(report.skillsJsonFindings.some((f) => f.rule === 'skills-json/bad-version')).toBe(true);
    expect(report.hasErrors).toBe(true);
  });

  it('surfaces skill-level errors (missing name, bad mode)', async () => {
    const bad = {
      version: 1,
      skills: [
        {
          // name missing
          source: '/path/to/skill',
          agents: ['claude-code'],
          enabled: true,
          mode: 'turbo', // bad mode
        },
      ],
    };
    await writeFile(
      join(home, '.skill-switch', 'skills.json'),
      JSON.stringify(bad),
    );
    const report = await lintHome(home, 'claude-code');
    const rules = report.skillsJsonFindings.map((f) => f.rule);
    expect(rules).toContain('skills-json/skill-missing-name');
    expect(rules).toContain('skills-json/skill-bad-mode');
    expect(report.hasErrors).toBe(true);
  });

  it('unknown agent produces warning (not error) and does not set hasErrors alone', async () => {
    const withUnknown = {
      version: 1,
      skills: [
        {
          name: 'my-skill',
          source: '/path',
          agents: ['future-agent-9000'],
          enabled: true,
          mode: 'symlink',
        },
      ],
    };
    await writeFile(
      join(home, '.skill-switch', 'skills.json'),
      JSON.stringify(withUnknown),
    );
    const report = await lintHome(home, 'claude-code');
    const warnings = report.skillsJsonFindings.filter((f) => f.severity === 'warning');
    expect(warnings.some((f) => f.rule === 'skills-json/skill-unknown-agent')).toBe(true);
    expect(report.skillsJsonFindings.every((f) => f.severity !== 'error')).toBe(true);
    // warning-only → hasErrors should still be false (unless conflicts exist)
    expect(report.hasErrors).toBe(false);
  });
});
