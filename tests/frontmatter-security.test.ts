import { describe, expect, it } from 'vitest';
import {
  MAX_FRONTMATTER_ALIASES,
  parseFrontmatter,
} from '../src/core/frontmatter.ts';

describe('hardened frontmatter parser', () => {
  it('preserves the data/content contract for common Agent Skills metadata', () => {
    const raw = [
      '\uFEFF---\r',
      'name: deploy-helper\r',
      'description: |\r',
      '  Deploys a service safely.\r',
      'tags: [deploy, ci]\r',
      'metadata:\r',
      '  owner: platform\r',
      'enabled: true\r',
      'retries: 3\r',
      '---\r',
      '\r',
      '# Deploy Helper\r',
    ].join('\n');

    const { data, content } = parseFrontmatter(raw);

    expect(data).toEqual({
      name: 'deploy-helper',
      description: 'Deploys a service safely.\n',
      tags: ['deploy', 'ci'],
      metadata: { owner: 'platform' },
      enabled: true,
      retries: 3,
    });
    expect(content).toBe('\r\n# Deploy Helper\r');
  });

  it('returns an empty metadata object and preserves BOM-free Markdown without frontmatter', () => {
    expect(parseFrontmatter('\uFEFF# Plain skill\nBody')).toEqual({
      data: {},
      content: '# Plain skill\nBody',
    });
  });

  it('allows a small, bounded alias use for YAML compatibility', () => {
    const { data } = parseFrontmatter(
      '---\ndefaults: &defaults [lint, test]\nchecks: *defaults\n---\nbody',
    );

    expect(data).toEqual({ defaults: ['lint', 'test'], checks: ['lint', 'test'] });
  });

  it('uses YAML 1.2 core scalar semantics and does not construct Date objects', () => {
    const { data } = parseFrontmatter(
      '---\nlegacyBoolean: yes\nreleased: 2026-07-11\nenabled: true\n---\nbody',
    );

    expect(data).toEqual({
      legacyBoolean: 'yes',
      released: '2026-07-11',
      enabled: true,
    });
    expect(data.released).not.toBeInstanceOf(Date);
  });

  it('keeps YAML merge keys inert under the core schema', () => {
    const { data } = parseFrontmatter(
      '---\ndefaults: &defaults {admin: true}\nmetadata:\n  <<: *defaults\n  role: user\n---\nbody',
    );

    expect(data.metadata).toEqual({
      '<<': { admin: true },
      role: 'user',
    });
    expect(data.metadata).not.toHaveProperty('admin');
  });

  it('rejects an exponential alias expansion bomb', () => {
    const aliases = Array.from(
      { length: MAX_FRONTMATTER_ALIASES + 1 },
      () => '*base',
    ).join(', ');
    const raw = `---\nbase: &base [a, b, c]\nexpanded: [${aliases}]\n---\nbody`;

    expect(() => parseFrontmatter(raw)).toThrow(/alias count|resource exhaustion/i);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the prototype-pollution key %s at any mapping depth',
    (unsafeKey) => {
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
      const raw = `---\nmetadata:\n  ${unsafeKey}:\n    polluted: true\n---\nbody`;

      expect(() => parseFrontmatter(raw)).toThrow(/unsafe frontmatter mapping key/i);
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
    },
  );

  it.each([
    ['malformed flow sequence', '---\nname: [unterminated\n---\nbody'],
    ['duplicate keys', '---\nname: first\nname: second\n---\nbody'],
    ['non-mapping document', '---\n- name\n- description\n---\nbody'],
    ['unknown custom tag', '---\nname: !unsafe value\n---\nbody'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseFrontmatter(raw)).toThrow();
  });

  it('does not share a parse cache between repeated malformed and valid inputs', () => {
    const malformed = '---\nname: [unterminated\n---\nbody';
    expect(() => parseFrontmatter(malformed)).toThrow();
    expect(() => parseFrontmatter(malformed)).toThrow();
    expect(parseFrontmatter('---\nname: valid\n---\nbody')).toEqual({
      data: { name: 'valid' },
      content: 'body',
    });
  });
});
