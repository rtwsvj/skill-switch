import { useTranslation } from 'react-i18next';
import type { DashboardData } from '../data';
import { isBlockingAudit, isNameMismatch } from '../lib/helpers';
import type { SectionStates, WriteOperationsProps } from '../lib/types';
import { HealthCenter, Metric, StatusPill } from './atoms';
import { Onboarding } from './Onboarding';
import { WriteOperations } from './WriteOperations';

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
  const attentionPending = (!auditReady || !statsReady);

  return (
    <section className="screen">
      {showOnboarding ? <Onboarding onDismiss={onDismissOnboarding} /> : null}
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

        <HealthCenter doctor={data.doctor} lockOk={data.lockVerify.ok} />
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
