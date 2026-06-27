import { useTranslation } from 'react-i18next';
import type { InstallMode } from '../data';
import { agentOptions, changedActionCount, cx, isWriteBusy, severityLabel } from '../lib/helpers';
import type { WriteOperationsProps } from '../lib/types';
import { StatusPill } from './atoms';
import { PasteInstall } from './PasteInstall';

export function WriteOperations({
  data,
  busy,
  installDraft,
  installResult,
  syncPlan,
  restoreList,
  onInstallDraftChange,
  onInstall,
  onSyncDryRun,
  onSyncApply,
  onLoadSnapshots,
  onRestore,
  blockedReason,
  onBlockedReasonChange,
  onForceInstall,
  onPasteInstalled,
}: WriteOperationsProps) {
  const { t } = useTranslation();
  const agents = agentOptions(data);
  const syncChanges = syncPlan ? changedActionCount(syncPlan) : 0;
  // M0-A2:任一写操作在飞行中 → 禁用全部写控件,防 skills.json/lock 读改写竞争。
  const writeBusy = isWriteBusy(busy);

  return (
    <section className="panel write-panel">
      <div className="panel-title">
        <h2>{t('operations.title')}</h2>
        <StatusPill tone="warn">{t('operations.writeEnabled')}</StatusPill>
      </div>
      <PasteInstall
        agentOptions={agents}
        defaultAgent={installDraft.agent || agents[0] || 'claude-code'}
        onInstalled={onPasteInstalled}
      />
      <div className="write-grid">
        <form
          className="operation-form"
          onSubmit={(event) => {
            event.preventDefault();
            onInstall();
          }}
        >
          <h3>{t('operations.install.title')}</h3>
          <p className="form-help">{t('operations.install.help')}</p>
          <label>
            <span>{t('operations.install.source')}</span>
            <input
              value={installDraft.source}
              onChange={(event) => onInstallDraftChange({ ...installDraft, source: event.target.value })}
              placeholder={t('operations.install.sourcePlaceholder')}
            />
          </label>
          <div className="form-row">
            <label>
              <span>{t('operations.install.agent')}</span>
              <select
                value={installDraft.agent}
                onChange={(event) => onInstallDraftChange({ ...installDraft, agent: event.target.value })}
              >
                {agents.map((agent) => (
                  <option key={agent} value={agent}>
                    {agent}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('operations.install.mode')}</span>
              <select
                value={installDraft.mode}
                onChange={(event) => onInstallDraftChange({ ...installDraft, mode: event.target.value as InstallMode })}
              >
                <option value="copy">{t('operations.install.copy')}</option>
                <option value="symlink">{t('operations.install.symlink')}</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              <span>{t('operations.install.skill')}</span>
              <input
                value={installDraft.skill}
                onChange={(event) => onInstallDraftChange({ ...installDraft, skill: event.target.value })}
              />
            </label>
            <label>
              <span>{t('operations.install.ref')}</span>
              <input
                value={installDraft.ref}
                onChange={(event) => onInstallDraftChange({ ...installDraft, ref: event.target.value })}
              />
            </label>
          </div>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={installDraft.force}
              onChange={(event) => onInstallDraftChange({ ...installDraft, force: event.target.checked })}
            />
            <span>{t('operations.install.force')}</span>
          </label>
          <button className="primary-action" type="submit" disabled={busy === 'install' || writeBusy}>
            {busy === 'install' ? t('operations.busy') : t('operations.install.submit')}
          </button>
          {installResult?.blocked.length ? (
            <div className="blocked-list">
              <strong>{t('operations.install.blocked')}</strong>
              <p className="muted">{t('operations.install.blockedWhy')}</p>
              {installResult.blocked.map((blocked) => (
                <div className="blocked-item" key={blocked.name}>
                  <div className="blocked-head">
                    <strong>{blocked.name}</strong>
                    <StatusPill tone="danger">{t('operations.install.blockedScore', { score: blocked.score })}</StatusPill>
                  </div>
                  {(blocked.report.findings ?? []).length > 0 ? (
                    <ul className="finding-list">
                      {(blocked.report.findings ?? []).slice(0, 4).map((finding) => (
                        <li key={`${finding.ruleId}-${finding.line}`}>
                          <span className={cx('severity-dot', `severity-${finding.severity}`)} />
                          <span>{finding.ruleId}</span>
                          <strong>{severityLabel(finding.severity, t)}</strong>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
              <label className="field force-reason-field">
                <span>{t('operations.install.forceReasonLabel')}</span>
                <input
                  type="text"
                  value={blockedReason}
                  placeholder={t('operations.install.forceReasonPlaceholder')}
                  onChange={(event) => onBlockedReasonChange(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="danger-action"
                onClick={onForceInstall}
                disabled={!blockedReason.trim() || busy === 'install' || writeBusy}
              >
                {t('operations.install.forceAnyway')}
              </button>
            </div>
          ) : null}
        </form>

        <div className="operation-form">
          <h3>{t('operations.sync.title')}</h3>
          <p className="form-help">{t('operations.sync.help')}</p>
          <div className="button-row">
            <button type="button" onClick={onSyncDryRun} disabled={busy === 'sync-dry-run' || writeBusy}>
              {busy === 'sync-dry-run' ? t('operations.busy') : t('operations.sync.dryRun')}
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={onSyncApply}
              disabled={!syncPlan || busy === 'sync-apply' || writeBusy}
            >
              {busy === 'sync-apply' ? t('operations.busy') : t('operations.sync.apply')}
            </button>
          </div>
          {syncPlan ? (
            <div className="plan-list">
              <strong>{t('operations.sync.planCount', { changed: syncChanges, total: syncPlan.actions.length })}</strong>
              {syncPlan.actions.slice(0, 6).map((action) => (
                <p key={`${action.kind}-${action.agent}-${action.name}-${action.target}`}>
                  <span>{`[${action.kind}]`}</span>
                  {` ${action.agent}/${action.name}`}
                </p>
              ))}
            </div>
          ) : null}
        </div>

        <div className="operation-form">
          <h3>{t('operations.restore.title')}</h3>
          <p className="form-help">{t('operations.restore.help')}</p>
          <button type="button" onClick={onLoadSnapshots} disabled={busy === 'restore-list' || writeBusy}>
            {busy === 'restore-list' ? t('operations.busy') : t('operations.restore.load')}
          </button>
          <div className="snapshot-list">
            {restoreList?.snapshots.length ? (
              restoreList.snapshots.map((snapshot) => (
                <div key={snapshot.id ?? snapshot.path} className="snapshot-row">
                  <div>
                    <strong>{snapshot.label}</strong>
                    <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
                  </div>
                  <button type="button" onClick={() => onRestore(snapshot.id ?? '')} disabled={!snapshot.id || busy === 'restore-apply' || writeBusy}>
                    {t('operations.restore.submit')}
                  </button>
                </div>
              ))
            ) : (
              <p className="empty">{t('operations.restore.empty')}</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
