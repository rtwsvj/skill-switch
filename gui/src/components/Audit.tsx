// 安全屏 — G1 迁移:手写 CSS class → shadcn 设计系统(Card/Badge)+ 语义 token。
// 摘要三指标卡、bypass 留痕、逐技能审计卡片,severity 用 Badge good/warn/danger,明暗自适应。
// 数据流(props)不变;所有 UI 文案走 t(),被渲染的数据(finding message、文件名等)原样显示。
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertOctagon, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { AuditSeverity, DashboardData } from '../data';
import { auditCoverageSummary, isBlockingAudit, severityLabel, verdictLabel } from '../lib/helpers';
import type { SectionState } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { SectionStatusBar } from './atoms';

// severity → 语义 Badge variant:critical/high 危险,medium/low 提醒。
function severityVariant(severity: AuditSeverity): 'danger' | 'warn' {
  return severity === 'critical' || severity === 'high' ? 'danger' : 'warn';
}

// 紧凑摘要指标卡(与 Overview 的 MetricCard 同风格,但更小,专用于本屏)。
function SummaryMetric({
  icon,
  value,
  label,
  tone = 'neutral',
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  tone?: 'neutral' | 'good' | 'danger';
}) {
  return (
    <Card
      className={cn(
        'transition-shadow hover:shadow-md',
        tone === 'good' && 'border-good/45',
        tone === 'danger' && 'border-danger/55',
      )}
    >
      <CardContent className="flex items-center gap-3 px-4 py-4">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            tone === 'good' && 'bg-good/12 text-good',
            tone === 'danger' && 'bg-danger/12 text-danger',
            tone === 'neutral' && 'bg-muted text-muted-foreground',
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <div
            className={cn(
              'font-console text-2xl leading-none',
              tone === 'good' && 'text-good',
              tone === 'danger' && 'text-danger',
            )}
          >
            {value}
          </div>
          <p className="mt-1 text-[13px] uppercase tracking-wide text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function Audit({ data, section, onReload }: { data: DashboardData; section: SectionState; onReload: () => void }) {
  const { t } = useTranslation();
  const sorted = [...data.audit].sort((a, b) => Number(isBlockingAudit(b)) - Number(isBlockingAudit(a)) || a.score - b.score);
  const loadingFirstTime = section.status === 'loading' && data.audit.length === 0;
  // F-C1 安全中心:摘要 + bypass 留痕。
  const blockedCount = data.audit.filter(isBlockingAudit).length;
  const reviewCount = data.audit.filter((r) => !isBlockingAudit(r) && r.verdict === 'REVIEW').length;
  const safeCount = Math.max(0, data.audit.length - blockedCount - reviewCount);
  const bypasses = data.doctor.bypasses ?? [];
  const coverage = auditCoverageSummary(data.audit, t);

  return (
    <section className="screen">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">{t('screens.audit')}</h2>
        <SectionStatusBar section={section} onReload={onReload} />
      </div>

      {section.status === 'error' ? <p className="text-sm text-danger">{section.error}</p> : null}
      {loadingFirstTime ? <p className="text-sm text-muted-foreground">{t('section.loading')}</p> : null}

      {data.audit.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SummaryMetric
            icon={<ShieldCheck size={16} />}
            value={safeCount}
            label={t('safety.summary.safe')}
            tone={safeCount > 0 ? 'good' : 'neutral'}
          />
          <SummaryMetric
            icon={<ShieldAlert size={16} />}
            value={reviewCount}
            label={t('safety.summary.review')}
            tone={reviewCount > 0 ? 'danger' : 'neutral'}
          />
          <SummaryMetric
            icon={<AlertOctagon size={16} />}
            value={blockedCount}
            label={t('safety.summary.blocked')}
            tone={blockedCount > 0 ? 'danger' : 'good'}
          />
        </div>
      ) : null}

      {coverage ? <p className="text-xs text-muted-foreground">{coverage}</p> : null}

      {bypasses.length > 0 ? (
        <Card className="border-danger/40">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-[15px]">
                <AlertOctagon size={16} className="text-danger" />
                {t('safety.bypass.title')}
              </CardTitle>
              <Badge variant="danger">{t('safety.bypass.badge')}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('safety.bypass.subtitle')}</p>
            <div className="space-y-2">
              {bypasses.map((b) => (
                <div
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-danger/25 bg-danger/5 px-3 py-2.5"
                  key={`${b.agent}/${b.name}/${b.bypassedAt}`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <strong className="text-sm text-foreground">{b.name}</strong>
                    <p className="text-xs text-muted-foreground">
                      {b.agent} · {new Date(b.bypassedAt).toLocaleString()}
                    </p>
                    <p className="text-xs text-foreground">
                      {b.bypassReason ? t('safety.bypass.reason', { reason: b.bypassReason }) : t('safety.bypass.noReason')}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant="warn">{t('safety.bypass.score', { score: b.score })}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {t('safety.bypass.findings', { count: b.bypassedFindings.length })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {sorted.map((report) => {
          const blocking = isBlockingAudit(report);
          const findings = report.findings ?? [];
          return (
            <Card
              className={cn('flex flex-col transition-shadow hover:shadow-md', blocking && 'border-danger/55')}
              key={report.path}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-[15px]">{report.name ?? report.path.split('/').at(-1)}</CardTitle>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{report.relSkillsDir ?? report.path}</p>
                  </div>
                  <span
                    className={cn(
                      'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border font-console text-lg',
                      blocking ? 'border-danger/55 text-danger' : 'border-border text-foreground',
                    )}
                  >
                    {report.score}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={report.verdict === 'DANGER' ? 'danger' : report.verdict === 'REVIEW' ? 'warn' : 'good'}>
                    {verdictLabel(report.verdict, t)}
                  </Badge>
                  {blocking ? (
                    <Badge variant="danger">{t('status.blockable')}</Badge>
                  ) : (
                    <Badge variant="good">{t('status.pass')}</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">{t('audit.findingCount', { count: findings.length })}</span>
                </div>
                {findings.length > 0 ? (
                  <ul className="space-y-1.5">
                    {findings.slice(0, 3).map((finding) => (
                      <li className="flex items-center gap-2 text-sm" key={`${finding.ruleId}-${finding.line}`}>
                        <span
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            severityVariant(finding.severity) === 'danger' ? 'bg-danger' : 'bg-warn',
                          )}
                        />
                        <span className="truncate text-foreground">{finding.ruleId}</span>
                        <Badge variant={severityVariant(finding.severity)} className="ml-auto">
                          {severityLabel(finding.severity, t)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('audit.noRules')}</p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
