import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const NON_CLI_ROOTS = [join(SRC_ROOT, 'core'), join(SRC_ROOT, 'mcp')];
const RELATIVE_CLI_IMPORT = /(?:from\s+|import\s*\()\s*['"](?:\.\.\/)+cli\//gu;

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('architecture boundaries', () => {
  it('keeps reusable core and MCP modules independent from the CLI command layer', async () => {
    const files = (await Promise.all(NON_CLI_ROOTS.map(listTypeScriptFiles))).flat();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (RELATIVE_CLI_IMPORT.test(source)) violations.push(relative(SRC_ROOT, file));
      RELATIVE_CLI_IMPORT.lastIndex = 0;
    }

    expect(violations).toEqual([]);
  });
});
