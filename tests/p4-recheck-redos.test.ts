// P4: recheck 静态 ReDoS 守卫。
//
// 目的:
//   用 recheck 库对所有 allRules / allFileRules 的正则做静态 ReDoS 分析。
//   检测到真正的灾难性回溯漏洞时快速失败,阻止新增 vulnerable 正则进入主干。
//
// 白名单机制:
//   现有规则中有相当数量被 recheck 的 fuzz/automaton checker 判为 polynomial,
//   但这些规则受到引擎的 MAX_AUDIT_MATCH_LINE_LENGTH(2048 字符)行截断保护:
//     - 有界量词([^\n]{0,N})在 2048 字符上限内最坏 O(N²) ≈ 4M 次比较,< 10ms;
//     - 无真正的指数/catastrophic 回溯(recheck 把有界 polynomial 也报 vulnerable);
//     - 现有 audit-redos.test.ts 和 r23a-redos-guard.test.ts 通过实测验证了性能安全。
//
//   因此,这些规则加入白名单:测试断言"白名单外新增的 vulnerable 正则仍能被拦截"。
//   白名单只包含被 recheck 误判(polynomial 但受截断保护)的既有规则;
//   若白名单之外出现新的 vulnerable 规则,测试立即失败并列出详情。
//
// fuzz 非确定性规则(FUZZ_NONDETERMINISTIC):
//   recheck fuzz 模式具有随机性:同一正则多次检查可能在 safe/vulnerable 之间切换。
//   automaton 模式对这些正则会触发 JVM StackOverflow(无法用作确定性备选)。
//   此类规则加入 WHITELIST 的同时也加入 FUZZ_NONDETERMINISTIC 集合,
//   在"白名单过期验证"测试中跳过,避免 fuzz 随机性误报"可以移除"。
//
// 超时:
//   recheck 每条规则可能需要几百 ms(fuzz 模式)。
//   整体测试设 120 s 超时(allRules 约 30 条,allFileRules 约 10 条,足够宽松)。
//
// AuditFileRule 的处理:
//   AuditFileRule 没有 pattern 字段(用 evaluate 函数),内部正则由函数闭包持有,
//   无法被 recheck 静态分析。此类规则跳过(有注释说明)。

import { check, type Diagnostics } from 'recheck';
import { describe, expect, it } from 'vitest';
import { allFileRules, allRules } from '../rules/index.ts';

/** 获取 complexity.summary 的类型安全辅助函数;UnknownDiagnostics 没有 complexity 字段 */
function complexitySummary(d: Diagnostics): string {
  if (d.status === 'unknown') return 'N/A';
  return d.complexity.summary;
}

