import { useEffect, useMemo, useState } from 'react';
import { loadDashboardData, type AuditReport, type DashboardData, type SkillRecord } from './data';

type Screen = 'overview' | 'skills' | 'audit' | 'stats';

const screens: Array<{ id: Screen; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'skills', label: 'Skills' },
  { id: 'audit', label: 'Audit' },
  { id: 'stats', label: 'Usage' },
];

function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function isNameMismatch(skill: SkillRecord) {
  return Boolean(skill.name && skill.name !== skill.dirName);
}

function isBlockingAudit(report: AuditReport) {
  return report.blocked ?? (report.score < 70 || report.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high'));
}

function displaySkillName(skill: SkillRecord) {
  return skill.name ?? skill.dirName;
}

function metricLabel(value: number | string, label: string, tone = 'neutral') {
  return (
    <div className={cx('metric', tone === 'danger' && 'metric-danger', tone === 'good' && 'metric-good')}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function StatusPill({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'good' | 'warn' | 'danger' }) {
  return <span className={cx('pill', `pill-${tone}`)}>{children}</span>;
}

function Header({ data }: { data: DashboardData }) {
  return (
    <header className="header">
      <div>
        <p className="eyebrow">skill-switch</p>
        <h1>Governance Console</h1>
      </div>
      <div className="header-meta">
        <StatusPill tone={data.source === 'fixtures' ? 'warn' : 'good'}>{data.source === 'fixtures' ? 'Fixture feed' : 'Live shell feed'}</StatusPill>
        <span>{new Date(data.loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </header>
  );
}

function Overview({ data }: { data: DashboardData }) {
  const agents = new Set(data.scan.skills.flatMap((skill) => skill.agents));
  const broken = data.scan.skills.filter((skill) => skill.error || isNameMismatch(skill));
  const blocking = data.audit.filter(isBlockingAudit);

  return (
    <section className="screen">
      <div className="metric-grid">
        {metricLabel(agents.size, 'agents mapped', 'good')}
        {metricLabel(data.scan.total, 'skills visible')}
        {metricLabel(data.stats.zombies.length, 'zombies', data.stats.zombies.length > 0 ? 'danger' : 'good')}
        {metricLabel(data.doctor.clean ? 'clean' : data.doctor.findings.length, 'doctor state', data.doctor.clean ? 'good' : 'danger')}
      </div>

      <div className="overview-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Read-Only Control Surface</h2>
            <StatusPill tone="good">safe mode</StatusPill>
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
            <h2>Doctor</h2>
            <StatusPill tone={data.doctor.clean ? 'good' : 'danger'}>{data.doctor.clean ? 'clean' : 'drift'}</StatusPill>
          </div>
          <dl className="definition-grid">
            <div>
              <dt>declared</dt>
              <dd>{data.doctor.checked.declared}</dd>
            </div>
            <div>
              <dt>locked</dt>
              <dd>{data.doctor.checked.locked}</dd>
            </div>
            <div>
              <dt>lock verify</dt>
              <dd>{data.lockVerify.ok ? 'ok' : 'failed'}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>Attention Queue</h2>
          <span>{broken.length + blocking.length} items</span>
        </div>
        <div className="attention-list">
          {broken.map((skill) => (
            <div className="attention-row" key={`${skill.relSkillsDir}/${skill.dirName}`}>
              <span>{skill.dirName}</span>
              <StatusPill tone={skill.error ? 'danger' : 'warn'}>{skill.error ? 'bad frontmatter' : 'name mismatch'}</StatusPill>
            </div>
          ))}
          {blocking.map((report) => (
            <div className="attention-row" key={report.path}>
              <span>{report.name ?? report.path.split('/').at(-1)}</span>
              <StatusPill tone="danger">audit blocks</StatusPill>
            </div>
          ))}
          {broken.length + blocking.length === 0 ? <p className="empty">No immediate governance findings.</p> : null}
        </div>
      </section>
    </section>
  );
}

function Skills({ data }: { data: DashboardData }) {
  return (
    <section className="screen">
      <section className="panel table-panel">
        <div className="panel-title">
          <h2>Installed Skills</h2>
          <span>{data.scan.total} records</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Directory</th>
                <th>Name</th>
                <th>Agents</th>
                <th>Location</th>
                <th>Status</th>
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
                      {hasError ? <StatusPill tone="danger">parse error</StatusPill> : mismatch ? <StatusPill tone="warn">name mismatch</StatusPill> : <StatusPill tone="good">ok</StatusPill>}
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
  const sorted = [...data.audit].sort((a, b) => Number(isBlockingAudit(b)) - Number(isBlockingAudit(a)) || a.score - b.score);

  return (
    <section className="screen">
      <div className="audit-grid">
        {sorted.map((report) => {
          const blocking = isBlockingAudit(report);
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
                <StatusPill tone={report.verdict === 'DANGER' ? 'danger' : report.verdict === 'REVIEW' ? 'warn' : 'good'}>{report.verdict}</StatusPill>
                {blocking ? <StatusPill tone="danger">blockable</StatusPill> : <StatusPill tone="good">pass</StatusPill>}
                <span>{report.findings.length} findings</span>
              </div>
              {report.findings.length > 0 ? (
                <ul className="finding-list">
                  {report.findings.slice(0, 3).map((finding) => (
                    <li key={`${finding.ruleId}-${finding.line}`}>
                      <span className={cx('severity-dot', `severity-${finding.severity}`)} />
                      <span>{finding.ruleId}</span>
                      <strong>{finding.severity}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">No rules fired.</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Stats({ data }: { data: DashboardData }) {
  const zombieNames = useMemo(() => new Set(data.stats.zombies.map((zombie) => zombie.name)), [data.stats.zombies]);

  return (
    <section className="screen">
      <div className="metric-grid compact">
        {metricLabel(data.stats.scannedFiles, 'transcripts scanned')}
        {metricLabel(data.stats.invocations, 'skill invocations')}
        {metricLabel(data.stats.usage.length, 'active skills', data.stats.usage.length > 0 ? 'good' : 'neutral')}
        {metricLabel(data.stats.zombies.length, 'zero-use installs', data.stats.zombies.length > 0 ? 'danger' : 'good')}
      </div>
      <section className="panel table-panel">
        <div className="panel-title">
          <h2>Zombie Inventory</h2>
          <span>{data.stats.since ? `since ${data.stats.since.slice(0, 10)}` : 'all time'}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Skill</th>
                <th>Agents</th>
                <th>Location</th>
                <th>State</th>
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
                    <td>{zombie ? <StatusPill tone="danger">zombie</StatusPill> : <StatusPill tone="good">used</StatusPill>}</td>
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

export default function App() {
  const [active, setActive] = useState<Screen>('overview');
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
        <section className="loading-panel">Loading governance feed...</section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <Header data={data} />
      <nav className="screen-tabs" aria-label="Dashboard screens">
        {screens.map((screen) => (
          <button className={cx(active === screen.id && 'active')} key={screen.id} onClick={() => setActive(screen.id)}>
            {screen.label}
          </button>
        ))}
      </nav>
      {active === 'overview' ? <Overview data={data} /> : null}
      {active === 'skills' ? <Skills data={data} /> : null}
      {active === 'audit' ? <Audit data={data} /> : null}
      {active === 'stats' ? <Stats data={data} /> : null}
    </main>
  );
}
