export interface SkillRecord {
  agents: string[];
  relSkillsDir: string;
  dirName: string;
  dir: string;
  path: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  error?: string;
}

export interface ScanReport {
  home: string;
  total: number;
  skills: SkillRecord[];
}

export type AuditVerdict = 'SAFE' | 'REVIEW' | 'DANGER';
export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AuditFinding {
  ruleId: string;
  severity: AuditSeverity;
  file: string;
  line: number;
  excerpt: string;
  message: string;
}

/** M0-5.7 审计覆盖透明度(用户关心的子集;可选——旧 CLI 输出可能没有)。 */
export interface AuditCoverage {
  scannedFiles: number;
  skippedFiles: number;
  tooLargeFiles: number;
  readErrors: number;
  truncated: boolean;
}

export interface AuditReport {
  path: string;
  findings: AuditFinding[];
  score: number;
  verdict: AuditVerdict;
  name?: string;
  agents?: string[];
  relSkillsDir?: string;
  blocked?: boolean;
  coverage?: AuditCoverage;
}

export interface DoctorFinding {
  kind: string;
  agent: string;
  name: string;
  target?: string;
  detail: string;
}

export interface DoctorDeclaration {
  name: string;
  source: string;
  agents: string[];
  enabled: boolean;
  mode: 'copy' | 'symlink';
  agentSources?: Record<string, { source: string; mode: 'copy' | 'symlink' }>;
}

export interface BypassRecord {
  name: string;
  agent: string;
  auditBypassed: true;
  bypassedAt: string;
  bypassReason?: string;
  score: number;
  bypassedFindings: Array<{ ruleId: string; severity: string }>;
  cliVersion: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  clean: boolean;
  checked: {
    declared: number;
    locked: number;
  };
  declarations: DoctorDeclaration[];
  /** M0-5.8:force 越过 audit 的留痕(可选——旧 CLI 输出可能没有)。 */
  bypasses?: BypassRecord[];
  /** M0-5.9:不符合规范命名的 legacy skill 名(迁移告警)。 */
  legacyNames?: string[];
}

export interface StatsUsage {
  skill: string;
  count: number;
  lastUsed?: string;
}

export interface StatsZombie {
  name: string;
  agents: string[];
  relSkillsDir: string;
}

export interface StatsReport {
  since?: string;
  scannedFiles: number;
  invocations: number;
  usage: StatsUsage[];
  zombies: StatsZombie[];
  /** M0-5.12 覆盖透明度(可选——旧 CLI 输出可能没有)。 */
  skippedFiles?: number;
  parseErrors?: number;
  truncated?: boolean;
}

export type LockVerifyStatus = 'ok' | 'missing' | 'mismatch' | 'unknown-agent';

export interface LockVerifyEntry {
  name: string;
  agent: string;
  target?: string;
  expectedSha256: string;
  actualSha256?: string;
  status: LockVerifyStatus;
}

export interface LockVerifyReport {
  ok: boolean;
  lockPath: string;
  entries: LockVerifyEntry[];
}

export type InstallMode = 'copy' | 'symlink';

export interface CliJsonResult<T> {
  data: T;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SnapshotView {
  id?: string;
  path: string;
  label: string;
  createdAt: string;
  sourceDir?: string;
}

export interface SyncAction {
  kind: 'create' | 'replace' | 'remove' | 'noop' | 'config-disable' | 'config-enable';
  agent: string;
  name: string;
  target: string;
  reason?: string;
}

export interface InstallRequest {
  source: string;
  agent: string;
  mode: InstallMode;
  skill?: string;
  ref?: string;
  force?: boolean;
  /** M0-5.8 / F-C2:force 越过审计时记录原因,经 `--force-reason` 写入 bypass-ledger。 */
  forceReason?: string;
}

export interface InstallRunResult {
  installed: Array<{ name: string; targetPath: string }>;
  blocked: Array<{ name: string; score: number; report: AuditReport }>;
  snapshotPath?: string;
  lockPath?: string;
  declarationPath?: string;
}

export interface ToggleRequest {
  name: string;
  enabled: boolean;
}

export interface ToggleRunResult {
  name: string;
  enabled: boolean;
  declarationPath: string;
  snapshots: SnapshotView[];
  actions: SyncAction[];
}

export interface SyncRequest {
  dryRun: boolean;
}

export interface SyncRunResult {
  declarationPath: string;
  dryRun: boolean;
  snapshots: SnapshotView[];
  actions: SyncAction[];
}

export interface RemoveRequest {
  name: string;
  agent: string;
}

export interface RemoveRunResult {
  name: string;
  agent: string;
  targetPath: string;
  lockPath: string;
  declarationPath: string;
  snapshots: SnapshotView[];
}

export interface RestoreRequest {
  id?: string;
  latest?: boolean;
}

export interface RestoreListResult {
  store: string;
  snapshots: SnapshotView[];
}

export interface RestoreRunResult {
  restored: true;
  target: string;
  snapshot: SnapshotView;
  safetySnapshot: SnapshotView;
}

/** One config file entry returned by `audit --configs --json`. */
export interface ConfigFileResult {
  absPath: string;
  relPath: string;
  findings: AuditFinding[];
}

/** Top-level shape of `audit --configs --json` output. */
export interface ConfigAuditReport {
  home: string;
  total: number;
  skills: AuditReport[];
  configs: ConfigFileResult[];
  configsBlocked: boolean;
}

export interface DashboardData {
  scan: ScanReport;
  audit: AuditReport[];
  doctor: DoctorReport;
  stats: StatsReport;
  lockVerify: LockVerifyReport;
  source: 'fixtures' | 'tauri';
  loadedAt: string;
  /** 某些区块加载失败时记录(section → 错误信息);整体仍可用安全默认值渲染,不白屏。 */
  loadErrors?: Record<string, string>;
}

// ── 「一键安装」(add)— 粘贴链接/指令 → 解析 → 审计 → 选装 ──────────────────────
/** 解析出的来源(镜像 src/core/add/types.ts 的 ParsedSource)。 */
export interface AddParsedSource {
  kind: string;
  raw: string;
  gitSource?: string;
  ref?: string;
  subdir?: string;
  npmPackage?: string;
  note?: string;
  provenanceWarning?: string;
}
/** 一个候选 skill(已审计)。 */
export interface AddSkillCandidate {
  name: string;
  relPath: string;
  verdict: AuditVerdict;
  score: number;
  blocked: boolean;
  findings: Array<{ ruleId: string; severity: string; message: string }>;
}
/** 解析+审计预览(不含写动作)。 */
export interface AddPreview {
  parsed: AddParsedSource;
  candidates: AddSkillCandidate[];
  error?: string;
}
/** `add --json` 的整体输出(预览或安装后)。 */
export interface AddCliResult {
  preview: AddPreview;
  installed: Array<{ name: string; targetPath: string }>;
  blocked?: Array<{ name: string; score: number }>;
  error?: string;
  note?: string;
}
/** GUI 发起安装选中 skill 的请求。 */
export interface AddInstallRequest {
  raw: string;
  skills: string[];
  agent: string;
  mode?: InstallMode;
  force?: boolean;
  forceReason?: string;
}
