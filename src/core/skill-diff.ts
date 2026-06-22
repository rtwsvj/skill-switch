// D2:内容漂移的「改了什么」—— 对 copy 模式技能,把磁盘上的技能目录与 store 里的耐久副本
// (install 时落的「应该是什么」)逐文件对比,产出 added / removed / modified 列表。
// symlink 模式磁盘即源,没有独立参照,标 comparable=false。纯只读,不改任何文件。
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import type { AgentType } from '../vendor/vercel-skills/types.ts';

export type SkillFileDiffStatus = 'added' | 'removed' | 'modified';

export interface SkillFileDiff {
  /** 相对技能目录的路径 */
  path: string;
  status: SkillFileDiffStatus;
}

export interface SkillDiff {
  agent: AgentType;
  name: string;
  /** 能否对比:false 表示没有 store 参照(symlink 模式 / 非 copy 安装 / 目录缺失)。 */
  comparable: boolean;
  reason?: string;
  diskDir?: string;
  storeDir?: string;
  files: SkillFileDiff[];
}

// ---------------------------------------------------------------------------
// Unified diff generation (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Compute the longest common subsequence (LCS) of two arrays of strings.
 * Returns an array of [indexA, indexB] pairs that are in the LCS.
 */
function lcs(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = length of LCS of a[0..i-1], b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  // Backtrack to get the pairs
  const pairs: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  pairs.reverse();
  return pairs;
}

interface EditOp {
  type: 'context' | 'added' | 'removed';
  lineA: number; // 1-based line number in source (a), -1 for pure additions
  lineB: number; // 1-based line number in dest (b), -1 for pure removals
  text: string;
}

/**
 * Produce a sequence of edit operations (context/added/removed) from two
 * line arrays using LCS-based diff.
 */
function diffLines(a: string[], b: string[]): EditOp[] {
  const lcsPairs = lcs(a, b);
  const ops: EditOp[] = [];

  let ia = 0; // current position in a
  let ib = 0; // current position in b

  for (const [pa, pb] of lcsPairs) {
    // Drain removed lines from a before this LCS point
    while (ia < pa) {
      ops.push({ type: 'removed', lineA: ia + 1, lineB: -1, text: a[ia]! });
      ia++;
    }
    // Drain added lines from b before this LCS point
    while (ib < pb) {
      ops.push({ type: 'added', lineA: -1, lineB: ib + 1, text: b[ib]! });
      ib++;
    }
    // Common line
    ops.push({ type: 'context', lineA: ia + 1, lineB: ib + 1, text: a[ia]! });
    ia++;
    ib++;
  }
  // Remaining lines
  while (ia < a.length) {
    ops.push({ type: 'removed', lineA: ia + 1, lineB: -1, text: a[ia]! });
    ia++;
  }
  while (ib < b.length) {
    ops.push({ type: 'added', lineA: -1, lineB: ib + 1, text: b[ib]! });
    ib++;
  }
  return ops;
}

/**
 * Convert a sequence of edit operations into unified diff hunk text.
 * context: number of surrounding context lines (default 3).
 */
function opsToHunks(ops: EditOp[], context = 3): string {
  if (ops.length === 0) return '';

  // Identify indices of ops that are changed (not context-only)
  const changedIdx = ops.reduce<number[]>((acc, op, i) => {
    if (op.type !== 'context') acc.push(i);
    return acc;
  }, []);

  if (changedIdx.length === 0) return '';

  // Build groups: ranges of ops to include, merging overlapping context windows
  const groups: Array<[number, number]> = []; // [start, end] inclusive
  for (const ci of changedIdx) {
    const start = Math.max(0, ci - context);
    const end = Math.min(ops.length - 1, ci + context);
    if (groups.length === 0 || start > groups[groups.length - 1]![1] + 1) {
      groups.push([start, end]);
    } else {
      groups[groups.length - 1]![1] = Math.max(groups[groups.length - 1]![1]!, end);
    }
  }

  const lines: string[] = [];
  for (const [start, end] of groups) {
    const slice = ops.slice(start, end + 1);
    // Compute hunk header numbers
    const aStart = slice.find((o) => o.lineA > 0)?.lineA ?? 0;
    const bStart = slice.find((o) => o.lineB > 0)?.lineB ?? 0;
    const aCount = slice.filter((o) => o.type !== 'added').length;
    const bCount = slice.filter((o) => o.type !== 'removed').length;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) {
      const prefix = op.type === 'context' ? ' ' : op.type === 'added' ? '+' : '-';
      // Ensure the line doesn't already end with \n; add one if missing
      const text = op.text.endsWith('\n') ? op.text.slice(0, -1) : op.text;
      lines.push(`${prefix}${text}`);
    }
  }
  return lines.join('\n');
}

/**
 * Generate a unified diff string for a single file.
 * @param path  Relative path within the skill (used in headers).
 * @param aContent  "Old" content (store/reference); undefined means file is new (all added).
 * @param bContent  "New" content (disk); undefined means file was deleted (all removed).
 */
