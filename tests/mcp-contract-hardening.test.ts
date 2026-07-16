import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStats } from '../src/core/stats.ts';
import { MAX_FILE_BYTES } from '../src/cli/commands/audit.ts';
import { getStatsCachePath } from '../src/core/stats-cache.ts';
import {
  createMcpStdioTransport,
  handleMcpRequest,
  MCP_MAX_FRAME_BYTES,
  MCP_MAX_PENDING_REQUESTS,
  type JsonRpcResponse,
} from '../src/mcp/server.ts';

const VERSION = 'mcp-contract-test';
const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'skill-switch-mcp-contract-'));
  temporaryHomes.push(home);
  return home;
}

function transcriptLine(skill: string, args: string, timestamp = new Date().toISOString()): string {
  return JSON.stringify({
    timestamp,
    message: {
      content: [{ type: 'tool_use', name: 'Skill', input: { skill, args } }],
    },
  });
}

async function writeTranscript(home: string, args: string): Promise<void> {
  const directory = join(home, '.claude', 'projects', 'project');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'session.jsonl'), `${transcriptLine('safe-skill', args)}\n`);
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const key = relative(root, absolute);
      if (entry.isDirectory()) {
        snapshot[`${key}/`] = '<directory>';
        await walk(absolute);
      } else if (entry.isFile()) {
        snapshot[key] = (await readFile(absolute)).toString('base64');
      }
    }
  }
  await walk(root);
  return snapshot;
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('stats cache privacy and modes', () => {
  it('persists only v2 aggregates and never raw transcript args', async () => {
    const home = temporaryHome();
    const secret = 'TOP_SECRET_MCP_CACHE_VALUE';
    await writeTranscript(home, `--token ${secret}`);

    const first = await buildStats(home, undefined, {});
    expect(first.cacheMisses).toBe(1);

    const raw = await readFile(getStatsCachePath(home), 'utf8');
    const cache = JSON.parse(raw) as {
      version: number;
      entries: Record<string, { aggregates: Array<{ skill: string; count: number }> }>;
    };
    expect(cache.version).toBe(2);
    expect(Object.values(cache.entries)[0]?.aggregates).toEqual([
      expect.objectContaining({ skill: 'safe-skill', count: 1 }),
    ]);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('"args"');
    expect(raw).not.toContain('"sessionFile"');

    const second = await buildStats(home, undefined, {});
    expect(second.cacheHits).toBe(1);
    expect(second.invocations).toBe(1);
  });

  it('read-only and disabled cache modes never create a cache file', async () => {
    for (const cacheMode of ['read-only', 'disabled'] as const) {
      const home = temporaryHome();
      await writeTranscript(home, 'literal args');
      const report = await buildStats(home, undefined, {}, { cacheMode });
      expect(report.invocations).toBe(1);
      await expect(readFile(getStatsCachePath(home), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

describe('MCP read-only contract', () => {
  it('skill_switch_stats leaves the supplied home byte-for-byte unchanged', async () => {
    const home = temporaryHome();
    await writeTranscript(home, '--api-key should-not-be-copied');
    const skillDirectory = join(home, '.claude', 'skills', 'safe-skill');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: safe-skill\ndescription: fixture.\n---\nBody.\n',
    );
    const before = await snapshotTree(home);

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'skill_switch_stats', arguments: { home } },
      },
      VERSION,
    );

    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1, result: { content: expect.any(Array) } });
    expect(await snapshotTree(home)).toEqual(before);
  });

  it('path audit exposes incomplete coverage and the fail-closed decision', async () => {
    const home = temporaryHome();
    const skill = join(home, 'oversized-skill');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: oversized-skill\ndescription: fixture.\n---\n');
    await writeFile(join(skill, 'payload.sh'), 'x'.repeat(MAX_FILE_BYTES + 1));

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'skill_switch_audit', arguments: { path: skill } },
      },
      VERSION,
    );
    const text = (response?.result as { content: Array<{ text: string }> }).content[0]!.text;
    const report = JSON.parse(text) as {
      blocked: boolean;
      coverage: { complete: boolean; incompleteReasons: string[] };
    };
    expect(report.blocked).toBe(true);
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.incompleteReasons).toContain('oversized-text-file');
  });
});

describe('JSON-RPC runtime shape validation', () => {
  it.each([
    null,
    [],
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: {}, method: 'ping' },
    { jsonrpc: '2.0', id: 1, method: 'ping', params: 'not-structured' },
  ])('returns -32600 instead of throwing for invalid request %#', async (request) => {
    await expect(handleMcpRequest(request, VERSION)).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600 },
    });
  });

  it('returns -32602 for positional or malformed method parameters', async () => {
    await expect(
      handleMcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: [] },
        VERSION,
      ),
    ).resolves.toMatchObject({ id: 1, error: { code: -32602 } });
    await expect(
      handleMcpRequest(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'skill_switch_scan', arguments: 'not-an-object' },
        },
        VERSION,
      ),
    ).resolves.toMatchObject({ id: 2, error: { code: -32602 } });
  });
});

describe('bounded serial MCP stdio transport', () => {
  it('survives malformed and invalid JSON frames, then processes the next split frame', async () => {
    const responses: JsonRpcResponse[] = [];
    const transport = createMcpStdioTransport(VERSION, (response) => responses.push(response));
    transport.push('{broken json\nnull\n{"jsonrpc":"2.0","id":7,"method":"pi');
    transport.push('ng"}');
    await transport.end();

    expect(responses).toHaveLength(3);
    expect(responses[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(responses[1]).toMatchObject({ id: null, error: { code: -32600 } });
    expect(responses[2]).toMatchObject({ id: 7, result: {} });
  });

  it('accepts a frame at exactly 1 MiB and rejects a fragmented frame one byte over', async () => {
    const responses: JsonRpcResponse[] = [];
    const transport = createMcpStdioTransport(VERSION, (response) => responses.push(response));
    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const exactFrame = `${request}${' '.repeat(MCP_MAX_FRAME_BYTES - Buffer.byteLength(request))}`;
    transport.push(`${exactFrame}\n`);
    transport.push('x'.repeat(MCP_MAX_FRAME_BYTES));
    transport.push(`x\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
    await transport.end();

    expect(responses).toContainEqual(expect.objectContaining({ id: 1, result: {} }));
    expect(responses).toContainEqual(
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32600 }) }),
    );
    expect(responses).toContainEqual(expect.objectContaining({ id: 2, result: {} }));
  });

  it('caps the serial queue and rejects excess requests without retaining them', async () => {
    const responses: JsonRpcResponse[] = [];
    const transport = createMcpStdioTransport(VERSION, (response) => responses.push(response));
    const total = MCP_MAX_PENDING_REQUESTS + 6;
    const frames = Array.from({ length: total }, (_, id) =>
      JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }),
    );
    transport.push(`${frames.join('\n')}\n`);
    await transport.end();

    expect(responses).toHaveLength(total);
    const overloaded = responses.filter((response) => response.error?.code === -32000);
    expect(overloaded).toHaveLength(6);
    const completedIds = responses
      .filter((response) => response.result !== undefined)
      .map((response) => response.id);
    expect(completedIds).toEqual(Array.from({ length: MCP_MAX_PENDING_REQUESTS }, (_, id) => id));
  });
});
