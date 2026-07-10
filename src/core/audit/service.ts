import type { Dirent } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { allFileRules, allRules } from '../../../rules/index.ts';
import { SAFE_COPY_EXCLUDED_DIRECTORIES } from '../safe-copy.ts';
import { scanHome, type SkillRecord } from '../scan.ts';
import { fingerprintFinding } from './baseline.ts';
import { auditConfigFiles, flattenConfigFindings, type ConfigFileResult } from './config-discovery.ts';
import { analyzeCrossSkillCollusion } from './cross-skill.ts';
import { auditContents, type AuditReport, type AuditTarget } from './engine.ts';
import type { ResolvedPolicy } from './policy.ts';
import { DANGER_THRESHOLD } from './score.ts';
import type { AuditFinding, Severity } from './types.ts';

const BLOCKING_SEVERITIES = new Set(['critical', 'high']);
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TEXT_EXT = new Set([
  '.md', '.txt', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.rb', '.go', '.rs', '.java', '.php',
  '.json', '.toml', '.yaml', '.yml', '.cfg', '.conf', '.html', '.xml', '.env', '',
]);

const BINARY_ASSET_EXT = new Set([
  '.avif', '.bmp', '.eot', '.gif', '.ico', '.jpeg', '.jpg', '.mp3', '.mp4', '.otf', '.png',
  '.tif', '.tiff', '.ttf', '.webm', '.webp', '.woff', '.woff2',
]);

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_AUDIT_FILES = 1000;
export const MAX_AUDIT_WALK_DEPTH = 24;
const TEXT_SNIFF_BYTES = 8 * 1024;

function isScannableFile(name: string): boolean {
  if (name === '.env' || name.startsWith('.env.')) return true;
  return TEXT_EXT.has(extname(name).toLowerCase());
}

export interface AuditCoverage {
  visitedFiles: number;
  scannedFiles: number;
  scannedBytes: number;
  skippedFiles: number;
  skippedSymlinks: number;
  skippedExtensions: string[];
  tooLargeFiles: number;
  readErrors: number;
  complete: boolean;
  incompleteReasons: AuditIncompleteReason[];
  truncated: boolean;
  fileLimitReached: boolean;
  depthLimitReached: boolean;
  maxFiles: number;
  maxDepth: number;
  maxBytesPerFile: number;
}

export type AuditIncompleteReason =
  | 'depth-limit-reached'
  | 'excluded-directory'
  | 'file-limit-reached'
  | 'nested-symbolic-link'
  | 'oversized-text-file'
  | 'oversized-unclassified-file'
  | 'read-error'
  | 'unclassified-binary-file'
  | 'unclassified-executable-file'
  | 'unclassified-text-file'
  | 'unsupported-file-type';

type AuditDecisionReport = Pick<AuditReport, 'score' | 'findings'> & {
  coverage?: Pick<AuditCoverage, 'complete'>;
};

function hasIncompleteCoverage(report: AuditDecisionReport): boolean {
  return report.coverage?.complete === false;
}

export function shouldBlock(report: AuditDecisionReport): boolean {
  if (hasIncompleteCoverage(report)) return true;
  if (report.score < DANGER_THRESHOLD) return true;
  return report.findings.some((finding) => BLOCKING_SEVERITIES.has(finding.severity));
}

export function shouldBlockWithPolicy(
  report: AuditDecisionReport,
  policy: ResolvedPolicy,
  baselinedFingerprints: ReadonlySet<string> = new Set(),
): boolean {
  if (hasIncompleteCoverage(report)) return true;
  if (report.score < DANGER_THRESHOLD) return true;
  const failOnRank = SEVERITY_RANK[policy.failOn];
  return report.findings.some(
    (finding) =>
      !policy.suppressedRuleIds.has(finding.ruleId) &&
      !baselinedFingerprints.has(fingerprintFinding(finding)) &&
      SEVERITY_RANK[finding.severity] <= failOnRank,
  );
}

export function applyPolicyToFindings(
  findings: AuditFinding[],
  policy: ResolvedPolicy,
): Array<AuditFinding & { suppressed: boolean }> {
  return findings.map((finding) => ({
    ...finding,
    suppressed: policy.suppressedRuleIds.has(finding.ruleId),
  }));
}

export function applyBaselineToFindings(
  findings: AuditFinding[],
  baselinedFingerprints: ReadonlySet<string>,
): Array<AuditFinding & { baselined: boolean }> {
  return findings.map((finding) => ({
    ...finding,
    baselined: baselinedFingerprints.has(fingerprintFinding(finding)),
  }));
}

export function applyPolicyAndBaselineToFindings(
  findings: AuditFinding[],
  policy: ResolvedPolicy,
  baselinedFingerprints: ReadonlySet<string>,
): Array<AuditFinding & { suppressed: boolean; baselined: boolean }> {
  return findings.map((finding) => ({
    ...finding,
    suppressed: policy.suppressedRuleIds.has(finding.ruleId),
    baselined: baselinedFingerprints.has(fingerprintFinding(finding)),
  }));
}

