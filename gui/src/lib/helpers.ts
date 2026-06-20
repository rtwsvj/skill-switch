import type { TFunction } from 'react-i18next';
import type {
  AuditReport,
  AuditSeverity,
  AuditVerdict,
  DashboardData,
  DoctorDeclaration,
  RestoreListResult,
  RestoreRunResult,
  SkillRecord,
  StatsReport,
  SyncRunResult,
} from '../data';
import type {
  ConfirmationDialogRequest,
  ConfirmationDialogState,
  Screen,
  SectionName,
  SectionStates,
} from './types';

export const initialSectionStates: SectionStates = {
  audit: { status: 'idle' },
  stats: { status: 'idle' },
};

export function sectionsForScreen(screen: Screen): SectionName[] {
  // overview 同时消费 audit(待办)与 stats(僵尸技能数),故两者都要;各 tab 只需各自的。
  if (screen === 'overview') return ['audit', 'stats'];
  if (screen === 'audit') return ['audit'];
  if (screen === 'stats') return ['stats'];
  return [];
}

export const advancedStorageKey = 'skill-switch-advanced';

export const screens: Array<{ id: Screen; labelKey: string }> = [
  { id: 'overview', labelKey: 'screens.overview' },
  { id: 'skills', labelKey: 'screens.skills' },
  { id: 'audit', labelKey: 'screens.audit' },
  { id: 'history', labelKey: 'screens.history' },
  { id: 'stats', labelKey: 'screens.stats' },
];

export function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function isNameMismatch(skill: SkillRecord) {
  return Boolean(skill.name && skill.name !== skill.dirName);
}

export function isBlockingAudit(report: AuditReport) {
  const findings = report.findings ?? [];
  return report.blocked ?? (report.score < 70 || findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high'));
}

export function displaySkillName(skill: SkillRecord) {
  return skill.name ?? skill.dirName;
}

export function actionSkillName(skill: SkillRecord) {
  return skill.dirName;
}

export function isSkillEnabled(skill: SkillRecord) {
  return skill.enabled ?? true;
}

function skillMatchesDeclaration(skill: SkillRecord, declaration: DoctorDeclaration) {
  return skill.dirName === declaration.name || skill.name === declaration.name;
}

function mergeAgents(first: string[], second: string[]) {
  return [...new Set([...first, ...second])];
}

function declarationToSkillRecord(declaration: DoctorDeclaration): SkillRecord {
  const source = declaration.source || '.skill-switch/skills.json';
  return {
    agents: [...declaration.agents],
    relSkillsDir: '.skill-switch/skills.json',
    dirName: declaration.name,
    dir: source,
    path: `${source}/SKILL.md`,
    name: declaration.name,
    enabled: declaration.enabled,
  };
}

export function mergeDeclaredSkills(data: DashboardData): DashboardData {
  const declarations = data.doctor.declarations ?? [];
  if (declarations.length === 0) return data;

  const skills = data.scan.skills.map((skill) => ({
    ...skill,
    agents: [...skill.agents],
  }));

  for (const declaration of declarations) {
    const index = skills.findIndex((skill) => skillMatchesDeclaration(skill, declaration));
    if (index >= 0) {
      const existing = skills[index]!;
      skills[index] = {
        ...existing,
        name: existing.name ?? declaration.name,
        agents: mergeAgents(existing.agents, declaration.agents),
        enabled: declaration.enabled,
      };
      continue;
    }
    skills.push(declarationToSkillRecord(declaration));
  }

  return {
    ...data,
    scan: {
      ...data.scan,
      total: skills.length,
      skills,
    },
  };
}

export function skillAgentKey(agent: string, name: string) {
  return `${agent}/${name}`;
}

// F-A3:磁盘上存在、但还没纳入声明(skills.json)管理的技能 —— 可一键「导入」(走 install-from-disk 收编)。
export function importableSkills(skills: SkillRecord[], declaredAgentPairs: Set<string>): SkillRecord[] {
  return skills.filter((skill) => {
    if (skill.error) return false; // 解析失败的先别收编
    const name = skill.dirName;
    return skill.agents.some((agent) => !declaredAgentPairs.has(skillAgentKey(agent, name)));
  });
}

// 写操作的 busy key(install/toggle/remove/sync-apply/restore-apply 等)在飞行中即为 true;
// 只读类(sync-dry-run / restore-list)不算,不阻塞。
export function isWriteBusy(busy: string | null): boolean {
  return busy !== null && busy !== 'sync-dry-run' && busy !== 'restore-list';
}

export function readStoredAdvanced() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(advancedStorageKey) === 'true';
}

// v0.3 A1:首启引导只显示到用户「知道了」为止(localStorage 记一次)。
export const onboardedStorageKey = 'skill-switch-onboarded';
export function readStoredOnboarded() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(onboardedStorageKey) === 'true';
}

const fallbackAgents = ['claude-code', 'codex', 'gemini-cli', 'cursor', 'copilot'];

export function agentOptions(data: DashboardData) {
  return [...new Set([...fallbackAgents, ...data.scan.skills.flatMap((skill) => skill.agents)])];
}

export function changedActionCount(result: SyncRunResult) {
  return result.actions.filter((action) => action.kind !== 'noop').length;
}

