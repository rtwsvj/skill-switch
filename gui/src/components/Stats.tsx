// 「使用」统计屏 — G3 shadcn 迁移:
// 四指标 → MetricCard(Card + lucide 图标 + 数值层级 + Skeleton,风格对齐 Overview)。
// 僵尸清单 → Card 包裹 shadcn Table + Badge(状态/工具)。
// 数据流不变,只改视觉;明暗自适应,文案全走 i18n。
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, FileText, Ghost, Zap } from 'lucide-react';
import type { DashboardData } from '../data';
import { coverageSummary, displaySkillName } from '../lib/helpers';
import type { SectionState } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Skeleton } from './ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { SectionStatusBar } from './atoms';

// ── 精致指标卡(与 Overview 的 MetricCard 同款风格,本屏内联)──────────────────
interface MetricCardProps {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  tone?: 'neutral' | 'good' | 'danger';
  loading?: boolean;
}

function MetricCard({ icon, value, label, tone = 'neutral', loading = false }: MetricCardProps) {
  return (
    <Card
      className={cn(
        'relative overflow-hidden transition-shadow hover:shadow-md',
        tone === 'good' && 'border-good/45',
        tone === 'danger' && 'border-danger/55',
      )}
    >
      <CardHeader className="pb-2 pt-5 px-5">
        <div className="flex items-center justify-between">
          <span
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg',
              tone === 'good' && 'bg-good/12 text-good',
              tone === 'danger' && 'bg-danger/12 text-danger',
              tone === 'neutral' && 'bg-muted text-muted-foreground',
            )}
          >
            {icon}
          </span>
          {tone !== 'neutral' && (
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                tone === 'good' && 'bg-good',
                tone === 'danger' && 'bg-danger animate-pulse',
              )}
            />
          )}
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        {loading ? (
          <Skeleton className="mb-1 h-9 w-16" />
        ) : (
          <div
            className={cn(
              'font-console text-[38px] leading-none mb-1',
              tone === 'good' && 'text-good',
              tone === 'danger' && 'text-danger',
            )}
          >
            {value}
          </div>
        )}
        <p className="text-[13px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

export function Stats({ data, section, onReload }: { data: DashboardData; section: SectionState; onReload: () => void }) {
  const { t } = useTranslation();
  const zombieNames = useMemo(() => new Set(data.stats.zombies.map((zombie) => zombie.name)), [data.stats.zombies]);
  const loadingFirstTime = section.status === 'loading' && section.loadedAt === undefined;
  const coverage = coverageSummary(data.stats, t);
  const activeCount = data.stats.usage.length;
  const zombieCount = data.stats.zombies.length;

  return (
    <section className="screen">
      <div className="section-toolbar">
        <h2>{t('screens.stats')}</h2>
        <SectionStatusBar section={section} onReload={onReload} />
      </div>
      {section.status === 'error' ? <p className="section-error">{section.error}</p> : null}

      {/* ── 四指标卡 ── */}
      <div className="metric-grid">
        <MetricCard
          icon={<FileText size={16} />}
          value={data.stats.scannedFiles}
          label={t('stats.metrics.transcripts')}
          loading={loadingFirstTime}
        />
        <MetricCard
          icon={<Zap size={16} />}
          value={data.stats.invocations}
          label={t('stats.metrics.invocations')}
          loading={loadingFirstTime}
        />
        <MetricCard
          icon={<CheckCircle2 size={16} />}
          value={activeCount}
          label={t('stats.metrics.active')}
          tone={activeCount > 0 ? 'good' : 'neutral'}
          loading={loadingFirstTime}
        />
        <MetricCard
          icon={<Ghost size={16} />}
          value={zombieCount}
          label={t('stats.metrics.zeroUse')}
          tone={zombieCount > 0 ? 'danger' : 'good'}
          loading={loadingFirstTime}
        />
      </div>

      {coverage ? <p className="text-[13px] text-muted-foreground">{coverage}</p> : null}

      {/* ── 从未用过的技能清单 ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-[15px]">
              <Ghost size={16} className="text-muted-foreground" />
              {t('stats.zombieTitle')}
            </CardTitle>
            <Badge variant="outline">
              {data.stats.since ? t('stats.since', { date: data.stats.since.slice(0, 10) }) : t('stats.allTime')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {loadingFirstTime ? (
            <div className="space-y-2 px-5 py-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : data.scan.skills.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-muted-foreground">{t('stats.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">{t('stats.columns.skill')}</TableHead>
                  <TableHead>{t('stats.columns.agents')}</TableHead>
                  <TableHead>{t('stats.columns.location')}</TableHead>
                  <TableHead className="pr-5 text-right">{t('stats.columns.state')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.scan.skills.map((skill) => {
                  const name = displaySkillName(skill);
                  const zombie = zombieNames.has(name);
                  return (
                    <TableRow key={`${skill.relSkillsDir}/${skill.dirName}`}>
                      <TableCell className="pl-5 font-console text-foreground">{name}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {skill.agents.map((agent) => (
                            <Badge key={agent} variant="outline" className="font-normal">
                              {agent}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{skill.relSkillsDir}</TableCell>
                      <TableCell className="pr-5 text-right">
                        <Badge variant={zombie ? 'danger' : 'good'}>
                          {zombie ? t('status.zombie') : t('status.used')}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
