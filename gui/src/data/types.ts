export interface SkillRecord {
  agents: string[];
  relSkillsDir: string;
  dirName: string;
  path: string;
  name?: string;
  description?: string;
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

export interface AuditReport {
  path: string;
  findings: AuditFinding[];
  score: number;
  verdict: AuditVerdict;
  name?: string;
  agents?: string[];
  relSkillsDir?: string;
  blocked?: boolean;
}

export interface DoctorFinding {
  kind: string;
  agent: string;
  name: string;
  target?: string;
  detail: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  clean: boolean;
  checked: {
    declared: number;
    locked: number;
  };
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

export interface DashboardData {
  scan: ScanReport;
  audit: AuditReport[];
  doctor: DoctorReport;
  stats: StatsReport;
  lockVerify: LockVerifyReport;
  source: 'fixtures' | 'tauri';
  loadedAt: string;
}
