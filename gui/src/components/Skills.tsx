import { useTranslation } from 'react-i18next';
import { type DashboardData } from '../data';
import { actionSkillName, cx, isNameMismatch, isSkillEnabled, isWriteBusy } from '../lib/helpers';
import type { SkillActionsProps } from '../lib/types';
import { StatusPill } from './atoms';

export function Skills({ data, actions }: { data: DashboardData; actions: SkillActionsProps }) {
  const { t } = useTranslation();
  const writeBusy = isWriteBusy(actions.busy);

  return (
    <section className="screen">
      <section className="guide-panel">
        {t('skills.guide')}
      </section>
      {actions.importableCount > 0 ? (
        <section className="import-banner">
          <span>{t('skills.import.found', { count: actions.importableCount })}</span>
          <button
            type="button"
            className="primary-action"
            onClick={actions.onImportExisting}
            disabled={actions.busy === 'import' || writeBusy}
          >
            {actions.busy === 'import' ? t('operations.busy') : t('skills.import.action')}
          </button>
        </section>
      ) : null}
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
                <th>{t('skills.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.scan.skills.map((skill) => {
                const mismatch = isNameMismatch(skill);
                const hasError = Boolean(skill.error);
                const name = actionSkillName(skill);
                const enabled = isSkillEnabled(skill);
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
                      <div className="status-stack">
                        <StatusPill tone={enabled ? 'good' : 'warn'}>{enabled ? t('status.enabled') : t('status.disabledKept')}</StatusPill>
                        {hasError ? <StatusPill tone="danger">{t('status.parseError')}</StatusPill> : null}
                        {mismatch ? <StatusPill tone="warn">{t('status.nameMismatch')}</StatusPill> : null}
                      </div>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className={enabled ? undefined : 'primary-action'}
                          onClick={() => actions.onToggle(skill, !enabled)}
                          disabled={actions.busy === `toggle-${name}` || writeBusy}
                          title={enabled ? t('skills.actions.disableHint') : undefined}
                        >
                          {enabled ? t('skills.actions.disable') : t('skills.actions.enable')}
                        </button>
                        <button
                          type="button"
                          className="danger-action"
                          onClick={() => actions.onRemove(skill)}
                          disabled={actions.busy === `remove-${name}` || writeBusy}
                          title={t('skills.actions.deleteHint')}
                        >
                          {t('skills.actions.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {data.scan.skills.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">{t('skills.empty')}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