// F-A2:把一条 sync 动作翻成大白话(「新建 claude-code / foo」),用于确认框的「将发生什么」预览。
const SYNC_ACTION_KEY: Record<string, string> = {
  create: 'operations.preview.create',
  replace: 'operations.preview.replace',
  remove: 'operations.preview.remove',
  'config-disable': 'operations.preview.disable',
  'config-enable': 'operations.preview.enable',
};

export function syncActionLabel(action: { kind: string; agent: string; name: string }, t: TFunction): string {
  const key = SYNC_ACTION_KEY[action.kind] ?? 'operations.preview.other';
  return t(key, { target: `${action.agent} / ${action.name}` });
}

// v0.3 F1:把快照标签(pre-install-<agent> / pre-toggle-<name> / pre-sync …)翻成大白话操作记录,
// 让「历史」tab 读起来像操作日志。无法识别的标签原样返回。
export function describeSnapshotLabel(label: string, t: TFunction): string {
  const match = /^pre-(install|toggle|remove|sync|restore)(?:-(.+))?$/.exec(label);
  if (!match) return label;
  return t(`history.op.${match[1]}`, { detail: match[2] ?? '' });
}

// 审计覆盖透明度:把每个技能的扫描覆盖聚合成一行(共扫了多少文件、跳过多少、读失败、是否截断)。
export function auditCoverageSummary(reports: AuditReport[], t: TFunction): string {
  const covs = reports.map((report) => report.coverage).filter((c): c is NonNullable<typeof c> => Boolean(c));
  if (covs.length === 0) return '';
  const scanned = covs.reduce((sum, c) => sum + c.scannedFiles, 0);
  const skipped = covs.reduce((sum, c) => sum + c.skippedFiles + c.tooLargeFiles, 0);
  const readErrors = covs.reduce((sum, c) => sum + c.readErrors, 0);
  const truncated = covs.some((c) => c.truncated);
  if (scanned === 0 && skipped === 0 && !truncated) return '';
  return [
    t('safety.coverage.scanned', { count: scanned }),
    skipped > 0 ? t('safety.coverage.skipped', { count: skipped }) : null,
    readErrors > 0 ? t('safety.coverage.readErrors', { count: readErrors }) : null,
    truncated ? t('safety.coverage.truncated') : null,
  ].filter(Boolean).join(' · ');
}

// 覆盖透明度:统计扫描了多少聊天记录、跳过/解析失败多少、是否截断。建立对数字的信任。
export function coverageSummary(stats: StatsReport, t: TFunction): string {
  if (stats.scannedFiles === 0 && !stats.truncated) return '';
  return [
    t('stats.coverage.scanned', { count: stats.scannedFiles }),
    (stats.skippedFiles ?? 0) > 0 ? t('stats.coverage.skipped', { count: stats.skippedFiles }) : null,
    (stats.parseErrors ?? 0) > 0 ? t('stats.coverage.parseErrors', { count: stats.parseErrors }) : null,
    stats.truncated ? t('stats.coverage.truncated') : null,
  ].filter(Boolean).join(' · ');
}

export function snapshotPaths(
  result: Partial<{
    snapshotPath: string;
    snapshots: Array<{ path: string }>;
    safetySnapshot: { path: string };
  }>,
) {
  return [
    ...(result.snapshotPath ? [result.snapshotPath] : []),
    ...(result.snapshots ?? []).map((snapshot) => snapshot.path),
    ...(result.safetySnapshot ? [result.safetySnapshot.path] : []),
  ];
}

export function isRestoreList(data: RestoreListResult | RestoreRunResult): data is RestoreListResult {
  return 'snapshots' in data;
}

export function verdictLabel(verdict: AuditVerdict, t: TFunction) {
  return t(`audit.verdict.${verdict}`);
}

export function severityLabel(severity: AuditSeverity, t: TFunction) {
  return t(`audit.severity.${severity}`);
}

export function doctorKindLabel(kind: string, t: TFunction) {
  const known = new Set(['missing', 'content-drift', 'stale-lock', 'extra-locked']);
  return t(known.has(kind) ? `doctor.kind.${kind}` : 'doctor.kind.unknown');
}

// v0.3 D1:漂移严重度着色 —— 内容被改最危险(可能被篡改/上游覆盖),其余是「该同步了」的提醒。
export function driftTone(kind: string): 'warn' | 'danger' {
  return kind === 'content-drift' ? 'danger' : 'warn';
}

export function doctorHint(kind: string, t: TFunction): string {
  const known = new Set(['missing', 'content-drift', 'stale-lock', 'extra-locked']);
  return t(known.has(kind) ? `doctor.hint.${kind}` : 'doctor.kind.unknown');
}

export function createConfirmationDialogState(
  request: ConfirmationDialogRequest,
  close: () => void,
): ConfirmationDialogState {
  return {
    title: request.title,
    message: request.message,
    confirmLabel: request.confirmLabel,
    cancelLabel: request.cancelLabel,
    tone: request.tone ?? 'warn',
    ...(request.consequence ? { consequence: request.consequence } : {}),
    ...(request.details && request.details.length > 0 ? { details: request.details } : {}),
    onConfirm: async () => {
      close();
      await request.onConfirm();
    },
    onCancel: async () => {
      close();
    },
  };
}
