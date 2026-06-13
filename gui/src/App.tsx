import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation, type TFunction } from 'react-i18next';
import { loadDashboardData, type AuditReport, type AuditSeverity, type AuditVerdict, type DashboardData, type SkillRecord } from './data';
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

function Overview({ data }: { data: DashboardData }) {
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
            <StatusPill tone="good">{t('overview.controlSurface.safeMode')}</StatusPill>
          </div>
          <div className="command-strip">
            <span>scan --json</span>
            <span>audit --json</span>
            <span>doctor --json</span>
            <span>stats --json</span>
            <span>lock --verify --json</span>
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

function Skills({ data }: { data: DashboardData }) {
  const { t } = useTranslation();

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
              </tr>
            </thead>
            <tbody>
              {data.scan.skills.map((skill) => {
                const mismatch = isNameMismatch(skill);
                const hasError = Boolean(skill.error);
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

export function DashboardShell({ data, initialScreen = 'overview' }: { data: DashboardData; initialScreen?: Screen }) {
  const { t } = useTranslation();
  const [active, setActive] = useState<Screen>(initialScreen);

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
      {active === 'overview' ? <Overview data={data} /> : null}
      {active === 'skills' ? <Skills data={data} /> : null}
      {active === 'audit' ? <Audit data={data} /> : null}
      {active === 'stats' ? <Stats data={data} /> : null}
    </>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadDashboardData()
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      <DashboardShell data={data} />
    </main>
  );
}