export function shouldBlockWithAll(
  report: AuditDecisionReport,
  policy: ResolvedPolicy,
  baselinedFingerprints: ReadonlySet<string>,
  inlineSuppressedFindings: ReadonlySet<AuditFinding>,
): boolean {
  if (hasIncompleteCoverage(report)) return true;
  if (report.score < DANGER_THRESHOLD) return true;
  const failOnRank = SEVERITY_RANK[policy.failOn];
  return report.findings.some(
    (finding) =>
      !policy.suppressedRuleIds.has(finding.ruleId) &&
      !baselinedFingerprints.has(fingerprintFinding(finding)) &&
      !inlineSuppressedFindings.has(finding) &&
      SEVERITY_RANK[finding.severity] <= failOnRank,
  );
}

export function isPathIgnored(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchGlob(pattern, relPath));
}

function matchGlob(pattern: string, path: string): boolean {
  if (!pattern.includes('*') && (path === pattern || path.startsWith(`${pattern}/`))) {
    return true;
  }
  const doubleStarPlaceholder = '\u0001DSTAR\u0001';
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, doubleStarPlaceholder)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(doubleStarPlaceholder, 'g'), '.*');
  if (!pattern.includes('/') && new RegExp(`(?:^|/)${regexStr}$`).test(path)) return true;
  return new RegExp(`^${regexStr}$`).test(path);
}

