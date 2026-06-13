// 持久化机制规则。规格来源:ags SECURITY.md `### Persistence Mechanisms`(已逐字核实)。
// 检测:安装后门或开机/计划自启。聚焦"写入"动作(重定向/管道/tee),
// 仅提及启动文件(如"把别名加到 ~/.zshrc")不算。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = 'ags SECURITY.md › Persistence Mechanisms';

export const persistenceRules: AuditRule[] = [
  {
    id: 'persistence/cron',
    severity: 'high',
    // 管道写入 crontab、crontab -e/-r、写 /etc/cron.d/
    pattern: /\|\s*crontab\b|\bcrontab\s+-[er]\b|\/etc\/cron\.d\//,
    message: '修改 crontab / 写系统 cron 目录:计划任务持久化',
    source: SECTION,
  },
  {
    id: 'persistence/shell-startup',
    severity: 'high',
    // 重定向或 tee 写入 shell 启动文件
    pattern:
      /(?:>>|>|\btee\s+-?a?\b)[^\n]{0,2048}(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|\.zprofile)\b/,
    message: '写入 shell 启动文件(.bashrc/.zshrc 等):登录持久化',
    source: SECTION,
  },
  {
    id: 'persistence/service-autostart',
    severity: 'high',
    // macOS launchctl 加载 / Linux systemd 自启
    pattern: /\blaunchctl\s+(?:load|bootstrap)\b|\bsystemctl\s+(?:--user\s+)?enable\b/,
    message: 'launchctl/systemctl 注册自启服务:开机持久化',
    source: SECTION,
  },
  {
    id: 'persistence/git-hooks',
    severity: 'high',
    // 写入 .git/hooks/(提交即触发的后门)
    pattern: /\.git\/hooks\/[a-z-]+/,
    message: '写入 .git/hooks/:git 操作触发的持久化后门',
    source: SECTION,
  },
];
