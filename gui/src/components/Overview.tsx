// Overview 总览屏 — w4 基建波重构:
// 四指标 → shadcn Card(图标 lucide,数值层级清晰)
// 关注队列 + 安装维护 → Card/Badge 重排
// 保留全部功能与 i18n key,明暗皆好看。
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  HeartPulse,
  LayoutGrid,
  ShieldAlert,
  Wrench,
} from 'lucide-react';
import type { DashboardData } from '../data';
import { isBlockingAudit, isNameMismatch } from '../lib/helpers';
import type { SectionStates, WriteOperationsProps } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Skeleton } from './ui/skeleton';
import { HealthCenter, StatusPill } from './atoms';
import { Onboarding } from './Onboarding';
import { WriteOperations } from './WriteOperations';

// ── 精致指标卡 ──────────────────────────────────────────────────────────────
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

// ── 关注队列面板 ──────────────────────────────────────────────────────────────
interface AttentionPanelProps {
  broken: Array<{ dirName: string; error?: unknown; relSkillsDir: string }>;
  blocking: Array<{ path: string; name?: string }>;
  attentionPending: boolean;
  auditReady: boolean;
}

function AttentionPanel({ broken, blocking, attentionPending, auditReady }: AttentionPanelProps) {
  const { t } = useTranslation();
  const totalCount = broken.length + blocking.length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <ShieldAlert size={16} className="text-muted-foreground" />
            {t('overview.attention.title')}
          </CardTitle>
          <Badge variant={totalCount > 0 ? 'warn' : 'outline'}>
            {t('overview.attention.itemCount', { count: totalCount })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="attention-list">
          {broken.map((skill) => (
            <div className="attention-row" key={`${skill.relSkillsDir}/${skill.dirName}`}>
              <span className="text-sm">{skill.dirName}</span>
              <StatusPill tone={skill.error ? 'danger' : 'warn'}>
                {skill.error ? t('status.badFrontmatter') : t('status.nameMismatch')}
              </StatusPill>
            </div>
          ))}
          {blocking.map((report) => (
            <div className="attention-row" key={report.path}>
              <span className="text-sm">{report.name ?? report.path.split('/').at(-1)}</span>
              <StatusPill tone="danger">{t('status.auditBlocks')}</StatusPill>
            </div>
          ))}
          {attentionPending ? (
            <div className="attention-row">
              <span className="muted text-sm">{!auditReady ? t('section.auditPending') : t('section.statsPending')}</span>
              <StatusPill tone="warn">{t('section.loading')}</StatusPill>
            </div>
          ) : null}
          {!attentionPending && totalCount === 0 ? (
            <p className="empty text-sm py-2">{t('overview.attention.empty')}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────
export function Overview({
  data,
  operations,
  advanced,
  sections,
  showOnboarding,
  onDismissOnboarding,
}: {
  data: DashboardData;
  operations: WriteOperationsProps;
  advanced: boolean;
  sections: SectionStates;
  showOnboarding: boolean;
  onDismissOnboarding: () => void;
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
  const attentionPending = !auditReady || !statsReady;

  return (
    <section className="screen">
      {showOnboarding ? <Onboarding onDismiss={onDismissOnboarding} /> : null}

      {/* ── 四指标卡 ── */}
      <div className="metric-grid">
        <MetricCard
          icon={<LayoutGrid size={16} />}
          value={agents.size}
          label={t('overview.metrics.agents')}
          tone="good"
        />
        <MetricCard
          icon={<Activity size={16} />}
          value={data.scan.total}
          label={t('overview.metrics.skills')}
        />
        <MetricCard
          icon={<AlertTriangle size={16} />}
          value={statsReady ? zombieCount : '…'}
          label={t('overview.metrics.zombies')}
          tone={statsReady ? (zombieCount > 0 ? 'danger' : 'good') : 'neutral'}
          loading={!statsReady}
        />
        <MetricCard
          icon={<HeartPulse size={16} />}
          value={doctorValue}
          label={t('overview.metrics.doctor')}
          tone={data.doctor.clean ? 'good' : 'danger'}
        />
      </div>

      {/* ── 高级面板:命令详情 + 健康中心 ── */}
      {advanced ? (
        <div className="overview-grid">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-[15px]">
                  <Wrench size={16} className="text-muted-foreground" />
                  {t('overview.controlSurface.title')}
                </CardTitle>
                <Badge variant="warn">{t('overview.controlSurface.safeMode')}</Badge>
              </div>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
          <HealthCenter doctor={data.doctor} lockOk={data.lockVerify.ok} />
        </div>
      ) : null}

      {/* ── 安装与维护 ── */}
      <WriteOperations {...operations} />

      {/* ── 关注队列 ── */}
      <AttentionPanel
        broken={broken}
        blocking={blocking}
        attentionPending={attentionPending}
        auditReady={auditReady}
      />
    </section>
  );
}
