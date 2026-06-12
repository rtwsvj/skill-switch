// S5.2:跨 agent 移植告警 — 每类告警一正(命中)一反(不误报)。
// 依据:调研报告⑥节字段差异表(Claude Code / Codex / Gemini / Cursor / Copilot 官方文档核实)。
import { describe, expect, it } from 'vitest';
import { checkPortability, type LintIssue } from '../src/core/lint/portability.ts';

const base = { name: 'demo-skill', description: 'Use when demoing portability checks for tests.' };

function rules(issues: LintIssue[]): string[] {
  return issues.map((i) => i.rule);
}

describe('portability: Claude 专有字段', () => {
  it('disable-model-invocation → codex 告警并给降级建议', () => {
    const issues = checkPortability({ ...base, 'disable-model-invocation': true }, '', 'codex');
    const hit = issues.find((i) => i.rule === 'portability/claude-only-field');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
    expect(hit!.message).toContain('allow_implicit_invocation');
  });

  it('model/hooks/context 等专有字段 → 非 Claude 目标统一"将被忽略"告警', () => {
    const issues = checkPortability(
      { ...base, model: 'opus', hooks: {}, context: 'fork' },
      '',
      'gemini-cli',
    );
    expect(issues.filter((i) => i.rule === 'portability/claude-only-field')).toHaveLength(3);
  });

  it('反例:target=claude-code 时专有字段不告警', () => {
    const issues = checkPortability(
      { ...base, 'disable-model-invocation': true, model: 'opus' },
      '',
      'claude-code',
    );
    expect(rules(issues)).not.toContain('portability/claude-only-field');
  });
});

describe('portability: allowed-tools 工具名不通用', () => {
  it('allowed-tools 在非 Claude 目标告警', () => {
    const issues = checkPortability({ ...base, 'allowed-tools': 'Bash Read' }, '', 'codex');
    expect(rules(issues)).toContain('portability/allowed-tools-not-portable');
  });

  it('反例:claude-code 不告警', () => {
    const issues = checkPortability({ ...base, 'allowed-tools': 'Bash Read' }, '', 'claude-code');
    expect(rules(issues)).not.toContain('portability/allowed-tools-not-portable');
  });
});

describe('portability: $ARGUMENTS 替换仅 Claude 支持', () => {
  it('body 含 $ARGUMENTS → 非 Claude 目标告警', () => {
    const issues = checkPortability(base, 'Run with $ARGUMENTS here.', 'codex');
    expect(rules(issues)).toContain('portability/arguments-substitution');
  });

  it('反例:claude-code 不告警;无 $ARGUMENTS 不告警', () => {
    expect(rules(checkPortability(base, 'Run with $ARGUMENTS.', 'claude-code'))).not.toContain(
      'portability/arguments-substitution',
    );
    expect(rules(checkPortability(base, 'No substitution.', 'codex'))).not.toContain(
      'portability/arguments-substitution',
    );
  });
});

describe('portability: Copilot 命名空间前缀静默失败', () => {
  it('name 带 namespace 前缀 → copilot 目标报 error', () => {
    const issues = checkPortability({ ...base, name: 'myplugin:demo-skill' }, '', 'copilot');
    const hit = issues.find((i) => i.rule === 'portability/copilot-namespace-prefix');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
    expect(hit!.message).toMatch(/静默/);
  });

  it('反例:无前缀或非 copilot 目标不报这条', () => {
    expect(rules(checkPortability(base, '', 'copilot'))).not.toContain(
      'portability/copilot-namespace-prefix',
    );
    expect(rules(checkPortability({ ...base, name: 'p:demo' }, '', 'codex'))).not.toContain(
      'portability/copilot-namespace-prefix',
    );
  });
});

describe('portability: Codex description 截短风险', () => {
  it('前 120 字符无触发词 → codex 目标 info 提示', () => {
    const issues = checkPortability(
      { ...base, description: 'Helps with various tasks around the codebase generally.' },
      '',
      'codex',
    );
    const hit = issues.find((i) => i.rule === 'portability/codex-description-truncation');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('info');
  });

  it('反例:触发词前置(英文/中文)或非 codex 目标不提示', () => {
    expect(
      rules(checkPortability({ ...base, description: 'Use when reviewing pull requests.' }, '', 'codex')),
    ).not.toContain('portability/codex-description-truncation');
    expect(
      rules(checkPortability({ ...base, description: '用于审查代码评审请求。' }, '', 'codex')),
    ).not.toContain('portability/codex-description-truncation');
    expect(
      rules(
        checkPortability({ ...base, description: 'Helps with stuff generally.' }, '', 'claude-code'),
      ),
    ).not.toContain('portability/codex-description-truncation');
  });
});
