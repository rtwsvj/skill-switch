// S5.2 跨 agent 移植告警(手写,无上游先例——skill-switch 护城河之一)。
// 依据:调研报告⑥节字段差异表,事实来源为各家官方文档(agentskills.io spec、
// code.claude.com、developers.openai.com/codex、VS Code agent-skills 文档)。
// 与 spec-validator(S5.1)分层:spec 校验是否"合规",portability 检查
// "换个 agent 还能不能按预期工作"。
export type LintTarget = 'claude-code' | 'codex' | 'gemini-cli' | 'cursor' | 'copilot';

export interface LintIssue {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  field?: string;
  message: string;
}

// Claude Code 专有 frontmatter 字段 → 跨家降级建议(无建议则统一"将被忽略")
export const CLAUDE_ONLY_FIELDS: Record<string, string | undefined> = {
  'disable-model-invocation':
    'Codex 等价物:在 agents/openai.yaml 写 policy.allow_implicit_invocation: false',
  'user-invocable': undefined,
  'argument-hint': undefined,
  model: undefined,
  effort: undefined,
  context: undefined,
  agent: undefined,
  hooks: undefined,
};

// 触发词线索(英文 + 中文):description 前段应包含,Codex 初始列表有 context budget 会截短
const TRIGGER_CUES = /use (?:this |it )?(?:when|for|to)|trigger|invoke|when (?:the )?user|当|用于|在.+时/i;
const DESCRIPTION_FRONT_WINDOW = 120;

export function checkPortability(
  metadata: Record<string, unknown>,
  body: string,
  target: LintTarget,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const name = typeof metadata.name === 'string' ? metadata.name : '';
  const description = typeof metadata.description === 'string' ? metadata.description : '';

  if (target !== 'claude-code') {
    for (const [field, advice] of Object.entries(CLAUDE_ONLY_FIELDS)) {
      if (!(field in metadata)) continue;
      issues.push({
        severity: 'warning',
        rule: 'portability/claude-only-field',
        field,
        message: `字段 '${field}' 是 Claude Code 专有,在 ${target} 将被忽略。${advice ?? ''}`.trim(),
      });
    }

    if ('allowed-tools' in metadata) {
      issues.push({
        severity: 'warning',
        rule: 'portability/allowed-tools-not-portable',
        field: 'allowed-tools',
        message: `'allowed-tools' 的工具名在各家不通用(如 Claude 的 Bash/Read 在 ${target} 无对应),迁移后需按目标家的工具名重写`,
      });
    }

    if (body.includes('$ARGUMENTS')) {
      issues.push({
        severity: 'warning',
        rule: 'portability/arguments-substitution',
        message: `正文使用 $ARGUMENTS 参数替换——仅 Claude Code 支持,在 ${target} 会原样出现在提示词里`,
      });
    }
  }

  if (target === 'copilot' && /[:/]/.test(name)) {
    issues.push({
      severity: 'error',
      rule: 'portability/copilot-namespace-prefix',
      field: 'name',
      message:
        'VS Code Copilot 对插件分发的 skill 自动加 namespace 前缀;手写前缀(含 : 或 /)会静默加载失败,移除前缀让平台自行添加',
    });
  }

  if (target === 'codex' && description) {
    const front = description.slice(0, DESCRIPTION_FRONT_WINDOW);
    if (!TRIGGER_CUES.test(front)) {
      issues.push({
        severity: 'info',
        rule: 'portability/codex-description-truncation',
        field: 'description',
        message: `Codex 初始 skills 列表有 context budget,description 可能被截短——把触发词(use when…/用于…)前置到前 ${DESCRIPTION_FRONT_WINDOW} 字符内`,
      });
    }
  }

  return issues;
}