export function generateUnifiedDiff(
  path: string,
  aContent: Buffer | undefined,
  bContent: Buffer | undefined,
): string {
  const aLines = aContent ? aContent.toString('utf8').split('\n') : [];
  const bLines = bContent ? bContent.toString('utf8').split('\n') : [];

  // If the last "line" is empty (trailing newline), keep it for correct line counting
  // but don't emit a blank diff line for it.
  const header = [`--- a/${path}`, `+++ b/${path}`].join('\n');

  let hunkText: string;
  if (aContent === undefined) {
    // All lines added
    const ops: EditOp[] = bLines.map((text, i) => ({
      type: 'added' as const,
      lineA: -1,
      lineB: i + 1,
      text,
    }));
    hunkText = opsToHunks(ops);
  } else if (bContent === undefined) {
    // All lines removed
    const ops: EditOp[] = aLines.map((text, i) => ({
      type: 'removed' as const,
      lineA: i + 1,
      lineB: -1,
      text,
    }));
    hunkText = opsToHunks(ops);
  } else {
    hunkText = opsToHunks(diffLines(aLines, bLines));
  }

  if (!hunkText) return '';
  return `${header}\n${hunkText}`;
}

/**
 * Given a SkillDiff (which must be comparable) and the raw file maps, produce
 * a full unified diff string covering all changed files.
 */
export function buildUnifiedDiffText(
  diff: SkillDiff,
  diskFiles: Map<string, Buffer>,
  storeFiles: Map<string, Buffer>,
): string {
  const parts: string[] = [];
  for (const file of diff.files) {
    const diskContent = diskFiles.get(file.path);
    const storeContent = storeFiles.get(file.path);
    const patch = generateUnifiedDiff(file.path, storeContent, diskContent);
    if (patch) parts.push(patch);
  }
  return parts.join('\n');
}

function storeDirFor(home: string, agent: AgentType, name: string): string {
  return join(home, '.skill-switch', 'store', agent, name);
}

function diskDirFor(home: string, agent: AgentType, name: string): string | undefined {
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  if (!location) return undefined;
  return join(resolveGlobalSkillsDir(home, location), name);
}

/**
 * Compare two file maps (disk vs store) and return a sorted list of per-file
 * diffs. A file present only in `disk` is 'added'; present only in `store` is
 * 'removed'; present in both but with differing content is 'modified'.
 * Files with identical content are omitted.
 */
function compareFileMaps(
  disk: Map<string, Buffer>,
  store: Map<string, Buffer>,
): SkillFileDiff[] {
  const files: SkillFileDiff[] = [];

  for (const [path, diskContent] of disk) {
    const storeContent = store.get(path);
    if (storeContent === undefined) {
      files.push({ path, status: 'added' }); // 磁盘有、参照没有 = 新增
    } else if (!diskContent.equals(storeContent)) {
      files.push({ path, status: 'modified' });
    }
  }
  for (const path of store.keys()) {
    if (!disk.has(path)) files.push({ path, status: 'removed' }); // 参照有、磁盘没 = 删除
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** 递归列出目录下所有文件 → 相对路径 → 内容 Buffer。目录不存在则空。 */
async function listFiles(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!existsSync(dir)) return out;
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.set(relative(dir, full), await readFile(full));
      }
    }
  }
  await walk(dir);
  return out;
}

export interface SkillDiffWithContents {
  diff: SkillDiff;
  /** Raw file contents from disk (only populated when comparable=true). */
  diskFiles: Map<string, Buffer>;
  /** Raw file contents from store (only populated when comparable=true). */
  storeFiles: Map<string, Buffer>;
}

async function diffSkillCore(
  home: string,
  agent: AgentType,
  name: string,
): Promise<SkillDiffWithContents> {
  const diskDir = diskDirFor(home, agent, name);
  const storeDir = storeDirFor(home, agent, name);
  const base: SkillDiff = { agent, name, comparable: false, files: [] };
  const empty: SkillDiffWithContents = {
    diff: base,
    diskFiles: new Map(),
    storeFiles: new Map(),
  };

  if (!diskDir || !existsSync(diskDir)) {
    return { ...empty, diff: { ...base, reason: '磁盘上找不到该技能目录' } };
  }
  if (!existsSync(storeDir)) {
    return {
      ...empty,
      diff: { ...base, reason: '没有 store 参照(symlink 模式或非 copy 安装,无法逐行对比)' },
    };
  }

  const disk = await listFiles(diskDir);
  const store = await listFiles(storeDir);
  const files = compareFileMaps(disk, store);
  return {
    diff: { agent, name, comparable: true, diskDir, storeDir, files },
    diskFiles: disk,
    storeFiles: store,
  };
}

export async function diffSkill(home: string, agent: AgentType, name: string): Promise<SkillDiff> {
  return (await diffSkillCore(home, agent, name)).diff;
}

export async function diffSkillWithContents(
  home: string,
  agent: AgentType,
  name: string,
): Promise<SkillDiffWithContents> {
  return diffSkillCore(home, agent, name);
}