// ── 白名单 ───────────────────────────────────────────────────────────────────
//
// 这些规则的正则被 recheck 判为 polynomial(2nd–4th degree),但实际上受到
// 引擎 MAX_AUDIT_MATCH_LINE_LENGTH(2048)行截断保护,经实测(r23a-redos-guard.test.ts)
// 验证在最坏情况下 < 10ms,不构成真实 ReDoS 威胁。
//
// 依据:见 tests/r23a-redos-guard.test.ts 的 ANALYSIS SUMMARY 注释
//      和 tests/audit-redos.test.ts 的 1000ms 预算测试。
//
// 如要移除白名单条目:修复对应正则使 recheck 判为 safe,然后从此列表删除。
const WHITELIST: ReadonlySet<string> = new Set([
  // ── exfiltration 类 ─────────────────────────────────────────────────────
  // [^\n]{0,2048} 间隙:2048 cap 下 O(N²),但 cap 使最坏情况 < 10ms
  'exfiltration/curl-body-with-secret',         // 2nd degree polynomial (fuzz)
  'exfiltration/sensitive-file-exfil',          // 2nd degree polynomial (fuzz) — SENSITIVE_PATH+gap+EXFIL_VERB
  'exfiltration/exfil-endpoint',                // 2nd degree polynomial (fuzz)
  'exfiltration/env-var-exfil-instruction',     // 4th degree polynomial (fuzz) — 6 路径×2 gap

  // ── reverse-shell 类 ─────────────────────────────────────────────────────
  'reverse-shell/netcat-exec',                  // 2nd degree polynomial (automaton)
  'reverse-shell/scripting-socket',             // 2nd degree polynomial (fuzz)

  // ── destructive 类 ───────────────────────────────────────────────────────
  'destructive/rm-rf-root',                     // 3rd degree polynomial (automaton)
  'destructive/disk-overwrite',                 // 2nd degree polynomial (automaton)

  // ── clickfix 类 ──────────────────────────────────────────────────────────
  'clickfix/gatekeeper-bypass',                 // 2nd degree polynomial (fuzz)
  'clickfix/curl-pipe-shell',                   // 2nd degree polynomial (automaton)
  'clickfix/copy-paste-lure',                   // 2nd degree polynomial (fuzz)

  // ── staged 类 ────────────────────────────────────────────────────────────
  'staged/chained-download-exec',               // 2nd degree polynomial (fuzz)
  // staged/prerequisite-install: recheck fuzz 结果非确定性——多次跑在 safe/vulnerable 之间
  // 切换(fuzz 随机性);automaton 模式对该正则崩溃(JVM StackOverflow)。
  // 该规则同受 2048 字符行截断保护,保守加入白名单。
  // 同时加入 FUZZ_NONDETERMINISTIC,跳过"白名单过期验证"以免 fuzz 随机误报。
  'staged/prerequisite-install',                // 2nd degree polynomial (fuzz, non-deterministic)

  // ── persistence 类 ───────────────────────────────────────────────────────
  'persistence/shell-startup',                  // 3rd degree polynomial (fuzz) — [^\n]{0,2048}+startup-file
  // 注:persistence/cron / service-autostart / git-hooks 均为 safe

  // ── global-tamper 类 ─────────────────────────────────────────────────────
  'global-tamper/agent-config-write',           // 3rd degree polynomial (fuzz) — WRITE_VERB+gap+AGENT_CONFIG 双向
  'global-tamper/permission-grant',             // 2nd degree polynomial (automaton) — [^\n]*

  // ── credential-theft 类 ──────────────────────────────────────────────────
  'credential-theft/token-exfil',              // 4th degree polynomial (fuzz) — AUTH_TOKEN+gap+ENDPOINT 双向

  // ── supply-chain 类 ──────────────────────────────────────────────────────
  'supply-chain/unofficial-registry',           // 2nd degree polynomial (fuzz)

  // ── prompt-injection 类 ──────────────────────────────────────────────────
  'prompt-injection/instruction-override',      // 2nd degree polynomial (fuzz) — [^\n]{0,40}+[^\n]{0,24}
  // 注:prompt-injection/conceal-from-user / zero-width-chars / hidden-style-text 均为 safe
]);

// ── fuzz 非确定性规则 ────────────────────────────────────────────────────────
//
// recheck fuzz 模式具有随机性:同一正则多次检查可能在 safe/vulnerable 之间切换。
// automaton 模式对这些正则会触发 JVM StackOverflow。
// 这类规则在"白名单过期验证"测试中跳过(否则 fuzz 返回 safe 时会错误报"可移除")。
const FUZZ_NONDETERMINISTIC: ReadonlySet<string> = new Set([
  'staged/prerequisite-install',  // fuzz 随机性:安全时返回 safe,不确定时返回 2nd poly
]);

// ── 辅助类型 ─────────────────────────────────────────────────────────────────

interface RecheckResult {
  id: string;
  status: string;
  summary: string;
  checker: string;
  whitelisted: boolean;
}

// ── 测试套件 ─────────────────────────────────────────────────────────────────

