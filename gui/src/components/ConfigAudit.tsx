// R8-b 配置安全:展示 `audit --configs --json` 的结果(settings.json / MCP 配置文件发现)。
// G1 迁移:手写 CSS class → shadcn 设计系统(Card/Badge)+ 语义 token;纯读。
// 数据流不变;UI 文案走 t(),被渲染的数据(ruleId、message、文件名)原样显示。
import { useTranslation } from 'react-i18next';
import { FileWarning, ShieldCheck } from 'lucide-react';
import type { ConfigAuditReport } from '../data';
import { severityLabel } from '../lib/helpers';
import type { SectionState } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { SectionStatusBar } from './atoms';

// severity 字符串 → 语义 Badge variant:critical/high 危险,其余提醒。
function isBlockingSeverity(severity: string): boolean {
  return severity === 'critical' || severity === 'high';
}

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
  const criticalOrHigh = allFindings.filter((f) => isBlockingSeverity(f.severity)).length;
  const otherCount = allFindings.length - criticalOrHigh;

  return (
    <section className="screen">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">{t('configAudit.title')}</h2>
        <SectionStatusBar section={section} onReload={onReload} />
      </div>

      {section.status === 'error' ? <p className="text-sm text-danger">{section.error}</p> : null}
      {loadingFirstTime ? <p className="text-sm text-muted-foreground">{t('section.loading')}</p> : null}

      {report !== null && allFindings.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={criticalOrHigh > 0 ? 'danger' : 'outline'}>
            {t('configAudit.summary.blocking', { count: criticalOrHigh })}
          </Badge>
          <Badge variant={otherCount > 0 ? 'warn' : 'outline'}>
            {t('configAudit.summary.other', { count: otherCount })}
          </Badge>
        </div>
      ) : null}

      {report !== null && report.configs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('configAudit.noConfigsFound')}</p>
      ) : null}

      {report !== null && allFindings.length === 0 && report.configs.length > 0 ? (
        <p className="text-sm text-muted-foreground">{t('configAudit.noFindings')}</p>
      ) : null}

      {report !== null ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {report.configs.map((cfg) => {
            const blocking = cfg.findings.some((f) => isBlockingSeverity(f.severity));
            return (
              <Card
                className={cn('flex flex-col transition-shadow hover:shadow-md', blocking && 'border-danger/55')}
                key={cfg.relPath}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-[15px]">{cfg.relPath.split('/').at(-1)}</CardTitle>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{cfg.relPath}</p>
                    </div>
                    {cfg.findings.length === 0 ? (
                      <Badge variant="good" className="gap-1">
                        <ShieldCheck size={12} />
                        {t('configAudit.fileClean')}
                      </Badge>
                    ) : (
                      <Badge variant={blocking ? 'danger' : 'warn'} className="gap-1">
                        <FileWarning size={12} />
                        {t('configAudit.findingCount', { count: cfg.findings.length })}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  {cfg.findings.length > 0 ? (
                    <ul className="space-y-2">
                      {cfg.findings.map((finding) => (
                        <li className="flex gap-2 text-sm" key={`${finding.ruleId}-${finding.line}`}>
                          <span
                            className={cn(
                              'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                              isBlockingSeverity(finding.severity) ? 'bg-danger' : 'bg-warn',
                            )}
                          />
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-foreground">{finding.ruleId}</span>
                              <Badge variant={isBlockingSeverity(finding.severity) ? 'danger' : 'warn'}>
                                {severityLabel(finding.severity, t)}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">{finding.message}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('configAudit.fileNoFindings')}</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
