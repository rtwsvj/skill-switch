import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation, type TFunction } from 'react-i18next';
import {
  loadAudit,
  loadCoreDashboard,
  loadStats,
  runInstall,
  runRemove,
  runRestore,
  runSync,
  runToggle,
  type AuditReport,
  type AuditSeverity,
  type AuditVerdict,
  type DashboardData,
  type DoctorDeclaration,
  type InstallMode,
  type InstallRunResult,
  type RestoreListResult,
  type RestoreRunResult,
  type SkillRecord,
  type StatsReport,
  type SyncRunResult,
} from './data';
import { languageLabels, supportedLanguages, type SupportedLanguage } from './i18n';

type Screen = 'overview' | 'skills' | 'audit' | 'history' | 'stats';

// M0-5.6 懒加载:audit/stats 这两个重区块(逐文件审计 / 解析 transcript)按需加载,
// 每个区块有独立状态机:idle 未触发 / loading 加载中 / loaded 成功 / error 失败。
type SectionName = 'audit' | 'stats';
type SectionStatus = 'idle' | 'loading' | 'loaded' | 'error';
interface SectionState {
  status: SectionStatus;
  loadedAt?: string;
  error?: string;
}
type SectionStates = Record<SectionName, SectionState>;
const initialSectionStates: SectionStates = {
  audit: { status: 'idle' },
  stats: { status: 'idle' },
};
function sectionsForScreen(screen: Screen): SectionName[] {
  // overview 同时消费 audit(待办)与 stats(僵尸技能数),故两者都要;各 tab 只需各自的。
  if (screen === 'overview') return ['audit', 'stats'];
  if (screen === 'audit') return ['audit'];
  if (screen === 'stats') return ['stats'];
  return [];
}
const advancedStorageKey = 'skill-switch-advanced';

const screens: Array<{ id: Screen; labelKey: string }> = [
  { id: 'overview', labelKey: 'screens.overview' },
  { id: 'skills', labelKey: 'screens.skills' },
  { id: 'audit', labelKey: 'screens.audit' },
  { id: 'history', labelKey: 'screens.history' },
  { id: 'stats', labelKey: 'screens.stats' },
];

function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function isNameMismatch(skill: SkillRecord) {
  return Boolean(skill.name && skill.name !== skill.dirName);
}

