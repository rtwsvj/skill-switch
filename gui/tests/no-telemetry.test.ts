// F-F2:零遥测守卫 —— GUI 源码里不应出现网络上报/分析 SDK,否则与「本地优先·零遥测」承诺相悖。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

function allSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return allSourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

// 一旦命中,说明可能引入了遥测/外传。新增确属必要的本地请求时,显式在此放行并复核承诺文案。
const FORBIDDEN: RegExp[] = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /\b(?:posthog|mixpanel|amplitude|sentry|segment\.io|googletagmanager|analytics)\b/i,
];

describe('F-F2 zero-telemetry guard', () => {
  it('gui/src contains no network/telemetry/analytics calls', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file.replace(SRC, 'src')} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
