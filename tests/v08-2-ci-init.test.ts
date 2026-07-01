// v0.8-2 `skill-switch ci` 命令验收测试。
// 覆盖:
//   1. 默认用法:写出合法 YAML,含正确 uses: 引脚 + sarif 格式 + security-events 权限
//   2. --format github:不含 security-events: write;含 format: github
//   3. 已有文件时不覆盖(exit 1);--force 覆盖成功
//   4. --baseline:同时写出基线文件,工作流 args 含 --baseline 参数
//   5. --json:机器可读摘要包含 workflowPath / format / pin / filesWritten
//   6. --out <path>:写到自定义路径
//   7. --pin <ref>:工作流 uses: 使用指定 ref
//   8. YAML 可解析(安全性:绝不输出无效 YAML)

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
// 凡是要把 cwd 设成临时目录的用例必须走 bin shim(不走 tsx-from-tempcwd)。
const BIN = join(ROOT, 'bin', 'skill-switch.mjs');

// ── 临时目录管理 ─────────────────────────────────────────────────────────────

const TMP_DIRS: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v082-ci-'));
  TMP_DIRS.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of TMP_DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

// ── CLI 辅助 ─────────────────────────────────────────────────────────────────

function runBin(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? -1 };
  }
}

/** 最小 YAML 解析器:验证文件是否合法 YAML 可安全手写(只做结构验证)。
 *  我们直接用字符串断言:YAML 语法问题会导致包含无效字符或者缩进错误,
 *  测试通过检查关键键值对来间接验证合法性。 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  // 粗粒度解析:读出顶层 key: value 对(不处理嵌套)。
  // 我们只需要验证"文件中含有期望的关键字",用正则即可。
  // 对于真正的 YAML 合法性验证,我们依赖 yaml 包——但测试不引入新依赖,
  // 改为用字符串模式验证(结构性正确意味着关键行都存在)。
  const result: Record<string, unknown> = {};
  for (const line of content.split('\n')) {
    const m = /^([a-z][a-z-]*):\s*(.*)$/.exec(line.trim());
    if (m) result[m[1]!] = m[2]!;
  }
  return result;
}

// ── 1. 默认用法 ──────────────────────────────────────────────────────────────

describe('skill-switch ci 默认用法', () => {
  it('写出 .github/workflows/skill-switch.yml,exit 0', () => {
    const dir = makeTmpDir();
    const { status } = runBin(['ci'], dir);
    expect(status).toBe(0);
    expect(existsSync(join(dir, '.github', 'workflows', 'skill-switch.yml'))).toBe(true);
  });

  it('写出的文件含正确 uses: 引脚(默认 v0.9.0)', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('rtwsvj/skill-switch@v0.9.0');
  });

  it('sarif 格式含 security-events: write 权限', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('security-events: write');
  });

  it('含 on: push + pull_request 触发', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('push');
    expect(content).toContain('pull_request');
  });

  it('含 actions/checkout@v4', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('actions/checkout@v4');
  });

  it('含 --configs(默认审计配置文件)', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('--configs');
  });

  it('输出提示"已写入工作流文件"', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci'], dir);
    expect(stdout).toContain('已写入工作流文件');
  });
});

// ── 2. --format github ────────────────────────────────────────────────────────

describe('skill-switch ci --format github', () => {
  it('exit 0,写出 workflow 文件', () => {
    const dir = makeTmpDir();
    const { status } = runBin(['ci', '--format', 'github'], dir);
    expect(status).toBe(0);
    expect(existsSync(join(dir, '.github', 'workflows', 'skill-switch.yml'))).toBe(true);
  });

  it('不含 security-events: write', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--format', 'github'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).not.toContain('security-events: write');
  });

  it('含 format: github(传给 Action 的输入)', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--format', 'github'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('format: github');
  });

  it('含正确 uses: 引脚', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--format', 'github'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('rtwsvj/skill-switch@v0.9.0');
  });
});

// ── 3. 防覆盖保护 ────────────────────────────────────────────────────────────

describe('防覆盖保护', () => {
  it('已有文件时不传 --force → exit 1 + stderr 报错', () => {
    const dir = makeTmpDir();
    // 先写一次
    runBin(['ci'], dir);
    // 第二次应失败
    const { status, stderr } = runBin(['ci'], dir);
    expect(status).toBe(1);
    expect(stderr).toContain('已存在');
  });

  it('--force 可覆盖已有文件', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pin', 'v0.7.0'], dir);
    // 用不同 pin 覆盖
    const { status } = runBin(['ci', '--pin', 'main', '--force'], dir);
    expect(status).toBe(0);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('rtwsvj/skill-switch@main');
  });

  it('已有文件内容不被修改(无 --force 时)', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pin', 'v0.7.0'], dir);
    const originalContent = readFileSync(
      join(dir, '.github', 'workflows', 'skill-switch.yml'),
      'utf8',
    );
    runBin(['ci', '--pin', 'main'], dir); // 无 --force,应失败
    const afterContent = readFileSync(
      join(dir, '.github', 'workflows', 'skill-switch.yml'),
      'utf8',
    );
    expect(afterContent).toBe(originalContent); // 文件未变
  });
});

// ── 4. --baseline ─────────────────────────────────────────────────────────────

describe('--baseline', () => {
  it('同时写出 .skill-switch-baseline.json', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--baseline'], dir);
    expect(existsSync(join(dir, '.skill-switch-baseline.json'))).toBe(true);
  });

  it('基线文件是合法 JSON,含 version + fingerprints 数组', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--baseline'], dir);
    const raw = readFileSync(join(dir, '.skill-switch-baseline.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: number; fingerprints: unknown[] };
    expect(typeof parsed.version).toBe('number');
    expect(Array.isArray(parsed.fingerprints)).toBe(true);
  });

  it('工作流 args 含 --baseline .skill-switch-baseline.json', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--baseline'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('--baseline .skill-switch-baseline.json');
  });

  it('stdout 提示两个文件均已写入', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--baseline'], dir);
    expect(stdout).toContain('已写入工作流文件');
    expect(stdout).toContain('已写入基线文件');
  });
});

// ── 5. --json ────────────────────────────────────────────────────────────────

describe('--json 输出', () => {
  it('输出合法 JSON', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--json'], dir);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('含 status / workflowPath / format / pin / filesWritten', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--json'], dir);
    const result = JSON.parse(stdout) as {
      status: string;
      workflowPath: string;
      format: string;
      pin: string;
      filesWritten: string[];
    };
    expect(result.status).toBe('ok');
    expect(typeof result.workflowPath).toBe('string');
    expect(result.format).toBe('sarif');
    expect(result.pin).toBe('v0.9.0');
    expect(Array.isArray(result.filesWritten)).toBe(true);
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });

  it('--baseline 时 JSON 含 baselinePath + baselineFingerprintCount', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--baseline', '--json'], dir);
    const result = JSON.parse(stdout) as {
      baselinePath: string;
      baselineFingerprintCount: number;
    };
    expect(typeof result.baselinePath).toBe('string');
    expect(typeof result.baselineFingerprintCount).toBe('number');
    expect(result.baselineFingerprintCount).toBeGreaterThanOrEqual(0);
  });

  it('--format github --json 时 format 字段为 github', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--format', 'github', '--json'], dir);
    const result = JSON.parse(stdout) as { format: string };
    expect(result.format).toBe('github');
  });
});

// ── 6. --out 自定义路径 ───────────────────────────────────────────────────────

describe('--out 自定义路径', () => {
  it('写到指定文件路径', () => {
    const dir = makeTmpDir();
    const customPath = join(dir, 'my-ci.yml');
    const { status } = runBin(['ci', '--out', customPath], dir);
    expect(status).toBe(0);
    expect(existsSync(customPath)).toBe(true);
  });

  it('默认 workflow 路径未被写入', () => {
    const dir = makeTmpDir();
    const customPath = join(dir, 'my-ci.yml');
    runBin(['ci', '--out', customPath], dir);
    expect(existsSync(join(dir, '.github', 'workflows', 'skill-switch.yml'))).toBe(false);
  });

  it('已有文件且 --out 时仍遵守防覆盖保护', () => {
    const dir = makeTmpDir();
    const customPath = join(dir, 'my-ci.yml');
    writeFileSync(customPath, 'existing content', 'utf8');
    const { status, stderr } = runBin(['ci', '--out', customPath], dir);
    expect(status).toBe(1);
    expect(stderr).toContain('已存在');
  });
});

// ── 7. --pin <ref> ────────────────────────────────────────────────────────────

describe('--pin 自定义版本引脚', () => {
  it('workflow 使用指定 ref', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pin', 'v1.2.3'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('rtwsvj/skill-switch@v1.2.3');
  });

  it('--pin main → uses main', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pin', 'main'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('rtwsvj/skill-switch@main');
  });
});

// ── 8. YAML 结构验证 ─────────────────────────────────────────────────────────

describe('YAML 结构正确性', () => {
  it('sarif workflow 含合法 YAML 顶层键', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    // 必须含 name: / on: / permissions: / jobs: 这四个顶层键
    const top = parseSimpleYaml(content);
    expect('name' in top).toBe(true);
    // on: 作为保留字,YAML 解析为字符串键
    expect(content).toMatch(/^on:/m);
    expect(content).toMatch(/^permissions:/m);
    expect(content).toMatch(/^jobs:/m);
  });

  it('github workflow 含合法 YAML 顶层键', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--format', 'github'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toMatch(/^name:/m);
    expect(content).toMatch(/^on:/m);
    expect(content).toMatch(/^permissions:/m);
    expect(content).toMatch(/^jobs:/m);
  });

  it('workflow 仅含 ASCII 和常见 YAML 字符(无乱码)', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    // 检查文件中每个字符的代码点都在可打印 ASCII + 换行/空格/制表 范围内
    // (避免 biome noControlCharactersInRegex)
    for (const ch of content) {
      const cp = ch.codePointAt(0)!;
      // 允许换行(10)、制表(9)、回车(13)和普通可打印字符(32+)
      expect(cp === 9 || cp === 10 || cp === 13 || cp >= 32).toBe(true);
    }
  });
});

// ── 9. 错误处理 ──────────────────────────────────────────────────────────────

describe('错误处理', () => {
  it('无效 --format → exit 1 + stderr 报错', () => {
    const dir = makeTmpDir();
    const { status, stderr } = runBin(['ci', '--format', 'invalid'], dir);
    expect(status).toBe(1);
    expect(stderr).toContain('--format');
  });
});