function isBlockingAudit(report: AuditReport) {
  const findings = report.findings ?? [];
  return report.blocked ?? (report.score < 70 || findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high'));
}

function displaySkillName(skill: SkillRecord) {
  return skill.name ?? skill.dirName;
}

function actionSkillName(skill: SkillRecord) {
  return skill.dirName;
}

function isSkillEnabled(skill: SkillRecord) {
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

function skillAgentKey(agent: string, name: string) {
  return `${agent}/${name}`;
}

// 写操作的 busy key(install/toggle/remove/sync-apply/restore-apply 等)在飞行中即为 true;
// 只读类(sync-dry-run / restore-list)不算,不阻塞。
function isWriteBusy(busy: string | null): boolean {
  return busy !== null && busy !== 'sync-dry-run' && busy !== 'restore-list';
}

function readStoredAdvanced() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(advancedStorageKey) === 'true';
}

const fallbackAgents = ['claude-code', 'codex', 'gemini-cli', 'cursor', 'copilot'];

function agentOptions(data: DashboardData) {
  return [...new Set([...fallbackAgents, ...data.scan.skills.flatMap((skill) => skill.agents)])];
}

function changedActionCount(result: SyncRunResult) {
  return result.actions.filter((action) => action.kind !== 'noop').length;
}

function snapshotPaths(
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

function isRestoreList(data: RestoreListResult | RestoreRunResult): data is RestoreListResult {
  return 'snapshots' in data;
}

function verdictLabel(verdict: AuditVerdict, t: TFunction) {
  return t(`audit.verdict.${verdict}`);
}

function severityLabel(severity: AuditSeverity, t: TFunction) {
  return t(`audit.severity.${severity}`);
}

function doctorKindLabel(kind: string, t: TFunction) {
  const known = new Set(['missing', 'content-drift', 'stale-lock', 'extra-locked']);
  return t(known.has(kind) ? `doctor.kind.${kind}` : 'doctor.kind.unknown');
}

function Metric({ value, label, tone = 'neutral' }: { value: number | string; label: string; tone?: 'neutral' | 'good' | 'danger' }) {
  return (
    <div className={cx('metric', tone === 'danger' && 'metric-danger', tone === 'good' && 'metric-good')}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'danger' }) {
  return <span className={cx('pill', `pill-${tone}`)}>{children}</span>;
}

// M0-5.6:某懒加载区块(audit/stats)的状态条 —— 加载中/失败/上次刷新时间 + 刷新按钮。
function SectionStatusBar({ section, onReload }: { section: SectionState; onReload: () => void }) {
  const { t } = useTranslation();
  const time = section.loadedAt
    ? new Date(section.loadedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '';
  return (
    <div className="section-status">
      {section.status === 'loading' ? <StatusPill tone="warn">{t('section.loading')}</StatusPill> : null}
      {section.status === 'error' ? <StatusPill tone="danger">{t('section.failed')}</StatusPill> : null}
      {section.status === 'loaded' ? <span className="muted">{t('section.lastRefreshed', { time })}</span> : null}
      {section.status === 'idle' ? <span className="muted">{t('section.notLoaded')}</span> : null}
      <button type="button" className="ghost-button" onClick={onReload} disabled={section.status === 'loading'}>
        {section.status === 'error' ? t('section.retry') : t('section.refresh')}
      </button>
    </div>
  );
}

interface OperationNotice {
  tone: 'good' | 'warn' | 'danger';
  title: string;
  detail?: string;
  snapshots?: string[];
}

function OperationBanner({ notice }: { notice: OperationNotice | null }) {
  const { t } = useTranslation();
  if (!notice) return null;
  return (
    <section className={cx('operation-banner', `operation-banner-${notice.tone}`)}>
      <div>
        <strong>{notice.title}</strong>
        {notice.detail ? <p>{notice.detail}</p> : null}
      </div>
      {notice.snapshots && notice.snapshots.length > 0 ? (
        <ul>
          {notice.snapshots.map((path) => (
            <li key={path}>
              <span>{t('operations.snapshot')}</span>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface ConfirmationDialogRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: 'warn' | 'danger';
  /** F-B2:大白话后果/安心提示(如「已自动备份,可在『历史』还原」),直击 P6 怕翻车。 */
  consequence?: string;
  onConfirm: () => void | Promise<void>;
}

interface WriteConfirmationRequest {
  message: string;
  tone?: 'warn' | 'danger';
  consequence?: string;
  onConfirm: () => void | Promise<void>;
}

export interface ConfirmationDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: 'warn' | 'danger';
  consequence?: string;
  onConfirm: () => Promise<void>;
  onCancel: () => Promise<void>;
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
    onConfirm: async () => {
      close();
      await request.onConfirm();
    },
    onCancel: async () => {
      close();
    },
  };
}

function ConfirmationDialog({ confirmation }: { confirmation: ConfirmationDialogState | null }) {
  const titleId = useId();
  const messageId = useId();
  if (!confirmation) return null;

  return (
    <div className="dialog-backdrop">
      <section
        className={cx('confirm-dialog', confirmation.tone === 'danger' && 'confirm-dialog-danger')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <h2 id={titleId}>{confirmation.title}</h2>
        <p id={messageId}>{confirmation.message}</p>
        {confirmation.consequence ? (
          <p className={cx('dialog-consequence', confirmation.tone === 'danger' && 'dialog-consequence-danger')}>
            {confirmation.consequence}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={() => void confirmation.onCancel()}>
            {confirmation.cancelLabel}
          </button>
          <button
            className={confirmation.tone === 'danger' ? 'danger-action' : 'primary-action'}
            type="button"
            onClick={() => void confirmation.onConfirm()}
            autoFocus
          >
            {confirmation.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const activeLanguage = supportedLanguages.includes(i18n.resolvedLanguage as SupportedLanguage) ? (i18n.resolvedLanguage as SupportedLanguage) : 'en';

  return (
    <label className="language-switcher">
      <span>{t('header.languageLabel')}</span>
      <select
        aria-label={t('header.languageLabel')}
        value={activeLanguage}
        onChange={(event) => {
          const language = event.target.value as SupportedLanguage;
          window.localStorage.setItem('skill-switch-language', language);
          void i18n.changeLanguage(language);
        }}
      >
        {supportedLanguages.map((language) => (
          <option key={language} value={language}>
            {languageLabels[language]}
          </option>
        ))}
      </select>
    </label>
  );
}

function Header({
  data,
  advanced,
  onAdvancedChange,
}: {
  data: DashboardData;
  advanced: boolean;
  onAdvancedChange: (enabled: boolean) => void;
}) {
  const { t, i18n } = useTranslation();

  return (
    <header className="header">
      <div>
        <p className="eyebrow">skill-switch</p>
        <h1>{t('header.title')}</h1>
      </div>
      <div className="header-meta">
        <StatusPill tone={data.source === 'fixtures' ? 'warn' : 'good'}>{data.source === 'fixtures' ? t('header.source.fixtures') : t('header.source.live')}</StatusPill>
        {advanced ? <span>{new Date(data.loadedAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</span> : null}
        <LanguageSwitcher />
        <label className="advanced-toggle">
          <input
            type="checkbox"
            checked={advanced}
            onChange={(event) => onAdvancedChange(event.target.checked)}
          />
          <span>{t('header.advanced')}</span>
        </label>
      </div>
    </header>
  );
}

interface InstallDraft {
  source: string;
  agent: string;
  mode: InstallMode;
  skill: string;
  ref: string;
  force: boolean;
}

interface WriteOperationsProps {
  data: DashboardData;
  busy: string | null;
  installDraft: InstallDraft;
  installResult: InstallRunResult | null;
  syncPlan: SyncRunResult | null;
  restoreList: RestoreListResult | null;
  onInstallDraftChange: (draft: InstallDraft) => void;
  onInstall: () => void;
  onSyncDryRun: () => void;
  onSyncApply: () => void;
  onLoadSnapshots: () => void;
  onRestore: (id: string) => void;
  blockedReason: string;
  onBlockedReasonChange: (value: string) => void;
  onForceInstall: () => void;
}

function WriteOperations({
  data,
  busy,
  installDraft,
  installResult,
  syncPlan,
  restoreList,
  onInstallDraftChange,
  onInstall,
  onSyncDryRun,
  onSyncApply,
  onLoadSnapshots,
  onRestore,
  blockedReason,
  onBlockedReasonChange,
  onForceInstall,
}: WriteOperationsProps) {
  const { t } = useTranslation();
  const agents = agentOptions(data);
  const syncChanges = syncPlan ? changedActionCount(syncPlan) : 0;
  // M0-A2:任一写操作在飞行中 → 禁用全部写控件,防 skills.json/lock 读改写竞争。
  const writeBusy = isWriteBusy(busy);

  return (
    <section className="panel write-panel">
      <div className="panel-title">
        <h2>{t('operations.title')}</h2>
        <StatusPill tone="warn">{t('operations.writeEnabled')}</StatusPill>
      </div>
      <div className="write-grid">
        <form
          className="operation-form"
          onSubmit={(event) => {
            event.preventDefault();
            onInstall();
          }}
        >
          <h3>{t('operations.install.title')}</h3>
          <p className="form-help">{t('operations.install.help')}</p>
          <label>
            <span>{t('operations.install.source')}</span>
            <input
              value={installDraft.source}
              onChange={(event) => onInstallDraftChange({ ...installDraft, source: event.target.value })}
              placeholder={t('operations.install.sourcePlaceholder')}
            />
          </label>
          <div className="form-row">
            <label>
              <span>{t('operations.install.agent')}</span>
              <select
                value={installDraft.agent}
                onChange={(event) => onInstallDraftChange({ ...installDraft, agent: event.target.value })}
              >
                {agents.map((agent) => (
                  <option key={agent} value={agent}>
                    {agent}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('operations.install.mode')}</span>
              <select
                value={installDraft.mode}
                onChange={(event) => onInstallDraftChange({ ...installDraft, mode: event.target.value as InstallMode })}
              >
                <option value="copy">{t('operations.install.copy')}</option>
                <option value="symlink">{t('operations.install.symlink')}</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              <span>{t('operations.install.skill')}</span>
              <input
                value={installDraft.skill}
                onChange={(event) => onInstallDraftChange({ ...installDraft, skill: event.target.value })}
              />
            </label>
            <label>
              <span>{t('operations.install.ref')}</span>
              <input
                value={installDraft.ref}
                onChange={(event) => onInstallDraftChange({ ...installDraft, ref: event.target.value })}
              />
            </label>
          </div>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={installDraft.force}
              onChange={(event) => onInstallDraftChange({ ...installDraft, force: event.target.checked })}
            />
            <span>{t('operations.install.force')}</span>
          </label>
          <button className="primary-action" type="submit" disabled={busy === 'install' || writeBusy}>
            {busy === 'install' ? t('operations.busy') : t('operations.install.submit')}
          </button>
          {installResult?.blocked.length ? (
            <div className="blocked-list">
              <strong>{t('operations.install.blocked')}</strong>
              <p className="muted">{t('operations.install.blockedWhy')}</p>
              {installResult.blocked.map((blocked) => (
                <div className="blocked-item" key={blocked.name}>
                  <div className="blocked-head">
                    <strong>{blocked.name}</strong>
                    <StatusPill tone="danger">{t('operations.install.blockedScore', { score: blocked.score })}</StatusPill>
                  </div>
                  {(blocked.report.findings ?? []).length > 0 ? (
                    <ul className="finding-list">
                      {(blocked.report.findings ?? []).slice(0, 4).map((finding) => (
                        <li key={`${finding.ruleId}-${finding.line}`}>
                          <span className={cx('severity-dot', `severity-${finding.severity}`)} />
                          <span>{finding.ruleId}</span>
                          <strong>{severityLabel(finding.severity, t)}</strong>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
              <label className="field force-reason-field">
                <span>{t('operations.install.forceReasonLabel')}</span>
                <input
                  type="text"
                  value={blockedReason}
                  placeholder={t('operations.install.forceReasonPlaceholder')}
                  onChange={(event) => onBlockedReasonChange(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="danger-action"
                onClick={onForceInstall}
                disabled={!blockedReason.trim() || busy === 'install' || writeBusy}
              >
                {t('operations.install.forceAnyway')}
              </button>
            </div>
          ) : null}
        </form>

        <div className="operation-form">
          <h3>{t('operations.sync.title')}</h3>
          <p className="form-help">{t('operations.sync.help')}</p>
          <div className="button-row">
            <button type="button" onClick={onSyncDryRun} disabled={busy === 'sync-dry-run' || writeBusy}>
              {busy === 'sync-dry-run' ? t('operations.busy') : t('operations.sync.dryRun')}
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={onSyncApply}
              disabled={!syncPlan || busy === 'sync-apply' || writeBusy}
            >
              {busy === 'sync-apply' ? t('operations.busy') : t('operations.sync.apply')}
            </button>
          </div>
          {syncPlan ? (
            <div className="plan-list">
              <strong>{t('operations.sync.planCount', { changed: syncChanges, total: syncPlan.actions.length })}</strong>
              {syncPlan.actions.slice(0, 6).map((action) => (
                <p key={`${action.kind}-${action.agent}-${action.name}-${action.target}`}>
                  <span>{`[${action.kind}]`}</span>
                  {` ${action.agent}/${action.name}`}
                </p>
              ))}
            </div>
          ) : null}
        </div>

        <div className="operation-form">
          <h3>{t('operations.restore.title')}</h3>
          <p className="form-help">{t('operations.restore.help')}</p>
          <button type="button" onClick={onLoadSnapshots} disabled={busy === 'restore-list' || writeBusy}>
            {busy === 'restore-list' ? t('operations.busy') : t('operations.restore.load')}
          </button>
          <div className="snapshot-list">
            {restoreList?.snapshots.length ? (
              restoreList.snapshots.map((snapshot) => (
                <div key={snapshot.id ?? snapshot.path} className="snapshot-row">
                  <div>
                    <strong>{snapshot.label}</strong>
                    <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
                  </div>
                  <button type="button" onClick={() => onRestore(snapshot.id ?? '')} disabled={!snapshot.id || busy === 'restore-apply' || writeBusy}>
                    {t('operations.restore.submit')}
                  </button>
                </div>
              ))
            ) : (
              <p className="empty">{t('operations.restore.empty')}</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Overview({
  data,
  operations,
  advanced,
  sections,
}: {
  data: DashboardData;
  operations: WriteOperationsProps;
  advanced: boolean;
  sections: SectionStates;
}) {
  const { t } = useTranslation();
  const agents = new Set(data.scan.skills.flatMap((skill) => skill.agents));
  const broken = data.scan.skills.filter((skill) => skill.error || isNameMismatch(skill));
  const statsReady = sections.stats.status === 'loaded';
  const auditReady = sections.audit.status === 'loaded';
  // 懒加载未完成时,审计待办还不可知:用占位提示,避免显示一个尚未算出的「0」误导用户。
  const blocking = auditReady ? data.audit.filter(isBlockingAudit) : [];
  const doctorValue = data.doctor.clean
    ? t('overview.metrics.doctorOk')
    : t('overview.metrics.doctorIssues', { count: data.doctor.findings.length });
  const zombieCount = data.stats.zombies.length;
  const attentionPending = (!auditReady || !statsReady);

  return (
    <section className="screen">
      <div className="metric-grid">
        <Metric value={agents.size} label={t('overview.metrics.agents')} tone="good" />
        <Metric value={data.scan.total} label={t('overview.metrics.skills')} />
        <Metric
          value={statsReady ? zombieCount : '…'}
          label={t('overview.metrics.zombies')}
          tone={statsReady ? (zombieCount > 0 ? 'danger' : 'good') : 'neutral'}
        />
        <Metric value={doctorValue} label={t('overview.metrics.doctor')} tone={data.doctor.clean ? 'good' : 'danger'} />
      </div>

      {advanced ? <div className="overview-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>{t('overview.controlSurface.title')}</h2>
            <StatusPill tone="warn">{t('overview.controlSurface.safeMode')}</StatusPill>
          </div>
          <div className="command-strip">
            <span>scan --json</span>
            <span>audit --json</span>
            <span>doctor --json</span>
            <span>stats --json</span>
            <span>lock --verify --json</span>
            <span>install --json</span>
            <span>toggle --json</span>
            <span>sync --json</span>
            <span>remove --json</span>
            <span>restore --json</span>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>{t('doctor.title')}</h2>
            <StatusPill tone={data.doctor.clean ? 'good' : 'danger'}>{data.doctor.clean ? t('status.clean') : t('status.drift')}</StatusPill>
          </div>
          <dl className="definition-grid">
            <div>
              <dt>{t('doctor.checked.declared')}</dt>
              <dd>{data.doctor.checked.declared}</dd>
            </div>
            <div>
              <dt>{t('doctor.checked.locked')}</dt>
              <dd>{data.doctor.checked.locked}</dd>
            </div>
            <div>
              <dt>{t('doctor.checked.lockVerify')}</dt>
              <dd>{data.lockVerify.ok ? t('status.ok') : t('status.failed')}</dd>
            </div>
          </dl>
          {data.doctor.clean ? null : (
            <ul className="doctor-list">
              {data.doctor.findings.slice(0, 4).map((finding) => (
                <li key={`${finding.kind}-${finding.agent}-${finding.name}`}>
                  <strong>{doctorKindLabel(finding.kind, t)}</strong>
                  <span>{`${finding.agent}/${finding.name}`}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div> : null}

      <WriteOperations {...operations} />

      <section className="panel">
        <div className="panel-title">
          <h2>{t('overview.attention.title')}</h2>
          <span>{t('overview.attention.itemCount', { count: broken.length + blocking.length })}</span>
        </div>
        <div className="attention-list">
          {broken.map((skill) => (
            <div className="attention-row" key={`${skill.relSkillsDir}/${skill.dirName}`}>
              <span>{skill.dirName}</span>
              <StatusPill tone={skill.error ? 'danger' : 'warn'}>{skill.error ? t('status.badFrontmatter') : t('status.nameMismatch')}</StatusPill>
            </div>
          ))}
          {blocking.map((report) => (
            <div className="attention-row" key={report.path}>
              <span>{report.name ?? report.path.split('/').at(-1)}</span>
              <StatusPill tone="danger">{t('status.auditBlocks')}</StatusPill>
            </div>
          ))}
          {attentionPending ? (
            <div className="attention-row">
              <span className="muted">{!auditReady ? t('section.auditPending') : t('section.statsPending')}</span>
              <StatusPill tone="warn">{t('section.loading')}</StatusPill>
            </div>
          ) : null}
          {!attentionPending && broken.length + blocking.length === 0 ? <p className="empty">{t('overview.attention.empty')}</p> : null}
        </div>
      </section>
    </section>
  );
}

interface SkillActionsProps {
  busy: string | null;
  onToggle: (skill: SkillRecord, enabled: boolean) => void;
  onRemove: (skill: SkillRecord) => void;
}

function Skills({ data, actions }: { data: DashboardData; actions: SkillActionsProps }) {
  const { t } = useTranslation();
  const writeBusy = isWriteBusy(actions.busy);

  return (
    <section className="screen">
      <section className="guide-panel">
        {t('skills.guide')}
      </section>
      <section className="panel table-panel">
        <div className="panel-title">
          <h2>{t('skills.title')}</h2>
          <span>{t('skills.recordCount', { count: data.scan.total })}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('skills.columns.directory')}</th>
                <th>{t('skills.columns.name')}</th>
                <th>{t('skills.columns.agents')}</th>
                <th>{t('skills.columns.location')}</th>
                <th>{t('skills.columns.status')}</th>
                <th>{t('skills.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.scan.skills.map((skill) => {
                const mismatch = isNameMismatch(skill);
                const hasError = Boolean(skill.error);
                const name = actionSkillName(skill);
                const enabled = isSkillEnabled(skill);
                return (
                  <tr className={cx((mismatch || hasError) && 'row-alert')} key={`${skill.relSkillsDir}/${skill.dirName}`}>
                    <td className="mono">{skill.dirName}</td>
                    <td>{skill.name ?? '-'}</td>
                    <td>
                      <div className="agent-list">
                        {skill.agents.map((agent) => (
                          <span key={agent}>{agent}</span>
                        ))}
                      </div>
                    </td>
                    <td className="muted">{skill.relSkillsDir}</td>
                    <td>
                      <div className="status-stack">
                        <StatusPill tone={enabled ? 'good' : 'warn'}>{enabled ? t('status.enabled') : t('status.disabledKept')}</StatusPill>
                        {hasError ? <StatusPill tone="danger">{t('status.parseError')}</StatusPill> : null}
                        {mismatch ? <StatusPill tone="warn">{t('status.nameMismatch')}</StatusPill> : null}
                      </div>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className={enabled ? undefined : 'primary-action'}
                          onClick={() => actions.onToggle(skill, !enabled)}
                          disabled={actions.busy === `toggle-${name}` || writeBusy}
                          title={enabled ? t('skills.actions.disableHint') : undefined}
                        >
                          {enabled ? t('skills.actions.disable') : t('skills.actions.enable')}
                        </button>
                        <button
                          type="button"
                          className="danger-action"
                          onClick={() => actions.onRemove(skill)}
                          disabled={actions.busy === `remove-${name}` || writeBusy}
                          title={t('skills.actions.deleteHint')}
                        >
                          {t('skills.actions.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function Audit({ data, section, onReload }: { data: DashboardData; section: SectionState; onReload: () => void }) {
  const { t } = useTranslation();
  const sorted = [...data.audit].sort((a, b) => Number(isBlockingAudit(b)) - Number(isBlockingAudit(a)) || a.score - b.score);
  const loadingFirstTime = section.status === 'loading' && data.audit.length === 0;
  // F-C1 安全中心:摘要 + bypass 留痕。
  const blockedCount = data.audit.filter(isBlockingAudit).length;
  const reviewCount = data.audit.filter((r) => !isBlockingAudit(r) && r.verdict === 'REVIEW').length;
  const safeCount = Math.max(0, data.audit.length - blockedCount - reviewCount);
  const bypasses = data.doctor.bypasses ?? [];

  return (
    <section className="screen">
      <div className="section-toolbar">
        <h2>{t('screens.audit')}</h2>
        <SectionStatusBar section={section} onReload={onReload} />
      </div>
      {section.status === 'error' ? <p className="section-error">{section.error}</p> : null}
      {loadingFirstTime ? <p className="empty">{t('section.loading')}</p> : null}
      {data.audit.length > 0 ? (
        <div className="metric-grid compact">
          <Metric value={safeCount} label={t('safety.summary.safe')} tone={safeCount > 0 ? 'good' : 'neutral'} />
          <Metric value={reviewCount} label={t('safety.summary.review')} tone={reviewCount > 0 ? 'danger' : 'neutral'} />
          <Metric value={blockedCount} label={t('safety.summary.blocked')} tone={blockedCount > 0 ? 'danger' : 'good'} />
        </div>
      ) : null}

      {bypasses.length > 0 ? (
        <section className="panel bypass-panel">
          <div className="panel-title">
            <h2>{t('safety.bypass.title')}</h2>
            <StatusPill tone="danger">{t('safety.bypass.badge')}</StatusPill>
          </div>
          <p className="muted">{t('safety.bypass.subtitle')}</p>
          <div className="bypass-list">
            {bypasses.map((b) => (
              <article className="bypass-row" key={`${b.agent}/${b.name}/${b.bypassedAt}`}>
                <div className="bypass-main">
                  <strong>{b.name}</strong>
                  <span className="muted">{b.agent} · {new Date(b.bypassedAt).toLocaleString()}</span>
                  <span>{b.bypassReason ? t('safety.bypass.reason', { reason: b.bypassReason }) : t('safety.bypass.noReason')}</span>
                </div>
                <div className="bypass-meta">
                  <StatusPill tone="warn">{t('safety.bypass.score', { score: b.score })}</StatusPill>
                  <span className="muted">{t('safety.bypass.findings', { count: b.bypassedFindings.length })}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <div className="audit-grid">
        {sorted.map((report) => {
          const blocking = isBlockingAudit(report);
          const findings = report.findings ?? [];
          return (
            <article className={cx('audit-card', blocking && 'audit-card-danger')} key={report.path}>
              <div className="audit-head">
                <div>
                  <h2>{report.name ?? report.path.split('/').at(-1)}</h2>
                  <p>{report.relSkillsDir ?? report.path}</p>
                </div>
                <div className="score-dial">{report.score}</div>
              </div>
              <div className="audit-meta">
                <StatusPill tone={report.verdict === 'DANGER' ? 'danger' : report.verdict === 'REVIEW' ? 'warn' : 'good'}>{verdictLabel(report.verdict, t)}</StatusPill>
                {blocking ? <StatusPill tone="danger">{t('status.blockable')}</StatusPill> : <StatusPill tone="good">{t('status.pass')}</StatusPill>}
                <span>{t('audit.findingCount', { count: findings.length })}</span>
              </div>
              {findings.length > 0 ? (
                <ul className="finding-list">
                  {findings.slice(0, 3).map((finding) => (
                    <li key={`${finding.ruleId}-${finding.line}`}>
                      <span className={cx('severity-dot', `severity-${finding.severity}`)} />
                      <span>{finding.ruleId}</span>
                      <strong>{severityLabel(finding.severity, t)}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">{t('audit.noRules')}</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Stats({ data, section, onReload }: { data: DashboardData; section: SectionState; onReload: () => void }) {
  const { t } = useTranslation();
  const zombieNames = useMemo(() => new Set(data.stats.zombies.map((zombie) => zombie.name)), [data.stats.zombies]);
  const loadingFirstTime = section.status === 'loading' && section.loadedAt === undefined;

  return (
    <section className="screen">
      <div className="section-toolbar">
        <h2>{t('screens.stats')}</h2>
        <SectionStatusBar section={section} onReload={onReload} />
      </div>
      {section.status === 'error' ? <p className="section-error">{section.error}</p> : null}
      {loadingFirstTime ? <p className="empty">{t('section.loading')}</p> : null}
      <div className="metric-grid compact">
        <Metric value={data.stats.scannedFiles} label={t('stats.metrics.transcripts')} />
        <Metric value={data.stats.invocations} label={t('stats.metrics.invocations')} />
        <Metric value={data.stats.usage.length} label={t('stats.metrics.active')} tone={data.stats.usage.length > 0 ? 'good' : 'neutral'} />
        <Metric value={data.stats.zombies.length} label={t('stats.metrics.zeroUse')} tone={data.stats.zombies.length > 0 ? 'danger' : 'good'} />
      </div>
      <section className="panel table-panel">
        <div className="panel-title">
          <h2>{t('stats.zombieTitle')}</h2>
          <span>{data.stats.since ? t('stats.since', { date: data.stats.since.slice(0, 10) }) : t('stats.allTime')}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('stats.columns.skill')}</th>
                <th>{t('stats.columns.agents')}</th>
                <th>{t('stats.columns.location')}</th>
                <th>{t('stats.columns.state')}</th>
              </tr>
            </thead>
            <tbody>
              {data.scan.skills.map((skill) => {
                const name = displaySkillName(skill);
                const zombie = zombieNames.has(name);
                return (
                  <tr key={`${skill.relSkillsDir}/${skill.dirName}`}>
                    <td className="mono">{name}</td>
                    <td>
                      <div className="agent-list">
                        {skill.agents.map((agent) => (
                          <span key={agent}>{agent}</span>
                        ))}
                      </div>
                    </td>
                    <td className="muted">{skill.relSkillsDir}</td>
                    <td>{zombie ? <StatusPill tone="danger">{t('status.zombie')}</StatusPill> : <StatusPill tone="good">{t('status.used')}</StatusPill>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

// F-B1:撤销/历史中心 —— 把自动备份做成可视时间线 + 一键还原。招牌「后悔药」体验。
// 纯展示 + 回调,便于直接测试;加载触发在 DashboardShell(进 tab 时拉一次)。
export function History({
  restoreList,
  busy,
  loaded,
  onReload,
  onRestore,
}: {
  restoreList: RestoreListResult | null;
  busy: string | null;
  loaded: boolean;
  onReload: () => void;
  onRestore: (id: string) => void;
}) {
  const { t } = useTranslation();
  const loading = busy === 'restore-list';
  const restoring = busy === 'restore-apply';
  const snapshots = restoreList?.snapshots ?? [];

  return (
    <section className="screen">
      <div className="section-toolbar">
        <h2>{t('screens.history')}</h2>
        <div className="section-status">
          {loading ? <StatusPill tone="warn">{t('section.loading')}</StatusPill> : null}
          {loaded && !loading ? <span className="muted">{t('history.count', { count: snapshots.length })}</span> : null}
          <button type="button" className="ghost-button" onClick={onReload} disabled={loading || restoring}>
            {t('section.refresh')}
          </button>
        </div>
      </div>
      <section className="guide-panel">{t('history.guide')}</section>
      {loading && snapshots.length === 0 ? <p className="empty">{t('section.loading')}</p> : null}
      {loaded && !loading && snapshots.length === 0 ? <p className="empty">{t('history.empty')}</p> : null}
      <div className="snapshot-timeline">
        {snapshots.map((snapshot) => (
          <article className="timeline-row" key={snapshot.id ?? snapshot.path}>
            <div className="timeline-main">
              <strong>{snapshot.label}</strong>
              <span className="muted">{new Date(snapshot.createdAt).toLocaleString()}</span>
              {snapshot.sourceDir ? <span className="muted timeline-source">{snapshot.sourceDir}</span> : null}
            </div>
            <button
              type="button"
              className="primary-action"
              onClick={() => onRestore(snapshot.id ?? '')}
              disabled={!snapshot.id || restoring || loading}
            >
              {t('history.restoreHere')}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

export function DashboardShell({
  data,
  initialScreen = 'overview',
  onRefresh,
  sections = initialSectionStates,
  onEnsureSections,
  onReloadSection,
}: {
  data: DashboardData;
  initialScreen?: Screen;
  onRefresh: () => Promise<void>;
  sections?: SectionStates;
  onEnsureSections?: (names: SectionName[]) => void;
  onReloadSection?: (name: SectionName) => void;
}) {
  const { t } = useTranslation();
  const mergedData = useMemo(() => mergeDeclaredSkills(data), [data]);
  const [active, setActive] = useState<Screen>(initialScreen);

  // M0-5.6:进入某屏时按需触发它消费的懒加载区块(idle→loading)。overview 触发 audit+stats。
  useEffect(() => {
    onEnsureSections?.(sectionsForScreen(active));
  }, [active, onEnsureSections]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<OperationNotice | null>(null);
  const [installDraft, setInstallDraft] = useState<InstallDraft>({
    source: '',
    agent: agentOptions(mergedData)[0] ?? 'claude-code',
    mode: 'copy',
    skill: '',
    ref: '',
    force: false,
  });
  const [installResult, setInstallResult] = useState<InstallRunResult | null>(null);
  const [blockedReason, setBlockedReason] = useState('');
  const [syncPlan, setSyncPlan] = useState<SyncRunResult | null>(null);
  const [restoreList, setRestoreList] = useState<RestoreListResult | null>(null);
  const [advanced, setAdvanced] = useState(readStoredAdvanced);
  const [confirmation, setConfirmation] = useState<ConfirmationDialogState | null>(null);

  const declaredAgentPairs = useMemo(
    () => new Set((data.doctor.declarations ?? []).flatMap((entry) => entry.agents.map((agent) => skillAgentKey(agent, entry.name)))),
    [data.doctor.declarations],
  );

  const requestConfirmation = useCallback((request: WriteConfirmationRequest) => {
    setConfirmation(createConfirmationDialogState({
      title: t('operations.confirmDialog.title'),
      confirmLabel: t('operations.confirmDialog.confirm'),
      cancelLabel: t('operations.confirmDialog.cancel'),
      ...request,
    }, () => setConfirmation(null)));
  }, [t]);

  const setAdvancedPreference = useCallback((enabled: boolean) => {
    setAdvanced(enabled);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(advancedStorageKey, String(enabled));
    }
  }, []);

  const runBusy = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } catch (reason) {
      setNotice({
        tone: 'danger',
        title: t('operations.notice.failed'),
        detail: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setBusy(null);
    }
  }, [t]);

  const handleInstall = useCallback(() => {
    const source = installDraft.source.trim();
    if (!source) {
      setNotice({ tone: 'warn', title: t('operations.notice.missingSource') });
      return;
    }
    requestConfirmation({
      message: t(installDraft.force ? 'operations.confirm.forceInstall' : 'operations.confirm.install'),
      tone: installDraft.force ? 'danger' : 'warn',
      consequence: t(installDraft.force ? 'operations.confirm.consequence.forceRisk' : 'operations.confirm.consequence.backup'),
      onConfirm: () => runBusy('install', async () => {
        const result = await runInstall({
          source,
          agent: installDraft.agent,
          mode: installDraft.mode,
          ...(installDraft.skill.trim() ? { skill: installDraft.skill.trim() } : {}),
          ...(installDraft.ref.trim() ? { ref: installDraft.ref.trim() } : {}),
          force: installDraft.force,
        });
        setInstallResult(result.data);
        if (result.data.blocked.length > 0) {
          setNotice({
            tone: 'danger',
            title: t('operations.install.blocked'),
            detail: t('operations.install.blockedDetail', { count: result.data.blocked.length }),
          });
          return;
        }
        setNotice({
          tone: 'good',
          title: t('operations.notice.installed'),
          detail: t('operations.notice.exitCode', { code: result.exitCode }),
          snapshots: snapshotPaths(result.data),
        });
        await onRefresh();
      }),
    });
  }, [installDraft, onRefresh, requestConfirmation, runBusy, t]);

  // F-C2:被安全拦截后,填了原因再「仍要安装」—— force + --force-reason,留痕进 bypass-ledger。
  const handleForceInstall = useCallback(() => {
    const source = installDraft.source.trim();
    const reason = blockedReason.trim();
    if (!source || !reason) return;
    requestConfirmation({
      message: t('operations.confirm.forceInstall'),
      tone: 'danger',
      consequence: t('operations.confirm.consequence.forceRisk'),
      onConfirm: () => runBusy('install', async () => {
        const result = await runInstall({
          source,
          agent: installDraft.agent,
          mode: installDraft.mode,
          ...(installDraft.skill.trim() ? { skill: installDraft.skill.trim() } : {}),
          ...(installDraft.ref.trim() ? { ref: installDraft.ref.trim() } : {}),
          force: true,
          forceReason: reason,
        });
        setInstallResult(result.data);
        if (result.data.blocked.length > 0) {
          setNotice({
            tone: 'danger',
            title: t('operations.install.blocked'),
            detail: t('operations.install.blockedDetail', { count: result.data.blocked.length }),
          });
          return;
        }
        setBlockedReason('');
        setNotice({
          tone: 'good',
          title: t('operations.notice.installed'),
          detail: t('operations.notice.exitCode', { code: result.exitCode }),
          snapshots: snapshotPaths(result.data),
        });
        await onRefresh();
      }),
    });
  }, [installDraft, blockedReason, onRefresh, requestConfirmation, runBusy, t]);

  const handleToggle = useCallback((skill: SkillRecord, enabled: boolean) => {
    const name = actionSkillName(skill);
    requestConfirmation({
      message: t(enabled ? 'operations.confirm.toggleOn' : 'operations.confirm.toggleOff', { name }),
      consequence: t(enabled ? 'operations.confirm.consequence.backup' : 'operations.confirm.consequence.disableKept'),
      onConfirm: () => runBusy(`toggle-${name}`, async () => {
        const installSnapshots: string[] = [];
        const agentsToPrepare = skill.agents.filter((agent) => !declaredAgentPairs.has(skillAgentKey(agent, name)));
        for (const agent of agentsToPrepare) {
          const prepared = await runInstall({
            source: skill.dir,
            agent,
            mode: 'copy',
            skill: name,
            force: false,
          });
          setInstallResult(prepared.data);
          if (prepared.data.blocked.length > 0) {
            setNotice({
              tone: 'danger',
              title: t('operations.install.blocked'),
              detail: t('operations.install.blockedDetail', { count: prepared.data.blocked.length }),
            });
            return;
          }
          installSnapshots.push(...snapshotPaths(prepared.data));
        }
        const result = await runToggle({ name, enabled });
        setNotice({
          tone: 'good',
          title: enabled ? t('operations.notice.toggledOn') : t('operations.notice.toggledOff'),
          detail: `${result.data.actions.length} actions`,
          snapshots: [...installSnapshots, ...snapshotPaths(result.data)],
        });
        await onRefresh();
      }),
    });
  }, [declaredAgentPairs, onRefresh, requestConfirmation, runBusy, t]);

  const handleRemove = useCallback((skill: SkillRecord) => {
    const name = actionSkillName(skill);
    requestConfirmation({
      message: t('operations.confirm.remove', { name }),
      tone: 'danger',
      consequence: t('operations.confirm.consequence.backup'),
      onConfirm: () => runBusy(`remove-${name}`, async () => {
        const snapshots: string[] = [];
        for (const agent of skill.agents) {
          const result = await runRemove({ name, agent });
          snapshots.push(...snapshotPaths(result.data));
        }
        setNotice({
          tone: 'good',
          title: t('operations.notice.removed'),
          detail: name,
          snapshots,
        });
        await onRefresh();
      }),
    });
  }, [onRefresh, requestConfirmation, runBusy, t]);

  const handleSyncDryRun = useCallback(() => {
    void runBusy('sync-dry-run', async () => {
      const result = await runSync({ dryRun: true });
      setSyncPlan(result.data);
      setNotice({
        tone: changedActionCount(result.data) > 0 ? 'warn' : 'good',
        title: t('operations.notice.syncPlanned'),
        detail: t('operations.sync.planCount', { changed: changedActionCount(result.data), total: result.data.actions.length }),
      });
    });
  }, [runBusy, t]);

  const handleSyncApply = useCallback(() => {
    if (!syncPlan) return;
    requestConfirmation({
      message: t('operations.confirm.sync', { count: changedActionCount(syncPlan) }),
      consequence: t('operations.confirm.consequence.backup'),
      onConfirm: () => runBusy('sync-apply', async () => {
        const result = await runSync({ dryRun: false });
        setSyncPlan(result.data);
        setNotice({
          tone: 'good',
          title: t('operations.notice.synced'),
          detail: t('operations.sync.planCount', { changed: changedActionCount(result.data), total: result.data.actions.length }),
          snapshots: snapshotPaths(result.data),
        });
        await onRefresh();
      }),
    });
  }, [onRefresh, requestConfirmation, runBusy, syncPlan, t]);

  const handleLoadSnapshots = useCallback(() => {
    void runBusy('restore-list', async () => {
      const result = await runRestore({});
      if (isRestoreList(result.data)) {
        setRestoreList(result.data);
        setNotice({
          tone: 'good',
          title: t('operations.notice.snapshotsLoaded'),
          detail: t('operations.restore.count', { count: result.data.snapshots.length }),
        });
      }
    });
  }, [runBusy, t]);

  const handleRestore = useCallback((id: string) => {
    if (!id) return;
    requestConfirmation({
      message: t('operations.confirm.restore'),
      tone: 'danger',
      consequence: t('operations.confirm.consequence.restoreOverwrite'),
      onConfirm: () => runBusy('restore-apply', async () => {
        const result = await runRestore({ id });
        if (!isRestoreList(result.data)) {
          setNotice({
            tone: 'good',
            title: t('operations.notice.restored'),
            detail: result.data.target,
            snapshots: snapshotPaths(result.data),
          });
          await onRefresh();
          const list = await runRestore({});
          if (isRestoreList(list.data)) setRestoreList(list.data);
        }
      }),
    });
  }, [onRefresh, requestConfirmation, runBusy, t]);

  // F-B1:进入「历史」tab 时按需拉一次快照列表(还没拉过才拉,避免重复)。
  useEffect(() => {
    if (active === 'history' && restoreList === null && busy !== 'restore-list') {
      handleLoadSnapshots();
    }
  }, [active, restoreList, busy, handleLoadSnapshots]);

  const operations: WriteOperationsProps = {
    data: mergedData,
    busy,
    installDraft,
    installResult,
    syncPlan,
    restoreList,
    onInstallDraftChange: setInstallDraft,
    onInstall: handleInstall,
    onSyncDryRun: handleSyncDryRun,
    onSyncApply: handleSyncApply,
    onLoadSnapshots: handleLoadSnapshots,
    onRestore: handleRestore,
    blockedReason,
    onBlockedReasonChange: setBlockedReason,
    onForceInstall: handleForceInstall,
  };

  const skillActions: SkillActionsProps = {
    busy,
    onToggle: handleToggle,
    onRemove: handleRemove,
  };

  return (
    <>
      <Header data={mergedData} advanced={advanced} onAdvancedChange={setAdvancedPreference} />
      <nav className="screen-tabs" aria-label={t('screens.ariaLabel')}>
        {screens.map((screen) => (
          <button className={cx(active === screen.id && 'active')} key={screen.id} onClick={() => setActive(screen.id)}>
            {t(screen.labelKey)}
          </button>
        ))}
      </nav>
      {mergedData.source === 'fixtures' ? (
        <section className="operation-banner operation-banner-warn">
          <div>
            <strong>{t('dashboard.fixtureMode')}</strong>
          </div>
        </section>
      ) : null}
      <OperationBanner notice={notice} />
      {mergedData.loadErrors ? (
        <section className="operation-banner operation-banner-warn">
          <div>
            <strong>{t('dashboard.partialLoad')}</strong>
            <p>{Object.keys(mergedData.loadErrors).join(', ')}</p>
          </div>
        </section>
      ) : null}
      <ConfirmationDialog confirmation={confirmation} />
      {active === 'overview' ? <Overview data={mergedData} operations={operations} advanced={advanced} sections={sections} /> : null}
      {active === 'skills' ? <Skills data={mergedData} actions={skillActions} /> : null}
      {active === 'audit' ? <Audit data={mergedData} section={sections.audit} onReload={() => onReloadSection?.('audit')} /> : null}
      {active === 'history' ? (
        <History
          restoreList={restoreList}
          busy={busy}
          loaded={restoreList !== null}
          onReload={handleLoadSnapshots}
          onRestore={handleRestore}
        />
      ) : null}
      {active === 'stats' ? <Stats data={mergedData} section={sections.stats} onReload={() => onReloadSection?.('stats')} /> : null}
    </>
  );
}

export default function App() {
  const { t } = useTranslation();
  // M0-5.6:首屏只加载 core(scan/doctor/lock),audit/stats 由各屏按需懒加载,不阻塞首屏。
  const [core, setCore] = useState<DashboardData | null>(null);
  const [auditValue, setAuditValue] = useState<AuditReport[] | null>(null);
  const [statsValue, setStatsValue] = useState<StatsReport | null>(null);
  const [sections, setSections] = useState<SectionStates>(initialSectionStates);
  const [error, setError] = useState<string | null>(null);

  // ensureSections 需读到最新 sections 又要保持引用稳定(否则会重复触发 effect),用 ref 兜。
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  const loadSection = useCallback(async (name: SectionName) => {
    setSections((prev) => ({ ...prev, [name]: { ...prev[name], status: 'loading' } }));
    try {
      if (name === 'audit') {
        setAuditValue(await loadAudit());
      } else {
        setStatsValue(await loadStats());
      }
      setSections((prev) => ({ ...prev, [name]: { status: 'loaded', loadedAt: new Date().toISOString() } }));
    } catch (reason) {
      setSections((prev) => ({
        ...prev,
        [name]: { status: 'error', error: reason instanceof Error ? reason.message : String(reason) },
      }));
    }
  }, []);

  // 进入消费某区块的屏时调用:仅当该区块还没触发过(idle)才加载,避免重复跑。
  const ensureSections = useCallback(
    (names: SectionName[]) => {
      for (const name of names) {
        if (sectionsRef.current[name].status === 'idle') void loadSection(name);
      }
    },
    [loadSection],
  );

  const reloadCore = useCallback(async () => {
    setError(null);
    setCore(await loadCoreDashboard());
  }, []);

  // 全局刷新(刷新按钮 / 写操作后):重载 core,并强制刷新已加载过的懒区块;idle 的保持懒态。
  const refreshAll = useCallback(async () => {
    await reloadCore();
    for (const name of ['audit', 'stats'] as SectionName[]) {
      if (sectionsRef.current[name].status !== 'idle') void loadSection(name);
    }
  }, [reloadCore, loadSection]);

  useEffect(() => {
    let cancelled = false;
    reloadCore().catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [reloadCore]);

  const data = useMemo<DashboardData | null>(
    () => (core ? { ...core, audit: auditValue ?? core.audit, stats: statsValue ?? core.stats } : null),
    [core, auditValue, statsValue],
  );

  if (error) {
    return (
      <main className="app-shell">
        <section className="fatal-panel">{error}</section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="app-shell">
        <section className="loading-panel">{t('loading')}</section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <DashboardShell
        data={data}
        onRefresh={refreshAll}
        sections={sections}
        onEnsureSections={ensureSections}
        onReloadSection={loadSection}
      />
    </main>
  );
}
