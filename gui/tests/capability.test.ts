// 安全姿态回归守卫:Tauri capability 最小权限不被悄悄放大。
// 当前刻意只给「执行那一个 sidecar」——不给 shell:allow-spawn / allow-kill / open,
// 也不允许执行 sidecar 以外的任何程序。本测试把这条姿态钉死(改动需显式更新此处)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cap = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
) as { permissions: Array<string | { identifier: string; allow?: Array<{ name?: string; sidecar?: boolean }> }> };

function shellPerms(): string[] {
  return cap.permissions
    .map((p) => (typeof p === 'string' ? p : p.identifier))
    .filter((id) => id.startsWith('shell:'));
}

describe('Tauri capability minimal-permission posture', () => {
  it('grants shell:allow-execute only — never spawn/kill/open or stdin', () => {
    expect(shellPerms()).toEqual(['shell:allow-execute']);
    const forbidden = ['shell:allow-spawn', 'shell:allow-kill', 'shell:allow-open', 'shell:allow-stdin-write'];
    for (const f of forbidden) expect(shellPerms()).not.toContain(f);
  });

  it('only the bundled sidecar may be executed (no arbitrary programs)', () => {
    const exec = cap.permissions.find(
      (p) => typeof p !== 'string' && p.identifier === 'shell:allow-execute',
    ) as { allow: Array<{ name?: string; sidecar?: boolean }> };
    expect(exec.allow.length).toBe(1);
    expect(exec.allow[0]!.name).toBe('bin/skill-switch-cli');
    expect(exec.allow[0]!.sidecar).toBe(true);
  });
});