async function collectTextFiles(
  root: string,
  ignorePatterns: readonly string[] = [],
): Promise<{ targets: AuditTarget[]; coverage: AuditCoverage }> {
  const targets: AuditTarget[] = [];
  const skippedExt = new Set<string>();
  const incompleteReasons = new Set<AuditIncompleteReason>();
  let scannedBytes = 0;
  let visitedFiles = 0;
  let skippedFiles = 0;
  let skippedSymlinks = 0;
  let tooLargeFiles = 0;
  let readErrors = 0;
  let fileLimitReached = false;
  let depthLimitReached = false;

  function recordReadError(): void {
    readErrors += 1;
    incompleteReasons.add('read-error');
  }

  function recordSkippedExtension(name: string): void {
    skippedFiles += 1;
    skippedExt.add(extname(name).toLowerCase() || '(none)');
  }

  function isProbablyText(content: Buffer): boolean {
    if (content.length === 0) return true;
    let suspicious = 0;
    for (const byte of content) {
      if (byte === 0) return false;
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) {
        suspicious += 1;
      }
    }
    if (suspicious / content.length > 0.05) return false;
    return !content.toString('utf8').includes('\uFFFD');
  }

  async function readPrefix(full: string, size: number): Promise<Buffer> {
    const handle = await open(full, 'r');
    try {
      const length = Math.min(size, TEXT_SNIFF_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async function readTarget(
    full: string,
    relPath: string,
    name: string,
    size: number,
    mode: number,
  ): Promise<void> {
    const executable = (mode & 0o111) !== 0;
    if (size > MAX_FILE_BYTES) {
      tooLargeFiles += 1;
      const extension = extname(name).toLowerCase();
      const textByName = isScannableFile(name);
      const knownBinaryAsset = BINARY_ASSET_EXT.has(extension);
      let textLike = textByName;
      if (knownBinaryAsset) {
        try {
          textLike = isProbablyText(await readPrefix(full, size));
        } catch {
          recordReadError();
          return;
        }
      }
      recordSkippedExtension(name);
      if (textLike) incompleteReasons.add('oversized-text-file');
      if (!textByName && !knownBinaryAsset) incompleteReasons.add('oversized-unclassified-file');
      if (executable && !textLike) incompleteReasons.add('unclassified-executable-file');
      return;
    }

    try {
      const content = await readFile(full);
      if (!isProbablyText(content)) {
        recordSkippedExtension(name);
        if (isScannableFile(name)) incompleteReasons.add('unclassified-text-file');
        if (!isScannableFile(name) && !BINARY_ASSET_EXT.has(extname(name).toLowerCase())) {
          incompleteReasons.add('unclassified-binary-file');
        }
        if (executable) incompleteReasons.add('unclassified-executable-file');
        return;
      }
      targets.push({ file: relPath, content: content.toString('utf8') });
      scannedBytes += size;
    } catch {
      recordReadError();
    }
  }

  let auditRoot = root;

  async function walk(dir: string, depth: number): Promise<void> {
    if (fileLimitReached) return;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      recordReadError();
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relPath = relative(auditRoot, full);
      if (entry.isFile()) {
        if (visitedFiles >= MAX_AUDIT_FILES) {
          fileLimitReached = true;
          incompleteReasons.add('file-limit-reached');
          return;
        }
        visitedFiles += 1;
      }
      if (ignorePatterns.length > 0 && isPathIgnored(relPath, ignorePatterns)) {
        skippedFiles += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (SAFE_COPY_EXCLUDED_DIRECTORIES.has(entry.name)) {
          skippedFiles += 1;
          if (entry.name === 'node_modules') incompleteReasons.add('excluded-directory');
          continue;
        }
        if (depth >= MAX_AUDIT_WALK_DEPTH) {
          depthLimitReached = true;
          incompleteReasons.add('depth-limit-reached');
          continue;
        }
        await walk(full, depth + 1);
        if (fileLimitReached) return;
      } else if (entry.isFile()) {
        try {
          const info = await lstat(full);
          if (!info.isFile()) {
            incompleteReasons.add('unsupported-file-type');
            skippedFiles += 1;
            continue;
          }
          await readTarget(full, relPath, entry.name, info.size, info.mode);
        } catch {
          recordReadError();
        }
      } else if (entry.isSymbolicLink()) {
        skippedFiles += 1;
        skippedSymlinks += 1;
        incompleteReasons.add('nested-symbolic-link');
      } else {
        skippedFiles += 1;
        incompleteReasons.add('unsupported-file-type');
      }
    }
  }

  const info = await lstat(root);
  let rootInfo = info;
  if (info.isSymbolicLink()) {
    auditRoot = await realpath(root);
    rootInfo = await stat(auditRoot);
  }
  if (rootInfo.isFile()) {
    visitedFiles = 1;
    await readTarget(
      auditRoot,
      relative(join(auditRoot, '..'), auditRoot),
      basename(auditRoot),
      rootInfo.size,
      rootInfo.mode,
    );
  } else if (rootInfo.isDirectory()) {
    await walk(auditRoot, 0);
  } else {
    skippedFiles += 1;
    incompleteReasons.add('unsupported-file-type');
  }

  return {
    targets,
    coverage: {
      visitedFiles,
      scannedFiles: targets.length,
      scannedBytes,
      skippedFiles,
      skippedSymlinks,
      skippedExtensions: [...skippedExt].sort(),
      tooLargeFiles,
      readErrors,
      complete: incompleteReasons.size === 0,
      incompleteReasons: [...incompleteReasons].sort(),
      truncated: fileLimitReached || depthLimitReached,
      fileLimitReached,
      depthLimitReached,
      maxFiles: MAX_AUDIT_FILES,
      maxDepth: MAX_AUDIT_WALK_DEPTH,
      maxBytesPerFile: MAX_FILE_BYTES,
    },
  };
}

export async function auditSkillDir(
  path: string,
  ignorePatterns: readonly string[] = [],
): Promise<AuditReport & { coverage: AuditCoverage }> {
  const { targets, coverage } = await collectTextFiles(path, ignorePatterns);
  return { ...auditContents(allRules, targets, allFileRules), coverage };
}

export async function auditSkillDirWithContents(
  path: string,
  ignorePatterns: readonly string[] = [],
): Promise<AuditReport & { coverage: AuditCoverage; fileContents: Map<string, string> }> {
  const { targets, coverage } = await collectTextFiles(path, ignorePatterns);
  const fileContents = new Map<string, string>(targets.map((target) => [target.file, target.content]));
  return { ...auditContents(allRules, targets, allFileRules), coverage, fileContents };
}

export interface AuditHomeSkillReport extends AuditReport {
  name: string;
  dirName: string;
  dir: string;
  path: string;
  agents: SkillRecord['agents'];
  relSkillsDir: string;
  blocked: boolean;
  coverage: AuditCoverage;
  fileContents?: Map<string, string>;
}

export interface AuditHomeReport {
  home: string;
  total: number;
  skills: AuditHomeSkillReport[];
  configs?: ConfigFileResult[];
  configsBlocked?: boolean;
  crossSkillFindings?: AuditFinding[];
}

export async function auditHome(
  home: string,
  options: { includeConfigs?: boolean } = {},
): Promise<AuditHomeReport> {
  const records = await scanHome(home);
  const uniqueRecords = new Map<string, SkillRecord>();
  for (const record of records) uniqueRecords.set(dirname(record.path), record);

  const skills: AuditHomeSkillReport[] = [];
  for (const [dir, record] of uniqueRecords) {
    const report = await auditSkillDirWithContents(dir);
    skills.push({
      ...report,
      name: record.name ?? record.dirName,
      dirName: record.dirName,
      dir,
      path: dir,
      agents: record.agents,
      relSkillsDir: record.relSkillsDir,
      blocked: shouldBlock(report),
      fileContents: report.fileContents,
    });
  }
  skills.sort((left, right) =>
    `${left.relSkillsDir}|${left.dirName}`.localeCompare(`${right.relSkillsDir}|${right.dirName}`),
  );

  const crossSkillFindings = analyzeCrossSkillCollusion(
    skills.map((skill) => ({
      skillId: skill.name,
      files: skill.fileContents
        ? [...skill.fileContents].map(([file, content]) => ({ file, content }))
        : [],
    })),
  );
  if (!options.includeConfigs) {
    return { home, total: skills.length, skills, crossSkillFindings };
  }

  const configs = await auditConfigFiles(home);
  const allConfigFindings = flattenConfigFindings(configs);
  const configsBlocked = allConfigFindings.some((finding) =>
    BLOCKING_SEVERITIES.has(finding.severity),
  );
  return { home, total: skills.length, skills, configs, configsBlocked, crossSkillFindings };
}
