// C 线测试:两源归一化 + 聚合搜索。
// 覆盖:① MCP Registry 响应归一化;② marketplace.json 解析归一化;③ 防御式解析(缺字段不崩);
//       ④ 聚合两源 + marketplace 未给仓库时跳过;⑤ 单源出错不影响另一源。
// 全程 mock fetch,零真实网络。
import { describe, expect, it, vi } from 'vitest';
import { searchRegistries } from '../src/core/registry/index.ts';
import { normalizeServer, searchMcpServers } from '../src/core/registry/mcp-registry.ts';
import {
  marketplaceUrl,
  normalizeMarketplaceDoc,
  parseOwnerRepo,
  searchMarketplace,
} from '../src/core/registry/marketplace.ts';

// ── 样例:官方 MCP Registry GET /v0/servers 响应(实测形状) ──────────────────
const MCP_RESPONSE = {
  servers: [
    {
      server: {
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025/server.schema.json',
        name: 'io.github.pulsemcp/remote-filesystem',
        description: 'Remote filesystem MCP server',
        version: '0.1.5',
        repository: {
          url: 'https://github.com/pulsemcp/mcp-servers',
          source: 'github',
          subfolder: 'experimental/remote-filesystem',
        },
        packages: [
          {
            registryType: 'npm',
            registryBaseUrl: 'https://registry.npmjs.org',
            identifier: 'remote-filesystem-mcp-server',
            version: '0.1.5',
            runtimeHint: 'npx',
            transport: { type: 'stdio' },
          },
        ],
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
    },
    {
      // 只有 remotes / packages,无 repository → 退回 npm 安装提示
      server: {
        name: 'ac.inference.sh/mcp',
        description: 'Inference.sh hosted MCP',
        title: 'Inference MCP',
        version: '1.0.1',
        packages: [{ registryType: 'npm', identifier: 'inference-mcp', version: '1.0.1' }],
      },
    },
    {
      // 极简条目:只有名字 → 仍归一化,sourceType=unknown
      server: { name: 'bare.example/minimal' },
    },
  ],
  metadata: { nextCursor: 'ac.inference.sh/mcp:1.0.1', count: 3 },
};

// ── 样例:.claude-plugin/marketplace.json(实测形状) ────────────────────────
const MARKETPLACE_DOC = {
  name: 'anthropic-agent-skills',
  owner: { name: 'Anthropic', email: 'x@example.com' },
  metadata: { description: 'demo', version: '1.0.0' },
  plugins: [
    {
      name: 'document-skills',
      description: 'Document processing suite',
      source: './',
      strict: false,
      skills: ['./skills/xlsx', './skills/docx', './skills/pptx', './skills/pdf'],
    },
    {
      name: 'claude-api',
      description: 'Claude API docs skill',
      source: './',
      skills: ['./skills/claude-api'],
    },
    {
      // 外部 owner/repo 源,无 skills 列表 → 单条目,装时克隆整个仓库
      name: 'external-plugin',
      description: 'lives in another repo',
      source: 'someone/their-repo',
    },
  ],
};

function jsonOk(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('registry: ① MCP Registry 归一化', () => {
  it('搜索归一化:仓库 / npm 退化 / 极简条目都正确', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/v0/servers');
      expect(url).toContain('search=fs');
      expect(url).toMatch(/^https:\/\//);
      return jsonOk(MCP_RESPONSE);
    });
    const entries = await searchMcpServers('fs', { fetchImpl: fetchImpl as never });
    expect(entries).toHaveLength(3);

    const withRepo = entries[0]!;
    expect(withRepo.id).toBe('io.github.pulsemcp/remote-filesystem');
    expect(withRepo.source).toBe('mcp');
    expect(withRepo.sourceType).toBe('git');
    expect(withRepo.repositoryUrl).toBe('https://github.com/pulsemcp/mcp-servers');
    expect(withRepo.subdir).toBe('experimental/remote-filesystem');
    expect(withRepo.installHint).toBe('https://github.com/pulsemcp/mcp-servers');
    expect(withRepo.version).toBe('0.1.5');

    const npmOnly = entries[1]!;
    expect(npmOnly.sourceType).toBe('npm');
    expect(npmOnly.repositoryUrl).toBeUndefined();
    expect(npmOnly.installHint).toBe('inference-mcp@1.0.1');
    expect(npmOnly.description).toBe('Inference.sh hosted MCP');

    const bare = entries[2]!;
    expect(bare.id).toBe('bare.example/minimal');
    expect(bare.sourceType).toBe('unknown');
    expect(bare.installHint).toBeUndefined();
    expect(bare.description).toBe('');
  });

  it('③ 防御式:无名字条目被丢弃;servers 非数组当空;接受裸 server 对象', () => {
    expect(normalizeServer({ server: { description: 'no name' } })).toBeUndefined();
    expect(normalizeServer(null)).toBeUndefined();
    expect(normalizeServer('nonsense')).toBeUndefined();
    // 裸 server 对象(无外层信封)
    const e = normalizeServer({ name: 'x/y', description: 'd' });
    expect(e?.id).toBe('x/y');
  });

  it('servers 字段缺失 / 非数组 → 返回空,不崩', async () => {
    const fetchImpl = vi.fn(async () => jsonOk({ metadata: {} }));
    await expect(searchMcpServers('q', { fetchImpl: fetchImpl as never })).resolves.toEqual([]);
  });
});

