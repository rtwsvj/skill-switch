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