describe('P4: recheck 静态 ReDoS 守卫', { timeout: 120_000 }, () => {
  it('AuditRule(pattern 字段)中无非白名单 vulnerable 正则', async () => {
    const results: RecheckResult[] = [];
    const newVulnerable: RecheckResult[] = [];

    for (const rule of allRules) {
      // AuditRule 有 pattern;AuditFileRule 没有(用 evaluate 函数),跳过
      if (!('pattern' in rule) || !rule.pattern) continue;

      const { source, flags } = rule.pattern as RegExp;
      const result = await check(source, flags);

      const entry: RecheckResult = {
        id: rule.id,
        status: result.status,
        summary: complexitySummary(result),
        checker: result.checker ?? 'unknown',
        whitelisted: WHITELIST.has(rule.id),
      };
      results.push(entry);

      // 若 vulnerable 且不在白名单,则记录为新问题
      if (result.status === 'vulnerable' && !WHITELIST.has(rule.id)) {
        newVulnerable.push(entry);
      }
    }

    // 输出摘要(仅在失败时有意义,但 vitest 会展示 console.log)
    const vulnerableAll = results.filter((r) => r.status === 'vulnerable');
    const whitelistedCount = vulnerableAll.filter((r) => r.whitelisted).length;

    if (newVulnerable.length > 0) {
      // 构建失败信息,列出所有新 vulnerable 规则及其详情
      const detail = newVulnerable
        .map((r) => `  • ${r.id}: ${r.summary} (checker: ${r.checker})`)
        .join('\n');
      expect.fail(
        `发现 ${newVulnerable.length} 条新增的 ReDoS-vulnerable 正则(不在白名单内):\n${detail}\n\n` +
        `请检查正则是否真正危险:\n` +
        `  - 若有引擎行截断(MAX_AUDIT_MATCH_LINE_LENGTH=2048)保护且实测安全,加入 WHITELIST 并注明 degree\n` +
        `  - 若真正危险,重写正则或改用 re2\n` +
        `\n白名单规则总数: ${whitelistedCount}(共 ${vulnerableAll.length} 个 vulnerable)`,
      );
    }

    // 至少应有一些规则通过分析(sanity check)
    expect(results.length).toBeGreaterThan(0);
  });

  it('AuditFileRule(evaluate 函数)均已跳过 recheck 静态分析,记录规则 id', () => {
    // AuditFileRule 用 evaluate 函数,内部正则在闭包里,recheck 无法静态分析。
    // 此测试仅文档化这一设计决策,列出被跳过的规则供人工审查。
    const skippedIds = allFileRules.map((r) => r.id);

    // 确保我们知道有多少规则被跳过
    expect(skippedIds.length).toBeGreaterThan(0);

    // 仅验证数量合理(当前有 stagedExfil / base64Payload / invisibleChar×4 / ansiInjection = 7 条)
    // 如果新增超过 20 条仍无 pattern 字段的规则,请考虑把正则提取出来单独测试
    expect(skippedIds.length).toBeLessThan(20);
  });

  it('白名单中所有条目未被 recheck 明确判为 safe(确保白名单不会静默失效)', async () => {
    // 若某条白名单规则的正则被修复为 safe,recheck 返回 safe 而白名单仍有它——
    // 此测试会失败并提示可以从白名单移除该条目。
    //
    // 只有 recheck 明确判 "safe" 才算 stale:
    //   recheck 的 status 可能是 safe / vulnerable / unknown / timeout / error。
    //   unknown / timeout / error 表示在分析预算内无法判定(在较慢的 CI 节点上很常见,
    //   同一条正则本机判 vulnerable、CI 判 unknown),并不代表正则已变安全——
    //   保留白名单是保守且正确的,因此不算 stale。这样断言跨环境确定、不 flaky。
    //
    // 跳过 FUZZ_NONDETERMINISTIC 中的规则:这些规则的 fuzz 结果是随机的,
    // 有时返回 safe,有时返回 vulnerable——不能用于确定性验证。
    const staleEntries: string[] = [];

    for (const rule of allRules) {
      if (!('pattern' in rule) || !rule.pattern) continue;
      if (!WHITELIST.has(rule.id)) continue;
      // 跳过 fuzz 非确定性规则(结果不稳定,无法做确定性断言)
      if (FUZZ_NONDETERMINISTIC.has(rule.id)) continue;

      const { source, flags } = rule.pattern as RegExp;
      const result = await check(source, flags);

      if (result.status === 'safe') {
        staleEntries.push(
          `  • ${rule.id}: recheck 现在明确判为 "safe"(${complexitySummary(result)}),可从白名单移除`,
        );
      }
    }

    if (staleEntries.length > 0) {
      expect.fail(
        `白名单中以下条目已不再被 recheck 判为 vulnerable,请从 WHITELIST 移除:\n${staleEntries.join('\n')}`,
      );
    }
  });
});