describe('registry: ② marketplace.json 归一化', () => {
  it('parseOwnerRepo 校验形态,拒绝穿越', () => {
    expect(parseOwnerRepo('anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills' });
    expect(parseOwnerRepo('anthropics/skills.git')).toEqual({ owner: 'anthropics', repo: 'skills' });
    expect(parseOwnerRepo('../etc/passwd')).toBeUndefined();
    expect(parseOwnerRepo('only-one-seg')).toBeUndefined();
    expect(parseOwnerRepo('a/b/c')).toBeUndefined();
  });

  it('marketplaceUrl 拼 HEAD raw 路径', () => {
    expect(marketplaceUrl('anthropics', 'skills')).toBe(
      'https://raw.githubusercontent.com/anthropics/skills/HEAD/.claude-plugin/marketplace.json',
    );
  });

  it('doc 归一化:plugin 总条目 + 每个 skill 子目录派生条目', () => {
    const entries = normalizeMarketplaceDoc(MARKETPLACE_DOC, 'anthropics/skills');
    const ids = entries.map((e) => e.id);
    // document-skills(总)+ 4 个 skill 派生 + claude-api(总)+ 1 派生 + external-plugin(总) = 8
    expect(ids).toContain('document-skills');
    expect(ids).toContain('document-skills/xlsx');
    expect(ids).toContain('claude-api/claude-api');
    expect(ids).toContain('external-plugin');

    const xlsx = entries.find((e) => e.id === 'document-skills/xlsx')!;
    expect(xlsx.source).toBe('marketplace');
    expect(xlsx.sourceType).toBe('git');
    // source "./" → 指 marketplace 仓库自身
    expect(xlsx.repositoryUrl).toBe('https://github.com/anthropics/skills.git');
    expect(xlsx.subdir).toBe('skills/xlsx');
    expect(xlsx.marketplaceRepo).toBe('anthropics/skills');

    // 外部源被解析成对应仓库 URL
    const ext = entries.find((e) => e.id === 'external-plugin')!;
    expect(ext.repositoryUrl).toBe('https://github.com/someone/their-repo.git');
  });

  it('③ 防御式:顶层非对象 / plugins 非数组 / plugin 缺名都安全降级', () => {
    expect(normalizeMarketplaceDoc(null, 'a/b')).toEqual([]);
    expect(normalizeMarketplaceDoc({ plugins: 'nope' }, 'a/b')).toEqual([]);
    expect(normalizeMarketplaceDoc({ plugins: [{ description: 'no name' }, 42] }, 'a/b')).toEqual([]);
  });

  it('searchMarketplace 拉取 + 过滤匹配', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        'https://raw.githubusercontent.com/anthropics/skills/HEAD/.claude-plugin/marketplace.json',
      );
      return jsonOk(MARKETPLACE_DOC);
    });
    const docMatches = await searchMarketplace('anthropics/skills', 'docx', {
      fetchImpl: fetchImpl as never,
    });
    expect(docMatches.map((e) => e.id)).toContain('document-skills/docx');
    // 不匹配的 skill 被过滤掉
    expect(docMatches.some((e) => e.id === 'document-skills/pdf')).toBe(false);
  });

  it('searchMarketplace 拒绝非法仓库格式', async () => {
    await expect(searchMarketplace('bad', 'q', { fetchImpl: vi.fn() as never })).rejects.toThrow(
      /owner\/repo/,
    );
  });
});

describe('registry: ④⑤ 聚合搜索', () => {
  it('两源都查;marketplace 未给仓库 → 跳过并标注(不报错)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('registry'); // 只该打 MCP
      return jsonOk(MCP_RESPONSE);
    });
    const result = await searchRegistries('fs', { fetchImpl: fetchImpl as never });
    expect(result.entries.length).toBe(3); // 仅 MCP
    const mp = result.perSource.find((s) => s.source === 'marketplace')!;
    expect(mp.skipped).toContain('--marketplace');
    // marketplace 没联网
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('给了 marketplace 仓库 → 两源合并', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) return jsonOk(MARKETPLACE_DOC);
      return jsonOk(MCP_RESPONSE);
    });
    const result = await searchRegistries('', {
      fetchImpl: fetchImpl as never,
      marketplaceRepo: 'anthropics/skills',
    });
    const sources = new Set(result.entries.map((e) => e.source));
    expect(sources).toEqual(new Set(['mcp', 'marketplace']));
  });

  it('单源出错不影响另一源(MCP 报错,marketplace 仍出结果)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('raw.githubusercontent.com')) return jsonOk(MARKETPLACE_DOC);
      // MCP 返回非 JSON content-type → fetchJson 抛
      return new Response('oops', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const result = await searchRegistries('docx', {
      fetchImpl: fetchImpl as never,
      marketplaceRepo: 'anthropics/skills',
    });
    const mcp = result.perSource.find((s) => s.source === 'mcp')!;
    expect(mcp.error).toBeTruthy();
    // marketplace 条目仍在
    expect(result.entries.some((e) => e.source === 'marketplace')).toBe(true);
  });

  it('--source mcp 时只查 MCP,不碰 marketplace', async () => {
    const fetchImpl = vi.fn(async () => jsonOk(MCP_RESPONSE));
    const result = await searchRegistries('fs', { fetchImpl: fetchImpl as never, source: 'mcp' });
    expect(result.perSource.every((s) => s.source === 'mcp')).toBe(true);
  });
});
