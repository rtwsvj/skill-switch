// 测试纪律:真实 agent 配置目录(~/.claude、~/.codex、~/.agents …)永远只读。
// 在任何被测模块加载之前,把 HOME 重定向到一次性临时目录,
// 使任何经 homedir()/HOME 解析的路径都落在沙箱内,误写真实目录在物理上不可能。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'skill-switch-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.XDG_CONFIG_HOME = join(fakeHome, '.config');
process.env.XDG_STATE_HOME = join(fakeHome, '.local', 'state');

// 这些 env 会让 vendor agents.ts 的预计算路径落到 home 之外,破坏测试密闭性
// (例如本机运行时 Claude Code 自身可能注入 CLAUDE_CONFIG_DIR)。一律清除。
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.VIBE_HOME;
delete process.env.HERMES_HOME;
delete process.env.AUTOHAND_HOME;
