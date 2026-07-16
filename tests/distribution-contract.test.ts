import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('distribution contract', () => {
  it('keeps planned package-manager channels visibly non-installable', () => {
    const scoop = JSON.parse(read('packaging/skill-switch.json')) as {
      installable?: boolean;
      status?: string;
    };
    const brew = read('packaging/skill-switch.rb');

    expect(scoop).toMatchObject({ installable: false, status: 'planned' });
    expect(brew).toContain('PLANNED / NOT INSTALLABLE');
    expect(brew).not.toMatch(/class\s+SkillSwitch\s*<\s*(Formula|Cask)/);
    expect(`${JSON.stringify(scoop)}\n${brew}`).not.toContain('PLACEHOLDER_');
  });

  it('build script is syntactically valid and selects the current host artifact explicitly', () => {
    execFileSync('bash', ['-n', join(ROOT, 'macos', 'build-app.sh')]);
    const script = read('macos/build-app.sh');
    expect(script).toContain('skill-switch-cli-$HOST_TRIPLE');
    expect(script).not.toMatch(/ls .*skill-switch-cli-\*/);
    expect(script).toContain('CFBundleShortVersionString</key><string>$VERSION');
    expect(script).toContain('SEA CLI 版本不匹配');
  });

  it('documents automated app artifacts as unsigned previews', () => {
    const readmes = `${read('README.md')}\n${read('README.en.md')}\n${read('docs/distribution.md')}`;
    expect(readmes).toContain('unsigned `.app.zip` preview');
    expect(readmes).toContain('未签名 `.app.zip` 预览产物');
    expect(readmes).not.toContain('shipped across all channels');
    expect(readmes).not.toContain('已全渠道发布');
  });
});
