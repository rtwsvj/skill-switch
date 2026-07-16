import { describe, expect, it } from 'vitest';
import {
  formatArgvForDisplay,
  neutralizeTerminalControls,
  redactArgvForDisplay,
  redactKnownSecrets,
  redactUrlUserinfo,
  sanitizeOutputText,
} from '../src/core/security/output-safety.ts';

describe('output-safety', () => {
  it('neutralizes every C0, DEL, and C1 byte without changing printable Unicode', () => {
    const controls = String.fromCharCode(
      ...Array.from({ length: 0x20 }, (_, index) => index),
      ...Array.from({ length: 0x21 }, (_, index) => 0x7f + index),
    );
    const safe = neutralizeTerminalControls(`前${controls}后`);
    expect(safe).toMatch(/^前<NUL>/u);
    expect(safe).toContain('<ESC>');
    expect(safe).toContain('<BEL>');
    expect(safe).toContain('<U+009F>');
    expect(safe).toMatch(/后$/u);
    expect([...safe].every((character) => {
      const code = character.codePointAt(0)!;
      return code > 0x1f && !(code >= 0x7f && code <= 0x9f);
    })).toBe(true);
  });

  it('redacts known token families, JSON literals, assignments, and URL userinfo', () => {
    const text = [
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd',
      'sk-live-THIS_IS_A_SECRET_VALUE_1234567890',
      'Bearer bearer-secret-value',
      'password=hunter2',
      '"OPENAI_API_KEY":"arbitrary-literal"',
      'https://alice:password@example.test/path',
    ].join(' ');
    const safe = redactKnownSecrets(text);
    for (const secret of [
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd',
      'sk-live-THIS_IS_A_SECRET_VALUE_1234567890',
      'bearer-secret-value',
      'hunter2',
      'arbitrary-literal',
      'alice:password',
    ]) {
      expect(safe).not.toContain(secret);
    }
  });

  it('removes both URL username and password, including percent-encoded values', () => {
    expect(redactUrlUserinfo('https://user:p%40ss@example.test/path?q=1'))
      .toBe('https://example.test/path?q=1');
  });

  it('redacts contextual argv values while preserving ordinary arguments', () => {
    expect(redactArgvForDisplay([
      'server.js',
      '--token',
      'opaque-A',
      '--api-key=opaque-B',
      '-H',
      'Authorization: Bearer opaque-C',
      '--header=X-Trace: visible',
      '-h',
      'help-topic',
    ])).toEqual([
      'server.js',
      '--token',
      '<redacted>',
      '--api-key=<redacted>',
      '-H',
      'Authorization: <redacted>',
      '--header=X-Trace: visible',
      '-h',
      'help-topic',
    ]);
  });

  it('produces an inert single-line command description', () => {
    const rendered = formatArgvForDisplay('node\u001b[2J', [
      'server.js', '--password', 'opaque', 'two words', 'line\nforge',
    ]);
    expect(rendered).toBe('node<ESC>[2J server.js --password <redacted> "two words" line<LF>forge');
    expect(sanitizeOutputText(rendered)).toBe(rendered);
  });
});
