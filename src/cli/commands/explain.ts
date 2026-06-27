// explain 子命令:把 audit 报告里的 ruleId 翻译成人类可读的解释。
// 纯只读——不写任何文件。
// 用法:  skill-switch explain <ruleId> [--json]
import type { Command } from 'commander';
import { explainRule, suggestRules } from '../../core/rule-explain.ts';

export function registerExplainCommand(program: Command): void {
  program
    .command('explain <ruleId>')
    .description('解释一条审计规则的含义、风险与修复方式')
    .option('--json', '机器可读 JSON 输出')
    .action((ruleId: string, options: { json?: boolean }) => {
      const explanation = explainRule(ruleId);

      if (!explanation) {
        // 未找到 — 给出近似建议并 exit 1
        const suggestions = suggestRules(ruleId);
        if (options.json) {
          console.error(
            JSON.stringify({
              error: `未知规则 ID: ${ruleId}`,
              suggestions,
            }),
          );
        } else {
          console.error(`错误: 未知规则 ID "${ruleId}"`);
          if (suggestions.length > 0) {
            console.error(`\n相近的规则 ID:`);
            for (const s of suggestions) {
              console.error(`  ${s}`);
            }
          }
          console.error(`\n提示: 运行 skill-switch audit 查看命中的规则,或查阅 docs/rules.md 浏览全部规则。`);
        }
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(explanation, null, 2));
        return;
      }

      // 人类可读输出
      const SEP = '─'.repeat(60);
      console.log(`\n${SEP}`);
      console.log(`规则 ID :  ${explanation.ruleId}`);
      console.log(`严重度  :  ${explanation.severity}`);
      console.log(`类目    :  ${explanation.category}`);
      console.log(SEP);
      console.log(`\n【检测什么】`);
      console.log(`  ${explanation.what}`);
      console.log(`\n【为什么危险】`);
      // 可能含多行,统一缩进
      for (const line of explanation.why.split('\n')) {
        console.log(`  ${line}`);
      }
      console.log(`\n【如何修复】`);
      for (const line of explanation.howToFix.split('\n')) {
        console.log(`  ${line}`);
      }
      console.log(`\n【如何抑制】`);
      for (const line of explanation.howToSuppress.split('\n')) {
        console.log(`  ${line}`);
      }
      console.log(SEP);
    });
}
