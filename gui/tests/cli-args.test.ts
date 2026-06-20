// F-C2:install 的 --force-reason 接线 —— 只有 force 且填了原因才带,原因经此写入 bypass-ledger。
import { describe, expect, it } from 'vitest';
import { installArgs } from '../src/data/cli-args';

const base = { source: '/x', agent: 'claude-code', mode: 'copy' as const };

describe('F-C2 installArgs force-reason', () => {
  it('includes --force-reason <reason> when forcing with a reason', () => {
    const args = installArgs({ ...base, force: true, forceReason: 'trusted private repo' });
    expect(args).toContain('--force');
    const i = args.indexOf('--force-reason');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('trusted private repo');
  });

  it('trims the reason', () => {
    const args = installArgs({ ...base, force: true, forceReason: '  manually reviewed  ' });
    const i = args.indexOf('--force-reason');
    expect(args[i + 1]).toBe('manually reviewed');
  });

  it('omits --force-reason (and --force) when not forcing', () => {
    const args = installArgs({ ...base, force: false, forceReason: 'ignored' });
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--force-reason');
  });

  it('omits --force-reason when forcing but the reason is blank', () => {
    const args = installArgs({ ...base, force: true, forceReason: '   ' });
    expect(args).toContain('--force');
    expect(args).not.toContain('--force-reason');
  });
});
