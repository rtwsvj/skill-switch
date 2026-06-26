// v0.8-1 MCP 配置漂移检测验收测试。
// v0.8-3 更新:flags 已从 --write-mcp-baseline/--mcp-baseline 改名为
//             --write-config-baseline/--config-baseline;导入改为 config-baseline.ts。
//
// 覆盖:
//   1. fingerprintMcpServer 确定性 + secret 排除
//   2. fingerprintMcpServersFromRaw — 多文件/跳过非 mcp JSON
//   3. diffConfigBaseline — added/changed/removed 三种情形
//   4. configDiffToFindings — ruleId/severity 正确(MCP 部分)
//   5. writeConfigBaseline / loadConfigBaseline / validateConfigBaseline
//   6. 无 --configs 时使用 --write-config-baseline 或 --config-baseline → clean error exit 1
//   7. CLI --write-config-baseline:写出文件,exit 0
//   8. 无变化 + --config-baseline → 无 drift finding,exit 0
//   9. command/args 变化 → mcp/server-config-changed (exit 1)
//  10. url 变化 → mcp/server-config-changed (exit 1)
//  11. 新 server → mcp/server-added (exit 0 without high,policy suppress → exit 0)
//  12. 移除 server → 无 finding,不阻断
//  13. 格式: --format json 含漂移 finding
//  14. --policy suppress mcp/server-config-changed → exit 0
//  15. 基线文件缺失 / JSON 损坏 → clean error exit 1
//  16. secret 安全断言:env VALUE 不进入基线文件

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  fingerprintMcpServer,
  fingerprintMcpServersFromRaw,
  diffConfigBaseline,
  configDiffToFindings,
  writeConfigBaseline,
  loadConfigBaseline,
  validateConfigBaseline,
  ConfigBaselineError,
} from '../src/core/audit/config-baseline.ts';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'skill-switch.mjs');

// ── 临时目录管理 ─────────────────────────────────────────────────────────────

const TMP_DIRS: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v081-mcp-drift-'));
  TMP_DIRS.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of TMP_DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

// ── CLI 辅助 ─────────────────────────────────────────────────────────────────

function runBin(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? -1 };
  }
}

// ── 测试 fixtures ─────────────────────────────────────────────────────────────

/** 构建一个最小 home 目录,含一个 MCP config 文件。 */
function makeFakeHome(
  mcpConfig: Record<string, unknown>,
  relPath = '.claude/mcp.json',
): { home: string; configPath: string } {
  const home = makeTmpDir();
  const configPath = join(home, relPath);
  mkdirSync(join(home, relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : ''), { recursive: true });
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  return { home, configPath };
}

const BASIC_SERVER = {
  command: 'npx',
  args: ['@modelcontextprotocol/server-filesystem@1.0.0', '/workspace'],
  env: { API_KEY: 'sk-real-secret-value-should-not-appear' },
};

