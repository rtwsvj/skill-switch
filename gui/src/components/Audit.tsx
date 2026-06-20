import { useTranslation } from 'react-i18next';
import type { DashboardData } from '../data';
import { auditCoverageSummary, cx, isBlockingAudit, severityLabel, verdictLabel } from '../lib/helpers';
import type { SectionState } from '../lib/types';
import { Metric, SectionStatusBar, StatusPill } from './atoms';

export function Audit({ data, section, onReload }: { data: DashboardData; section: SectionState; onReload: () => void }) {
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
      {auditCoverageSummary(data.audit, t) ? <p className="coverage-line muted">{auditCoverageSummary(data.audit, t)}</p> : null}

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
