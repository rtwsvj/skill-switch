// F-B1:撤销/历史中心 —— 把自动备份做成可视时间线 + 一键还原。招牌「后悔药」体验。
// W4/G2:迁移到 shadcn 设计系统(Card/Button/Badge + 设计 token),明暗自适应,风格与 Overview 一致。
// 纯展示 + 回调,便于直接测试;加载触发在 DashboardShell(进 tab 时拉一次)。数据流不变,只改视觉。
import { useTranslation } from 'react-i18next';
import { ArchiveRestore, Clock, FolderClock, RotateCcw } from 'lucide-react';
import type { RestoreListResult } from '../data';
import { describeSnapshotLabel } from '../lib/helpers';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

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
      {/* ── 屏幕标题 + 状态 + 刷新 ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
          <FolderClock size={18} className="text-muted-foreground" />
          {t('screens.history')}
        </h2>
        <div className="flex items-center gap-2">
          {loading ? <Badge variant="warn">{t('section.loading')}</Badge> : null}
          {loaded && !loading ? (
            <span className="text-[13px] text-muted-foreground">
              {t('history.count', { count: snapshots.length })}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onReload}
            disabled={loading || restoring}
          >
            {t('section.refresh')}
          </Button>
        </div>
      </div>

      {/* ── 引导语(后悔药说明) ── */}
      <Card className="border-primary/25 bg-accent text-accent-foreground shadow-none">
        <CardContent className="flex items-start gap-3 px-5 py-4 text-sm leading-relaxed">
          <RotateCcw size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
          <span>{t('history.guide')}</span>
        </CardContent>
      </Card>

      {/* ── 加载态(首次拉取) ── */}
      {loading && snapshots.length === 0 ? (
        <Card>
          <CardContent className="px-5 py-8 text-center text-sm text-muted-foreground">
            {t('section.loading')}
          </CardContent>
        </Card>
      ) : null}

      {/* ── 空态 ── */}
      {loaded && !loading && snapshots.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 px-5 py-10 text-center">
            <FolderClock size={28} className="text-muted-foreground/60" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t('history.empty')}</p>
          </CardContent>
        </Card>
      ) : null}

      {/* ── 备份时间线 ── */}
      {snapshots.length > 0 ? (
        <div className="grid gap-2.5">
          {snapshots.map((snapshot) => (
            <Card
              key={snapshot.id ?? snapshot.path}
              className="border-l-[3px] border-l-good/50 transition-shadow hover:shadow-md"
            >
              <CardHeader className="p-0">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <CardTitle className="text-sm">
                      {describeSnapshotLabel(snapshot.label, t)}
                    </CardTitle>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock size={12} aria-hidden="true" />
                      {new Date(snapshot.createdAt).toLocaleString()}
                    </span>
                    {snapshot.sourceDir ? (
                      <span className="truncate font-console text-[11px] text-muted-foreground">
                        {snapshot.sourceDir}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="good"
                    size="sm"
                    onClick={() => onRestore(snapshot.id ?? '')}
                    disabled={!snapshot.id || restoring || loading}
                  >
                    <ArchiveRestore size={14} aria-hidden="true" />
                    {t('history.restoreHere')}
                  </Button>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  );
}
