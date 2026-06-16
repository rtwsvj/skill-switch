import { useTranslation } from 'react-i18next';
import { type RestoreListResult } from '../data';
import { describeSnapshotLabel } from '../lib/helpers';
import { StatusPill } from './atoms';

// F-B1:撤销/历史中心 —— 把自动备份做成可视时间线 + 一键还原。招牌「后悔药」体验。
// 纯展示 + 回调,便于直接测试;加载触发在 DashboardShell(进 tab 时拉一次)。
export function History({
  restoreList,
  busy,
  loaded,
  onReload,
  onRestore,
}: {
  restoreList: RestoreListResult | null;
  busy: string | null;
  loaded: boolean;
  onReload: () => void;
  onRestore: (id: string) => void;
}) {
  const { t } = useTranslation();
  const loading = busy === 'restore-list';
  const restoring = busy === 'restore-apply';
  const snapshots = restoreList?.snapshots ?? [];

  return (
    <section className="screen">
      <div className="section-toolbar">
        <h2>{t('screens.history')}</h2>
        <div className="section-status">
          {loading ? <StatusPill tone="warn">{t('section.loading')}</StatusPill> : null}
          {loaded && !loading ? <span className="muted">{t('history.count', { count: snapshots.length })}</span> : null}
          <button type="button" className="ghost-button" onClick={onReload} disabled={loading || restoring}>
            {t('section.refresh')}
          </button>
        </div>
      </div>
      <section className="guide-panel">{t('history.guide')}</section>
      {loading && snapshots.length === 0 ? <p className="empty">{t('section.loading')}</p> : null}
      {loaded && !loading && snapshots.length === 0 ? <p className="empty">{t('history.empty')}</p> : null}
      <div className="snapshot-timeline">
        {snapshots.map((snapshot) => (
          <article className="timeline-row" key={snapshot.id ?? snapshot.path}>
            <div className="timeline-main">
              <strong>{describeSnapshotLabel(snapshot.label, t)}</strong>
              <span className="muted">{new Date(snapshot.createdAt).toLocaleString()}</span>
              {snapshot.sourceDir ? <span className="muted timeline-source">{snapshot.sourceDir}</span> : null}
            </div>
            <button
              type="button"
              className="primary-action"
              onClick={() => onRestore(snapshot.id ?? '')}
              disabled={!snapshot.id || restoring || loading}
            >
              {t('history.restoreHere')}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
