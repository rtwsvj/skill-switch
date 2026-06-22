// R8-b 配置安全:展示 `audit --configs --json` 的结果(settings.json / MCP 配置文件发现)。
// 纯读;沿用 Audit.tsx 的 finding-list 样式与 SectionStatusBar。
import { useTranslation } from 'react-i18next';
import type { ConfigAuditReport } from '../data';
import { cx, severityLabel } from '../lib/helpers';
import type { SectionState } from '../lib/types';
import { SectionStatusBar, StatusPill } from './atoms';

export function ConfigAudit({
  report,
  section,
  onReload,
}: {
  report: ConfigAuditReport | null;
  section: SectionState;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const loadingFirstTime = section.status === 'loading' && report === null;

  const allFindings = report?.configs.flatMap((cfg) => cfg.findings) ?? [];
  const criticalOrHigh = allFindings.filter(
    (f) => f.severity === 'critical' || f.severity === 'high',
  ).length;
  const otherCount = allFindings.length - criticalOrHigh;

  return (
    <section className="screen">
      <div className="section-toolbar">
        <h2>{t('configAudit.title')}</h2>
        <SectionStatusBar section={section} onReload={onReload} />
      </div>
      {section.status === 'error' ? <p className="section-error">{section.error}</p> : null}
      {loadingFirstTime ? <p className="empty">{t('section.loading')}</p> : null}

      {report !== null && allFindings.length > 0 ? (
        <div className="metric-grid compact">
          <StatusPill tone={criticalOrHigh > 0 ? 'danger' : 'neutral'}>
            {t('configAudit.summary.blocking', { count: criticalOrHigh })}
          </StatusPill>
          <StatusPill tone={otherCount > 0 ? 'warn' : 'neutral'}>
            {t('configAudit.summary.other', { count: otherCount })}
          </StatusPill>
        </div>
      ) : null}

      {report !== null && report.configs.length === 0 ? (
        <p className="empty">{t('configAudit.noConfigsFound')}</p>
      ) : null}

      {report !== null && allFindings.length === 0 && report.configs.length > 0 ? (
        <p className="empty">{t('configAudit.noFindings')}</p>
      ) : null}

      {report !== null ? (
        <div className="audit-grid">
          {report.configs.map((cfg) => (
            <article
              className={cx('audit-card', cfg.findings.some((f) => f.severity === 'critical' || f.severity === 'high') && 'audit-card-danger')}
              key={cfg.relPath}
            >
              <div className="audit-head">
                <div>
                  <h2>{cfg.relPath.split('/').at(-1)}</h2>
                  <p>{cfg.relPath}</p>
                </div>
                {cfg.findings.length === 0 ? (
                  <StatusPill tone="good">{t('configAudit.fileClean')}</StatusPill>
                ) : (
                  <StatusPill tone={cfg.findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 'danger' : 'warn'}>
                    {t('configAudit.findingCount', { count: cfg.findings.length })}
                  </StatusPill>
                )}
              </div>
              {cfg.findings.length > 0 ? (
                <ul className="finding-list">
                  {cfg.findings.map((finding) => (
                    <li key={`${finding.ruleId}-${finding.line}`}>
                      <span className={cx('severity-dot', `severity-${finding.severity}`)} />
                      <span>{finding.ruleId}</span>
                      <strong>{severityLabel(finding.severity, t)}</strong>
                      <span className="muted">{finding.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">{t('configAudit.fileNoFindings')}</p>
              )}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
