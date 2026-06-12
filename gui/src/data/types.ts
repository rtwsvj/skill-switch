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

export interface DashboardData {
  scan: ScanReport;
  audit: AuditReport[];
  doctor: DoctorReport;
  stats: StatsReport;
  lockVerify: LockVerifyReport;
  source: 'fixtures' | 'tauri';
  loadedAt: string;
}
