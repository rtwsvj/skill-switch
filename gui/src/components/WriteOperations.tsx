// 安装与维护面板 —— 一键装(PasteInstall)+ 安装 / 同步 / 撤销(备份还原)。
// W4 迁移:改用 shadcn 设计系统(Card 分区 / Input·Button·Badge 表单 / 设计 token),
// 明暗自适应,风格与 Overview 一致。所有写操作 / 安装 / 审计的数据流与确认逻辑一律不改,只换皮。
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Wrench } from 'lucide-react';
import type { InstallMode } from '../data';
import { agentOptions, changedActionCount, isWriteBusy, severityLabel } from '../lib/helpers';
import type { WriteOperationsProps } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { PasteInstall } from './PasteInstall';

// 表单字段标签(灰、小号,与旧 operation-form label 视觉一致)。htmlFor 关联控件(a11y)。
function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-xs text-muted-foreground">
      {children}
    </label>
  );
}

// 原生 select 用设计 token 样式(保持 SSR 行为与数据流,不换 Radix 组件)
const selectClass = cn(
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
);

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
  // 每个字段的稳定唯一 id(a11y:label htmlFor ↔ 控件 id)
  const ids = useId();
  const fieldId = (name: string) => `${ids}-${name}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <Wrench size={16} className="text-muted-foreground" />
            {t('operations.title')}
          </CardTitle>
          <Badge variant="warn">{t('operations.writeEnabled')}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <PasteInstall
          agentOptions={agents}
          defaultAgent={installDraft.agent || agents[0] || 'claude-code'}
          onInstalled={onPasteInstalled}
        />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,0.8fr)_minmax(260px,0.8fr)]">
          {/* ── 安装 ── */}
          <form
            className="grid content-start gap-2.5 border-t border-border pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              onInstall();
            }}
          >
            <h3 className="text-[13px] font-semibold text-foreground">{t('operations.install.title')}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('operations.install.help')}</p>
            <div className="grid gap-1.5">
              <FieldLabel htmlFor={fieldId('source')}>{t('operations.install.source')}</FieldLabel>
              <Input
                id={fieldId('source')}
                value={installDraft.source}
                onChange={(event) => onInstallDraftChange({ ...installDraft, source: event.target.value })}
                placeholder={t('operations.install.sourcePlaceholder')}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <FieldLabel htmlFor={fieldId('agent')}>{t('operations.install.agent')}</FieldLabel>
                <select
                  id={fieldId('agent')}
                  className={selectClass}
                  value={installDraft.agent}
                  onChange={(event) => onInstallDraftChange({ ...installDraft, agent: event.target.value })}
                >
                  {agents.map((agent) => (
                    <option key={agent} value={agent}>
                      {agent}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor={fieldId('mode')}>{t('operations.install.mode')}</FieldLabel>
                <select
                  id={fieldId('mode')}
                  className={selectClass}
                  value={installDraft.mode}
                  onChange={(event) => onInstallDraftChange({ ...installDraft, mode: event.target.value as InstallMode })}
                >
                  <option value="copy">{t('operations.install.copy')}</option>
                  <option value="symlink">{t('operations.install.symlink')}</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <FieldLabel htmlFor={fieldId('skill')}>{t('operations.install.skill')}</FieldLabel>
                <Input
                  id={fieldId('skill')}
                  value={installDraft.skill}
                  onChange={(event) => onInstallDraftChange({ ...installDraft, skill: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor={fieldId('ref')}>{t('operations.install.ref')}</FieldLabel>
                <Input
                  id={fieldId('ref')}
                  value={installDraft.ref}
                  onChange={(event) => onInstallDraftChange({ ...installDraft, ref: event.target.value })}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                checked={installDraft.force}
                onChange={(event) => onInstallDraftChange({ ...installDraft, force: event.target.checked })}
              />
              <span>{t('operations.install.force')}</span>
            </label>
            <Button type="submit" className="w-full" disabled={busy === 'install' || writeBusy}>
              {busy === 'install' ? t('operations.busy') : t('operations.install.submit')}
            </Button>
            {installResult?.blocked.length ? (
              <div className="grid gap-2 border-l-2 border-danger pl-2.5 text-xs text-muted-foreground">
                <strong className="text-danger">{t('operations.install.blocked')}</strong>
                <p>{t('operations.install.blockedWhy')}</p>
                {installResult.blocked.map((blocked) => (
                  <div className="grid gap-1.5 border-t border-danger/20 py-2" key={blocked.name}>
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-foreground">{blocked.name}</strong>
                      <Badge variant="danger">{t('operations.install.blockedScore', { score: blocked.score })}</Badge>
                    </div>
                    {(blocked.report.findings ?? []).length > 0 ? (
                      <ul className="grid gap-1">
                        {(blocked.report.findings ?? []).slice(0, 4).map((finding) => (
                          <li key={`${finding.ruleId}-${finding.line}`} className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                'h-1.5 w-1.5 shrink-0 rounded-full',
                                finding.severity === 'critical' && 'bg-danger',
                                finding.severity === 'high' && 'bg-danger/80',
                                finding.severity === 'medium' && 'bg-warn',
                                finding.severity === 'low' && 'bg-muted-foreground',
                              )}
                            />
                            <span className="font-console">{finding.ruleId}</span>
                            <strong className="text-foreground">{severityLabel(finding.severity, t)}</strong>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
                <div className="mt-1 grid gap-1">
                  <FieldLabel htmlFor={fieldId('force-reason')}>{t('operations.install.forceReasonLabel')}</FieldLabel>
                  <Input
                    id={fieldId('force-reason')}
                    type="text"
                    value={blockedReason}
                    placeholder={t('operations.install.forceReasonPlaceholder')}
                    onChange={(event) => onBlockedReasonChange(event.target.value)}
                  />
                </div>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={onForceInstall}
                  disabled={!blockedReason.trim() || busy === 'install' || writeBusy}
                >
                  {t('operations.install.forceAnyway')}
                </Button>
              </div>
            ) : null}
          </form>

          {/* ── 同步 ── */}
          <div className="grid content-start gap-2.5 border-t border-border pt-3">
            <h3 className="text-[13px] font-semibold text-foreground">{t('operations.sync.title')}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('operations.sync.help')}</p>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" onClick={onSyncDryRun} disabled={busy === 'sync-dry-run' || writeBusy}>
                {busy === 'sync-dry-run' ? t('operations.busy') : t('operations.sync.dryRun')}
              </Button>
              <Button
                type="button"
                onClick={onSyncApply}
                disabled={!syncPlan || busy === 'sync-apply' || writeBusy}
                aria-label={busy === 'sync-apply' ? t('operations.busy') : t('operations.sync.apply')}
              >
                {busy === 'sync-apply' ? t('operations.busy') : t('operations.sync.apply')}
              </Button>
            </div>
            {syncPlan ? (
              <div className="grid gap-1.5 text-xs text-muted-foreground">
                <strong className="text-foreground">{t('operations.sync.planCount', { changed: syncChanges, total: syncPlan.actions.length })}</strong>
                {syncPlan.actions.slice(0, 6).map((action) => (
                  <p key={`${action.kind}-${action.agent}-${action.name}-${action.target}`}>
                    <span className="font-console text-warn">{`[${action.kind}]`}</span>
                    {` ${action.agent}/${action.name}`}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          {/* ── 撤销(备份还原)── */}
          <div className="grid content-start gap-2.5 border-t border-border pt-3">
            <h3 className="text-[13px] font-semibold text-foreground">{t('operations.restore.title')}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('operations.restore.help')}</p>
            <Button type="button" variant="outline" onClick={onLoadSnapshots} disabled={busy === 'restore-list' || writeBusy}>
              {busy === 'restore-list' ? t('operations.busy') : t('operations.restore.load')}
            </Button>
            <div className="grid gap-1.5 text-xs text-muted-foreground">
              {restoreList?.snapshots.length ? (
                restoreList.snapshots.map((snapshot) => (
                  <div key={snapshot.id ?? snapshot.path} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-border pt-2">
                    <div className="grid gap-0.5">
                      <strong className="text-foreground">{snapshot.label}</strong>
                      <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRestore(snapshot.id ?? '')}
                      disabled={!snapshot.id || busy === 'restore-apply' || writeBusy}
                    >
                      {t('operations.restore.submit')}
                    </Button>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">{t('operations.restore.empty')}</p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
