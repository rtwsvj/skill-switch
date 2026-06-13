import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation, type TFunction } from 'react-i18next';
import {
  loadDashboardData,
  runInstall,
  runRemove,
  runRestore,
  runSync,
  runToggle,
  type AuditReport,
  type AuditSeverity,
  type AuditVerdict,
  type DashboardData,
  type InstallMode,
  type InstallRunResult,
  type RestoreListResult,
  type RestoreRunResult,
  type SkillRecord,
  type SyncRunResult,
} from './data';
import { languageLabels, supportedLanguages, type SupportedLanguage } from './i18n';

type Screen = 'overview' | 'skills' | 'audit' | 'stats';

const screens: Array<{ id: Screen; labelKey: string }> = [
  { id: 'overview', labelKey: 'screens.overview' },
  { id: 'skills', labelKey: 'screens.skills' },
  { id: 'audit', labelKey: 'screens.audit' },
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

function Header({ data }: { data: DashboardData }) {
  const { t, i18n } = useTranslation();

  return (
    <header className="header">
      <div>
        <p className="eyebrow">skill-switch</p>
        <h1>{t('header.title')}</h1>
      </div>
      <div className="header-meta">
        <StatusPill tone={data.source === 'fixtures' ? 'warn' : 'good'}>{data.source === 'fixtures' ? t('header.source.fixtures') : t('header.source.live')}</StatusPill>
        <span>{new Date(data.loadedAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</span>
        <LanguageSwitcher />
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
}: WriteOperationsProps) {
  const { t } = useTranslation();
  const agents = agentOptions(data);
  const syncChanges = syncPlan ? changedActionCount(syncPlan) : 0;

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
          <button className="primary-action" type="submit" disabled={busy === 'install'}>
            {busy === 'install' ? t('operations.busy') : t('operations.install.submit')}
          </button>
          {installResult?.blocked.length ? (
            <div className="blocked-list">
              <strong>{t('operations.install.blocked')}</strong>
              {installResult.blocked.map((blocked) => (
                <p key={blocked.name}>{`${blocked.name}: ${blocked.report.findings.length} findings / score ${blocked.score}`}</p>
              ))}
            </div>
          ) : null}
        </form>

        <div className="operation-form">
          <h3>{t('operations.sync.title')}</h3>
          <div className="button-row">
            <button type="button" onClick={onSyncDryRun} disabled={busy === 'sync-dry-run'}>
              {busy === 'sync-dry-run' ? t('operations.busy') : t('operations.sync.dryRun')}
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={onSyncApply}
              disabled={!syncPlan || busy === 'sync-apply'}
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
          <button type="button" onClick={onLoadSnapshots} disabled={busy === 'restore-list'}>
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
                  <button type="button" onClick={() => onRestore(snapshot.id ?? '')} disabled={!snapshot.id || busy === 'restore-apply'}>
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

function Overview({ data, operations }: { data: DashboardData; operations: WriteOperationsProps }) {
  const { t } = useTranslation();
  const agents = new Set(data.scan.skills.flatMap((skill) => skill.agents));
  const broken = data.scan.skills.filter((skill) => skill.error || isNameMismatch(skill));
  const blocking = data.audit.filter(isBlockingAudit);

  return (
    <section className="screen">
      <div className="metric-grid">
        <Metric value={agents.size} label={t('overview.metrics.agents')} tone="good" />
        <Metric value={data.scan.total} label={t('overview.metrics.skills')} />
        <Metric value={data.stats.zombies.length} label={t('overview.metrics.zombies')} tone={data.stats.zombies.length > 0 ? 'danger' : 'good'} />
        <Metric value={data.doctor.clean ? t('status.clean') : data.doctor.findings.length} label={t('overview.metrics.doctor')} tone={data.doctor.clean ? 'good' : 'danger'} />
      </div>

      <div className="overview-grid">
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
      </div>

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
          {broken.length + blocking.length === 0 ? <p className="empty">{t('overview.attention.empty')}</p> : null}
        </div>
      </section>
    </section>
  );
}

interface SkillActionsProps {
  busy: string | null;
  onToggle: (skill: SkillRecord, enabled: boolean) => void;
  onRemove: (skill: SkillRecord, agent: string) => void;
  onAdopt: (skill: SkillRecord, agent: string) => void;
}

function Skills({ data, actions }: { data: DashboardData; actions: SkillActionsProps }) {
  const { t } = useTranslation();
  const locked = useMemo(
    () => new Set(data.lockVerify.entries.map((entry) => `${entry.agent}/${entry.name}`)),
    [data.lockVerify.entries],
  );

  return (
    <section className="screen">
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
                const managed = skill.agents.some((agent) => locked.has(`${agent}/${name}`));
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
                      {hasError ? (
                        <StatusPill tone="danger">{t('status.parseError')}</StatusPill>
                      ) : mismatch ? (
                        <StatusPill tone="warn">{t('status.nameMismatch')}</StatusPill>
                      ) : (
                        <StatusPill tone="good">{t('status.ok')}</StatusPill>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {managed ? (
                          <>
                            <button type="button" onClick={() => actions.onToggle(skill, true)} disabled={actions.busy === `toggle-${name}`}>
                              {t('skills.actions.on')}
                            </button>
                            <button type="button" onClick={() => actions.onToggle(skill, false)} disabled={actions.busy === `toggle-${name}`}>
                              {t('skills.actions.off')}
                            </button>
                            {skill.agents.map((agent) => (
                              <button
                                type="button"
                                className="danger-action"
                                key={agent}
                                onClick={() => actions.onRemove(skill, agent)}
                                disabled={actions.busy === `remove-${agent}-${name}`}
                              >
                                {t('skills.actions.remove', { agent })}
                              </button>
                            ))}
                          </>
                        ) : (
                          skill.agents.map((agent) => (
                            <button
                              type="button"
                              className="primary-action"
                              key={agent}
                              onClick={() => actions.onAdopt(skill, agent)}
                              disabled={actions.busy === `adopt-${agent}-${name}`}
                            >
                              {t('skills.actions.adopt', { agent })}
                            </button>
                          ))
                        )}
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

function Audit({ data }: { data: DashboardData }) {
  const { t } = useTranslation();
  const sorted = [...data.audit].sort((a, b) => Number(isBlockingAudit(b)) - Number(isBlockingAudit(a)) || a.score - b.score);

  return (
    <section className="screen">
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

function Stats({ data }: { data: DashboardData }) {
  const { t } = useTranslation();
  const zombieNames = useMemo(() => new Set(data.stats.zombies.map((zombie) => zombie.name)), [data.stats.zombies]);

  return (
    <section className="screen">
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

export function DashboardShell({
  data,
  initialScreen = 'overview',
  onRefresh,
}: {
  data: DashboardData;
  initialScreen?: Screen;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<Screen>(initialScreen);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<OperationNotice | null>(null);
  const [installDraft, setInstallDraft] = useState<InstallDraft>({
    source: '',
    agent: agentOptions(data)[0] ?? 'claude-code',
    mode: 'copy',
    skill: '',
    ref: '',
    force: false,
  });
  const [installResult, setInstallResult] = useState<InstallRunResult | null>(null);
  const [syncPlan, setSyncPlan] = useState<SyncRunResult | null>(null);
  const [restoreList, setRestoreList] = useState<RestoreListResult | null>(null);

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
    if (!window.confirm(t(installDraft.force ? 'operations.confirm.forceInstall' : 'operations.confirm.install'))) return;
    void runBusy('install', async () => {
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
    });
  }, [installDraft, onRefresh, runBusy, t]);

  const handleToggle = useCallback((skill: SkillRecord, enabled: boolean) => {
    const name = actionSkillName(skill);
    if (!window.confirm(t(enabled ? 'operations.confirm.toggleOn' : 'operations.confirm.toggleOff', { name }))) return;
    void runBusy(`toggle-${name}`, async () => {
      const result = await runToggle({ name, enabled });
      setNotice({
        tone: 'good',
        title: enabled ? t('operations.notice.toggledOn') : t('operations.notice.toggledOff'),
        detail: `${result.data.actions.length} actions`,
        snapshots: snapshotPaths(result.data),
      });
      await onRefresh();
    });
  }, [onRefresh, runBusy, t]);

  const handleRemove = useCallback((skill: SkillRecord, agent: string) => {
    const name = actionSkillName(skill);
    if (!window.confirm(t('operations.confirm.remove', { agent, name }))) return;
    void runBusy(`remove-${agent}-${name}`, async () => {
      const result = await runRemove({ name, agent });
      setNotice({
        tone: 'good',
        title: t('operations.notice.removed'),
        detail: `${result.data.agent}/${result.data.name}`,
        snapshots: snapshotPaths(result.data),
      });
      await onRefresh();
    });
  }, [onRefresh, runBusy, t]);

  const handleAdopt = useCallback((skill: SkillRecord, agent: string) => {
    const name = actionSkillName(skill);
    if (!window.confirm(t('operations.confirm.adopt', { agent, name }))) return;
    void runBusy(`adopt-${agent}-${name}`, async () => {
      const result = await runInstall({
        source: skill.path,
        agent,
        mode: 'copy',
        skill: name,
        force: false,
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
        title: t('operations.notice.adopted'),
        detail: `${agent}/${name}`,
        snapshots: snapshotPaths(result.data),
      });
      await onRefresh();
    });
  }, [onRefresh, runBusy, t]);

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
    if (!window.confirm(t('operations.confirm.sync', { count: changedActionCount(syncPlan) }))) return;
    void runBusy('sync-apply', async () => {
      const result = await runSync({ dryRun: false });
      setSyncPlan(result.data);
      setNotice({
        tone: 'good',
        title: t('operations.notice.synced'),
        detail: t('operations.sync.planCount', { changed: changedActionCount(result.data), total: result.data.actions.length }),
        snapshots: snapshotPaths(result.data),
      });
      await onRefresh();
    });
  }, [onRefresh, runBusy, syncPlan, t]);

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
    if (!id || !window.confirm(t('operations.confirm.restore'))) return;
    void runBusy('restore-apply', async () => {
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
    });
  }, [onRefresh, runBusy, t]);

  const operations: WriteOperationsProps = {
    data,
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
  };

  const skillActions: SkillActionsProps = {
    busy,
    onToggle: handleToggle,
    onRemove: handleRemove,
    onAdopt: handleAdopt,
  };

  return (
    <>
      <Header data={data} />
      <nav className="screen-tabs" aria-label={t('screens.ariaLabel')}>
        {screens.map((screen) => (
          <button className={cx(active === screen.id && 'active')} key={screen.id} onClick={() => setActive(screen.id)}>
            {t(screen.labelKey)}
          </button>
        ))}
      </nav>
      <OperationBanner notice={notice} />
      {active === 'overview' ? <Overview data={data} operations={operations} /> : null}
      {active === 'skills' ? <Skills data={data} actions={skillActions} /> : null}
      {active === 'audit' ? <Audit data={data} /> : null}
      {active === 'stats' ? <Stats data={data} /> : null}
    </>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    setError(null);
    const loaded = await loadDashboardData();
    setData(loaded);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshData()
      .then(() => {
        if (cancelled) return;
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshData]);

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
      <DashboardShell data={data} onRefresh={refreshData} />
    </main>
  );
}
