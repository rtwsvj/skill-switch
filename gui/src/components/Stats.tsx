import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DashboardData } from '../data';
import { coverageSummary, displaySkillName } from '../lib/helpers';
import type { SectionState } from '../lib/types';
import { Metric, SectionStatusBar, StatusPill } from './atoms';

export function Stats({ data, section, onReload }: { data: DashboardData; section: SectionState; onReload: () => void }) {
  const { t } = useTranslation();
  const zombieNames = useMemo(() => new Set(data.stats.zombies.map((zombie) => zombie.name)), [data.stats.zombies]);
  const loadingFirstTime = section.status === 'loading' && section.loadedAt === undefined;

  return (
    <section className="screen">
      <div className="section-toolbar">
        <h2>{t('screens.stats')}</h2>
        <SectionStatusBar section={section} onReload={onReload} />
      </div>
      {section.status === 'error' ? <p className="section-error">{section.error}</p> : null}
      {loadingFirstTime ? <p className="empty">{t('section.loading')}</p> : null}
      <div className="metric-grid compact">
        <Metric value={data.stats.scannedFiles} label={t('stats.metrics.transcripts')} />
        <Metric value={data.stats.invocations} label={t('stats.metrics.invocations')} />
        <Metric value={data.stats.usage.length} label={t('stats.metrics.active')} tone={data.stats.usage.length > 0 ? 'good' : 'neutral'} />
        <Metric value={data.stats.zombies.length} label={t('stats.metrics.zeroUse')} tone={data.stats.zombies.length > 0 ? 'danger' : 'good'} />
      </div>
      {coverageSummary(data.stats, t) ? <p className="coverage-line muted">{coverageSummary(data.stats, t)}</p> : null}
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