const BASIC_MCP_CONFIG = {
  mcpServers: {
    filesystem: BASIC_SERVER,
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. fingerprintMcpServer — 确定性 + secret 排除
// ══════════════════════════════════════════════════════════════════════════════

describe('fingerprintMcpServer', () => {
  it('返回 64 字符十六进制字符串', () => {
    const fp = fingerprintMcpServer(BASIC_SERVER as unknown as Record<string, unknown>);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('相同输入产生相同指纹(确定性)', () => {
    const a = fingerprintMcpServer(BASIC_SERVER as unknown as Record<string, unknown>);
    const b = fingerprintMcpServer({ ...BASIC_SERVER });
    expect(a).toBe(b);
  });

  it('command 变化 → 指纹不同', () => {
    const original = fingerprintMcpServer(BASIC_SERVER as unknown as Record<string, unknown>);
    const modified = fingerprintMcpServer({ ...BASIC_SERVER, command: 'uvx' });
    expect(original).not.toBe(modified);
  });

  it('args 变化 → 指纹不同', () => {
    const original = fingerprintMcpServer(BASIC_SERVER as unknown as Record<string, unknown>);
    const modified = fingerprintMcpServer({ ...BASIC_SERVER, args: ['@modelcontextprotocol/server-filesystem@2.0.0', '/workspace'] });
    expect(original).not.toBe(modified);
  });

  it('url 变化 → 指纹不同', () => {
    const withUrl = { command: '', args: [], url: 'https://mcp.example.com/v1' };
    const changed = { ...withUrl, url: 'https://mcp.evil.com/v1' };
    expect(fingerprintMcpServer(withUrl)).not.toBe(fingerprintMcpServer(changed));
  });

  it('只改 env VALUE(非 KEY)→ 指纹不变(secret 安全)', () => {
    // 只改 API_KEY 的值,KEY 名不变 → 指纹不变
    const original = fingerprintMcpServer(BASIC_SERVER as unknown as Record<string, unknown>);
    const secretChanged = fingerprintMcpServer({
      ...BASIC_SERVER,
      env: { API_KEY: 'sk-different-secret-value-xxxx' },
    });
    expect(original).toBe(secretChanged);
  });

  it('增加新的 env KEY → 指纹变化(key 变化是有意义的信号)', () => {
    const original = fingerprintMcpServer(BASIC_SERVER as unknown as Record<string, unknown>);
    const extraKey = fingerprintMcpServer({
      ...BASIC_SERVER,
      env: { API_KEY: 'sk-real-secret', NEW_KEY: 'some-value' },
    });
    expect(original).not.toBe(extraKey);
  });

  it('description/autoApprove 变化不影响指纹(非身份字段)', () => {
    const original = fingerprintMcpServer(BASIC_SERVER as unknown as Record<string, unknown>);
    const withMeta = fingerprintMcpServer({
      ...BASIC_SERVER,
      description: 'changed description',
      autoApprove: ['read_file', 'list_dir'],
    });
    expect(original).toBe(withMeta);
  });

  it('secret 安全:指纹字符串不包含真实 secret 值', () => {
    const fp = fingerprintMcpServer(BASIC_SERVER as unknown as Record<string, unknown>);
    // 指纹是 sha256 hex,不能包含原始 secret 字符串
    expect(fp).not.toContain('sk-real-secret-value-should-not-appear');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. fingerprintMcpServersFromRaw — 多文件/跳过非 mcp JSON
// ══════════════════════════════════════════════════════════════════════════════

describe('fingerprintMcpServersFromRaw', () => {
  it('从单个 mcp.json 提取 server 指纹', () => {
    const raw = new Map([
      ['.claude/mcp.json', JSON.stringify(BASIC_MCP_CONFIG)],
    ]);
    const fp = fingerprintMcpServersFromRaw(raw);
    expect(fp.size).toBe(1);
    // v0.8-3:key 格式改为 "relPath::server::serverName"
    expect(fp.has('.claude/mcp.json::server::filesystem')).toBe(true);
    expect(fp.get('.claude/mcp.json::server::filesystem')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('从多个文件聚合', () => {
    const raw = new Map([
      ['.claude/mcp.json', JSON.stringify({ mcpServers: { serverA: BASIC_SERVER } })],
      ['.cursor/mcp.json', JSON.stringify({ mcpServers: { serverB: { command: 'node', args: ['server.js'] } } })],
    ]);
    const fp = fingerprintMcpServersFromRaw(raw);
    expect(fp.size).toBe(2);
    expect(fp.has('.claude/mcp.json::server::serverA')).toBe(true);
    expect(fp.has('.cursor/mcp.json::server::serverB')).toBe(true);
  });

  it('无效 JSON 静默跳过', () => {
    const raw = new Map([
      ['.claude/mcp.json', 'not json {{{'],
    ]);
    expect(fingerprintMcpServersFromRaw(raw).size).toBe(0);
  });

  it('无 mcpServers 字段的 JSON 静默跳过', () => {
    const raw = new Map([
      ['.gemini/settings.json', JSON.stringify({ theme: 'dark' })],
    ]);
    expect(fingerprintMcpServersFromRaw(raw).size).toBe(0);
  });

  it('secret VALUE 不出现在任何指纹值中', () => {
    const raw = new Map([
      ['.claude/mcp.json', JSON.stringify(BASIC_MCP_CONFIG)],
    ]);
    const fp = fingerprintMcpServersFromRaw(raw);
    for (const [, hash] of fp) {
      expect(hash).not.toContain('sk-real-secret-value-should-not-appear');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. diffConfigBaseline — added/changed/removed(MCP 部分)
// ══════════════════════════════════════════════════════════════════════════════

describe('diffConfigBaseline (MCP keys)', () => {
  const baselineMap = new Map([
    ['.claude/mcp.json::server::server-a', 'aaa'],
    ['.claude/mcp.json::server::server-b', 'bbb'],
  ]);

  it('完全相同 → 空 diff', () => {
    const diff = diffConfigBaseline(new Map(baselineMap), baselineMap);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('hash 变化 → changed', () => {
    const current = new Map(baselineMap);
    current.set('.claude/mcp.json::server::server-a', 'xxx-different');
    const diff = diffConfigBaseline(current, baselineMap);
    expect(diff.changed).toEqual(['.claude/mcp.json::server::server-a']);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('新增 server → added', () => {
    const current = new Map(baselineMap);
    current.set('.claude/mcp.json::server::server-new', 'new-hash');
    const diff = diffConfigBaseline(current, baselineMap);
    expect(diff.added).toEqual(['.claude/mcp.json::server::server-new']);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('移除 server → removed', () => {
    const current = new Map([['.claude/mcp.json::server::server-a', 'aaa']]);
    const diff = diffConfigBaseline(current, baselineMap);
    expect(diff.removed).toEqual(['.claude/mcp.json::server::server-b']);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
  });

  it('diff 结果列表按字母排序', () => {
    const current = new Map([
      ['.cursor/mcp.json::server::z-server', 'z'],
      ['.cursor/mcp.json::server::a-server', 'a'],
    ]);
    const baseline = new Map<string, string>();
    const diff = diffConfigBaseline(current, baseline);
    expect(diff.added).toEqual(['.cursor/mcp.json::server::a-server', '.cursor/mcp.json::server::z-server']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. configDiffToFindings — ruleId / severity (MCP 部分)
// ══════════════════════════════════════════════════════════════════════════════

describe('configDiffToFindings (MCP)', () => {
  it('changed MCP server → mcp/server-config-changed (high)', () => {
    const findings = configDiffToFindings({
      changed: ['.claude/mcp.json::server::my-server'],
      added: [],
      removed: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe('mcp/server-config-changed');
    expect(findings[0]!.severity).toBe('high');
    expect(findings[0]!.file).toBe('.claude/mcp.json');
    expect(findings[0]!.message).toContain('my-server');
  });

  it('added MCP server → mcp/server-added (medium)', () => {
    const findings = configDiffToFindings({
      changed: [],
      added: ['.cursor/mcp.json::server::new-server'],
      removed: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe('mcp/server-added');
    expect(findings[0]!.severity).toBe('medium');
    expect(findings[0]!.file).toBe('.cursor/mcp.json');
    expect(findings[0]!.message).toContain('new-server');
  });

  it('removed → 无 finding(移除不是威胁)', () => {
    const findings = configDiffToFindings({
      changed: [],
      added: [],
      removed: ['.claude/mcp.json::server::old-server'],
    });
    expect(findings).toHaveLength(0);
  });

  it('多种情形同时 → 每种各一条 finding', () => {
    const findings = configDiffToFindings({
      changed: ['.claude/mcp.json::server::s1'],
      added: ['.claude/mcp.json::server::s2'],
      removed: ['.claude/mcp.json::server::s3'],
    });
    expect(findings).toHaveLength(2);
    const ruleIds = findings.map((f) => f.ruleId);
    expect(ruleIds).toContain('mcp/server-config-changed');
    expect(ruleIds).toContain('mcp/server-added');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. writeConfigBaseline / loadConfigBaseline / validateConfigBaseline
// ══════════════════════════════════════════════════════════════════════════════

describe('writeConfigBaseline / loadConfigBaseline', () => {
  it('写出后可读回,内容一致', async () => {
    const dir = makeTmpDir();
    const file = join(dir, 'config-baseline.json');
    const fp = new Map([
      ['.claude/mcp.json::server::server-a', 'aaaa1234'],
      ['.cursor/mcp.json::server::server-b', 'bbbb5678'],
    ]);
    await writeConfigBaseline(file, fp);
    const loaded = await loadConfigBaseline(file);
    expect(loaded.get('.claude/mcp.json::server::server-a')).toBe('aaaa1234');
    expect(loaded.get('.cursor/mcp.json::server::server-b')).toBe('bbbb5678');
    expect(loaded.size).toBe(2);
  });

  it('写出文件 keys 已排序', async () => {
    const dir = makeTmpDir();
    const file = join(dir, 'config-baseline.json');
    const fp = new Map([
      ['z::server::server', 'z'],
      ['a::server::server', 'a'],
    ]);
    await writeConfigBaseline(file, fp);
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { servers: Record<string, string> };
    const keys = Object.keys(parsed.servers);
    expect(keys).toEqual([...keys].sort());
  });

  it('文件末尾有换行符', async () => {
    const dir = makeTmpDir();
    const file = join(dir, 'config-baseline.json');
    await writeConfigBaseline(file, new Map());
    const raw = readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('ENOENT → ConfigBaselineError', async () => {
    await expect(loadConfigBaseline('/nonexistent/path/config-baseline.json'))
      .rejects.toBeInstanceOf(ConfigBaselineError);
  });

  it('JSON 损坏 → ConfigBaselineError', async () => {
    const dir = makeTmpDir();
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{{{invalid json');
    await expect(loadConfigBaseline(file)).rejects.toBeInstanceOf(ConfigBaselineError);
  });
});

describe('validateConfigBaseline', () => {
  it('缺少 version → ConfigBaselineError', () => {
    expect(() => validateConfigBaseline({ servers: {} }, '/x')).toThrow(ConfigBaselineError);
  });

  it('servers 不是对象 → ConfigBaselineError', () => {
    expect(() => validateConfigBaseline({ version: 1, servers: ['x'] }, '/x')).toThrow(ConfigBaselineError);
  });

  it('servers 值不是字符串 → ConfigBaselineError', () => {
    expect(() => validateConfigBaseline({ version: 1, servers: { key: 123 } }, '/x')).toThrow(ConfigBaselineError);
  });

  it('合法结构 → 正常返回 Map', () => {
    const result = validateConfigBaseline(
      { version: 1, servers: { 'a::server::b': 'abc123' } },
      '/x',
    );
    expect(result.get('a::server::b')).toBe('abc123');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. CLI — 无 --configs 时使用 config baseline 标志 → clean error exit 1
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: --write-config-baseline 无 --configs → error', () => {
  it('exit 1 + stderr 提示须配合 --configs', () => {
    const dir = makeTmpDir();
    const res = runBin(['audit', '--home', dir, '--write-config-baseline', 'out.json'], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--configs/);
  });
});

describe('CLI: --config-baseline 无 --configs → error', () => {
  it('exit 1 + stderr 提示须配合 --configs', () => {
    const dir = makeTmpDir();
    const res = runBin(['audit', '--home', dir, '--config-baseline', 'config-bl.json'], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--configs/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. CLI — --write-config-baseline 写出文件,exit 0
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: --write-config-baseline', () => {
  it('写出基线文件,exit 0,stdout 有提示', () => {
    const { home } = makeFakeHome(BASIC_MCP_CONFIG);
    const outFile = join(home, 'config-baseline.json');
    const res = runBin(
      ['audit', '--home', home, '--configs', '--write-config-baseline', outFile],
      home,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/配置漂移基线/);
    // 文件存在且可解析
    const raw = readFileSync(outFile, 'utf8');
    const parsed = JSON.parse(raw) as { version: number; servers: Record<string, string> };
    expect(parsed.version).toBe(1);
    expect(typeof parsed.servers).toBe('object');
  });

  it('基线文件中不含 secret 值', () => {
    const { home } = makeFakeHome(BASIC_MCP_CONFIG);
    const outFile = join(home, 'config-baseline.json');
    runBin(['audit', '--home', home, '--configs', '--write-config-baseline', outFile], home);
    const raw = readFileSync(outFile, 'utf8');
    // sk-real-secret-value-should-not-appear 是 BASIC_SERVER.env.API_KEY 的值
    expect(raw).not.toContain('sk-real-secret-value-should-not-appear');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. CLI — 无变化 + --config-baseline → 无 drift finding,exit 0
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: --config-baseline 无变化', () => {
  it('相同配置对比基线 → 无 drift finding,exit 0', () => {
    const { home } = makeFakeHome(BASIC_MCP_CONFIG);
    const blFile = join(home, 'config-baseline.json');
    // 先写基线
    const w = runBin(['audit', '--home', home, '--configs', '--write-config-baseline', blFile], home);
    expect(w.status).toBe(0);
    // 再对比(配置未变)
    const r = runBin(['audit', '--home', home, '--configs', '--config-baseline', blFile], home);
    // 无漂移 finding → stdout 里没有 mcp/server-config-changed 或 mcp/server-added
    expect(r.stdout).not.toContain('mcp/server-config-changed');
    expect(r.stdout).not.toContain('mcp/server-added');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. CLI — command/args 变化 → mcp/server-config-changed (exit 1)
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: command 变化 → mcp/server-config-changed', () => {
  it('command 改变后对比基线 → exit 1 + mcp/server-config-changed 出现', () => {
    const { home, configPath } = makeFakeHome(BASIC_MCP_CONFIG);
    const blFile = join(home, 'config-baseline.json');
    // 写基线
    runBin(['audit', '--home', home, '--configs', '--write-config-baseline', blFile], home);
    // 篡改 command
    const tampered = {
      mcpServers: {
        filesystem: { ...BASIC_SERVER, command: 'curl' },
      },
    };
    writeFileSync(configPath, JSON.stringify(tampered, null, 2));
    // 对比
    const r = runBin(['audit', '--home', home, '--configs', '--config-baseline', blFile], home);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('mcp/server-config-changed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. CLI — url 变化 → mcp/server-config-changed
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: url 变化 → mcp/server-config-changed', () => {
  it('url 改变后对比基线 → exit 1 + finding', () => {
    const remoteConfig = {
      mcpServers: {
        remote: { url: 'https://mcp.trusted.com/v1', headers: {} },
      },
    };
    const { home, configPath } = makeFakeHome(remoteConfig);
    const blFile = join(home, 'config-baseline.json');
    runBin(['audit', '--home', home, '--configs', '--write-config-baseline', blFile], home);
    // 篡改 url
    const tampered = {
      mcpServers: {
        remote: { url: 'https://mcp.evil.com/v1', headers: {} },
      },
    };
    writeFileSync(configPath, JSON.stringify(tampered, null, 2));
    const r = runBin(['audit', '--home', home, '--configs', '--config-baseline', blFile], home);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('mcp/server-config-changed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. CLI — 新 server → mcp/server-added (medium,不直接阻断)
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: 新 server → mcp/server-added', () => {
  it('新 server 出现 → mcp/server-added 在输出中', () => {
    // 从空 home 写基线(无 server)
    const home = makeTmpDir();
    mkdirSync(join(home, '.claude'), { recursive: true });
    const configPath = join(home, '.claude/mcp.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2));
    const blFile = join(home, 'config-baseline.json');
    runBin(['audit', '--home', home, '--configs', '--write-config-baseline', blFile], home);
    // 添加新 server
    writeFileSync(configPath, JSON.stringify(BASIC_MCP_CONFIG, null, 2));
    const r = runBin(['audit', '--home', home, '--configs', '--config-baseline', blFile], home);
    expect(r.stdout).toContain('mcp/server-added');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. CLI — 移除 server → 无 finding,不阻断
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: 移除 server → 无阻断 finding', () => {
  it('移除 server 后对比基线 → stdout 不含 mcp/server-config-changed', () => {
    // 先有一个 server
    const { home, configPath } = makeFakeHome(BASIC_MCP_CONFIG);
    const blFile = join(home, 'config-baseline.json');
    runBin(['audit', '--home', home, '--configs', '--write-config-baseline', blFile], home);
    // 移除 server
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2));
    const r = runBin(['audit', '--home', home, '--configs', '--config-baseline', blFile], home);
    // 移除不产生 drift finding
    expect(r.stdout).not.toContain('mcp/server-config-changed');
    expect(r.stdout).not.toContain('mcp/server-added');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 13. CLI — --format json 含漂移 finding
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: --format json 含漂移 finding', () => {
  it('命令变化时 JSON 输出含 mcp/server-config-changed finding', () => {
    const { home, configPath } = makeFakeHome(BASIC_MCP_CONFIG);
    const blFile = join(home, 'config-baseline.json');
    runBin(['audit', '--home', home, '--configs', '--write-config-baseline', blFile], home);
    // 篡改
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { filesystem: { ...BASIC_SERVER, command: 'evil-cmd' } },
    }));
    const r = runBin(['audit', '--home', home, '--configs', '--config-baseline', blFile, '--format', 'json'], home);
    // 应能解析为 JSON,且包含漂移 finding
    const json = JSON.parse(r.stdout) as { configs?: Array<{ findings: Array<{ ruleId: string }> }> };
    const allFindings = (json.configs ?? []).flatMap((c) => c.findings);
    expect(allFindings.some((f) => f.ruleId === 'mcp/server-config-changed')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 14. CLI — --policy suppress mcp/server-config-changed → exit 0
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: --policy suppress mcp/server-config-changed', () => {
  it('被策略抑制后不阻断', () => {
    // 使用不含 env secret 的简单服务器,避免其它高严重度 finding 干扰本测试
    const cleanServer = { command: 'node', args: ['server.js'] };
    const cleanConfig = { mcpServers: { myserver: cleanServer } };
    const { home, configPath } = makeFakeHome(cleanConfig);
    const blFile = join(home, 'config-baseline.json');
    runBin(['audit', '--home', home, '--configs', '--write-config-baseline', blFile], home);
    // 篡改 command
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { myserver: { ...cleanServer, command: 'evil-cmd' } },
    }));
    // 写策略文件:抑制 mcp/server-config-changed
    const policyFile = join(home, '.skill-switch-policy.json');
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      failOn: 'critical',
      suppress: [{ ruleId: 'mcp/server-config-changed' }],
    }));
    const r = runBin(
      ['audit', '--home', home, '--configs', '--config-baseline', blFile, '--policy', policyFile],
      home,
    );
    // mcp/server-config-changed 被抑制 → 不阻断(exit 0)
    expect(r.status).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 15. CLI — 基线文件缺失 / JSON 损坏 → clean error exit 1
// ══════════════════════════════════════════════════════════════════════════════

describe('CLI: 基线文件错误处理', () => {
  it('基线文件不存在 → exit 1 + stderr 友好提示', () => {
    const home = makeTmpDir();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude/mcp.json'), JSON.stringify(BASIC_MCP_CONFIG));
    const r = runBin(
      ['audit', '--home', home, '--configs', '--config-baseline', '/nonexistent/config-baseline.json'],
      home,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/配置基线|config.*baseline/i);
  });

  it('基线文件 JSON 损坏 → exit 1 + stderr 友好提示', () => {
    const home = makeTmpDir();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude/mcp.json'), JSON.stringify(BASIC_MCP_CONFIG));
    const blFile = join(home, 'bad-baseline.json');
    writeFileSync(blFile, '{{{bad json');
    const r = runBin(
      ['audit', '--home', home, '--configs', '--config-baseline', blFile],
      home,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/配置基线|config.*baseline/i);
  });
});
